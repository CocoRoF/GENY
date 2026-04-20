# Progress/02-A — Executor: manifest.tools.built_in goes live

**PR.** [CocoRoF/geny-executor#35](https://github.com/CocoRoF/geny-executor/pull/35) — `feat/pipeline-autoregister-built-ins`
**Merged.** 2026-04-20
**Released.** geny-executor 0.27.0
**Plan.** `plan/02_file_write_tool.md` §PR-A

---

## The principle

> *The framework must ship not only the interface but also the useful
> tools built on that interface.*

geny-executor had always shipped `ReadTool` / `WriteTool` / `EditTool`
/ `BashTool` / `GlobTool` / `GrepTool` under
`src/geny_executor/tools/built_in/`. Until this PR, though,
`Pipeline.from_manifest_async` only consumed `tools.external` — so the
`tools.built_in` field was dead metadata. Consumers (Geny) were
forced to reimplement filesystem tools on their own side if they
wanted them.

## The change

### `src/geny_executor/tools/built_in/__init__.py`

Added a single source of truth for the shipped tool names:

```python
BUILT_IN_TOOL_CLASSES: dict[str, type] = {
    "Read": ReadTool,
    "Write": WriteTool,
    "Edit": EditTool,
    "Bash": BashTool,
    "Glob": GlobTool,
    "Grep": GrepTool,
}
```

Future built-ins only need to land in this map to be reachable by any
manifest — the consumer side doesn't have to change a line.

### `src/geny_executor/core/pipeline.py`

New helper `_register_built_in_tools(manifest, registry)` handles
three cases:

- `built_in == ["*"]` — register every name in `BUILT_IN_TOOL_CLASSES`
- `built_in == ["Write", "Read"]` — register only the named classes
- `built_in == []` / missing — no-op (preserves the prior "external
  only" behavior)

Unknown names emit a warning and are skipped; a typo doesn't kill the
build. The helper runs **before** `_register_external_tools`, so host
providers retain the ability to override a framework tool (e.g. ship a
sandboxed `Bash` variant) via `AdhocToolProvider` — `ToolRegistry`'s
existing last-write-wins semantics give the host the final say.

### Tests

`tests/unit/test_built_in_autoregister.py` — new, 9 cases:

- Map shape guards (every exported class is mapped; no duplicates)
- `["*"]` → all 6 tools registered
- `["Write", "Read"]` → only those two
- `[]` / missing → nothing registered
- Unknown name → warning, registration continues
- External provider with same name → host override wins
- Built-in + external with different names → both coexist
- End-to-end: registered `WriteTool.execute` creates a real file
- Negative: path outside `working_dir` rejected

Full suite: **1046 passed, 18 skipped**. Pre-existing
`test_pipeline_from_manifest` continues to cover the manifest integration
layer unchanged.

## Version + changelog

- `pyproject.toml` / `__init__.py`: `0.26.2` → `0.27.0` (additive —
  new field semantics; no breaking change)
- `CHANGELOG.md`: new section documenting the feature and the
  "framework ships the tool, not just the interface" direction

## What unblocks after this

Geny PR-B can now flip `tools.built_in = []` → `["*"]` on the worker
manifest template and have the Sub-Worker actually receive a `Write`
tool in its runtime registry. That is progress/02-B.

## Issues encountered / resolved

- Initial assertion on "external provider gets skipped when built-in
  already registered" failed because `ToolRegistry.register` is
  last-write-wins. The test was renamed to
  `test_external_overrides_built_in_on_name_collision` and the
  docstring updated: *this is actually the preferable semantic* —
  hosts can swap a framework tool for a hardened variant via a single
  provider line instead of forking.
- CI Lint: F401 unused `AdhocToolProvider` import → removed
- CI Lint: ruff format re-wrapped `pipeline.py` and the test file →
  applied
