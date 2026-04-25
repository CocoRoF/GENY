# Cycle A · 묶음 1 — Task lifecycle (10 PR)

**묶음 ID:** A.1 (executor 5) + A.5 (Geny 5)
**Layer:** EXEC-CORE (tools / runner) + EXEC-INTERFACE (store ABC) + SERVICE (REST + UI + Postgres backend)
**격차:** A.5 / H.29 / H.30 / H.31 — claude-code 의 7 task type (local_bash / local_agent / remote_agent / in_process_teammate / local_workflow / monitor_mcp / dream) 중 본 cycle 에서 `local_bash` + `local_agent` 만 ship.
**의존성:** Stage 12 (`s12_agent.SubagentTypeOrchestrator`) + Stage 13 (`s13_task_registry.TaskRegistry`) — 모두 1.0.0 에 이미 ship.

---

# Part A — geny-executor (5 PR, release 1.1.0 의 일부)

## PR-A.1.1 — feat(stages): TaskRegistryStore ABC + InMemoryTaskRegistryStore

### Metadata
- **Branch:** `feat/task-registry-store-abc`
- **Repo:** geny-executor
- **Layer:** EXEC-INTERFACE (ABC) + EXEC-CORE (in-memory reference impl)
- **Depends on:** none
- **Consumed by:** PR-A.1.2 / A.1.3 / A.1.5 / Geny PR-A.5.2

### Files added

#### `geny_executor/stages/s13_task_registry/store_abc.py` (~60 lines)

```python
from __future__ import annotations
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any, AsyncIterator, Dict, List, Optional


class TaskStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    STOPPED = "stopped"


@dataclass
class TaskRecord:
    id: str
    type: str                         # "local_bash" | "local_agent" | etc.
    subagent_type: Optional[str]      # local_agent / in_process_teammate 일 때
    prompt: Optional[str]
    payload: Dict[str, Any] = field(default_factory=dict)
    status: TaskStatus = TaskStatus.PENDING
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    error: Optional[str] = None
    output_path: Optional[str] = None  # 외부 파일 위치 (file backend / S3)


@dataclass
class TaskFilter:
    status: Optional[TaskStatus] = None
    type: Optional[str] = None
    created_after: Optional[datetime] = None
    limit: int = 100


class TaskRegistryStore(ABC):
    """Persistence backend for TaskRegistry. Reference: in_memory.py / file_persister.py.
    
    서비스가 별도 backend (Postgres / Redis / DynamoDB) 를 구현해서
    register_task_store() 로 swap.
    """

    @abstractmethod
    async def put(self, record: TaskRecord) -> None: ...
    
    @abstractmethod
    async def get(self, task_id: str) -> Optional[TaskRecord]: ...
    
    @abstractmethod
    async def list(self, filter: TaskFilter) -> List[TaskRecord]: ...
    
    @abstractmethod
    async def update(self, task_id: str, **fields: Any) -> Optional[TaskRecord]: ...
    
    @abstractmethod
    async def delete(self, task_id: str) -> bool: ...
    
    @abstractmethod
    async def append_output(self, task_id: str, chunk: bytes) -> None: ...
    
    @abstractmethod
    async def read_output(
        self, task_id: str, offset: int = 0, limit: Optional[int] = None
    ) -> bytes: ...
    
    @abstractmethod
    async def stream_output(self, task_id: str) -> AsyncIterator[bytes]: ...
```

#### `geny_executor/stages/s13_task_registry/store_impl/in_memory.py` (~100 lines)

```python
from __future__ import annotations
import asyncio
from copy import deepcopy
from typing import Any, AsyncIterator, Dict, List, Optional

from ..store_abc import TaskFilter, TaskRecord, TaskRegistryStore, TaskStatus


class InMemoryTaskRegistryStore(TaskRegistryStore):
    """Reference impl. Process-local, lost on restart.
    Suitable for dev / single-tenant test. Production should swap.
    """

    def __init__(self) -> None:
        self._records: Dict[str, TaskRecord] = {}
        self._outputs: Dict[str, bytearray] = {}
        self._lock = asyncio.Lock()
        self._output_events: Dict[str, asyncio.Event] = {}

    async def put(self, record: TaskRecord) -> None:
        async with self._lock:
            self._records[record.id] = deepcopy(record)
            self._outputs.setdefault(record.id, bytearray())
            self._output_events.setdefault(record.id, asyncio.Event())

    async def get(self, task_id: str) -> Optional[TaskRecord]:
        async with self._lock:
            rec = self._records.get(task_id)
            return deepcopy(rec) if rec else None

    async def list(self, filter: TaskFilter) -> List[TaskRecord]:
        async with self._lock:
            rows = list(self._records.values())
        if filter.status:
            rows = [r for r in rows if r.status == filter.status]
        if filter.type:
            rows = [r for r in rows if r.type == filter.type]
        if filter.created_after:
            rows = [r for r in rows if r.created_at >= filter.created_after]
        rows.sort(key=lambda r: r.created_at, reverse=True)
        return [deepcopy(r) for r in rows[: filter.limit]]

    async def update(self, task_id: str, **fields: Any) -> Optional[TaskRecord]:
        async with self._lock:
            rec = self._records.get(task_id)
            if not rec:
                return None
            for k, v in fields.items():
                setattr(rec, k, v)
            return deepcopy(rec)

    async def delete(self, task_id: str) -> bool:
        async with self._lock:
            if task_id not in self._records:
                return False
            del self._records[task_id]
            self._outputs.pop(task_id, None)
            ev = self._output_events.pop(task_id, None)
            if ev:
                ev.set()
            return True

    async def append_output(self, task_id: str, chunk: bytes) -> None:
        async with self._lock:
            buf = self._outputs.setdefault(task_id, bytearray())
            buf.extend(chunk)
            ev = self._output_events.setdefault(task_id, asyncio.Event())
            ev.set()
            ev.clear()

    async def read_output(self, task_id, offset=0, limit=None) -> bytes:
        async with self._lock:
            buf = self._outputs.get(task_id, bytearray())
            end = len(buf) if limit is None else min(offset + limit, len(buf))
            return bytes(buf[offset:end])

    async def stream_output(self, task_id: str) -> AsyncIterator[bytes]:
        offset = 0
        while True:
            chunk = await self.read_output(task_id, offset)
            if chunk:
                yield chunk
                offset += len(chunk)
            rec = await self.get(task_id)
            if rec and rec.status in (TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.STOPPED):
                # drain any final bytes
                final = await self.read_output(task_id, offset)
                if final:
                    yield final
                return
            ev = self._output_events.get(task_id)
            if ev:
                try:
                    await asyncio.wait_for(ev.wait(), timeout=1.0)
                except asyncio.TimeoutError:
                    pass
```

### Files modified

- `geny_executor/stages/s13_task_registry/__init__.py` — re-export `TaskRegistryStore`, `TaskRecord`, `TaskFilter`, `TaskStatus`, `InMemoryTaskRegistryStore`.

### Tests added

`tests/stages/s13_task_registry/test_in_memory_store.py`

- `test_put_get_round_trip`
- `test_list_filters_by_status`
- `test_list_filters_by_type`
- `test_list_orders_by_created_at_desc`
- `test_list_respects_limit`
- `test_update_modifies_existing_record`
- `test_update_returns_none_for_missing`
- `test_delete_removes_record_and_output`
- `test_append_then_read_output`
- `test_read_output_with_offset_and_limit`
- `test_stream_output_yields_until_completed`
- `test_concurrent_appends_do_not_lose_bytes` (asyncio.gather)

### Acceptance criteria
- [ ] ABC import 가능: `from geny_executor.stages.s13_task_registry import TaskRegistryStore`
- [ ] InMemory impl coverage ≥ 95%
- [ ] mypy strict pass
- [ ] CHANGELOG.md 1.1.0 unreleased: "Add TaskRegistryStore ABC + InMemoryTaskRegistryStore"

### Risk / mitigation
| Risk | Mitigation |
|---|---|
| append_output 의 race | asyncio.Lock 으로 직렬화, 단일 process 가정 |
| stream_output 가 영원히 hang | task 완료 시 status check 로 종료 보장 |

---

## PR-A.1.2 — feat(stages): FileBackedTaskRegistryStore (reference prod-grade)

### Metadata
- **Branch:** `feat/task-registry-file-backed`
- **Repo:** geny-executor
- **Layer:** EXEC-CORE
- **Depends on:** PR-A.1.1
- **Consumed by:** PR-A.1.5 (default backend) / Geny PR-A.5.3 (lifespan)

### Files added

#### `geny_executor/stages/s13_task_registry/store_impl/file_persister.py` (~180 lines)

핵심 구조:

```python
class FileBackedTaskRegistryStore(TaskRegistryStore):
    """Single-process file backend. Suitable for self-hosted deploys.
    
    Layout:
      <root>/
        registry.jsonl       # TaskRecord (1 line per task, latest version 마지막)
        outputs/
          <task_id>.bin      # raw output bytes
    """

    def __init__(self, root: Path) -> None:
        self._root = root
        self._registry_path = root / "registry.jsonl"
        self._outputs_dir = root / "outputs"
        self._lock = asyncio.Lock()
        self._cache: Dict[str, TaskRecord] = {}
        self._loaded = False

    async def _ensure_loaded(self):
        if self._loaded: return
        async with self._lock:
            if self._loaded: return
            self._root.mkdir(parents=True, exist_ok=True)
            self._outputs_dir.mkdir(parents=True, exist_ok=True)
            if self._registry_path.exists():
                # last-write-wins: 같은 id 의 마지막 줄이 final
                for line in self._registry_path.read_text().splitlines():
                    if not line.strip(): continue
                    rec = _decode(line)
                    self._cache[rec.id] = rec
            self._loaded = True
    
    # put / get / list / update / delete / append_output / read_output / stream_output
    # 모두 InMemory 와 동일 인터페이스, 내부에서 _ensure_loaded + jsonl append.
```

직렬화 helpers `_encode(rec) -> str` / `_decode(line) -> TaskRecord` 포함.

### Tests added

`tests/stages/s13_task_registry/test_file_backed_store.py`

- `test_round_trip_survives_restart` (tmp_path → store close → 새 instance → 데이터 보존)
- `test_corrupt_jsonl_line_skipped_with_warning`
- `test_concurrent_writes_serialised`
- `test_outputs_dir_isolated_per_task`
- `test_delete_removes_output_file`
- `test_load_idempotent` (_ensure_loaded 두 번 호출 안전)

### Acceptance criteria
- [ ] FileBackedTaskRegistryStore impl + 6 test pass
- [ ] InMemory 와 동일 ABC 시그니처 (호환)
- [ ] line coverage ≥ 90%
- [ ] CHANGELOG.md 1.1.0: "Add FileBackedTaskRegistryStore"

### Risk / mitigation
| Risk | Mitigation |
|---|---|
| jsonl 누적 → 무한 grow | 첫 cycle 은 무시, P2 에서 compaction 도입 |
| 파일 corruption | line 단위 try/except + warning log + skip |

---

## PR-A.1.3 — feat(runtime): TaskRunner (asyncio background) + lifecycle

### Metadata
- **Branch:** `feat/task-runner`
- **Repo:** geny-executor
- **Layer:** EXEC-CORE
- **Depends on:** PR-A.1.1
- **Consumed by:** PR-A.1.5 / PR-A.4.3 / Geny PR-A.5.3

### Files added

#### `geny_executor/runtime/task_runner.py` (~200 lines)

```python
class TaskRunner:
    """Background task runner using asyncio.Task.
    
    Lifecycle:
      runner = TaskRunner(store=...)
      await runner.start()
      task_id = await runner.submit(record)
      ...
      await runner.shutdown(timeout=30)
    """

    def __init__(
        self,
        store: TaskRegistryStore,
        executors: Dict[str, TaskExecutor],
        max_concurrent: int = 16,
    ) -> None:
        self._store = store
        self._executors = executors  # { "local_bash": BashExecutor(), "local_agent": AgentExecutor() }
        self._sem = asyncio.Semaphore(max_concurrent)
        self._futures: Dict[str, asyncio.Task] = {}
        self._started = False
        self._stop_event = asyncio.Event()

    async def start(self) -> None:
        """Optional warm-up. Re-attaches in-progress tasks if backend supports."""
        if self._started: return
        # backend 재시작 시 RUNNING 상태인 task 들 → FAILED (graceful, 추후 재실행)
        running = await self._store.list(TaskFilter(status=TaskStatus.RUNNING, limit=1000))
        for r in running:
            await self._store.update(r.id, status=TaskStatus.FAILED, error="restarted_during_run")
        self._started = True

    async def submit(self, record: TaskRecord) -> str:
        await self._store.put(record)
        executor = self._executors.get(record.type)
        if not executor:
            await self._store.update(record.id, status=TaskStatus.FAILED, error=f"no_executor_for_type:{record.type}")
            return record.id
        task = asyncio.create_task(self._run(record, executor), name=f"task-{record.id}")
        self._futures[record.id] = task
        task.add_done_callback(lambda t: self._futures.pop(record.id, None))
        return record.id

    async def _run(self, record: TaskRecord, executor: "TaskExecutor") -> None:
        async with self._sem:
            await self._store.update(record.id, status=TaskStatus.RUNNING, started_at=datetime.now(timezone.utc))
            try:
                async for chunk in executor.execute(record):
                    await self._store.append_output(record.id, chunk)
                await self._store.update(record.id, status=TaskStatus.COMPLETED, completed_at=datetime.now(timezone.utc))
            except asyncio.CancelledError:
                await self._store.update(record.id, status=TaskStatus.STOPPED, completed_at=datetime.now(timezone.utc))
                raise
            except Exception as e:
                await self._store.update(record.id, status=TaskStatus.FAILED, error=str(e), completed_at=datetime.now(timezone.utc))

    async def stop(self, task_id: str) -> bool:
        task = self._futures.get(task_id)
        if not task: return False
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):
            pass
        return True

    async def shutdown(self, timeout: float = 30.0) -> None:
        if not self._futures: return
        for t in self._futures.values():
            t.cancel()
        await asyncio.wait(self._futures.values(), timeout=timeout)
```

#### `geny_executor/runtime/task_executors.py` (~120 lines)

```python
class TaskExecutor(ABC):
    @abstractmethod
    async def execute(self, record: TaskRecord) -> AsyncIterator[bytes]:
        """Yield output chunks. Final chunk = empty bytes optional."""

class LocalBashExecutor(TaskExecutor):
    async def execute(self, record):
        cmd = record.payload.get("command")
        if not cmd:
            raise ValueError("local_bash requires payload.command")
        proc = await asyncio.create_subprocess_shell(
            cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT
        )
        assert proc.stdout
        while True:
            chunk = await proc.stdout.read(4096)
            if not chunk: break
            yield chunk
        rc = await proc.wait()
        if rc != 0:
            raise RuntimeError(f"bash exited rc={rc}")

class LocalAgentExecutor(TaskExecutor):
    """sub-pipeline 실행. SubagentTypeOrchestrator 활용."""
    
    def __init__(self, orchestrator_factory: Callable[[], SubagentTypeOrchestrator]):
        self._factory = orchestrator_factory
    
    async def execute(self, record):
        orch = self._factory()
        descriptor = orch.get_descriptor(record.subagent_type)
        if not descriptor:
            raise ValueError(f"unknown subagent_type:{record.subagent_type}")
        async for evt in orch.spawn(descriptor, record.prompt or ""):
            yield evt.encode()
```

### Files modified

- `geny_executor/runtime/__init__.py` — re-export `TaskRunner`, `TaskExecutor`, `LocalBashExecutor`, `LocalAgentExecutor`.

### Tests added

`tests/runtime/test_task_runner.py`

- `test_submit_runs_task_to_completion`
- `test_submit_unknown_type_marks_failed`
- `test_stop_cancels_in_flight_task`
- `test_concurrent_submits_respect_semaphore` (max_concurrent=2)
- `test_shutdown_cancels_all_futures`
- `test_restart_marks_running_as_failed` (재시작 시뮬레이션)
- `test_local_bash_streams_output`
- `test_local_bash_nonzero_exit_marks_failed`
- `test_local_agent_uses_orchestrator`

### Acceptance criteria
- [ ] TaskRunner.start/submit/stop/shutdown 4 method 동작
- [ ] LocalBashExecutor + LocalAgentExecutor 2 ship
- [ ] 9 test pass
- [ ] line coverage ≥ 90%
- [ ] CHANGELOG.md 1.1.0: "Add TaskRunner with local_bash + local_agent executors"

### Risk / mitigation
| Risk | Mitigation |
|---|---|
| executor.execute 가 generator 가 아님 | typing.AsyncIterator 강제 + runtime check |
| shutdown 시 task hang | timeout 후 강제 cancel |
| in_process_teammate 미지원 → 실수로 등록 | first cycle 은 type whitelist (`local_bash`, `local_agent`) |

---

## PR-A.1.4 — feat(tools): AgentTool built-in

### Metadata
- **Branch:** `feat/agent-tool`
- **Repo:** geny-executor
- **Layer:** EXEC-CORE
- **Depends on:** none (Stage 12 already shipped — only need tool wrapper)
- **Consumed by:** Geny PR-A.5.1 (uses via SubagentTypeRegistry seed)

### Files added

#### `geny_executor/tools/built_in/agent_tool.py` (~140 lines)

```python
from typing import Any, Dict
from geny_executor.tools.base import Tool, ToolCapabilities, ToolResult, ToolContext
from geny_executor.stages.s12_agent.orchestrator import SubagentTypeOrchestrator


class AgentTool(Tool):
    name = "Agent"
    description = (
        "Spawn a sub-agent of the specified type with a prompt. "
        "Returns the sub-agent's final assistant message."
    )

    capabilities = ToolCapabilities(
        concurrency_safe=True,
        destructive=False,
        requires_network=True,
        max_recursion_depth=3,
    )

    input_schema = {
        "type": "object",
        "required": ["subagent_type", "prompt"],
        "properties": {
            "subagent_type": {"type": "string", "description": "Registered subagent type id"},
            "prompt": {"type": "string", "description": "Initial user prompt"},
            "model": {"type": "string", "description": "Optional model override"},
        },
    }

    async def execute(self, input_data: Dict[str, Any], ctx: ToolContext) -> ToolResult:
        if ctx.depth >= self.capabilities.max_recursion_depth:
            return ToolResult.error(
                f"max recursion depth {self.capabilities.max_recursion_depth} exceeded"
            )
        orch = ctx.get_strategy("agent_orchestrator")
        if not isinstance(orch, SubagentTypeOrchestrator):
            return ToolResult.error("agent_orchestrator strategy not active in pipeline")
        st = input_data["subagent_type"]
        descriptor = orch.get_descriptor(st)
        if descriptor is None:
            return ToolResult.error(f"unknown subagent_type: {st}")
        try:
            result = await orch.spawn_collect(
                descriptor=descriptor,
                prompt=input_data["prompt"],
                model_override=input_data.get("model"),
                parent_ctx=ctx,
            )
        except Exception as e:
            return ToolResult.error(f"subagent failed: {e}")
        return ToolResult.ok(result.final_assistant_message)
```

### Files modified

- `geny_executor/tools/built_in/__init__.py` — `BUILT_IN_TOOL_CLASSES` 에 `AgentTool` 추가.
- `geny_executor/stages/s12_agent/orchestrator.py` — `spawn_collect` 메소드 추가 (없는 경우). spawn 의 sync convenience wrapper.

### Tests added

`tests/tools/built_in/test_agent_tool.py`

- `test_spawns_subagent_with_descriptor` (mock orchestrator)
- `test_returns_error_when_orchestrator_inactive`
- `test_returns_error_for_unknown_subagent_type`
- `test_propagates_subagent_failure`
- `test_max_recursion_depth_enforced` (ctx.depth=3 → error)
- `test_model_override_passed_through`

### Acceptance criteria
- [ ] AgentTool 등록 + import 가능
- [ ] 6 test pass
- [ ] depth limit (3) 강제
- [ ] CHANGELOG.md 1.1.0: "Add AgentTool built-in"

### Risk / mitigation
| Risk | Mitigation |
|---|---|
| nested AgentTool 호출 폭주 | max_recursion_depth=3 |
| subagent 가 cost 폭주 | 부모 session 의 CostBudgetGuard 가 sub-pipeline 에도 전파 (Stage 04) |

---

## PR-A.1.5 — feat(tools): 6 task tools (Create / Get / List / Update / Output / Stop)

### Metadata
- **Branch:** `feat/task-lifecycle-tools`
- **Repo:** geny-executor
- **Layer:** EXEC-CORE
- **Depends on:** PR-A.1.1, PR-A.1.3 (TaskRunner 활용)
- **Consumed by:** Geny PR-A.5.4 (REST endpoint wraps these)

### Files added

#### `geny_executor/tools/built_in/task_create_tool.py` (~80 lines)

```python
class TaskCreateTool(Tool):
    name = "TaskCreate"
    description = (
        "Create and submit a background task. Returns task_id. "
        "Supports 'local_bash' (run shell command) and 'local_agent' (spawn subagent)."
    )
    capabilities = ToolCapabilities(concurrency_safe=True, destructive=True)
    input_schema = {
        "type": "object",
        "required": ["type"],
        "properties": {
            "type": {"enum": ["local_bash", "local_agent"]},
            "command": {"type": "string"},          # local_bash 전용
            "subagent_type": {"type": "string"},    # local_agent 전용
            "prompt": {"type": "string"},           # local_agent 전용
            "payload": {"type": "object"},          # 임의 metadata
        },
    }

    async def execute(self, input_data, ctx):
        runner: TaskRunner = ctx.get_strategy("task_runner")
        if not runner:
            return ToolResult.error("task_runner not configured")
        record = TaskRecord(
            id=str(uuid.uuid4()),
            type=input_data["type"],
            subagent_type=input_data.get("subagent_type"),
            prompt=input_data.get("prompt"),
            payload={**input_data.get("payload", {}),
                     "command": input_data.get("command")},
        )
        task_id = await runner.submit(record)
        return ToolResult.ok({"task_id": task_id, "status": "pending"})
```

#### `geny_executor/tools/built_in/task_get_tool.py` (~50 lines)

```python
class TaskGetTool(Tool):
    name = "TaskGet"
    description = "Get task record by id."
    capabilities = ToolCapabilities(concurrency_safe=True)
    input_schema = {"type": "object", "required": ["task_id"], "properties": {"task_id": {"type": "string"}}}

    async def execute(self, input_data, ctx):
        store = ctx.get_strategy("task_store")
        rec = await store.get(input_data["task_id"])
        if not rec:
            return ToolResult.error("not_found")
        return ToolResult.ok(_serialize(rec))
```

#### `geny_executor/tools/built_in/task_list_tool.py` (~60 lines)

```python
class TaskListTool(Tool):
    name = "TaskList"
    description = "List tasks with optional filter."
    capabilities = ToolCapabilities(concurrency_safe=True)
    input_schema = {
        "type": "object",
        "properties": {
            "status": {"enum": ["pending", "running", "completed", "failed", "stopped"]},
            "type": {"type": "string"},
            "limit": {"type": "integer", "default": 20},
        },
    }

    async def execute(self, input_data, ctx):
        store = ctx.get_strategy("task_store")
        rows = await store.list(TaskFilter(
            status=TaskStatus(input_data["status"]) if input_data.get("status") else None,
            type=input_data.get("type"),
            limit=input_data.get("limit", 20),
        ))
        return ToolResult.ok([_serialize(r) for r in rows])
```

#### `geny_executor/tools/built_in/task_update_tool.py`, `task_output_tool.py`, `task_stop_tool.py`

(유사 구조; 각 ~50-70 lines)

- `TaskUpdateTool`: store.update 호출. 단 status 직접 변경 금지 (RUNNING ↔ COMPLETED 등) — payload / prompt 같은 user-mutable 필드만 화이트리스트.
- `TaskOutputTool`: store.read_output(offset, limit). offset / limit input. streaming 은 endpoint 에서.
- `TaskStopTool`: runner.stop(task_id). 결과 status STOPPED.

### Files modified

- `geny_executor/tools/built_in/__init__.py` — 6 추가.
- `geny_executor/manifest/default.py` — Stage 13 의 `task_store` slot default 를 `InMemoryTaskRegistryStore`, `task_runner` slot 추가.

### Tests added

`tests/tools/built_in/test_task_create_tool.py`, `test_task_get_tool.py`, ... (6 파일)

각 파일에 4-6 test:
- happy path
- not_found
- invalid input
- runner not configured

총 ~30 test.

### Acceptance criteria
- [ ] 6 tool 모두 등록 + import 가능
- [ ] 30 test pass
- [ ] line coverage ≥ 90% (각 파일)
- [ ] CHANGELOG.md 1.1.0: "Add 6 task lifecycle tools (Create/Get/List/Update/Output/Stop)"

### Risk / mitigation
| Risk | Mitigation |
|---|---|
| TaskUpdateTool 로 status 임의 변경 → 데이터 corruption | status 화이트리스트 X (mutable 필드만) |
| TaskOutputTool 의 큰 limit → memory 폭주 | max limit = 1MB |

---

# Part B — Geny (5 PR, executor 1.1.0 채택 후)

## PR-A.5.0 — chore(deps): bump geny-executor 1.0.x → 1.1.0

### Metadata
- **Branch:** `chore/bump-executor-1.1.0`
- **Repo:** Geny
- **Depends on:** Executor 1.1.0 release (모든 A.1.* / A.2.* / A.3.* / A.4.* 머지 후)

### Files modified

- `backend/pyproject.toml`:
  ```diff
  - geny-executor = "1.0.0"
  + geny-executor = ">=1.1.0,<1.2.0"
  ```
- `backend/poetry.lock` — `poetry lock` 실행 결과
- `docker/Dockerfile.backend` — 캐시 무효화를 위한 build arg bump (선택)

### Tests
- 기존 test suite 재실행 (회귀 0 확인)

### Acceptance criteria
- [ ] poetry install 성공
- [ ] 기존 worker_adaptive / vtuber preset smoke test pass
- [ ] CI green

---

## PR-A.5.1 — feat(service): SubagentTypeRegistry seed (worker / researcher / vtuber-narrator)

### Metadata
- **Branch:** `feat/subagent-type-seed`
- **Repo:** Geny
- **Layer:** SERVICE
- **Depends on:** PR-A.5.0
- **Consumed by:** PR-A.5.5 (TasksTab 의 type 선택 dropdown)

### Files added

#### `backend/service/agent_types/__init__.py`
#### `backend/service/agent_types/registry.py` (~80 lines)

```python
from geny_executor.stages.s12_agent import (
    SubagentTypeRegistry, SubagentTypeDescriptor,
)

DESCRIPTORS = [
    SubagentTypeDescriptor(
        id="worker",
        name="General-purpose worker",
        description="Default coding / research worker. Uses worker_adaptive preset.",
        default_model="claude-haiku-4-5-20251001",
        default_tools=["bash", "read", "write", "edit", "grep", "glob"],
    ),
    SubagentTypeDescriptor(
        id="researcher",
        name="Research-only worker",
        description="Read-only investigation. No file mutation tools.",
        default_model="claude-haiku-4-5-20251001",
        default_tools=["read", "grep", "glob", "web_fetch", "web_search"],
    ),
    SubagentTypeDescriptor(
        id="vtuber-narrator",
        name="VTuber narration sub-agent",
        description="Generates short narrations in VTuber persona.",
        default_model="claude-haiku-4-5-20251001",
        default_tools=["memory_search", "knowledge_search"],
    ),
]


def install_subagent_types(registry: SubagentTypeRegistry) -> None:
    for d in DESCRIPTORS:
        registry.register(d)
```

#### `backend/service/agent_types/descriptors.py`

(`DESCRIPTORS` 분리하고 싶을 때. 본 plan 에서는 registry.py 에 통합.)

### Files modified

- `backend/service/executor/default_manifest.py` — pipeline build 후 `install_subagent_types(pipeline.get_strategy("subagent_registry"))` 호출.

### Tests added

`backend/tests/service/agent_types/test_registry.py`

- `test_install_registers_three_descriptors`
- `test_worker_descriptor_has_correct_default_tools`
- `test_idempotent` (두 번 호출해도 중복 없음)

### Acceptance criteria
- [ ] 3 descriptor 등록
- [ ] 3 test pass
- [ ] worker_adaptive 의 default_manifest 가 등록 호출

---

## PR-A.5.2 — feat(service): PostgresTaskRegistryStore (운영 backend)

### Metadata
- **Branch:** `feat/postgres-task-store`
- **Repo:** Geny
- **Layer:** SERVICE (EXEC-INTERFACE 의 impl)
- **Depends on:** PR-A.5.0
- **Consumed by:** PR-A.5.3

### Files added

#### `backend/service/tasks/__init__.py`
#### `backend/service/tasks/store_postgres.py` (~200 lines)

```python
from sqlalchemy import Column, String, Text, DateTime, JSON
from sqlalchemy.orm import declarative_base
from geny_executor.stages.s13_task_registry import (
    TaskRegistryStore, TaskRecord, TaskFilter, TaskStatus,
)

Base = declarative_base()

class TaskRow(Base):
    __tablename__ = "tasks"
    id = Column(String(64), primary_key=True)
    type = Column(String(32), nullable=False)
    subagent_type = Column(String(64))
    prompt = Column(Text)
    payload = Column(JSON, default={})
    status = Column(String(16), nullable=False, index=True)
    created_at = Column(DateTime(timezone=True), nullable=False)
    started_at = Column(DateTime(timezone=True))
    completed_at = Column(DateTime(timezone=True))
    error = Column(Text)
    output_path = Column(String(256))


class TaskOutputRow(Base):
    __tablename__ = "task_outputs"
    id = Column(String(64), primary_key=True)  # task_id + offset
    task_id = Column(String(64), ForeignKey("tasks.id", ondelete="CASCADE"), nullable=False, index=True)
    offset = Column(Integer, nullable=False)
    chunk = Column(LargeBinary, nullable=False)
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)


class PostgresTaskRegistryStore(TaskRegistryStore):
    def __init__(self, session_factory):
        self._session_factory = session_factory  # async_sessionmaker
    # 모든 method 를 SQLAlchemy async session 으로 구현
    # 단, stream_output 은 polling-based (output_rows 의 offset > last_offset)
    ...
```

#### `backend/migrations/versions/<rev>_add_tasks_tables.py` (Alembic)

### Tests added

`backend/tests/service/tasks/test_postgres_store.py`

- 기존 conftest 의 postgres fixture 사용
- `test_round_trip_via_postgres`
- `test_concurrent_appends_serialised`
- `test_stream_output_polling_mode`
- `test_filter_by_status_indexed`
- `test_cascade_delete_outputs`

### Acceptance criteria
- [ ] alembic upgrade head 성공
- [ ] 5 test pass
- [ ] PostgresTaskRegistryStore 가 ABC 시그니처 통과 (mypy)
- [ ] 기존 InMemoryTaskRegistryStore 와 동일 행동 (test_in_memory_store.py 의 모든 test 가 Postgres 로도 통과)

### Risk / mitigation
| Risk | Mitigation |
|---|---|
| stream_output 의 polling latency | 첫 cycle 은 1s polling, P2 에서 LISTEN/NOTIFY |
| 큰 output 의 row 수 폭주 | 4KB chunk, 1년 후 archival 정책은 별도 cycle |

---

## PR-A.5.3 — feat(infra): FastAPI lifespan — TaskRunner + register_task_store

### Metadata
- **Branch:** `feat/task-runner-lifespan`
- **Repo:** Geny
- **Layer:** SERVICE
- **Depends on:** PR-A.5.2

### Files modified

#### `backend/main.py` (lifespan 부분)

```python
from contextlib import asynccontextmanager
from geny_executor.runtime import TaskRunner, LocalBashExecutor, LocalAgentExecutor
from service.tasks.store_postgres import PostgresTaskRegistryStore

@asynccontextmanager
async def lifespan(app: FastAPI):
    # ... 기존 lifespan
    
    store = PostgresTaskRegistryStore(session_factory=async_session_factory)
    executors = {
        "local_bash": LocalBashExecutor(),
        "local_agent": LocalAgentExecutor(orchestrator_factory=lambda: app.state.subagent_orchestrator),
    }
    runner = TaskRunner(store=store, executors=executors, max_concurrent=16)
    await runner.start()
    app.state.task_runner = runner
    app.state.task_store = store
    
    try:
        yield
    finally:
        await runner.shutdown(timeout=30)
        # ... 기존 cleanup
```

### Files added

`backend/service/tasks/install.py`

```python
def install_task_runtime(pipeline, runner, store):
    """Pipeline 의 Stage 13 slot 에 task_runner / task_store 주입."""
    s13 = pipeline.get_stage(13)
    s13.set_strategy("task_store", store)
    s13.set_strategy("task_runner", runner)
```

### Tests added

`backend/tests/main/test_lifespan_task_runner.py`

- `test_runner_started_in_lifespan` (TestClient 컨텍스트)
- `test_runner_shutdown_on_app_close`
- `test_pipeline_stage_13_has_runner_after_lifespan`

### Acceptance criteria
- [ ] lifespan 시작 시 TaskRunner 실행 중
- [ ] app.state.task_runner / task_store 접근 가능
- [ ] 3 test pass

---

## PR-A.5.4 — feat(controller): /api/agents/{id}/tasks 5 endpoint

### Metadata
- **Branch:** `feat/agent-tasks-endpoints`
- **Repo:** Geny
- **Layer:** SERVICE
- **Depends on:** PR-A.5.3
- **Consumed by:** PR-A.5.5 (TasksTab.tsx)

### Files modified

#### `backend/controller/agent_controller.py` — 5 endpoint 추가

```python
@router.post("/agents/{agent_id}/tasks", response_model=TaskCreateResponse)
async def create_task(
    agent_id: str,
    body: TaskCreateRequest,
    request: Request,
    _auth=Depends(require_auth),
):
    runner: TaskRunner = request.app.state.task_runner
    record = TaskRecord(
        id=str(uuid.uuid4()),
        type=body.type,
        subagent_type=body.subagent_type,
        prompt=body.prompt,
        payload=body.payload or {},
    )
    task_id = await runner.submit(record)
    return TaskCreateResponse(task_id=task_id)


@router.get("/agents/{agent_id}/tasks", response_model=TaskListResponse)
async def list_tasks(
    agent_id: str, request: Request,
    status: Optional[str] = None,
    limit: int = 20,
    _auth=Depends(require_auth),
):
    store = request.app.state.task_store
    rows = await store.list(TaskFilter(
        status=TaskStatus(status) if status else None, limit=limit,
    ))
    return TaskListResponse(tasks=[_serialize(r) for r in rows])


@router.get("/agents/{agent_id}/tasks/{task_id}")
async def get_task(...): ...

@router.patch("/agents/{agent_id}/tasks/{task_id}")
async def update_task(...): ...

@router.delete("/agents/{agent_id}/tasks/{task_id}")
async def stop_task(agent_id, task_id, request: Request, _auth=Depends(require_auth)):
    runner = request.app.state.task_runner
    ok = await runner.stop(task_id)
    if not ok:
        raise HTTPException(404, "not_found_or_already_stopped")
    return {"stopped": True}


@router.get("/agents/{agent_id}/tasks/{task_id}/output")
async def stream_task_output(agent_id, task_id, request: Request, _auth=Depends(require_auth)):
    store = request.app.state.task_store
    async def gen():
        async for chunk in store.stream_output(task_id):
            yield chunk
    return StreamingResponse(gen(), media_type="application/octet-stream")
```

#### Pydantic models 추가

- `TaskCreateRequest`, `TaskCreateResponse`, `TaskListResponse`, `TaskGetResponse`, `TaskUpdateRequest`

### Tests added

`backend/tests/controller/test_agent_tasks.py`

- `test_create_task_returns_task_id`
- `test_create_task_requires_auth`
- `test_list_tasks_filters_by_status`
- `test_get_task_404_when_missing`
- `test_stop_task_via_delete`
- `test_stream_output_chunks`
- `test_create_task_invalid_type_400`

### Acceptance criteria
- [ ] 5 endpoint 모두 auth required
- [ ] 7 test pass
- [ ] OpenAPI doc 생성 (FastAPI auto)

---

## PR-A.5.5 — feat(frontend): TasksTab.tsx (polling + status badge + stop)

### Metadata
- **Branch:** `feat/tasks-tab`
- **Repo:** Geny
- **Layer:** SERVICE
- **Depends on:** PR-A.5.4

### Files added

#### `frontend/src/components/tabs/TasksTab.tsx` (~250 lines)

핵심 구조:

```tsx
export function TasksTab({ agentId }: { agentId: string }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [filter, setFilter] = useState<TaskFilter>({ status: 'all' });
  const [selected, setSelected] = useState<Task | null>(null);

  useEffect(() => {
    const interval = setInterval(async () => {
      const res = await fetch(`/api/agents/${agentId}/tasks?status=${filter.status === 'all' ? '' : filter.status}`);
      setTasks(await res.json());
    }, 5000);
    return () => clearInterval(interval);
  }, [agentId, filter.status]);

  return (
    <div className="tasks-tab">
      <TaskFilterBar filter={filter} onChange={setFilter} />
      <TaskTable tasks={tasks} onSelect={setSelected} />
      {selected && <TaskDetailModal task={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
```

- `TaskTable`: status badge / type / created_at / duration / actions (View / Stop)
- `TaskDetailModal`: output streaming via EventSource or fetch streaming
- `TaskFilterBar`: status dropdown / refresh button

### Files modified

- `frontend/src/components/MainView.tsx` — Tabs 에 "Tasks" 추가
- `frontend/src/api/tasks.ts` (신규) — fetch wrapper

### Tests
- 본 cycle 의 carve-out (vitest infra 없음). manual smoke:
  - `/api/agents/<id>/tasks` 호출 확인
  - 5s polling 동작 확인
  - Stop 버튼 → status STOPPED 변경 확인
  - Output streaming 확인

### Acceptance criteria
- [ ] 새 Tab "Tasks" 표시
- [ ] polling 5s
- [ ] Stop 동작
- [ ] Output preview (stream)
- [ ] 운영 환경 배포 후 manual smoke pass

### Risk / mitigation
| Risk | Mitigation |
|---|---|
| 큰 task 수 → 5s polling 부담 | limit=20 + pagination cursor 는 P2 |
| Stream 장시간 hang | TaskDetailModal close 시 fetch abort |

---

## 묶음 1 의 PR 합계 + 의존성 요약

| PR | Repo | 의존 | 누가 consume |
|---|---|---|---|
| PR-A.1.1 | executor | — | A.1.2, A.1.3, A.1.5, Geny A.5.2 |
| PR-A.1.2 | executor | A.1.1 | (default backend, optional) |
| PR-A.1.3 | executor | A.1.1 | A.1.5, Geny A.5.3 |
| PR-A.1.4 | executor | — | Geny A.5.1 |
| PR-A.1.5 | executor | A.1.1, A.1.3 | Geny A.5.4 |
| PR-A.5.0 | Geny | (executor 1.1.0 release) | A.5.1 ~ A.5.5 |
| PR-A.5.1 | Geny | A.5.0 | A.5.5 |
| PR-A.5.2 | Geny | A.5.0 | A.5.3 |
| PR-A.5.3 | Geny | A.5.2 | A.5.4 |
| PR-A.5.4 | Geny | A.5.3 | A.5.5 |
| PR-A.5.5 | Geny | A.5.4 | (frontend manual smoke) |

총 11 PR (executor 5 + Geny 6 — 5.0 chore deps 포함). 위 분포 표 (overview) 의 10 PR + 1 deps PR.

---

## 다음 묶음

[`cycle_A_p0_2_slash.md`](cycle_A_p0_2_slash.md) — Slash commands 6 PR
