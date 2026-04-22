# PR-X4-2 · `feat/stage-manifests-infant-child-teen` — 진행 기록

**Date.** 2026-04-22
**Status.** Implemented, 60/60 신규 + 인접 317 회귀 pass.

PR-X4-1 이 `ManifestSelector` 로 *어느 manifest 로 갈지* 를 결정해 놓고,
실제 id 가 매핑될 manifest 자체는 비어 있었다. 본 PR 은 그 매핑의
**stage 축** 을 채운다 — `"infant"` / `"infant_cheerful"` 같은 id 를
실 `EnvironmentManifest` 로 materialize.

## 계획 ↔ 현실 조정

`plan/05 §4.2` 는 "`manifests/infant_*.yaml`" 을 언급하지만 Geny 는
YAML 매니페스트 시스템이 없다. `build_default_manifest(preset)` 라는
**Python factory** 가 `EnvironmentManifest` 를 직접 만들어
`Pipeline.from_manifest_async` 에 넘긴다 (v0.27.0 이후).

따라서 본 PR 은 plan 문구의 *의도* (stage 마다 다른 manifest) 를
Python factory 확장으로 충족한다:

- 새 모듈 `backend/service/langgraph/stage_manifest.py` 에
  `build_stage_manifest(manifest_id)` 신설.
- 기존 `build_default_manifest(preset)` 는 **그대로 유지** — 기존
  deployment preset (vtuber/worker_adaptive/worker_easy/default) 경로가
  건드려지지 않는다. 두 경로가 공존하고, PR-X4-5 가 session build 에서
  id 종류에 따라 분기.

## 범위

### 1. `backend/service/langgraph/stage_manifest.py` (신규)

Public API 4 개:

- `parse_stage_manifest_id(id) -> (stage, archetype)` — 첫 `_` 기준 분리.
  `"infant" → ("infant", "")`, `"teen_introvert" → ("teen", "introvert")`,
  `"adult_artisan_hermit" → ("adult", "artisan_hermit")` (복합 archetype
  보존).
- `is_stage_manifest_id(id) -> bool` — stage prefix 가 known
  (infant/child/teen/adult) 이면 True. PR-X4-5 의 **디스패치 키**:
  True 면 `build_stage_manifest` 로, False 면 `build_default_manifest`
  로 라우팅.
- `known_stage_manifest_ids() -> list[str]` — plan §7.2 에 문서화된
  canonical id 들 정렬 반환 (프론트엔드 enumeration).
- `build_stage_manifest(id, *, model=, external_tool_names=,
  built_in_tool_names=) -> EnvironmentManifest` — 실제 materialize.

### 2. stage 별로 차등되는 4 개 knob

`plan/04 §7.1` 의 "infant 은 짧은 답 / feed-play 만 / teen 은 풍부한
표현 / 확장 도구" 을 4 개 축으로 분해:

| stage | loop.max_turns | cache.strategy | evaluate.strategy | tools.external (default) |
|---|---|---|---|---|
| infant | 2 | `system_cache` | `signal_based` | `feed`, `play` |
| child | 5 | `system_cache` | `signal_based` | `feed`, `play`, `gift` |
| teen | 8 | `aggressive_cache` | `binary_classify` | `feed`, `play`, `gift`, `talk` |
| adult | 10 | `aggressive_cache` | `binary_classify` | `feed`, `play`, `gift`, `talk` |

나머지는 전부 vtuber preset 과 동일 (stage 8 think 없음, tool/agent/emit
strategies 공통). 즉 "4 knob 만 다르고 15 stage 체인은 동일" — drift
위험을 plan/05 §4.4 의 수준으로 묶어 놓음.

### 3. archetype 은 metadata 축으로만

`"teen_introvert"` 와 `"teen_extrovert"` 는 **같은 pipeline shape** 을
쓴다. archetype 은:

- `metadata.name = "stage:teen_introvert"` (ops grep 용)
- `metadata.description` 에 자연어 설명
- `metadata.tags = ["stage:teen", "archetype:introvert"]` (metric slice
  용)

에만 반영. archetype 별 prompt 뉘앙스는 `PersonaBlock` (기존, 성격
prompt) 과 `ProgressionBlock` (PR-X4-3) 의 책임. manifest 는 파이프라인
모양만 기술한다 — species × stage × archetype 전량으로 manifest 를
복제하면 MVP 에서도 10 개 넘는 duplicate 가 쌓이고 drift 위험이 급증.

### 4. archetype 화이트리스트는 soft

plan §7.2 는 `cheerful` / `curious` / `introvert` / `extrovert` /
`artisan` 을 canonical 로 나열하지만, `build_stage_manifest` 는
**unknown archetype 도 받아들인다** (metadata 에 그대로 실림). 이유:

- PR-X4-1 의 `NamingFn` 이 pluggable 이라 deployment 가 experimental
  archetype 을 실험할 수 있어야 함.
- Stage prefix 는 hard-fail (ValueError) — 실제 파이프라인 shape 을
  모르면 빌드 불가. plan/04 §7.3 에서 전이 타깃이 infant/child/teen/
  adult 뿐이므로 이건 hard-fail 로 묶는 게 옳다.

### 5. 단위 테스트 `test_stage_manifest.py` (신규 60)

4 구획으로 나뉨:

- **Parse / predicate (8)**: 바 stage, archetype 분리, 복합 archetype,
  빈 문자열, preset / unknown reject, canonical id 포함, 정렬.
- **Stage tunings (24)**: 4 stage × bare build + 5 canonical combo
  build + unknown archetype soft + unknown stage hard + 4 knob
  × 4 stage parametrize + 3 tool override 케이스.
- **Chain shape parity with vtuber (16)**: 4 stage 각각 stage 10/11/14
  존재, stage 8 없음, tool stage strategies 동일, emit chain 비어 있음.
- **Metadata traceability (12)**: stage tag only vs stage+archetype
  tag, name grep, description, model override, model 미설정.

주요 parametrize:

- `@pytest.mark.parametrize("stage,expected", [("infant", 2), ("child", 5), ("teen", 8), ("adult", 10)])` — loop.max_turns.
- 같은 패턴으로 cache, evaluator, tool roster.

전체 60 통과, `test_default_manifest.py` 25 는 건드리지 않았으므로
그대로 pass.

## 설계 결정

- **두 factory 공존.** `build_default_manifest` 는 preset (deployment
  축), `build_stage_manifest` 는 manifest_id (growth 축). 각각이 자기
  이름대로 책임지고, PR-X4-5 의 dispatcher 가 `is_stage_manifest_id`
  로 갈라 라우팅. 하나로 합치려면 preset/stage 축 섞이는 시그니처가
  되고, 오히려 "vtuber 도 stage 취급해야 하나?" 같은 혼선이 생긴다.

- **vtuber 기반 체인을 복제.** stage_manifest 가 `_vtuber_stage_entries`
  를 import 해 재사용하려 했지만, 일부러 인라인 복제했다. vtuber 쪽
  튜닝을 바꿨을 때 stage manifest 가 조용히 따라 바뀌는 것이 더
  위험 — stage 축은 growth 실험에 쓰이므로 preset 쪽과 **독립적으로**
  움직여야 한다. 15 entry 중복은 diff 로 보이는 편이 코드 명확성에
  기여.

- **stage 4 knob 에만 차이.** 더 많은 축 (e.g. `parse.signal_detector`
  infant 는 `regex`, teen 은 더 유연) 으로 바꿀 여지는 있지만, MVP 는
  "관찰 가능한 차이 최소 세트" 가 낫다. 4 knob 은 각각 이유가 있다:
  - `loop.max_turns`: 발화 길이 체감 (infant 짧음, adult 길음).
  - `cache.strategy`: 비용 (infant 는 전반적 세션도 짧아 aggressive
    cache 수익률 낮음).
  - `evaluate.strategy`: signal_based 는 LLM 한 번 덜 (infant 는
    overshoot 를 허용해도 짧아서 괜찮음).
  - `tools.external`: plan §7.1 의 직접 명시.

- **archetype 은 pipeline 에 영향 없음.** 5 개 archetype × 4 stage
  = 20 개 pipeline shape 을 정의하면 drift 가 manifest 숫자의 제곱으로
  커진다. 말투 / 감정 임계는 `PersonaBlock` / `ProgressionBlock` /
  `AffectTagEmitter` 가 이미 담당 중 — 파이프라인 구조를 중복해
  표현할 필요 없음.

- **external override = []` 가 default 를 **끄는** 의미.** `None` 은
  "stage default 주세요" 이지만 `[]` 는 "도구 없음" — voice-only 실험
  배포 (관객 투표 대화만) 같은 유즈케이스에 명시적. `list()` 으로
  감싸 수정 고립.

- **`metadata.tags` 에 `stage:*` / `archetype:*` 쌍 실음.** Prometheus
  / ops 관점에서 "stage=teen 에서 transition 비율" 같은 쿼리가
  metadata 파싱 없이 태그만 읽어 가능.

## 의도적 비움

- **Session build 통합** — PR-X4-5. session lifecycle 이 `selector.select`
  로 id 뽑아 `is_stage_manifest_id` 디스패치해 빌드까지.
- **Archetype → PersonaBlock 색채 변경** — PR-X4-3 (ProgressionBlock
  live) 또는 PR-X5 이후. 현재 `CharacterPersonaProvider` 는 archetype
  를 이미 character record 에서 읽고 있는 모양이므로 (plan/04 §1.1),
  prompt 차별화는 그쪽에서.
- **Tool roster 의 더 세밀한 stage 차등** — MVP 는 "enable/disable"
  단위. 예를 들어 infant 의 `feed` 는 "soft food only" 로 제한하는
  건 tool 자체의 argument 검증 몫이지 manifest 책임 아님.
- **`species` 축** — plan §1.1 의 `species` ("catgirl", "dragon", ...)
  는 아직 Character 모델에 없다 (PR-X4-5 가 추가). species × stage
  manifest 분기는 X5+ 까지 이월.

## 테스트 결과

- `backend/tests/service/langgraph/test_stage_manifest.py` — **60/60**.
- 인접 회귀 (langgraph/default_manifest + progression + state + persona +
  emit + game) — **317 passed**. PR-X4-1 의 20 + 기존 default manifest
  25 + state/persona/emit/game 272 그대로.

## 다음 PR

PR-X4-3 `feat/progression-block-live` — `backend/service/persona/blocks.py`
의 `ProgressionBlock` 를 실제 구현. X1 에서 skeleton 만 두고 "stage
descriptor 는 stage_manifest 가 바뀌면 같이 움직여야 한다" 고 잡아
뒀던 부분. `p.life_stage`, `p.age_days` 를 읽어 plan §7.5 의
`{"infant": "아직 어린", ...}` 매핑으로 한 줄 prompt 생성.
