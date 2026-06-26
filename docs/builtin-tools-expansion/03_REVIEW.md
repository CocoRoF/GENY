# 빌트인 도구 대확장 — 검토 리포트 (사용자용)

> 2026-06-26 · 전 Phase prod 배포·검증 완료. 무엇이 만들어졌고, 어떻게 보면 되는지.
> 상세 설계: [01_REPORT.md](01_REPORT.md) · 진행 로그: [02_PROGRESS.md](02_PROGRESS.md)

---

## 1. 한눈에

Geny를 "프론트엔드에서 클릭만으로 강력한 도구를 붙이는" 플랫폼으로 만들었습니다.
핵심 규칙 하나로 관통합니다 — **설정 안 된 도구는 에이전트에게 아예 안 보인다(progressive disclosure)**.

| Phase | 무엇 | 상태 |
|---|---|---|
| 0 · 게이팅 인프라 | 필수 config 없는 도구를 LLM 도구목록에서 자동 숨김 | ✅ 라이브·검증 |
| 1 · Google Workspace | Gmail/Calendar/Drive/Tasks 네이티브 9도구 + OAuth(기기 인증) | ✅ 라이브 |
| 2 · MCP 커넥터 레지스트리 | GitHub/Notion/Slack/Composio/… + **임의 MCP 서버 연결** | ✅ 라이브 |
| 3 · 통신/데이터 | 네이티브 email 전송 + 범용 HTTP 호출 | ✅ 라이브 |
| 4 · VTuber 실시간 | (선택) OBS/방송/라이브챗 — custom_http로 연결 가능, 네이티브는 보류 | 구조 완비 |

검증(prod): executor `2.37.0`, 백엔드 healthy, 커넥터 8종, Google 미연결 시 google 도구 0개, email 미설정 시 email_send 숨김·http_request 노출, knowledge는 LTM 켜짐이라 노출.

---

## 2. 만들어진 것 (Phase별)

### Phase 0 — 게이팅 (가장 중요한 토대)
- 도구가 `REQUIRED_CONFIG` 토큰을 선언하면, 그 config가 충족될 때만 노출됩니다.
  토큰: `config:<이름>`(전역 설정) · `setting:<키>`(환경별) · `feature:<플래그>`.
- 미충족 도구는 **레지스트리에 등록조차 안 되어 엔진(geny-executor)에 전달되지 않음** —
  과거엔 노출 후 호출 시 실패하던 안티패턴을 제거.
- 적용 예: `knowledge_*` 7종은 LTM 큐레이션 지식이 켜져야만 보임.
- 코드: `service/executor/tool_config_gate.py`, `geny_tool_provider.py`(Geny 도구),
  geny-executor `from_manifest(satisfied_config=)`(executor 네이티브 도구).

### Phase 1 — Google Workspace (네이티브)
- **9개 도구**: `gmail_search/read/send`, `calendar_list_events/create_event`,
  `drive_search/read`, `tasks_list/add` — geny-executor 2.37.0 네이티브(우리가 세부조작 제어).
- **연결 = OAuth 기기 인증(Device Flow)**: 리다이렉트 URL/도메인 불필요(현재 IP:포트 배포에서 동작).
- 도구는 `feature:google_connected`로 게이팅 → 연결 전엔 안 보임.
- 코드: executor `tools/built_in/google_tools.py`; Geny `service/google/oauth.py`,
  `controller/google_controller.py`, `GoogleConfig`.

### Phase 2 — MCP 커넥터 레지스트리 (생태계 연동의 핵심)
- 커넥터 = 설정 가능한 MCP 서버. 활성+설정하면 그 서버가 세션에 연결되어 도구가 등장.
- **카탈로그 8종**: `custom_http`(아무 MCP나 URL로 연결 — 만능), `github`(HTTP+PAT),
  `notion`(npx+토큰), `composio`(HTTP, 1000+ 앱), `slack`/`postgres`/`brave`/`filesystem`(npx).
  ※ npx 커넥터는 백엔드에 node 필요 → **확인됨(npx 있음)**.
- 커넥터별로 숨김 설정(config)이 자동 생성 → 미설정/비활성이면 세션에 주입 안 됨.
- 코드: `service/mcp_connectors/catalog.py`, `controller/connectors_controller.py`.

### Phase 3 — 통신/데이터 (네이티브)
- **`email_send`**: SMTP로 메일 전송. Settings→Tool의 Email 설정 시 등장(미설정 시 숨김).
- **`http_request`**: 인증 헤더/JSON 바디 지원 범용 REST 호출(GET/POST/PUT/PATCH/DELETE).
  항상 사용 가능(WebFetch의 GET 전용을 보완).
- 코드: `tools/built_in/{email_tools,http_tools}.py`, `EmailConfig`.

---

## 3. 어떻게 쓰나 (프론트엔드)

모두 **Settings(설정)** 에서:

1. **Google** 카드 → Google Cloud OAuth 클라이언트(Desktop/TV형) id+secret 입력 → 저장 →
   **Connect** → 화면의 코드를 google.com에서 입력·승인 → 끝. Gmail/캘린더/드라이브/태스크 도구 자동 등장.
2. **Connectors** 카드 → 원하는 커넥터 **활성 + 토큰/URL 입력 → 저장**. 즉시 그 도구가 등장.
   - GitHub: PAT · Notion: 토큰 · Slack: 봇토큰+팀ID · Postgres: 연결문자열 · Brave: API키 · Filesystem: 경로
   - **임의 MCP 서버**: `Custom MCP (HTTP)`에 URL(+선택 토큰)만.
3. **Tool 카테고리** → **Email** 설정(SMTP) 시 `email_send` 등장. `http_request`는 기본 제공.
4. 환경별로 더 좁히고 싶으면 **환경관리(/environments)** 편집기에서 도구/설정 조정.

핵심 UX: **설정한 것만 보인다.** 미설정 커넥터/도구는 에이전트의 도구 목록에 나타나지 않습니다.

---

## 4. 검증 상태 (prod 라이브)
- 게이팅 양방향: LTM 큐레이션 OFF→knowledge 도구 `🚫 gated` 후 부재 / ON→노출 (가역 테스트).
- Google: `/api/google/status` 200, 미연결 시 워커 세션 google 도구 0개.
- 커넥터: `/api/connectors` 8종, 미활성 시 주입 안 됨(`configured_mcp_servers()==[]`).
- 통신: email 미설정→`email_send` 숨김, `http_request` 노출.
- executor 2.37.0 컨테이너 반영, 백엔드 healthy.

---

## 5. 더 붙이려면 (확장 방법)
- **MCP 서버**: 카탈로그(`catalog.py`)에 한 줄 추가하거나, 지금 바로 `Custom MCP (HTTP)`로 연결.
- **네이티브 도구**: Google과 동일 패턴 — executor/Geny에 도구 작성 + config + `REQUIRED_CONFIG` 한 줄.

## 6. 남은 것 (선택)
- Phase 4 VTuber 실시간(OBS 제어·Twitch/YouTube/치지직 라이브챗·화면): MCP 서버가 있으면
  `custom_http`로 지금 연결 가능. 네이티브 실시간 통합은 플랫폼 계정·실행 대상이 있어야
  의미있게 구현/검증되므로 필요 시 지정해 주시면 Google식으로 추가합니다.

## 7. 커밋/파일 참조
- geny-executor `2.37.0`(게이팅 + google_tools) — PyPI.
- Geny: `c60042c0`(Google) · `1bb7de5b`(connectors) · `93bc4932`(email/http) · `87593c18`(게이팅) · `f0e5b1d8`(docs).
- 코드 맵: 위 각 Phase의 "코드:" 줄 참고.
