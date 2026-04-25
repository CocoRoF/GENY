# Cycle A · 묶음 3 — Built-in tool catalog 확장 (9 PR)

**묶음 ID:** A.3 (executor 7) + A.7 (Geny 2)
**Layer:** EXEC-CORE (모든 새 tool) + EXEC-INTERFACE (notifications endpoint ABC, SendMessageChannel ABC, UserFileChannel ABC) + SERVICE (channel impl + settings 주입)
**격차:** A.2 의 14 HIGH/MED tool 중 P0.1 (AgentTool, Task* 6) / P0.4 (Cron* 3) 와 겹치지 않는 잔여 11 tool. (실제로는 묶음 단위로 7 PR.)
**의존성:** 없음 — A.1 / A.2 와 병렬 진행 가능. 단 P0.4 의 Cron 도 동일 catalog 라 cross-reference.

본 cycle 에 ship 하는 tool: **AskUserQuestion / PushNotification / MCPTool 4 / Worktree 2 / LSP / REPL / Brief / Config / Monitor / SendUserFile / SendMessage** = 14 tool.

---

# Part A — geny-executor (7 PR)

## PR-A.3.1 — feat(tools): AskUserQuestionTool

### Metadata
- **Branch:** `feat/ask-user-question-tool`
- **Repo:** geny-executor
- **Layer:** EXEC-CORE (HITL slot 활용)
- **Depends on:** none — Stage 15 (`s15_hitl`) 이미 ship.
- **Consumed by:** Geny PR-A.5.x (REST 가 user response 주입)

### 동작 모델

```
LLM tool_use (AskUserQuestion {"question": "Which file?", "options": ["a.py","b.py"]})
   ↓
Stage 15 HITL slot 가 awaiting_user_input 상태로 전환 + persist
   ↓
REST endpoint 가 SSE/long-poll 로 awaiting state 노출
   ↓
사용자가 응답 → endpoint 가 HITL slot 에 resolve(value)
   ↓
tool_result = value (LLM 의 다음 turn input)
```

### Files added

#### `geny_executor/tools/built_in/ask_user_question_tool.py` (~120 lines)

```python
class AskUserQuestionTool(Tool):
    name = "AskUserQuestion"
    description = (
        "Ask the user a question and wait for their response. "
        "Use sparingly; only when the answer is required to continue."
    )
    capabilities = ToolCapabilities(
        concurrency_safe=False,   # blocks on HITL
        destructive=False,
        latency_class="user",     # 분 단위 지연 가능
    )
    input_schema = {
        "type": "object",
        "required": ["question"],
        "properties": {
            "question": {"type": "string", "minLength": 1, "maxLength": 1000},
            "options": {"type": "array", "items": {"type": "string"}, "maxItems": 8},
            "default": {"type": "string"},
            "timeout_seconds": {"type": "integer", "minimum": 5, "maximum": 86400},
        },
    }

    async def execute(self, input_data, ctx):
        hitl = ctx.get_strategy("hitl_provider")
        if not hitl:
            return ToolResult.error("hitl_provider not active in this pipeline")
        prompt_id = str(uuid.uuid4())
        try:
            answer = await hitl.ask(
                prompt_id=prompt_id,
                question=input_data["question"],
                options=input_data.get("options"),
                default=input_data.get("default"),
                timeout_seconds=input_data.get("timeout_seconds", 600),
            )
        except asyncio.TimeoutError:
            return ToolResult.error("user_input_timeout")
        except HITLCancelled:
            return ToolResult.error("user_input_cancelled")
        return ToolResult.ok({"answer": answer, "prompt_id": prompt_id})
```

### Tests added

`tests/tools/built_in/test_ask_user_question_tool.py`

- `test_calls_hitl_ask_with_question`
- `test_returns_answer_on_resolve`
- `test_returns_error_on_timeout`
- `test_returns_error_on_cancel`
- `test_returns_error_when_hitl_not_active`
- `test_validates_options_max_items`

### Acceptance criteria
- [ ] AskUserQuestionTool 등록
- [ ] 6 test pass
- [ ] CHANGELOG.md 1.1.0: "Add AskUserQuestionTool built-in"

---

## PR-A.3.2 — feat(tools): PushNotificationTool + notifications settings section

### Metadata
- **Branch:** `feat/push-notification-tool`
- **Repo:** geny-executor
- **Layer:** EXEC-CORE + EXEC-INTERFACE (settings section schema)
- **Depends on:** none

### Files added

#### `geny_executor/tools/built_in/push_notification_tool.py` (~150 lines)

```python
class PushNotificationTool(Tool):
    name = "PushNotification"
    description = (
        "Send a notification to a configured webhook endpoint. "
        "Endpoints are registered via settings.notifications.endpoints."
    )
    capabilities = ToolCapabilities(
        concurrency_safe=True, destructive=False, requires_network=True,
    )
    input_schema = {
        "type": "object",
        "required": ["endpoint", "message"],
        "properties": {
            "endpoint": {"type": "string", "description": "Endpoint name registered in settings"},
            "message": {"type": "string", "minLength": 1, "maxLength": 2000},
            "title": {"type": "string"},
            "metadata": {"type": "object"},
        },
    }

    async def execute(self, input_data, ctx):
        endpoints = ctx.get_strategy("notification_endpoints")
        if not endpoints:
            return ToolResult.error("no notification_endpoints registered")
        ep = endpoints.get(input_data["endpoint"])
        if not ep:
            return ToolResult.error(f"unknown endpoint: {input_data['endpoint']}")
        payload = {
            "title": input_data.get("title", "Notification"),
            "message": input_data["message"],
            "metadata": input_data.get("metadata", {}),
        }
        async with httpx.AsyncClient(timeout=10.0) as client:
            try:
                resp = await client.post(ep.url, json=payload, headers=ep.headers or {})
                resp.raise_for_status()
            except httpx.HTTPError as e:
                return ToolResult.error(f"webhook_failed: {e}")
        return ToolResult.ok({"endpoint": input_data["endpoint"], "status": "sent"})
```

#### `geny_executor/notifications/__init__.py`
#### `geny_executor/notifications/registry.py` (~80 lines)

```python
@dataclass
class NotificationEndpoint:
    name: str
    url: str
    headers: Optional[Dict[str, str]] = None
    description: Optional[str] = None


class NotificationEndpointRegistry:
    """In-memory mapping name → NotificationEndpoint.
    Service registers endpoints at startup from settings.notifications.endpoints.
    """
    def __init__(self):
        self._endpoints: Dict[str, NotificationEndpoint] = {}
    
    def register(self, ep: NotificationEndpoint) -> None: ...
    def get(self, name: str) -> Optional[NotificationEndpoint]: ...
    def list(self) -> List[NotificationEndpoint]: ...
```

### Tests added

`tests/tools/built_in/test_push_notification_tool.py`

- `test_sends_webhook_with_payload` (httpx mock)
- `test_unknown_endpoint_returns_error`
- `test_no_registry_returns_error`
- `test_webhook_failure_returns_error`
- `test_validates_message_max_length`

`tests/notifications/test_registry.py`

- `test_register_then_get`
- `test_register_overwrites_with_warning`
- `test_list_returns_all`

### Acceptance criteria
- [ ] PushNotificationTool 등록
- [ ] NotificationEndpointRegistry 동작
- [ ] 8 test pass
- [ ] CHANGELOG.md 1.1.0: "Add PushNotificationTool + endpoint registry"

### Risk / mitigation
| Risk | Mitigation |
|---|---|
| webhook secret 누출 | headers 는 settings 에서만 주입, log 에 redact |
| 무한 retry → 폭주 | 단발 호출 (retry 는 caller 책임) |

---

## PR-A.3.3 — feat(tools): MCP wrapper 4 tools

### Metadata
- **Branch:** `feat/mcp-wrapper-tools`
- **Repo:** geny-executor
- **Layer:** EXEC-CORE
- **Depends on:** MCPManager (이미 ship)

### Files added

#### `geny_executor/tools/built_in/mcp_tool.py` (~150 lines)

```python
class MCPTool(Tool):
    name = "MCP"
    description = (
        "Call a tool exposed by an MCP server. Use ListMcpResources to discover."
    )
    capabilities = ToolCapabilities(concurrency_safe=True, requires_network=True)
    input_schema = {
        "type": "object",
        "required": ["server", "tool"],
        "properties": {
            "server": {"type": "string", "description": "MCP server name"},
            "tool": {"type": "string", "description": "Tool name on the server"},
            "arguments": {"type": "object", "description": "Tool arguments"},
        },
    }

    async def execute(self, input_data, ctx):
        mgr = ctx.get_strategy("mcp_manager")
        if not mgr:
            return ToolResult.error("mcp_manager not active")
        try:
            result = await mgr.call_tool(
                server_name=input_data["server"],
                tool_name=input_data["tool"],
                arguments=input_data.get("arguments", {}),
            )
        except MCPServerNotFound:
            return ToolResult.error(f"unknown server: {input_data['server']}")
        except MCPToolError as e:
            return ToolResult.error(f"mcp_tool_error: {e}")
        return ToolResult.ok(result)
```

#### `geny_executor/tools/built_in/list_mcp_resources_tool.py` (~80 lines)

```python
class ListMcpResourcesTool(Tool):
    name = "ListMcpResources"
    description = "List resources exposed by registered MCP servers."
    capabilities = ToolCapabilities(concurrency_safe=True)
    input_schema = {
        "type": "object",
        "properties": {
            "server": {"type": "string"},   # filter
            "kind": {"enum": ["tool", "resource", "prompt"]},
        },
    }

    async def execute(self, input_data, ctx):
        mgr = ctx.get_strategy("mcp_manager")
        ...
        return ToolResult.ok({
            "resources": [
                {"server": s, "kind": k, "name": n, "description": d}
                for ...
            ]
        })
```

#### `geny_executor/tools/built_in/read_mcp_resource_tool.py` (~70 lines)

```python
class ReadMcpResourceTool(Tool):
    name = "ReadMcpResource"
    description = "Read content of an MCP resource by uri (mcp://server/...)."
    ...

    async def execute(self, input_data, ctx):
        mgr = ctx.get_strategy("mcp_manager")
        content = await mgr.read_resource(uri=input_data["uri"])
        return ToolResult.ok({"content": content})
```

#### `geny_executor/tools/built_in/mcp_auth_tool.py` (~80 lines)

```python
class McpAuthTool(Tool):
    name = "McpAuth"
    description = "Trigger OAuth flow for an MCP server requiring auth."
    capabilities = ToolCapabilities(concurrency_safe=False)  # blocks on user
    input_schema = {
        "type": "object", "required": ["server"],
        "properties": {"server": {"type": "string"}},
    }

    async def execute(self, input_data, ctx):
        mgr = ctx.get_strategy("mcp_manager")
        oauth_status = await mgr.start_oauth(server_name=input_data["server"])
        return ToolResult.ok({
            "auth_url": oauth_status.url,
            "state": oauth_status.state,
            "instructions": "Visit auth_url and complete authorization.",
        })
```

### Files modified

- `geny_executor/tools/built_in/__init__.py` — 4 추가
- `geny_executor/mcp/manager.py` — `call_tool`, `read_resource`, `start_oauth` method 가 없으면 추가 (보통 존재)

### Tests added

`tests/tools/built_in/test_mcp_tool.py`, `test_list_mcp_resources_tool.py`, `test_read_mcp_resource_tool.py`, `test_mcp_auth_tool.py` (4 파일)

각 4-5 test. 총 ~17 test.

### Acceptance criteria
- [ ] 4 tool 등록
- [ ] 17 test pass
- [ ] CHANGELOG.md 1.1.0: "Add 4 MCP wrapper tools"

---

## PR-A.3.4 — feat(tools): Worktree 2 tools (EnterWorktree / ExitWorktree)

### Metadata
- **Branch:** `feat/worktree-tools`
- **Repo:** geny-executor
- **Layer:** EXEC-CORE
- **Depends on:** none — git CLI 의존만

### Files added

#### `geny_executor/tools/built_in/enter_worktree_tool.py` (~120 lines)

```python
class EnterWorktreeTool(Tool):
    name = "EnterWorktree"
    description = (
        "Create a git worktree for the given branch. Subsequent file ops "
        "in the same session resolve relative paths against the worktree."
    )
    capabilities = ToolCapabilities(
        concurrency_safe=False,   # changes session state
        destructive=False,        # creates dir, doesn't modify branch
        requires_filesystem=True,
    )
    input_schema = {
        "type": "object",
        "required": ["branch"],
        "properties": {
            "branch": {"type": "string"},
            "path": {"type": "string", "description": "Optional explicit path"},
            "base": {"type": "string", "description": "Base branch (default: current HEAD)"},
        },
    }

    async def execute(self, input_data, ctx):
        sandbox = ctx.get_strategy("sandbox")
        if not sandbox:
            return ToolResult.error("sandbox not active")
        # validate cwd is a git repo
        if not (Path(sandbox.cwd) / ".git").exists():
            return ToolResult.error("not a git repository")
        path = Path(input_data.get("path") or _default_worktree_path(input_data["branch"]))
        cmd = ["git", "worktree", "add"]
        if input_data.get("base"):
            cmd += ["-b", input_data["branch"], str(path), input_data["base"]]
        else:
            cmd += [str(path), input_data["branch"]]
        proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await proc.communicate()
        if proc.returncode != 0:
            return ToolResult.error(f"git_worktree_failed: {stderr.decode()[:500]}")
        # session state: 새 worktree path 를 sandbox.scoped_cwd 로 push
        sandbox.push_scope(path)
        return ToolResult.ok({
            "worktree_path": str(path),
            "branch": input_data["branch"],
        })
```

#### `geny_executor/tools/built_in/exit_worktree_tool.py` (~80 lines)

```python
class ExitWorktreeTool(Tool):
    name = "ExitWorktree"
    description = "Exit the current git worktree scope. Optional --remove deletes it."
    capabilities = ToolCapabilities(concurrency_safe=False, destructive=True)
    input_schema = {
        "type": "object",
        "properties": {"remove": {"type": "boolean", "default": False}},
    }

    async def execute(self, input_data, ctx):
        sandbox = ctx.get_strategy("sandbox")
        path = sandbox.pop_scope()
        if not path:
            return ToolResult.error("not currently in a worktree scope")
        if input_data.get("remove", False):
            proc = await asyncio.create_subprocess_exec(
                "git", "worktree", "remove", str(path),
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            )
            await proc.communicate()
        return ToolResult.ok({"exited": str(path)})
```

### Tests added

`tests/tools/built_in/test_enter_worktree_tool.py`

- `test_creates_worktree_for_existing_branch` (tmp git repo fixture)
- `test_creates_worktree_with_new_branch`
- `test_fails_in_non_git_directory`
- `test_pushes_sandbox_scope`

`tests/tools/built_in/test_exit_worktree_tool.py`

- `test_pops_scope_without_remove`
- `test_pops_scope_with_remove`
- `test_fails_when_no_scope_pushed`

### Acceptance criteria
- [ ] 2 tool 등록
- [ ] 7 test pass (git fixture 포함)
- [ ] CHANGELOG.md 1.1.0: "Add Enter/Exit Worktree tools"

### Risk / mitigation
| Risk | Mitigation |
|---|---|
| process cwd 변경 → 다른 session 영향 | sandbox.scoped_cwd 만 변경, os.chdir X |
| worktree 누적 → disk 폭주 | exit 시 remove 권장, 사용자 책임 |

---

## PR-A.3.5 — feat(tools): LSP / REPL / Brief tools

### Metadata
- **Branch:** `feat/lsp-repl-brief-tools`
- **Repo:** geny-executor
- **Layer:** EXEC-CORE
- **Depends on:** none

### Files added

#### `geny_executor/tools/built_in/lsp_tool.py` (~200 lines)

```python
class LSPTool(Tool):
    name = "LSP"
    description = (
        "Query a language server for diagnostics / hover / definition. "
        "Supported: pyright, tsc, rust-analyzer."
    )
    capabilities = ToolCapabilities(concurrency_safe=True, requires_filesystem=True)
    input_schema = {
        "type": "object",
        "required": ["language", "action", "file"],
        "properties": {
            "language": {"enum": ["python", "typescript", "rust"]},
            "action": {"enum": ["diagnostics", "hover", "definition", "references"]},
            "file": {"type": "string"},
            "line": {"type": "integer"},
            "col": {"type": "integer"},
        },
    }

    async def execute(self, input_data, ctx):
        adapter = _ADAPTERS.get(input_data["language"])
        if not adapter:
            return ToolResult.error(f"unsupported_language: {input_data['language']}")
        # adapter 가 stdio LSP 클라이언트 / CLI wrapper 결정
        result = await adapter.run(
            action=input_data["action"],
            file=input_data["file"],
            line=input_data.get("line", 0),
            col=input_data.get("col", 0),
            cwd=ctx.get_strategy("sandbox").cwd,
        )
        return ToolResult.ok(result)
```

#### `geny_executor/tools/built_in/repl_tool.py` (~120 lines)

```python
class REPLTool(Tool):
    name = "REPL"
    description = "Execute a python expression in a sandboxed subprocess."
    capabilities = ToolCapabilities(concurrency_safe=True, destructive=False)
    input_schema = {
        "type": "object", "required": ["expression"],
        "properties": {
            "expression": {"type": "string", "maxLength": 8000},
            "timeout_seconds": {"type": "integer", "default": 5, "maximum": 60},
        },
    }

    async def execute(self, input_data, ctx):
        sandbox = ctx.get_strategy("sandbox")
        cmd = ["python", "-c", input_data["expression"]]
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd, cwd=sandbox.cwd,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                env=sandbox.scoped_env(),
            )
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(), timeout=input_data.get("timeout_seconds", 5),
            )
        except asyncio.TimeoutError:
            proc.kill()
            return ToolResult.error("repl_timeout")
        return ToolResult.ok({
            "stdout": stdout.decode(errors="replace")[:64_000],
            "stderr": stderr.decode(errors="replace")[:8_000],
            "exit_code": proc.returncode,
        })
```

#### `geny_executor/tools/built_in/brief_tool.py` (~70 lines)

```python
class BriefTool(Tool):
    name = "Brief"
    description = "Manually trigger context summarization (Stage 19)."
    capabilities = ToolCapabilities(concurrency_safe=False)
    input_schema = {
        "type": "object",
        "properties": {
            "scope": {"enum": ["all", "since_last_brief"], "default": "since_last_brief"},
        },
    }

    async def execute(self, input_data, ctx):
        summarizer = ctx.get_strategy("summarize_strategy")
        if not summarizer:
            return ToolResult.error("summarize_strategy not active")
        summary = await summarizer.summarize_now(scope=input_data.get("scope", "since_last_brief"))
        return ToolResult.ok({"summary": summary, "tokens_saved": summary.tokens_compressed})
```

### Tests added

`tests/tools/built_in/test_lsp_tool.py`, `test_repl_tool.py`, `test_brief_tool.py` (3 파일)

각 4-5 test. 총 ~13 test. LSP 는 fake adapter mock 으로 (실 LSP 띄우지 않음).

### Acceptance criteria
- [ ] 3 tool 등록
- [ ] 13 test pass
- [ ] CHANGELOG.md 1.1.0: "Add LSP / REPL / Brief tools"

---

## PR-A.3.6 — feat(tools): Config / Monitor / SendUserFile tools

### Metadata
- **Branch:** `feat/config-monitor-sendfile-tools`
- **Repo:** geny-executor
- **Layer:** EXEC-CORE + EXEC-INTERFACE (UserFileChannel ABC)

### Files added

#### `geny_executor/tools/built_in/config_tool.py` (~100 lines)

```python
class ConfigTool(Tool):
    name = "Config"
    description = "Inspect or mutate runtime configuration (active strategies / settings)."
    capabilities = ToolCapabilities(concurrency_safe=False, destructive=True)
    input_schema = {
        "type": "object", "required": ["action"],
        "properties": {
            "action": {"enum": ["get", "set", "list_active"]},
            "section": {"type": "string"},
            "key": {"type": "string"},
            "value": {"type": ["string", "number", "boolean", "object", "null"]},
        },
    }

    async def execute(self, input_data, ctx):
        if input_data["action"] == "list_active":
            mutator = ctx.get_strategy("pipeline_mutator")
            return ToolResult.ok({"active": mutator.list_active()})
        ...
```

#### `geny_executor/tools/built_in/monitor_tool.py` (~120 lines)

```python
class MonitorTool(Tool):
    name = "Monitor"
    description = "Subscribe to EventBus events for a duration; return collected events."
    capabilities = ToolCapabilities(concurrency_safe=True)
    input_schema = {
        "type": "object",
        "properties": {
            "events": {"type": "array", "items": {"type": "string"}},
            "duration_seconds": {"type": "integer", "default": 10, "maximum": 300},
            "max_events": {"type": "integer", "default": 100},
        },
    }

    async def execute(self, input_data, ctx):
        bus = ctx.get_strategy("event_bus")
        events = input_data.get("events") or [
            "stage_started", "stage_completed", "tool_executed",
        ]
        collected = []
        async with bus.subscribe(events) as stream:
            try:
                async for evt in asyncio.wait_for(_aiter(stream), timeout=input_data.get("duration_seconds", 10)):
                    collected.append({"type": evt.type, "ts": evt.ts.isoformat(), "data": evt.data})
                    if len(collected) >= input_data.get("max_events", 100):
                        break
            except asyncio.TimeoutError:
                pass
        return ToolResult.ok({"events": collected, "count": len(collected)})
```

#### `geny_executor/tools/built_in/send_user_file_tool.py` (~100 lines)

```python
class SendUserFileTool(Tool):
    name = "SendUserFile"
    description = (
        "Send a file to the user. The service-side UserFileChannel determines "
        "delivery (download URL / direct push)."
    )
    capabilities = ToolCapabilities(concurrency_safe=True, requires_filesystem=True)
    input_schema = {
        "type": "object", "required": ["file_path"],
        "properties": {
            "file_path": {"type": "string"},
            "filename": {"type": "string", "description": "Override display name"},
            "content_type": {"type": "string"},
            "description": {"type": "string"},
        },
    }

    async def execute(self, input_data, ctx):
        channel = ctx.get_strategy("user_file_channel")
        if not channel:
            return ToolResult.error("user_file_channel not configured")
        sandbox = ctx.get_strategy("sandbox")
        full_path = sandbox.resolve(input_data["file_path"])
        if not full_path.exists():
            return ToolResult.error("file_not_found")
        result = await channel.send(
            path=full_path,
            filename=input_data.get("filename") or full_path.name,
            content_type=input_data.get("content_type"),
            description=input_data.get("description"),
        )
        return ToolResult.ok(result)  # {"download_url": ..., "expires_at": ...}
```

#### `geny_executor/channels/__init__.py`
#### `geny_executor/channels/user_file_channel.py` (~50 lines)

```python
class UserFileChannel(ABC):
    @abstractmethod
    async def send(self, path: Path, filename: str,
                   content_type: Optional[str], description: Optional[str]) -> Dict[str, Any]: ...
```

### Tests added

`tests/tools/built_in/test_config_tool.py`, `test_monitor_tool.py`, `test_send_user_file_tool.py`

각 4-5 test. 총 ~14 test.

### Acceptance criteria
- [ ] 3 tool + UserFileChannel ABC ship
- [ ] 14 test pass
- [ ] CHANGELOG.md 1.1.0: "Add Config / Monitor / SendUserFile tools"

---

## PR-A.3.7 — feat(tools): SendMessageTool ABC + reference channel

### Metadata
- **Branch:** `feat/send-message-tool`
- **Repo:** geny-executor
- **Layer:** EXEC-CORE + EXEC-INTERFACE

### Files added

#### `geny_executor/tools/built_in/send_message_tool.py` (~100 lines)

```python
class SendMessageTool(Tool):
    name = "SendMessage"
    description = (
        "Send a message via a configured SendMessageChannel "
        "(Discord / Slack / SMS / etc — channel impl is service-specific)."
    )
    capabilities = ToolCapabilities(concurrency_safe=True, requires_network=True)
    input_schema = {
        "type": "object", "required": ["channel", "message"],
        "properties": {
            "channel": {"type": "string", "description": "Channel name registered by service"},
            "to": {"type": "string", "description": "Recipient (user id / DM target)"},
            "message": {"type": "string", "minLength": 1, "maxLength": 4000},
            "attachments": {"type": "array", "items": {"type": "string"}},
        },
    }

    async def execute(self, input_data, ctx):
        registry = ctx.get_strategy("send_message_channels")
        if not registry:
            return ToolResult.error("no send_message_channels registered")
        channel = registry.get(input_data["channel"])
        if not channel:
            return ToolResult.error(f"unknown channel: {input_data['channel']}")
        result = await channel.send(
            to=input_data.get("to"),
            message=input_data["message"],
            attachments=input_data.get("attachments", []),
        )
        return ToolResult.ok(result)
```

#### `geny_executor/channels/send_message_channel.py` (~50 lines)

```python
class SendMessageChannel(ABC):
    @abstractmethod
    async def send(self, to: Optional[str], message: str,
                   attachments: List[str]) -> Dict[str, Any]: ...


class SendMessageChannelRegistry:
    def __init__(self):
        self._channels: Dict[str, SendMessageChannel] = {}
    def register(self, name: str, channel: SendMessageChannel) -> None: ...
    def get(self, name: str) -> Optional[SendMessageChannel]: ...
    def list(self) -> List[str]: ...


class StdoutChannel(SendMessageChannel):
    """Reference impl. Prints to logger.info. Useful for tests."""
    async def send(self, to, message, attachments):
        logger.info("send_message", to=to, message=message, attachments=attachments)
        return {"channel": "stdout", "sent": True}
```

### Tests added

`tests/tools/built_in/test_send_message_tool.py`

- `test_dispatches_to_registered_channel`
- `test_unknown_channel_returns_error`
- `test_no_registry_returns_error`
- `test_validates_message_max_length`
- `test_stdout_channel_logs`

### Acceptance criteria
- [ ] SendMessageTool + ABC + registry + reference impl
- [ ] 5 test pass
- [ ] CHANGELOG.md 1.1.0: "Add SendMessageTool + SendMessageChannel ABC"

---

# Part B — Geny (2 PR)

## PR-A.7.1 — feat(service): notifications.endpoints settings + NotificationEndpointRegistry seed

### Metadata
- **Branch:** `feat/geny-notification-endpoints`
- **Repo:** Geny
- **Layer:** SERVICE
- **Depends on:** PR-A.5.0 (executor 1.1.0), PR-A.3.2

### 임시 wiring (P1.3 settings.json 이전이라 yaml/env 사용)

#### `backend/service/notifications/__init__.py`
#### `backend/service/notifications/install.py` (~80 lines)

```python
import os
import yaml
from pathlib import Path
from geny_executor.notifications import (
    NotificationEndpoint, NotificationEndpointRegistry,
)


def install_notification_endpoints(registry: NotificationEndpointRegistry) -> int:
    """Read notification endpoints from settings.
    
    Sources (priority):
      1. ~/.geny/notifications.yaml
      2. .geny/notifications.yaml
      3. NOTIFICATION_ENDPOINTS env (json string)
    
    P1.3 cycle 에서 settings.json 으로 통합 예정.
    """
    paths = [
        Path("~/.geny/notifications.yaml").expanduser(),
        Path(".geny/notifications.yaml"),
    ]
    loaded = 0
    for p in paths:
        if p.exists():
            data = yaml.safe_load(p.read_text()) or {}
            for entry in data.get("endpoints", []):
                registry.register(NotificationEndpoint(**entry))
                loaded += 1
    env = os.getenv("NOTIFICATION_ENDPOINTS")
    if env:
        for entry in json.loads(env):
            registry.register(NotificationEndpoint(**entry))
            loaded += 1
    return loaded
```

### Files modified

- `backend/main.py` — lifespan 에서 `install_notification_endpoints` 호출 + `app.state.notification_endpoints` 보관
- `backend/service/executor/default_manifest.py` — pipeline build 시 endpoint registry 주입

### Tests added

`backend/tests/service/notifications/test_install.py`

- `test_load_from_yaml`
- `test_load_from_env`
- `test_priority_yaml_then_env`
- `test_no_endpoints_returns_zero`

### Acceptance criteria
- [ ] yaml + env 양쪽 source 동작
- [ ] 4 test pass

---

## PR-A.7.2 — feat(service): SendMessageChannel impl (기존 send_dm 통합)

### Metadata
- **Branch:** `feat/geny-send-message-channels`
- **Repo:** Geny
- **Layer:** SERVICE

### Files added

#### `backend/service/channels/__init__.py`
#### `backend/service/channels/install.py` (~60 lines)

```python
from geny_executor.channels.send_message_channel import (
    SendMessageChannelRegistry,
)
from .discord_channel import DiscordChannel
from .geny_dm_channel import GenyDmChannel  # 기존 send_dm 의 channel 화


def install_send_message_channels(registry: SendMessageChannelRegistry) -> None:
    if os.getenv("DISCORD_BOT_TOKEN"):
        registry.register("discord", DiscordChannel(token=os.getenv("DISCORD_BOT_TOKEN")))
    registry.register("geny", GenyDmChannel())   # 기본
```

#### `backend/service/channels/geny_dm_channel.py` (~80 lines)

기존 `tools/geny/send_dm_tool.py` 의 채널 layer 분리. `SendMessageChannel` impl.

#### `backend/service/channels/discord_channel.py` (~80 lines)

discord webhook / API 호출 wrapper.

### Files modified

- `backend/tools/geny/send_dm_tool.py` — deprecated. 기존 사용처가 SendMessageTool 로 swap 되도록 alias 등록 + warning.
- `backend/main.py` — lifespan 에서 `install_send_message_channels` 호출

### Tests added

`backend/tests/service/channels/test_geny_dm_channel.py` — 기존 send_dm 테스트 transferred

`backend/tests/service/channels/test_discord_channel.py`

- `test_send_via_webhook`
- `test_handles_webhook_failure`

### Acceptance criteria
- [ ] geny channel 동작 (기존 send_dm 와 동일 결과)
- [ ] discord channel 옵션 (token 있을 때만)
- [ ] 기존 send_dm 사용처 0 회귀
- [ ] 새 test pass

---

## 묶음 3 의 PR 합계 + 의존성 요약

| PR | Repo | 의존 | 누가 consume |
|---|---|---|---|
| PR-A.3.1 | executor | — | LLM (Stage 15) |
| PR-A.3.2 | executor | — | Geny A.7.1 |
| PR-A.3.3 | executor | (MCPManager 이미) | LLM |
| PR-A.3.4 | executor | — | LLM (코드 worker) |
| PR-A.3.5 | executor | — | LLM |
| PR-A.3.6 | executor | — | Geny A.7.2 (UserFileChannel) |
| PR-A.3.7 | executor | — | Geny A.7.2 (SendMessageChannel) |
| PR-A.7.1 | Geny | A.5.0, A.3.2 | (사용자 webhook 등록) |
| PR-A.7.2 | Geny | A.5.0, A.3.6, A.3.7 | LLM (SendMessage / SendUserFile) |

총 9 PR (executor 7 + Geny 2).

---

## 다음 묶음

[`cycle_A_p0_4_cron.md`](cycle_A_p0_4_cron.md) — Cron 6 PR
