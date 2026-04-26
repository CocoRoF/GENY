# 04. Deep Dive #3 — Skill / Task / Cron / Subagent 편집

본 chapter 는 cycle A+B 가 ship 한 *session 데이터* 영역에서, 사용자가 보고 / 만들고 / 편집할 수 없는 갭을 다룬다.

---

## 1. Skill management

### 1.1 현재 상태

| 자원 | 상태 |
|---|---|
| `/api/skills/list` GET | ✅ — list of SkillSummary 반환 (PR-D.3.3 후 category/effort/examples 포함) |
| `/api/skills/{id}` GET (single, body 포함) | ❌ |
| `/api/skills` POST/PUT/DELETE | ❌ |
| Bundled skills | ✅ — `backend/skills/bundled/<id>/SKILL.md` (3종 ship) |
| User skills | ✅ — `~/.geny/skills/<id>/SKILL.md` (사용자 직접 작성, GENY_ALLOW_USER_SKILLS=1 필요) |
| MCP→skill 자동 변환 | ✅ — PR-B.4.3 의 MCPSkillAdapter |
| **Frontend UI** | 🟡 — SkillPanel 은 chip 만; 클릭하면 slash command 가 input 에 쓰여짐 |

### 1.2 사용자가 현재 할 수 있는 것

```
✅ SkillPanel 에서 등록된 skill 의 chip + category + effort 보기
✅ tooltip 으로 description + examples 보기
✅ chip 클릭으로 /skill-id 를 chat input 에 prepend

❌ skill 의 SKILL.md body (실제 prompt template) 보기
❌ GENY_ALLOW_USER_SKILLS 토글 UI 에서 변경
❌ skill 을 UI 에서 새로 만들기
❌ skill 을 UI 에서 수정 / 삭제
❌ MCP→skill 자동 변환된 skill 의 출처 (어떤 MCP server) 추적
❌ skill 별 사용 통계
```

### 1.3 갭의 이유

skill 의 source-of-truth 가 **filesystem** (SKILL.md 파일). UI 가 파일을 read/write 하려면:
- bundled 와 user 의 path resolution 분리 필요
- 권한 (operator 만 ~/.geny/ 편집 가능)
- SKILL.md frontmatter ↔ body 의 분할 / 재조합

이 작업이 무거워 보였고, "operator 가 직접 텍스트 에디터로 편집하면 됨" 으로 defer.

### 1.4 개선 설계

**단계 1: Skill 상세 viewer (read-only)**

```python
# /api/skills/{id} — GET
# 응답: SkillSummary + body (markdown text)
# bundled 와 user 둘 다 읽기 가능

class SkillDetail(BaseModel):
    id: str
    name: str
    description: str
    category: Optional[str]
    effort: Optional[str]
    examples: List[str]
    allowed_tools: List[str]
    body: str  # markdown
    source: str  # "bundled" | "user" | "mcp"
    source_path: Optional[str]  # filesystem path
    mcp_origin: Optional[Dict[str, str]]  # for mcp-derived skills
```

Frontend: SkillPanel 의 chip 클릭 시 (alt-click 또는 별도 "details" 버튼) → 상세 모달 with markdown render + frontmatter 표시.

**단계 2: User skill CRUD**

```python
# /api/skills — POST (create user skill)
# /api/skills/{id} — PUT (update user skill, 단 source=='bundled' 거부)
# /api/skills/{id} — DELETE (user skill 만)

# Body: SkillDetail without source/source_path/mcp_origin
```

GENY_ALLOW_USER_SKILLS 가 false 면 모든 mutation endpoint 가 403.

Frontend: 새 탭 "Skills" 또는 SkillPanel 확장:
- Top: opt-in 토글 (env or settings.json:skills.user_skills_enabled)
- Middle: skill list (bundled / user / mcp 분류)
- Right pane: 선택한 skill 상세 — markdown editor (user skill 만 편집 가능)
- "New skill" 버튼 → frontmatter form + body textarea

**단계 3: Inline test**

skill 의 prompt template 작성 후 "Test" 버튼 → 임시 session 에서 fire → 결과 미리보기. 이건 follow-up.

### 1.5 PR 분해

| PR | Scope |
|---|---|
| 1 | `/api/skills/{id}` GET (single + body) |
| 2 | Frontend: SkillPanel chip 의 "details" 모달 |
| 3 | `/api/skills` POST/PUT/DELETE (user skill 만) |
| 4 | Frontend: "Skills" 탭 또는 패널 (CRUD UI) |
| 5 | settings.json:skills.user_skills_enabled toggle (SettingsTab 의 PermissionsConfig 패턴 따라) |

---

## 2. Background tasks (TasksTab 보강)

### 2.1 현재 상태

| 자원 | 상태 |
|---|---|
| `/api/agents/{sid}/tasks` GET (list) | ✅ |
| POST (create) | ✅ |
| GET single | ✅ |
| DELETE (stop) | ✅ |
| GET output (stream) | ✅ |
| **TasksTab.tsx** | ✅ — 5s polling, status filter, Stop, Output |

### 2.2 사용자가 현재 할 수 있는 것

```
✅ 활성 task 목록 보기 (status filter)
✅ task output streaming
✅ task stop

❌ TasksTab 에서 task 직접 생성 (지금은 LLM 만 만들 수 있음)
❌ task kind 별 payload schema 가이드 표시
❌ 사용 가능한 subagent type 목록 보기 (worker / researcher / vtuber-narrator)
❌ task → cron 으로 promote (자주 쓰는 task 를 schedule 화)
```

### 2.3 개선 설계

**단계 1: TasksTab 에 "New Task" 모달**

CronTab 의 "Add Job" 모달과 같은 패턴:
- Kind dropdown (`local_bash` / `local_agent`)
- Kind-별 schema 표시:
  - local_bash: command (text), max_output_bytes (number, default 64MB)
  - local_agent: subagent_type (dropdown — fetch from `/api/subagent-types` if exists), prompt (textarea), model (optional)
- Submit → POST `/api/agents/{sid}/tasks`

**단계 2: SubagentType 카탈로그 endpoint**

```python
# /api/subagent-types — GET
# 응답: [{id, description, default_model, default_tools, isolation_strategy}, ...]

class SubagentTypeSummary(BaseModel):
    agent_type: str
    description: str
    default_model: Optional[str]
    default_tools: List[str]
    isolation_strategy: str = "none"
```

→ TasksTab 의 New Task 모달이 dropdown 채울 source.

**단계 3: Task → Cron promote 버튼**

TasksTab row 의 "..." 메뉴에 "Schedule" → CronTab 의 Add Job 모달이 task 의 kind+payload 를 pre-fill.

### 2.4 PR 분해

| PR | Scope |
|---|---|
| 1 | `/api/subagent-types` GET endpoint |
| 2 | TasksTab "New Task" 모달 |
| 3 | TasksTab row "Schedule as cron" 액션 |

---

## 3. CronTab 개선

### 3.1 현재 갭 (PR-A.8.3 frontend 후)

```
✅ list / create / delete / run-now
✅ status badge / last_fired_at

❌ cron expression human-readable (e.g. "every minute" / "at 9am daily")
❌ next_fire_at 표시 (croniter 로 backend 가 계산해서 응답에 포함)
❌ enable/disable toggle (CronJobStatus.update_status endpoint 노출)
❌ payload kind-별 schema 가이드 (raw JSON textarea 만)
❌ subagent_type dropdown (위 §2 와 동일 — /api/subagent-types 필요)
❌ cron 의 출처 / 작성자 / 마지막 수정 시간
❌ 실패한 cron fire 의 로그 / 재시도
```

### 3.2 개선 설계

**Backend:**

- `/api/cron/jobs` 응답에 `next_fire_at` 추가 (croniter 로 backend 가 계산)
- `/api/cron/jobs/{name}/status` PATCH (enabled / disabled 토글)
- `/api/cron/jobs/{name}/history?limit=N` GET (최근 N 회 fire 결과)

**Frontend:**

- 각 row 에 "next fire: 5분 후" 같은 인간친화적 표시 (date-fns formatDistance)
- Add Job 모달:
  - cron expression 입력 시 cronstrue 로 "every 5 minutes" 자동 표시
  - target_kind 별 schema 가이드 (local_bash → command field; local_agent → subagent_type dropdown + prompt)
- 각 row 에 enable/disable toggle
- row 클릭 시 expand → 최근 fire 내역 (성공/실패/output 링크)

### 3.3 PR 분해

| PR | Scope |
|---|---|
| 1 | `/api/cron/jobs` 응답 enrich (next_fire_at) + `/status` PATCH |
| 2 | CronTab Add Job 모달 enrich (cronstrue + kind-별 form) |
| 3 | CronTab row enable toggle + expand 의 최근 fire 내역 |
| 4 | `/api/cron/jobs/{name}/history` endpoint + 표시 |

---

## 4. Subagent type 관리

### 4.1 현재 상태

PR-A.5.1 에서 3 종 등록:
- `worker` — full toolset
- `researcher` — read-only
- `vtuber-narrator` — persona-only

이 정보가 어디에도 노출 안 됨. 사용자 또는 LLM 이 `Agent` tool 을 호출할 때 어떤 type 을 인자로 줄지 모름.

### 4.2 개선 설계

위 §2.3 의 `/api/subagent-types` endpoint + `SubagentTypeSummary` model 동일.

추가 (선택):
- `/api/subagent-types` POST/PUT/DELETE (런타임 등록) — 단 SubagentTypeRegistry 를 mutable 로 wired 해야 함; 현재는 코드에서 install_subagent_types 를 한 번만 호출.

UI:
- AdminPanel 에 "Subagent Types" 패널 — type 별 카드 (description + default tools + model)
- Workspace isolation strategy 표시 (PR-D.4.1 의 isolation_strategy field 가 있다면)

### 4.3 PR 분해

| PR | Scope |
|---|---|
| 1 | `/api/subagent-types` GET — 위 §2.3 와 통합 |
| 2 | AdminPanel "Subagent Types" 패널 |

---

## 5. Notification endpoints + SendMessage channels

### 5.1 현재 상태

| 자원 | 상태 |
|---|---|
| Notification endpoints | yaml/env 만 — UI 0 |
| SendMessage channels | 코드 등록만 (StdoutSendMessageChannel default) — UI 0 |
| `/api/notifications/*` | ❌ 없음 |
| `/api/channels/*` | ❌ 없음 |

### 5.2 개선 설계

**Backend:**

- `/api/notifications/endpoints` GET / POST / DELETE (settings.json:notifications)
- `/api/notifications/endpoints/{name}/test` POST (테스트 send → 결과 표시)
- `/api/channels` GET (등록된 channel 목록)

**Frontend:**

- SettingsTab 에 "Notifications" 카드 — endpoint 표 + Add/Test 버튼
- Channel 은 read-only 표시 (코드 등록이라 UI 추가 불필요)

### 5.3 PR 분해

| PR | Scope |
|---|---|
| 1 | `/api/notifications/endpoints` CRUD + test endpoint |
| 2 | SettingsTab "Notifications" 패널 |
| 3 | `/api/channels` GET + 표시 |

---

## 6. 종합 PR 추정

| 갭 | PR 수 | 우선순위 |
|---|---|---|
| §1 Skill view+CRUD | 5 | MED |
| §2 TasksTab 보강 (New Task, subagent dropdown, schedule promote) | 3 | MED |
| §3 CronTab 보강 (next_fire, cronstrue, kind schema, history) | 4 | MED |
| §4 Subagent type 카탈로그 | 2 | MED |
| §5 Notification + Channel UI | 3 | LOW |

**총 ~17 PR.** 모두 MED ~ LOW 우선순위 — UX 가시성이 큼.

---

## 다음 chapter

- [`05_gap_observability.md`](05_gap_observability.md) — workspace / events / admin viewer 갭
