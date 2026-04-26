# 07. Design Sketches — Top 5 Priorities

P0 묶음의 5 항목에 대한 *implementable design baseline*. 각 sketch 는:
- 화면 레이아웃 (ASCII wireframe)
- 신규 / 수정 file 경로
- 백엔드 schema (pydantic)
- 핵심 frontend 컴포넌트 골격
- acceptance criteria
- risk + mitigation

---

## D1 — ToolCatalogTab (P0.1)

### Wireframe

```
┌─────────────────────────────────────────────────────────────────┐
│  Tool Catalog                              [All ▾] [In preset ▾]│
├──────────┬──────────────────────────────────────────────────────┤
│ Filter   │  filesystem (6 tools)                                │
│ ─────── │  ┌─────────────────┬─────────────────┬─────────────┐ │
│ All      │  │ Read     ✅    │ Write    ✅    │ Edit    ✅  │ │
│ filesys… │  │ ──────────     │ ──────────     │ ──────────  │ │
│ shell    │  │ Read a file…   │ Write content… │ Modify…     │ │
│ web      │  │ read_only      │ destructive    │ destructive │ │
│ workflow │  └─────────────────┴─────────────────┴─────────────┘ │
│ meta     │  ┌─────────────────┬─────────────────┬─────────────┐ │
│ agent ▼  │  │ Glob     ✅    │ Grep     ✅    │ NotebookEdit│ │
│ tasks    │  └─────────────────┴─────────────────┴─────────────┘ │
│ cron     │                                                       │
│ mcp      │  shell (1 tool)                                       │
│ worktree │  ┌─────────────────┐                                  │
│ dev      │  │ Bash     ✅    │                                  │
│ operator │  └─────────────────┘                                  │
│ messag…  │                                                       │
│ notif…   │  ... (다른 그룹들)                                     │
│ interact │                                                       │
└──────────┴──────────────────────────────────────────────────────┘
```

좌측 sidebar 에 카테고리 (BUILT_IN_TOOL_FEATURES 의 10 그룹). 중앙은 그룹별 카드 그리드. 카드 클릭 시 우측 패널 expand.

### 카드 클릭 시 우측 패널

```
┌─────────────────────────────────────────────────────────────────┐
│  Read                                                  ✕ 닫기   │
├─────────────────────────────────────────────────────────────────┤
│  Group: filesystem    Added: 1.0.0    Capabilities: read-only,  │
│                                       concurrency-safe          │
│                                                                 │
│  Description                                                    │
│  Read a file from the filesystem. Returns content with line     │
│  numbers. Use offset and limit to read specific portions of     │
│  large files.                                                   │
│                                                                 │
│  Input schema (JSONSchema)                                      │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │ {                                                          │ │
│  │   "type": "object",                                        │ │
│  │   "required": ["file_path"],                               │ │
│  │   "properties": { ... }                                    │ │
│  │ }                                                          │ │
│  └───────────────────────────────────────────────────────────┘ │
│                                                                 │
│  Active in presets                                              │
│  ✅ worker_adaptive   ✅ developer   ✅ researcher    ❌ vtuber │
│                                                                 │
│  Recent activity (last 24h)                                     │
│  47 calls · avg 12ms · last: 2분 전                             │
└─────────────────────────────────────────────────────────────────┘
```

### Backend

**파일 신규 / 수정:**

- `backend/controller/tool_controller.py` (수정 — built-in 응답 enrich)
- `backend/service/tools/built_in_view.py` (신규 — 응답 빌드 헬퍼)

**응답 schema:**

```python
class BuiltInToolDetail(BaseModel):
    name: str
    description: str
    feature_group: str  # "filesystem" | "shell" | ...
    capabilities: Dict[str, Any]
    input_schema: Dict[str, Any]
    added_in: Optional[str] = None  # version metadata
    active_in: Dict[str, bool] = Field(default_factory=dict)
    # {preset_name: True/False} — populated when query=?with-preset=worker_adaptive

class BuiltInCatalogResponse(BaseModel):
    tools: List[BuiltInToolDetail]
    groups: List[str]  # 모든 feature group 이름
```

**사용:** 
```
GET /api/tools/catalog/built-in
GET /api/tools/catalog/built-in?with-preset=worker_adaptive
```

### Frontend

**파일 신규:**

- `frontend/src/components/tabs/ToolCatalogTab.tsx`
- `frontend/src/api/toolCatalog.ts`
- `frontend/src/lib/i18n/{en,ko}.ts` — `tabs.toolCatalog`
- `frontend/src/components/TabNavigation.tsx` (수정 — 'toolCatalog' 추가)
- `frontend/src/components/TabContent.tsx` (수정 — TAB_MAP)

**컴포넌트 골격:**

```tsx
export function ToolCatalogTab() {
  const [presetFilter, setPresetFilter] = useState<string>('all');
  const [groupFilter, setGroupFilter] = useState<string>('all');
  const [tools, setTools] = useState<BuiltInToolDetail[]>([]);
  const [selected, setSelected] = useState<BuiltInToolDetail | null>(null);
  const [presetList, setPresetList] = useState<string[]>([]);

  useEffect(() => {
    toolCatalogApi.builtIn(presetFilter !== 'all' ? presetFilter : undefined)
      .then(r => setTools(r.tools));
  }, [presetFilter]);

  const visible = tools.filter(t =>
    groupFilter === 'all' || t.feature_group === groupFilter
  );

  return (
    <div className="flex h-full">
      <Sidebar groups={...} active={groupFilter} onChange={setGroupFilter} />
      <main className="flex-1 overflow-auto p-4">
        <header>...</header>
        <CardGrid tools={visible} onSelect={setSelected} presetFilter={presetFilter} />
      </main>
      {selected && <DetailPanel tool={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
```

### Acceptance criteria

- [ ] 33 도구 모두 표시
- [ ] 그룹별 sidebar 작동 (10 그룹)
- [ ] 카드 클릭 시 상세 패널 (description / input_schema / active_in)
- [ ] preset filter "Active in <preset>" 시 비활성 도구 회색 처리
- [ ] 모바일 반응형 (sidebar collapse)
- [ ] 운영 manual smoke: ToolCatalogTab → Read 카드 → input_schema 확인 OK

### Risk + mitigation

| Risk | Mitigation |
|---|---|
| input_schema 가 큼 → 카드 그리드 응답 페이로드 폭주 | 카드 응답에는 description 만, input_schema 는 detail endpoint (`/api/tools/catalog/built-in/{name}`) 별도 lazy fetch |
| preset 별 active 표시 누락 | with-preset query 처리 helper 명확히 분리 |
| 새 cycle 에서 도구 추가 시 그룹 누락 | BUILT_IN_TOOL_FEATURES 누락 catch 위해 cross-import audit (cycle C 패턴) 추가 |

---

## D2 — PermissionsTab (P0.2)

### Wireframe

```
┌─────────────────────────────────────────────────────────────────┐
│  Permissions                                       [Add rule +] │
├─────────────────────────────────────────────────────────────────┤
│  Mode: [advisory ▾]  Executor: [default ▾]    [Save]            │
│                                                                 │
│  Rules (12)                                  Source priority:   │
│  ┌─────────────────────────────────────────┐  CLI > LOCAL >     │
│  │ Tool        Pattern         Behavior    │  PROJECT > USER >  │
│  │ ──────      ───────         ────────    │  PRESET            │
│  │ Bash        git push *      ASK   [✏][🗑]│                    │
│  │ Bash        rm -rf *        DENY  [✏][🗑]│                    │
│  │ Write       *.env           DENY  [✏][🗑]│                    │
│  │ *           *               ALLOW [✏][🗑]│                    │
│  └─────────────────────────────────────────┘                    │
│                                                                 │
│  Recent decisions (last 50)                          [📊 view]  │
│  ─────────────────────────                                      │
│  10:23  Bash     git push origin main          ASK    matched: bash#1│
│  10:22  Read     /etc/passwd                   DENY   matched: write#3│
│  10:21  WebFetch https://api.example.com       ALLOW  no match  │
└─────────────────────────────────────────────────────────────────┘
```

### Backend

**Endpoint 신규:**

```python
# /api/permissions/rules POST/PUT/DELETE
# /api/permissions/recent-decisions?limit=50 GET

class RulePayload(BaseModel):
    tool_name: str  # "*" or specific name
    behavior: Literal["allow", "deny", "ask"]
    pattern: Optional[str] = None
    reason: Optional[str] = None
    source: Literal["user", "project", "local"] = "user"

class RecentDecision(BaseModel):
    ts: str
    tool_name: str
    input_summary: str  # truncated
    behavior: str
    matched_rule_id: Optional[str]
    reason: Optional[str]
```

**Mutation 위치:** `service/permission/install.py` 옆에 `service/permission/store.py` 신규 — settings.json 의 permissions section 을 read/modify/write.

### Frontend

**파일 신규:**

- `frontend/src/components/tabs/PermissionsTab.tsx`
- `frontend/src/api/permissions.ts`
- `frontend/src/components/permissions/RuleEditModal.tsx`

**Add rule 모달:**
- Tool dropdown (built-in catalog + custom + "*")
- Behavior radio (allow / deny / ask)
- Pattern input (with example placeholders)
- Reason textarea (optional, shown in audit log)
- Source dropdown (user / project / local)

### Acceptance criteria

- [ ] rule CRUD 작동 (settings.json:permissions 에 즉시 반영)
- [ ] rule 즉시 효력 발휘 (다음 tool 호출부터)
- [ ] recent decisions 50개 표시 + auto-refresh (10s)
- [ ] ExecutionTimeline detail panel 에 matched rule 표시 (D4 와 협업)

---

## D3 — HooksTab (P0.3)

### Wireframe

```
┌─────────────────────────────────────────────────────────────────┐
│  Hooks                                          [Add entry +]   │
├─────────────────────────────────────────────────────────────────┤
│  Status:  ✅ Subprocess hooks ENABLED (GENY_ALLOW_HOOKS=1)       │
│           ✅ In-process handlers: 3 active                       │
│                                                                 │
│  Subprocess entries (5)                                         │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │ Event          Command                Timeout    Actions  │ │
│  │ ────────      ────────                ──────     ───────  │ │
│  │ PRE_TOOL_USE  bash /audit/pre.sh      5000ms    [✏][🗑]  │ │
│  │ POST_TOOL_USE python notify.py        2000ms    [✏][🗑]  │ │
│  │ ...                                                        │ │
│  └───────────────────────────────────────────────────────────┘ │
│                                                                 │
│  In-process handlers                                            │
│  ─────────────────                                              │
│  PRE_TOOL_USE  → log_permission_denied (Geny default)           │
│  PRE_TOOL_USE  → log_high_risk_tool_call (Geny default)         │
│  POST_TOOL_USE → observe_post_tool_use (Geny default)           │
│                                                                 │
│  Recent fires (last 100)                              [⏸ pause] │
│  ────────────────────                                           │
│  10:23.412  PRE_TOOL_USE   Bash       passthrough  1.2ms        │
│  10:23.408  POST_TOOL_USE  Read       passthrough  0.8ms        │
│  ...                                                            │
└─────────────────────────────────────────────────────────────────┘
```

### Backend

**Endpoint 신규:**

```python
# /api/hooks/entries POST/PUT/DELETE
# /api/hooks/in-process GET — list of handlers (read only)
# /api/admin/hook-fires?limit=100 GET — ring buffer

class HookEntryPayload(BaseModel):
    event: str  # HookEvent enum value
    command: List[str]
    timeout_ms: int = 5000
    allow_blocking: bool = True
    matchers: Optional[Dict[str, Any]] = None
    working_dir: Optional[str] = None
```

**executor PR 필요:**
- HookRunner 에 fire ring buffer 추가 (PR-B.1.1 패턴)
- `runner.recent_fires(limit)` 메소드 노출

### Frontend

**파일 신규:**

- `frontend/src/components/tabs/HooksTab.tsx`
- `frontend/src/api/hooks.ts`

### Acceptance criteria

- [ ] subprocess entry CRUD
- [ ] in-process handler 목록 표시 (read-only)
- [ ] recent fires log 100개 + 5s polling
- [ ] env opt-in 상태 표시 (변경은 backend 재시작 필요한 안내)

---

## D4 — Recent Activity Panel (P0.4)

### Wireframe (AdminPanel 확장)

```
┌─────────────────────────────────────────────────────────────────┐
│  Admin                                                          │
├─────────────────────────────────────────────────────────────────┤
│  ▸ Sessions overview                                            │
│  ▸ Permissions activity                                         │
│  ▸ Recent tool activity                              [Auto ▾]   │
│    ─────────────────────                                        │
│    ts          session    tool         duration  details        │
│    10:23.4     sess-123   Bash         1.2s      pid=42 exit=0  │
│    10:23.0     sess-123   Read         0.05s     /work/x.py     │
│    10:22.8     sess-456   WebFetch     2.4s      api.example.com│
│    ...                                                          │
│  ▸ Permission decisions                                         │
│    ─────────────────                                            │
│    ts          tool      behavior   matched    reason           │
│    10:23.4     Bash      ASK        rule#1     git push *       │
│    ...                                                          │
└─────────────────────────────────────────────────────────────────┘
```

### CommandTab 헤더 workspace badge

```
┌─────────────────────────────────────────────────────────────────┐
│  Session sess-123                                               │
│  📁 Workspace: feature-x @ /work/.worktrees/feature-x  [🔍]   │
│  ─────────────────────────────────────────────────────────────  │
│  ... ExecutionTimeline ...                                      │
```

클릭 시 모달:

```
┌──────────────────────────────────┐
│  Workspace stack (depth 2)       │
├──────────────────────────────────┤
│  ↑ feature-x (current)           │
│    /work/.worktrees/feature-x    │
│    LSP: pyright-session-42       │
│  ↑ main (parent)                 │
│    /work                         │
│                                  │
│         [Cleanup all worktrees]  │
└──────────────────────────────────┘
```

### Backend

**Endpoint 신규:**

```python
# /api/admin/recent-tool-events?limit=100&since=<ts>
# /api/admin/recent-permissions?limit=100&since=<ts>
# /api/agents/{sid}/workspace GET
# /api/agents/{sid}/workspace/cleanup POST  (option: pop_all)
```

### Frontend

- `frontend/src/components/admin/RecentActivityPanel.tsx`
- `frontend/src/components/WorkspaceBadge.tsx` (CommandTab 헤더 mount)
- `frontend/src/components/WorkspaceStackModal.tsx`

### Acceptance criteria

- [ ] AdminPanel 에 두 패널 (tool activity + permission)
- [ ] auto-refresh (5s)
- [ ] CommandTab 헤더에 workspace badge 표시 (worktree push 후)
- [ ] cleanup 버튼 → 모든 worktree pop + remove

---

## D5 — Built-in Tool Per-preset Editor (P1.5, but referenced from D1)

D1 의 후속. ToolPresetDefinition 에 `built_in_tools` 필드 추가 + ToolSetsTab edit 모달의 새 섹션.

### ToolSetsTab edit 모달 (신규 섹션)

```
┌─────────────────────────────────────────────────────────────────┐
│  Edit preset: my-custom                                         │
├─────────────────────────────────────────────────────────────────┤
│  Name:        [my-custom              ]                         │
│  Description: [...]                                             │
│                                                                 │
│  ▼ Built-in tools                                               │
│    Mode: ( ) All tools                                          │
│           (•) Selected tools                                    │
│           ( ) None                                              │
│           ( ) Deny list (all minus selected)                    │
│                                                                 │
│    Selection:                                                   │
│    ┌─────────────────────────────────────────────────────────┐ │
│    │ filesystem                                               │ │
│    │  ☑ Read       ☑ Write       ☑ Edit                     │ │
│    │  ☐ Glob       ☐ Grep        ☐ NotebookEdit             │ │
│    │ shell                                                    │ │
│    │  ☑ Bash                                                  │ │
│    │ tasks                                                    │ │
│    │  ☐ TaskCreate  ☐ TaskGet    ☐ TaskList                 │ │
│    │  ...                                                     │ │
│    └─────────────────────────────────────────────────────────┘ │
│                                                                 │
│  ▼ Custom tools                                                 │
│    ...                                                          │
│  ▼ MCP servers                                                  │
│    ...                                                          │
└─────────────────────────────────────────────────────────────────┘
```

### Backend

```python
# ToolPresetDefinition 확장
class ToolPresetDefinition(BaseModel):
    custom_tools: List[str]
    mcp_servers: List[str]
    # NEW
    built_in_tools: List[str] = Field(default_factory=lambda: ["*"])
    built_in_mode: Literal["all", "selected", "none", "deny"] = "all"
    built_in_deny: List[str] = Field(default_factory=list)
```

Manifest 빌드 시:
- mode == "all" → `["*"]` (현 동작)
- mode == "selected" → `built_in_tools`
- mode == "none" → `[]`
- mode == "deny" → `["*"]` 후 `built_in_deny` 차감 (Pipeline 측 수정 필요)

### Acceptance criteria

- [ ] preset edit 모달에 "Built-in tools" 섹션
- [ ] 4 mode 모두 작동
- [ ] manifest 가 정확한 list of names 생성
- [ ] 기존 preset 의 default = "all" → 회귀 0

---

## 종합 PR 정리

| Sketch | PR 수 | 우선순위 |
|---|---|---|
| D1 ToolCatalogTab | 4 | P0 |
| D2 PermissionsTab | 3 | P0 |
| D3 HooksTab | 3 | P0 |
| D4 Recent Activity + Workspace badge | 5 | P0 |
| D5 Built-in tool per-preset editor | 4 | P1 |

P0 합계 **15 PR.** D5 는 P1 의 다음 cycle 로.

---

## 본 분석의 마무리

- [`index.md`](index.md) — folder navigation
- [`00_methodology.md`](00_methodology.md) — 갭 식별 방법론
- [`01_capability_visibility_matrix.md`](01_capability_visibility_matrix.md) — 93 항목 매트릭스
- [`02_gap_built_in_tools.md`](02_gap_built_in_tools.md) — Deep dive 1
- [`03_gap_settings_editing.md`](03_gap_settings_editing.md) — Deep dive 2
- [`04_gap_session_data.md`](04_gap_session_data.md) — Deep dive 3
- [`05_gap_observability.md`](05_gap_observability.md) — Deep dive 4
- [`06_priority_buckets.md`](06_priority_buckets.md) — P0/P1/P2
- [`07_design_sketches.md`](07_design_sketches.md) — 이 파일

본 분석은 *report*. 사용자가 P0 cycle 시작 시 [`07_design_sketches.md`](07_design_sketches.md) 의 D1~D4 를 plan baseline 으로 사용 권장. 상세 plan 은 별도 폴더에서 (cycle A+B+D 의 `plan/` 패턴 따라).
