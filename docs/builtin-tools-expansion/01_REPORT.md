# Geny · geny-executor 기본 도구 대확장 — 구현 리포트

> 작성일: 2026-06-26 · 상태: **조사·설계 (구현 전, 검토용)**
> 범위: geny-executor(에이전트 엔진) + Geny(오케스트레이터/설정/UI) 양쪽

---

## 0. 요약 (TL;DR)

**목표.** Google 연동을 시작으로, 널리 쓰이는 VTuber/Agent 기능들을 Geny·geny-executor의 **기본 제공 도구**로 대거 편입한다. 모든 도구는 "기본적으로 쓰려고 시도"하되, **필수 config가 설정되지 않은 도구는 LLM(에이전트 엔진)에게 전달되는 도구 목록에서 아예 제외**(progressive disclosure)한다.

**핵심 발견 (가장 중요).** 현재 이 "비설정 도구 비공개" 원칙은 **GAPT 한 곳에만** 임시방편(ad-hoc)으로 적용되어 있고, **범용 메커니즘은 존재하지 않는다.** 나머지 도구들(web_search 비-DDG 백엔드, knowledge_*, Task/Cron/Agent/SubAgent 런타임 핸들, browser_*, blog_agent_*, DB 커스텀 도구 등)은 config가 없어도 LLM 목록에 항상 노출되고 **호출 시점에 실패**한다 — 코드 주석에도 명시된 안티패턴(`agent_session.py:2626` "Without these the tools raise 'not configured' at call time").
→ **따라서 Phase 0(범용 게이팅 메커니즘 구축 + 기존 갭 수정)이 모든 신규 도구의 선결 조건이다.**

**전략.** 도구를 3계층으로 본다.
- **T1 — 네이티브 핵심 도구**: 사용 빈도·가치가 가장 높은 것(Google Workspace, 이메일, 캘린더 등)은 geny-executor/Geny 네이티브 도구로 1급 구현.
- **T2 — 큐레이션 MCP 커넥터**: 이미 성숙한 MCP 생태계(Google/Slack/Notion/GitHub/…, Composio 1000+ toolkit)를 **config-gated 기본 커넥터**로 큐레이션해 흡수. 재발명 금지.
- **T3 — 사용자 커스텀**: 기존 custom tools / MCP 등록 경로 유지.

세 계층 **모두** Phase 0의 동일한 config-게이팅 규약을 따른다.

---

## 1. 현재 상태 분석

### 1.1 도구 아키텍처 (geny-executor)

- **Tool ABC** (`geny-executor/src/geny_executor/tools/base.py:263`): `name`/`description`/`input_schema`/`execute()`가 핵심. `to_api_format()`(`:402`)가 LLM에 가는 `{name, description, input_schema}`를 만든다. 선택 오버라이드: `is_enabled()`(`:392`, 정적 토글 — **현재 어떤 빌트인도 사용 안 함**), `capabilities()`(`:325`, read_only/destructive/network_egress 등), 권한 훅, UI 힌트.
  - **핵심: ABC에 config/credential 요구 메타데이터가 없다.** `required_config`/`is_available`/`is_configured` 부재(전 디렉터리 grep 무결과).
- **빌트인 인벤토리**: `BUILT_IN_TOOL_CLASSES`(`tools/built_in/__init__.py:93`, 45종) + 기능 그룹 `BUILT_IN_TOOL_FEATURES`(`:148`). 파일/셸/Web(Fetch·Search)/Todo/Agent/Ask/Push/MCP/Worktree/Dev(LSP·REPL)/Operator/SendMessage/Cron/Task/SubAgent/env 등.
- **레지스트리·조립**: `ToolRegistry`(`tools/registry.py:13`, version 카운터) ← `ToolComposer`(`composer.py:73`) ← 두 호스트 확장 프로토콜: `AdhocToolProvider`(이름키 lookup, manifest `tools.external`로 활성)와 `ToolProvider`(자족형 feature pack).
- **LLM 전달 경로**: **Stage 3 (System)** `s03_system/.../stage.py:169-176`에서 `state.tools = registry.to_api_format()` (registry.version 변동 시에만 재생성) → **Stage 6 (API)** `request.tools = state.tools` (anthropic/openai/claude_code_cli 동일 소비).
- **세션별 on/off는 manifest 빌드 시점**: `manifest.tools.built_in`(`["*"]`=전체) / `tools.external` / `mcp_servers`. `HostSelections`는 hooks/skills/permissions만, **도구는 게이팅 안 함**.
- **ctx.extras 주입**: Stage 10 `build_dispatch_context()`(`s10_tool/.../stage.py:166`)가 매 호출 `extras=dict(self._context.extras)` 라이브로 읽음 → 런타임 설정 변경 즉시 반영. 호스트는 `attach_runtime(tool_context=…, env_settings_schemas=[…])`로 주입.
- **executor의 config 게이팅: 없음.** `is_enabled()`는 크레덴셜과 미연결. 실제 게이팅은 **execute-time fail-loud**(예: `WebSearchConfigError`). `CredentialBundle`은 **LLM 프로바이더 + MCP 서버 선택**만 게이팅, 빌트인 도구는 무관. → **"키 없으면 도구 자체를 안 준다"는 호스트(Geny)의 몫**(또는 ABC+Stage3 확장 필요).

### 1.2 Geny 도구/설정 — 3대 선언 체계

| 체계 | 선언 | 저장 | 범위 | 용도 |
|---|---|---|---|---|
| **BaseConfig** (`service/config/`) | `@register_config` 데이터클래스 | DB `persistent_configs` + JSON, **전역 싱글톤** | 호스트 전역 | API 키, enable 플래그, 전역 크레덴셜 |
| **ToolSettingSchema** (`service/tool_settings/`) | `@register_tool_setting` | manifest `host_selections.extras.tool_settings[key]`, **환경별** | per-env | 도구 옵션, `ctx.extras`로 주입 |
| **Tool roster** (manifest `tools.external`/`built_in`) | `*_tools.py` → `ToolLoader` → `GenyToolProvider` | manifest | per-env | 도구 객체 자체 |

- **Geny BaseTool**(`tools/base.py:263`)은 이제 executor `Tool`을 **직접 상속**(어댑터 제거, 경계 위반 해소). `run()` 시그니처+docstring으로 스키마 자동 생성. `INJECTED_PARAM_NAMES = {"session_id", "web_search_config"}`(`:63`) — LLM 스키마에서 제거되고 신뢰된 `ToolContext`로 주입(**신규 호스트-주입 파라미터의 유일한 훅**).
- **ToolLoader**(`service/tool_loader.py:32`): 부팅 시 `tools/built_in/*_tools.py`(상시) + `tools/custom/*_tools.py` 스캔, 모듈 `TOOLS` 리스트 수집. DB 커스텀 도구 오버레이.
- **GenyToolProvider**(`service/executor/geny_tool_provider.py:38`): adhoc 프로바이더, **모든 로드 도구를 광고**(`list_names()`), `get()`은 그대로 반환. **자체 필터 없음.**
- **빌트인 도구군**: `geny_tools.py`(세션/룸/메시징), `memory_tools.py`/`memory_inspect_tools.py`(메모리), `knowledge_tools.py`(지식/옵시디언), `gapt_tools.py`(config-gated), `sandbox_tool_pack_tools.py`, `game_tools.py`. 커스텀: `web_search_tools.py`, `web_fetch_tools.py`, `browser_tools.py`, `whiteboard_tools.py`.

### 1.3 ToolSettingSchema 풀 체인 (web_search 예시)

선언 `service/tool_settings/sub_settings/web_search.py:18`(`get_key()→"web_search"`, 4필드) → UI `GET /api/tool-settings/schemas` + `ToolSettingsPicker.tsx`(스키마당 카드 자동 렌더, **백엔드 추가만으로 UI 등장**) → 저장 manifest `host_selections.extras.tool_settings["web_search"]` → 주입 `agent_session.py:_load_tool_settings(:1867)` → `_tool_extras[key]` → `ToolContext.extras` → 소비 `WebSearchTool.run(..., web_search_config=)`(우선순위: per-env tool-setting → 전역 env → ddg).

### 1.4 인증/크레덴셜 흐름

- **CredentialBundleBuilder**(`service/executor/credentials.py:131`): LLM 프로바이더 키만(anthropic/openai/google/ollama/…). 세션마다 fresh build. `{llm_credentials, cli_backends, media_credentials}` 변경 시 `refresh_all_session_credentials()`로 라이브 세션 재빌드.
- **도구 크레덴셜 3경로**: ① 전역 config + `apply_change`로 `os.environ` 동기화(예: `GITHUB_TOKEN`/`GH_TOKEN`) ② per-env tool-settings → `ctx.extras`(brave/tavily 키) ③ MCP 크레덴셜 `FileCredentialStore`(`~/.geny/credentials.json`).
- **크레덴셜이 도구 가용성을 게이팅하지 않음** — 도구 내부 call-time 검사(gapt 패턴) 또는 roster 빌드 시 빈 `TOOLS`만 존재.

### 1.5 ⚠️ 핵심 발견 — 비설정 도구 비공개(게이팅) 메커니즘 **부재**

**범용 메커니즘 없음. config 기반 도구 숨김은 GAPT 한 가족에만 ad-hoc.**

발견된 게이트 전체:

| 도구/그룹 | 게이트 위치 | 조건 | 시점 |
|---|---|---|---|
| `gapt_*` (9종) | `tools/built_in/gapt_tools.py:260` | `TOOLS = [...] if get_gapt_client().configured else []` | 로드 시 |
| `list_tool_packs`/`use_tool_pack` | `sandbox_tool_pack_tools.py:170` | 동일(`configured`) | 로드 시 |
| 샌드박스 팩 프로바이더/lifecycle | `agent_session_manager.py:1018-1072` | `if _gc.configured` | 세션 빌드 |
| executor `required` 외부 항목 | `core/pipeline.py:597` | **프로바이더 부재 시만** raise (config 검사 아님) | 빌드 |

→ 모든 게이트가 **`GaptClient.configured`(=`GAPT_BASE_URL` 존재) 하나**에만 의존. 다른 크레덴셜엔 동등물 없음.

**갭 (config 없어도 항상 LLM 목록에 노출 → call-time 실패):**

| 도구 | 추가 위치 | 미설정 동작 |
|---|---|---|
| `web_search`/`news_search` (Geny), `WebSearch` (executor) | 상시 `TOOLS` / `BUILT_IN_TOOL_CLASSES` | 비-DDG 백엔드인데 키 없으면 call-time 에러. DDG 폴백이라 "작동하는 척". |
| `knowledge_*`/`opsidian_*` (7종) | `knowledge_tools.py` 상시 | LTM 비활성 시 매번 "not enabled" 에러. |
| `Task*`/`Cron*`/`Agent`/`SubAgent*` | executor 빌트인 + 런타임 핸들 주입 | 핸들 부재 시 "not configured" call-time(코드 주석에 명시). |
| `browser_*` (7, Playwright) | `browser_tools.py` 상시 | 브라우저 미설치 시 call-time 실패. |
| `whiteboard_*` | `whiteboard_tools.py` | 비전/Whisper 없으면 degrade(저위험). |
| **`blog_agent_*`** | DB 커스텀 등록 시 | **config 게이트 전혀 없음 — 정확히 사용자가 우려한 "블로그 config 없는 블로그 에이전트" 케이스.** |

> DB 커스텀 도구(`tool_loader.py:75`)는 config 검증 없이 병합 → 향후 외부서비스 커스텀 도구 전부 이 갭을 상속.

---

## 2. 설계 A — 통합 Config 게이팅 (Progressive Disclosure) ★최우선

### 2.1 원칙
도구는 자신의 **필수 config 키(들)**를 선언한다. 세션 도구 목록을 확정하기 직전, 선언된 필수 키가 (크레덴셜/ToolSettings/전역 config 중 어디서든) **모두 충족되지 않으면 그 도구를 레지스트리에서 제거**해 LLM에 절대 전달하지 않는다. 미선언 도구는 항상 노출(하위호환).

### 2.2 단일 진실(source of truth)
이미 `ConfigField.required`(BaseConfig·ToolSettingSchema 공용, `service/config/base.py`, `tool_settings/base.py:120`)가 "필수 필드"를 안다. 게이트는 **이 required 메타를 그대로 소비**한다(편집기 UI와 동일 출처).

### 2.3 메커니즘 (2-레이어, executor-우선)

**Layer 1 — geny-executor 네이티브 게이트 (1급, 모든 백엔드·도구 공통):**
1. `Tool` ABC에 선택 선언 추가 — 예: `required_settings_key: str | None`(= ToolSettingSchema/`ctx.extras` 그룹 키) + `required_setting_fields: list[str]`, 그리고/또는 `required_credentials: list[str]`. 미선언=항상 통과(하위호환).
2. **단일 수렴점**인 `core/pipeline.py` `from_manifest`의 등록 직후(`:1199-1208`)에 **필터 패스** 추가: 각 등록 도구에 대해 선언된 필수 키를 (a) `pipeline._credentials`(CredentialBundle) + (b) attach될 `ToolContext.extras`(tool_settings)에 대조 → 미충족이면 **unregister** + `ToolResolutionReport`에 `gated_unconfigured` 버킷 기록(관측성).
   - 이 지점이 옳은 이유: 빌트인·external/adhoc(Geny 커스텀·팩)·executor 자체 도구가 **모두 하나의 registry로 수렴**. 상류(ToolLoader/Provider)에서 막으면 executor 자체 빌트인을 놓침. "어댑터가 아니라 executor를 확장" 원칙과도 일치.

**Layer 2 — Geny 측 보강 (빠른 적용 + executor 미선언 도구 커버):**
- `GenyToolProvider.get()`(`geny_tool_provider.py:75`) 또는 ToolLoader 단계에서, 도구가 가진 ToolSettingSchema의 required 필드가 해당 env의 `tool_settings`에 미충족이면 `None` 반환(= roster 미등록). GAPT의 `TOOLS=[] if not configured` 패턴을 **일반화**.
- 전역 config 의존 도구(예: blog_agent → `BLOG_AGENT_BASE_URL`/`API_KEY`, github → `GITHUB_TOKEN`)는 해당 BaseConfig `is_valid()`/`enabled` 검사로 게이팅.

### 2.4 기존 갭 일괄 수정 (Phase 0 산출물)
- `blog_agent_*` → BaseConfig 미설정/비활성 시 제외.
- `knowledge_*`/`opsidian_*` → LTM 기능 플래그 off면 제외.
- `web_search` 비-DDG → 키 없으면 백엔드 선택지에서 숨김(DDG는 무키라 도구 자체는 유지).
- `browser_*` → 브라우저 capability 없으면 제외(런타임 capability 게이트).
- `Task*`/`Cron*`/`Agent`/`SubAgent*` → 런타임 핸들 부재 시 제외(현재는 주입돼 있어 대개 OK지만 규약화).
- DB 커스텀/외부 서비스 도구 → required config 선언 의무화.

### 2.5 수용 기준
- 키 미설정 도구가 `state.tools`(LLM 목록)에 **나타나지 않음** + `ToolSearch` 결과/프롬프트에도 부재.
- 설정 추가 즉시(다음 세션 또는 라이브 재빌드) 도구 등장.
- 관측: `gated_unconfigured`로 "왜 안 보이는지" 로그/디버그 가능.

---

## 3. 설계 B — 신규 기본 도구 카탈로그

### 3.1 계층 전략 (재발명 금지)
- **T1 네이티브**: Google Workspace(핵심), 이메일, 캘린더, HTTP/REST 범용 — 빈도·가치 최고. executor 빌트인 또는 Geny 빌트인으로 1급 구현.
- **T2 큐레이션 MCP 커넥터**: 성숙한 MCP 서버를 **기본 커넥터 레지스트리**로 흡수. 각 커넥터 = {표시명, 아이콘, 필수 config(토큰/OAuth), MCP 실행 스펙}. config 충족 시에만 `mcp_servers`에 주입(=Phase 0 게이트가 MCP 서버에도 적용). Composio(1000+ toolkit) 단일 엔드포인트도 한 커넥터로 편입 가능.
- **T3 커스텀**: 기존 경로 유지(+required config 의무).

### 3.2 도메인별 카탈로그

| 도메인 | 대표 도구 | 필수 config / 인증 | 배치 | 참고 |
|---|---|---|---|---|
| **Google Workspace** | Gmail(읽기/보내기/검색), Calendar(일정 CRUD), Drive(검색/읽기/업로드), Docs/Sheets, Tasks, Contacts | **Google OAuth2** (scope별) | T1 네이티브 + T2(google_workspace_mcp) | google_workspace_mcp |
| **Google 기타** | YouTube(검색/자막/업로드), Maps/Places, Search(Programmable/Serp) | OAuth 또는 API key | T2 | — |
| **생산성** | Notion(페이지/DB CRUD), Slack(채널/메시지), Discord, Linear/Jira(이슈), Trello, Todoist, ClickUp | 봇토큰/OAuth/API key | T2 (MCP/Composio) | Notion·Slack·GitHub MCP, Composio |
| **개발** | GitHub 심화(이슈/PR/리뷰/검색), GitLab, Sentry | PAT/OAuth | T2 (official GitHub MCP) + 기존 `GITHUB_TOKEN` 재사용 | GitHub MCP |
| **커뮤니케이션** | Email(SMTP/IMAP), Telegram, SMS(Twilio), 일반 Webhook | SMTP 자격/봇토큰/계정SID | T1(email) + T2 | — |
| **웹/리서치** | 브라우저 자동화(Playwright), 스크래핑, 검색 백엔드 확장(Brave/Tavily/SearXNG/Serp), RSS | 키(검색)/capability(브라우저) | 기존 확장 + 게이트 | 기존 browser_tools |
| **미디어/생성** | 이미지 생성(FAL/Replicate/OpenAI/SD), TTS 확장, STT 확장, 비전/OCR, 음악 | media_credentials(FAL/Replicate 등) 재사용 | T1/T2 | 기존 media_credentials |
| **데이터** | SQL/DB 질의, 스프레드시트, HTTP/REST 범용 호출 | 연결 문자열/키 | T1(http) + T2 | — |
| **VTuber 특화** | 방송 제어(OBS), 라이브 채팅 통합(Twitch/YouTube Live/Chzzk), 화면 관찰, 음성 상호작용 | OBS WS 비번/스트림 키/플랫폼 OAuth | T1/T2 | Open-LLM-VTuber, AITuber OnAir, AI-Waifu-Vtuber, LocalAIVtuber |

### 3.3 VTuber/Agent 레퍼런스 (참고 출처)
- **VTuber**: [Open-LLM-VTuber](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber)(로컬 음성+Live2D), [AITuber OnAir], [AI-Waifu-Vtuber](https://github.com/ardha27/AI-Waifu-Vtuber)(Twitch 채팅), [LocalAIVtuber](https://github.com/0Xiaohei0/LocalAIVtuber)(게임 관전), [awesome-ai-vtubers](https://github.com/proj-airi/awesome-ai-vtubers). 공통 기능: TTS/STT, OBS 제어, Twitch/YouTube 라이브 채팅, RAG 메모리(ChromaDB), Discord 음성, 화면/게임 코멘터리, 플러그인 스킬, 관계(kizuna) 시스템 → Geny는 감정/아바타/음성/메모리·스킬을 이미 보유(해자), **방송 제어·라이브 채팅·화면 관찰**이 보강 후보.
- **에이전트 도구 생태계**: [google_workspace_mcp](https://github.com/taylorwilsdon/google_workspace_mcp), [awesome-mcp-servers](https://github.com/appcypher/awesome-mcp-servers), [Composio](https://github.com/ComposioHQ/composio)(1000+ toolkit, OAuth/인증/툴서치 내장), 공식 GitHub/Notion/Slack MCP, LangChain/LlamaIndex toolkits.

---

## 4. 인증 / OAuth 설계

핵심 분기: **API key형** vs **OAuth2형(Google 등)**.

- **API key형** (Notion/Slack/GitHub/검색/미디어): 기존 패턴 재사용 — BaseConfig(`secure` PASSWORD 필드) + `apply_change` env-sync, 또는 per-env ToolSettings. Phase 0 게이트가 키 유무로 자동 숨김.
- **OAuth2형 (Google Workspace — 최우선 인프라)**:
  - 필요한 것: client_id/secret(앱 등록), per-user **refresh token**, scope별 동의, 토큰 갱신.
  - 저장소: MCP credential store(`~/.geny/credentials.json`, `FileCredentialStore`)를 확장하거나 전용 OAuth 토큰 스토어 신설. **주의(메모리): OAuth는 샌드박스 간 공유 불가(refresh 회전) — 다중 인스턴스/샌드박스에서 토큰 회전 충돌**([[feedback_claude_oauth_no_share]] 원칙 준용). VTuber/세션이 여러 개면 토큰 회전 전략 필요.
  - UI: 설정에 "Google 연결" 카테고리 — OAuth 동의 플로우 개시(redirect) → 토큰 저장 → 연결 상태 표시(`설정됨`/`미설정`).
  - scope 단위 게이팅: Gmail-읽기 도구는 gmail.readonly scope 토큰이 있을 때만 노출(세분화).

---

## 5. 구현 로드맵 (Phase)

| Phase | 내용 | executor | Geny | 검증 |
|---|---|---|---|---|
| **0. 게이팅 인프라** ★선결 | §2 통합 config 게이팅 + 기존 갭 수정 | `Tool` required 선언 + `from_manifest` 필터 + ResolutionReport `gated_unconfigured` | `GenyToolProvider`/loader 보강, blog/knowledge/browser/web_search 게이트 적용 | 미설정 도구가 `state.tools`·ToolSearch·프롬프트에서 부재; 설정 시 등장 |
| **1. Google + OAuth 인프라** | OAuth2 토큰 스토어/플로우 + Gmail/Calendar/Drive/Tasks 네이티브(T1) + google_workspace_mcp 커넥터(T2) | (필요 시 OAuth-aware credential 주입) | OAuth 스토어/컨트롤러/UI, Google config 카테고리, 도구군 + ToolSettingSchema | OAuth 연결 → 도구 등장 → 실제 호출(테스트 계정) |
| **2. MCP 커넥터 레지스트리** | T2 큐레이션 커넥터(Notion/Slack/GitHub/Linear/…) + Composio 단일 커넥터, config-gated `mcp_servers` 주입 | (MCP 서버도 Phase 0 게이트 대상화) | 커넥터 카탈로그 + 설정 UI(연결/상태) | 토큰 설정 시에만 커넥터 도구 노출 |
| **3. 커뮤니케이션/데이터** | Email/Telegram/SMS/Webhook, SQL/HTTP 범용 | — | 도구군 + config | 도메인별 |
| **4. VTuber 특화** | OBS 제어, 라이브 채팅(Twitch/YouTube/Chzzk), 화면 관찰 | — | 도구군 + 플랫폼 OAuth/키 | 방송 환경 시연 |

각 Phase는 기존 PR 케이던스로 분할 배포. Phase 0은 **단독으로도 가치**(현재 깨진 progressive disclosure를 정상화).

---

## 6. 원칙 · 리스크

- **프롬프트 다이어트 준수**([[feedback_prompt_diet]]): 도구 설명/목록을 프롬프트에 넣지 않는다 — 스키마(MCP/API tool defs)로 전달. 신규 도구는 프롬프트 비대화 없이 추가.
- **executor를 확장, 어댑터 다층화 금지**([[feedback_extend_executor_not_adapter_layer]]): 게이팅·공통 도구는 executor 1급으로(모든 백엔드 공통).
- **정책은 config로, 하드코딩 금지**([[feedback_policy_config_not_hardcode]]): 기본 deny + config 편집 가능.
- **OAuth 샌드박스 공유 불가**([[feedback_claude_oauth_no_share]]): Google 다계정/다세션 토큰 회전 설계 선행.
- **보안**: 외부 쓰기/파괴적 도구는 `capabilities`(destructive/network_egress) 선언 + 권한 매처. 비밀값은 `secure` 필드 + 마스킹.
- **MCP vs 네이티브 트레이드오프**: 네이티브=지연/제어 우수·유지비↑, MCP=생태계 즉시 흡수·프로세스 경계. 핵심만 T1, 나머지 T2.
- **재동기화**: 도구 크레덴셜 변경 시에도 라이브 세션 반영 경로(`refresh_all_session_credentials` 유사) 필요.

---

## 7. 다음 단계
1. 본 리포트 검토 → Phase 0 설계 확정(특히 `Tool` required 선언 형태 + 게이트 위치).
2. Phase 0 구현·배포(게이팅 정상화 + 기존 갭 수정) — 단독 가치.
3. Phase 1(Google+OAuth)부터 도메인 확장.

> 참고 파일(현재 상태): executor `tools/base.py`·`tools/built_in/__init__.py`·`core/pipeline.py(1187-1208)`·`s03_system/.../stage.py(169)`·`s10_tool/.../stage.py(166)`; Geny `service/tool_loader.py`·`service/executor/geny_tool_provider.py`·`service/tool_settings/base.py`·`service/config/base.py`·`service/executor/{credentials.py,agent_session.py(2611-2670),agent_session_manager.py(945-1080)}`·`service/environment/{templates.py,service.py(738)}`·`tools/built_in/gapt_tools.py(260)`(유일한 기존 게이트, 일반화 템플릿).
