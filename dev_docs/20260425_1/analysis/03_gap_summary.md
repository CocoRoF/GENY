# 03. Gap Summary — prioritized backlog

**Date:** 2026-04-25
**Source:** 01 (executor inventory) + 02 (Geny consumption audit) 의 산물
**Purpose:** 28 건의 unwired capability 를 (의존성 → 영향도 → 위험) 순으로 정렬, sprint 단위로 묶기 위한 입력.

---

## 1. 의존성 그래프

```
P1 (capability flags + permission)
   │
   ├──► P5 (hooks)            ─── PRE/POST_TOOL_USE 가 capability flag 를 본다
   │
   ├──► P7 S7.4 (PermissionGuard)  ─── permission_rules 가 attach_runtime 에 들어가야 동작
   │
   └──► P9b (Stage 13 task_registry) ─── policy 에서 capability 검증

P3 (built-in catalog)  ✅ WIRED ─ 영향: 다른 phase 가 사실상 무전제 사용
P6 (MCP runtime FSM)
   │
   ├──► P7 S7.2 (MCPResourceRetriever)  ─── runtime MCP 가 있어야 의미
   │
   ├──► P8 (OAuth + credential + URI + prompts→Skills bridge) ─── manager FSM 위에서 동작
   │
   └──► (Skills System P4 의 mcp_bridge 경로)

P4 (Skills) ─── 단독 가능, 단 P8 의 mcp_prompts_to_skills 와 결합 가능

P7 (12 sprints)  ─── 대부분 단독 가능. 의존:
   │   S7.2 ◄── P6
   │   S7.4 ◄── P1
   │   S7.5 ◄── (P4 if SkillTool 와 결합)

P9c read-side (restore_state_from_checkpoint)  ─── 단독, 즉시 가능

P10 (frontend dashboard)  ─── EventBus 만 있으면 가능, 다른 phase 와 독립
```

## 2. 우선순위 매트릭스

기준: **(영향도 × 보안 무게) ÷ 의존성 길이**.

| Rank | Phase | 항목 | 영향도 | 보안 | 의존성 |
|---|---|---|---|---|---|
| **R1** | P1 | ToolCapabilities 분류 + permission matrix + attach_runtime wiring | 높음 | **높음** | 없음 (independent) |
| **R2** | P5 | HookRunner + Stage 10 PRE/POST_TOOL_USE | 중 | **높음** | R1 (capability flag 활용 시 더 강력) |
| **R3** | P9c | `restore_state_from_checkpoint` + resume endpoint | 중 | 중 | 없음 — write 측은 이미 wired |
| **R4** | P6 | MCP runtime add/remove + FSM + UI | 중 | 중 | 없음 |
| **R5** | P4 | Skills loader + SkillTool + (slash command UX) | 중 | 낮음 | 없음 (단 P8 의 mcp_prompts_to_skills 와 결합 시 R5+) |
| **R6** | P7 | 12 stage strategy 슬랏 흡수 (개별 단위) | 중 | 낮음 | S7.2◄P6, S7.4◄R1 |
| **R7** | P8 | MCP credential / OAuth / URI / prompts→Skills | 낮 | 중 | R4 (P6 위에서) |
| **R8** | P10 | Live stage dashboard + mutation audit | 낮 | 낮음 | 없음 |

설명:
- R1 이 모든 보안 layer 의 토대. 이걸 미루면 R2, R6 (S7.4) 도 effective-no-op.
- R3 는 단일 PR 분량이고 SLA 효과 큼 (장애 후 세션 복원). R4 와 독립적으로 진행 가능.
- R4 가 R7 을 잠금 해제. R7 은 R4 후 즉시 진행.
- R6 는 12 sprint 로 쪼개지므로 R1·R4 가 끝나는대로 병렬 진행.
- R8 은 가장 후순위 — UX 향상이지 기능 회복이 아님. 단, EventBus 가 이미 발사 중이라 frontend 작업만으로 진행 가능.

## 3. Sprint 묶음 (다음 cycle 후보)

| Cycle ID | 묶음 | 포함 항목 | 예상 PR 수 |
|---|---|---|---|
| **G6.x** | P1 + P5 | capability flag adoption, permission rules YAML loader + attach_runtime wiring, HookRunner + hooks.yaml + frontend hook indicator | 6 |
| **G7.x** | P9c read + Skills | `restore_state_from_checkpoint` endpoint + resume UI hook, `~/.geny/skills/` 로더 + SkillTool 등록 + 슬래시 커맨드 + frontend skill list | 5 |
| **G8.x** | P6 MCP runtime | `MCPManager.connect/disconnect` 호출 endpoint, `mcp.server.state` event subscriber, frontend MCP server admin panel | 4 |
| **G9.x** | P7 stage strategies | 11개 stage 별 strategy 흡수 (S7.2/3/4/5/6/7/8/9/10/12 + manifest 표). S7.1, S7.11 은 이미 wired | 11 |
| **G10.x** | P8 OAuth + URI + bridge | credential store, OAuth flow, mcp:// URI, prompts→Skills | 4 |
| **G11.x** | P10 dashboard | live stage grid, token/cost meter, mutation audit log viewer | 3 |
| **합계** | | | **33 PR** |

각 묶음은 독립 cycle 로 진행 가능. 단, R1 (G6.x) 이 G9.x S7.4 와 G6.x P5 의 선결.

## 4. 위험 항목

| 위험 | 영향 | 대응 |
|---|---|---|
| **Permission rule YAML 형식 변경** | host 측 정책 파일이 깨짐 | executor 의 `load_permission_rules` 시그니처 frozen — 우리가 정의하는 rule 파일만 owner. rollback: rule 파일 비우면 fail-open. |
| **Hook subprocess 가 secret 누출** | sensitive payload 가 stdout 으로 | hook payload sanitizer — `state.shared['secrets']` 제거 후 dispatch. fail-open 기본. |
| **Skills 디렉토리에 신뢰할 수 없는 파일** | RCE 잠재성 | `allowed_tools` 화이트리스트, sandbox 환경 변수 제한. `GENY_ALLOW_USER_SKILLS=1` 옵트인 기본. |
| **MCP runtime add/remove 가 기존 세션 영향** | 진행 중 turn 깨짐 | `MCPManager` 의 disable_server 가 in-flight tool call 끝까지 기다리는지 확인. 없으면 idempotent disable 후 next-turn 적용. |
| **OAuth callback port 충돌** | localhost 포트 사용 중 | dynamic port assignment, `~/.geny/oauth_state.json` 으로 state 보관. |
| **Phase 7 strategy 활성화로 회귀** | 기존 worker session 결과 변경 | preset override 표 (`_PRESET_SCAFFOLD_OVERRIDES`) 와 동일 패턴 — 기본 off, opt-in. 300 seed 비교 매트릭스 사용. |
| **Crash recovery 가 partial state 복원** | tool_results 누락 → 다음 턴 LLM 혼선 | `state_from_payload` 가 missing key tolerant 임이 보장 — 누락된 messages 등은 빈 list 로 재구성. user 에게 "이 세션은 부분 복구됨" 안내 필요. |

## 5. 다음 단계

- `plan/cycle_plan.md` 에 6개 cycle (G6 → G11) 의 PR 단위 분해 + 검증 매트릭스
- 사용자 승인 후 R1 부터 순차 진행 (continuous PR cadence — durable instruction 준수)
- 각 cycle 종료마다 `progress/<cycle>_<sprint>_<topic>.md` 누적
