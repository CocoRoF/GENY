"""Notification + send-message channel wiring (PR-A.7.1 + PR-A.7.2)."""

from service.notifications.install import (
    install_notification_endpoints,
    install_send_message_channels,
)

__all__ = ["install_notification_endpoints", "install_send_message_channels"]
