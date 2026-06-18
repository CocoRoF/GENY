# Sub-Agent / Sub-Worker (executor 일급 제공) + 작업·스케줄 정합 — 분석 & 계획 (rev.4 · 결정 확정)

**작성일:** 2026-06-18 (rev.4 — 사용자 4대 결정 확정 반영)
**원칙:** 모든 주장은 실제 코드(파일:라인) 검증. 추측 0.

---

## 0. 확정된 결정 (사용자)

1. **네이밍:** **sub-worker = 일회성** 작업 위임자 / **sub-agent = 영속** 작업 위임자. (현재 코드 네이밍과 거꾸로 → 정렬 필요. §0-1)
2. **메커니즘은 전부 geny-executor가 제공.** 알림(notification)·인박스(inbox)·메시징, sub-agent/sub-worker를 *정확히 사용하는 로직* 까지 **executor가 일급으로 제공.** **Geny는 그냥 소비자(user)** — 코어 메커니즘을 호스트에서 재구현하지 않는다.
3. **완전 이식.** Geny의 bespoke Sub-Worker를 executor 메커니즘으로 **완전 대체**(이중화 제거).
4. **영속 세션 별도 노출 안 함.** VTuber로 생성 시 sub-agent를 소유하되, **지금 Geny처럼 "확인만"** 가능(별도 드라이브 세션으로 노출 X). 현행 SUB 배지 + VTuber/Sub-Agent 탭 수준의 view-only 유지.

**불변 제약:** 지금 Geny의 **모든 기능이 그대로 동작**하면서, **상당히 고도화된 executor 기능**이 추가되어야 한다(무회귀 + 큰 업그레이드).

### 0-1. 네이밍 정렬 (현재 → 목표)
| 현재 | 실제 동작 | 목표 명칭 |
|---|---|---|
| executor `SubagentType*`/`Agent`툴/`run_subagent` | 일회성 build→run→close (`subagent_type.py:669-742`) | **sub-worker** |
| Geny `Sub-Worker`(`session_type="sub"`) 페어 | 영속·자율·알람 (`agent_session_manager.py:1062-1244`) | **sub-agent** |
- catalog 명칭: **agent type**(worker/researcher/critic/…) 유지.

---

## 1. 두 프리미티브 (executor가 둘 다 일급 제공)

| | **sub-worker** (일회성) | **sub-agent** (영속) |
|---|---|---|
| 목적 | 특정 작업만 위임 | 작업 완전 위임 → 자율 완수 → 완료 알람 |
| 수명 | ephemeral (끝나면 소멸) | persistent (소유·재사용·재시작 생존) |
| 실행 | one-shot build→run→close | autonomous 백그라운드, 다중 작업/다중턴 |
| 결과 | **즉시 반환** (호출자가 이어감) | **완료 알람**(inbox/notification, 비동기) |
| 상태 | stateless | stateful (메모리·대화 유지, 주소지정) |
| 통신 | 요청→응답 | **executor inbox/메시징**(양방향) |
| Geny 사용 | ad-hoc 호출 | VTuber가 기본 소유(view-only) |
| executor 현황 | ✅ 존재(=현 run_subagent) | ❌ 신규 구현 대상 |

---

## 2. 현황 (검증)

### 2-A. executor 2.6.0
- sub-worker(일회성): ✅ `SubagentTypeDescriptor`(`subagent_type.py:98-151`), `run_subagent`/`Agent`툴, `LocalAgentExecutor`(`runtime/task_executors.py:95-143`). 매 호출 close, 무상태.
- sub-agent(영속): ❌ keep-alive·인스턴스풀·세션store·완료이벤트·다중턴·**inbox/notification 전부 부재.**
- 작업/스케줄: ✅ 네이티브(`TaskCreate/CronCreate`+`BackgroundTaskRunner`+`CronRunner`).

### 2-B. Geny
- sub-agent(영속) prototype = bespoke Sub-Worker(`agent_session_manager.py:1062-1244`): 메모리 vault 공유(`:1077-1080`), **자체 inbox**(`chat/inbox.py`)·메시징(`geny_tools.py:1050-1180`)·알람(`[SUB_WORKER_RESULT]`, `execution/agent_executor.py:601-850`)·재시작 cascade(`:1466-1482`)·트리거/아바타(`:867-906`)·SUB 배지. **← 이 메커니즘들이 executor로 이전 대상(결정2).**
- 작업/스케줄 배선 단절(GAP A~E, §2-C).

### 2-C. 작업/스케줄 배선 GAP
- **A(치명):** `agent_session.py:2343-2354` extras에 `workspace_stack`만 → task/cron/agent 런타임 미주입 → 도구 호출 실패.
- **B:** `app.state.subagent_orchestrator` 미설정 → `local_agent` 작업 실패(`service/tasks/install.py:69-78`).
- **C:** VTuber 매니페스트에 Task/Cron/Agent 미포함(`templates.py:203+`).
- **D:** 위임이 작업 우회 → 작업 탭 미표시.
- **E:** `agent_tasks_controller.py:110-135` `list_tasks` 세션 미필터 + InMemory(재시작 소실).

---

## 3. 목표 아키텍처 — executor가 메커니즘 소유, Geny는 소비자 (결정2)

### 3-A. 레이어 경계 (확정)
| 책임 | 소속 |
|---|---|
| agent type catalog, **sub-worker + sub-agent 런타임**, 영속/다중턴/주소지정, **inbox·notification·메시징 메커니즘**, 완료 알람, 자율 실행, provider/model/env/tool/system_prompt 설정, budget/재귀, **lifecycle/이벤트** | **geny-executor (코어, 일급)** |
| host 영속 store **구현체 주입**(executor가 정의한 seam에), UI 렌더(view-only), persona/아바타/트리거 **flavor**(executor 이벤트 구독), 세션 DB 매핑 | **Geny (소비자)** |
| 위임 → 작업(Task) 표면화 | **Geny** (executor 이벤트 구독 → TaskRecord) |

> 결정2 핵심: inbox/알림/메시징의 **로직 자체**는 executor. Geny는 (a) executor가 정의한 **persistence seam에 자기 저장소를 꽂고**, (b) executor가 쏘는 **이벤트를 구독해 UI/아바타/트리거를 그림**. 코어 메커니즘 재구현 금지.
> seam(저장소 주입)과 메커니즘(inbox/알림 로직)은 다르다 — 로직은 executor, *저장 매체*만 host가 제공.

### 3-B. Geny 사용 모델 (결정3·4)
- VTuber 생성 → executor **sub-agent 1개 spawn(소유)**. bespoke 페어/inbox/delegation/execute_command 경로 **완전 제거**, executor 메커니즘으로 대체.
- sub-agent는 **view-only**(별도 드라이브 세션 노출 X) — 현 SUB 배지 + VTuber/Sub-Agent 탭으로 확인만.
- worker/VTuber는 ad-hoc **sub-worker** 호출 가능.
- 두 경로 모두 작업 탭에 task로 표면화.

---

## 4. executor 2.7.0 API 설계 (additive·비파괴 — 조사로 확인) ★ 구현 전 사용자 검토 권장

### 4-A. agent type (catalog) — 설정 고도화
`SubagentTypeDescriptor` 확장(`subagent_type.py:98-151`): `system_prompt`, `tool_preset`(매크로), `max_delegation_depth`/`no_further_delegation`, `cost_budget_usd`/`token_budget`, `thinking_*`. 전부 optional.

### 4-B. sub-worker (일회성) — 정리/명명
- 기존 `run_subagent`(build→run→close)를 **sub-worker**로 명명·문서화(동작 유지).
- 툴: `Delegate`(=일회성, 결과 반환). (기존 `Agent` 툴 의미 고정/별칭.)

### 4-C. sub-agent (영속) — 신규 핵심
- **`SubAgentManager`**(`ToolProvider` 패턴 mirror): `(agent_type, sub_agent_id)` 인스턴스 풀, keep-alive, 명시 close, 재시작 복원.
- **`SubAgentInbox`**(신규 코어 프리미티브): agent별 mailbox. `deliver(to, msg)` / `drain(to)` / 메시지 메타(tag/sender/ts). 부모↔sub 양방향 + 알림 채널.
- **완료 알림:** sub-agent가 작업 완수 시 `subagent.completed` 이벤트 + 소유자 inbox로 결과 전달(= "알람"). `subagent.assigned/started/failed`도.
- **persistence seam:** `SubAgentBuildContext`에 `session_store`(load/save sub-state)+`memory_provider_factory`(`subagent_type.py:64-89`). 호스트가 *저장소* 주입, **저장/복원 로직은 executor**.
- **다중턴/자율:** `assign(sub_agent_id, task)` → state load → 백그라운드 자율 run → save → 완료 이벤트. 호출자 비블로킹.
- **툴 표면:** `SubAgentSpawn`/`SubAgentAssign`/`SubAgentList`/`SubAgentStop`/`SubAgentInboxRead`.
- **이벤트:** `event/catalog.py`에 `subagent.*` + `on_event` hook.
- (hook 위치 상세: executor 조사 "CLEANEST UPGRADE PATHS" — `subagent_type.py:64-89,98-151,154-186,605-718`.)

### 4-D. 버저닝
optional 필드/hook only → 일회성 회귀 0. **geny-executor 2.7.0** publish(`publish.yml target=pypi`).

---

## 5. Geny 구현 (소비자)

### 5-A. 배선 (GAP A·B·E) — executor 무변경으로 가능, **즉시 가치 = PR-1**
- 매니저 경유로 `task_registry/task_runner/cron_store/cron_runner/agent_orchestrator`를 세션 `ToolContext.extras`에 주입. `app.state.subagent_orchestrator` 설정. 생성/재바인딩/재시작 경로 일관.
- `list_tasks` 세션 필터(+VTuber면 소유 sub-agent 작업 포함).
- **효과:** sub-worker(일회성) 즉시 동작 + 작업 탭 세션 격리. ("동작 불가" 해소.)

### 5-B. VTuber = sub-agent 완전 이식 (결정3, 고위험, flag+parity)
- VTuber 생성 시 executor **sub-agent spawn**. Geny는:
  - `session_store` seam ← Geny 세션 DB(영속·재시작) **주입만**.
  - `memory_provider_factory` ← 공유 vault 주입.
  - executor `subagent.*` 이벤트 구독 → 알람 표시 + 아바타/트리거 flavor + UI(SUB 배지, view-only 탭).
- **제거 대상(이식 완료 후):** `chat/inbox.py` 기반 위임, `send_direct_message_internal` 라이브 fire-and-forget, `[SUB_WORKER_RESULT]` 자체 알람, delegation.py 라이브 경로 → executor inbox/notification로 대체.
- **무회귀 보장:** flag 병행 + parity 테스트(다중턴·메모리공유·재시작·알람·트리거·아바타·UI) 통과 후 구경로 제거.

### 5-C. 작업 표면화 (GAP D)
- executor `subagent.*`(sub-worker·sub-agent 공통) 구독 → TaskRecord 생성/전이. sub-worker=단발 task, sub-agent=assign마다 task+완료 알람 동기화. 작업 탭(5-A 필터) 노출.

### 5-D. 도구 정책 (GAP C)
- worker/VTuber 매니페스트에 `Delegate`(sub-worker)/`SubAgent*` 노출 정책.

---

## 6. 단계별 PR

1. **PR-1 (Geny 배선, GAP A·B·E)** — executor 2.6.0로 가능. extras 주입 + orchestrator 설정 + 작업 세션 필터. → **sub-worker 즉시 동작, "동작 불가" 즉시 해소.** ★ 지금 착수.
2. **PR-2 (executor 2.7.0)** — §4: sub-agent 영속 + inbox + notification + persistence seam + 설정 고도화 + 이벤트. 일회성 회귀 무변경 테스트 + 영속/다중턴/inbox/알림 테스트. publish.
3. **PR-3 (Geny 완전 이식, 결정3)** — VTuber sub-agent를 executor로 대체, bespoke inbox/delegation 제거. flag+parity, 무회귀.
4. **PR-4 (작업 표면화, GAP D)** — 이벤트→TaskRecord + 완료 알람 동기화.
5. **PR-5 (마감)** — 작업/cron 영속 백엔드(file/postgres), 도구정책(GAP C), 네이밍/태그 정리(`[SUB_WORKER_RESULT]`→`[SUB_AGENT_RESULT]` 등 호환 별칭).

**순서:** PR-1(즉시) → PR-2(고도화) → PR-3(이식) → PR-4 → PR-5.

---

## 7. 리스크
- **PR-3 완전 이식:** inbox·메시징·알람·재시작·트리거·아바타·UI 깊은 결합 → flag+parity+점진. 무회귀 최우선.
- **메커니즘 이전(결정2):** inbox/알림을 executor로 옮기되, executor를 *얇은 포워더*가 아니라 *정확한 로직 제공자*로. 단, persona/아바타/트리거 등 VTuber flavor는 host(이벤트 구독). 경계 혼동 주의.
- **배선 회귀:** extras 주입을 생성/재바인딩/재시작 경로 전부 일관.
- **검증 원칙:** executor README outdated 가능 → 코드 1차. 능력은 executor 일반화로 흡수.

---

## 8. 지금 착수
**PR-1 (Geny 배선)** 부터 구현. executor 무변경, 무회귀, 즉시 sub-worker(일회성) 동작 + 작업 탭 세션 격리. 이어서 PR-2(executor 2.7.0 §4 — 사용자 API 검토 후) 진행.

---

## 진행 현황 (2026-06-18, 구현)

| PR | 내용 | 상태 |
|---|---|---|
| PR-1 (#961) | 작업/cron/sub-agent 런타임을 세션 extras에 배선 + 작업 탭 세션 격리 (GAP A·B·E) | ✅ 배포 |
| PR-2 (executor #229, **2.7.0** PyPI) | 영속 **sub-agent**(SubAgentManager: spawn/assign/list/stop, keep-alive, 다중턴, 재시작) + **inbox** + 완료 **알림** + 이벤트 v4 + descriptor 설정(system_prompt/tool_preset) + SubAgent* 툴. 일회성 **sub-worker**는 기존 `Agent`/`run_subagent`로 명확화. (3175 tests green) | ✅ 배포 |
| PR-3a/PR-4 (#962) | Geny가 executor SubAgentManager를 소비(부팅 생성+extras 주입), 위임 lifecycle → 작업(Task) 미러(작업 탭 노출, 세션 격리) | ✅ 배포 |
| 영속 state (#963) | sub-agent PipelineState를 FileSessionPersistence로 영속 → 재시작 생존 | ✅ 배포 |
| **PR-3b** | **VTuber bespoke Sub-Worker → executor sub-agent 완전 cutover** (flag + 라이브 parity). 기존 inbox.py/send_direct_message_internal/[SUB_WORKER_RESULT]/execute_command 알림을 executor 메커니즘으로 대체 후 제거. | ⏳ **남음 (검증 필요)** |

### 달성된 목표
- geny-executor가 **두 프리미티브를 모두 일급 제공**: sub-worker(일회성) + sub-agent(영속, 자율, 완료 알림). 알림/inbox/메시징 **메커니즘이 executor에 위치**. Geny는 소비자. ✅
- Geny에서 **상당히 고도화된 executor 기능** 사용 가능(SubAgent* 툴, 작업 탭 노출, 재시작 생존). ✅
- **무회귀**: 기존 Geny 기능 그대로(전부 additive). ✅

### PR-3b가 남은 이유 (정직한 평가)
VTuber Sub-Worker는 Geny에서 가장 깊게 결합된 서브시스템(inbox·execute_command 알림·chat room·아바타·트리거·재시작 cascade·UI). 이를 executor sub-agent로 **완전 교체**하는 것은 라이브 VTuber의 대화/메모리/재시작 parity를 **실환경에서 검증**해야 안전하다. 사용자 제약("모든 기능이 제대로 동작")상 **무검증 일괄 교체는 부적절** → flag(`GENY_VTUBER_SUBAGENT_MODE`, default=bespoke)로 신경로를 넣고 staging 검증 후 default 전환 + bespoke 제거하는 것이 정석. cutover에 필요한 executor 능력은 **이미 전부 구축/배포됨**.

### PR-3b 업데이트 (#964, 배포됨 — flag default OFF)
VTuber→executor sub-agent cutover의 **백엔드 경로**를 `GENY_VTUBER_SUBAGENT_MODE`(default `bespoke`)로 게이트하여 구현:
- executor 모드: VTuber 생성 시 executor 영속 sub-agent **소유**(spawn) + 위임은 `SubAgentAssign`(자율) + 완료 시 `[SUB_AGENT_RESULT]`로 VTuber 깨움(알람). bespoke 블록은 `elif`로 그대로 유지(무회귀, prod 검증: default=bespoke).
- **남은 것(완전 이식 마무리):** ① 비-세션 sub-agent의 **view-only UI**(결정4) ② executor 모드 **라이브 parity 검증**(대화/메모리/재시작/알람/트리거) ③ default 전환 + bespoke 제거.
