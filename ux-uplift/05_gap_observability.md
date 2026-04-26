# 05. Deep Dive #4 — Workspace / Events / Admin observability

본 chapter 는 cycle B+D 가 ship 한 *런타임 상태* 영역에서, 사용자가 "지금 무슨 일이 일어나는지" 볼 화면이 없는 갭을 다룬다.

---

## 1. Workspace state 가시화 (PR-D.4 / D.5.1 산출물)

### 1.1 현재 상태

| 자원 | 상태 |
|---|---|
| Workspace value object | ✅ executor 1.3.0 |
| WorkspaceStack | ✅ executor 1.3.0 |
| ToolContext.extras["workspace_stack"] | ✅ Geny PR-D.5.1 에서 시드 |
| EnterWorktreeTool / ExitWorktreeTool | ✅ workspace_stack 에 push/pop |
| LSPTool 의 workspace.cwd 라우팅 | ✅ |
| **사용자가 현재 workspace 보는 endpoint** | ❌ 없음 |
| **Frontend UI** | ❌ 없음 |

### 1.2 사용자가 못 보는 것

```
세션 5분 전: LLM 이 EnterWorktree("feature-x") 호출
        → ctx.extras["workspace_stack"] 에 push
        → ExecutionTimeline 에는 "EnterWorktree fired" 만 표시
        → 그 후 모든 tool 호출이 worktree 안에서 일어남

지금: 사용자가 session 의 cwd 가 어디인지 모름
      LLM 이 worktree 정리 안 했으면 .worktrees/ 가 누적됨을 모름
      LSP 이 어떤 workspace 에 묶였는지 모름
```

### 1.3 개선 설계

**Backend (신규):**

```python
# /api/agents/{sid}/workspace — GET
# 응답: 현재 workspace_stack snapshot

class WorkspaceSnapshot(BaseModel):
    depth: int
    current: Optional[WorkspaceState]
    stack: List[WorkspaceState]

class WorkspaceState(BaseModel):
    cwd: str
    git_branch: Optional[str]
    lsp_session_id: Optional[str]
    env_vars: Dict[str, str]
    metadata: Dict[str, Any]
```

이 endpoint 는 session 의 ToolContext 를 통해 stack 을 읽어옴 (agent_session_manager 에서 핸들 가져와서).

```python
# 추가: /api/agents/{sid}/worktrees — GET
# 활성 worktree 목록 (legacy worktree_stack dict 와 unified)
```

**Frontend:**

CommandTab 의 헤더 또는 Sidebar 에:
- "Workspace: feature-x @ /work/.worktrees/feature-x" badge
- 클릭 시 expand: stack 전체 (parent → current 의 chain)
- "Cleanup" 버튼 → 모든 worktree pop + remove

### 1.4 PR 분해

| PR | Scope |
|---|---|
| 1 | `/api/agents/{sid}/workspace` GET — snapshot endpoint |
| 2 | Frontend: CommandTab 헤더에 workspace badge + expand 모달 |
| 3 | Frontend: "Cleanup all worktrees" 버튼 + DELETE endpoint |

---

## 2. Recent tool events ring buffer (PR-B.1.3)

### 2.1 현재 상태

PR-B.1.3 가 in-process hook handler 3 개를 등록:
- `log_permission_denied` — log only, no UI
- `log_high_risk_tool_call` — log only, no UI
- `observe_post_tool_use` — **256 슬롯 ring buffer 에 기록**

ring buffer 의 데이터:
```python
{
  "ts": time.time(),
  "session_id": ...,
  "post_tool": "Bash",
  "details": {...},
}
```

`recent_tool_events(limit)` 함수 있음. 그러나 endpoint 도 UI 도 없음.

### 2.2 개선 설계

**Backend:**

```python
# /api/admin/recent-tool-events?limit=N — GET
# 응답: ring buffer 의 최근 N 개 (기본 50)
```

require_auth 보다 admin gate 권장 (operator 만).

**Frontend:**

- AdminPanel 에 "Recent Tool Activity" 패널
- 표 형태: ts / session / tool / details(json preview)
- Live update (SSE 또는 5s polling)

### 2.3 PR 분해

| PR | Scope |
|---|---|
| 1 | `/api/admin/recent-tool-events` endpoint |
| 2 | AdminPanel "Recent Tool Activity" 패널 |

---

## 3. Lifespan install status

### 3.1 현재 상태

`backend/main.py` lifespan 에서 install_* 마다 logger 에 ✅ / ⚠️ / ❌ 출력. 운영자는 docker logs 로만 확인.

### 3.2 개선 설계

**Backend:**

`app.state` 에 install 결과 dict 누적:

```python
app.state.lifespan_status = {
    "task_runtime": {"status": "ok", "backend": "postgres", "started_at": ...},
    "cron_runtime": {"status": "ok", "backend": "memory", ...},
    "slash_commands": {"status": "ok", "count": 14},
    "notifications": {"status": "warn", "reason": "..."},
    ...
}

# /api/admin/lifespan-status — GET
```

**Frontend:**

AdminPanel "System Status" 패널:
- 각 subsystem 의 ✅ / ⚠️ / ❌
- 오류 detail 클릭 시 expand

### 3.3 PR 분해

| PR | Scope |
|---|---|
| 1 | lifespan 에 status dict 누적 + /api/admin/lifespan-status endpoint |
| 2 | AdminPanel "System Status" 패널 |

---

## 4. Cron daemon 상태

### 4.1 현재 상태

CronRunner asyncio daemon 동작 중인지 외부에서 알 수 없음. cron job 이 fire 안 되면 daemon 죽었는지 / 잘못된 expr 인지 / store 비었는지 구분 안 됨.

### 4.2 개선 설계

**Backend:**

```python
# /api/cron/status — GET
# 응답:
{
  "daemon_alive": true,
  "cycle_seconds": 60,
  "last_tick_at": "2026-04-26T...",
  "next_tick_at": "2026-04-26T...",
  "jobs_active": 5,
  "jobs_disabled": 2,
}
```

CronRunner 가 last_tick_at 을 self 에 저장하고 expose.

**Frontend:**

CronTab 헤더에 "Daemon: alive (last tick 23s ago)" 같은 표시.

### 4.3 PR 분해

| PR | Scope |
|---|---|
| 1 | CronRunner.last_tick_at 저장 + `/api/cron/status` endpoint |
| 2 | CronTab 헤더 status badge |

---

## 5. Task runner queue depth

### 5.1 현재 상태

BackgroundTaskRunner 의 semaphore (max_concurrent=8) 로 동시성 제한. 사용자는 task 가 queue 에서 대기 중인지 / 실제로 실행 중인지 구분 못 함 (status="pending" 만).

### 5.2 개선 설계

**Backend:**

```python
# /api/agents/{sid}/tasks/runner-status — GET
{
  "max_concurrent": 8,
  "running": 5,
  "pending": 12,
  "queue_age_p99_ms": 4500,
}
```

또는 TasksTab list 응답에 status="pending" 외 "queued" / "running" 구분.

**Frontend:**

- TasksTab 헤더에 capacity meter (5/8 running, 12 queued)
- pending row 에 "queued for X" 표시

### 5.3 PR 분해

| PR | Scope |
|---|---|
| 1 | BackgroundTaskRunner 에 queue depth 통계 + endpoint |
| 2 | TasksTab capacity meter |

---

## 6. Hook fire history / latency

§3.1 의 ring buffer 와 부분 겹침. Hook 전용 ring buffer:

```python
# In HookRunner: 별도 ring buffer for fire events
{
  "ts": ...,
  "event": "PRE_TOOL_USE",
  "tool_name": "Bash",
  "in_process_handlers_fired": 2,
  "subprocess_handlers_fired": 0,
  "outcome": "passthrough" | "blocked",
  "latency_ms": 1.2,
}
```

Frontend: AdminPanel "Hook Activity" 패널 — Recent Tool Activity 와 같은 형식.

PR 추정: 2 (executor PR + Geny endpoint + UI = 3개 분리 가능).

---

## 7. Permission decision audit trail

### 7.1 현재 상태

`evaluate_permission` 의 결과 (allow / deny / ask + matched_rule + reason) 가 어디에도 노출 안 됨. ExecutionTimeline 에 tool 호출은 표시되지만 "왜 그 결정이 났는지" 추적 불가.

### 7.2 개선 설계

**Backend:**

- ExecutionTimeline 의 tool event 에 `permission_decision` field 추가
- 또는 별도 ring buffer `recent_permission_decisions`
- `/api/admin/recent-permissions?limit=N`

**Frontend:**

- ExecutionTimeline 의 tool 호출 row 클릭 → detail panel 에 "Permission: ALLOW (matched USER rule: Bash(git *))" 표시
- AdminPanel 에 "Permission Activity" 별도 패널

### 7.3 PR 분해

| PR | Scope |
|---|---|
| 1 | EventBus 에 permission decision event 추가 |
| 2 | ExecutionTimeline detail panel 에 표시 |
| 3 | `/api/admin/recent-permissions` + AdminPanel 패널 |

---

## 8. 종합 PR 추정

| 갭 | PR 수 | 우선순위 |
|---|---|---|
| §1 Workspace state viewer | 3 | MED |
| §2 Recent tool events ring buffer | 2 | MED |
| §3 Lifespan install status | 2 | LOW |
| §4 Cron daemon status | 2 | LOW |
| §5 Task runner queue depth | 2 | LOW |
| §6 Hook fire history | 3 | LOW |
| §7 Permission decision audit | 3 | MED |

**총 ~17 PR.** §1 + §2 + §7 (가장 자주 의문 발생하는 영역) 만 한 cycle 에 처리해도 큰 향상.

---

## 다음 chapter

- [`06_priority_buckets.md`](06_priority_buckets.md) — 모든 갭의 우선순위 통합
