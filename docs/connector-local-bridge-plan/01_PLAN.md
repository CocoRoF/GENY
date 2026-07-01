# 접속기 로컬 브리지 — Local MCP 프록시 + Computer Use (완벽 계획)

> 목표: Geny 접속기를 **프록시**로 만들어 `사용자 로컬 컴퓨터 ↔ 접속기 ↔ Geny 서버(웹 에이전트)`를
> 연결한다. 두 능력을 구현한다.
> **① Local MCP 프록시** — 사용자가 접속기에 로컬 MCP 서버를 등록하면, 서버에 떠 있는 Geny
> 에이전트가 그 로컬 MCP 도구를 접속기를 통해 호출할 수 있다.
> **② Local Computer Use** — 에이전트가 접속기를 통해 사용자의 로컬 컴퓨터를 관찰·조작한다
> (화면 캡처, 타이핑, 클릭, 앱 열기 등).
>
> 상태: **Phase 0 (계획)**. 아래는 세 레포(geny-executor / Geny / 접속기)를 직접 코드로 검증한
> 결과에 기반한 설계다.

---

## 0. 한 줄 요약 — 왜 이 계획이 작아지는가

핵심 발견: **역방향 capability 브리지(inverse-MCP)는 이미 존재하며 Computer Use는 ~80% 완성돼 있다.**
서버 에이전트가 `/ws/connector/{session_id}` 소켓으로 로컬 능력을 원격 호출하고 결과를 받는 전 구간
(RPC future 상관, fail-closed, 마스터 스위치 + 네이티브 확인, nut.js 실행)이 프로덕션에 살아 있다.

따라서 이 작업은 "밑바닥부터 구현"이 아니라 **기존 브리지 위에 (a) 제대로 된 설정 UX/게이팅, (b)
로컬 MCP 프록시 절반, (c) 하드닝을 얹는 것**이다. 이 문서는 그 정확한 seam들을 못박는다.

---

## 1. 역할 분리 (요청의 핵심) — 불변식

세 레포의 책임을 **엄격히** 나눈다. 어떤 로컬 능력 로직도 서버/엔진으로 새면 안 된다.

| 레이어 | 레포 | 책임 | 이 기능에서 하는 일 | **하지 않는 것** |
|---|---|---|---|---|
| **엔진** | `geny-executor` | 능력-불가지론적 도구 실행. Tool ABC, MCP 클라이언트(in-process), adhoc provider, `tools.external` 해석 | 접속기 위임 도구를 **평범한 Tool**로 취급 (execute = async RPC). MCP·Computer Use 개념 자체를 모름 | 접속기/로컬/컴퓨터의 존재를 알지 못함. 코드 변경 **거의 0** |
| **서버(허브)** | `Geny/backend` | 세션별 도구 조립, 게이팅, **순수 프록시/라우터** | capability_call·mcp_call 프레임을 접속기로 라우팅. 세션↔접속기 레지스트리. 어떤 도구를 노출할지 정책 결정 | 로컬 실행 안 함. 로컬 MCP 설정을 **저장하지 않음**(프라이버시). 도구 목록만 통과 |
| **접속기** | `Geny/desktop` | **유일한 로컬 실행 지점 + 유일한 로컬 동의(consent) 지점** | 로컬 MCP 클라이언트 호스팅, nut.js 실행, 화면 캡처, 마스터 스위치 + 동의 UI, 로컬 설정 저장 | 정책/에이전트 로직 없음. 서버가 시킨 것을 **동의 하에** 실행만 |

**불변식 3개:**
1. **로컬 실행과 로컬 동의는 오직 접속기에.** 서버는 무엇이 실행됐는지 라우팅만 하지, 승인 권한이 없다.
2. **서버는 순수 프록시.** 로컬 MCP 서버 설정(커맨드/키/경로)은 절대 서버 DB에 저장하지 않는다. 서버는
   접속기가 광고한 *도구 목록(스키마)*만 알고, 실행은 항상 접속기로 되돌린다.
3. **엔진은 불가지론적.** 접속기 도구는 `ToolContext.extras` 위임 패턴을 쓰는 일반 Tool일 뿐 —
   executor에 "connector"라는 단어가 들어가지 않는다. (executor 재설치/수정 없이 확장)

---

## 2. 현재 아키텍처 — 이미 존재하는 것 (코드 검증됨)

### 2.1 역방향 RPC 브리지 (완성)
```
서버 에이전트 턴                                        접속기(로컬)
─────────────                                          ───────────
ConnectorCapabilityTool.execute()
  → registry.get(session_id).capability_call(tool,args)
      │  {type:capability_call, data:{request_id,tool,args,reason}}
      ▼  (send_lock 직렬화, request_id future 상관)
   /ws/connector/{session_id} ──────────────────────▶ ConnectorBridgeClient (overlay 창)
                                                        handleCall() switch(tool)
                                                          → window.connector.actuate.* / capture.*
                                                            (main: 마스터 스위치 + 네이티브 확인 + nut.js)
      ◀────────────────────────────────────────────── {type:capability_result, data:{request_id,ok,result?,error?,denied?}}
   resolve_result(request_id) → future
  ← ToolResult(content) → 에이전트
```
- **서버측 파일**: `ws/connector_stream.py:27-75` (WS 핸드셰이크·수신 루프), `service/executor/connector_registry.py`
  (`ConnectorConnection.capability_call` 34-50, `ConnectorRegistry` 64-98, **fail-closed** `cancel_all` 57-61),
  `service/executor/connector_bridge.py` (`ConnectorCapabilityTool` 26-88, `ConnectorToolProvider` 252-268).
- **접속기측 파일**: `frontend/.../ConnectorBridgeClient.tsx:1-201` (overlay에 마운트, WS 재연결·heartbeat),
  `desktop/src/preload/index.ts:203-212` (`capture.listSources`, `actuate.openApp/type/key/click/clipboardWrite`),
  `desktop/src/main/index.ts` (트레이 마스터 스위치 830-837, `runActuation` 933-952 = 게이트+네이티브 확인,
  `loadNut` 954-977, actuate IPC 1121-1156).
- **인증/바인딩**: WS는 실제 JWT 요구(익명 거부, `connector_stream.py:29-36`); URL 경로의 `session_id`가
  에이전트 세션을 지목; 세션당 접속기 1개(last-writer-wins).

### 2.2 이미 동작하는 Computer Use 도구 (7종, 하지만 "잠자는 중")
`connector_bridge.py:_build_tools()` — `connector_ping`, `desktop_glance`(캡처→비전 캡셔닝),
`desktop_window_list`, `desktop_open_app`, `desktop_clipboard_write`, `desktop_type`, `desktop_key`,
`desktop_click`. 모두 end-to-end 배선 완료. **destructive 도구는 매트릭스가 PLAN 모드에서 ASK로 승격.**

### 2.3 도구가 세션에 붙는 방식 (활성화 seam)
`agent_session_manager.py`:
- `adhoc_providers`에 `ConnectorToolProvider()` 항상 추가(1000-1002) — 그러나 **`manifest.tools.external`이
  이름을 고르기 전까지는 inert**.
- **활성화 메커니즘**: `extra_external_tools`로 넘긴 이름들이 `tools.external`에 union됨
  (`instantiate_pipeline(..., extra_external_tools=_extra_tools)` 1131-1139). 이게 sandbox pack·gapt
  lifecycle 도구가 "per-env 재시드 없이" 켜지는 바로 그 seam이다 (1109-1119).
- **게이팅**: `compute_satisfied_config()`(988) → `GenyToolProvider(satisfied_config=...)` + executor의
  `from_manifest` 필터 이중 게이팅. `config:` / `feature:` / `setting:` 토큰 미충족 도구는 엔진에 도달조차 못 함.

### 2.4 엔진의 위임 seam (executor)
- `Tool` ABC(`tools/base.py:263-421`) + `build_tool()`(428-540): 서브클래싱 없이 도구 생성 가능.
- `ToolContext.extras`(base.py:160): 매 dispatch마다 라이브 복사 — 런타임 상태 위임 표준
  (`subagent_manager`, `web_search`, `agent_orchestrator` 선례).
- **MCP 클라이언트는 executor 내부**(`tools/mcp/manager.py:109-289`) — 서버측/원격 MCP 전용.
  → **로컬 MCP는 여기 못 붙는다**(로컬 fs/앱 접근 불가). 그래서 접속기 프록시가 필요한 것.
- `tools.external` 해석: `core/pipeline.py:_register_external_tools:507-540`.

### 2.5 그래서 빠진 것 (이 계획의 실제 작업량)
| # | 빠진 것 | 규모 |
|---|---|---|
| A | Computer Use를 **켜는 UX** (지금은 tools.external에 손으로 넣어야 함). 세션/환경 opt-in + `feature:` 게이트 | 소 |
| B | **제대로 된 접속기 설정 UI** — 마스터 스위치가 트레이 체크박스 하나. 세분 동의·동의 모드·활동 로그·allowlist 없음 | 중 |
| C | **Local MCP 프록시 전체 (접속기측)** — 로컬 MCP 클라이언트 호스팅·설정·광고·`mcp_call` 핸들러 없음 | 대 |
| D | **Local MCP 프록시 전체 (서버측)** — 동적 MCP 도구 발견·등록, `mcp_call` capability, 네임스페이싱, 캐시 없음 | 대 |
| E | **Computer Use 하드닝** — 모델용 스크린샷(좌표계), 커서/스크롤/드래그, DPI, 동의 모드 | 중 |

---

## 3. 목표 아키텍처

### 3.1 Local Computer Use (기존 위 하드닝)
접속기 설정에 **"로컬 컴퓨터 제어"** 섹션 신설. 트레이 체크박스를 대체(상위 개념)하고 세분화한다.
- **마스터 토글** + **능력별 토글**: 화면 보기 / 타이핑 / 클릭·마우스 / 앱·URL 열기 / 클립보드.
- **동의 모드(consent mode)**: `항상 확인`(현행 기본) · `이 세션 동안 허용` · `자동 허용`(위험, 기본 off).
- **활동 로그**: 에이전트가 로컬에서 한 모든 행동(도구·인자·결과·시각) 감사 뷰.
- **allowlist**(선택): `open_app` 대상 화이트리스트.
- **Computer-use proper (Phase E)**: 비전 모델이 스크린샷을 **직접 보고 좌표로 조작** —
  Anthropic computer-use 도구 형태 정렬 (현재 `desktop_glance`는 캡션 텍스트만 반환).
  좌표계·DPI 스케일 정규화 포함.

### 3.2 Local MCP 프록시 (신규 절반)
```
접속기 main 프로세스                     서버                              엔진
──────────────────                     ────                             ────
로컬 MCP 클라이언트들 (stdio/http)
  @modelcontextprotocol/sdk
  ├ fs-server (npx ...)
  ├ sqlite-server (uvx ...)
  └ ...
      │ (1) hello에 mcp_servers + 각 도구 스키마 광고
      ▼
 /ws/connector ──▶ ConnectorConnection.local_mcp = {server:[tools...]}
                     ConnectorMCPToolProvider (세션별)
                       → lmcp__<server>__<tool> Tool N개 동적 생성   ──▶ tools.external union
                                                                          → 엔진이 일반 도구로 노출
 에이전트가 lmcp__fs__read_file 호출
      ◀── capability_call{tool:"mcp_call", args:{server,tool,arguments}}
 main: mcp 클라이언트.callTool() 실행 ──▶ 결과
      ──▶ capability_result{ok,result}
```
- **접속기측**: main에 `MCPManager`(로컬 MCP 서버 spawn/connect/list/call), 설정 저장(userData JSON,
  **서버로 안 나감**), preload `window.connector.mcp.*`, overlay 브리지에 `case 'mcp_call'` 추가.
- **서버측**: `hello` 확장(`mcp_servers` 수신), `ConnectorConnection.local_mcp` 캐시,
  `ConnectorMCPToolProvider`(동적 `lmcp__*` 도구), `mcp_call` capability, `feature:local_mcp` 게이트.
- **네임스페이스**: 서버측 원격 MCP는 `mcp__<server>__<tool>`; **로컬은 `lmcp__<server>__<tool>`**로 구분.

---

## 4. 설계 결정 (하드 초이스)

### D1. 활성화(enablement) = 접속기 동의(로컬) × 환경 opt-in(서버)
두 게이트를 **AND**로 결합. 하나라도 꺼지면 도구 미노출.
- **접속기(로컬)**: 사용자가 "컴퓨터 제어"·"MCP"를 켜야만 접속기가 capability를 광고/실행. 로컬 주권.
- **서버(환경)**: 환경 설정에 `feature:computer_use` / `feature:local_mcp` 토큰 → `compute_satisfied_config`
  게이트 통과 + `extra_external_tools` union으로 세션에 주입. 재사용 seam은 §2.3 그대로.
- 근거: 로컬 동의 없이 서버가 강제 못 하고(불변식 1), 사용자가 환경별로 "이 페르소나에게만 제어 허용"
  같은 정책도 가능.

### D2. Local MCP 동적 등록 — MVP는 제네릭 디스패처, V2는 1급 도구
접속기는 세션 생성 *이후*에 붙는다(비동기·재연결). 그래서 세션 빌드 시점엔 로컬 MCP 도구 목록을 모른다.
- **MVP (Phase 4a)**: 정적 도구 2개만 등록 — `local_mcp_list()`(라이브 카탈로그 반환) +
  `local_mcp_call(server, tool, arguments)`(제네릭 디스패처). 엔진 변경 0, 즉시 동작. 단점: 모델이
  개별 스키마를 1급으로 못 받음.
- **V2 (Phase 4b)**: 접속기 hello의 스키마로 `lmcp__<server>__<tool>` **1급 도구**를 세션에 동적 등록해
  모델 신뢰도↑. **선행 검증 필요**: executor 레지스트리가 턴 사이 라이브 mutation을 지원하는지
  (`pipeline.py` 레지스트리 재-스냅샷 여부). 지원하면 connector 연결 시점에 도구를 patch, 미지원이면
  세션 재시드로 union.
- 권장: **MVP 먼저 배포**(가치 즉시), 검증 후 V2.

### D3. 단일 소켓, 제네릭 프레임
`/ws/connector` 하나로 computer-use(`capability_call`)와 MCP(`mcp_call`)를 모두 나른다. `mcp_call`은
`ConnectorCapabilityTool`의 capability 한 종류로 추가 — 새 소켓/프로토콜 불필요. 대용량 결과(스크린샷
base64·MCP 큰 페이로드)는 타임아웃 상향 + 크기 제한 + 필요 시 청크.

### D4. 로컬 MCP 설정은 접속기에만 저장
커맨드/args/env(키 포함)/경로는 접속기 userData JSON에만. 서버엔 **도구 이름·스키마·설명만** 광고로 전달
(실행 인자는 매 호출 접속기가 자기 설정에서 해석). 프라이버시·불변식 2.

### D5. 왜 서버 in-process MCP를 재사용하지 않나
executor는 이미 MCP 클라이언트를 갖지만 **서버에서** 뜬다 → 사용자의 로컬 fs/앱/로컬 네트워크에 접근
불가. 로컬 MCP의 존재 이유가 바로 그 로컬 자원 접근이므로 반드시 접속기가 호스팅. (서버 MCP =
GAPT·원격 커넥터용, 로컬 MCP = 접속기 프록시용 — 명확히 분리.)

---

## 5. 보안 모델

- **웹 세션이 로컬 머신을 조작한다**는 본질적 위험 → 다층 방어:
  1. WS는 실제 JWT만(익명 거부), 세션당 접속기 1개, 프론트가 소유 세션만 소켓 오픈.
  2. 모든 로컬 실행은 접속기 **마스터 스위치 + 능력별 토글 + 동의 모드**를 통과. 기본은 `항상 확인`.
  3. **fail-closed**: 접속기 드롭 시 모든 pending future에 transport error → 턴이 절대 안 멈춤.
  4. **활동 로그** + destructive 도구의 매트릭스 ASK 승격(HITL).
  5. `open_app` allowlist(선택), MCP 서버별 enable/도구별 allow.
  6. 타임아웃(capability_call 기본 30s), 결과 크기 상한, 인자 로깅 시 민감값 레닥션.
- **확인 필요(열린 질문)**: 서버측이 "이 JWT 사용자가 이 session_id의 소유자"임을 명시 검증하지 않음
  (현재 프론트가 강제). 로컬 제어 소켓엔 서버측 소유권 assert를 추가할지 → **Phase 1에서 강화 권장.**

---

## 6. 단계별 구현 (연속 PR 카덴스, 각 배포·검증 가능)

> 원칙(durable): 작은 PR, 각자 배포+헤드리스 검증. 프론트 변경=prod 배포, 접속기 변경=릴리스.
> executor는 가능하면 손대지 않음(불변식 3).

**Phase 0 — 계획(본 문서).** ✅

**Phase 1 — Computer Use 활성화 UX + 서버 소유권 강화 (소).**
- 접속기 ControlApp에 **"로컬 컴퓨터 제어"** 카드/탭: 마스터 + 능력별 토글(캡처는 기존 `captureArmed`,
  actuation은 기존 `automationEnabled` 재사용 + 세분화), 동의 모드 셀렉트.
- 서버: `feature:computer_use` 토큰 게이트 + 환경 opt-in 시 desktop_* 이름을 `extra_external_tools`에 union.
- `connector_stream.py`에 세션 소유권 assert 추가(§5 열린 질문).
- 검증: 환경 opt-in → 세션에서 `connector_ping`/`desktop_glance` 실사용, 동의 다이얼로그 확인.

**Phase 2 — Computer Use 하드닝 (중).**
- 활동 로그(접속기 로컬 뷰 + 각 actuation 기록), 동의 모드 3종 실제 동작(세션 허용 캐시), allowlist.
- `desktop_glance` 외 **모델용 스크린샷**(좌표 포함 이미지 반환) 경로 설계 + 커서 위치/스크롤/드래그/다중키.
- DPI·좌표계 정규화(멀티모니터).

**Phase 3 — Local MCP: 접속기측 (대).**
- main `MCPManager`(`@modelcontextprotocol/sdk`): stdio/http 로컬 MCP spawn/connect, `listTools`, `callTool`,
  재연결·헬스. 설정 스키마(`mcpServers: [{name, transport, command/args/env | url/headers, enabled}]`) userData 저장.
- preload `window.connector.mcp.{listServers,listTools,callTool,test}`; overlay 브리지 `case 'mcp_call'`.
- ControlApp **"MCP"** 탭: 서버 추가/편집/삭제/테스트, 연결 상태, 발견 도구 수, per-server enable.
- hello 확장: `capabilities`에 `mcp_call` 추가 + `mcp_servers`(이름·도구 스키마) 광고.

**Phase 4a — Local MCP: 서버측 MVP (중).**
- `connector_stream.py` hello에서 `mcp_servers` 수신 → `ConnectorConnection.local_mcp` 저장.
- 정적 도구 2개: `local_mcp_list` + `local_mcp_call`(→ `mcp_call` capability 위임). `feature:local_mcp` 게이트.
- 검증: 로컬 fs MCP 등록 → 에이전트가 `local_mcp_list`→`local_mcp_call('fs','read_file',...)` 성공.

**Phase 4b — Local MCP: 1급 도구 승격 (중, D2 검증 후).**
- executor 레지스트리 라이브-mutation 검증. 가능하면 접속기 연결 시 `lmcp__<server>__<tool>` 1급 등록,
  아니면 세션 재시드 union. 모델이 개별 스키마 직접 사용.

**Phase 5 — 폴리시·관측·문서 (소).**
- MCP 설정 변경 시 재광고→서버 카탈로그 무효화·재빌드, 에러 UX, 재연결 견고화, `docs/` 사용자 가이드,
  `02_PROGRESS.md` 기록.

---

## 7. 확정된 결정 (2026-07-01, 사용자)

1. **범위**: ① Computer Use + ② Local MCP **둘 다 끝까지**(Phase 1~5 전부). 병렬 의도이나 의존성 순서로
   PR 카덴스 진행.
2. **동의 기본값 = 능력별로 다르게(D1 세분)**:
   - **화면 보기**(`screen_capture`/`window_list`, read-only) → 기본 **자동 허용**(기존 `captureArmed` 재사용;
     관찰 스트림 off 시 `liveOnly` 거부하는 프라이버시 게이트는 유지).
   - **조작**(`type`/`key`/`click`/`scroll`/`drag`) → 기본 **항상 확인**. 단 확인 다이얼로그가
     **"이 세션 동안 허용"** 옵션을 제공(진짜 computer-use는 클릭이 수십 번 → 매번 확인은 비현실적).
   - **앱·URL 열기 / 클립보드 쓰기** → 기본 **항상 확인**.
   - 모든 기본값은 설정에서 능력별로 변경 가능.
3. **Computer-use proper = 이번에 진짜 컴퓨터 제어까지.** 비전 모델이 **스크린샷을 직접 보고 좌표로
   조작**(Anthropic computer-use 도구 형태). `desktop_glance`(캡션 텍스트)는 경량 보조로 유지하되,
   신규 `computer` 도구가 스크린샷 이미지 블록을 반환 + 좌표 액션. DPI/좌표계 정규화 필수.

**남은 기술 열린 질문(구현 중 검증):**
- **Local MCP 1급 등록(D2/V2)**: executor 레지스트리 라이브-mutation 지원 여부 → 미지원 시 세션 재시드 union.
  MVP(제네릭 디스패처)로 먼저 배포 후 검증.
- **서버측 세션 소유권 assert**: Phase 1에서 추가.

---

## 8. 파일 맵 (건드릴 곳)

**접속기 (`Geny/desktop`)**
- `src/main/index.ts` — 트레이 마스터(830-837)→설정 위임, `runActuation`(933) 동의모드/로그 확장, **신규
  `MCPManager`**(로컬 MCP spawn/connect/call), IPC `mcp:*`, actuation 세분 게이트.
- `src/preload/index.ts` — `capture`/`actuate`(203-212) 옆에 **`mcp` 서피스** + 동의모드/로그 API 추가.
- `src/renderer/src/ControlApp.tsx` — **"로컬 컴퓨터 제어"** 탭/카드 + **"MCP"** 탭 신설.
- `package.json` — `@modelcontextprotocol/sdk` 의존성, 버전 범프.

**프론트 (`Geny/frontend`)**
- `src/components/live2d/ConnectorBridgeClient.tsx` — `CAPABILITIES`에 `mcp_call` 추가, `handleCall`에
  `case 'mcp_call'`(→ `window.connector.mcp.callTool`), hello에 `mcp_servers` 광고.
- `src/types/connector-bridge.d.ts` — `mcp` 서피스 타입.

**서버 (`Geny/backend`)**
- `ws/connector_stream.py` — hello `mcp_servers` 수신·저장, 세션 소유권 assert.
- `service/executor/connector_registry.py` — `ConnectorConnection.local_mcp` 필드 + 접근자.
- `service/executor/connector_bridge.py` — `mcp_call` capability, **신규 `ConnectorMCPToolProvider`**
  (`local_mcp_list`/`local_mcp_call` MVP → `lmcp__*` 1급 V2).
- `service/executor/agent_session_manager.py` — `feature:computer_use`/`feature:local_mcp` 게이트 +
  desktop_*/lmcp_* 이름을 `extra_external_tools` union(1109-1139 패턴 재사용).
- `service/executor/tool_config_gate.py` — 신규 feature 토큰.
- 환경 편집 UI/서비스 — 환경별 `feature:computer_use`/`feature:local_mcp` opt-in 노출.

**엔진 (`geny-executor`)** — **변경 없음 목표.** (D2/V2에서 라이브 등록 seam이 필요하면 그때만 최소 확장.)

---

## 9. 검증 전략
- 각 PR: `tsc --noEmit`(프론트·접속기), 접속기 `build`, 백엔드 임포트 스모크.
- Phase 1/2: 헤드리스로 세션에 접속기 붙이고 `connector_ping`·`desktop_glance` 왕복, 동의 다이얼로그 확인.
- Phase 3/4: 실제 로컬 MCP(예: `@modelcontextprotocol/server-filesystem`) 등록 → `local_mcp_list` 카탈로그 →
  `local_mcp_call` 실행 성공, fail-closed(접속기 끊으면 클린 에러) 확인.
- 보안: 마스터 off·능력 off·동의 거부 각각에서 도구가 안전 실패하는지.
```
```

> 다음 문서: `02_PROGRESS.md`(구현 착수 시). 본 계획 확정 후 Phase 1부터 PR 카덴스로 진행.
