# Cycle A · 묶음 2 — Slash commands (6 PR)

**묶음 ID:** A.2 (executor 4) + A.6 (Geny 2)
**Layer:** EXEC-CORE (registry / parser / 12 introspection 명령) + EXEC-INTERFACE (register API + path 주입) + SERVICE (Geny 전용 명령 + REST + UI)
**격차:** F.25 — claude-code 의 ~100 slash command 패턴
**의존성:** 없음 — 독립 진행 가능. 단 `/tasks` 명령은 P0.1 의 TaskListTool 의존.

---

# Part A — geny-executor (4 PR)

## PR-A.2.1 — feat(slash): SlashCommandRegistry + parser + types

### Metadata
- **Branch:** `feat/slash-command-registry`
- **Repo:** geny-executor
- **Layer:** EXEC-CORE + EXEC-INTERFACE
- **Depends on:** none
- **Consumed by:** A.2.2 / A.2.3 / A.2.4 / Geny A.6.1

### Files added

#### `geny_executor/slash_commands/__init__.py`

```python
from .registry import SlashCommandRegistry, get_default_registry
from .parser import parse_slash, ParsedSlash
from .types import SlashCommand, SlashContext, SlashResult, SlashCategory

__all__ = [
    "SlashCommandRegistry", "get_default_registry",
    "parse_slash", "ParsedSlash",
    "SlashCommand", "SlashContext", "SlashResult", "SlashCategory",
]
```

#### `geny_executor/slash_commands/types.py` (~80 lines)

```python
from __future__ import annotations
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional


class SlashCategory(str, Enum):
    INTROSPECTION = "introspection"   # /cost /clear /status /help /memory /context /tasks
    CONTROL       = "control"         # /cancel /compact /config /model /preset-info
    DOMAIN        = "domain"          # 서비스 전용 (e.g. /preset)


@dataclass
class SlashContext:
    """Runtime context passed to command handlers.
    All optional — handlers should defensively check.
    """
    pipeline: Optional[Any] = None        # geny_executor.core.pipeline.Pipeline
    session_state: Dict[str, Any] = field(default_factory=dict)
    user_id: Optional[str] = None
    extras: Dict[str, Any] = field(default_factory=dict)


@dataclass
class SlashResult:
    """Returned to the caller, rendered as system-message in the chat."""
    content: str                          # markdown OK
    success: bool = True
    metadata: Dict[str, Any] = field(default_factory=dict)
    follow_up_prompt: Optional[str] = None  # if non-None, sent to LLM next


class SlashCommand(ABC):
    """One slash command (e.g. /cost). Extend and register()."""
    name: str                             # without leading slash, e.g. "cost"
    description: str
    category: SlashCategory = SlashCategory.INTROSPECTION
    aliases: List[str] = []
    
    @abstractmethod
    async def execute(self, args: List[str], ctx: SlashContext) -> SlashResult: ...
```

#### `geny_executor/slash_commands/parser.py` (~70 lines)

```python
from __future__ import annotations
import shlex
from dataclasses import dataclass
from typing import List, Optional


@dataclass
class ParsedSlash:
    command: str           # "cost" (no leading slash)
    args: List[str]        # ["--detail", "session-1"]
    remaining_prompt: str  # "and then summarize"  ← LLM input 후속


def parse_slash(input_text: str) -> Optional[ParsedSlash]:
    """Detect slash command at the start of input_text.
    
    Examples:
      "/cost"                           → ParsedSlash("cost", [], "")
      "/cost --detail"                  → ParsedSlash("cost", ["--detail"], "")
      "/skill-foo arg1\nplease run"     → ParsedSlash("skill-foo", ["arg1"], "please run")
      "regular text"                    → None
    
    Rules:
    - 첫 char 가 '/' 이어야
    - 첫 줄까지 가 명령 (\n 이후는 remaining_prompt)
    - 명령 + args 는 shlex.split (quoted args 처리)
    - command name 은 [a-zA-Z0-9_-]+ 만 허용 (그 외는 None)
    """
    if not input_text or not input_text.lstrip().startswith("/"):
        return None
    text = input_text.lstrip()
    first_line, _, rest = text.partition("\n")
    parts = shlex.split(first_line[1:])  # strip leading slash
    if not parts:
        return None
    cmd = parts[0]
    if not _is_valid_command_name(cmd):
        return None
    return ParsedSlash(command=cmd, args=parts[1:], remaining_prompt=rest.lstrip())


def _is_valid_command_name(name: str) -> bool:
    import re
    return bool(re.fullmatch(r"[a-zA-Z][a-zA-Z0-9_-]*", name))
```

#### `geny_executor/slash_commands/registry.py` (~150 lines)

```python
from __future__ import annotations
import logging
from pathlib import Path
from typing import Dict, List, Optional, Type
from .types import SlashCommand, SlashCategory

logger = logging.getLogger(__name__)


class SlashCommandRegistry:
    """Registry with discovery hierarchy:
       built-in (executor) > register() (service) > project path > user path.
    
    Discovery from path:
      <path>/<command_name>.md   — markdown with frontmatter:
        ---
        description: short
        category: introspection|control|domain
        ---
        body (used as prompt template; first line of args replaces $ARG_1)
    """

    def __init__(self) -> None:
        self._commands: Dict[str, SlashCommand] = {}
        self._discovery_paths: List[Path] = []

    def register(self, cmd: SlashCommand) -> None:
        if cmd.name in self._commands:
            logger.warning("slash_command_overwritten", name=cmd.name)
        self._commands[cmd.name] = cmd
        for alias in cmd.aliases:
            self._commands[alias] = cmd

    def discover_paths(self, path: Path) -> int:
        """Add a directory of <cmd>.md files. Returns count loaded."""
        if not path.exists() or not path.is_dir():
            self._discovery_paths.append(path)
            return 0
        loaded = 0
        for md in path.glob("*.md"):
            cmd = _load_md_command(md)
            if cmd:
                self.register(cmd)
                loaded += 1
        self._discovery_paths.append(path)
        return loaded

    def resolve(self, name: str) -> Optional[SlashCommand]:
        return self._commands.get(name)

    def list_all(self) -> List[SlashCommand]:
        seen, out = set(), []
        for cmd in self._commands.values():
            if id(cmd) in seen: continue
            seen.add(id(cmd))
            out.append(cmd)
        return sorted(out, key=lambda c: c.name)

    def list_by_category(self, category: SlashCategory) -> List[SlashCommand]:
        return [c for c in self.list_all() if c.category == category]


_DEFAULT: Optional[SlashCommandRegistry] = None

def get_default_registry() -> SlashCommandRegistry:
    """Process-singleton. Fresh registry can be created for testing."""
    global _DEFAULT
    if _DEFAULT is None:
        _DEFAULT = SlashCommandRegistry()
        _install_built_ins(_DEFAULT)  # 별도 함수, A.2.2 / A.2.3 에서 채움
    return _DEFAULT


def _install_built_ins(reg: SlashCommandRegistry) -> None:
    """Imported by tests; PR-A.2.2 / A.2.3 에서 명령 등록."""
    pass


def _load_md_command(md: Path) -> Optional[SlashCommand]:
    """Markdown frontmatter → MdTemplateCommand. (impl detail)"""
    ...
```

### Tests added

`tests/slash_commands/test_parser.py`

- `test_parse_slash_simple` (`"/cost"` → ParsedSlash)
- `test_parse_slash_with_args`
- `test_parse_slash_with_remaining_prompt`
- `test_parse_slash_quoted_args`
- `test_parse_slash_returns_none_for_non_slash`
- `test_parse_slash_returns_none_for_empty`
- `test_parse_slash_invalid_command_name`
- `test_parse_slash_strips_leading_whitespace`

`tests/slash_commands/test_registry.py`

- `test_register_then_resolve`
- `test_register_overwrite_warns`
- `test_aliases_resolvable`
- `test_discover_paths_loads_md_files`
- `test_discover_paths_missing_dir_no_error`
- `test_list_by_category`
- `test_default_registry_is_singleton`

### Acceptance criteria
- [ ] `from geny_executor.slash_commands import SlashCommandRegistry, parse_slash` 가능
- [ ] 15 test pass
- [ ] line coverage ≥ 90%
- [ ] CHANGELOG.md 1.1.0: "Add SlashCommandRegistry + parser"

### Risk / mitigation
| Risk | Mitigation |
|---|---|
| md frontmatter 파싱 실수 | PyYAML safe_load + try/except + warning |
| Discovery path 의 보안 (임의 md 실행) | MdTemplateCommand 는 prompt template only, 코드 실행 X |

---

## PR-A.2.2 — feat(slash): 6 introspection commands (/cost /clear /status /help /memory /context)

### Metadata
- **Branch:** `feat/slash-introspection-commands`
- **Repo:** geny-executor
- **Layer:** EXEC-CORE
- **Depends on:** PR-A.2.1
- **Consumed by:** Geny A.6.2 (CommandTab 자동완성에 표시)

### Files added

#### `geny_executor/slash_commands/built_in/cost.py` (~50 lines)

```python
from ..types import SlashCommand, SlashContext, SlashResult, SlashCategory


class CostCommand(SlashCommand):
    name = "cost"
    description = "Show current session token usage and estimated cost."
    category = SlashCategory.INTROSPECTION

    async def execute(self, args, ctx):
        if ctx.pipeline is None:
            return SlashResult(content="No active pipeline.", success=False)
        accountant = ctx.pipeline.get_strategy("token_accountant")
        if not accountant:
            return SlashResult(content="Token accountant not available.", success=False)
        snapshot = accountant.snapshot()
        body = (
            f"**Session cost**\n\n"
            f"- Input tokens: {snapshot.input_tokens:,}\n"
            f"- Output tokens: {snapshot.output_tokens:,}\n"
            f"- Cached input: {snapshot.cached_input_tokens:,}\n"
            f"- Estimated USD: ${snapshot.estimated_usd:.4f}\n"
        )
        return SlashResult(content=body)
```

#### `geny_executor/slash_commands/built_in/clear.py` (~40 lines)

```python
class ClearCommand(SlashCommand):
    name = "clear"
    description = "Clear message history (preserves session). New messages start fresh."
    category = SlashCategory.CONTROL

    async def execute(self, args, ctx):
        if ctx.pipeline is None:
            return SlashResult(content="No active pipeline.", success=False)
        history = ctx.pipeline.get_strategy("history_provider")
        if not history:
            return SlashResult(content="No history provider.", success=False)
        await history.clear()
        return SlashResult(content="✓ Cleared message history.")
```

#### `geny_executor/slash_commands/built_in/status.py` (~70 lines)

```python
class StatusCommand(SlashCommand):
    name = "status"
    description = "Dump session info: model / preset / active strategies / open tasks."
    category = SlashCategory.INTROSPECTION

    async def execute(self, args, ctx):
        if ctx.pipeline is None:
            return SlashResult(content="No active pipeline.", success=False)
        manifest = ctx.pipeline.manifest
        active = manifest.active_strategies()
        body = (
            f"**Session status**\n\n"
            f"- Preset: `{manifest.preset_name}`\n"
            f"- Model: `{manifest.model}`\n"
            f"- Active strategies: {len(active)} ({', '.join(s.slot_name for s in active[:5])}...)\n"
        )
        return SlashResult(content=body)
```

#### `geny_executor/slash_commands/built_in/help.py` (~50 lines)

```python
class HelpCommand(SlashCommand):
    name = "help"
    description = "List all available slash commands."
    category = SlashCategory.INTROSPECTION

    async def execute(self, args, ctx):
        from ..registry import get_default_registry
        reg = get_default_registry()
        all_cmds = reg.list_all()
        lines = ["**Available slash commands**\n"]
        for cat in SlashCategory:
            cmds = [c for c in all_cmds if c.category == cat]
            if not cmds: continue
            lines.append(f"\n**{cat.value}**\n")
            for c in cmds:
                lines.append(f"- `/{c.name}` — {c.description}")
        return SlashResult(content="\n".join(lines))
```

#### `geny_executor/slash_commands/built_in/memory.py` (~50 lines)

```python
class MemoryCommand(SlashCommand):
    name = "memory"
    description = "Show recent memory notes from the active memory provider."
    category = SlashCategory.INTROSPECTION

    async def execute(self, args, ctx):
        if ctx.pipeline is None:
            return SlashResult(content="No active pipeline.", success=False)
        memory = ctx.pipeline.get_strategy("memory_provider")
        if not memory:
            return SlashResult(content="No memory provider configured.")
        notes = await memory.recent(limit=10)
        if not notes:
            return SlashResult(content="No memory notes.")
        body = "**Recent memory**\n\n" + "\n".join(f"- {n.summary}" for n in notes)
        return SlashResult(content=body)
```

#### `geny_executor/slash_commands/built_in/context.py` (~60 lines)

```python
class ContextCommand(SlashCommand):
    name = "context"
    description = "Show files currently loaded by the context loader."
    category = SlashCategory.INTROSPECTION

    async def execute(self, args, ctx):
        if ctx.pipeline is None:
            return SlashResult(content="No active pipeline.", success=False)
        loader = ctx.pipeline.get_strategy("context_loader")
        if not loader:
            return SlashResult(content="No context loader.")
        loaded = loader.last_loaded_paths()
        if not loaded:
            return SlashResult(content="No context files loaded.")
        body = "**Context files**\n\n" + "\n".join(f"- `{p}`" for p in loaded)
        return SlashResult(content=body)
```

### Files modified

- `geny_executor/slash_commands/registry.py` — `_install_built_ins(reg)` 에 6 명령 register.
- `geny_executor/slash_commands/built_in/__init__.py` — re-export.

### Tests added

`tests/slash_commands/built_in/test_cost.py` ~ `test_context.py` (6 파일)

각 파일에 4-5 test:
- happy path (mock pipeline + strategy)
- "no pipeline" → success=False
- "strategy not present" → graceful message
- formatting check (markdown valid)

### Acceptance criteria
- [ ] 6 명령 register
- [ ] 24 test pass
- [ ] line coverage ≥ 85%
- [ ] CHANGELOG.md 1.1.0: "Add 6 introspection slash commands"

---

## PR-A.2.3 — feat(slash): 6 control commands (/tasks /cancel /compact /config /model /preset-info)

### Metadata
- **Branch:** `feat/slash-control-commands`
- **Repo:** geny-executor
- **Layer:** EXEC-CORE
- **Depends on:** PR-A.2.1, PR-A.1.5 (TaskListTool)

### Files added

`geny_executor/slash_commands/built_in/tasks.py` ~ `preset_info.py` (6 파일)

각 ~50-80 lines, 동일 패턴.

핵심:
- `TasksCommand` — TaskListTool 의 결과 요약. `/tasks running` 같은 filter arg.
- `CancelCommand` — pipeline.stop() 호출. 결과 system-message.
- `CompactCommand` — Stage 19 의 manual trigger. summarize_strategy.execute().
- `ConfigCommand` — manifest active strategies dump (config.dump()).
- `ModelCommand` — `args[0]` 로 model 변경 (session 단위 — pipeline.set_model).
- `PresetInfoCommand` — manifest.preset_name + manifest.preset_metadata. 변경 X (`/preset` 은 Geny 가 register).

### Tests added

`tests/slash_commands/built_in/test_tasks.py` ~ `test_preset_info.py` (6 파일)

각 4-5 test. 총 ~28 test.

### Acceptance criteria
- [ ] 6 명령 register
- [ ] 28 test pass
- [ ] CHANGELOG.md 1.1.0: "Add 6 control slash commands"

### Risk / mitigation
| Risk | Mitigation |
|---|---|
| `/cancel` race | Stage 의 stop() 이 idempotent (이미 G2.5 패턴) |
| `/model` 가 invalid model name → exception | 사전 validate (claude-* 또는 known list) |

---

## PR-A.2.4 — feat(slash): project / user discovery path API + md template loader

### Metadata
- **Branch:** `feat/slash-discovery-paths`
- **Repo:** geny-executor
- **Layer:** EXEC-INTERFACE + EXEC-CORE (md template runtime)
- **Depends on:** PR-A.2.1

### Files added

#### `geny_executor/slash_commands/md_template.py` (~120 lines)

```python
class MdTemplateCommand(SlashCommand):
    """Slash command loaded from a markdown file with frontmatter.
    
    File format:
      ---
      description: <one-line>
      category: introspection|control|domain
      ---
      body (used as prompt template; $ARG_1 $ARG_2 ... replaced)
    
    On execute: returns SlashResult with follow_up_prompt = body 변환.
    """

    def __init__(self, name: str, source_path: Path, description: str,
                 category: SlashCategory, body_template: str):
        self.name = name
        self.description = description
        self.category = category
        self._source = source_path
        self._template = body_template

    async def execute(self, args, ctx):
        body = self._template
        for i, arg in enumerate(args, start=1):
            body = body.replace(f"$ARG_{i}", arg)
        body = body.replace("$ARGS", " ".join(args))
        return SlashResult(
            content=f"_Running command from `{self._source.name}`_",
            follow_up_prompt=body,
        )
```

### Files modified

- `geny_executor/slash_commands/registry.py` — `_load_md_command(md: Path)` 가 frontmatter 파싱 + `MdTemplateCommand` 생성.

### Tests added

`tests/slash_commands/test_md_template.py`

- `test_md_template_args_substitution`
- `test_md_template_args_glob`
- `test_md_template_no_args`
- `test_md_template_unknown_arg_position_left_intact`

`tests/slash_commands/test_discover_paths.py`

- `test_discover_loads_multiple_md`
- `test_discover_skips_invalid_frontmatter`
- `test_discover_priority_path_order`
- `test_discover_idempotent_reregister`

### Acceptance criteria
- [ ] MdTemplateCommand 동작
- [ ] 8 test pass
- [ ] line coverage ≥ 85%
- [ ] CHANGELOG.md 1.1.0: "Add slash command discovery from markdown templates"

### Risk / mitigation
| Risk | Mitigation |
|---|---|
| md frontmatter 의 임의 코드 실행 | safe_load + executor 가 명령 실행 안 함 (LLM 에 prompt 전달만) |
| 큰 markdown 파일 → memory | 1 file 최대 64KB 제한 |

---

# Part B — Geny (2 PR)

## PR-A.6.1 — feat(service): SlashCommandRegistry register Geny 명령 + path 주입

### Metadata
- **Branch:** `feat/geny-slash-commands`
- **Repo:** Geny
- **Layer:** SERVICE
- **Depends on:** PR-A.5.0 (executor 1.1.0)

### Files added

#### `backend/service/slash_commands/__init__.py`
#### `backend/service/slash_commands/install.py` (~80 lines)

```python
from pathlib import Path
from geny_executor.slash_commands import get_default_registry
from .commands.preset import PresetCommand
from .commands.skill_dispatch import SkillDispatchCommand


def install_geny_slash_commands(session_manager):
    reg = get_default_registry()
    
    # Service-specific commands
    reg.register(PresetCommand(session_manager=session_manager))
    reg.register(SkillDispatchCommand())
    
    # Discovery paths (lower priority than register())
    reg.discover_paths(Path("~/.geny/commands/").expanduser())
    reg.discover_paths(Path(".geny/commands/"))
```

#### `backend/service/slash_commands/commands/preset.py` (~70 lines)

```python
class PresetCommand(SlashCommand):
    name = "preset"
    description = "Switch session preset (worker_adaptive | vtuber). Usage: /preset <name>"
    category = SlashCategory.DOMAIN

    def __init__(self, session_manager):
        self._mgr = session_manager

    async def execute(self, args, ctx):
        if not args:
            current = self._mgr.current_preset(ctx.user_id)
            return SlashResult(content=f"Current preset: `{current}`. Usage: /preset <name>")
        new_preset = args[0]
        if new_preset not in {"worker_adaptive", "vtuber"}:
            return SlashResult(content=f"Unknown preset: {new_preset}", success=False)
        await self._mgr.switch_preset(ctx.user_id, new_preset)
        return SlashResult(content=f"✓ Switched to preset: `{new_preset}`")
```

#### `backend/service/slash_commands/commands/skill_dispatch.py` (~80 lines)

```python
class SkillDispatchCommand(SlashCommand):
    """Catches /<skill_id> patterns. Registered via aliases at install time
    after listing all bundled + user skills.
    
    Note: aliases bound dynamically — install loops over list_skills() and
    creates one alias per skill_id.
    """

    name = "skill"
    description = "Dispatch a skill by id. Usage: /skill-id <args>"
    category = SlashCategory.DOMAIN

    async def execute(self, args, ctx):
        # The actual dispatch is handled by SkillTool; this is just a UX note.
        return SlashResult(
            content=f"`/skill <id>` dispatches to SkillTool. Use the SkillPanel for the list.",
        )
```

> Note: real `/skill-<id>` 동작은 frontend (CommandTab) 에서 prefix 검출 + tool_use 변환. 본 명령은 alias 등록 + help 출력 용도.

### Files modified

- `backend/main.py` — lifespan 시작 시 `install_geny_slash_commands(session_manager)` 호출.

### Tests added

`backend/tests/service/slash_commands/test_install.py`

- `test_install_registers_preset_and_skill_dispatch`
- `test_install_discovers_user_path` (tmp HOME)
- `test_install_idempotent`

`backend/tests/service/slash_commands/commands/test_preset.py`

- `test_preset_no_args_shows_current`
- `test_preset_switches_via_session_manager`
- `test_preset_unknown_returns_error`

### Acceptance criteria
- [ ] `/preset` 등록 + 동작
- [ ] `~/.geny/commands/` 에 `.md` 추가 → registry 에 자동 등장
- [ ] 6 test pass

---

## PR-A.6.2 — feat: /api/slash-commands endpoint + CommandTab 자동완성

### Metadata
- **Branch:** `feat/slash-commands-endpoint`
- **Repo:** Geny
- **Layer:** SERVICE
- **Depends on:** PR-A.6.1

### Files added

#### `backend/controller/slash_command_controller.py` (~120 lines)

```python
router = APIRouter(prefix="/api/slash-commands", tags=["slash-commands"])

class SlashCommandSummary(BaseModel):
    name: str
    description: str
    category: str
    aliases: List[str]

class SlashListResponse(BaseModel):
    commands: List[SlashCommandSummary]

class SlashExecuteRequest(BaseModel):
    input_text: str   # full input including '/'
    
class SlashExecuteResponse(BaseModel):
    matched: bool
    content: Optional[str]
    success: bool
    follow_up_prompt: Optional[str]


@router.get("/", response_model=SlashListResponse)
async def list_slash_commands(_auth=Depends(require_auth)):
    reg = get_default_registry()
    return SlashListResponse(commands=[
        SlashCommandSummary(
            name=c.name, description=c.description,
            category=c.category.value, aliases=c.aliases,
        ) for c in reg.list_all()
    ])


@router.post("/execute", response_model=SlashExecuteResponse)
async def execute_slash(
    body: SlashExecuteRequest,
    request: Request,
    user=Depends(require_auth),
):
    parsed = parse_slash(body.input_text)
    if not parsed:
        return SlashExecuteResponse(matched=False, content=None, success=False, follow_up_prompt=None)
    reg = get_default_registry()
    cmd = reg.resolve(parsed.command)
    if not cmd:
        return SlashExecuteResponse(matched=False, content=f"Unknown: /{parsed.command}", success=False, follow_up_prompt=None)
    pipeline = await _resolve_active_pipeline(request, user)
    ctx = SlashContext(pipeline=pipeline, user_id=user["id"])
    result = await cmd.execute(parsed.args, ctx)
    return SlashExecuteResponse(
        matched=True, content=result.content, success=result.success,
        follow_up_prompt=result.follow_up_prompt,
    )
```

### Files modified

- `frontend/src/components/tabs/CommandTab.tsx`:
  - textarea onChange — `/` prefix 검출
  - 자동완성 dropdown — `/api/slash-commands/` 결과 caching (60s)
  - submit 시 `/api/slash-commands/execute` 호출 → 결과 system-message 로 timeline 추가
  - follow_up_prompt 가 있으면 textarea 채워넣고 submit
- `frontend/src/api/slashCommands.ts` (신규)

### Tests added

`backend/tests/controller/test_slash_commands.py`

- `test_list_returns_all_commands`
- `test_list_requires_auth`
- `test_execute_unknown_returns_matched_false`
- `test_execute_dispatches_to_handler`
- `test_execute_propagates_follow_up_prompt`

### Acceptance criteria
- [ ] 2 endpoint auth required
- [ ] 5 test pass
- [ ] CommandTab 의 `/` prefix 자동완성 동작 (manual smoke)
- [ ] follow_up_prompt 가 있는 명령 → textarea 자동 채워짐

### Risk / mitigation
| Risk | Mitigation |
|---|---|
| `/api/slash-commands/execute` 가 LLM bypass → security | command 자체 가 권한 가드 적용 (user_id 기반) |
| 자동완성 dropdown 의 race | abortController 사용 |

---

## 묶음 2 의 PR 합계 + 의존성 요약

| PR | Repo | 의존 | 누가 consume |
|---|---|---|---|
| PR-A.2.1 | executor | — | A.2.2, A.2.3, A.2.4, Geny A.6.1 |
| PR-A.2.2 | executor | A.2.1 | (사용자가 /cost 등 호출) |
| PR-A.2.3 | executor | A.2.1, A.1.5 | (사용자) |
| PR-A.2.4 | executor | A.2.1 | Geny A.6.1 (path 주입) |
| PR-A.6.1 | Geny | A.5.0 | A.6.2 |
| PR-A.6.2 | Geny | A.6.1 | (frontend) |

총 6 PR.

---

## 다음 묶음

[`cycle_A_p0_3_tools.md`](cycle_A_p0_3_tools.md) — Tool catalog 9 PR
