# Cycle B · 묶음 3 — Settings.json 통일 (5 PR)

**묶음 ID:** B.3
**Layer:** EXEC-CORE (loader + 표준 section schema) + EXEC-INTERFACE (register_section ABC) + SERVICE (migrator + Geny 전용 section + 기존 install.py 들 swap)
**격차:** K.38 / K.39 / K.41 — claude-code 의 settings.json (user/project/local) hierarchy
**의존성:** 없음 — 독립

---

# Part A — geny-executor (2 PR)

## PR-B.3.1 — feat(settings): SettingsLoader + section schema

### Metadata
- **Branch:** `feat/settings-json-loader`
- **Repo:** geny-executor
- **Layer:** EXEC-CORE

### Files added

#### `geny_executor/settings/__init__.py`

```python
from .loader import SettingsLoader, get_default_loader
from .schema import (
    PermissionsSection, HooksSection, SkillsSection,
    ModelSection, TelemetrySection, NotificationsSection,
)
from .section_registry import register_section, get_section_schema

__all__ = [
    "SettingsLoader", "get_default_loader",
    "PermissionsSection", "HooksSection", "SkillsSection",
    "ModelSection", "TelemetrySection", "NotificationsSection",
    "register_section", "get_section_schema",
]
```

#### `geny_executor/settings/loader.py` (~200 lines)

```python
from __future__ import annotations
import json
import logging
from pathlib import Path
from typing import Any, Dict, List, Optional, Type

from pydantic import BaseModel, ValidationError

logger = logging.getLogger(__name__)


class SettingsLoader:
    """Hierarchical settings.json loader.
    
    Path priority (last wins):
      1. user   (e.g. ~/.geny/settings.json)
      2. project (e.g. .geny/settings.json)
      3. local  (e.g. .geny/settings.local.json — gitignored)
    
    Each level is a JSON file. Sections deep-merge; arrays in section
    schema decide concat vs override (default: override).
    """

    def __init__(self, paths: List[Path]) -> None:
        self._paths = list(paths)
        self._raw: Dict[str, Any] = {}
        self._loaded = False

    def load(self) -> Dict[str, Any]:
        merged: Dict[str, Any] = {}
        for p in self._paths:
            if not p.exists(): continue
            try:
                data = json.loads(p.read_text())
            except json.JSONDecodeError as e:
                logger.error("settings_invalid_json", path=str(p), error=str(e))
                continue
            if not isinstance(data, dict):
                logger.error("settings_root_not_object", path=str(p))
                continue
            merged = _deep_merge(merged, data)
        self._raw = merged
        self._loaded = True
        return merged

    def get_section(self, name: str, default: Optional[Any] = None) -> Any:
        if not self._loaded: self.load()
        section = self._raw.get(name, default)
        # validate via schema if registered
        from .section_registry import get_section_schema
        schema = get_section_schema(name)
        if schema is not None and section is not None:
            try:
                return schema(**section)
            except ValidationError as e:
                logger.error("settings_section_validation_failed", name=name, error=str(e))
                return None
        return section

    def reload(self) -> Dict[str, Any]:
        self._loaded = False
        return self.load()


_DEFAULT: Optional[SettingsLoader] = None

def get_default_loader() -> SettingsLoader:
    global _DEFAULT
    if _DEFAULT is None:
        _DEFAULT = SettingsLoader(paths=[])  # service registers paths
    return _DEFAULT


def _deep_merge(base: Dict, overlay: Dict) -> Dict:
    out = dict(base)
    for k, v in overlay.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = v
    return out
```

#### `geny_executor/settings/schema.py` (~150 lines)

```python
from typing import Dict, List, Optional
from pydantic import BaseModel, Field


class PermissionRule(BaseModel):
    tool: str
    pattern: Optional[str] = "*"
    reason: Optional[str] = None


class PermissionsSection(BaseModel):
    mode: str = "advisory"   # advisory | enforce
    allow: List[PermissionRule] = []
    deny: List[PermissionRule] = []
    ask: List[PermissionRule] = []


class HookEntry(BaseModel):
    command: List[str]                # ["bash", "/path/to/audit.sh"]
    timeout_ms: int = 5000
    allow_blocking: bool = True


class HooksSection(BaseModel):
    enabled: bool = True
    entries: Dict[str, List[HookEntry]] = {}    # event_name → entries


class SkillsSection(BaseModel):
    user_skills_enabled: bool = False
    additional_paths: List[str] = []


class ModelSection(BaseModel):
    default: str = "claude-haiku-4-5-20251001"
    session_overrides: Dict[str, str] = {}


class TelemetrySection(BaseModel):
    enabled: bool = False
    endpoint: Optional[str] = None
    sample_rate: float = 1.0


class NotificationEndpointConfig(BaseModel):
    name: str
    url: str
    headers: Optional[Dict[str, str]] = None
    description: Optional[str] = None


class NotificationsSection(BaseModel):
    endpoints: List[NotificationEndpointConfig] = []
```

### Tests added

`tests/settings/test_loader.py`

- `test_load_single_file`
- `test_load_merges_user_then_project_then_local`
- `test_invalid_json_skipped_with_log`
- `test_root_not_object_skipped`
- `test_get_section_validates_via_schema`
- `test_get_section_invalid_returns_none`
- `test_reload_picks_up_changes`
- `test_deep_merge_dict_recursion`
- `test_deep_merge_overlay_overrides_array`

`tests/settings/test_schema.py`

- 각 section 의 default + parse 테스트 (~10 test)

### Acceptance criteria
- [ ] SettingsLoader + 6 section schema ship
- [ ] 19 test pass
- [ ] line coverage ≥ 95%
- [ ] CHANGELOG.md 1.2.0: "Add SettingsLoader (settings.json hierarchy) + 6 standard sections"

---

## PR-B.3.2 — feat(settings): register_section ABC + integration with existing systems

### Metadata
- **Branch:** `feat/settings-section-registry`
- **Repo:** geny-executor
- **Layer:** EXEC-INTERFACE
- **Depends on:** PR-B.3.1

### Files added

#### `geny_executor/settings/section_registry.py` (~80 lines)

```python
from typing import Dict, Optional, Type
from pydantic import BaseModel
from .schema import (
    PermissionsSection, HooksSection, SkillsSection,
    ModelSection, TelemetrySection, NotificationsSection,
)

_REGISTRY: Dict[str, Type[BaseModel]] = {
    "permissions": PermissionsSection,
    "hooks": HooksSection,
    "skills": SkillsSection,
    "model": ModelSection,
    "telemetry": TelemetrySection,
    "notifications": NotificationsSection,
}


def register_section(name: str, schema: Type[BaseModel]) -> None:
    """Register a custom settings section (service-side).
    Service can extend the standard schema set without forking the loader.
    """
    if name in _REGISTRY:
        logger.warning("settings_section_overwritten", name=name)
    _REGISTRY[name] = schema


def get_section_schema(name: str) -> Optional[Type[BaseModel]]:
    return _REGISTRY.get(name)


def list_section_names() -> List[str]:
    return list(_REGISTRY.keys())
```

### Files modified

#### `geny_executor/permission/loader.py`

기존 yaml.load 호출을 settings.json 우선으로:

```python
def load_permissions() -> PermissionsSection:
    loader = get_default_loader()
    section = loader.get_section("permissions")
    if section is not None:
        return section
    # fallback: 기존 yaml (deprecation window)
    return _load_legacy_yaml()
```

같은 패턴을 `hooks/loader.py`, `skills/loader.py` 에도 적용 — 단 **본 PR 은 fallback 만 추가**, 기존 yaml 코드 보존. 진정한 swap 은 Geny 측 PR-B.3.4.

### Tests added

`tests/settings/test_section_registry.py`

- `test_default_six_sections_registered`
- `test_register_custom_section`
- `test_register_overwrite_warns`
- `test_get_section_schema_returns_none_for_unknown`

`tests/permission/test_loader_settings_json.py`

- `test_loads_from_settings_json_when_present`
- `test_falls_back_to_yaml_when_settings_missing`

### Acceptance criteria
- [ ] register_section API ship
- [ ] 6 default section + 추가 가능
- [ ] 6 test pass
- [ ] 기존 yaml fallback 동작 (회귀 0)
- [ ] CHANGELOG.md 1.2.0: "Add settings section registry + permissions loader integration"

---

# Part B — Geny (3 PR)

## PR-B.3.3 — feat(service): settings.json migrator (4 YAML → settings.json)

### Metadata
- **Branch:** `feat/settings-migrator`
- **Repo:** Geny
- **Layer:** SERVICE
- **Depends on:** PR-B.3.1, Geny pyproject 1.2.0 bump

### Files added

#### `backend/service/settings/__init__.py`
#### `backend/service/settings/migrator.py` (~200 lines)

```python
"""One-shot migrator: 기존 4 YAML → ~/.geny/settings.json.

Detects:
  ~/.geny/permissions.yaml  → settings.json:permissions
  ~/.geny/hooks.yaml        → settings.json:hooks
  ~/.geny/skills.yaml       → settings.json:skills (user_skills_enabled 등)
  ~/.geny/credentials.json  → 별도 keep (settings 가 아님)

Behavior:
  - settings.json 이 이미 있으면: backup 후 merge (기존 우선)
  - 각 source YAML 은 ~/.geny/<name>.yaml.bak 으로 rename
  - migration log 출력 (어떤 file 이 migrated 됐는지)
  - idempotent (두 번 실행해도 안전)
"""

import json
import shutil
import yaml
from pathlib import Path
from typing import Dict, Any
from logging import getLogger

logger = getLogger(__name__)


def migrate_to_settings_json(home: Path = Path("~/.geny").expanduser()) -> Dict[str, Any]:
    """Migrate 4 YAML to settings.json. Returns the merged settings dict."""
    settings_path = home / "settings.json"
    backup_path = home / "settings.json.bak"
    
    existing: Dict[str, Any] = {}
    if settings_path.exists():
        existing = json.loads(settings_path.read_text())
        shutil.copyfile(settings_path, backup_path)
    
    migrated: Dict[str, Any] = dict(existing)
    
    sources = [
        ("permissions.yaml", "permissions"),
        ("hooks.yaml", "hooks"),
        ("skills.yaml", "skills"),
    ]
    for fname, section_name in sources:
        src = home / fname
        if not src.exists(): continue
        try:
            data = yaml.safe_load(src.read_text()) or {}
        except yaml.YAMLError as e:
            logger.error("migrate_yaml_invalid", path=str(src), error=str(e))
            continue
        # 기존 settings 우선 — yaml 은 보조
        if section_name not in migrated:
            migrated[section_name] = data
            logger.info("migrate_yaml_to_settings", source=str(src), section=section_name)
        else:
            logger.info("migrate_yaml_skipped_existing_section", source=str(src), section=section_name)
        # rename source → .bak
        bak = src.with_suffix(src.suffix + ".bak")
        src.rename(bak)
    
    home.mkdir(parents=True, exist_ok=True)
    settings_path.write_text(json.dumps(migrated, indent=2, ensure_ascii=False))
    logger.info("settings_json_written", path=str(settings_path), sections=list(migrated.keys()))
    return migrated
```

### Tests added

`backend/tests/service/settings/test_migrator.py`

- `test_migrates_permissions_yaml` (tmp HOME with permissions.yaml)
- `test_migrates_hooks_yaml`
- `test_migrates_all_three`
- `test_keeps_existing_settings_section_when_yaml_overlaps`
- `test_renames_source_to_bak`
- `test_idempotent_second_run_no_op`
- `test_invalid_yaml_skipped_with_log`
- `test_no_yaml_files_returns_empty_settings`
- `test_settings_json_written_atomically` (tmp file 가 잠시라도 settings.json 보다 먼저 존재 X)

### Acceptance criteria
- [ ] migrator 동작
- [ ] 9 test pass
- [ ] 운영 환경 시뮬레이션: 기존 운영자의 ~/.geny/ → migrate → settings.json 정상 생성
- [ ] backup 보존

### Risk / mitigation
| Risk | Mitigation |
|---|---|
| migration 도중 crash → 데이터 유실 | atomic write (tmp → rename) + .bak 보존 |
| yaml 의 unknown section → 누락 | unknown section 도 settings.json 에 그대로 보존 |

---

## PR-B.3.4 — refactor(service): 기존 install.py 들 swap to loader.get_section

### Metadata
- **Branch:** `refactor/install-py-use-settings-loader`
- **Repo:** Geny
- **Layer:** SERVICE
- **Depends on:** PR-B.3.3

### Files modified

#### `backend/service/permission/install.py`

```python
def install_permissions(...):
    loader = get_default_loader()
    section = loader.get_section("permissions")
    if section is None:
        logger.warning("permissions_section_missing — using defaults")
        section = PermissionsSection()
    # 기존 yaml.load(...) 호출 제거
    # ... section 으로 PermissionGuard 구성 ...
```

#### `backend/service/hooks/install.py`

동일 패턴.

#### `backend/service/skills/install.py`

```python
def install_skills(...):
    loader = get_default_loader()
    section = loader.get_section("skills")
    user_enabled = (section.user_skills_enabled if section else False)
    # 기존 GENY_ALLOW_USER_SKILLS env 도 backward-compat 로 OR
    user_enabled = user_enabled or os.getenv("GENY_ALLOW_USER_SKILLS") == "1"
    ...
```

#### `backend/service/notifications/install.py`

이전 PR-A.7.1 의 yaml/env 로 임시 wired 됐던 것 → settings 로 swap:

```python
def install_notification_endpoints(registry):
    loader = get_default_loader()
    section = loader.get_section("notifications")
    if section is None: return 0
    for ep_cfg in section.endpoints:
        registry.register(NotificationEndpoint(**ep_cfg.dict()))
    return len(section.endpoints)
```

#### `backend/main.py`

lifespan 시작 시:

```python
from service.settings.migrator import migrate_to_settings_json
from geny_executor.settings import SettingsLoader, get_default_loader

# 1. migration (idempotent)
migrate_to_settings_json()

# 2. loader paths 설정
loader = get_default_loader()
loader._paths = [
    Path("~/.geny/settings.json").expanduser(),
    Path(".geny/settings.json"),
    Path(".geny/settings.local.json"),
]
loader.reload()

# 3. install_* 호출 (이제 loader 사용)
install_permissions(...)
install_hooks(...)
install_skills(...)
install_notification_endpoints(...)
```

### Tests added

`backend/tests/service/permission/test_install_with_settings.py`
`backend/tests/service/hooks/test_install_with_settings.py`
`backend/tests/service/skills/test_install_with_settings.py`
`backend/tests/service/notifications/test_install_with_settings.py`

각 3-4 test:
- happy path (settings.json 존재)
- fallback (settings.json 없음 — defaults)
- legacy env (GENY_ALLOW_USER_SKILLS) 동작 보존

### Acceptance criteria
- [ ] 4 install.py 모두 loader.get_section 사용
- [ ] 16 test pass
- [ ] 기존 운영 환경 0 회귀 (yaml 사용자가 migration 없이도 fallback 동작)
- [ ] PR-A.7.1 의 yaml/env 임시 wiring 제거 완료

---

## PR-B.3.5 — feat(service): Geny 전용 section (preset / vtuber) register

### Metadata
- **Branch:** `feat/geny-custom-settings-sections`
- **Repo:** Geny
- **Layer:** SERVICE

### Files added

#### `backend/service/settings/sections.py` (~80 lines)

```python
from pydantic import BaseModel, Field
from typing import Optional, List


class PresetSection(BaseModel):
    default: str = "worker_adaptive"   # worker_adaptive | vtuber
    available: List[str] = ["worker_adaptive", "vtuber"]
    auto_switch_on_keywords: dict = {}  # {"vtuber": ["broadcast", "stream"]}


class VTuberSection(BaseModel):
    tick_interval_seconds: int = 30
    persona_name: str = "Geny"
    background_topics: List[str] = []
    enable_idle_chat: bool = True
```

#### `backend/service/settings/install.py`

```python
def install_geny_sections():
    from geny_executor.settings import register_section
    register_section("preset", PresetSection)
    register_section("vtuber", VTuberSection)
```

### Files modified

- `backend/main.py` — lifespan 의 loader.reload() 직전에 `install_geny_sections()` 호출
- `backend/service/agent_session.py` — preset 결정 시 settings.preset.default 참조

### Tests added

`backend/tests/service/settings/test_sections.py`

- `test_preset_section_defaults`
- `test_vtuber_section_defaults`
- `test_register_makes_section_loadable`

### Acceptance criteria
- [ ] 2 section 등록
- [ ] 3 test pass
- [ ] settings.json 의 preset.default 가 agent_session 에 반영

---

## 묶음 합계

| PR | Repo | 의존 |
|---|---|---|
| PR-B.3.1 | executor | — |
| PR-B.3.2 | executor | B.3.1 |
| PR-B.3.3 | Geny | B.3.1 + Geny pyproject 1.2.0 |
| PR-B.3.4 | Geny | B.3.3 |
| PR-B.3.5 | Geny | B.3.4 |

총 5 PR. 다음: [`cycle_B_p1_4_skill_richness.md`](cycle_B_p1_4_skill_richness.md).
