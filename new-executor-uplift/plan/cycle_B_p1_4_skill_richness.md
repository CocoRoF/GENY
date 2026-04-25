# Cycle B · 묶음 4 — Skill 시스템 폼 풍부화 (4 PR)

**묶음 ID:** B.4
**Layer:** EXEC-CORE (SKILL.md schema 확장 + forked execution + MCP→skill 자동 변환) + SERVICE (bundled skill frontmatter 갱신 + frontend 표시)
**격차:** D.12 / D.13 / D.15 — 8 frontmatter field / forked execution mode / MCP→skill 자동 변환

---

# Part A — geny-executor (3 PR)

## PR-B.4.1 — feat(skills): SKILL.md schema 확장 (category / examples / effort)

### Metadata
- **Branch:** `feat/skill-md-schema-richer`
- **Repo:** geny-executor
- **Layer:** EXEC-CORE

### Files modified

#### `geny_executor/skills/schema.py`

```python
class SkillMetadata(BaseModel):
    id: str
    name: Optional[str] = None
    description: Optional[str] = None
    version: Optional[str] = None
    model: Optional[str] = None
    execution_mode: str = "inline"   # inline | forked
    allowed_tools: List[str] = []
    
    # NEW (B.4.1)
    category: Optional[str] = None              # "code" | "writing" | "data" | "agent"
    examples: List[SkillExample] = []
    effort: Optional[str] = None                # "low" | "medium" | "high"
    permissions: List[PermissionRule] = []      # skill 자체의 권한 요구사항
    
    extras: Dict[str, Any] = {}


class SkillExample(BaseModel):
    description: str
    user_input: str
    expected_outcome: Optional[str] = None
```

#### `geny_executor/skills/loader.py`

frontmatter parser 가 새 field 무시 X — 정확히 받아서 `SkillMetadata.examples` 에 list of dict.

### Tests added

`tests/skills/test_schema_richer.py`

- `test_loads_category_field`
- `test_loads_examples_list`
- `test_loads_effort_field`
- `test_loads_permissions_list`
- `test_backward_compat_old_skill_md_still_works` (없는 field 모두 None/빈 list)
- `test_invalid_category_passes_through` (validation X — 자유 string)
- `test_examples_with_only_user_input`

### Acceptance criteria
- [ ] 4 새 field 인식
- [ ] 7 test pass
- [ ] 기존 SKILL.md 모두 여전히 load OK
- [ ] CHANGELOG.md 1.2.0: "Extend SKILL.md schema with category/examples/effort/permissions"

---

## PR-B.4.2 — feat(skills): execution_mode `forked` impl (subprocess 격리)

### Metadata
- **Branch:** `feat/skill-execution-forked`
- **Repo:** geny-executor
- **Layer:** EXEC-CORE

### 동작 모델

```
SkillTool 호출 (execution_mode=forked):
  1. subprocess 시작 (python -m geny_executor.skills.fork_runner)
  2. parent → fork: skill_id + input + 필요 context (json)
  3. fork: SkillTool 실행 (own pipeline / own state)
  4. fork → parent: result (json)
  5. parent: tool_result 반환

격리:
  - fork 의 prompt cache, token accounting 은 parent 와 분리
  - fork 의 hook / permission 은 parent 와 동일 manifest 사용 (clone)
  - fork 가 panic 해도 parent 는 살아남음
```

### Files added

#### `geny_executor/skills/fork_runner.py` (~150 lines)

```python
"""Subprocess entry point for forked skill execution.

Invoked as:
  python -m geny_executor.skills.fork_runner

Reads JSON request from stdin, writes JSON response to stdout.
Logs to stderr.
"""

import asyncio
import json
import sys
from typing import Any, Dict


async def main():
    request = json.loads(sys.stdin.read())
    skill_id = request["skill_id"]
    input_data = request["input"]
    manifest_dict = request["manifest"]
    
    from geny_executor.core.pipeline import Pipeline
    from geny_executor.skills import get_default_registry
    
    pipeline = Pipeline.from_manifest_dict(manifest_dict)
    skill = get_default_registry().resolve(skill_id)
    if not skill:
        json.dump({"error": f"unknown_skill:{skill_id}"}, sys.stdout)
        return
    
    result = await skill.execute(input_data, pipeline.tool_context())
    json.dump({"ok": True, "result": result.to_dict()}, sys.stdout)


if __name__ == "__main__":
    asyncio.run(main())
```

#### `geny_executor/skills/skill_tool.py` (수정)

```python
class SkillTool(Tool):
    async def execute(self, input_data, ctx):
        skill = get_default_registry().resolve(self.skill_id)
        if not skill: return ToolResult.error(...)
        if skill.metadata.execution_mode == "forked":
            return await self._execute_forked(skill, input_data, ctx)
        return await self._execute_inline(skill, input_data, ctx)
    
    async def _execute_forked(self, skill, input_data, ctx) -> ToolResult:
        manifest = ctx.pipeline.manifest.to_dict()
        request = {
            "skill_id": skill.id, "input": input_data, "manifest": manifest,
        }
        proc = await asyncio.create_subprocess_exec(
            sys.executable, "-m", "geny_executor.skills.fork_runner",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await proc.communicate(json.dumps(request).encode())
        if proc.returncode != 0:
            return ToolResult.error(f"fork_failed: {stderr.decode()[:500]}")
        try:
            response = json.loads(stdout.decode())
        except json.JSONDecodeError:
            return ToolResult.error("fork_invalid_response")
        if response.get("error"):
            return ToolResult.error(response["error"])
        return ToolResult.from_dict(response["result"])
```

### Tests added

`tests/skills/test_fork_runner.py`

- `test_fork_executes_inline_skill_isolated` (subprocess 실제 띄움)
- `test_fork_propagates_skill_error`
- `test_fork_invalid_request_writes_error`
- `test_fork_unknown_skill_id_returns_error`

`tests/skills/test_skill_tool_forked.py`

- `test_skill_tool_forked_mode_calls_subprocess`
- `test_skill_tool_inline_mode_unchanged`
- `test_skill_tool_forked_propagates_result`
- `test_skill_tool_forked_handles_subprocess_crash`

### Acceptance criteria
- [ ] forked execution 동작
- [ ] 8 test pass (실 subprocess 포함)
- [ ] inline mode 회귀 0
- [ ] CHANGELOG.md 1.2.0: "Add forked execution mode for SKILL.md skills"

### Risk / mitigation
| Risk | Mitigation |
|---|---|
| subprocess 누적 → resource leak | timeout (default 60s) + proc.kill on timeout |
| stdout pollution (skill 이 print) | fork_runner 가 stderr 로 전부 redirect |
| manifest 직렬화 실패 | manifest.to_dict 가 모든 strategy 의 serializable check |

---

## PR-B.4.3 — feat(skills): MCP→skill 자동 변환 loader

### Metadata
- **Branch:** `feat/mcp-to-skill-auto-loader`
- **Repo:** geny-executor
- **Layer:** EXEC-CORE

### 동작 모델

```
MCP server 의 prompts / templates 는 SKILL.md 에 거의 1:1 대응.
MCP server 가 prompts 를 expose 하면 자동으로 SkillRegistry 에 등록:
  - skill.id = "mcp__<server>__<prompt_name>"
  - skill.metadata.description = MCP prompt.description
  - skill.metadata.allowed_tools = ["MCP"]   (MCPTool 활용)
  - skill.execute(input) → MCPTool 호출
```

### Files added

#### `geny_executor/skills/mcp_loader.py` (~150 lines)

```python
class MCPSkillAdapter(Skill):
    """Skill that wraps an MCP prompt."""
    def __init__(self, server_name: str, prompt_name: str, prompt_metadata: Dict):
        self.id = f"mcp__{server_name}__{prompt_name}"
        self.metadata = SkillMetadata(
            id=self.id,
            name=prompt_metadata.get("name") or prompt_name,
            description=prompt_metadata.get("description"),
            allowed_tools=["MCP"],
            execution_mode="inline",
            extras={"mcp_server": server_name, "mcp_prompt": prompt_name},
        )
        self._server = server_name
        self._prompt = prompt_name

    async def execute(self, input_data, ctx):
        mcp = ctx.get_strategy("mcp_manager")
        # MCP prompt 호출 → 그 결과를 LLM 에 system prompt 로 inject
        result = await mcp.get_prompt(server_name=self._server, prompt_name=self._prompt, arguments=input_data)
        return SkillResult.ok(result)


async def load_mcp_skills_into(registry: SkillRegistry, mcp_manager: MCPManager) -> int:
    """Iterate all MCP servers, register each prompt as a Skill."""
    loaded = 0
    for server in mcp_manager.list_servers():
        try:
            prompts = await mcp_manager.list_prompts(server.name)
        except Exception as e:
            logger.warning("mcp_list_prompts_failed", server=server.name, error=str(e))
            continue
        for p in prompts:
            adapter = MCPSkillAdapter(server.name, p["name"], p)
            registry.register(adapter)
            loaded += 1
    return loaded
```

### Files modified

- `geny_executor/skills/__init__.py` — re-export `MCPSkillAdapter`, `load_mcp_skills_into`

### Tests added

`tests/skills/test_mcp_loader.py`

- `test_load_mcp_skills_registers_each_prompt` (mock MCPManager)
- `test_load_handles_server_error_gracefully`
- `test_skill_id_format`
- `test_execute_calls_mcp_get_prompt`
- `test_idempotent_reload_no_duplicate`

### Acceptance criteria
- [ ] MCPSkillAdapter ship
- [ ] 5 test pass
- [ ] CHANGELOG.md 1.2.0: "Add MCP→Skill auto loader (mcp prompts as skills)"

---

# Part B — Geny (1 PR)

## PR-B.4.4 — feat: bundled skill 3종 frontmatter 갱신 + frontend 표시

### Metadata
- **Branch:** `feat/skill-richer-frontmatter`
- **Repo:** Geny
- **Layer:** SERVICE
- **Depends on:** PR-B.4.1 + Geny pyproject 1.2.0 bump

### Files modified

#### `backend/skills/bundled/<each_skill>/SKILL.md`

각 bundled skill (3종) frontmatter 에 새 field 추가:

```markdown
---
id: vtuber_chat
name: VTuber chat reply
description: Reply in VTuber persona using current memory context.
category: writing
effort: low
examples:
  - description: Greeting a viewer
    user_input: "Hi Geny!"
    expected_outcome: "Persona-aware greeting referencing recent stream"
allowed_tools: [memory_search, knowledge_search]
execution_mode: inline
---
... (body)
```

#### `frontend/src/components/SkillPanel.tsx`

새 field 노출:
- category badge
- effort indicator (●○○ / ●●○ / ●●●)
- examples → "Try" 버튼 (클릭 시 user_input 을 textarea 에 채움)

#### `frontend/src/types/skill.ts`

```typescript
export type Skill = {
  id: string;
  name: string;
  description: string;
  category?: string;
  effort?: 'low' | 'medium' | 'high';
  examples?: SkillExample[];
  // ...
};
```

#### `backend/controller/skills_controller.py`

`SkillSummary` model 에 새 field 추가:

```python
class SkillSummary(BaseModel):
    id: Optional[str]
    name: Optional[str]
    description: Optional[str]
    category: Optional[str] = None
    effort: Optional[str] = None
    examples: List[Dict[str, str]] = []
    model: Optional[str]
    allowed_tools: List[str] = []
```

### Tests added

`backend/tests/controller/test_skills_controller_richer.py`

- `test_summary_includes_category_field`
- `test_summary_includes_examples`
- `test_summary_handles_skill_without_new_fields` (backward compat)

### Acceptance criteria
- [ ] 3 bundled skill frontmatter 갱신
- [ ] /api/skills/list 응답에 새 field
- [ ] SkillPanel UI 가 새 field 표시
- [ ] 3 test pass
- [ ] manual smoke: SkillPanel 열면 category badge + effort 표시

---

## 묶음 합계

| PR | Repo | 의존 |
|---|---|---|
| PR-B.4.1 | executor | — |
| PR-B.4.2 | executor | — |
| PR-B.4.3 | executor | — |
| PR-B.4.4 | Geny | B.4.1 + Geny pyproject 1.2.0 |

총 4 PR. 다음: [`cycle_B_p1_5_plan_mode.md`](cycle_B_p1_5_plan_mode.md).
