"""Email (SMTP) configuration — powers the native ``email_send`` tool.

Standard SMTP creds; when set, the ``email_send`` tool becomes available
(progressive disclosure via ``config:email``). User-visible in the Tool category.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List

from service.config.base import BaseConfig, ConfigField, FieldType, register_config


@register_config
@dataclass
class EmailConfig(BaseConfig):
    """SMTP credentials for sending email."""

    smtp_host: str = ""
    smtp_port: int = 587
    smtp_user: str = ""
    smtp_password: str = ""
    from_addr: str = ""
    use_tls: bool = True

    @classmethod
    def get_config_name(cls) -> str:
        return "email"

    @classmethod
    def get_display_name(cls) -> str:
        return "Email (SMTP)"

    @classmethod
    def get_description(cls) -> str:
        return "SMTP credentials for the email_send tool (Gmail: smtp.gmail.com:587 + app password)."

    @classmethod
    def get_category(cls) -> str:
        return "tools"

    @classmethod
    def get_icon(cls) -> str:
        return "mail"

    @classmethod
    def get_fields_metadata(cls) -> List[ConfigField]:
        return [
            ConfigField(name="smtp_host", field_type=FieldType.STRING, label="SMTP Host",
                        placeholder="smtp.gmail.com", required=True, group="smtp"),
            ConfigField(name="smtp_port", field_type=FieldType.NUMBER, label="SMTP Port",
                        default=587, min_value=1, max_value=65535, group="smtp"),
            ConfigField(name="smtp_user", field_type=FieldType.STRING, label="SMTP Username",
                        placeholder="you@gmail.com", required=True, group="smtp"),
            ConfigField(name="smtp_password", field_type=FieldType.PASSWORD, label="SMTP Password",
                        description="App password for Gmail/most providers", required=True,
                        secure=True, group="smtp"),
            ConfigField(name="from_addr", field_type=FieldType.STRING, label="From Address",
                        description="Defaults to the username", placeholder="you@gmail.com",
                        required=False, group="smtp"),
            ConfigField(name="use_tls", field_type=FieldType.BOOLEAN, label="Use STARTTLS",
                        default=True, group="smtp"),
        ]
