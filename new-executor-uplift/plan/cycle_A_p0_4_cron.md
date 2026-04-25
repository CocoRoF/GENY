# Cycle A · 묶음 4 — Cron / scheduling (6 PR)

**묶음 ID:** A.4 (executor 3) + A.8 (Geny 3)
**Layer:** EXEC-CORE (CronJobStore ABC + 3 tool + daemon) + SERVICE (Postgres backend + REST + UI + lifespan)
**격차:** N.45 / N.46 — claude-code 의 CronCreate/Delete/List + scheduler
**의존성:** P0.1 의 TaskRunner 와 fire 시점 통합 (cron → TaskRunner.submit)

---

# Part A — geny-executor (3 PR)

## PR-A.4.1 — feat(cron): CronJobStore ABC + InMemory + FileBacked impls

### Metadata
- **Branch:** `feat/cron-job-store`
- **Repo:** geny-executor
- **Layer:** EXEC-INTERFACE + EXEC-CORE (reference impls)
- **Depends on:** none
- **Consumed by:** PR-A.4.2 / A.4.3 / Geny A.8.1

### Files added

#### `geny_executor/cron/__init__.py`

```python
from .types import CronJob, CronJobStatus
from .store_abc import CronJobStore
from .store_impl.in_memory import InMemoryCronJobStore
from .store_impl.file_backed import FileBackedCronJobStore
from .runner import CronRunner

__all__ = [
    "CronJob", "CronJobStatus",
    "CronJobStore", "InMemoryCronJobStore", "FileBackedCronJobStore",
    "CronRunner",
]
```

#### `geny_executor/cron/types.py` (~70 lines)

```python
from __future__ import annotations
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Dict, Optional


class CronJobStatus(str, Enum):
    ENABLED = "enabled"
    DISABLED = "disabled"


@dataclass
class CronJob:
    name: str
    cron_expr: str                          # "0 9 * * *"
    target_type: str                        # "local_bash" | "local_agent"
    payload: Dict[str, Any] = field(default_factory=dict)
                                            # local_bash: {"command": "..."}
                                            # local_agent: {"subagent_type": "...", "prompt": "..."}
    description: Optional[str] = None
    status: CronJobStatus = CronJobStatus.ENABLED
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    last_fired_at: Optional[datetime] = None
    last_task_id: Optional[str] = None
    next_fire_at: Optional[datetime] = None  # 캐시 (runner 가 갱신)
```

#### `geny_executor/cron/store_abc.py` (~50 lines)

```python
class CronJobStore(ABC):
    @abstractmethod
    async def put(self, job: CronJob) -> None: ...
    
    @abstractmethod
    async def get(self, name: str) -> Optional[CronJob]: ...
    
    @abstractmethod
    async def list(self, *, only_enabled: bool = False) -> List[CronJob]: ...
    
    @abstractmethod
    async def delete(self, name: str) -> bool: ...
    
    @abstractmethod
    async def mark_fired(self, name: str, when: datetime, task_id: Optional[str]) -> None: ...
    
    @abstractmethod
    async def update_status(self, name: str, status: CronJobStatus) -> Optional[CronJob]: ...
```

#### `geny_executor/cron/store_impl/in_memory.py` (~80 lines)

표준 InMemory impl. `dict[str, CronJob]` + `asyncio.Lock`.

#### `geny_executor/cron/store_impl/file_backed.py` (~120 lines)

```python
class FileBackedCronJobStore(CronJobStore):
    """Single-file json store. Suitable for self-hosted single-process.
    
    Layout:
      <root>/cron.json    {"jobs": [...]}
      <root>/cron.json.bak (마지막 successful write 의 backup)
    """

    def __init__(self, path: Path):
        self._path = path
        self._cache: Dict[str, CronJob] = {}
        self._loaded = False
        self._lock = asyncio.Lock()

    async def _ensure_loaded(self):
        if self._loaded: return
        if self._path.exists():
            data = json.loads(self._path.read_text())
            for j in data.get("jobs", []):
                self._cache[j["name"]] = _decode(j)
        self._loaded = True

    async def _flush(self):
        # atomic write: tmp → rename
        tmp = self._path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"jobs": [_encode(j) for j in self._cache.values()]}, indent=2))
        if self._path.exists():
            self._path.replace(self._path.with_suffix(".bak"))
        tmp.replace(self._path)

    async def put(self, job): ...      # ensure_loaded → cache update → flush
    async def get(self, name): ...
    async def list(self, *, only_enabled=False): ...
    async def delete(self, name): ...
    async def mark_fired(self, name, when, task_id): ...
    async def update_status(self, name, status): ...
```

### Tests added

`tests/cron/test_in_memory_store.py`

- `test_round_trip`
- `test_list_only_enabled_filter`
- `test_delete_returns_false_for_missing`
- `test_mark_fired_updates_timestamp`
- `test_update_status_disable_then_enable`

`tests/cron/test_file_backed_store.py`

- `test_survives_restart`
- `test_atomic_write_via_rename`
- `test_corrupt_json_ignored_with_warning`
- `test_concurrent_puts_serialised`
- `test_backup_created_on_write`

### Acceptance criteria
- [ ] CronJobStore ABC + 2 impl ship
- [ ] 10 test pass
- [ ] line coverage ≥ 90%
- [ ] CHANGELOG.md 1.1.0: "Add CronJobStore ABC + in-memory + file-backed"

---

## PR-A.4.2 — feat(tools): 3 cron tools (CronCreate / Delete / List)

### Metadata
- **Branch:** `feat/cron-tools`
- **Repo:** geny-executor
- **Layer:** EXEC-CORE
- **Depends on:** PR-A.4.1

### Files added

#### `geny_executor/tools/built_in/cron_create_tool.py` (~120 lines)

```python
class CronCreateTool(Tool):
    name = "CronCreate"
    description = (
        "Create a recurring scheduled task. cron_expr is standard 5-field "
        "(minute hour day month weekday). target_type is local_bash or local_agent."
    )
    capabilities = ToolCapabilities(concurrency_safe=False, destructive=True)
    input_schema = {
        "type": "object",
        "required": ["name", "cron_expr", "target_type"],
        "properties": {
            "name": {"type": "string", "pattern": "^[a-zA-Z0-9_-]+$", "maxLength": 64},
            "cron_expr": {"type": "string"},
            "target_type": {"enum": ["local_bash", "local_agent"]},
            "payload": {"type": "object"},
            "description": {"type": "string"},
        },
    }

    async def execute(self, input_data, ctx):
        store = ctx.get_strategy("cron_store")
        if not store:
            return ToolResult.error("cron_store not configured")
        # validate cron expr
        from croniter import croniter, CroniterBadCronError
        try:
            croniter(input_data["cron_expr"])
        except CroniterBadCronError as e:
            return ToolResult.error(f"invalid_cron_expr: {e}")
        # 이미 존재하면 reject (update 는 별도)
        existing = await store.get(input_data["name"])
        if existing:
            return ToolResult.error(f"name_already_exists: {input_data['name']}")
        job = CronJob(
            name=input_data["name"],
            cron_expr=input_data["cron_expr"],
            target_type=input_data["target_type"],
            payload=input_data.get("payload", {}),
            description=input_data.get("description"),
        )
        await store.put(job)
        # runner 에 즉시 반영
        runner = ctx.get_strategy("cron_runner")
        if runner:
            await runner.refresh()
        return ToolResult.ok({"name": job.name, "next_fire_at": job.next_fire_at})
```

#### `geny_executor/tools/built_in/cron_delete_tool.py` (~70 lines)

```python
class CronDeleteTool(Tool):
    name = "CronDelete"
    description = "Delete a cron job by name."
    capabilities = ToolCapabilities(concurrency_safe=False, destructive=True)
    input_schema = {"type": "object", "required": ["name"], "properties": {"name": {"type": "string"}}}

    async def execute(self, input_data, ctx):
        store = ctx.get_strategy("cron_store")
        deleted = await store.delete(input_data["name"])
        if not deleted:
            return ToolResult.error("not_found")
        runner = ctx.get_strategy("cron_runner")
        if runner:
            await runner.refresh()
        return ToolResult.ok({"deleted": input_data["name"]})
```

#### `geny_executor/tools/built_in/cron_list_tool.py` (~70 lines)

```python
class CronListTool(Tool):
    name = "CronList"
    description = "List all cron jobs (with next/last fire times)."
    capabilities = ToolCapabilities(concurrency_safe=True)
    input_schema = {
        "type": "object",
        "properties": {"only_enabled": {"type": "boolean", "default": False}},
    }

    async def execute(self, input_data, ctx):
        store = ctx.get_strategy("cron_store")
        jobs = await store.list(only_enabled=input_data.get("only_enabled", False))
        return ToolResult.ok({"jobs": [_serialize(j) for j in jobs]})
```

### Files modified

- `geny_executor/tools/built_in/__init__.py` — 3 추가
- `geny_executor/manifest/default.py` — Stage 신규 slot `cron_store`, `cron_runner` 추가 (default = InMemory)
- `pyproject.toml` — `croniter = "^2.0"` dependency 추가

### Tests added

`tests/tools/built_in/test_cron_create_tool.py`, `test_cron_delete_tool.py`, `test_cron_list_tool.py` (3 파일)

각 4-6 test. 총 ~14 test.

### Acceptance criteria
- [ ] 3 tool 등록
- [ ] 14 test pass
- [ ] croniter dependency 추가
- [ ] CHANGELOG.md 1.1.0: "Add 3 cron tools"

### Risk / mitigation
| Risk | Mitigation |
|---|---|
| 잘못된 cron expr → 무한 fire | croniter 사전 validate |
| name 충돌 | put 전 get 확인 (CronCreate 에서) |

---

## PR-A.4.3 — feat(cron): CronRunner (asyncio + croniter) + lifecycle hook

### Metadata
- **Branch:** `feat/cron-runner`
- **Repo:** geny-executor
- **Layer:** EXEC-CORE
- **Depends on:** PR-A.4.1, PR-A.1.3 (TaskRunner)
- **Consumed by:** Geny A.8.2 (lifespan)

### Files added

#### `geny_executor/cron/runner.py` (~250 lines)

```python
class CronRunner:
    """Background daemon. Polls store every cycle_seconds, fires jobs whose
    next_fire_at <= now via TaskRunner.submit.
    
    Usage:
      runner = CronRunner(store=..., task_runner=..., cycle_seconds=60)
      await runner.start()
      ...
      await runner.shutdown()
    
    Concurrency:
      - 단일 daemon (asyncio.Task)
      - 동일 cron 의 중복 fire 방지: last_fired_at 비교
      - fire 자체는 TaskRunner 에 위임 → 비동기
    """

    def __init__(
        self,
        store: CronJobStore,
        task_runner: TaskRunner,
        cycle_seconds: int = 60,
    ) -> None:
        self._store = store
        self._task_runner = task_runner
        self._cycle = cycle_seconds
        self._daemon: Optional[asyncio.Task] = None
        self._stop = asyncio.Event()
        self._last_check: Dict[str, datetime] = {}

    async def start(self) -> None:
        if self._daemon: return
        self._stop.clear()
        self._daemon = asyncio.create_task(self._loop(), name="cron-daemon")

    async def shutdown(self, timeout: float = 5.0) -> None:
        if not self._daemon: return
        self._stop.set()
        try:
            await asyncio.wait_for(self._daemon, timeout=timeout)
        except asyncio.TimeoutError:
            self._daemon.cancel()
        self._daemon = None

    async def refresh(self) -> None:
        """Wake daemon to re-read store. Useful after CronCreate/Delete."""
        # 다음 cycle 에 자동 반영. 명시적 reset 필요 시 store list 재호출.
        # 단순하게는 no-op (현 cycle 의 다음 tick 에 반영됨).
        pass

    async def _loop(self):
        from croniter import croniter
        while not self._stop.is_set():
            now = datetime.now(timezone.utc)
            try:
                jobs = await self._store.list(only_enabled=True)
                for job in jobs:
                    next_fire = self._compute_next(job, now)
                    if next_fire is None: continue
                    if job.last_fired_at and next_fire <= job.last_fired_at:
                        continue   # 이미 발사됨 (idempotent)
                    if next_fire > now:
                        continue
                    # FIRE
                    record = self._build_task_record(job, next_fire)
                    task_id = await self._task_runner.submit(record)
                    await self._store.mark_fired(job.name, next_fire, task_id)
                    logger.info("cron_fired", name=job.name, next_fire=next_fire, task_id=task_id)
            except Exception as e:
                logger.exception("cron_loop_error", error=str(e))
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=self._cycle)
            except asyncio.TimeoutError:
                pass

    def _compute_next(self, job: CronJob, now: datetime) -> Optional[datetime]:
        from croniter import croniter
        base = job.last_fired_at or job.created_at
        try:
            it = croniter(job.cron_expr, base)
            return it.get_next(datetime)
        except Exception:
            return None

    def _build_task_record(self, job: CronJob, fire_time: datetime) -> TaskRecord:
        from geny_executor.stages.s13_task_registry import TaskRecord
        return TaskRecord(
            id=str(uuid.uuid4()),
            type=job.target_type,
            subagent_type=job.payload.get("subagent_type"),
            prompt=job.payload.get("prompt"),
            payload={**job.payload, "cron_name": job.name, "scheduled_for": fire_time.isoformat()},
        )
```

### Tests added

`tests/cron/test_runner.py`

- `test_fire_when_due` (mock TaskRunner — runner.submit called)
- `test_no_fire_when_disabled`
- `test_no_fire_when_not_due`
- `test_idempotent_skips_already_fired`
- `test_handles_invalid_cron_expr_gracefully`
- `test_shutdown_cancels_daemon`
- `test_refresh_no_op_does_not_break`
- `test_concurrent_jobs_fired_in_same_cycle`

### Acceptance criteria
- [ ] CronRunner ship + 8 test pass
- [ ] line coverage ≥ 90%
- [ ] CHANGELOG.md 1.1.0: "Add CronRunner background daemon"

### Risk / mitigation
| Risk | Mitigation |
|---|---|
| daemon 죽으면 모든 cron miss | 서비스 lifespan 에서 keepalive (재시작) |
| 동일 cron 중복 fire | last_fired_at 비교 + croniter 의 deterministic 계산 |
| store 가 list 호출에서 실패 → loop 멈춤 | try/except + log + 다음 cycle 재시도 |

---

# Part B — Geny (3 PR)

## PR-A.8.1 — feat(service): PostgresCronJobStore

### Metadata
- **Branch:** `feat/postgres-cron-store`
- **Repo:** Geny
- **Layer:** SERVICE
- **Depends on:** PR-A.5.0, PR-A.4.1
- **Consumed by:** PR-A.8.2

### Files added

#### `backend/service/cron/__init__.py`
#### `backend/service/cron/store_postgres.py` (~150 lines)

```python
class CronJobRow(Base):
    __tablename__ = "cron_jobs"
    name = Column(String(64), primary_key=True)
    cron_expr = Column(String(64), nullable=False)
    target_type = Column(String(32), nullable=False)
    payload = Column(JSON, default={})
    description = Column(Text)
    status = Column(String(16), nullable=False, default="enabled", index=True)
    created_at = Column(DateTime(timezone=True), nullable=False)
    last_fired_at = Column(DateTime(timezone=True))
    last_task_id = Column(String(64))


class PostgresCronJobStore(CronJobStore):
    def __init__(self, session_factory):
        self._session_factory = session_factory
    # 모든 method 를 SQLAlchemy async 로 구현
    ...
```

#### `backend/migrations/versions/<rev>_add_cron_jobs_table.py`

### Tests added

`backend/tests/service/cron/test_postgres_store.py` (postgres fixture)

- 5 test (in-memory test 와 동일 행동 확인)

### Acceptance criteria
- [ ] alembic upgrade head 성공
- [ ] 5 test pass
- [ ] PostgresCronJobStore 가 ABC 시그니처 통과

---

## PR-A.8.2 — feat(infra): FastAPI lifespan — CronRunner + register_cron_store

### Metadata
- **Branch:** `feat/cron-runner-lifespan`
- **Repo:** Geny
- **Layer:** SERVICE
- **Depends on:** PR-A.8.1, PR-A.5.3 (TaskRunner 가 이미 lifespan 에)

### Files modified

#### `backend/main.py`

```python
@asynccontextmanager
async def lifespan(app: FastAPI):
    # 기존 ... TaskRunner setup ...
    
    cron_store = PostgresCronJobStore(session_factory=async_session_factory)
    cron_runner = CronRunner(
        store=cron_store, task_runner=app.state.task_runner, cycle_seconds=60,
    )
    await cron_runner.start()
    app.state.cron_runner = cron_runner
    app.state.cron_store = cron_store
    
    try:
        yield
    finally:
        await cron_runner.shutdown(timeout=5)
        await app.state.task_runner.shutdown(timeout=30)
        ...
```

#### `backend/service/cron/install.py`

```python
def install_cron_runtime(pipeline, store, runner):
    """Pipeline 에 cron_store / cron_runner slot 주입."""
    # 적절한 stage / 전역 slot 에 set
    pipeline.set_global_strategy("cron_store", store)
    pipeline.set_global_strategy("cron_runner", runner)
```

### Tests added

`backend/tests/main/test_lifespan_cron.py`

- `test_cron_runner_started_in_lifespan`
- `test_cron_runner_shutdown_on_app_close`
- `test_cron_runner_uses_task_runner`

### Acceptance criteria
- [ ] lifespan 시작 시 CronRunner 실행 중
- [ ] 3 test pass
- [ ] cron_runner 가 task_runner 와 정확히 연결

---

## PR-A.8.3 — feat: /api/cron/jobs endpoint × 4 + CronTab.tsx

### Metadata
- **Branch:** `feat/cron-endpoints-and-ui`
- **Repo:** Geny
- **Layer:** SERVICE
- **Depends on:** PR-A.8.2

### Files added

#### `backend/controller/cron_controller.py` (~150 lines)

```python
router = APIRouter(prefix="/api/cron", tags=["cron"])


class CronJobCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=64, regex="^[a-zA-Z0-9_-]+$")
    cron_expr: str
    target_type: str = Field(regex="^(local_bash|local_agent)$")
    payload: Dict[str, Any] = {}
    description: Optional[str] = None


class CronJobResponse(BaseModel):
    name: str
    cron_expr: str
    target_type: str
    payload: Dict[str, Any]
    description: Optional[str]
    status: str
    created_at: datetime
    last_fired_at: Optional[datetime]
    next_fire_at: Optional[datetime]


@router.get("/jobs", response_model=List[CronJobResponse])
async def list_cron_jobs(request: Request, _auth=Depends(require_auth)):
    store = request.app.state.cron_store
    jobs = await store.list()
    return [CronJobResponse.from_cronjob(j) for j in jobs]


@router.post("/jobs", response_model=CronJobResponse)
async def create_cron_job(body: CronJobCreateRequest, request: Request, _auth=Depends(require_auth)):
    store = request.app.state.cron_store
    runner = request.app.state.cron_runner
    # validate cron expr
    try:
        croniter(body.cron_expr)
    except CroniterBadCronError as e:
        raise HTTPException(400, f"invalid_cron_expr: {e}")
    if await store.get(body.name):
        raise HTTPException(409, "name_already_exists")
    job = CronJob(
        name=body.name, cron_expr=body.cron_expr, target_type=body.target_type,
        payload=body.payload, description=body.description,
    )
    await store.put(job)
    await runner.refresh()
    return CronJobResponse.from_cronjob(job)


@router.delete("/jobs/{name}")
async def delete_cron_job(name: str, request: Request, _auth=Depends(require_auth)):
    store = request.app.state.cron_store
    if not await store.delete(name):
        raise HTTPException(404, "not_found")
    await request.app.state.cron_runner.refresh()
    return {"deleted": name}


@router.post("/jobs/{name}/run-now")
async def run_cron_now(name: str, request: Request, _auth=Depends(require_auth)):
    """Adhoc trigger — fire job immediately, regardless of schedule."""
    store = request.app.state.cron_store
    runner = request.app.state.cron_runner
    job = await store.get(name)
    if not job:
        raise HTTPException(404, "not_found")
    record = runner._build_task_record(job, datetime.now(timezone.utc))
    task_id = await request.app.state.task_runner.submit(record)
    return {"task_id": task_id}
```

#### `frontend/src/components/tabs/CronTab.tsx` (~280 lines)

핵심 구조:

```tsx
export function CronTab() {
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [showCreateModal, setShowCreateModal] = useState(false);

  useEffect(() => {
    refresh();
    const i = setInterval(refresh, 30_000);
    return () => clearInterval(i);
  }, []);

  async function refresh() {
    const res = await fetch("/api/cron/jobs");
    setJobs(await res.json());
  }

  async function handleDelete(name: string) {
    if (!confirm(`Delete cron job ${name}?`)) return;
    await fetch(`/api/cron/jobs/${name}`, { method: "DELETE" });
    refresh();
  }

  async function handleRunNow(name: string) {
    const res = await fetch(`/api/cron/jobs/${name}/run-now`, { method: "POST" });
    const { task_id } = await res.json();
    // 결과는 TasksTab 으로 navigate (선택)
  }

  return (
    <div className="cron-tab">
      <header>
        <h2>Scheduled Tasks (cron)</h2>
        <button onClick={() => setShowCreateModal(true)}>+ Add job</button>
      </header>
      <CronJobTable jobs={jobs} onDelete={handleDelete} onRunNow={handleRunNow} />
      {showCreateModal && (
        <CronJobCreateModal onClose={() => { setShowCreateModal(false); refresh(); }} />
      )}
    </div>
  );
}
```

- `CronJobTable`: name / cron_expr / next_fire_at / last_fired_at / status badge / actions (Run now / Delete)
- `CronJobCreateModal`: form (name + cron_expr with cronstrue 같은 humanizer + target_type select + payload textarea + description)

### Files modified

- `backend/main.py` — `app.include_router(cron_controller.router)`
- `frontend/src/components/MainView.tsx` — Tabs 에 "Cron" 추가
- `frontend/src/api/cron.ts` (신규) — fetch wrapper

### Tests added

`backend/tests/controller/test_cron_endpoints.py`

- `test_list_jobs_requires_auth`
- `test_create_job_validates_cron_expr`
- `test_create_job_409_on_duplicate_name`
- `test_delete_job_404_when_missing`
- `test_run_now_creates_task`
- `test_run_now_404_for_unknown_job`

### Acceptance criteria
- [ ] 4 endpoint 모두 auth required
- [ ] 6 test pass
- [ ] CronTab manual smoke (운영 배포 후)
- [ ] cronstrue 같은 humanizer 사용 (선택 — 없으면 raw expr)

### Risk / mitigation
| Risk | Mitigation |
|---|---|
| run-now 의 race (cron tick 과 동시) | last_fired_at 갱신 X (manual fire 는 schedule 무관) |
| 큰 payload (e.g. 100KB prompt) | payload max 16KB (controller validate) |

---

## 묶음 4 의 PR 합계 + 의존성 요약

| PR | Repo | 의존 | 누가 consume |
|---|---|---|---|
| PR-A.4.1 | executor | — | A.4.2, A.4.3, Geny A.8.1 |
| PR-A.4.2 | executor | A.4.1 | LLM (cron tools) |
| PR-A.4.3 | executor | A.4.1, A.1.3 | Geny A.8.2 |
| PR-A.8.1 | Geny | A.5.0, A.4.1 | A.8.2 |
| PR-A.8.2 | Geny | A.8.1, A.5.3 | A.8.3 |
| PR-A.8.3 | Geny | A.8.2 | (frontend) |

총 6 PR (executor 3 + Geny 3).

---

## Cycle A 전체 마무리

- 4 묶음 모두 완료 → executor 19 PR + Geny 12 PR + chore deps 1 PR = **32 PR** (overview 의 31 + chore)
- Executor 1.1.0 release tag → Geny pyproject bump → Geny 의 12 PR 완료 → docker compose redeploy
- Cycle A 완료 → [`cycle_C_audit.md`](cycle_C_audit.md) 또는 [`cycle_B_overview.md`](cycle_B_overview.md) 로

## 다음 묶음

[`cycle_B_overview.md`](cycle_B_overview.md) — Cycle B (executor 1.2 + Geny adopt)
