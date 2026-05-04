# Environment Preset 동기화 — VTuber/Worker 21-stage 재정비 계획 (rev2)

> 작성: 2026-05-04 · 대상: Geny ↔ geny-executor 1.15.0 정합성 / VTuber·Worker 프리셋 품질
> 범위: `Geny/backend/service/` + `Geny/frontend/src/` + `Geny/backend/controller/` + `Geny/backend/tests/`
> 우선순위: **worker_easy 완전 삭제** → 16-stage 잔재 제거 → VTuber/Worker 프리셋 고품질화 → UI 텍스트 정합
>
> rev2 변경: worker_easy 분리 폐기 → `worker_adaptive` 단일 worker 프리셋만 유지. 사용자 직접 지시.

---

## 0. 한 줄 진단

Geny는 **이미 21-stage 매니페스트를 발행** ([default_manifest.py](../../backend/service/executor/default_manifest.py))하고 있지만,
**(1) `worker_easy`라는 dead-code preset이 분기 로직·테스트·UI 텍스트에 잔재**하고,
**(2) 필수 stage 검증이 16-stage 시절 가정**(`_REQUIRED_ORDERS = {1, 6, 9, 16}`)이며,
**(3) i18n / docstring에 "16단계" 라벨이 6+곳**에 박혀 있고 — 캔버스 헤더("16단계 아키텍처")로 노출,
**(4) VTuber 프리셋이 신규 5개 stage 전부 비활성** 이라 1.15.0의 가치를 0% 활용 중이다.

worker는 **하나의 프리셋(`worker_adaptive`)만** 남기고, VTuber는 **세 개의 신규 stage(s11/s19/s20)를 정식 활성화**해서 두 프리셋을 모두 "고품질"로 정돈한다.

---

## 1. 현 상황 (실제 코드 기준)

### 1.1 geny-executor 1.15.0이 제공하는 것

기준점: [src/geny_executor/core/environment.py](../../../geny-executor/src/geny_executor/core/environment.py), [src/geny_executor/core/introspection.py:141](../../../geny-executor/src/geny_executor/core/introspection.py#L141)

- **21-stage 파이프라인**. 16-stage v2 → 21-stage v3 마이그레이션은 자동 (`_V3_NEW_ORDERS`, [environment.py:287-314](../../../geny-executor/src/geny_executor/core/environment.py#L287-L314)).
- **신규 5개 stage** (모두 default `active=False`):
  - s11_tool_review — 도구 호출 사전 리뷰 체인 (schema → sensitive → destructive → network → size)
  - s13_task_registry — 위임 작업 레지스트리 + 정책
  - s15_hitl — Human-in-the-Loop 게이트 (요청자 + 타임아웃)
  - s19_summarize — 턴 요약 + 중요도 평가
  - s20_persist — 체크포인트 작성/복원
- **필수 4개 stage** ([introspection.py:141](../../../geny-executor/src/geny_executor/core/introspection.py#L141)): `s01_input`, `s06_api`, `s09_parse`, **`s21_yield`**.

### 1.2 Geny 백엔드의 매니페스트 발행 (현재 상태)

[backend/service/executor/default_manifest.py](../../backend/service/executor/default_manifest.py)에서 **세 프리셋**을 발행한다.

| 프리셋 | base stages | 신규 5개 활성 | 비고 |
|---|---|---|---|
| **worker_adaptive** | 16개 | s11 ✅ · s13 ❌ · s15 ✅ · s19 ✅ · s20 ✅ | aggressive_cache, binary_classify, max_turns=30 |
| **worker_easy** | worker_adaptive와 **base 동일** | 모두 ❌ | base `_worker_adaptive_stage_entries()` 공유 ([L271-275](../../backend/service/executor/default_manifest.py#L271-L275)). 차이는 런타임 max_turns=1 뿐 |
| **vtuber** | 14개 (s08 think 제외) | **모두 ❌** | system_cache, signal_based, max_turns=10 |

**worker_easy의 실태**:
- 매니페스트는 worker_adaptive와 100% 동일한 stage chain ([default_manifest.py:271-275](../../backend/service/executor/default_manifest.py#L271-L275)).
- 차이를 만드는 건 오직 [_PRESET_SCAFFOLD_OVERRIDES[_WORKER_EASY] = {}](../../backend/service/executor/default_manifest.py#L182-L186) (scaffold 0개 활성) 와 host-side max_turns=1 강제.
- 진입 경로는 **단 한 곳**: [agent_controller.py:1055, 1076](../../backend/controller/agent_controller.py#L1055)
  ```python
  preset = 'vtuber' if 'vtuber' in wid else 'worker_easy' if 'simple' in wid else 'worker_adaptive'
  ```
  → workflow_id에 'simple' 문자열이 들어 있으면 worker_easy로 매핑. 'simple' workflow_id는 [docs/_archive/langgraph-era](../../backend/docs/_archive/langgraph-era/) 시절 잔재.
- `service.settings.sections` ([sections.py:32-35](../../backend/service/settings/sections.py#L32-L35))의 `available = ["worker_adaptive", "vtuber"]` — 사용자 설정 차원에서 이미 worker_easy 미노출.
- 즉 **dead code + 사용자에게 안 보이는 우회로 + 테스트만 부지런히 동행**하는 상태.

### 1.3 환경 시드 설치 흐름

```
main.py boot
 → service.environment.templates.install_environment_templates()
 → create_worker_env() / create_vtuber_env()
 → build_default_manifest(preset="worker_adaptive" | "vtuber")  ← worker_easy 시드 없음
 → EnvironmentService._write_manifest("template-worker-env" | "template-vtuber-env")
```

세션 생성 ([agent_session_manager.py](../../backend/service/executor/agent_session_manager.py)):
```
session 생성 요청
 → role_defaults.resolve_env_id(role, explicit)
   - VTuber role  → "template-vtuber-env"
   - Worker/Dev/Researcher/Planner → "template-worker-env"
 → EnvironmentService.load_manifest()
 → Pipeline.from_manifest_async() → attach_runtime() (런타임 의존 슬롯 주입)
```

⇒ 시드 환경은 이미 vtuber + worker 두 개뿐. worker_easy는 시드도 없고 영구 env_id도 없음 — 휘발성 매니페스트로만 존재.

### 1.4 frontend의 21-stage 시각화

- [components/session-env/stageMetadata.ts](../../frontend/src/components/session-env/stageMetadata.ts) — 21-stage 메타데이터 완비, 신규 5개 한국어/영어 라벨 등록.
- [components/session-env/PipelineCanvas.tsx](../../frontend/src/components/session-env/PipelineCanvas.tsx) — 21 노드 캔버스, `entry.active=false` 시 `.inactive` 회색.
- [components/env_management/StageDetailView.tsx](../../frontend/src/components/env_management/StageDetailView.tsx) — 21개 dedicated editor (`Stage11ToolReviewEditor`...`Stage21YieldEditor`).

스크린샷의 캔버스 자체는 **21-stage 정상 렌더**. 회색 노드는 VTuber 프리셋의 `active=false` 표시일 뿐 시각화 버그 아님.

---

## 2. 명확한 결함 (실제 버그 + dead code + 외관 outdated)

### 🚨 2.1 [DEAD CODE] worker_easy preset 자체

**사용자 지시: "WORKER 관련 ENV는 하나만 존재할거야 그냥 제대로 된 것으로 하나만 — worker_easy는 그냥 삭제."**

근거:
- worker_easy의 매니페스트 = worker_adaptive 매니페스트 (stage chain identical).
- 사용자 노출 경로 0건. 'simple' wid 우회로 1건 (langgraph-era 잔재).
- 시드 환경 없음, 영구 env_id 없음.
- 의도된 차이("single-turn")는 매니페스트가 아닌 host-side max_turns=1 hack으로 표현 → self-describing 위반.
- 단일 턴 동작이 정말 필요하면 사용자가 worker 매니페스트를 복제해서 `pipeline.single_turn=True` 한 줄 박는 게 정도. **시스템이 selp-named "easy" 변종을 들고 있을 이유 없음.**

⇒ **완전 삭제**. naming은 `worker_adaptive` 그대로 유지 (`_DEFAULT_ALIAS = "default"`도 유지). rename은 변경 폭만 늘리고 가치 없음.

### 🐞 2.2 [BUG] `_REQUIRED_ORDERS = {1, 6, 9, 16}`

[backend/service/environment/service.py:52-58](../../backend/service/environment/service.py#L52-L58)

```python
# Mirrors geny_executor.core.introspection._STAGE_REQUIRED
# (s01_input, s06_api, s09_parse, s16_yield).
_REQUIRED_ORDERS: frozenset[int] = frozenset({1, 6, 9, 16})
```

주석은 `s16_yield`라 적었지만 21-stage에서 **s16=Loop, s21=Yield**. 실제 executor의 `_STAGE_REQUIRED = {"s01_input", "s06_api", "s09_parse", "s21_yield"}`.

**증상**: `_force_required_stages_active()`가 Loop(s16)를 강제 활성화하지만, Yield(s21)는 사용자가 `active=False`로 저장 가능. Yield가 꺼진 매니페스트가 디스크에 들어가면 다음 boot에서 `Pipeline.from_manifest()` 빌드 실패.

**수정**: `frozenset({1, 6, 9, 21})` + 주석 정정.

### 🐞 2.3 [GAP] VTuber 프리셋이 신규 stage 0개 활성

[default_manifest.py:187-191](../../backend/service/executor/default_manifest.py#L187-L191):
```python
_VTUBER: {
    # VTuber turns are conversational — summary defers to host-side
    # mood/bond accumulation rather than a structured turn record.
},
```

Sub-phase 9a 5개 전부 default 비활성. 결과:
- **s11 tool_review 없음** — VTuber도 web_fetch/news_search/web_search 호출. sensitive/network 리뷰 패스 → 보안 후퇴.
- **s19 summarize 없음** — 긴 대화 핵심 누적 미흡. host-side mood/bond와 별개의 "이번 턴 요약"이 발행 안 됨.
- **s20 persist 없음** — 체크포인트 미발행. 세션 복원이 host-side 로직에만 의존.
- s13 task_registry · s15 hitl — VTuber는 단일-에이전트 + 자율이라 비활성 OK.

### 🐞 2.4 [GAP] worker_adaptive에 task_registry 비활성

worker_adaptive overrides ([L132-181](../../backend/service/executor/default_manifest.py#L132-L181))에서 s11/s15/s19/s20만 켜고 **s13(task_registry) 비활성**. 그런데 worker는 `send_direct_message_internal` 등으로 sub-worker 위임을 한다. task_registry 없으면 위임 lifecycle 추적이 host-side에만 의존 → executor가 제공하는 정책 인프라 미사용.

### 🚨 2.5 [LABEL] i18n / docstring "16단계" 잔재

| 위치 | 현재 | 비고 |
|---|---|---|
| [frontend/src/lib/i18n/ko.ts:530](../../frontend/src/lib/i18n/ko.ts#L530) | `title: '16단계 아키텍처'` | **스크린샷 헤더 라벨** |
| [frontend/src/lib/i18n/ko.ts:2146](../../frontend/src/lib/i18n/ko.ts#L2146) | `subtitle: '...16-stage 파이프라인의 artifact/config/active...'` | env_management 부제 |
| [frontend/src/lib/i18n/ko.ts:2229](../../frontend/src/lib/i18n/ko.ts#L2229) | `presetAgent: 'Agent — 16 스테이지 풀 파이프라인'` | preset 설명 |
| [frontend/src/lib/i18n/en.ts:2099](../../frontend/src/lib/i18n/en.ts#L2099) | `Edit the 16-stage pipeline...` | 동일 (영문) |
| [frontend/src/lib/i18n/en.ts:2182](../../frontend/src/lib/i18n/en.ts#L2182) | `Agent — full 16-stage pipeline` | 동일 (영문) |
| [frontend/src/components/tabs/SessionEnvironmentTab.tsx:6](../../frontend/src/components/tabs/SessionEnvironmentTab.tsx#L6) | `16-stage pipeline canvas` | 주석 |
| [backend/controller/catalog_controller.py:49](../../backend/controller/catalog_controller.py#L49) | `Return the 16-stage summary list` | docstring |
| [backend/service/executor/agent_session.py:235](../../backend/service/executor/agent_session.py#L235) | `geny-executor Pipeline: 16-stage execution engine` | docstring |

⚠️ 주의: `section_help/content/Stage*.ts` 안의 "16단계 (Loop)"는 **정확** (21-stage에서 s16=Loop). 건드리지 말 것.

### 🟡 2.6 [UX] 캔버스 회색 노드의 의미 불명

PipelineCanvas는 `active=false`를 단일 회색 톤으로만 표시. 사용자가 보는 회색 노드의 실제 의미는 두 종류:
1. **이 프리셋이 의도적으로 빼는 stage** (예: VTuber의 s08_think) — 영구 비활성.
2. **Sub-phase 9a 신규, 옵션 stage** (s11/s13/s15/s19/s20) — 프리셋별 선택.

이 두 종류를 시각적으로 구분하지 않으면 사용자가 "왜 회색인지" 추측만 가능. legend / hover tooltip 필요.

---

## 3. 개선 계획

세 단계로 분리. 각 단계는 독립적 PR로 머지 가능.

### Phase 1 — `worker_easy` 완전 제거 + `_REQUIRED_ORDERS` 버그 수정 + i18n 라벨 갱신

**목표**: dead code 제거 + correctness 버그 수정 + UI 텍스트 동기화. 동작 변경 없음 (worker_easy 사용자 0명, 매니페스트 동일).

#### 3.1.1 worker_easy 코드 삭제

- [default_manifest.py](../../backend/service/executor/default_manifest.py)
  - L47 `_WORKER_EASY = "worker_easy"` 제거
  - L51 `_KNOWN_PRESETS` set에서 `_WORKER_EASY` 제거 → `{_VTUBER, _WORKER_ADAPTIVE, _DEFAULT_ALIAS}`
  - L182-186 `_PRESET_SCAFFOLD_OVERRIDES[_WORKER_EASY]` 항목 제거
  - L268-275 `_build_stage_entries()`의 worker_easy 주석/분기 단순화 — `if preset == _VTUBER: ... else: worker_adaptive` 그대로 두되 주석 갱신
  - L555-556 `build_default_manifest` docstring "worker_easy" 제거
  - 모듈 헤더 docstring (L3-4) "worker_easy" 제거

- [stage_manifest.py:43](../../backend/service/executor/stage_manifest.py#L43)
  - "vtuber / worker_adaptive / worker_easy" → "vtuber / worker_adaptive"

- [agent_controller.py:1055, 1076](../../backend/controller/agent_controller.py#L1055)
  - `preset = 'vtuber' if 'vtuber' in wid else 'worker_easy' if 'simple' in wid else 'worker_adaptive'`
  - → `preset = 'vtuber' if 'vtuber' in wid else 'worker_adaptive'`
  - 'simple' wid 분기 자체가 langgraph-era 잔재라 안전하게 제거.

- [agent_controller.py:1273](../../backend/controller/agent_controller.py#L1273) 주석에서 worker_easy 언급 제거.

#### 3.1.2 worker_easy 테스트 정리

| 파일 | 처리 |
|---|---|
| [tests/service/executor/test_default_manifest.py:22, 46, 95-96, 121-124, 145-147](../../backend/tests/service/executor/test_default_manifest.py#L22) | parametrize에서 worker_easy 제거. negative-control 테스트는 vtuber 단일 case로 단순화 |
| [tests/service/executor/test_g12_phase7_activation.py:7-9, 34-36, 100](../../backend/tests/service/executor/test_g12_phase7_activation.py#L7) | worker_easy를 negative control로 쓰던 테스트 삭제 또는 vtuber로 통합. `test_worker_easy_uses_adaptive_router`는 의미 소멸 — 삭제 |
| [tests/service/executor/test_permission_guard_chain.py:36-44](../../backend/tests/service/executor/test_permission_guard_chain.py#L36) | `test_worker_easy_declares_permission_guard` 삭제 (worker_adaptive 테스트가 동일 invariant 커버) |
| [tests/service/executor/test_partition_execution.py:34](../../backend/tests/service/executor/test_partition_execution.py#L34) | `@pytest.mark.parametrize("preset", ("worker_adaptive", "worker_easy"))` → `("worker_adaptive",)` |
| [tests/service/executor/test_default_manifest.py:42-46](../../backend/tests/service/executor/test_default_manifest.py#L42) | preset → 활성화 신규 stage 매핑 dict에서 worker_easy entry 삭제 |

#### 3.1.3 frontend worker_easy 라벨 정리

- [stageMetadata.ts:469, 1205](../../frontend/src/components/session-env/stageMetadata.ts#L469) — "VTuber와 worker_easy는 기본 비활성" → "VTuber는 기본 비활성"
- [section_help/content/Stage01Normalizer.ts:52, 154](../../frontend/src/components/env_management/section_help/content/Stage01Normalizer.ts#L52) — "(vtuber / worker_adaptive / worker_easy)" → "(vtuber / worker_adaptive)"

#### 3.1.4 `_REQUIRED_ORDERS` 버그 수정

- [backend/service/environment/service.py:52-58](../../backend/service/environment/service.py#L52-L58)
  - `frozenset({1, 6, 9, 16})` → `frozenset({1, 6, 9, 21})`
  - 주석 `s16_yield` → `s21_yield`

#### 3.1.5 "16단계" → "21단계" i18n 일괄 교체

위 §2.5의 8개 위치 (i18n 5곳 + 주석/docstring 3곳). `presetAgent` 설명도 단순 숫자 갈음을 넘어 의미 강화:
- ko: `presetAgent: 'Agent — 21 스테이지 풀 파이프라인'`
- en: `presetAgent: 'Agent — full 21-stage pipeline'`

⚠️ 다시 강조: `section_help/content/Stage*.ts`의 "16단계 (Loop)" 표현은 **건드리지 말 것** (21-stage에서 s16=Loop라 정확).

**Phase 1 완료 검증**
- [ ] `pytest backend/tests/` 전체 통과
- [ ] boot 후 `data/environments/template-vtuber-env.json` / `template-worker-env.json` 생성 확인 (worker_easy 시드는 원래도 없었음)
- [ ] 새 worker 세션 graph endpoint (`/{session_id}/graph`) 응답 `preset` 항상 `worker_adaptive` 또는 `vtuber`
- [ ] frontend grep `"16단계\|16-stage\|16 stage"` — i18n / 주석 / docstring 0건 (단, `section_help/content/Stage*.ts`는 예외)
- [ ] 캔버스 헤더 라벨 "21단계 아키텍처" 노출
- [ ] `_REQUIRED_ORDERS` 변경 후 매니페스트에서 s21_yield를 active=false로 시도 → `_write_manifest`가 강제로 true 교정

### Phase 2 — VTuber 프리셋 고품질화

**목표**: VTuber 프리셋에 신규 stage 3개(s11/s19/s20)를 명시 활성화. 1.15.0의 가치 활용.

[default_manifest.py:187-191 `_PRESET_SCAFFOLD_OVERRIDES[_VTUBER]`](../../backend/service/executor/default_manifest.py#L187-L191) 확장:

```python
_VTUBER: {
    # 도구 안전 리뷰 — VTuber도 web_fetch/news_search/web_search 호출.
    # 가벼운 리뷰어 두 개만: schema(인자 검증) + sensitive(개인정보).
    # destructive/network/size는 VTuber 도구 surface가 작아서 과한 cost.
    "tool_review": {
        "active": True,
        "chain_order": {"reviewers": ["schema", "sensitive"]},
    },
    # 턴 요약 — 페르소나 대화의 핵심 의제 누적.
    # rule_based(신호 추출) + heuristic(중요도)으로 host-side mood/bond
    # 누적과 분리된 "이번 턴 요약"을 state.shared에 발행 →
    # GenyMemoryStrategy가 다음 턴 컨텍스트로 활용.
    "summarize": {
        "active": True,
        "strategies": {
            "summarizer": "rule_based",
            "importance": "heuristic",
        },
    },
    # 체크포인트 — 페르소나의 "이전 N턴" 복원이 자연스러워짐.
    # on_significant: HITL/태스크 결과/높은 중요도 발생 시에만 디스크 IO.
    "persist": {
        "active": True,
        "strategies": {
            "persister": "no_persist",  # FilePersister는 attach_runtime이 주입
            "frequency": "on_significant",
        },
    },
    # task_registry / hitl — VTuber는 단일-에이전트 + 자율이라 OFF 유지.
},
```

**런타임 wiring 확인 (sub-task, 코드 추적 필요)**:
1. [service/persist/install.py](../../backend/service/persist/) (있다면) `install_file_persister`가 VTuber 세션에도 호출되는지. 호출 안 되면 `persister=no_persist`로 남아 active=True여도 noop → install 함수 호출 분기에 VTuber 추가.
2. `service/summary` 또는 등가 host-side 컴포넌트가 `state.shared['turn_summary']` 소비하는지. 없으면 stage가 발행만 하고 무용 → 소비자 추가 또는 이번 PR 범위에서 제외.
3. `tool_review` 이벤트가 session_logger / WebSocket에 노출되는지 확인 (worker_adaptive는 이미 forward한다고 [default_manifest.py:135-141](../../backend/service/executor/default_manifest.py#L135-L141) 주석에 적힘).

**Phase 2 완료 검증**
- [ ] VTuber 세션에서 web_search 호출 시 tool_review 이벤트 노출
- [ ] VTuber 5+ 턴 후 `state.shared['turn_summary']` 발행 + GenyMemoryStrategy 소비
- [ ] VTuber 세션 종료 후 storage_path에 체크포인트 파일 존재 (significant event 발생 시)
- [ ] `pytest backend/tests/service/executor/test_default_manifest.py` 갱신: VTuber active set이 `{"tool_review", "summarize", "persist"}`로 변경됨을 검증

### Phase 3 — Worker(adaptive)에 task_registry 활성화

**목표**: worker_adaptive에 s13 task_registry 활성화로 sub-worker 위임 lifecycle을 stage 레이어에서 추적.

[default_manifest.py:132-181 `_PRESET_SCAFFOLD_OVERRIDES[_WORKER_ADAPTIVE]`](../../backend/service/executor/default_manifest.py#L132-L181)에 추가:

```python
_WORKER_ADAPTIVE: {
    ...,  # tool_review / hitl / summarize / persist
    "task_registry": {
        "active": True,
        "strategies": {
            "registry": "in_memory",
            "policy": "fire_and_forget",  # sub-worker delegation에 부합
        },
    },
},
```

**Sub-task — host-side consumer**:
- 위임 작업이 registry에 등록되어도 host-side에서 progress를 update하는 코드가 없으면 stage 활성화는 cosmetic. `send_direct_message_internal` 호출 경로 + AgentSessionManager에서 task_registry API를 부르도록 통합 필요.
- 통합 없이 PR-3을 머지하면 active=True 빈 registry 상태. 그것도 invariant 측면 정합 (executor가 registry 슬롯을 인스턴스화는 함)이지만 의미 없음 → 통합 작업이 동반돼야 진짜 가치.

**Phase 3 완료 검증**
- [ ] worker_adaptive 세션에서 sub-worker 위임 시 task_registry에 task entry 등록
- [ ] task lifecycle이 session_logger에 노출 (시작/완료/실패)
- [ ] `test_default_manifest.py`의 worker_adaptive active set에 `"task_registry"` 추가

### Phase 4 — Frontend UX (선택적)

#### 4.1 Pipeline Canvas 회색 노드 legend

회색의 두 의미를 시각적으로 분리:
- **"이 프리셋이 의도적으로 제외"** (예: VTuber의 s08_think) — 진한 회색, hover시 "이 프리셋에선 사용 안 함"
- **"Sub-phase 9a 옵션, 비활성"** (s13처럼 프리셋이 켜지 않은 경우) — 점선 외곽선 + hover시 "옵션 stage — 활성화 시 X 효과"

`stageMetadata.ts`의 카테고리(`review` / `orchestration` / `gate` / `finalize`)를 활용해 자동 구분. `canBypass` 플래그로 prefix 결정.

#### 4.2 프리셋 비교 카드

`CreateSessionModal`에서 role 선택 시 프리셋 카드:
- VTuber: "14 active stage · tool_review/summary/persist 옵션 ON"
- Worker: "16 active stage · 5개 옵션 모두 ON"

사용자가 카드만 보고 차이를 즉시 인지.

#### 4.3 `presetAgent` 설명 의미 강화

ko/en 단순 "21 스테이지" 갈음을 넘어:
- ko: `'Agent — 21 스테이지 어댑티브 (도구 리뷰 · 요약 · 체크포인트 · HITL 포함)'`
- en: `'Agent — 21-stage adaptive (tool review · summary · checkpoint · HITL included)'`

---

## 4. 위험 / 미해결 질문

1. **`persist.install_file_persister`가 VTuber 세션에 적용 가능한가** — 코드 미확인. 적용 안 되면 Phase 2의 s20 active=True가 noop. PR-2 사전에 추적.
2. **task_registry의 host-side consumer가 누구인가** — 현재 미통합 가능성. PR-3을 stage-only / host-integration 두 PR로 쪼갤지 결정.
3. **summarize의 turn_summary를 GenyMemoryStrategy가 실제로 읽는가** — attach_runtime swap 코드 추적 필요.
4. **'simple' wid를 가진 워크플로우가 운영 환경에 실제 존재하는가** — DB / 실데이터 grep. 존재하면 worker_easy 삭제 시 일시적으로 worker_adaptive로 흡수되는데, 이는 사용자 의도와 부합하므로 OK. 없으면 더 청결한 삭제.

---

## 5. 작업 순서 (PR 분할)

| PR | 내용 | 의존성 | 위험 |
|---|---|---|---|
| **PR-1** | worker_easy 완전 삭제 + `_REQUIRED_ORDERS` fix + i18n "16→21" 갱신 | — | 낮음 (dead code, 텍스트, invariant fix) |
| **PR-2** | VTuber 프리셋에 s11/s19/s20 활성화 (런타임 wiring 확인 포함) | PR-1 | 중 (위험 1, 3 답에 따라 noop 위험) |
| **PR-3** | worker_adaptive에 s13 활성화 + host-side task_registry consumer | PR-1 | 중 (위험 2 답에 따라 host-side 작업 동반) |
| **PR-4** | Pipeline Canvas legend + 프리셋 비교 카드 | PR-2, PR-3 | 낮 (UX only) |

각 PR은 [feedback_durable_instructions](../../../.claude/projects/-home-geny-workspace/memory/feedback_durable_instructions.md)의 단일 책임 원칙을 따름. PR-1은 무위험 즉시 머지. PR-2/3은 직렬·병렬 모두 가능 (서로 다른 프리셋 건드림). PR-4는 PR-2/3 머지 후.

---

## 6. 변경 영향 요약 (한 눈에)

**삭제**:
- `_WORKER_EASY` 상수 / scaffold override / `_KNOWN_PRESETS` 멤버 / 'simple' wid 분기 / 관련 테스트 5개 파일 / frontend 라벨 4곳

**수정**:
- `_REQUIRED_ORDERS` 16 → 21
- i18n / docstring "16단계" → "21단계" (8곳, section_help 제외)
- VTuber `_PRESET_SCAFFOLD_OVERRIDES` 빈 dict → 3개 stage 활성
- worker_adaptive `_PRESET_SCAFFOLD_OVERRIDES`에 task_registry 추가

**신규**:
- (옵션) Canvas legend 컴포넌트 + 프리셋 비교 카드 + `presetAgent` 설명 강화

**불변**:
- `default_manifest.py`의 21-stage 발행 로직 자체
- `template-worker-env` / `template-vtuber-env` env_id
- `role_defaults.ROLE_DEFAULT_ENV_ID` 매핑
- frontend stageMetadata 21-stage 메타데이터 본체
- PipelineCanvas 21-노드 렌더링 로직
- `section_help/content/Stage*.ts`의 "N단계 (XXX)" 인용 표현
