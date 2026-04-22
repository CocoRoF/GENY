# PR-X5-3 · `refactor/tamagotchi-as-plugin` — 진행 기록

**Date.** 2026-04-22
**Status.** Implemented, 8 신규 + 122 인접 회귀 (plugin / persona /
integration) pass.

PR-X5-1 이 Protocol, PR-X5-2 가 Registry 를 찍었고, 본 PR 은 *첫 번째
실제 플러그인* 을 도입한다 — 현 `AgentSessionManager` 내부에 직접
wire 되어 있던 tamagotchi 요소를 `TamagotchiPlugin` 로 재포장.

본 PR 의 원칙은 **구조 변경만, 동작 불변**. Persona provider 는
여전히 같은 4 개 블록과 같은 seed pool 을 받고, 렌더 결과 byte-
identical. Registry 경유로 바뀌는 것은 "manager 가 직접 리스트를
하드코딩" 에서 "plugin 이 소유, registry 가 전달" 로.

## 범위

### 1. `backend/service/plugin/tamagotchi.py` — `TamagotchiPlugin`

```python
class TamagotchiPlugin(PluginBase):
    name = "tamagotchi"
    version = "0.1.0"

    def __init__(
        self, *, event_seeds: Sequence[EventSeed] = DEFAULT_SEEDS,
    ) -> None:
        self._event_seed_pool = EventSeedPool(event_seeds)

    @property
    def event_seed_pool(self) -> EventSeedPool: ...

    def contribute_prompt_blocks(self, session_ctx):
        return (MoodBlock(), VitalsBlock(), RelationshipBlock(),
                ProgressionBlock())
```

나머지 5 훅 (`contribute_emitters` / `attach_runtime` / `tickers` /
`tools` / `session_listeners`) 은 `PluginBase` 의 no-op 기본값 상속.

**블록 인스턴스는 per-call fresh.** contribute_* 는 side-effect-free
해야 한다는 protocol 계약, 그리고 "per-session 간 상태 누출 금지"
원칙의 보조장치. 블록 자체가 stateless 라 인스턴스화 비용은 trivial.

**`event_seed_pool` 은 plugin-specific 접근자.** Protocol 의 6 훅
어디에도 맞지 않는다 — `CharacterPersonaProvider` 가 블록 리스트와
별개의 생성자 kwarg 로 받기 때문. 새 Protocol 훅을 만들기보다
`plugin.event_seed_pool` 로 노출하는 게 scope 대비 값 뽑기가 쉽다.
다른 플러그인이 또 event_seed pool 을 제공할 일이 생기면 그때
훅화.

### 2. `backend/service/langgraph/agent_session_manager.py` — `__init__` 재배선

Before:

```python
from backend.service.persona.blocks import MoodBlock, VitalsBlock, ...
from backend.service.game.events import DEFAULT_SEEDS, EventSeedPool

self._persona_provider = CharacterPersonaProvider(
    ...,
    live_blocks=(MoodBlock(), VitalsBlock(), RelationshipBlock(),
                 ProgressionBlock()),
    event_seed_pool=EventSeedPool(DEFAULT_SEEDS),
)
```

After:

```python
self._plugin_registry = PluginRegistry()
self._tamagotchi_plugin = TamagotchiPlugin()
self._plugin_registry.register(self._tamagotchi_plugin)

self._persona_provider = CharacterPersonaProvider(
    ...,
    live_blocks=self._plugin_registry.collect_prompt_blocks({}),
    event_seed_pool=self._tamagotchi_plugin.event_seed_pool,
)
```

만들어지는 `CharacterPersonaProvider` 는 이전과 **identical** — 같은
4 블록 (같은 순서), 같은 pool. Registry 경유라는 것만 다름.

### 3. `backend/service/plugin/__init__.py`

`TamagotchiPlugin` 재노출 추가.

## 테스트 — `backend/tests/service/plugin/test_tamagotchi.py`

8 신규:

1. `test_tamagotchi_plugin_satisfies_protocol` — `isinstance(_, GenyPlugin)`.
2. `test_contribute_prompt_blocks_returns_four_live_blocks_in_order`
   — `[MoodBlock, VitalsBlock, RelationshipBlock, ProgressionBlock]`
   순서 핀.
3. `test_contribute_prompt_blocks_returns_fresh_instances_per_call`
   — per-call 독립성.
4. `test_event_seed_pool_exposes_default_catalogue` — pool 이 살아
   있고 `pick` 이 raise 없이 동작.
5. `test_event_seed_pool_accepts_custom_seed_catalogue` — 커스텀
   seed 주입.
6. `test_unused_hooks_inherit_pluginbase_defaults` — 나머지 5 훅
   빈 리턴.
7. `test_tamagotchi_plugin_in_registry_fans_out_blocks` —
   `PluginRegistry.register` + `collect_prompt_blocks` 통합.
8. `test_default_seeds_count_is_eight` — DEFAULT_SEEDS 변경 시 회귀
   트립와이어.

## 회귀

```
pytest backend/tests/service/plugin/ \
       backend/tests/service/persona/ \
       backend/tests/integration/
```

→ 122 passed (기존 114 + 8 신규). `CharacterPersonaProvider` 주변
회귀 없음 — 인입값이 구조적으로 동일하므로 예상된 결과.

전체 백엔드 sweep 에서 보이는 5 failed / 15 errors 는 numpy/fastapi
미설치 + text sanitizer / template 관련 pre-existing 실패로, PR-X5-1
에서도 확인했던 것과 동일. `git checkout main && pytest ...` 로
main 에서 재현 — 본 PR 무관.

## 설계 선택

### 왜 블록·seed pool *만* 옮겼는가

계획 index §목표 는 "state + blocks + seeds + tools + decay ticker +
progression selector" 를 한 플러그인으로 묶는 것을 그린다. 본 PR
에서는 그 중 **blocks + seeds** 만 먼저 옮긴다. 이유:

- **State / DecayService** — `AgentSession.state_provider=` 경로,
  `main.py` 의 `set_state_provider(provider, decay_service=...)`
  배선을 같이 건드려야 한다. plan/05 §5.3 의 "executor 수정은
  X5-4 까지 미룸" 정책과 깔끔하게 분리됨.
- **AffectTagEmitter** — 현 `install_affect_tag_emitter(pipeline)`
  은 pipeline mutation 직접 호출. `contribute_emitters` 경유 설치
  경로는 emit chain 쪽 수정이 필요 — 별도 follow-up 이 맞음.
- **ManifestSelector** — 본질적으로 *character-driven* (캐릭터마다
  성장 트리가 다름). Plugin 이 제공한다는 모델이 어색. Protocol 의
  6 훅에도 잡혀 있지 않음 — 적어도 X6 까지 보류.
- **Game tools** — ToolLoader 가 manifest-driven. Live
  `register_tool` API 부재라 `contribute_tools` 결과를 쓸 곳이
  없음.

본 PR 은 "registry 경유로 블록을 전달하는 경로가 실제로 동작함" 을
증명하는 것 자체가 이득. 나머지 surface 는 각자 재배선을 위한
별도 PR 로 쪼개는 쪽이 리뷰/롤백 비용 최저.

### 왜 `event_seed_pool` 을 훅 아닌 속성으로

Protocol 의 6 훅은 *확장 표면 contribution* — "내 모듈이 이런
요소를 기여한다" 를 표현한다. `EventSeedPool` 은 `CharacterPersonaProvider`
가 블록 리스트와 병렬로 받는 *collaborator* — "기여" 라기보다
"소유/보관" 에 가까워서, 훅보다 plugin 객체의 속성으로 노출하는
게 실제 호출측 흐름과 잘 맞는다. 훅을 늘리면 Protocol 변경 →
PR-X5-1 재방문인데, 비용이 큼.

## 의도적 이월

- `CreatureStateProvider` / `CreatureStateDecayService` 를 플러그인으로
  흡수 — PR-X5-4 (executor attach_runtime bump) 또는 즉시 후속.
- `AffectTagEmitter` 를 `contribute_emitters` 경로로 이동 — emit
  chain 재배선 별도 PR.
- `ManifestSelector` 이동 — 7 번째 훅 추가 여부 별도 설계.
- Game tools live 등록 — ToolRegistry 리팩터 필요.

## 다음 PR

원래 계획상 PR-X5-4 `feat/attach-runtime-session-runtime-kwarg` (geny-
executor 리포) 와 PR-X5-5 `chore/pin-executor-0.30.0` (Geny 리포) 이
남지만, plan/index "0줄 수정 원칙 / 정말 필요할 때만" 정책상 현
MVP 는 bump 없이 동작. X5 사이클의 정적 산출은 이 PR 에서
클로즈하고, attach_runtime 경유 상태 전달이 실제로 필요한 시점에
X5-4/5-5 를 재검토.
