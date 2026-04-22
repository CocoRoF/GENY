# X7 · VTuber 다마고치 UX 통합 — 진행 기록

**Date.** 2026-04-22
**Status.** Implemented — backend 188 tests pass (regression 0),
frontend TS 타입 / 컴포넌트 완성 (node_modules 부재로 로컬 빌드 미검증
— 컨테이너 재빌드 필요).

## 범위 실제 구현

### 1. `service.affect.taxonomy` — 단일 source of truth

신규 모듈. 25+ 태그의 6-dim 매핑 table 과 헬퍼.

| Tag family | 포함 태그 | 매핑 특징 |
|---|---|---|
| Primary 6 | joy, sadness, anger, fear, calm, excitement | 1:1 mood axis, coefficient 1.0 (pre-X7 magnitude 그대로) |
| Aliases | excited | 동일 axis + same coeff |
| Surprise / curiosity | surprise, wonder, amazement, curious, curiosity | excitement 중심, + fear/calm/joy weighted |
| Positive | satisfaction, proud, grateful, playful, confident, amused, tender, warmth, love, smirk | joy/calm 중심 + bond.affection 증가 |
| Negative (mild) | disgust, concerned, shy | anger/fear/sadness 부분 기여 |
| Neutral | neutral, thoughtful | calm 중심 |

API:

```python
MOOD_AXES: Tuple[str, ...]                 # (joy, sadness, anger, fear, calm, excitement)
AFFECT_TAG_MAPPING: Dict[str, Dict[str, float]]
RECOGNIZED_TAGS: Tuple[str, ...]           # = tuple(AFFECT_TAG_MAPPING.keys())
def coefficients_for(tag: str) -> Dict[str, float]
```

- stdlib only. emitter / sanitizer 양쪽에서 import 가능.
- 대소문자 무관 (`coefficients_for("Joy") == coefficients_for("joy")`).
- 미지 태그는 `{}` 반환 → emitter 가 "mutation 없이 strip 만" 으로 처리.

### 2. `AffectTagEmitter` 교체

- 구 hardcoded 6-tag list 제거. `AFFECT_TAGS = RECOGNIZED_TAGS` alias
  유지 (기존 테스트 호환).
- `_apply_tag` 를 coefficient-driven 으로 재작성:
  ```python
  coeffs = coefficients_for(tag)
  for path, coeff in coeffs.items():
      if path.startswith("mood."):   delta = strength * coeff * MOOD_ALPHA
      elif path == "bond.affection": delta = strength * coeff * _BOND_AFFECTION_SCALE
      elif path == "bond.trust":     delta = strength * coeff * _BOND_TRUST_SCALE
      ...
      buf.append(op="add", path=path, value=delta, source=source)
  ```
- Pre-X7 primary 6 magnitude 유지 위해 scale 을 분리:
  - `MOOD_ALPHA = 0.15` (기존)
  - `_BOND_AFFECTION_SCALE = 0.5` (기존 joy/calm → +0.5 재현)
  - `_BOND_TRUST_SCALE = -0.3` (기존 anger/fear → -0.3 재현)
  - 부호는 scale 에, magnitude 는 taxonomy coefficient 에 분리 →
    taxonomy table 은 항상 양수로 유지.
- 안전망 regex `UNKNOWN_EMOTION_TAG_RE = r"\[([a-z][a-z_]{2,19})\]"`:
  - AFFECT_TAG_RE 매칭 후 *남은* lowercase single-word bracket 을 strip.
  - 대문자 routing tag (`[THINKING_TRIGGER]`) 는 매치 안 됨.
  - 짧은 ([a], [1]) / 숫자 ([1]) / 다중-단어 ([a, b]) 도 매치 안 됨.
- `EmitResult.metadata["unknown_stripped"]` 카운터 추가 → observability.

### 3. `text_sanitizer` 연동

```python
from service.affect.taxonomy import RECOGNIZED_TAGS
EMOTION_TAGS = RECOGNIZED_TAGS  # no more duplication
EMOTION_TAG_PATTERN = re.compile(r"\[(?:" + "|".join(EMOTION_TAGS) + r")\]\s*", ...)

UNKNOWN_EMOTION_TAG_PATTERN = re.compile(r"\[[a-z][a-z_]{2,19}\]\s*")

def sanitize_for_display(text):
    ...
    text = EMOTION_TAG_PATTERN.sub("", text)
    text = UNKNOWN_EMOTION_TAG_PATTERN.sub("", text)  # X7: catch-all
    ...
```

### 4. `prompts/vtuber.md` 업데이트

기존 8-태그 문구를 25+ 태그 그룹별 + `:strength` 옵션 명시로 교체.

### 5. `AgentSession.load_creature_state_snapshot()` 신규 async 메서드

- `self._state_provider.load(character_id, owner_user_id=...)` 호출.
- JSON-friendly dict 반환 (nested `mood` / `bond` / `vitals` /
  `progression` + top-level `mood_dominant`, `recent_events`,
  timestamps as ISO strings).
- classic mode (`_state_provider is None`) / load 예외 → 모두 `None`
  반환 (swallow + debug log).

### 6. `SessionInfo` Pydantic 모델 확장

`creature_state: Optional[dict] = None` 필드 추가. 기존 23개 필드는
전부 그대로.

### 7. `agent_controller.get_agent_session`

```python
info = agent.get_session_info()
info.creature_state = await agent.load_creature_state_snapshot()
return info
```

2줄 추가. 나머지 `get_session_info` 호출자들은 sync 유지 — 오직 이 UI
endpoint 만 enrich.

### 8. Frontend

- `types/index.ts`:
  ```ts
  creature_state?: CreatureStateSnapshot | null;

  export interface CreatureStateSnapshot {
    character_id: string; owner_user_id: string;
    mood: { joy: number; sadness: number; anger: number; fear: number; calm: number; excitement: number; };
    mood_dominant: string;
    bond: { affection: number; trust: number; familiarity: number; dependency: number; };
    vitals: { hunger: number; energy: number; stress: number; cleanliness: number; };
    progression: { age_days: number; life_stage: string; xp: number; milestones: string[]; manifest_id: string; };
    last_interaction_at: string | null; last_tick_at: string | null;
    recent_events: string[];
  }
  ```
- `components/info/CreatureStatePanel.tsx` — 순수 presentational:
  - Header: sparkle icon + title + life_stage badge + age days.
  - 2-col grid top row: dominant mood / last interaction.
  - Vitals 4축 (hunger/energy/stress/cleanliness) progress bar —
    hunger/stress warn tone, energy/cleanliness good tone.
  - Bond 4축 progress bar — info tone, clamp(-100, 100).
  - Mood 6축 progress bar — neutral tone, percent scale.
- `components/tabs/InfoTab.tsx`:
  ```tsx
  {!isDeleted && data.creature_state && (
    <CreatureStatePanel snapshot={data.creature_state} t={t} />
  )}
  ```
  Thinking Trigger 와 Fields Grid 사이에 삽입. classic mode (null) 에선
  자동 숨김.
- `lib/i18n/ko.ts` / `en.ts` 에 `info.creatureState.*` 세트 추가
  (title / dominantMood / lastInteraction / ageDays / vitals/bond/mood
  labels + per-axis 한/영 이름).

## 테스트

### 신규

- `tests/service/affect/test_taxonomy.py` — 8 tests.
- `tests/service/emit/test_affect_tag_emitter.py` — 9 tests 추가
  (총 36).
- `tests/service/utils/test_text_sanitizer.py` — 5 tests 추가 + 기존
  parametrized 1개 수정 (X7 catch-all 의도된 행동 변경).

### 결과

```
backend tests — emit/affect/database/state/integration
188 passed
```

- 기존 `tts_controller` 관련 1 test 는 sandbox 의 fastapi 부재로 pre-
  existing 실패 — 본 PR 무관.
- state/provider/ 및 state/schema/ 는 sandbox numpy 부재로 여전히
  collection error — pre-existing, X5F / X6F 와 동일 한계.

### Frontend

로컬 sandbox 에 `node_modules` 없음 — TypeScript 타입체크 / build 미검증.
컨테이너 재빌드 시 자동 설치 + build 검증. 코드는 수동 review 로:

- `@/` alias resolution 확인 (tsconfig paths = `./src/*`).
- lucide-react icons (Heart / Battery / Brain / Sparkles) 는 이미 다른
  컴포넌트에서 사용 중인 표준 icon (확인).
- snake_case field 이름 backend/frontend 일관성 확인.
- Pydantic `SessionInfo` assignment + `model_dump` round-trip 검증 (Python
  sandbox 에서 실행).

## 불변식 체크 (cycle index §불변식 재확인)

- executor 무수정 ✅
- Pre-X7 primary 6 magnitude byte-identical ✅ (36 emitter tests 중
  `test_original_six_tags_preserve_exact_pre_x7_magnitudes` 가 regression
  pin)
- FAISS / SQL schema 무영향 ✅
- Side-door 금지 ✅ (creature_state API 는 read-only)
- Mutation 4 op ✅ (`add` 만 사용)
- Pure additive frontend ✅ (classic mode 자동 hide)

## 의도된 행동 변경 한 가지

기존 display sanitizer 는 `[random_thing]` 같은 임의 lowercase bracket
을 *보존*. X7 는 catch-all 로 **strip** — 사용자 보고의 핵심이
"알려지지 않은 감정 태그 leak" 이었기 때문에 display cleanliness 우선.

Narrow regex `\[[a-z][a-z_]{2,19}\]` 는 업무용 bracket 을 해치지 않음:

- `[note: todo]` — 콜론 + 공백 → 매치 안 됨 → 보존
- `[INBOX from Alice]` — 대문자 + 공백 → 보존
- `[DM to Bob (internal)]` — 공백 + 괄호 → 보존
- `[a]` / `[1]` / `[to]` — 길이 미달 또는 숫자 → 보존

## 후속 작업

- **cycle_close.md** 작성 후 단일 close PR. 본 사이클은 단일 feature
  PR + 단일 close PR 의 2-PR 사이클.
- **운영 검증**: 컨테이너 재빌드 + frontend build 후 VTuber 세션에서
  - 새 태그 (`[wonder]`, `[satisfaction]` 등) 가 chat 에 깨끗이
    사라지는지
  - session info 패널에 CreatureState 섹션이 보이고 값이 업데이트되는지
  - classic session 에서는 섹션이 숨겨지는지
- **다음 사이클 후보**: 두 번째 plugin 사례 추가 (taxonomy coordination
  실증), X6F last-mile (memory write path), X6-3/6-4 재활성 (데이터
  의존).
