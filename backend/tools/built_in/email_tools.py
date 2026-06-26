"""Native email tool — send mail via SMTP (EmailConfig).

Gated on ``config:email`` (progressive disclosure): hidden until SMTP creds are set.
No external deps — stdlib ``smtplib``/``email``.
"""

from __future__ import annotations

import smtplib
from email.message import EmailMessage
from email.utils import parseaddr
from logging import getLogger

from tools.base import BaseTool, ToolError

logger = getLogger(__name__)


class EmailSendTool(BaseTool):
    """Send an email via the configured SMTP account."""

    name = "email_send"
    description = (
        "Send an email from the configured SMTP account. Provide recipient(s), a "
        "subject, and a plain-text body."
    )
    REQUIRED_CONFIG = ("config:email",)

    def run(self, to: str, subject: str, body: str, cc: str = "") -> str:
        """Send an email.

        Args:
            to: Recipient address(es), comma-separated.
            subject: Subject line.
            body: Plain-text body.
            cc: Optional CC address(es), comma-separated.
        """
        from service.config import get_config_manager
        from service.config.sub_config.general.email_config import EmailConfig

        cfg = get_config_manager().load_config(EmailConfig)
        if not (cfg.smtp_host and cfg.smtp_user and cfg.smtp_password):
            raise ToolError("Email is not configured (Settings → Email).")

        sender = (cfg.from_addr or cfg.smtp_user).strip()
        recipients = [a.strip() for a in to.split(",") if a.strip()]
        cc_list = [a.strip() for a in (cc or "").split(",") if a.strip()]
        if not recipients:
            raise ToolError("No recipient address provided.")
        for a in recipients + cc_list + [sender]:
            if "@" not in parseaddr(a)[1]:
                raise ToolError(f"Invalid email address: {a}")

        msg = EmailMessage()
        msg["From"] = sender
        msg["To"] = ", ".join(recipients)
        if cc_list:
            msg["Cc"] = ", ".join(cc_list)
        msg["Subject"] = subject
        msg.set_content(body)

        try:
            port = int(cfg.smtp_port or 587)
            if port == 465:
                with smtplib.SMTP_SSL(cfg.smtp_host, port, timeout=30) as s:
                    s.login(cfg.smtp_user, cfg.smtp_password)
                    s.send_message(msg, to_addrs=recipients + cc_list)
            else:
                with smtplib.SMTP(cfg.smtp_host, port, timeout=30) as s:
                    if getattr(cfg, "use_tls", True):
                        s.starttls()
                    s.login(cfg.smtp_user, cfg.smtp_password)
                    s.send_message(msg, to_addrs=recipients + cc_list)
        except Exception as e:  # noqa: BLE001
            raise ToolError(f"Failed to send email: {e}")
        return f"Email sent to {', '.join(recipients)}" + (f" (cc: {', '.join(cc_list)})" if cc_list else "")


TOOLS = [EmailSendTool()]
