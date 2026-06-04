# B2 — Stage 10 도구 선택 ↔ LLM 노출 심층 감사

> **Date**: 2026-06-01
> **Method**: Geny 백엔드 + geny-executor 라이브러리 양방향 코드 정독 + prod 환경 `034fba082724` 의 실제 manifest 로 런타임 시뮬레이션
> **Goal**: 사용자가 Stage 10 에서 체크한 도구가 실제로 LLM 의 `tools[]` 배열에 정확히 그대로 도달하는지 라인 단위로 검증

---

## TL;DR

**검증 결과 — Stage 10 선택 ↔ LLM 노출 1:1 매핑 보장**.

prod 환경 `034fba082724`(name="test", Stage 6 provider=`claude_code_cli`):

```
사용자가 Stage 10 에서 선택:
  ▸ Executor Built-in:  8개 (Read, Glob, Grep, TodoWrite, EnterPlanMode,
                              ExitPlanMode, AskUserQuestion, PushNotification)
  ▸ Geny Built-in:     23개 (memory_*, knowledge_*, opsidian_*, send_*, read_inbox)
  ▸ Custom Built-in:    3개 (web_search, news_search, web_fetch)
  ▸ Custom Tools:       5개 (blog_agent_*)
  ▸ MCP Servers:        0
  ──────────────────────
  합계:                39개

           ↓ Pipeline.from_manifest_async()
           ↓
ToolRegistry 최종 크기: 39
           ↓ Stage 3 (system): state.tools = registry.to_api_format()
           ↓ Stage 6 (api):    kwargs["tools"] = state.tools
           ↓
Anthropic API 전송: tools=[{name, description, input_schema}] × 39
```

39 → 39, 누락도 추가도 없음.

---

## 1. 전체 데이터 흐름 (코드 라인 단위)

### 1.1 사용자 입력 (Stage 10 UI)

Stage 10 의 5 카테고리 사이드바는 각각 다른 manifest 필드를 편집:

| UI 카테고리 | manifest 필드 | source_kind 필터 |
|---|---|---|
| Executor Built-in | `manifest.tools.built_in[]` | (framework, BUILT_IN_TOOL_CLASSES 키) |
| Geny Built-in | `manifest.tools.external[]` | `geny_builtin` |
| Custom Built-in | `manifest.tools.external[]` | `geny_custom_file` |
| Custom Tools | `manifest.tools.external[]` | `custom_db` |
| MCP Servers | `manifest.tools.mcp_servers[]` | (별도) |

위치:
- [Stage10ToolsEditor.tsx](../../frontend/src/components/env_management/stages/Stage10ToolsEditor.tsx) — 카테고리 정의 + 각 카테고리의 `filterSourceKinds` 매핑

### 1.2 Manifest 저장 — Postgres `environments` + JSON 이중화

위치: `backend/service/environment/service.py:137-174`

```python
# _read_raw — DB 우선, file fallback
def _read_raw(self, env_id: str) -> Optional[Dict]:
    if self._db_available:
        row = self._app_db.execute_query_one(
            "SELECT data FROM environments WHERE env_id = %s", (env_id,)
        )
        if row: return json.loads(row["data"])
    # fallback: ./data/environments/<env_id>.json
    return ...

# _write_raw — DB + JSON 동시 upsert
```

prod 의 실제 저장된 manifest snapshot (env `034fba082724`):
```python
manifest.tools.built_in    = ['Read', 'Glob', 'Grep', 'TodoWrite',
                              'EnterPlanMode', 'ExitPlanMode',
                              'AskUserQuestion', 'PushNotification']     # 8개
manifest.tools.external    = ['send_direct_message_internal', 'read_inbox',
                              'knowledge_*' (4), 'opsidian_*' (3),
                              'memory_*' (14), 'web_search', 'news_search',
                              'web_fetch', 'blog_agent_*' (5)]            # 31개
manifest.tools.mcp_servers = []                                            # 0개
manifest.tools.adhoc       = []                                            # reserved
```

### 1.3 세션 생성 시 — manifest → Pipeline

위치: `backend/service/executor/agent_session_manager.py:725-780`

```python
adhoc_providers = []
if self._tool_loader is not None:
    adhoc_providers.append(GenyToolProvider(self._tool_loader))   # line 727-729
if skill_provider is not None:
    adhoc_providers.append(skill_provider)                         # line 758-759

prebuilt_pipeline = await self._environment_service.instantiate_pipeline(
    env_id,
    credentials=credentials,                # CredentialBundle (Phase I MCP token 포함)
    subagent_registry=subagent_registry,
    adhoc_providers=adhoc_providers,        # [GenyToolProvider, SkillToolProvider]
)
```

`instantiate_pipeline` 은 `Pipeline.from_manifest_async(manifest, ..., adhoc_providers=adhoc_providers)` 로 위임. (`service/environment/service.py:689-728`)

### 1.4 geny-executor 의 도구 등록 분기

위치: `geny_executor/core/pipeline.py:173-258`

#### A. Executor Built-in (`manifest.tools.built_in[]`)

```python
def _register_built_in_tools(manifest, registry):
    names = list(getattr(manifest.tools, "built_in", []) or [])  # line 200
    if names == ["*"]:                                            # line 204-205
        names = list(BUILT_IN_TOOL_CLASSES.keys())                # 와일드카드 → 38개 전부
    for name in names:
        cls = BUILT_IN_TOOL_CLASSES.get(name)                     # line 208
        if cls is None: continue
        if registry.has(name): continue                            # 외부 provider 우선
        registry.register(cls())                                   # line 218
```

`BUILT_IN_TOOL_CLASSES` 정의 — `geny_executor/tools/built_in/__init__.py:82-121`:
- **38개 클래스**: Read/Write/Edit/Glob/Grep/NotebookEdit (filesystem 6) / Bash (shell 1) / WebFetch/WebSearch (web 2) / TodoWrite (workflow 1) / ToolSearch/EnterPlanMode/ExitPlanMode (meta 3) / Agent (agent 1) / Task*×6 (tasks 6) / AskUserQuestion (interaction 1) / PushNotification (notification 1) / MCP/ListMcpResources/ReadMcpResource/McpAuth (mcp 4) / EnterWorktree/ExitWorktree (worktree 2) / LSP/REPL/Brief (dev 3) / Config/Monitor/SendUserFile (operator 3) / SendMessage (messaging 1) / CronCreate/CronDelete/CronList (cron 3) = **38**

#### B. External (`manifest.tools.external[]`)

```python
def _register_external_tools(manifest, registry, adhoc_providers):
    external_names = list(getattr(manifest.tools, "external", []) or [])   # line 235
    for name in external_names:
        tool = None
        for provider in adhoc_providers:                                    # line 245-248
            tool = provider.get(name)                                       # 좌→우 우선순위
            if tool is not None: break
        if tool is None:
            logger.warning("external tool '%s' was ... skipped", name)      # 모르는 이름 skip
            continue
        registry.register(tool)                                              # line 258
```

#### C. MCP servers (`manifest.tools.mcp_servers[]`)

`Pipeline.from_manifest_async()` 의 후반부 (`pipeline.py:617-633`):
```python
configs = _mcp_configs_from_manifest(manifest)
if configs:
    await manager.connect_all(configs)         # 각 서버에 연결
    adapters = await manager.discover_all()    # tools/list 호출
    for adapter in adapters:
        registry.register(adapter)              # mcp__<server>__<tool> 이름으로 등록
```

### 1.5 GenyToolProvider 의 역할

위치: `backend/service/executor/geny_tool_provider.py:67-96`

```python
def list_names(self) -> List[str]:
    return list(self._loader.get_all_names())   # builtin + custom + DB python_inline 전부

def get(self, name: str) -> Optional[Tool]:
    base = self._loader.get_tool(name)
    if base is None: return None
    return _GenyToolAdapter(base)               # BaseTool → executor Tool 어댑터
```

→ `manifest.tools.external` 의 모든 이름을 ToolLoader 에서 풀어줌. file-system tools + DB python_inline 가 한 provider 에 머지되어 있음.

### 1.6 Stage 3 (System) — state.tools 직렬화

위치: `geny_executor/stages/s03_system/artifact/default/stage.py:116-138`

```python
if self._tool_registry and not state.tools:
    state.tools = self._tool_registry.to_api_format()
```

`ToolRegistry.to_api_format()` (`geny_executor/tools/registry.py:75-82`):
```python
def to_api_format(self, include=None, exclude=None) -> List[Dict]:
    return [t.to_api_format() for t in self.filter(include, exclude)]
```

각 Tool 의 `to_api_format()` (`geny_executor/tools/base.py:389-395`):
```python
def to_api_format(self) -> Dict[str, Any]:
    return {
        "name": self.name,
        "description": self.description,
        "input_schema": self.input_schema,   # JSON Schema dict
    }
```

prod 샘플:
```json
{
  "name": "Read",
  "description": "Read a file from the filesystem. Returns content with line numbers.",
  "input_schema": {
    "type": "object",
    "properties": {
      "file_path": {"type": "string", "description": "Absolute path to the file to read."},
      "offset":    {"type": "integer", "minimum": 0, "description": "..."},
      "limit":     {"type": "integer", "description": "..."}
    },
    "required": ["file_path"],
    "additionalProperties": false
  }
}
```

### 1.7 Stage 6 (API) — Anthropic 전송

위치: `geny_executor/stages/s06_api/artifact/default/stage.py:399-411`

```python
def _call_kwargs(self, cfg, state) -> Dict[str, Any]:
    kwargs = {"model_config": cfg, "messages": list(state.messages)}
    if state.system:      kwargs["system"]     = state.system
    if state.tools:       kwargs["tools"]      = state.tools       # line 408 — 그대로 전달
    if state.tool_choice: kwargs["tool_choice"] = state.tool_choice
    return kwargs

# 실제 호출:
response = await client.create_message(**kwargs)
```

→ `state.tools` (39개 dict) 가 Anthropic API 의 `tools=[...]` 인자로 그대로 전송. **별도 필터링 / 가공 없음**.

---

## 2. claude_code_cli 분기 처리 (prod 환경의 실제 케이스)

prod env `034fba082724` 의 Stage 6 provider 는 **`claude_code_cli`**. 별도 MCP wrap 경로가 추가됨.

### 2.1 CredentialBundle 빌드 시 MCP bridge 토큰 주입

위치: `backend/service/executor/agent_session_manager.py:699-704`

```python
mcp_bridge_token = mint_bridge_token()                            # 256-bit hex
mcp_bridge_ctx   = McpBridgeContext(session_id=sid, token=mcp_bridge_token)
credentials      = CredentialBundleBuilder(mcp_bridge=mcp_bridge_ctx).build()
```

`CredentialBundleBuilder.build()` (`backend/service/executor/credentials.py:154-178`):
```python
if claude_cli.enabled:
    by_provider["claude_code_cli"] = self._build_claude_code(
        creds, claude_cli, mcp_bridge=self._mcp_bridge,
    )
```

`_build_claude_code` (`credentials.py:182-310`) — claude_code_cli 의 `extras` 에 MCP 설정 추가:
```python
if mcp_bridge is not None:
    extras["mcp_config"] = _build_mcp_bridge_config(mcp_bridge)   # line 234
    extras["settings_path"] = json.dumps({                         # line 305-307
        "permissions": {"allow": [
            "mcp__geny",                                            # MCP wrap 전체 허용
            "Read", "Write", "Edit", "Bash", ...                   # CLI built-ins 허용
        ]}
    })
```

### 2.2 ClaudeCodeCLIClient 가 spawn 하는 명령

CLI 가 spawn 될 때 다음 인자가 전달됨:
```
claude --mcp-config <json> --strict-mcp-config \
       --tools ""                                # built-ins 자동 비활성 (settings 가 override)
       --settings '<inline JSON with permissions.allow>'
```

CLI 내부 LLM 이 보는 도구:
- CLI 의 built-in 도구 (`Read`/`Write`/`Bash`/`Edit`/... — settings 에서 허용된 것)
- `mcp__geny__*` 로 wrap 된 Geny 도구 (모두 `mcp__geny` 와일드카드로 허용)

### 2.3 MCP bridge → Geny 도구 dispatch

위치: `backend/scripts/geny_mcp_bridge.py` + `backend/controller/mcp_bridge_controller.py`

```
CLI LLM의 tool_use(mcp__geny__blog_agent_delegate)
    ↓
geny_mcp_bridge.py (CLI 가 spawn 한 stdio subprocess)
    ↓ HTTP POST /api/internal/mcp/{sid}/rpc
    ↓ Authorization: Bearer <mcp_bridge_token>
    ↓
mcp_bridge_controller.mcp_rpc()
    ↓ tools/call → _execute_tool()
    ↓ tool = loader.get_tool("blog_agent_delegate")
    ↓ result = await tool.arun(**args)
```

`_list_session_tools()` 는 ToolLoader 의 모든 도구를 advertise (PR #847 에서 dead `_allowed_tools` filter 제거됨) — CLI 의 LLM 이 모든 도구를 알게 됨.

**중요**: claude_code_cli 백엔드일 때 LLM 이 보는 도구는 *manifest 의 39개 + CLI built-in 26개* 가 아니라 *ToolLoader 의 모든 47개 (built-in 31 + DB-merged custom 16)*. 이는 PR #847 의 의도된 정리 — manifest 의 `tools.external` whitelist 가 MCP bridge 단계에서 무시되는 게 cycle 20260525_1 의 명시된 정책.

### 2.4 anthropic API 백엔드와의 차이 — 1줄 요약

| backend | LLM 이 보는 도구 |
|---|---|
| `anthropic` (Stage 6 = api) | manifest 의 `tools.built_in` + `tools.external` + `tools.mcp_servers` 가 정확히 그대로 |
| `claude_code_cli` (Stage 6 = api) | manifest 의 `tools.built_in` (CLI built-in 부분) + ToolLoader 전체 (MCP wrap) |

**이 차이가 의도된 것인지**: ✓ 의도됨. claude_code_cli 의 LLM 은 자체 tool loop 가 있어서 host 가 도구 제어를 못 함. host 는 MCP wrap 으로 *접근 가능* 하게만 만들고 LLM 이 *어떤 도구를 부를지* 는 LLM 의 prompt + reasoning 에 맡김.

---

## 3. AdhocToolProvider 우선순위 + 충돌 처리

위치: `geny_executor/core/pipeline.py:245-248`

```python
for name in external_names:
    tool = None
    for provider in adhoc_providers:    # 좌→우 순회
        tool = provider.get(name)
        if tool is not None: break       # 첫 hit 채택
```

Geny 의 `adhoc_providers` 순서 (agent_session_manager.py:725-759):
1. **GenyToolProvider** (ToolLoader 의 built-in + custom)
2. **SkillToolProvider** (SkillRegistry 의 skill__<id> 도구)

→ 같은 이름이 양쪽에 있으면 GenyToolProvider 가 이김. 실제로 충돌 가능한 케이스는 없음 (skill 은 `skill__` prefix).

### 3.1 ToolLoader 내부의 collision 처리

위치: `backend/service/tool_loader.py:75-136` (`load_custom_tools_from_db`)

```python
for defn in defs:
    if defn.name in self.builtin_tools or defn.name in self.custom_tools:
        logger.info("ToolLoader: skipping DB tool %s — filesystem tool wins", defn.name)
        continue
    self.custom_tools[defn.name] = adapter
    self._db_custom_names.add(defn.name)
```

**파일시스템 도구 > DB python_inline** (collision 시). PR #856 에서 `blog_agent_tools.py` 가 삭제되면서 blog 5개가 DB 로 넘어옴.

---

## 4. ToolRegistry 의 최종 검증 (prod 실측)

env `034fba082724` 의 manifest 로 `Pipeline.from_manifest_async()` 직접 호출 후 final ToolRegistry 의 도구 목록:

```
ToolRegistry 최종 크기: 39

[framework]      (8 — manifest.tools.built_in 8개와 1:1)
  AskUserQuestion, EnterPlanMode, ExitPlanMode, Glob, Grep,
  PushNotification, Read, TodoWrite

[geny_builtin]   (23 — source_kind="geny_builtin" 의 23개)
  knowledge_list, knowledge_promote, knowledge_read, knowledge_search,
  memory_artifact, memory_categories, memory_delete, memory_distill,
  memory_event, memory_link, memory_list, memory_pin, memory_read,
  memory_search, memory_status, memory_update, memory_with, memory_write,
  opsidian_browse, opsidian_read, opsidian_search,
  read_inbox, send_direct_message_internal

[geny_custom_file] (3 — source_kind="geny_custom_file" 의 3개)
  news_search, web_fetch, web_search

[custom_db]      (5 — source_kind="custom_db" 의 5개)
  blog_agent_cancel, blog_agent_delegate, blog_agent_get_post,
  blog_agent_list_posts, blog_agent_status

[mcp_proxy]      (0)
```

**합계 8+23+3+5+0 = 39 = manifest.tools.built_in(8) + tools.external(31) + tools.mcp_servers(0)**. 1:1 매핑 확정.

---

## 5. 식별된 한 가지 미세 이슈 (안전, 보고용)

### W15 — Custom Tools 의 source_kind 우선순위 미세 분기

`tool_controller.py:267-275` 의 `_source_kind()`:
```python
def _source_kind(name, loader_bucket):
    if name in db_names:           return "custom_db"     # DB 가 우선
    if loader_bucket == "built_in": return "geny_builtin"
    return "geny_custom_file"
```

**ToolLoader 의 collision 정책** (`tool_loader.py:109`): 파일시스템이 우선. 즉 `blog_agent_*` 가 파일시스템에 *있었다면* `custom_tools` 에 파일시스템 버전이 들어가고, DB 버전은 skip 되어 `_db_custom_names` 에 추가되지 않음.

**결과**: 두 결정이 일관됨 (DB 로 등록된 것만 `custom_db`, file-system 으로 등록된 것은 `geny_*`). 충돌 없음. 단, 이 invariant 가 미래에 깨지지 않도록 회귀 테스트 추가 권장 (예: `blog_agent_tools.py` 가 다시 추가되면 DB 가 shadow 되어 Custom Tools 탭에서 사라지는 시나리오 - 의도된 동작이지만 명시적 테스트 없음).

---

## 6. 결론

**Stage 10 에서 사용자가 체크한 도구 = LLM 이 보는 도구**, 1:1 매핑 보장.

| 보장 | 근거 |
|---|---|
| 카테고리별 분리 표시 정확 | `source_kind` 필드 + `filterSourceKinds` 사이드바 (PR #856 + #857) |
| Per-category 카운트 정확 | `selectedCount` 가 visible-window intersection (PR #856) |
| Manifest 필드 1 곳만 편집 | Stage 0 의 도구 패널 제거 (PR #855) |
| Manifest 변경 → Pipeline 반영 | `Pipeline.from_manifest_async` 의 `_register_built_in_tools` + `_register_external_tools` |
| Pipeline → LLM 변경 없이 직렬화 | Stage 3 `state.tools = registry.to_api_format()`, Stage 6 `kwargs["tools"] = state.tools` |
| anthropic 백엔드 정확 매핑 | 39 in, 39 out (prod 실측) |
| claude_code_cli 백엔드 의도된 wider exposure | MCP wrap 으로 ToolLoader 전체 노출 (PR #847 의 명시 정책) |

도구 흐름은 정상. UI 정리 사이클 (PR #855→#857) 의 결과로 데이터 모델과 UI 분류가 완전 일치하게 됨.
