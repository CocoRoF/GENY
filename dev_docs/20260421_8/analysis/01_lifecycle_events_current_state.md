# Analysis 01 — 현재 세션 생명주기 전환 지점 전수조사

**작성일.** 2026-04-21
**목적.** `plan/01_bus_contract.md` 의 이벤트 enum 을 *현 코드 기준* 으로 확정하기 위한 audit.
**ref.** 본 사이클의 사전 청사진은 `dev_docs/20260421_6/plan/05_cycle_and_pr_breakdown.md §2.1` — "bus 는 7 이벤트" 로 기재되어 있음. 본 문서는 그 "7" 이 실제 코드의 어느 지점에 있는지 맵핑.

## 요약 결과

코드 전반을 확인한 결과, 현재 **8 개 지점** 에서 세션 생명주기성 상태 전환이 일어난다. 이 중 WS connect/disconnect 는 *transport-level only* 이므로 bus 이벤트로 승격할 대상은 WS 쪽에서 *추가* 되는 1 개 (`SESSION_ABANDONED`, PR-X2-6 에서 도입) 이다. 최종적으로 bus 는 다음 **7 이벤트** 로 확정한다:

| # | 이벤트 | 현재 위치 | 현재 상태 |
|---|---|---|---|
| 1 | `SESSION_CREATED` | `agent_session_manager.py:602` | `session_logger.log_session_event("created", ...)` inline |
| 2 | `SESSION_DELETED` | `agent_session_manager.py:862` | `session_logger.log_session_event("deleted", ...)` inline + persona reset + store soft-delete |
| 3 | `SESSION_RESTORED` | `controller/agent_controller.py:429` | HTTP endpoint logger only |
| 4 | `SESSION_PAIRED` | `agent_session_manager.py:635-680` | inline — vtuber 생성 시 worker 자동 생성 및 back-link |
| 5 | `SESSION_IDLE` | `agent_session.py:550-601` | `mark_idle()` 가 RUNNING→IDLE 전환 (VTuber 예외) |
| 6 | `SESSION_REVIVED` | `agent_session.py:603-645` | 실행 시 IDLE→RUNNING, pipeline 재빌드, memory reset |
| 7 | `SESSION_ABANDONED` | (신설) | PR-X2-6 에서 WS 장기 단절 기반 emit |

## 각 지점 세부

### 1. `SESSION_CREATED` — `agent_session_manager.py:602`

```python
# create_agent_session(...) 말미
self._session_logger.log_session_event(
    session_id, "created",
    {"model_profile": ..., "role": ..., "env_id": ..., "is_vtuber": ...},
)
```

- **트리거** — REST `/api/agent/sessions` POST (controller) 또는 VTuber paired 생성.
- **승격 방법** — bus.emit(SESSION_CREATED, session_id, meta=...). 기존 logger 호출은 유지 (로그는 로그대로).
- **주의** — VTuber 가 worker 를 자동 생성할 때 worker 쪽에서도 create 이벤트가 발생하므로, `meta={'paired_parent': vtuber_id}` 를 실어 구분 가능하게 한다.

### 2. `SESSION_DELETED` — `agent_session_manager.py:862`

```python
# delete_session(session_id, hard=False) 내부
self._persona_provider.reset(session_id)     # X1 에서 추가됨
self._session_logger.log_session_event(session_id, "deleted", {...})
```

- **soft-delete** 와 **hard-delete** 구분이 있다. bus 에는 `meta={'hard': bool}` 로 싣는다.
- **연쇄** — linked worker 가 있으면 연쇄 삭제. bus 이벤트 2 개 emit (부모 + 자식).

### 3. `SESSION_RESTORED` — `controller/agent_controller.py:429`

```python
# POST /api/agent/sessions/{sid}/restore
if linked_id:
    linked_agent_manager.restore_session(linked_id, ...)  # cascade
```

- **cascade** 는 2 이벤트 (main + linked) 를 emit. 순서: linked 먼저 → main 나중 (consumers 가 일관성 있게 "pair 가 복원되었다" 를 볼 수 있도록).

### 4. `SESSION_PAIRED` — `agent_session_manager.py:635-680`

```python
# VTuber 세션 생성 중 자동 worker 생성
worker_agent = AgentSession.create(...)
self._sub_worker_map[vtuber_id] = worker_id
self._persona_provider.append_context(vtuber_id, vtuber_ctx)  # X1
```

- `SESSION_PAIRED` 는 `SESSION_CREATED`(worker) 뒤에 추가로 emit. payload: `{'vtuber_id': ..., 'worker_id': ...}`.
- **재시작 시 restore** 에서도 pairing 이 복원되지만, 그때는 main/linked 각각의 `SESSION_RESTORED` 면 충분 — 중복 pair 이벤트는 발행하지 않음.

### 5. `SESSION_IDLE` — `agent_session.py:550-601`

- AgentSession 자체가 상태 머신을 들고 있음 (RUNNING/IDLE/DELETED). `mark_idle()` 은 매니저의 60s 스캔에서 호출.
- VTuber + linked worker 는 **always-on** 예외 (line 582). bus 이벤트도 마찬가지로 발행하지 않음.
- 승격 포인트 — `mark_idle` 성공 직후 `bus.emit(SESSION_IDLE, ...)`.

### 6. `SESSION_REVIVED` — `agent_session.py:603-645`

- IDLE → RUNNING 으로 돌아오면서 pipeline 재빌드 (`_build_pipeline` 재호출) + memory reset.
- 승격 포인트 — revive 완료 후 `bus.emit(SESSION_REVIVED, ...)`. `meta={'revive_count': ...}`.

### 7. `SESSION_ABANDONED` — (신설)

- **현재 상태** — WS connect/disconnect 는 ws handler 의 **로컬 스코프** 에만 존재 (`execute_stream.py:413` 등). 세션 단위로는 "언제부터 WS 없었는가" 를 아무도 모름.
- **PR-X2-6 도입** — WS 단절 후 일정 시간 경과 시 TickEngine spec `ws_abandoned_detector` 가 확인하여 `bus.emit(SESSION_ABANDONED, ...)`.
- idle 과의 차이 — idle 은 "에이전트가 일정 시간 응답 없음", abandoned 는 "사용자가 WS 를 끊고 안 돌아옴". 이 둘은 *독립* 이다.

## Findings

1. **기존 구현은 이벤트 감각이 아니다.** 각 지점마다 (로깅, store 업데이트, provider reset) 가 *inline* 으로 섞여 있다. bus 로 분리해도 기존 inline 부작용은 유지 — bus 는 *추가* 구독 경로일 뿐, **대체** 가 아니다.

2. **cascade 이벤트** — pair 복원/삭제는 2 이벤트를 emit 한다. consumer 는 session_id 로 구분 + `meta.paired_parent` 로 연결 관계 재구성 가능.

3. **VTuber 예외** — SESSION_IDLE 은 VTuber 에 발행되지 않음. plan/01 bus contract 의 "이벤트 발행 규약" 에 이 예외를 명문화.

4. **WS connect/disconnect 는 bus 에 올리지 않는다.** transport-level event 라 session 생명주기와 1:1 매칭이 아니다 (한 세션에 다중 WS 가 달릴 수 있음). 대신 `SESSION_ABANDONED` 만 bus 에 emit 하고, WS 계층은 자체 tracker (TickEngine spec) 로 판정.

## 영향 범위

- 코드 수정 대상: `agent_session_manager.py` (create/delete/pair/restore cascade), `agent_session.py` (idle/revive), `controller/agent_controller.py` (restore endpoint 로깅 유지), `ws/*_stream.py` (PR-X2-6 에서 abandoned detector 등록).
- 신규 파일: `backend/service/lifecycle/{events,bus}.py` (PR-X2-1).
