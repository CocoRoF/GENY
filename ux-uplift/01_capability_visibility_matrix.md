# 01. Capability ↔ Visibility 매트릭스

각 capability 가 (Backend API surface, Frontend UI surface, Data shape) 3축에서 어떻게 노출되는지의 단일 진실 표.

**범례:** ✅ full / 🟡 partial / ❌ gap / 🚫 intentional out

---

## A. Built-in tool catalog (33개)

| 항목 | Backend API | Frontend UI | Data shape | 종합 |
|---|---|---|---|---|
| A.1 도구 목록 조회 (33개 모두) | ✅ `/api/tools/catalog/built-in` | 🟡 SessionToolsTab 카운트만; 개별 도구 상세 X | ✅ name + description + capabilities | 🟡 |
| A.2 도구별 상세 (input_schema / capabilities / category) | 🟡 GET 응답에 포함 가능하나 사용 안 됨 | ❌ 어디에도 표시 안 함 | ✅ Tool ABC 에 다 있음 | ❌ |
| A.3 preset 별 enable/disable 한 도구 표시 | 🟡 manifest 에 있지만 endpoint 없음 | ❌ | ✅ manifest.tools.built_in | ❌ |
| A.4 도구 개별 enable/disable (session 단위) | ❌ all-or-nothing (`["*"]` or `[]`) | ❌ | ❌ schema 가 list of names 만 받음 | ❌ |
| A.5 도구 사용량 / 호출 카운트 표시 | ❌ | ❌ | — | ❌ |

**핵심 갭:** A.2 (도구별 상세) + A.3 (preset 별 enable 여부) + A.4 (개별 선택). [`02_gap_built_in_tools.md`](02_gap_built_in_tools.md) deep dive.

---

## B. External tool / Tool Preset

| 항목 | Backend API | Frontend UI | Data shape | 종합 |
|---|---|---|---|---|
| B.1 Tool preset CRUD | ✅ `/api/tool-presets/*` 6 endpoint | ✅ ToolSetsTab CRUD | ✅ ToolPresetDefinition | ✅ |
| B.2 Custom tool 카탈로그 | ✅ `/api/tools/catalog/custom` | ✅ ToolSetsTab 그룹+체크박스 | ✅ | ✅ |
| B.3 Custom tool 상세 (input_schema / 동작 설명) | 🟡 list 에 description 만 | ❌ 클릭해서 상세 보기 화면 없음 | ✅ Tool ABC | 🟡 |
| B.4 Adhoc tool 등록 (런타임) | 🟡 GenyToolProvider 가 처리 | ❌ UI 없음 — 코드 add 만 | ✅ | 🟡 |
| B.5 도구 활성/비활성 by preset | ✅ preset.custom_tools | ✅ ToolSetsTab | ✅ | ✅ |

---

## C. MCP integration

| 항목 | Backend API | Frontend UI | Data shape | 종합 |
|---|---|---|---|---|
| C.1 MCP server 목록 (built-in + custom) | ✅ `/api/tools/catalog/mcp-servers` | ✅ SessionToolsTab MCPAdminPanel | ✅ | ✅ |
| C.2 MCP server 추가 (custom) | 🟡 mcp_loader 가 ~/.geny/mcp.json 로드 | ❌ UI 없음 — 파일 수동 편집 | 🟡 | ❌ |
| C.3 MCP OAuth flow | ✅ `/api/agents/{sid}/mcp/servers/{name}/auth/start` | ❌ 사용자 flow UI 없음 | ✅ | ❌ |
| C.4 MCP tool 호출 결과 표시 | ✅ ExecutionTimeline 에 포함 | ✅ | ✅ | ✅ |
| C.5 MCP resource (mcp:// URI) 조회 | ✅ `/api/mcp/resources?uri=...` | ❌ UI 없음 | ✅ | 🟡 |

**핵심 갭:** C.2 (custom MCP 서버 추가 UI), C.3 (OAuth flow UI). [`02_gap_built_in_tools.md`](02_gap_built_in_tools.md) §3 참조.

---

## D. Permission system

| 항목 | Backend API | Frontend UI | Data shape | 종합 |
|---|---|---|---|---|
| D.1 권한 규칙 목록 조회 | ✅ `/api/permissions/list` GET | ❌ 어디에도 표시 안 함 | ✅ PermissionRule | ❌ |
| D.2 권한 규칙 추가 / 수정 / 삭제 | ❌ POST/PUT/DELETE 없음 | ❌ UI 없음 | 🟡 schema 정의는 있음 | ❌ |
| D.3 Permission mode 변경 (advisory ↔ enforce) | 🟡 PermissionsConfig (PR-D.3.4) 에 있음 | 🟡 SettingsTab 에 보일 가능성 (검증 안 됨) | ✅ | 🟡 |
| D.4 Executor mode 변경 (default/plan/auto/bypass/acceptEdits/dontAsk) | 🟡 PermissionsConfig (PR-D.3.4) 에 있음 | 🟡 같음 | ✅ | 🟡 |
| D.5 Source 별 우선순위 표시 (CLI/LOCAL/PROJECT/USER/PRESET) | ❌ list 응답에 포함되지 않음 | ❌ | ✅ enum 있음 | ❌ |
| D.6 권한 deny event 실시간 알림 / 로그 | 🟡 in-process hook 가 logger 에 기록 | ❌ UI 미노출 (admin viewer 없음) | ✅ | ❌ |

**핵심 갭:** D.1 (조회 UI), D.2 (CRUD UI). [`03_gap_settings_editing.md`](03_gap_settings_editing.md) §1 참조.

---

## E. Hook system

| 항목 | Backend API | Frontend UI | Data shape | 종합 |
|---|---|---|---|---|
| E.1 Hook 설정 조회 | ✅ `/api/hooks/list` GET | ❌ | ✅ HookConfig | ❌ |
| E.2 Hook entry 추가 / 수정 / 삭제 | ❌ | ❌ | ✅ HookConfigEntry | ❌ |
| E.3 Env opt-in (`GENY_ALLOW_HOOKS`) 상태 표시 | ✅ list 응답에 포함 | ❌ | ✅ | ❌ |
| E.4 In-process handler 등록 / 조회 | ❌ list_in_process_handlers 노출 안 됨 | ❌ | ✅ | ❌ |
| E.5 Hook fire history / latency | ❌ | ❌ | — | ❌ |

[`03_gap_settings_editing.md`](03_gap_settings_editing.md) §2 참조.

---

## F. Skill system

| 항목 | Backend API | Frontend UI | Data shape | 종합 |
|---|---|---|---|---|
| F.1 Skill 목록 조회 | ✅ `/api/skills/list` GET | ✅ SkillPanel chip | ✅ SkillSummary (PR-D.3.3 후 category/effort/examples 포함) | ✅ |
| F.2 Skill 상세 (body / SKILL.md) 조회 | ❌ | ❌ | 🟡 SKILL.md 자체가 데이터 | ❌ |
| F.3 Skill 추가 (~/.geny/skills/<id>/SKILL.md 생성) | ❌ | ❌ | ✅ schema 있음 | ❌ |
| F.4 Skill 수정 / 삭제 | ❌ | ❌ | ✅ | ❌ |
| F.5 Skill 활성/비활성 (`GENY_ALLOW_USER_SKILLS`) | 🟡 PermissionsConfig 식의 settings 등록 가능하나 미확인 | ❌ | ✅ settings.skills.user_skills_enabled | 🟡 |
| F.6 MCP→skill 자동 변환 결과 표시 | ❌ | ❌ | ✅ MCPSkillAdapter 있음 | ❌ |

[`04_gap_session_data.md`](04_gap_session_data.md) §1 참조.

---

## G. Background tasks (PR-A.1 / A.5)

| 항목 | Backend API | Frontend UI | Data shape | 종합 |
|---|---|---|---|---|
| G.1 Task 목록 조회 (status filter) | ✅ `/api/agents/{sid}/tasks` | ✅ TasksTab 5s polling | ✅ BackgroundTaskRecord | ✅ |
| G.2 Task 생성 (kind + payload) | ✅ POST | ❌ TasksTab 에 Create 모달 없음 | 🟡 payload schema dynamic 안 됨 | 🟡 |
| G.3 Task 상세 (output stream) | ✅ GET / output endpoint | ✅ "Output" 버튼 → 새 탭 streaming | ✅ | ✅ |
| G.4 Task stop | ✅ DELETE | ✅ Stop 버튼 | ✅ | ✅ |
| G.5 Task kind 별 schema 노출 (local_bash → command, local_agent → subagent_type+prompt) | ❌ | ❌ | 🟡 hardcoded in executor | ❌ |
| G.6 SubagentType 카탈로그 표시 | ❌ | ❌ | ✅ DESCRIPTORS 3종 등록 | ❌ |
| G.7 Task 결과 → TasksTab 외 다른 surface 노출 (예: chat 에 inline) | ❌ | ❌ | — | 🟡 |

[`04_gap_session_data.md`](04_gap_session_data.md) §2 참조.

---

## H. Cron jobs (PR-A.4 / A.8)

| 항목 | Backend API | Frontend UI | Data shape | 종합 |
|---|---|---|---|---|
| H.1 Cron 목록 조회 | ✅ `/api/cron/jobs` | ✅ CronTab | ✅ CronJobRecord | ✅ |
| H.2 Cron 생성 (name + cron_expr + target_kind + payload) | ✅ POST | 🟡 CronTab Add Job 모달 — payload 는 raw JSON textarea | 🟡 schema 없음 | 🟡 |
| H.3 Cron 삭제 | ✅ DELETE | ✅ | ✅ | ✅ |
| H.4 Cron run-now (adhoc fire) | ✅ POST `/run-now` | ✅ Play 버튼 → alert 으로 task_id 만 표시 | 🟡 task_id 후 navigate 안 됨 | 🟡 |
| H.5 Cron 상태 (enabled/disabled) toggle | 🟡 store.update_status 있지만 endpoint 없음 | ❌ | ✅ | ❌ |
| H.6 Cron expression human-readable 표시 (cronstrue) | ❌ | ❌ raw expr 만 | — | ❌ |
| H.7 Cron next-fire-at 계산 표시 | ❌ | ❌ | 🟡 runner 가 계산하지만 store 에 안 저장 | ❌ |
| H.8 Cron payload kind-별 schema 가이드 | ❌ | ❌ | — | ❌ |

[`04_gap_session_data.md`](04_gap_session_data.md) §3 참조.

---

## I. Slash commands (PR-A.2 / A.6)

| 항목 | Backend API | Frontend UI | Data shape | 종합 |
|---|---|---|---|---|
| I.1 명령 목록 조회 | ✅ `/api/slash-commands` | ✅ SlashCommandAutocomplete dropdown | ✅ SlashCommandSummary | ✅ |
| I.2 명령 server-side 실행 | ✅ POST `/execute` | ✅ CommandTab handleExecute | ✅ SlashExecuteResponse | ✅ |
| I.3 명령 카테고리 별 그룹 표시 (introspection / control / domain) | ✅ category 필드 있음 | 🟡 dropdown 에 라벨로만 | ✅ | 🟡 |
| I.4 사용자 정의 명령 추가 (markdown template) | 🟡 ~/.geny/commands/*.md 자동 발견 | ❌ UI 없음 — 파일 수동 작성 | ✅ MdTemplateCommand | 🟡 |
| I.5 명령 결과 follow_up_prompt 처리 | ✅ 있음 | ✅ CommandTab 이 처리 | ✅ | ✅ |

---

## J. Settings (settings.json + register_config)

| 항목 | Backend API | Frontend UI | Data shape | 종합 |
|---|---|---|---|---|
| J.1 Geny config 목록 (register_config 기반) | ✅ `/api/config` | ✅ SettingsTab 카테고리 / 카드 | ✅ ConfigSchema | ✅ |
| J.2 Geny config 편집 | ✅ PUT `/api/config/{name}` | ✅ SettingsTab 모달 | ✅ | ✅ |
| J.3 PermissionsConfig (PR-D.3.4) 노출 | ✅ register_config 등록 | 🟡 자동 렌더링 가정 — 실제 노출 검증 안 됨 | ✅ | 🟡 |
| J.4 settings.json:permissions section 편집 | ❌ | ❌ | ✅ schema 있음 | ❌ |
| J.5 settings.json:hooks section 편집 | ❌ | ❌ | ✅ | ❌ |
| J.6 settings.json:skills section 편집 | ❌ | ❌ | ✅ | ❌ |
| J.7 settings.json:model section 편집 | ❌ | ❌ | ✅ | ❌ |
| J.8 settings.json:notifications section 편집 | ❌ | ❌ | ✅ | ❌ |
| J.9 settings.json migration 상태 표시 (yaml-only ⇒ migrated) | ❌ | ❌ | 🟡 migrator 결과를 보여줄 endpoint 없음 | ❌ |

[`03_gap_settings_editing.md`](03_gap_settings_editing.md) §3 참조.

---

## K. Workspace abstraction (PR-D.4 / D.5.1)

| 항목 | Backend API | Frontend UI | Data shape | 종합 |
|---|---|---|---|---|
| K.1 현재 workspace stack 조회 (cwd / branch / depth) | ❌ | ❌ | ✅ WorkspaceStack.snapshot() 있음 | ❌ |
| K.2 Worktree 활성 list (EnterWorktree push 결과) | ❌ | ❌ | ✅ | ❌ |
| K.3 Worktree 수동 정리 / pop | ❌ | ❌ | ✅ ExitWorktreeTool 있지만 LLM 만 호출 | ❌ |
| K.4 LSP session 상태 표시 | ❌ | ❌ | ✅ Workspace.lsp_session_id | ❌ |

[`05_gap_observability.md`](05_gap_observability.md) §1 참조.

---

## L. Notification + SendMessage channel

| 항목 | Backend API | Frontend UI | Data shape | 종합 |
|---|---|---|---|---|
| L.1 Notification endpoint 목록 | ❌ endpoint 없음 | ❌ | ✅ NotificationEndpointRegistry | ❌ |
| L.2 Notification endpoint 추가 / 수정 / 삭제 | ❌ | ❌ | 🟡 yaml/env 수동 | ❌ |
| L.3 SendMessage channel 목록 (Discord / Slack 등) | ❌ | 🟡 SessionToolsTab 일부 가능성 | ✅ SendMessageChannelRegistry | ❌ |
| L.4 SendMessage 테스트 send | ❌ | ❌ | — | ❌ |

---

## M. Observability (logs / events / runtime state)

| 항목 | Backend API | Frontend UI | Data shape | 종합 |
|---|---|---|---|---|
| M.1 ExecutionTimeline (stage events) | ✅ WS | ✅ CommandTab | ✅ | ✅ |
| M.2 Tool 호출 이벤트 ring buffer (PR-B.1.3) | ❌ /api/admin/recent-tool-events 없음 | ❌ | ✅ recent_tool_events 함수 있음 | ❌ |
| M.3 In-process hook latency 통계 | ❌ | ❌ | — | ❌ |
| M.4 Active sessions count + state | ✅ `/api/agents` | ✅ Sidebar | ✅ | ✅ |
| M.5 Lifespan install status (어떤 runtime 이 alive 인지) | ❌ | ❌ | 🟡 logger 에는 있음 | ❌ |
| M.6 Token cost / budget 실시간 | 🟡 cost-tracker | ✅ TokenMeter | ✅ | ✅ |
| M.7 Cron daemon 상태 / 다음 fire-at | ❌ | ❌ | 🟡 runner 내부 | ❌ |
| M.8 Task queue depth (BackgroundTaskRunner.semaphore) | ❌ | ❌ | 🟡 runner 내부 | ❌ |

[`05_gap_observability.md`](05_gap_observability.md) §2 참조.

---

## N. Memory + knowledge

| 항목 | Backend API | Frontend UI | Data shape | 종합 |
|---|---|---|---|---|
| N.1 Memory 노트 CRUD | ✅ 모든 verb | ✅ MemoryTab 완전 | ✅ | ✅ |
| N.2 Memory 검색 | ✅ | ✅ | ✅ | ✅ |
| N.3 Global memory CRUD | ✅ | ✅ | ✅ | ✅ |
| N.4 Knowledge graph 연결 | ✅ | 🟡 표시는 있으나 편집 일부 | ✅ | 🟡 |

→ 메모리는 가장 잘 wired 됨. 본 분석의 갭 영역 아님.

---

## O. Manifest / Environment editing

| 항목 | Backend API | Frontend UI | Data shape | 종합 |
|---|---|---|---|---|
| O.1 Environment list / create / delete | ✅ | ✅ EnvironmentsTab | ✅ | ✅ |
| O.2 Manifest stage 편집 | ✅ PATCH `/stages/{order}` | ✅ BuilderTab StageEditor | ✅ | ✅ |
| O.3 Strategy slot 편집 | ✅ | ✅ BuilderTab StrategiesEditor | ✅ | ✅ |
| O.4 Tools allowlist/blocklist 편집 | ✅ | ✅ BuilderTab tools 섹션 | ✅ | ✅ |
| O.5 Built-in tool 활성 여부 편집 (manifest.tools.built_in) | 🟡 manifest에 있지만 hardcoded `["*"]` or `[]` | ❌ | ❌ schema 가 list of names 만 | ❌ |
| O.6 Environment 비교 / diff | ✅ | ✅ | ✅ | ✅ |
| O.7 Environment import / export | ✅ | ✅ | ✅ | ✅ |

→ Environment 편집은 잘 wired. 단 O.5 (built-in tool 활성 편집) 만 갭.

---

## 종합 요약

| 분류 | ✅ Full | 🟡 Partial | ❌ Gap | 🚫 Out | 합계 |
|---|---|---|---|---|---|
| A. Built-in tool | 0 | 1 | 4 | 0 | 5 |
| B. External tool | 4 | 1 | 0 | 0 | 5 |
| C. MCP | 3 | 1 | 1 | 0 | 5 |
| D. Permission | 0 | 2 | 4 | 0 | 6 |
| E. Hook | 0 | 0 | 5 | 0 | 5 |
| F. Skill | 1 | 1 | 4 | 0 | 6 |
| G. Background tasks | 4 | 2 | 1 | 0 | 7 |
| H. Cron | 2 | 3 | 3 | 0 | 8 |
| I. Slash | 4 | 1 | 0 | 0 | 5 |
| J. Settings | 3 | 1 | 5 | 0 | 9 |
| K. Workspace | 0 | 0 | 4 | 0 | 4 |
| L. Notifications | 0 | 1 | 3 | 0 | 4 |
| M. Observability | 4 | 2 | 5 | 0 | 11 |
| N. Memory | 4 | 1 | 0 | 0 | 5 |
| O. Manifest | 6 | 1 | 1 | 0 | 8 |
| **합계** | **35 (37%)** | **18 (19%)** | **40 (43%)** | **0** | **93** |

**가장 큰 갭 영역 (❌ count):**
1. M. Observability — 5
2. J. Settings — 5
3. E. Hook — 5
4. F. Skill — 4
5. K. Workspace — 4
6. D. Permission — 4
7. A. Built-in tool — 4

Settings + Permission + Hook + Skill 4 영역이 가장 시급. Built-in tool 도 사용자 명시 1순위. Workspace 는 D.4 산출물의 가시화 갭. Observability 는 cycle B+D 의 backend 산출물의 비가시화 갭.

다음 [`02_gap_built_in_tools.md`](02_gap_built_in_tools.md) 부터 deep dive.
