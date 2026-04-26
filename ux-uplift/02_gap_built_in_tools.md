# 02. Deep Dive #1 — Built-in Tool Catalog

> **사용자 명시 1순위:** "geny-executor 가 제공하는 기본 built-in 도구들을 geny에서 열람할 방법이 없고, 그 built-in 도구 중 무엇을 사용할지 그런 것들도 전혀 셋팅 불가능해."

본 chapter 는 그 진단을 코드로 검증하고, 무엇이 어디까지 가능한지 명시한 후, 개선 설계의 baseline 을 깐다.

---

## 1. 현재 상태 — 코드 근거

### 1.1 Backend 표면

| 자원 | 위치 | 상태 |
|---|---|---|
| BUILT_IN_TOOL_CLASSES (33개) | `geny-executor/src/geny_executor/tools/built_in/__init__.py:82-121` | 모든 cycle A+B+D 도구 enumerate |
| BUILT_IN_TOOL_FEATURES (10개 그룹) | 같은 파일 | filesystem / shell / web / workflow / meta / agent / tasks / interaction / notification / mcp / worktree / dev / operator / messaging / cron |
| `/api/tools/catalog/built-in` | `Geny/backend/controller/tool_controller.py` | name + description 응답 — **input_schema 미포함** |
| `/api/tools/catalog/custom` | 같음 | 커스텀 Python tool |
| `/api/tools/catalog/mcp-servers` | 같음 | MCP 서버만 |

### 1.2 Manifest 결정 지점

| 항목 | 위치 |
|---|---|
| Worker 의 built-in tool 리스트 | `Geny/backend/service/environment/templates.py:104` → `_WORKER_BUILT_IN_TOOL_NAMES = ["*"]` |
| VTuber 의 built-in tool 리스트 | `Geny/backend/service/environment/templates.py:105` → `_VTUBER_BUILT_IN_TOOL_NAMES = []` |
| Manifest 빌드 | `Geny/backend/service/executor/default_manifest.py:545-628` → `build_default_manifest(preset, built_in_tool_names=...)` |
| 실제 도구 등록 | `geny-executor/src/geny_executor/core/pipeline.py` → `Pipeline.from_manifest_async` → `_register_built_ins` |

**핵심 hard-coding:**
```python
# Geny/backend/service/environment/templates.py
_WORKER_BUILT_IN_TOOL_NAMES: List[str] = ["*"]   # 모든 33개
_VTUBER_BUILT_IN_TOOL_NAMES: List[str] = []      # 0개
```

→ 다른 preset (developer / researcher / planner) 도 모두 `["*"]`.
→ Worker 의 33개 중 *일부만* 켜고 싶어도 불가능.

### 1.3 Frontend 표면

| 컴포넌트 | 위치 | 표시 내용 |
|---|---|---|
| SessionToolsTab | `Geny/frontend/src/components/tabs/SessionToolsTab.tsx` | 카운트만 (예: "Built-in: 33") |
| ToolSetsTab | `Geny/frontend/src/components/tabs/ToolSetsTab.tsx` | preset 단위로 custom_tools / mcp_servers 만 편집; built-in 은 read-only |
| BuilderTab | `Geny/frontend/src/components/tabs/BuilderTab.tsx` | manifest stage 편집 가능, 단 `tools.built_in` 은 schema 자체가 list of names 라 32개 chip 으로 표시되지 않음 |

**검증된 사실:**
- 33개 도구의 *개별 정보* (description / capabilities / input_schema) 를 볼 화면 0개
- preset 별 어떤 도구가 활성/비활성인지 한 눈에 보여주는 UI 0개
- 도구별 사용량 카운터 0개

### 1.4 사용자가 현재 할 수 있는 것 (전체)

```
✅ ToolSetsTab 에서 "내 preset 의 custom tool 목록" 편집
✅ ToolSetsTab 에서 "내 preset 의 MCP server 목록" 편집
✅ BuilderTab 에서 stage strategy / chain / artifact 편집
✅ ExecutionTimeline 에서 "지금 어떤 tool 이 fire 됐는지" 사후 확인
✅ SkillPanel 에서 등록된 skill chip 보기

❌ "Read tool 의 input_schema 가 무엇인지" 보기
❌ "내 worker preset 에 어떤 built-in 도구가 enable 됐는지" 보기
❌ "Bash + Edit + Write 만 켜고 싶음" 같은 fine-grained 선택
❌ "Cron 도구를 disable" 같은 도구 단위 deny
❌ "TaskCreate 가 무슨 일을 하는지" 도구 자체에 대한 설명 보기
```

---

## 2. 진단 — 왜 이런 상태가 됐는가

### 2.1 cycle A+B+D 의 무게중심이 backend 였음

`new-executor-uplift/00_layering_principle.md` 의 axiom:
- **EXEC-CORE** = framework 표준 (built-in tool 33개 포함)
- **SERVICE** = REST + UI

cycle 들이 EXEC-CORE 측 33개 도구를 ship 하면서 Geny SERVICE 측은 lifespan + REST 어댑터만 wired. UI 작업은 PR-D.3.x (frontend completion) 4개 PR 만 있었고 그 중 도구 카탈로그 viewer 는 없었다.

### 2.2 Tool preset 추상화가 built-in 을 가림

ToolPresetDefinition 은 `custom_tools` + `mcp_servers` 만 다룸. Built-in 은 framework concern 이라 의도적으로 preset 밖. 결과: ToolSetsTab 에서 사용자가 보는 것은 "내가 추가한 외부 도구" 뿐, 항상 동작하는 33개 framework 도구는 invisible.

### 2.3 Manifest schema 가 list of names

```python
# manifest.tools.built_in: ["Read", "Write", ...] 또는 ["*"]
```

스키마가 단순 문자열 list 라 도구별 metadata (왜 enable / disable 인지) 표현이 안 됨. Hardcoded `["*"]` 가 되는 이유.

### 2.4 BUILT_IN_TOOL_FEATURES 의 그룹 정보 미사용

executor 가 도구를 10개 feature group 으로 나눴음 (filesystem / shell / agent / tasks / cron / etc). 이 정보는 manifest 차원에서도 grouping 으로 활용 가능한데 Geny 가 사용 안 함.

---

## 3. 개선 설계 — 3 단계 (view → describe → edit)

### 3.1 단계 1: Built-in tool catalog viewer

**목표:** 사용자가 "내가 가진 33개 도구가 무엇이고 무엇을 하는지" 한 화면에서 본다.

**Backend:**
- `/api/tools/catalog/built-in` 응답을 풍부하게 — name, description, **input_schema**, **feature_group**, **capabilities**:
  ```python
  {
    "tools": [
      {
        "name": "Read",
        "description": "Read a file from the filesystem...",
        "input_schema": {...},  # JSONSchema
        "capabilities": {"concurrency_safe": true, "read_only": true, ...},
        "feature_group": "filesystem",
        "added_in": "1.0.0",  # version metadata
      },
      ...
    ],
    "groups": ["filesystem", "shell", "web", ...],
  }
  ```

**Frontend:**
- 새 탭 `ToolCatalogTab` 또는 SessionToolsTab 의 새 패널
- 좌측: feature group sidebar (filesystem / shell / agent / tasks / cron / etc)
- 중앙: 도구 카드 그리드 (name + 1-line desc + capability badges)
- 우측: 선택된 도구의 상세 — full description / input_schema / 출처 / 사용 예

→ 이 단계만 해도 UX 90% 향상. 사용자가 "Geny 가 무엇을 할 수 있는지" 알게 됨.

### 3.2 단계 2: Preset 별 활성 표시

**목표:** "내 worker preset 에서 33개 중 무엇이 enable 인가" 를 시각적으로 본다.

**Backend:**
- 각 preset 이 사용하는 manifest 의 `tools.built_in` 을 응답에 포함
- 새 endpoint `/api/environments/{id}/built-in-tools` 또는 기존 `/api/environments/{id}` 응답에 expand
  ```python
  {
    "preset_name": "worker_adaptive",
    "built_in": {
      "mode": "all",  # "all" | "explicit" | "none"
      "names": ["*"],
      "resolved": ["Read", "Write", ..., 33개],  # "*" 풀어서
    }
  }
  ```

**Frontend:**
- ToolCatalogTab 에 toggle: "Show: All Tools / Active in <preset>"
- Active 모드에서 각 도구 카드에 ✅ (active) / ⚪ (inactive) 표시
- preset 선택 dropdown

### 3.3 단계 3: Per-preset built-in 편집

**목표:** "Bash 만 켜고 Edit 은 끄기" 같은 fine-grained 편집.

**Backend 변경 필요:**
- Manifest schema 에 `tools.built_in` 의 `["*"]` 외에 explicit list 지원 (이미 가능).
- Hardcoded `_WORKER_BUILT_IN_TOOL_NAMES = ["*"]` 를 ToolPresetDefinition 에 union 시켜서 ToolPreset CRUD 로 편집 가능하게.

```python
class ToolPresetDefinition:
    custom_tools: List[str]
    mcp_servers: List[str]
    built_in_tools: List[str] = field(default_factory=lambda: ["*"])  # NEW
    built_in_mode: str = "all"  # "all" | "explicit" | "none" | "deny"
    built_in_deny: List[str] = field(default_factory=list)  # only if mode="deny"
```

**Frontend:**
- ToolSetsTab 의 preset edit 모달에 "Built-in tools" 섹션 추가
- Mode dropdown: All / Custom selection / Deny list / None
- Custom selection mode → 33개 체크박스
- Deny list mode → 33개 중 끄고 싶은 것만 체크

**검증 hook:**
- 변경 즉시 ExecutionTimeline 에서 deny 된 도구 호출이 PermissionDecision.deny 처럼 표시됨 → feedback loop closed.

---

## 4. 부산물: Tool 사용량 / 호출 카운터

별도 chapter 가 아닌 부산물:

- BackgroundTaskRunner / 매 tool fire 가 EventBus 에 emit
- 새 endpoint `/api/admin/tool-usage?since=<ts>` → tool별 호출 카운트 + 평균 latency
- Frontend ToolCatalogTab 의 도구 카드에 "Last 24h: 47 calls" 같은 메타 표시

이 부산물은 Observability chapter ([`05_gap_observability.md`](05_gap_observability.md)) 와도 겹치므로 그쪽에서 묶어 다룬다.

---

## 5. PR 분해 (구현 시)

| PR | Backend | Frontend | 추정 |
|---|---|---|---|
| 1 | `/api/tools/catalog/built-in` 응답 enrich (input_schema/capabilities/group/version) | — | S |
| 2 | — | `ToolCatalogTab` 신규 + sidebar 그룹 + 카드 + 상세 패널 | M |
| 3 | `/api/environments/{id}` 응답에 resolved built-in 추가 | — | S |
| 4 | — | ToolCatalogTab toggle "Active in preset" | S |
| 5 | ToolPresetDefinition 에 built_in_tools / built_in_mode / built_in_deny 필드 + migration | — | M |
| 6 | — | ToolSetsTab edit 모달 "Built-in tools" 섹션 | M |
| 7 | manifest 빌드 시 ToolPreset 의 built_in 필드 반영 | — | S |
| 8 | — | ExecutionTimeline 에 built-in deny 표시 | XS |

**총 ~8 PR.** 단계 1 (PR 1+2) 만 해도 UX 90% 향상.

---

## 6. 위험 + mitigation

| Risk | Mitigation |
|---|---|
| 33개 도구의 input_schema 가 큼 → 응답 페이로드 큼 | client-side lazy load (도구 클릭 시 fetch) |
| Built-in deny 로 framework 가 망가짐 (예: ExecutionTimeline 에 필요한 도구 deny) | warning + min-set 보호 (Read / WebFetch 같은 핵심은 deny 불가) |
| 기존 worker_adaptive preset 동작 변화 | default = "all" 유지 → 기존 사용자 zero impact |
| ToolPresetDefinition migration | 기존 preset 의 built_in_tools = `["*"]` 로 자동 채움 |

---

## 다음 chapter

- [`03_gap_settings_editing.md`](03_gap_settings_editing.md) — Permission / Hook / Settings.json 편집기 갭
