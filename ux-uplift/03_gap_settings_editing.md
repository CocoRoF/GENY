# 03. Deep Dive #2 — Settings / Permission / Hook 편집

본 chapter 는 cycle B+D 가 만든 settings.json / PermissionRule / HookConfig 영역에서, **데이터는 backend 에 있는데 사용자가 편집할 화면이 없는** 갭을 다룬다.

---

## 1. Permission rules — Read만, Write 없음

### 1.1 현재 상태

| 자원 | 상태 |
|---|---|
| `/api/permissions/list` GET | ✅ — rules + sources 반환 |
| `/api/permissions/rules` POST/PUT/DELETE | ❌ — endpoint 없음 |
| Permission yaml file (`~/.geny/permissions.yaml`) | ✅ — 수동 편집 |
| settings.json `permissions` section | ✅ — PR-D.2.1 dual-read 후 우선 사용 |
| **Frontend UI** | ❌ — 어떤 탭에도 표시 / 편집 없음 |

### 1.2 사용자가 현재 할 수 있는 것

```
✅ ~/.geny/permissions.yaml 수동 편집 후 backend 재시작
✅ settings.json:permissions section 수동 편집 후 backend 재시작
✅ GENY_PERMISSION_MODE / GENY_PERMISSION_EXEC_MODE env 로 mode 변경
   → PermissionsConfig 가 SettingsTab 에 자동 노출 (이론상; 검증 필요)

❌ 활성 rule 목록 조회
❌ rule 단위 추가
❌ rule 수정 / 삭제
❌ rule 우선순위 시각화 (CLI > LOCAL > PROJECT > USER > PRESET_DEFAULT)
❌ "이 tool 호출이 어떤 rule 에 매칭됐는지" 사후 추적
```

### 1.3 갭의 이유

Cycle A 때 `/api/permissions/list` GET 만 만들고 멈춤. CRUD 가 ship 되지 않은 이유:
- yaml 편집이 "operator 직접 편집" 패턴이라 가정
- UI 가 yaml ↔ JSON 변환 + 검증 로직이 무거워 보였을 것

그러나 cycle D 에 settings.json + dual-read 가 ship 되면서 schema 가 통일됨 → 이제 CRUD 만들기 쉬워짐.

### 1.4 개선 설계

**Backend (필요 신규):**

```python
# /api/permissions/rules — POST (create), PUT /{id} (update), DELETE /{id}
# 모두 settings.json 의 permissions section 에 write
# yaml fallback 은 read-only (deprecation window)

class PermissionRulePayload(BaseModel):
    tool_name: str
    behavior: Literal["allow", "deny", "ask"]
    pattern: Optional[str] = None
    reason: Optional[str] = None
    source: Literal["user", "project", "local"] = "user"

@router.post("/api/permissions/rules", response_model=PermissionRuleResponse)
async def create_rule(body: PermissionRulePayload, ...):
    ...

@router.delete("/api/permissions/rules/{rule_id}")
async def delete_rule(rule_id: str, ...):
    ...
```

**Frontend (필요 신규):**

새 탭 또는 SettingsTab 의 "Permissions" 카드 확장:
- 활성 rule 표 — tool / pattern / behavior / source / actions
- "Add rule" 모달 — tool 이름 (catalog 에서 선택), behavior dropdown, pattern textbox + 예시
- rule 우선순위 / source priority 시각화 (드래그 정렬은 source 가 결정하니 readonly)
- ExecutionTimeline 의 tool 호출 detail 에 "matched rule" 표시 (이미 PermissionDecision 에 정보 있음)

### 1.5 PR 분해

| PR | Scope |
|---|---|
| 1 | `/api/permissions/rules` POST/PUT/DELETE; settings.json 의 rules 배열 mutate |
| 2 | Frontend: `PermissionsTab` 또는 SettingsTab 의 패널; 표 + Add 모달 |
| 3 | ExecutionTimeline 의 tool detail 에 matched rule 표시 |

---

## 2. Hook configuration — Read만, Write 없음

### 2.1 현재 상태

| 자원 | 상태 |
|---|---|
| `/api/hooks/list` GET | ✅ — config + env opt-in 상태 반환 |
| `/api/hooks/entries` POST/PUT/DELETE | ❌ — endpoint 없음 |
| Hook yaml file (`~/.geny/hooks.yaml`) | ✅ — 수동 편집 |
| settings.json `hooks` section | ✅ — PR-D.2.2 dual-read 후 우선 사용 |
| `register_in_process` API | ✅ — Geny 가 3 handler 등록 (PR-B.1.3) |
| In-process handler list | 🟡 — `runner.list_in_process_handlers()` 있지만 endpoint 없음 |
| **Frontend UI** | ❌ — 표시 / 편집 없음 |

### 2.2 사용자가 현재 할 수 있는 것

```
✅ ~/.geny/hooks.yaml 수동 편집 + GENY_ALLOW_HOOKS=1 + 재시작
✅ settings.json:hooks section 수동 편집

❌ 활성 hook entry 목록 보기
❌ Hook entry 추가 (어떤 event 에 어떤 script 실행)
❌ Hook fire 통계 / latency
❌ In-process handler 등록 현황 (PR-B.1.3 의 3 handler)
❌ Hook 결과 (block / passthrough / suppress_output) 시각화
```

### 2.3 개선 설계

**Backend:**

```python
# /api/hooks/entries POST/PUT/DELETE
# /api/hooks/in-process — GET only (등록은 코드 호출이라 UI 추가 X)
# /api/hooks/recent-fires?limit=N — ring buffer (PR-B.1.3 의 _RECENT_EVENTS)

class HookEntryPayload(BaseModel):
    event: str  # HookEvent enum
    command: List[str]
    timeout_ms: int = 5000
    allow_blocking: bool = True
    matchers: Optional[Dict[str, str]] = None
```

**Frontend:**

새 패널 "Hooks" (또는 SettingsTab):
- Top: env opt-in 상태 (GENY_ALLOW_HOOKS=1 토글 — 단 backend 재시작 필요 표시)
- Middle: subprocess hook entries 표 (event / command / timeout / actions)
- Bottom: in-process handler 표 (event / handler name / 호출 수)
- Recent fires log (ring buffer 표시 — PR-B.1.3 의 ring buffer 가 endpoint 노출돼야 함)

### 2.4 부산물

PR-B.1.3 의 `recent_tool_events` ring buffer 가 endpoint 로 노출되면 [`05_gap_observability.md`](05_gap_observability.md) §2 와 겹침. 같은 endpoint 로 통합.

---

## 3. settings.json framework section 편집

### 3.1 현재 상태

cycle B 가 ship 한 settings.json 의 표준 sections:

| Section | Schema 출처 | 편집 가능? |
|---|---|---|
| `permissions` | executor PermissionsSection | ❌ (위 §1) |
| `hooks` | executor HooksSection | ❌ (위 §2) |
| `skills` | executor SkillsSection | 🟡 user_skills_enabled 만 PermissionsConfig 식 surface 가능 |
| `model` | executor ModelSection | ❌ |
| `telemetry` | executor TelemetrySection | ❌ |
| `notifications` | executor NotificationsSection | ❌ |
| `preset` | Geny PresetSection | ✅ register_config 로 SettingsTab 노출 (이론상) |
| `vtuber` | Geny VTuberSection | ✅ 같음 |

→ Geny 자체 section (preset / vtuber) 만 노출됐고, framework 5 section 은 모두 미노출.

### 3.2 PR-D.3.4 의 PermissionsConfig 가 실제로 노출되나?

`backend/service/config/sub_config/general/permissions_config.py` 를 register_config 로 등록. SettingsTab 은 카테고리 sidebar 가 있고 "general" 카테고리에 들어가야 보임.

**검증되지 않은 가정:**
- PermissionsConfig 의 `runner_mode` + `executor_mode` 두 SELECT 가 SettingsTab 에서 정말 자동 렌더링되는지 — 코드만 봐서는 확신 어려움
- Frontend 가 새로 추가된 sub_config 를 발견하려면 reload 가 필요한지

**해야 할 일:**
- 운영 환경에서 SettingsTab 열어서 "Permissions" 카드 확인
- 안 보이면: SettingsTab 의 카테고리 새로고침 / sub_config import 누락 진단

### 3.3 개선 설계

**옵션 A: Geny config 시스템에 framework section 등록**

각 framework section (permissions / hooks / skills / model / telemetry / notifications) 마다 register_config dataclass 작성 → SettingsTab 자동 노출.

장점: 기존 SettingsTab 인프라 재사용, 0 frontend 작업
단점: section 수만큼 dataclass 작성 (5+ 개), 일부 schema 가 nested 라 ConfigField 표현 제약

**옵션 B: 새로운 "Settings.json" 탭 — 직접 JSON 편집**

settings.json 파일 자체를 JSON tree editor 로 보여주기. 각 section 마다 schema validation.

장점: settings.json 의 모든 section 을 한 번에 다룸; nested 구조 자연스럽게 표현
단점: SettingsTab 과 두 군데서 "설정" 이 노출되는 혼란

**권장: 옵션 A (PR-D.3.4 의 PermissionsConfig 패턴 이어가기)**

각 section 마다:
- HooksConfig (subprocess entries 는 여전히 yaml 차원으로 두고, enable / opt-in toggle 만)
- SkillsConfig (user_skills_enabled toggle + paths)
- ModelConfig (default model + per-session override map)
- TelemetryConfig (enabled toggle + endpoint)
- NotificationsConfig (endpoint list — array of dicts 는 ConfigField 가 표현 어려움 → MULTISELECT 또는 별도 패널)

### 3.4 PR 분해

| PR | Scope | 추정 |
|---|---|---|
| 1 | HooksConfig dataclass + register_config | S |
| 2 | SkillsConfig dataclass | S |
| 3 | ModelConfig dataclass | S |
| 4 | TelemetryConfig dataclass | S |
| 5 | NotificationsConfig dataclass + endpoint 편집 패널 (array 처리) | M |
| 6 | SettingsTab 에 "Framework" / "Geny" 두 카테고리 분리 | XS |

→ 5 section × ~30 lines + 별도 array editor = 1 cycle 안 들어감.

### 3.5 부산물: Settings migration 상태 표시

PR-B.3.3 의 `migrate_yaml_to_settings_json` 결과를 SettingsTab 또는 별도 admin 패널에 노출:
- "settings.json 에 migrated section: [permissions, hooks]"
- "yaml 잔재: [notifications.yaml] — consider deleting"
- "BACKUP files: ~/.geny/permissions.yaml.bak"

operator 가 마이그레이션 상태를 한 번에 파악 가능.

---

## 4. PermissionsConfig (PR-D.3.4) 노출 검증

### 4.1 검증 절차

운영 환경에서:

```
1. 컨테이너 재시작 (PR-D.3.4 머지 후)
2. SettingsTab 열기
3. 좌측 카테고리 sidebar 에서 "general" 또는 "permissions" 확인
4. "Permissions" 카드 보이면 클릭 → 모달
5. "Runner mode" / "Executor mode" 두 SELECT 확인
6. dropdown options:
   - Runner: Advisory / Enforce
   - Executor: Default / Plan / Auto / Bypass / Accept Edits / Don't Ask
7. 변경 → Save → backend/log 에서 env_sync 호출 확인
```

### 4.2 안 보이면 진단

| 증상 | 원인 후보 |
|---|---|
| "Permissions" 카드가 카테고리에 없음 | sub_config 자동 발견 누락 — `service/config/__init__.py` 의 walker 가 `permissions_config.py` 를 import 하는지 확인 |
| 카드는 있지만 모달이 빈 form | get_fields_metadata 의 ConfigField list 가 ui 에 전달 안 됨 |
| Save 가 적용 안 됨 | env_sync apply_change 가 fire 안 됨 — backend log 확인 |

진단 절차는 별도 PR 로 ship — 지금 시점에서 알 수 없음.

---

## 5. 종합 PR 추정

| 갭 | PR 수 | 우선순위 |
|---|---|---|
| §1 Permission CRUD | 3 | HIGH |
| §2 Hook CRUD + In-process viewer | 3 | HIGH |
| §3 Framework section 편집기 | 6 | MED |
| §4 PermissionsConfig 노출 검증 + 디버깅 | 1 | LOW |

**총 ~13 PR.** §1 + §2 만 한 cycle 에 처리해도 큰 UX 향상.

---

## 다음 chapter

- [`04_gap_session_data.md`](04_gap_session_data.md) — Skill / Task / Cron payload 편집 갭
