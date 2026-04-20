# Progress/02-B — Geny: manifest wires executor built-ins per role

**PR.** [CocoRoF/Geny#189](https://github.com/CocoRoF/Geny/pull/189) — `feat/manifest-wire-executor-built-ins`
**Merged.** 2026-04-20
**Plan.** `plan/02_file_write_tool.md` §PR-B
**Depends on.** geny-executor 0.27.0 (progress/02-A)

---

## Symptom (from cycle 20260420_5 smoke reports)

Sub-Worker asked to "create test.txt" returned a plausible-looking
success message but no file landed under
`backend/storage/<sub_id>/`. The LLM had called `memory_write`
(storing the phrase "test.txt created") as a fallback — its tool
roster contained no filesystem primitive.

## Root cause

See `analysis/02_file_creation_gap.md` (rewritten mid-cycle).
Executor already shipped `WriteTool`; Geny's manifest never asked for
it because `ToolsSnapshot.built_in` was hardcoded to `[]`. Before
executor 0.27.0, populating the field would have been dead metadata —
so Geny's code had a correct comment explaining why. 0.27.0 makes the
field live; Geny's side of the wiring was what remained.

## The change

### `service/langgraph/default_manifest.py`

`build_default_manifest` grows a `built_in_tool_names` kwarg and
threads it into `ToolsSnapshot.built_in`. Docstring + inline comment
updated — the old "dead metadata" rationale is replaced with "the
executor resolves this against `BUILT_IN_TOOL_CLASSES` inside
`from_manifest_async`."

### `service/environment/templates.py`

Two new role-scoped constants:

```python
_WORKER_BUILT_IN_TOOL_NAMES: List[str] = ["*"]   # full filesystem set
_VTUBER_BUILT_IN_TOOL_NAMES: List[str] = []      # no direct file ops
```

- `create_worker_env` passes `["*"]`. Sub-Workers / solo workers get
  `Write` / `Read` / `Edit` / `Bash` / `Glob` / `Grep`, all sandboxed
  to `ToolContext.working_dir` — which `AgentSession` already sets to
  the session's `storage_path` (line 739 of `agent_session.py`).
- `create_vtuber_env` passes `[]`. Conversational persona stays
  file-free; every file operation goes through the bound Sub-Worker
  via `geny_message_counterpart` (progress/01).

### Prompts — `prompts/templates/sub-worker-default.md` / `sub-worker-detailed.md`

Added a "File operations" section teaching Write/Edit and
discouraging `memory_write` for file creation. Also switched the
reporting channel from the deprecated `geny_send_direct_message` to
the symmetric `geny_message_counterpart` introduced in PR-1 —
catching a cleanup the earlier PR missed on the Sub-Worker prompts.

### Dependency floor — `backend/pyproject.toml` / `requirements.txt`

`geny-executor>=0.26.2,<0.27.0` → `>=0.27.0,<0.28.0`.

## Tests

### `tests/service/environment/test_templates.py`

- `test_worker_env_declares_all_executor_built_ins` — worker seed has
  `tools.built_in == ["*"]`
- `test_vtuber_env_declares_no_executor_built_ins` — VTuber seed has
  `tools.built_in == []`
- `test_install_templates_persists_role_built_in_choices` — the disk
  roundtrip preserves both choices

### `tests/service/environment/test_tool_registry_roster.py`

- `test_worker_pipeline_registers_all_executor_built_ins` — real
  `Pipeline.from_manifest` produces a registry containing every
  `BUILT_IN_TOOL_CLASSES` name plus externals
- `test_vtuber_pipeline_registers_no_executor_built_ins` — VTuber
  registry contains none of them
- Pre-existing "empty roster" tests updated — they assert nothing
  resolves through the external channel when no provider is present;
  framework built-ins are subtracted from the registry before the
  comparison since they resolve through the separate built-in channel.

### `tests/integration/test_sub_worker_file_write.py` (new)

- `test_worker_pipeline_write_tool_creates_file` — builds a real
  worker Pipeline, calls `Write.execute` with `working_dir=tmp_path`,
  asserts file exists on disk with the expected content
- `test_worker_pipeline_write_tool_rejects_escape` — path outside
  `working_dir` returns `is_error=True`, no file created
- `test_vtuber_env_has_no_write_tool` — symmetric negative control

Full suite: **74/74 pass** (previous baseline 66 + 8 new).

## Ship verification (pending runtime smoke)

Merged into main as commit `6db5d8d`. Next manual smoke:

1. Restart Geny backend with new executor floor
2. Create a VTuber session → Sub-Worker auto-links
3. User: "Sub-Worker에게 test.txt 파일을 만들라고 해줘"
4. Expect: VTuber calls `geny_message_counterpart`; Sub-Worker calls
   `Write(file_path="test.txt", content=...)`;
   `backend/storage/<sub_id>/test.txt` exists;
   `/api/sessions/<sub_id>/files` returns it
5. Negative control: user asks VTuber directly "make test.txt" —
   VTuber has no `Write` tool, must delegate

## Architectural note

This PR completes the transition from "Geny owns the filesystem tool"
to "executor ships the filesystem tool, Geny opts in per role." The
precedent this sets: new built-in tools landing in executor under
`BUILT_IN_TOOL_CLASSES` are picked up automatically by any consumer
that already declares `["*"]`. Future `Delete` / `Move` / `HttpGet`
shipped by the executor will flow to Sub-Workers with zero Geny-side
code change.
