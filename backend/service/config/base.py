"""
Base configuration abstract class.

All configs should inherit from BaseConfig to enable:
- Automatic registration in main.py
- JSON serialization/deserialization
- Frontend configuration UI support
- Validation
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field, fields, asdict
from typing import Any, Callable, Dict, List, Optional, Type, TypeVar, get_type_hints
from enum import Enum
import json
from logging import getLogger

_logger = getLogger(__name__)


class FieldType(str, Enum):
    """Supported field types for config UI"""
    STRING = "string"
    PASSWORD = "password"  # Masked input
    NUMBER = "number"
    BOOLEAN = "boolean"
    SELECT = "select"  # Dropdown with options
    MULTISELECT = "multiselect"  # Multiple selection
    TEXTAREA = "textarea"  # Multi-line text
    URL = "url"
    EMAIL = "email"


@dataclass
class ConfigField:
    """Metadata for a configuration field"""
    name: str
    field_type: FieldType
    label: str
    description: str = ""
    required: bool = False
    default: Any = None
    placeholder: str = ""
    options: List[Dict[str, str]] = field(default_factory=list)  # For SELECT/MULTISELECT: [{"value": "...", "label": "..."}]
    min_value: Optional[float] = None  # For NUMBER
    max_value: Optional[float] = None  # For NUMBER
    pattern: Optional[str] = None  # Regex pattern for validation
    group: str = "general"  # Group name for UI organization
    secure: bool = False  # If True, field is masked with show/hide toggle in UI
    depends_on: Optional[str] = None  # If set, options are filtered by the value of this sibling field (matched via option["group"])
    apply_change: Optional[Callable[[Any, Any], None]] = field(
        default=None, repr=False
    )  # Callback(old_value, new_value) invoked when this field changes


# Registry for all config classes
_config_registry: Dict[str, Type['BaseConfig']] = {}

# Field-name substrings that mark a value as secret even when the field
# metadata didn't flag it (backstop for nested list/dict secrets like
# ssh.servers[].password). Used by _mask_value (audit S1).
_SECRET_NAME_HINTS = (
    "password", "passphrase", "private_key", "secret", "token",
    "api_key", "apikey", "credential", "client_secret",
)


def _looks_secret(name: str) -> bool:
    n = str(name).lower()
    return any(h in n for h in _SECRET_NAME_HINTS)


def _mask_value(name: str, value: Any, is_secure: bool) -> Any:
    """Redact ``value`` when the field is secure or its name looks secret;
    recurse into lists/dicts so nested credentials are masked too."""
    if isinstance(value, dict):
        return {
            k: _mask_value(k, v, is_secure or _looks_secret(k)) for k, v in value.items()
        }
    if isinstance(value, list):
        return [_mask_value(name, v, is_secure) for v in value]
    if is_secure or _looks_secret(name):
        if value in (None, "", 0, False):
            return value
        return BaseConfig.SECRET_MASK
    return value


def register_config(cls: Type['BaseConfig']) -> Type['BaseConfig']:
    """Decorator to register a config class for auto-discovery"""
    _config_registry[cls.get_config_name()] = cls
    return cls


def get_registered_configs() -> Dict[str, Type['BaseConfig']]:
    """Get all registered config classes"""
    return _config_registry.copy()


T = TypeVar('T', bound='BaseConfig')


class BaseConfig(ABC):
    """
    Abstract base class for all configurations.

    To create a new config:
    1. Inherit from BaseConfig
    2. Implement required abstract methods
    3. Define config fields with type hints and defaults
    4. Use @register_config decorator for auto-registration

    Example:
        @register_config
        @dataclass
        class MyConfig(BaseConfig):
            api_key: str = ""
            enabled: bool = True

            @classmethod
            def get_config_name(cls) -> str:
                return "my_config"

            @classmethod
            def get_display_name(cls) -> str:
                return "My Configuration"

            @classmethod
            def get_description(cls) -> str:
                return "Description of my config"

            @classmethod
            def get_fields_metadata(cls) -> List[ConfigField]:
                return [
                    ConfigField(
                        name="api_key",
                        field_type=FieldType.PASSWORD,
                        label="API Key",
                        required=True
                    ),
                    ConfigField(
                        name="enabled",
                        field_type=FieldType.BOOLEAN,
                        label="Enabled",
                        default=True
                    )
                ]
    """

    @classmethod
    @abstractmethod
    def get_config_name(cls) -> str:
        """
        Return the unique identifier for this config.
        This is used as the filename (without .json extension).
        """
        pass

    @classmethod
    @abstractmethod
    def get_display_name(cls) -> str:
        """Return the human-readable name for the config"""
        pass

    @classmethod
    @abstractmethod
    def get_description(cls) -> str:
        """Return a description of what this config is for"""
        pass

    @classmethod
    @abstractmethod
    def get_fields_metadata(cls) -> List[ConfigField]:
        """
        Return metadata for all configurable fields.
        This is used to generate the UI form.
        """
        pass

    @classmethod
    def get_category(cls) -> str:
        """Return the category for grouping in UI (default: 'general')"""
        return "general"

    @classmethod
    def get_icon(cls) -> str:
        """Return an icon identifier for the config (optional)"""
        return "settings"

    @classmethod
    def is_user_visible(cls) -> bool:
        """Whether this config surfaces in the generic SettingsTab list.

        Hidden configs (returning ``False``) are still fully accessible
        through ``GET /api/config/{name}`` and ``PUT /api/config/{name}``
        — only the list endpoint filters them out. Use this to gate
        configs that have a dedicated editor (e.g. ``llm_credentials``
        edited via the LLM Backends panel, ``cli_backend_*`` edited
        through the per-CLI auth modals).
        """
        return True

    @classmethod
    def get_i18n(cls) -> Dict[str, Dict[str, Any]]:
        """
        Return i18n translations keyed by locale code.

        Override in subclasses to provide translations.
        Structure::

            {
                "ko": {
                    "display_name": "...",
                    "description": "...",
                    "groups": {
                        "group_name": "Group Name",
                    },
                    "fields": {
                        "field_name": {
                            "label": "...",
                            "description": "...",
                            "placeholder": "...",
                        },
                    },
                }
            }
        """
        return {}

    def to_dict(self) -> Dict[str, Any]:
        """Serialize config to dictionary"""
        if hasattr(self, '__dataclass_fields__'):
            return asdict(self)
        # Fallback for non-dataclass configs
        result = {}
        for field_meta in self.get_fields_metadata():
            result[field_meta.name] = getattr(self, field_meta.name, field_meta.default)
        return result

    #: Placeholder returned in place of a set secret by :meth:`to_dict_masked`.
    SECRET_MASK = "__SECRET_SET__"

    def to_dict_masked(self) -> Dict[str, Any]:
        """Serialize with ``secure=True`` fields redacted (audit S1).

        A set secret becomes :data:`SECRET_MASK` (so the client knows it is
        configured) and an empty one stays empty — the cleartext value is
        never sent. Used by the bulk/unauthenticated-surface serializers so
        API keys, SSH passwords and bot tokens don't ride a config listing.
        Nested secrets inside list/dict fields (e.g. ``ssh.servers[].password``)
        are masked by field-name heuristic as a backstop.
        """
        values = self.to_dict()
        secure_names = {
            f.name for f in self.get_fields_metadata() if getattr(f, "secure", False)
        }
        return {k: _mask_value(k, v, k in secure_names) for k, v in values.items()}

    def to_json(self) -> str:
        """Serialize config to JSON string"""
        return json.dumps(self.to_dict(), indent=2, ensure_ascii=False)

    @classmethod
    def from_dict(cls: Type[T], data: Dict[str, Any]) -> T:
        """Create config instance from dictionary"""
        # Filter out unknown fields
        valid_fields = {f.name for f in cls.get_fields_metadata()}
        filtered_data = {k: v for k, v in data.items() if k in valid_fields}
        return cls(**filtered_data)

    @classmethod
    def from_json(cls: Type[T], json_str: str) -> T:
        """Create config instance from JSON string"""
        data = json.loads(json_str)
        return cls.from_dict(data)

    @classmethod
    def get_default_instance(cls: Type[T]) -> T:
        """Create a config instance with all default values"""
        # For dataclass configs, just call the constructor with no args
        # This uses the dataclass field defaults
        if hasattr(cls, '__dataclass_fields__'):
            return cls()

        # Fallback for non-dataclass configs
        defaults = {}
        for field_meta in cls.get_fields_metadata():
            if field_meta.default is not None:
                defaults[field_meta.name] = field_meta.default
        return cls(**defaults)

    def validate(self) -> List[str]:
        """
        Validate the configuration.
        Returns a list of error messages. Empty list means valid.
        """
        errors = []
        for field_meta in self.get_fields_metadata():
            value = getattr(self, field_meta.name, None)

            # Check required fields
            if field_meta.required:
                if value is None or (isinstance(value, str) and value.strip() == ""):
                    errors.append(f"{field_meta.label} is required")
                    continue

            # Skip validation for empty optional fields
            if value is None or (isinstance(value, str) and value.strip() == ""):
                continue

            # Type-specific validation
            if field_meta.field_type == FieldType.NUMBER:
                try:
                    num_value = float(value)
                    if field_meta.min_value is not None and num_value < field_meta.min_value:
                        errors.append(f"{field_meta.label} must be at least {field_meta.min_value}")
                    if field_meta.max_value is not None and num_value > field_meta.max_value:
                        errors.append(f"{field_meta.label} must be at most {field_meta.max_value}")
                except (TypeError, ValueError):
                    errors.append(f"{field_meta.label} must be a number")

            elif field_meta.field_type in (FieldType.SELECT, FieldType.MULTISELECT):
                valid_values = {opt.get('value') for opt in field_meta.options}
                if field_meta.field_type == FieldType.SELECT:
                    if value not in valid_values:
                        errors.append(f"{field_meta.label} has an invalid value")
                else:  # MULTISELECT
                    if isinstance(value, list):
                        invalid = [v for v in value if v not in valid_values]
                        if invalid:
                            errors.append(f"{field_meta.label} contains invalid values: {invalid}")

            elif field_meta.field_type == FieldType.URL:
                if not value.startswith(('http://', 'https://')):
                    errors.append(f"{field_meta.label} must be a valid URL")

            elif field_meta.field_type == FieldType.EMAIL:
                if '@' not in value:
                    errors.append(f"{field_meta.label} must be a valid email")

            # Pattern validation
            if field_meta.pattern:
                import re
                if not re.match(field_meta.pattern, str(value)):
                    errors.append(f"{field_meta.label} format is invalid")

        return errors

    def is_valid(self) -> bool:
        """Check if config is valid"""
        return len(self.validate()) == 0

    def apply_field_changes(self, old_values: Dict[str, Any]) -> None:
        """
        Compare current values against *old_values* and invoke
        ``apply_change`` callbacks for every field that actually changed.

        Called automatically by ConfigManager.update_config().
        """
        meta_lookup = {f.name: f for f in self.get_fields_metadata()}
        new_values = self.to_dict()

        for name, new_val in new_values.items():
            old_val = old_values.get(name)
            if old_val == new_val:
                continue
            meta = meta_lookup.get(name)
            if meta and meta.apply_change is not None:
                try:
                    meta.apply_change(old_val, new_val)
                except Exception as exc:
                    _logger.error(
                        f"apply_change failed for {self.get_config_name()}.{name}: {exc}"
                    )

    @classmethod
    def get_setup_guide(cls) -> Dict[str, str]:
        """Optional per-locale Markdown setup guide.

        Return ``{}`` for no guide, or ``{"ko": "...", "en": "..."}`` with
        Markdown bodies. The frontend renders it in a "설정 방법" modal so a
        channel's external-bot setup (Discord intents, OAuth2 invite, Slack
        Socket Mode, …) lives next to the fields instead of in docs.
        """
        return {}

    @classmethod
    def get_schema(cls) -> Dict[str, Any]:
        """
        Get the full schema for this config.
        Used by frontend to render the configuration UI.
        """
        schema: Dict[str, Any] = {
            "name": cls.get_config_name(),
            "display_name": cls.get_display_name(),
            "description": cls.get_description(),
            "category": cls.get_category(),
            "icon": cls.get_icon(),
            "fields": [
                {
                    "name": f.name,
                    "type": f.field_type.value,
                    "label": f.label,
                    "description": f.description,
                    "required": f.required,
                    "default": f.default,
                    "placeholder": f.placeholder,
                    "options": f.options,
                    "min": f.min_value,
                    "max": f.max_value,
                    "pattern": f.pattern,
                    "group": f.group,
                    "secure": f.secure,
                    "depends_on": f.depends_on,
                }
                for f in cls.get_fields_metadata()
            ],
        }
        i18n = cls.get_i18n()
        if i18n:
            schema["i18n"] = i18n
        guide = cls.get_setup_guide()
        if guide:
            schema["setup_guide"] = guide
        return schema
