# Cycle B · 묶음 5 — Permission PLAN mode 확장 (3 PR)

**묶음 ID:** B.5
**Layer:** EXEC-CORE (PermissionMode enum 확장 + RuleSource ABC) + SERVICE (frontend toggle + preset default)
**격차:** B.6 / B.7 — 6 mode (acceptEdits / bypass / default / dontAsk / plan / auto) vs 4 (default/plan/auto/bypass), 7 source vs 5

---

# Part A — geny-executor (2 PR)

## PR-B.5.1 — feat(permission): PermissionMode enum 확장 (acceptEdits / dontAsk)

### Metadata
- **Branch:** `feat/permission-mode-accept-edits-dont-ask`
- **Repo:** geny-executor
- **Layer:** EXEC-CORE

### Files modified

#### `geny_executor/permission/types.py`

```python
class PermissionMode(str, Enum):
    DEFAULT      = "default"        # 기존
    BYPASS       = "bypass"         # 기존 (모든 ask → allow)
    PLAN         = "plan"           # 기존 (모든 destructive → deny)
    AUTO         = "auto"           # 기존 (LLM 자동 판단)
    
    # NEW (B.5.1)
    ACCEPT_EDITS = "acceptEdits"    # destructive_edit (Write/Edit/NotebookEdit) 자동 허용
    DONT_ASK     = "dontAsk"        # ask category 만 자동 허용 (deny 는 그대로)
```

#### `geny_executor/permission/guard.py`

```python
class PermissionGuard:
    async def check(self, request: PermissionRequest) -> PermissionDecision:
        rule = self._matrix.lookup(request.tool, request.input_data)
        
        if self.mode == PermissionMode.BYPASS:
            return PermissionDecision.allow(reason="bypass_mode")
        if self.mode == PermissionMode.PLAN:
            if request.tool_destructive:
                return PermissionDecision.deny(reason="plan_mode_blocks_destructive")
        # NEW
        if self.mode == PermissionMode.ACCEPT_EDITS:
            if rule.action == "ask" and request.tool in EDIT_TOOLS:
                return PermissionDecision.allow(reason="accept_edits_mode")
        if self.mode == PermissionMode.DONT_ASK:
            if rule.action == "ask":
                return PermissionDecision.allow(reason="dont_ask_mode")
        
        # 기존 default / auto 흐름
        ...


EDIT_TOOLS = {"Write", "Edit", "NotebookEdit", "MultiEdit"}
```

### Tests added

`tests/permission/test_modes.py`

- `test_accept_edits_allows_write_when_ask`
- `test_accept_edits_does_not_affect_deny`
- `test_accept_edits_does_not_affect_non_edit_tools`
- `test_dont_ask_allows_all_ask_rules`
- `test_dont_ask_does_not_affect_deny`
- `test_existing_modes_unchanged` (default/bypass/plan/auto 회귀 0)

### Acceptance criteria
- [ ] 2 mode 추가
- [ ] 6 test pass
- [ ] CHANGELOG.md 1.2.0: "Add acceptEdits/dontAsk permission modes"

---

## PR-B.5.2 — feat(permission): RuleSource ABC + flag/policy/session sources

### Metadata
- **Branch:** `feat/permission-rule-source-abc`
- **Repo:** geny-executor
- **Layer:** EXEC-CORE + EXEC-INTERFACE

### Files added

#### `geny_executor/permission/source_abc.py` (~80 lines)

```python
class RuleSource(ABC):
    """A source of permission rules. Loaded in priority order."""
    
    name: str   # "user" | "project" | "local" | "flag" | "policy" | "session"
    priority: int   # higher = wins on conflict
    
    @abstractmethod
    async def load(self) -> List[PermissionRule]: ...


class StaticListSource(RuleSource):
    def __init__(self, name: str, priority: int, rules: List[PermissionRule]):
        self.name, self.priority, self._rules = name, priority, rules
    async def load(self): return list(self._rules)


class FlagSource(RuleSource):
    """CLI flag --permission-allow / --permission-deny.
    Service can construct from request args."""
    name = "flag"
    priority = 100
    def __init__(self, allow: List[str], deny: List[str]):
        self._rules = [...]
    async def load(self): return self._rules


class PolicySource(RuleSource):
    """Org-wide policy. Highest priority. Loaded from settings.policy."""
    name = "policy"
    priority = 200


class SessionSource(RuleSource):
    """Per-session ephemeral rules. Lost on session end."""
    name = "session"
    priority = 50
    def __init__(self):
        self._rules: List[PermissionRule] = []
    def add(self, rule: PermissionRule): self._rules.append(rule)
    async def load(self): return list(self._rules)
```

#### `geny_executor/permission/source_registry.py` (~60 lines)

```python
class RuleSourceRegistry:
    def __init__(self):
        self._sources: List[RuleSource] = []
    
    def register(self, source: RuleSource) -> None:
        self._sources.append(source)
        self._sources.sort(key=lambda s: s.priority, reverse=True)
    
    async def collect_all(self) -> List[PermissionRule]:
        out = []
        for src in self._sources:
            out.extend(await src.load())
        return out
```

### Files modified

- `geny_executor/permission/loader.py` — `load_permissions` 가 RuleSourceRegistry 활용. settings.json 의 sources 외에 register 된 source 도 모두 collect.

### Tests added

`tests/permission/test_rule_sources.py`

- `test_static_list_source`
- `test_flag_source_constructs_rules`
- `test_policy_source_loads_from_settings`
- `test_session_source_add_then_load`
- `test_registry_orders_by_priority`
- `test_collect_all_aggregates`
- `test_higher_priority_wins_on_conflict`

### Acceptance criteria
- [ ] 4 RuleSource subclass + registry
- [ ] 7 test pass
- [ ] 기존 user/project/local source 와 호환
- [ ] CHANGELOG.md 1.2.0: "Add RuleSource ABC + flag/policy/session sources"

---

# Part B — Geny (1 PR)

## PR-B.5.3 — feat(frontend): 새 PLAN mode toggle + preset default

### Metadata
- **Branch:** `feat/frontend-permission-modes`
- **Repo:** Geny
- **Layer:** SERVICE
- **Depends on:** PR-B.5.1 + Geny pyproject 1.2.0 bump

### Files modified

#### `frontend/src/components/SettingsPanel.tsx` (또는 PermissionPanel)

PermissionMode dropdown 에 2 추가:
- "Accept Edits (자동 허용 Write/Edit)" — value `acceptEdits`
- "Don't Ask (모든 ask → allow)" — value `dontAsk`

#### `frontend/src/types/permission.ts`

```typescript
export type PermissionMode =
  | "default" | "bypass" | "plan" | "auto"
  | "acceptEdits" | "dontAsk";  // NEW
```

#### `backend/controller/permission_controller.py`

PermissionMode enum 의 새 value 통과시키기:

```python
class PermissionModeRequest(BaseModel):
    mode: Literal["default", "bypass", "plan", "auto", "acceptEdits", "dontAsk"]
```

#### `backend/service/permission/install.py`

기본 preset 별 권장 mode 가이드:
- `worker_adaptive`: default
- `vtuber`: dontAsk (대화형, 빠른 반응)

settings.preset.default_permission_mode 추가 (PresetSection 에).

### Tests added

`backend/tests/controller/test_permission_modes.py`

- `test_set_mode_accept_edits`
- `test_set_mode_dont_ask`
- `test_invalid_mode_400`

### Acceptance criteria
- [ ] frontend dropdown 에 2 mode 추가
- [ ] backend 가 새 mode 수용
- [ ] preset 별 default mode 동작 (vtuber → dontAsk)
- [ ] 3 test pass

### Risk / mitigation
| Risk | Mitigation |
|---|---|
| 운영자가 acceptEdits 로 두고 prod 데이터 변조 | UI 에 "이 mode 는 destructive edit 자동 허용" 경고 표시 |
| dontAsk 가 ask 만 변환하지만 사용자는 deny 도 풀린 것으로 오해 | tooltip 명확히 |

---

## 묶음 합계

| PR | Repo | 의존 |
|---|---|---|
| PR-B.5.1 | executor | — |
| PR-B.5.2 | executor | — |
| PR-B.5.3 | Geny | B.5.1 + Geny pyproject 1.2.0 |

총 3 PR. 다음: [`cycle_B_p1_6_worktree_lsp_depth.md`](cycle_B_p1_6_worktree_lsp_depth.md).
