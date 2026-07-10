"""SSH Configuration (category: ``tools``).

Records the servers this user's agents may SSH into. Each entry carries the
connection + credential:

    {name, host, port, user, password?, private_key?, passphrase?,
     description?, strict_host_key?}

The list is edited in Settings → Tool → SSH (a dedicated list editor — the
generic auto-form has no list-of-dicts renderer). At session build,
``agent_session`` hands the list to geny-executor via
``ToolContext.extras["ssh"]["servers"]``; the executor's SSH tools resolve a
server by NAME and connect, so the agent never handles a credential. When at
least one valid server is present AND ``enabled`` is on, Geny satisfies
``feature:ssh_enabled`` (``tool_config_gate``), unlocking the SshRun / SshList /
SshUpload / SshDownload tools.

Secrets live only in the config store + the per-session executor file; they are
never surfaced to the model.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List

from service.config.base import BaseConfig, ConfigField, FieldType, register_config


#: Field names on a server entry that hold secrets (never logged / echoed).
SSH_SECRET_KEYS = ("password", "private_key", "passphrase")


def _server_issues(idx: int, s: Dict[str, Any]) -> List[str]:
    """Validation issues for one server entry (label uses name or index)."""
    label = str(s.get("name") or "").strip() or f"#{idx + 1}"
    issues: List[str] = []
    if not str(s.get("name") or "").strip():
        issues.append(f"Server {label}: name is required")
    if not str(s.get("host") or "").strip():
        issues.append(f"Server '{label}': host is required")
    if not str(s.get("user") or s.get("username") or "").strip():
        issues.append(f"Server '{label}': user is required")
    if not (s.get("password") or s.get("private_key")):
        issues.append(f"Server '{label}': needs a password or a private key")
    port = s.get("port", 22)
    try:
        p = int(port)
        if not (1 <= p <= 65535):
            raise ValueError
    except (TypeError, ValueError):
        issues.append(f"Server '{label}': port must be 1–65535")
    return issues


@register_config
@dataclass
class SSHConfig(BaseConfig):
    """SSH servers agents can operate (by name)."""

    #: List of server records. Edited via the bespoke SSH editor; stored as a
    #: JSON list. Secrets are kept here and mirrored to the per-session
    #: executor file, never shown to the model.
    servers: List[Dict[str, Any]] = field(default_factory=list)
    #: Master switch — off hides the SSH tools even when servers exist.
    enabled: bool = True

    @classmethod
    def get_default_instance(cls) -> "SSHConfig":
        return cls(servers=[], enabled=True)

    @classmethod
    def get_config_name(cls) -> str:
        return "ssh"

    @classmethod
    def get_display_name(cls) -> str:
        return "SSH"

    @classmethod
    def get_description(cls) -> str:
        return (
            "Servers your agents can SSH into. Add each server's host, account, "
            "and password or private key — agents run commands / transfer files "
            "by server name, without ever handling the credential."
        )

    @classmethod
    def get_category(cls) -> str:
        return "tools"

    @classmethod
    def get_icon(cls) -> str:
        return "server"

    @classmethod
    def get_i18n(cls) -> Dict[str, Dict[str, Any]]:
        return {
            "ko": {
                "display_name": "SSH",
                "description": (
                    "에이전트가 접속할 수 있는 서버들. 서버별 호스트·계정·비밀번호(또는 "
                    "개인키)를 등록하면, 에이전트는 비밀번호를 직접 다루지 않고 서버 이름만으로 "
                    "명령 실행·파일 전송을 수행합니다."
                ),
                "groups": {"servers": "서버"},
                "fields": {
                    "servers": {
                        "label": "서버 목록",
                        "description": "SSH 접속 정보를 하나씩 추가하세요.",
                    },
                    "enabled": {
                        "label": "활성화",
                        "description": "끄면 서버가 있어도 SSH 도구가 숨겨집니다.",
                    },
                },
            }
        }

    @classmethod
    def get_fields_metadata(cls) -> List[ConfigField]:
        # ``servers`` is rendered by the bespoke SSH editor on the frontend
        # (the generic form has no list-of-dicts widget); the TEXTAREA type is
        # only a harmless fallback. ``enabled`` is a normal boolean.
        return [
            ConfigField(
                name="servers",
                field_type=FieldType.TEXTAREA,
                label="Servers",
                description="SSH server connection records (managed via the SSH editor).",
                group="servers",
                required=False,
            ),
            ConfigField(
                name="enabled",
                field_type=FieldType.BOOLEAN,
                label="Enabled",
                description="Master switch for the SSH tools.",
                default=True,
                group="servers",
            ),
        ]

    # ── validation ──────────────────────────────────────────────────
    def validate(self) -> List[str]:
        """Per-entry validation + duplicate-name detection. Empty list = valid.
        Surfaced as the card's issue count and the editor's inline errors."""
        errors: List[str] = []
        seen: Dict[str, int] = {}
        for i, s in enumerate(self.servers or []):
            if not isinstance(s, dict):
                errors.append(f"Server #{i + 1}: malformed entry")
                continue
            errors.extend(_server_issues(i, s))
            name = str(s.get("name") or "").strip()
            if name:
                if name in seen:
                    errors.append(f"Server '{name}': duplicate name")
                seen[name] = i
        return errors

    def has_valid_servers(self) -> bool:
        """True when SSH is enabled and at least one fully-valid server exists —
        the condition Geny uses to satisfy ``feature:ssh_enabled``."""
        if not self.enabled:
            return False
        for i, s in enumerate(self.servers or []):
            if isinstance(s, dict) and not _server_issues(i, s):
                return True
        return False
