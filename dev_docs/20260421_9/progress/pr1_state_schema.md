# PR-X3-1 · `feat/state-schema` — 진행 기록

**Date.** 2026-04-21
**Status.** Implemented, 227/227 pass (기존 197 + 신규 30). X3 사이클 첫 PR — `CreatureState` 외부 래퍼의 순수 스키마 레이어 확정.

## 범위

plan/02 §1~§2 의 dataclass 시그니처 그대로 구현:
- `CreatureState` 본체 + 4 개 서브구조 (Vitals / Bond / MoodVector / Progression)
- `Mutation` (frozen) + `MutationBuffer` (append-only, ordered)
- `SCHEMA_VERSION = 1`

Provider / Registry / Decay / TickEngine 등록은 각각 PR-X3-2~4 에서 이어서.

## 적용된 변경

### 1. `backend/service/state/__init__.py` (신규)

- 새 service 트리의 루트 패키지.
- `schema/` 의 주요 심볼을 재수출 (`CreatureState`, `MutationBuffer`, `MoodVector`, …).

### 2. `backend/service/state/schema/__init__.py` (신규)

- 3 개 모듈에서 본 cycle 가 노출할 심볼 일괄 export.

### 3. `backend/service/state/schema/mood.py` (신규)

```python
@dataclass
class MoodVector:
    joy: 0.0  sadness: 0.0  anger: 0.0  fear: 0.0
    calm: 0.5  excitement: 0.0
    def keys() -> tuple[str, ...]
    def as_dict() -> dict[str, float]
    def ema(other, alpha) -> MoodVector          # alpha ∈ [0,1], 새 인스턴스 반환
    def dominant(*, threshold=0.15) -> str       # basic 감정이 threshold 초과 시 키, else "calm"
```

- **calm 은 기본 감정으로 치지 않음.** dominant() 의 후보 집합은 joy/sadness/anger/fear/excitement.
  모두 임계값 이하면 "calm" 반환 — "중립" 을 calm 의 수치와 분리.
- **EMA 는 순수 함수.** self 변경 안 하고 새 MoodVector 반환. 밖에서 감정 추출기 벡터로 이동평균할 때 idempotent.

### 4. `backend/service/state/schema/creature_state.py` (신규)

plan/02 §1.1 시그니처 그대로. `last_tick_at` 은 `datetime.now(timezone.utc)` default_factory 로 tz-aware 보장. `recent_events` / `milestones` / `Vitals` / `Bond` 등은 전부 `field(default_factory=...)` 로 인스턴스 간 독립.

### 5. `backend/service/state/schema/mutation.py` (신규)

```python
MutationOp = Literal["add", "set", "append", "event"]

@dataclass(frozen=True)
class Mutation:
    op, path, value, source, at=now_utc, note=None

class MutationBuffer:
    def append(*, op, path, value, source, note=None) -> Mutation
    @property items -> tuple[Mutation, ...]   # 불변 스냅샷
    __len__, __iter__, __bool__
```

- **순서 유지.** append 순이 apply 순.
- **items 는 tuple 스냅샷.** 반환 시점 이후 append 가 들어와도 그 snapshot 에는 영향 없음 (단위 테스트로 검증).
- `remove` / `delete` 는 의도적으로 없음 (plan/02 §2.2).

### 6. 테스트 (신규 30)

`backend/tests/service/state/schema/{test_mood,test_creature_state,test_mutation}.py`:

**MoodVector (10):** default neutral / keys & as_dict / ema α=0,1, 블렌드 / α 범위 검증 / 새 인스턴스 반환 / dominant 임계값 초과 / dominant calm fallback / 임계값 경계 / tie 시 첫 키 우승.

**CreatureState (9):** SCHEMA_VERSION=1 / Vitals 기본값 / Bond 전부 0 / Progression 기본값 / 식별자 인자 필수 / 최소 생성 / default factory 독립성 / last_tick_at UTC aware+최근 / 전부 dataclass 확인.

**Mutation/Buffer (11):** frozen=True / 기본 timestamp UTC / 4 op 모두 허용 / 빈 버퍼 / 순서 유지 / items 스냅샷 불변성 / append 반환값 / bool 의미 / iter 동치 / MutationOp 임포트.

## 테스트 결과

- `backend/tests/service/state/` — **30/30 pass**.
- `backend/tests/service/tick/` — **19/19**.
- `backend/tests/service/lifecycle/` — **27/27**.
- `backend/tests/service/persona/` — **36/36**.
- `backend/tests/service/langgraph/` — **104/104**.
- `backend/tests/service/vtuber/test_thinking_trigger_tick.py` — **11/11**.
- 총 **227/227 pass**.

## 의도적 비움

- **Provider / Registry / Hydrator / Decay** — 각각 X3-2/3/4.
- **Validation beyond construction.** `Vitals.hunger` 가 음수가 되어도 dataclass 는 막지 않음. 밸런스 로직 (clamp) 은 `apply` / `decay` 의 책임.
- **Serialization helpers.** `data_json` (SQLite) 은 PR-X3-2 에서 직렬화 방식 결정.
- **에러 타입.** `StateConflictError` 등은 provider PR 에서.

## 다음 PR

PR-X3-2 `feat/state-provider-sqlite` — `CreatureStateProvider` Protocol 선언 + SQLite 구현 + `0001_initial.sql` migration.
