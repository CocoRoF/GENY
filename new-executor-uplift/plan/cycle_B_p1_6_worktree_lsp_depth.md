# Cycle B · 묶음 6 — Worktree + LSP integration depth (3 PR)

**묶음 ID:** B.6
**Layer:** EXEC-CORE (subagent-worktree integration + multi-language LSP) + SERVICE (preset 의 default Worktree 정책 + LSP language 설정)
**격차:** P0.3 의 단일 Worktree/LSP tool 로는 부족한 dev environment 통합. 코드 worker preset 가 worktree 를 자동 활용 + LSP 가 language 별 adapter 정확히 wired.
**의존성:** P0.3 (PR-A.3.4 Worktree, PR-A.3.5 LSP) 의 기본 tool 이 이미 ship.

---

# Part A — geny-executor (1 PR)

## PR-B.6.1 — feat(stages): SubagentTypeOrchestrator 의 worktree integration

### Metadata
- **Branch:** `feat/subagent-worktree-integration`
- **Repo:** geny-executor
- **Layer:** EXEC-CORE

### 동작 모델

```
SubagentTypeDescriptor 에 isolation_strategy field 추가:
  - "none"      — 동일 cwd 에서 실행 (기본)
  - "worktree"  — 새 git worktree 만들어 sub-pipeline 실행, 종료 시 정리

orchestrator.spawn 시 isolation 평가:
  if descriptor.isolation_strategy == "worktree":
      worktree_path = await EnterWorktreeTool.execute(...)
      sub_ctx.sandbox.cwd = worktree_path
      try:
          result = await sub_pipeline.run(...)
      finally:
          await ExitWorktreeTool.execute(remove=True)
```

### Files modified

#### `geny_executor/stages/s12_agent/descriptor.py`

```python
class SubagentTypeDescriptor:
    id: str
    name: str
    description: str
    default_model: str
    default_tools: List[str]
    
    # NEW
    isolation_strategy: str = "none"   # "none" | "worktree"
    isolation_config: Dict[str, Any] = {}  # worktree: {"branch_template": "agent-{id}-{ts}"}
```

#### `geny_executor/stages/s12_agent/orchestrator.py`

```python
async def spawn(self, descriptor, prompt, parent_ctx):
    # ... 기존
    sub_ctx = self._build_sub_context(parent_ctx, descriptor)
    
    if descriptor.isolation_strategy == "worktree":
        worktree_path = await self._enter_worktree(descriptor, sub_ctx)
        sub_ctx.sandbox.push_scope(worktree_path)
    
    try:
        async for evt in self._run_sub_pipeline(descriptor, prompt, sub_ctx):
            yield evt
    finally:
        if descriptor.isolation_strategy == "worktree":
            await self._exit_worktree(sub_ctx, remove=True)
```

### Tests added

`tests/stages/s12_agent/test_orchestrator_worktree.py`

- `test_isolation_none_does_not_create_worktree`
- `test_isolation_worktree_creates_and_cleans_up` (tmp git repo fixture)
- `test_isolation_worktree_sub_ctx_uses_isolated_cwd`
- `test_isolation_worktree_cleanup_on_subagent_failure`
- `test_isolation_worktree_branch_template_substitutes`

### Acceptance criteria
- [ ] descriptor.isolation_strategy field
- [ ] orchestrator 가 worktree 자동 enter/exit
- [ ] 5 test pass
- [ ] CHANGELOG.md 1.2.0: "SubagentTypeOrchestrator: worktree isolation_strategy"

### Risk / mitigation
| Risk | Mitigation |
|---|---|
| sub-pipeline crash → worktree 정리 안 됨 | finally 블록 + cleanup 실패도 log + 다음 spawn 에 영향 X |
| 동시 spawn 의 branch name 충돌 | branch_template 에 {ts} (ms 단위 + uuid) |

---

# Part B — Geny (2 PR)

## PR-B.6.2 — feat(service): 코드 worker preset 의 default worktree 정책

### Metadata
- **Branch:** `feat/code-worker-default-worktree`
- **Repo:** Geny
- **Layer:** SERVICE
- **Depends on:** PR-B.6.1 + Geny pyproject 1.2.0 bump

### Files modified

#### `backend/service/agent_types/registry.py`

기존 PR-A.5.1 의 descriptors:

```python
DESCRIPTORS = [
    SubagentTypeDescriptor(
        id="worker",
        name="General-purpose worker",
        ...
        isolation_strategy="none",
    ),
    SubagentTypeDescriptor(
        id="researcher",
        name="Research-only worker",
        ...
        isolation_strategy="none",
    ),
    SubagentTypeDescriptor(
        id="vtuber-narrator",
        name="VTuber narration sub-agent",
        ...
        isolation_strategy="none",
    ),
    # NEW (B.6.2)
    SubagentTypeDescriptor(
        id="code-coder",
        name="Code-editing sub-agent (isolated worktree)",
        description="Spawns into a fresh git worktree for safe code edits.",
        default_model="claude-sonnet-4-6",
        default_tools=["read", "write", "edit", "grep", "glob", "bash", "lsp"],
        isolation_strategy="worktree",
        isolation_config={"branch_template": "agent-{id}"},
    ),
]
```

### Files modified

- `backend/service/preset/code_worker.py` (신규 또는 기존 수정) — default subagent_type = "code-coder"
- `frontend/src/components/SettingsPanel.tsx` — "Code worker" preset 선택 시 isolation 설명 표시

### Tests added

`backend/tests/service/agent_types/test_code_coder.py`

- `test_code_coder_descriptor_uses_worktree`
- `test_code_coder_default_tools_include_lsp`
- `test_install_includes_code_coder`

### Acceptance criteria
- [ ] code-coder descriptor 등록
- [ ] 3 test pass
- [ ] manual smoke: code worker preset → AgentTool spawn → tmp worktree 생성 확인

---

## PR-B.6.3 — feat(service): LSP language adapter config wiring

### Metadata
- **Branch:** `feat/lsp-language-adapters`
- **Repo:** Geny
- **Layer:** SERVICE

### Files added

#### `backend/service/lsp/__init__.py`
#### `backend/service/lsp/install.py` (~80 lines)

```python
"""Configure LSP language adapters in the executor's LSPTool.

Wires (settings.lsp.adapters):
  python:     pyright (or basedpyright)
  typescript: tsc + tsserver
  rust:       rust-analyzer

If a binary is not found in PATH, the language is logged and skipped.
"""

import shutil
from geny_executor.tools.built_in.lsp_tool import _ADAPTERS
from .adapters.pyright import PyrightAdapter
from .adapters.tsc import TscAdapter
from .adapters.rust_analyzer import RustAnalyzerAdapter


def install_lsp_adapters(settings_lsp: Dict[str, Any]):
    candidates = {
        "python": (PyrightAdapter, ["pyright", "basedpyright"]),
        "typescript": (TscAdapter, ["tsc"]),
        "rust": (RustAnalyzerAdapter, ["rust-analyzer"]),
    }
    enabled = settings_lsp.get("languages", ["python", "typescript"])
    for lang in enabled:
        cls, bins = candidates.get(lang, (None, []))
        if not cls: continue
        bin_path = next((shutil.which(b) for b in bins if shutil.which(b)), None)
        if not bin_path:
            logger.warning("lsp_binary_missing", language=lang, candidates=bins)
            continue
        _ADAPTERS[lang] = cls(binary=bin_path)
        logger.info("lsp_adapter_installed", language=lang, binary=bin_path)
```

#### `backend/service/lsp/adapters/pyright.py` (~120 lines)

pyright CLI 호출 / stdio LSP client wrapper.

#### `backend/service/lsp/adapters/tsc.py` / `rust_analyzer.py`

비슷한 구조.

### Files modified

- `backend/main.py` — lifespan 에서 `install_lsp_adapters(settings.get_section("lsp") or {})`
- `backend/service/settings/sections.py` — LSPSection 추가 + register_section("lsp", LSPSection)

### Tests added

`backend/tests/service/lsp/test_install.py`

- `test_install_skips_missing_binaries`
- `test_install_registers_adapter_when_binary_present` (mock shutil.which)
- `test_install_only_enabled_languages`

### Acceptance criteria
- [ ] 3 language adapter ship
- [ ] 3 test pass
- [ ] LSPTool 호출 가능 (manual smoke: `LSP {language: python, action: diagnostics, file: <path>}`)
- [ ] 누락된 binary 는 graceful skip

### Risk / mitigation
| Risk | Mitigation |
|---|---|
| LSP server 가 stdio 로 무한 응답 hang | per-call timeout (10s) |
| pyright stdout 의 색상 escape | strip ANSI |

---

## 묶음 합계

| PR | Repo | 의존 |
|---|---|---|
| PR-B.6.1 | executor | — |
| PR-B.6.2 | Geny | B.6.1 + Geny pyproject 1.2.0 |
| PR-B.6.3 | Geny | A.3.5 (LSPTool ship) + Geny pyproject 1.2.0 |

총 3 PR. Cycle B 완료 → [`cycle_C_audit.md`](cycle_C_audit.md).
