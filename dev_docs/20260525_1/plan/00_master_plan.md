# Custom Tools + Custom Skills 도입 & claude_code_cli MCP-Wrap 강건화

> **Cycle**: 20260525_1
> **Status**: 계획 v2 (실제 코드 정독 후 재작성)
> **Author**: Claude Opus 4.7
> **Date**: 2026-05-25

## 0. 한 문장 요약

claude_code_cli 백엔드의 MCP wrap 메커니즘이 약해서 host-side 도구(blog 등)가 불안정한 문제를 **코드 라인 단위로 식별한 10가지 약점**을 고친다. 동시에 환경관리 패널에 **커스텀 도구(Custom Tools) DB-backed CRUD** 메뉴를 신설하고, 기존 blog tool을 그 첫 샘플로 이전한다. SKILLS 패널에는 **CUSTOM 번들** 카테고리를 추가.

---

## 1. 사용자가 확정한 결정 (이전 턴)

1. **데이터 저장**: DB 테이블 (Custom tools = DB-backed)
2. **Blog tool 동작**: anthropic API에서는 정상. claude_code_cli에서 약함 → MCP wrap 메커니즘 자체를 강건화. Blog tool은 그대로 두고 wrap만 손본다.
3. **죽은 코드**: 제대로 제거
4. **prod 실측**: 사용자 없음 → 자유롭게 배포·실측·반복
5. **SSE**: 알아서 (이번 사이클에서는 BuiltinAlias 방식으로 blog 이전, SSE는 그 안에서 처리됨)

---

## 2. 실제 코드에서 식별한 10가지 약점 (강건화 대상)

### W1. **schema가 auto-injected `session_id`를 노출**
- 위치: [tools/base.py:70-107](../../backend/tools/base.py#L70-L107) `_generate_parameters_schema`
- 현상: `BlogAgentDelegateTool.run(self, session_id, task, ...)` 같은 모든 BaseTool subclass의 schema가 `session_id`를 **required**로 노출.
- 영향: LLM이 `session_id`를 hallucinate(빈 문자열, UUID 추측 등) → adapter의 `setdefault` injection이 **bypass됨**.
  - tool_bridge.py:159 — `call_input.setdefault("session_id", context.session_id)` ← LLM이 임의 값 보내면 그대로 사용
  - mcp_bridge_controller.py:211 — 동일한 문제
- 이는 **anthropic API + claude_code_cli 양쪽 모두**의 약점. 다만 anthropic의 LLM이 description("adapter 가 자동 주입")을 더 잘 따라서 빈도가 낮아 보였을 가능성.

### W2. **`agent._allowed_tools` 는 죽은 코드**
- 위치: [mcp_bridge_controller.py:135-144](../../backend/controller/mcp_bridge_controller.py#L135-L144)
- 현상: `getattr(agent, "_allowed_tools", None)` 으로 읽지만 Geny 코드 어디에도 set하는 곳 없음.
- 영향: MCP bridge가 ToolLoader의 **모든 도구를 LLM에 노출**. 환경 매니페스트의 `tools.external` whitelist가 MCP 단계에서 무시됨.

### W3. **tool_preset의 vtuber 항목이 deprecated인데 살아있음**
- 위치: [service/tool_preset/templates.py:27-46](../../backend/service/tool_preset/templates.py#L27-L46)
- 현상: VTuber preset `custom_tools=["web_search", "news_search", "web_fetch"]` (blog 누락). [agent_session_manager.py:580-587](../../backend/service/executor/agent_session_manager.py#L580-L587) 주석에 따르면 "more longer fed into pipeline construction — log only".
- 영향: 진실의 단일 소스가 깨져있음. environment template(`_VTUBER_CUSTOM_TOOL_WHITELIST`)이 실제 필터인데 코드 두 곳에서 다른 답을 줌 → 디버그 시 어디가 진짜인지 추적 어려움.

### W4. **에러 반환이 `{"error": "..."}` 문자열 → MCP는 `isError: false`**
- 위치: [blog_agent_tools.py:63-65, 290-294](../../backend/tools/custom/blog_agent_tools.py#L63), mcp_bridge_controller.py:248-249
- 현상: blog tool의 `_check_enabled()` / `_err(...)` 가 `json.dumps({"error": "..."})` 문자열을 정상 return. MCP bridge가 `isError: false`로 LLM에 전달.
- 영향: LLM 입장에서는 "tool이 성공적으로 실행되었고 결과가 `{"error":"..."}` 라는 텍스트" 로 받음 → "맡겼다"는 paraphrase를 그대로 사용자에게 전달 (실제로는 실패).

### W5. **에러가 raise되면 traceback이 LLM에 그대로 노출**
- 위치: mcp_bridge_controller.py:234-241
- 현상: tool이 exception을 raise하면 `{"content": [{"type":"text", "text": f"Tool error: {exc}"}], "isError": True}` — `exc` 가 그대로. 민감한 파일경로/내부 구조 leak 가능.

### W6. **MCP bridge 토큰의 lifecycle 미관리**
- 위치: agent_session_manager.py:699-710, mcp_bridge_controller.py:88-113
- 현상: 토큰은 `agent._mcp_bridge_token` 인스턴스 속성으로만 보관. agent 객체가 GC되면 토큰 검증 못 함. 세션 자체가 long-lived지만, `delete_session`이 호출되어도 spawn된 bridge subprocess가 살아있을 수 있음 → 401이 영원히 반환.
- 추가: 토큰 회전 메커니즘 없음. 세션 전체 lifetime 동안 같은 토큰 사용.

### W7. **bridge subprocess가 부모(claude CLI) 죽으면 orphan될 수 있음**
- 위치: [scripts/geny_mcp_bridge.py:107-128](../../backend/scripts/geny_mcp_bridge.py#L107-L128)
- 현상: `for raw in sys.stdin` — stdin EOF에서 종료. 정상 종료 경로 OK. 그러나 CLI가 `--print` 모드에서 timeout으로 강제 종료되면 stdin이 닫히지 않은 채 hang 가능.
- 영향: bridge process leak, 백엔드 자원 낭비.

### W8. **bridge가 `resources/list`, `prompts/list` 등 MCP 표준 메서드를 method-not-found로 답함**
- 위치: mcp_bridge_controller.py:421-423
- 현상: 신규 CLI 버전이 capability probe로 보내는 메서드들이 모두 -32601 에러. CLI는 fallback이 있지만 logs가 시끄럽고 일부는 retry로 latency 증가.

### W9. **initialize에서 client protocolVersion을 무조건 echo back**
- 위치: mcp_bridge_controller.py:285-301
- 현상: CLI가 보낸 `protocolVersion` 을 그대로 응답. spec에서는 server가 자신이 지원하는 버전을 advertise해야 함. CLI가 newer/unknown 버전 보내면 우리는 거짓말로 "지원함" 응답 → 이후 호환되지 않는 method 호출 시 깨짐.

### W10. **schema에 `additionalProperties: false` 명시 없음**
- 위치: tools/base.py:72-76 — `{"type": "object", "properties": {}, "required": []}`
- 현상: JSON Schema에 `additionalProperties` 미명시 → 일부 LLM은 모르는 필드를 "허용된 것"으로 간주하고 hallucinated arg 추가. MCP 측 검증도 통과해버림.
- 영향: 예측 못한 인자가 `run()` kwargs로 흘러들어 `TypeError: unexpected keyword argument` → 5번 약점(traceback 노출)을 트리거.

### (보너스) W11. **`run()` 에 docstring이 dual-purpose**
- 위치: blog_agent_tools.py:278-289 — docstring이 LLM-facing description으로도 쓰이고, schema generator의 param description으로도 쓰임. 후자는 작동하지만 description의 첫 문장이 잘리는 경우 있음.
- 영향: 작음. W1~W10 처리 후 정리.

---

## 3. 작업 범위 (4 Phase / 4 PR)

### Phase A — MCP Wrap 강건화 + 죽은 코드 제거 (PR #1)

#### A1. 진단 (prod 실측, ~30분)
- prod 백엔드에서 VTuber + claude_code_cli 1턴 실행, 다음 로그 수집:
  1. ToolLoader 부팅 로그 (blog_agent_tools 5 tools 로드 확인)
  2. 세션 생성 시 tool_preset / 매니페스트 로그
  3. MCP bridge `tools/list` 응답 — blog tool 포함 여부, schema 형태
  4. LLM이 실제 호출한 tool name + args (특히 session_id 값)
  5. 실패 시 traceback
- 결과를 [analysis/A1_mcp_wrap_prod_diagnosis.md](../analysis/A1_mcp_wrap_prod_diagnosis.md) 에 기록.
- W1~W10 중 실제로 발현되는 것 확인 + 추가 약점 발견.

#### A2. 구현 (PR #1)

**A2-1. Schema 정화** (W1, W10)
- [tools/base.py](../../backend/tools/base.py) 변경:
  - `INJECTED_PARAMS: ClassVar[set[str]] = {"session_id"}` — subclass가 override 가능
  - `_generate_parameters_schema` 가 `INJECTED_PARAMS` 의 키를 `properties`/`required`에서 제외
  - 생성된 schema에 `"additionalProperties": False` 추가
- [tool_bridge.py:153-159](../../backend/service/executor/tool_bridge.py#L153-L159) 변경:
  - `setdefault` 대신 **무조건 overwrite** — LLM이 보낸 session_id는 신뢰하지 않음
  - `if self._accepts_session_id and context and context.session_id:`<br>&nbsp;&nbsp;&nbsp;&nbsp;`call_input["session_id"] = context.session_id`
- [mcp_bridge_controller.py:197-214](../../backend/controller/mcp_bridge_controller.py#L197-L214) 변경:
  - 동일하게 overwrite. + inspect 결과를 ToolLoader에서 캐시 (tool 등록 시 1회 결정).

**A2-2. 에러 envelope 정상화** (W4, W5)
- BaseTool에 `class ToolError(Exception)` 도입 (or 기존 표준 사용).
- BaseTool의 helper `_err(...)` 가 ToolError raise하도록 변경 (blog_agent_tools 전부).
- tool_bridge / mcp_bridge가 raise된 ToolError를 `{"isError": true, "content": [{"type": "text", "text": <safe message>}]}` 로 변환. 일반 Exception은 sanitize (traceback 노출 X, 로그만 detailed).
- Backward compat: 여전히 `{"error": "..."}` JSON string return하는 경로는 자동 감지해서 `isError: true` 로 변환.

**A2-3. 죽은 코드 제거** (W2, W3)
- mcp_bridge_controller.py:135-149 — `_allowed_tools` 로직 완전 제거. MCP bridge는 `tools/list`에서 **manifest의 `tools.external`** 을 기반으로 필터링하도록 재배선.
- service/tool_preset/templates.py — `create_vtuber_tools_preset` 제거, `ROLE_DEFAULT_PRESET`의 vtuber entry 제거. 이제 vtuber는 매니페스트 단일 출처.
- agent_session_manager.py:560-597 의 deprecated 로그 라인 정리.

**A2-4. MCP protocol hygiene** (W6, W7, W8, W9)
- protocolVersion: 우리가 지원하는 버전 advertise (`"2024-11-05"`), client request 무시.
- `resources/list`, `prompts/list` 핸들러 추가 (빈 배열 + listChanged: false).
- bridge subprocess: 부모 monitoring 추가. `os.getppid()` 체크 또는 `setpgrp`로 그룹 분리 후 SIGHUP/SIGPIPE 처리.
- 토큰 lifecycle: agent 객체 reference 만료 시 token도 invalidate. Manager에 `_session_tokens: dict[str, str]` 추가, `delete_session` 이 정리.

**A2-5. 회귀 테스트**
- `tests/integration/test_mcp_wrap_robustness.py`:
  - blog_agent_status를 claude_code_cli backend로 실제 호출 → 성공
  - schema에 session_id가 없는지 검증
  - 잘못된 token 거부 (401)
  - LLM이 잘못된 session_id 보내도 무시되는지 (W1 fix)
  - exception이 sanitize되는지 (W5 fix)
  - `_err(...)` JSON 반환이 isError로 변환되는지 (W4 fix)
- `tests/integration/test_mcp_protocol.py`: resources/list, prompts/list, protocolVersion advertise

**산출물**: PR #1 (강건화 + 죽은 코드 제거 + 회귀 테스트). 라인 추정 ~600.

---

### Phase B — Custom Tools 백엔드 (DB-backed) — PR #2

확정된 결정 (사용자): **DB 저장**.

#### B1. DB 스키마 (Alembic 마이그레이션)

```sql
CREATE TABLE custom_tools (
    id           VARCHAR(26) PRIMARY KEY,    -- ULID
    name         VARCHAR(64) NOT NULL UNIQUE, -- tool name (LLM이 보는 이름)
    description  TEXT NOT NULL,
    input_schema JSONB NOT NULL,              -- JSON Schema (additionalProperties:false)
    backend_kind VARCHAR(32) NOT NULL,        -- 'http' | 'mcp_proxy' | 'builtin_alias'
    config       JSONB NOT NULL,              -- backend-specific config
    capabilities JSONB NOT NULL DEFAULT '{}', -- ToolCapabilities (read_only, idempotent, network_egress, ...)
    enabled      BOOLEAN NOT NULL DEFAULT TRUE,
    is_sample    BOOLEAN NOT NULL DEFAULT FALSE, -- Geny-shipped sample (D 단계에서 blog 5개가 여기에 들어감)
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_custom_tools_enabled ON custom_tools(enabled) WHERE enabled = TRUE;
```

#### B2. Backend kind별 config 스키마 (pydantic)

```python
class HttpToolConfig(BaseModel):
    method: Literal["GET", "POST", "PUT", "DELETE", "PATCH"]
    url_template: str           # {arg_name} 치환 (path/query 양쪽)
    headers: dict[str, str]     # 값에 ${secret:NAME} 또는 ${session:field} 참조
    body_template: str | None   # JSON body. 동일한 치환 규칙
    timeout_seconds: int = 30
    response_handler: Literal["json", "text", "sse_stream_collect"] = "json"
    # SSE: stream을 background task로 소비, 본 호출은 즉시 task_id 반환
    sse_done_marker: str | None = None  # SSE done event marker

class McpProxyConfig(BaseModel):
    """기존 MCP 서버의 특정 tool을 다른 이름/스키마/설명으로 노출."""
    upstream_mcp_server: str   # custom_mcp 테이블의 server name
    upstream_tool_name: str
    schema_overlay: dict | None  # input_schema를 덮어쓸 부분 (예: 일부 인자 숨기기)

class BuiltinAliasConfig(BaseModel):
    """backend/tools/custom/*_tools.py 에 있는 기존 Python tool의 메타데이터 오버레이."""
    source_module: str         # 'blog_agent_tools'
    source_class: str          # 'BlogAgentDelegateTool'
    # 메타데이터만 override (실제 실행은 원본 Python 클래스 그대로)
    description_override: str | None = None
    examples_override: list | None = None
```

**SSE의 처리 방식 (W2-1 결정)**: HTTP backend의 `response_handler = "sse_stream_collect"` 는 호출 즉시 task_id를 LLM에 반환하고, 백그라운드에서 stream을 끝까지 소비. 완료 시 blog_agent 패턴처럼 `[EXTERNAL_TASK_RESULT]` envelope을 호출자 inbox에 deliver. blog tool과 같은 fire-and-poll semantics를 일반화.

#### B3. ToolLoader 통합

- `ToolLoader.load_all()` 이후에 `load_custom_tools_from_db()` 호출 추가.
- DB의 각 row → 적절한 adapter로 wrapping:
  - `http` → `HttpToolAdapter(BaseTool)` 신규 클래스
  - `mcp_proxy` → `McpProxyAdapter(BaseTool)` 신규 클래스
  - `builtin_alias` → 기존 BaseTool subclass 그대로 + metadata override
- `custom_tools` 딕셔너리에 등록.
- 변경 watcher: postgres LISTEN/NOTIFY 또는 폴링으로 reload (Phase A의 Skills watcher 패턴 참고).

#### B4. API 엔드포인트

```
GET    /api/custom-tools                    — 리스트 (samples + user)
GET    /api/custom-tools/{tool_id}          — 상세
POST   /api/custom-tools                    — 생성
PUT    /api/custom-tools/{tool_id}          — 업데이트 (sample은 fork-and-edit only)
DELETE /api/custom-tools/{tool_id}          — 삭제 (sample은 disabled 처리만)
POST   /api/custom-tools/{tool_id}/test     — dry-run (인자 검증 + optional real call)
POST   /api/custom-tools/{tool_id}/duplicate — sample 복제 (user 영역으로)
```

각 핸들러는 ToolLoader hot-reload 트리거.

#### B5. 보안

- `${secret:NAME}` 참조 → host의 `~/.geny/settings.json` 또는 env var에서만 해석. DB에 평문 저장 금지.
- URL allowlist: `GENY_CUSTOM_TOOL_URL_ALLOWLIST` env (default empty = 모두 허용 — 사용자 hobby 운영). prod에서 명시 설정 권장.
- input_schema 검증: `additionalProperties: false` 강제, max property count, max string length.

#### B6. 테스트
- `tests/controller/test_custom_tools_controller.py` — CRUD 라운드트립
- `tests/service/test_http_tool_adapter.py` — pytest-httpx로 HTTP backend 실호출
- `tests/service/test_mcp_proxy_adapter.py` — mock MCP upstream
- `tests/integration/test_custom_tool_in_session.py` — 세션 안에서 등록된 custom tool 호출 성공

**산출물**: PR #2. 라인 추정 ~1800.

---

### Phase C — Custom Tools 프론트엔드 — PR #3

#### C1. 사이드바 탭 추가
- [EnvManagementHeader.tsx:47-115](../../frontend/src/components/env_management/EnvManagementHeader.tsx#L47-L115):
  - `EnvManagementTab` 타입에 `'custom_tools'` 추가
  - `TAB_ORDER` 에 추가 (SKILLS와 HOOK 사이가 자연스러움)
  - icon: `Wrench` (lucide), label: `커스텀 도구`

#### C2. CustomToolsTab 컴포넌트
- `frontend/src/components/env_management/tabs/CustomToolsTab.tsx` 신규
- `RegistryPageShell` + 섹션:
  - **Bundled samples** (Geny가 ship한 샘플; D 단계에서 blog 5개)
  - **User custom** (사용자가 UI로 만든)
- 카드 메타: name, description, backend kind 배지, 사용 환경 수, capabilities flags (RO/idem 등)
- 액션: 편집 / 복제 / 테스트 / 비활성화 / 삭제

#### C3. CustomToolFormModal (3-step wizard)

**Step 1 — 기본 정보**
- name, description (LLM facing)
- input_schema editor:
  - Visual builder (property add/remove + type picker)
  - JSON editor 토글 (advanced)
  - 라이브 미리보기: "LLM이 보는 모습"

**Step 2 — Backend**
- Radio: HTTP / MCP Proxy / Builtin Alias
- 각 옵션의 form:
  - HTTP: method, url_template, headers, body_template, timeout, response_handler, sse marker
  - MCP Proxy: upstream server picker (`customMcpApi.list()`), upstream tool picker, schema overlay
  - Builtin Alias: module + class picker (서버 introspection으로 목록 제공), 메타데이터 override
- Capabilities checkboxes: read_only, idempotent, network_egress, concurrency_safe

**Step 3 — 테스트**
- 인자 입력 폼 (input_schema에서 자동 생성)
- "Dry-run" / "Real-call" 분기
- 응답 미리보기 + duration + status

#### C4. API 클라이언트
- [frontend/src/lib/api.ts](../../frontend/src/lib/api.ts) 에 `customToolsApi`:
```typescript
export const customToolsApi = {
  list: () => apiCall<CustomTool[]>("/api/custom-tools"),
  get: (id) => apiCall<CustomTool>(`/api/custom-tools/${id}`),
  create: (body) => apiCall<CustomTool>("/api/custom-tools", { method: "POST", body }),
  replace: (id, body) => apiCall<CustomTool>(`/api/custom-tools/${id}`, { method: "PUT", body }),
  remove: (id) => apiCall(`/api/custom-tools/${id}`, { method: "DELETE" }),
  test: (id, args) => apiCall(`/api/custom-tools/${id}/test`, { method: "POST", body: { args } }),
  duplicate: (id) => apiCall<CustomTool>(`/api/custom-tools/${id}/duplicate`, { method: "POST" }),
};
```

#### C5. i18n
- en.ts + ko.ts에 `customTools` namespace (메뉴, 폼 라벨, 에러 메시지)

#### C6. 시각 검증
- 브라우저에서 환경관리 → 커스텀 도구 → 새 도구 생성 → HTTP 케이스로 테스트 호출까지 동작 확인. (사용자 없으므로 prod에서 직접 검증)

**산출물**: PR #3. 라인 추정 ~1200.

---

### Phase D — Blog → Custom Tool Sample 이전 + Custom Skills 카테고리 + 문서 — PR #4

#### D1. Blog 5개 도구를 DB sample로 seed

- Alembic data migration: `custom_tools` 테이블에 5개 row insert (is_sample=TRUE, backend_kind="builtin_alias").
- 각 row가 기존 `BlogAgentDelegateTool` 등을 참조 — Python 코드는 그대로 둠.
- 결과: 사용자는 환경관리 → 커스텀 도구 탭에서 blog 5개를 "Bundled samples"로 봄. 복제해서 자신만의 도구 만들기 가능.

> 비고: 결정 #2에서 사용자가 "BuiltinAlias 유지" 의도를 보였고, 또한 SSE 처리 로직(`pump_task`)이 복잡하므로 이번 사이클은 BuiltinAlias만. HTTP 완전 이전은 추후 사이클.

#### D2. SkillsTab에 CUSTOM 카테고리 추가

- [service/skills/install.py](../../backend/service/skills/install.py) 에 4번째 레이어: `samples` 디렉토리 추가.
  - 위치: `backend/skills/samples/` (신규)
  - source_kind = `"sample"` 추가
- 신규 sample skill: `backend/skills/samples/blog_write_sample/SKILL.md`
  - 기존 `blog_write` 의 주석 풍부한 버전 — "이걸 복제해서 자신만의 외부 위임 skill을 만들어보세요"
- [SkillsTab.tsx](../../frontend/src/components/env_management/tabs/SkillsTab.tsx) `grouped` 객체에 `samples` 추가
- "Copy to my skills" 버튼: 샘플을 `~/.geny/skills/` 로 복사

#### D3. 문서 갱신

- README.md + README_ko.md "MCP & custom tools" 섹션 → "Custom Tools & Skills"로 확장
- 신규 [docs/custom_tools.md](../../docs/custom_tools.md) — 3가지 backend kind, HTTP tool 작성 튜토리얼, 보안 가이드
- docs/providers.md → "claude_code_cli + host tools" subsection (A2에서 정리한 강건화된 메커니즘 설명)
- dev_docs/20260525_1/progress/ — Phase별 결과 요약

**산출물**: PR #4. 라인 추정 ~700.

---

## 4. PR 분할 + 머지 순서

| PR | 의존 | 라인 추정 | 머지 후 prod 효과 |
|---|---|---|---|
| **#1** Phase A | 없음 | ~600 | claude_code_cli + blog 즉시 안정화. 죽은 코드 제거. 회귀 테스트 |
| **#2** Phase B | #1 | ~1800 | API + DB만 — 사용자 UI 영향 0 (Headless) |
| **#3** Phase C | #2 | ~1200 | UI 등장. 사용자가 직접 custom tool 등록 가능 |
| **#4** Phase D | #3 | ~700 | blog 가 sample로 이전 + custom skills 카테고리 + 문서 |

각 PR 머지 직후 prod 배포 + 1턴 검증.

---

## 5. 작업 추정

| Phase | 작업 (실시간) |
|---|---|
| A1 진단 | 30분 |
| A2 구현 + 테스트 + PR #1 | 3–4시간 |
| B 구현 + 테스트 + PR #2 | 5–7시간 |
| C 구현 + 시각 검증 + PR #3 | 4–5시간 |
| D 이전 + 문서 + PR #4 | 2–3시간 |
| **합계** | **15–20시간** |

---

## 6. 리스크 매트릭스

| 리스크 | 가능성 | 영향 | 완화 |
|---|---|---|---|
| A2의 schema 정화가 기존 anthropic 호출자도 손상시킴 | 中 | 高 | tool_bridge / mcp_bridge 양쪽에 일관 적용 + 통합 테스트 |
| Custom tools가 임의 URL 호출 → SSRF | 中 (hobby env) | 中 | URL allowlist env var. default open (사용자 결정 #4) |
| DB 마이그레이션 실패 | 低 | 中 | Alembic downgrade 검증 + prod 배포 전 dev에서 round-trip |
| ToolLoader hot-reload 도중 race | 中 | 中 | reload는 lock으로 직렬화. 진행 중 호출은 old loader로 완료 |
| 죽은 코드 제거가 숨은 의존성 가진 곳을 깸 | 中 | 中 | grep 전수 + 통합 테스트 + prod canary |

---

## 7. 다음 단계 (즉시 진행)

1. ☐ [analysis/A1_mcp_wrap_prod_diagnosis.md](../analysis/A1_mcp_wrap_prod_diagnosis.md) — prod 실측 진단 (30분)
2. ☐ [plan/01_phase_a_implementation.md](./01_phase_a_implementation.md) — A1 결과 반영한 상세 PR #1 plan
3. ☐ PR #1 구현 → 머지 → prod 배포 → 검증
4. (반복) Phase B/C/D
