# 접속기 로컬 브리지 — 진행 상황

계획: [01_PLAN.md](01_PLAN.md). 확정 결정(2026-07-01): 두 기능 끝까지 · 능력별 동의 · 진짜 컴퓨터 제어.

## 상태 보드
| Phase | 내용 | 상태 |
|---|---|---|
| 0 | 계획 문서 | ✅ 완료 |
| 1 | Computer Use 활성화 UX(능력별 동의) + 서버 게이트 | ✅ 코드 완료 (배포/검증 중) |
| 2 | Computer Use 하드닝 — 진짜 스크린샷-좌표 `computer` 도구 | ◻ 대기 |
| 3 | Local MCP — 접속기측(MCPManager·설정·광고·mcp_call) | ◻ 대기 |
| 4a | Local MCP — 서버측 MVP(local_mcp_list/call, feature 게이트) | ◻ 대기 |
| 4b | Local MCP — lmcp__ 1급 도구 승격(D2 검증 후) | ◻ 대기 |
| 5 | 폴리시·관측·문서 | ◻ 대기 |

## Phase 1.5 — sub-agent 위임 경로 (라이브 테스트 반영)
사용자 실기기 테스트: VTuber가 데스크톱 작업을 **owned companion(pair)** 에게 위임하는데, companion이
`desktop_*` 도구가 없어 샌드박스 `Bash`로 시도→실패. 3원인 규명 후 **Geny-only** 수정(executor 무변경):
- **원인①** opt-in은 세션 빌드 시점에 union → 기존 세션엔 없음(재시작 필요).
- **원인②** sub-agent 매니페스트의 `tools.external`이 connector 도구를 포함 안 함(sub-worker=allowed_tools만,
  companion=부모 env clone이라 런타임 union 우회).
- **원인③** sub-agent는 파생 session_id로 실행 → `capability_call`이 connector 못 찾음("offline").
- **수정**: connector 도구명을 두 sub-agent 팩토리(sub-worker `factories._build_sub_manifest`, companion
  `sub_agent_bridge._make_parent_env_companion_factory`) 매니페스트 external에 union
  (`SubagentRegistryBuilder(extra_external_tools=)` / `spawn_owned_subagent(extra_external_tools=)` 배선).
  `ConnectorRegistry.get()`에 **최장 프리픽스 폴백** 추가 → companion `{parent}-subagent` / sub-worker
  `{parent}-{type}-{uuid}` 모두 부모 세션 connector로 라우팅. 라우팅 로직 단위검증 통과.
- **주의**: opt-in 후 **세션 재시작** 해야 메인+companion이 도구를 받음(빌드 시점 union).

## 로그
- 2026-07-01: 3-레포 아키텍처 조사 완료(inverse-MCP 브리지 ~80% 기존 확인). 계획서 작성, 결정 확정.
- 2026-07-01: **Phase 1 코드 완료** (connector v0.11.8 + 프론트/백엔드).
  - 접속기: `computerUse` 설정(마스터+능력별 screen/input/apps/clipboard + 동의모드 ask/session/auto),
    `runActuation(cap,...)` 능력별 게이트 + "이 세션 동안 허용", capture 게이트를 computerUse.screen로,
    트레이 2체크박스→마스터 1개, ControlApp **"제어" 탭** 신설(카드 UI).
  - 서버: `_env_computer_use_enabled(env_id)`(host_selections.extras.computer_use_enabled) + 참이면
    connector capability 도구명을 `extra_external_tools`에 union(sandbox pack 패턴).
  - 프론트 env 편집기: GlobalSettingsView **"로컬 제어" 패널** + 스토어 `setComputerUseEnabled`.
  - 검증: desktop typecheck+build, frontend tsc, backend py_compile 전부 통과.
  - 서버측 세션 소유권 assert는 Phase 5로 이월(프론트가 이미 소유 세션만 소켓 오픈).
