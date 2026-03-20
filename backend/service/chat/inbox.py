"""
Inter-agent Inbox — Lightweight per-session direct message store.

Provides a simple inbox system for agents to send direct messages to
each other outside of chat rooms.  Messages are stored in JSON files
on disk, one file per target session.

Storage layout::

    backend/service/chat_conversations/
        inbox/
            {session_id}.json   — Inbox for one session (list of messages)

Public API::

    inbox = get_inbox_manager()
    msg   = inbox.deliver(target_session_id, content, sender_session_id, sender_name)
    msgs  = inbox.read(session_id, limit=20, unread_only=False)
    inbox.mark_read(session_id, message_ids)
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from logging import getLogger
from pathlib import Path
from threading import Lock
from typing import Any, Dict, List, Optional

logger = getLogger(__name__)

# Store inbox files alongside chat_conversations
_INBOX_DIR = Path(__file__).parent.parent / "chat_conversations" / "inbox"


class InboxManager:
    """Thread-safe per-session inbox for direct messages between agents."""

    def __init__(self, inbox_dir: Optional[Path] = None) -> None:
        self._dir = inbox_dir or _INBOX_DIR
        self._dir.mkdir(parents=True, exist_ok=True)
        self._lock = Lock()

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _inbox_path(self, session_id: str) -> Path:
        """Return the JSON file path for a session's inbox."""
        # Sanitise session_id to prevent path traversal
        safe_id = "".join(c for c in session_id if c.isalnum() or c in "-_")
        return self._dir / f"{safe_id}.json"

    def _load_inbox(self, session_id: str) -> List[Dict[str, Any]]:
        """Load messages for a session (returns empty list if none)."""
        path = self._inbox_path(session_id)
        if not path.exists():
            return []
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            return data if isinstance(data, list) else []
        except (json.JSONDecodeError, OSError) as exc:
            logger.warning("Failed to load inbox for %s: %s", session_id, exc)
            return []

    def _save_inbox(self, session_id: str, messages: List[Dict[str, Any]]) -> None:
        """Persist messages for a session."""
        path = self._inbox_path(session_id)
        path.write_text(
            json.dumps(messages, indent=2, ensure_ascii=False, default=str),
            encoding="utf-8",
        )

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def deliver(
        self,
        target_session_id: str,
        content: str,
        sender_session_id: str = "",
        sender_name: str = "",
    ) -> Dict[str, Any]:
        """Deliver a direct message to a session's inbox.

        Returns the created message dict.
        """
        msg: Dict[str, Any] = {
            "id": str(uuid.uuid4()),
            "sender_session_id": sender_session_id or None,
            "sender_name": sender_name or None,
            "content": content,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "read": False,
        }

        with self._lock:
            messages = self._load_inbox(target_session_id)
            messages.append(msg)
            self._save_inbox(target_session_id, messages)

        logger.info(
            "Inbox: delivered message %s → %s (from %s)",
            msg["id"], target_session_id, sender_session_id or "unknown",
        )
        return msg

    def read(
        self,
        session_id: str,
        limit: int = 20,
        unread_only: bool = False,
    ) -> List[Dict[str, Any]]:
        """Read messages from a session's inbox.

        Args:
            session_id: The session whose inbox to read.
            limit: Maximum number of messages to return (most recent first).
            unread_only: If True, return only unread messages.

        Returns:
            List of message dicts (newest last).
        """
        with self._lock:
            messages = self._load_inbox(session_id)

        if unread_only:
            messages = [m for m in messages if not m.get("read", False)]

        # Return the *last* `limit` messages (most recent)
        return messages[-limit:] if len(messages) > limit else messages

    def mark_read(self, session_id: str, message_ids: List[str]) -> int:
        """Mark specific messages as read.

        Args:
            session_id: The session whose inbox to update.
            message_ids: List of message IDs to mark as read.

        Returns:
            Number of messages actually marked.
        """
        ids_set = set(message_ids)
        marked = 0

        with self._lock:
            messages = self._load_inbox(session_id)
            for m in messages:
                if m["id"] in ids_set and not m.get("read", False):
                    m["read"] = True
                    marked += 1
            if marked:
                self._save_inbox(session_id, messages)

        return marked

    def clear(self, session_id: str) -> None:
        """Clear all messages for a session."""
        with self._lock:
            path = self._inbox_path(session_id)
            if path.exists():
                path.unlink()

    def unread_count(self, session_id: str) -> int:
        """Return the number of unread messages for a session."""
        messages = self._load_inbox(session_id)
        return sum(1 for m in messages if not m.get("read", False))


# ── Singleton ──

_inbox_instance: Optional[InboxManager] = None


def get_inbox_manager() -> InboxManager:
    """Get or create the singleton InboxManager."""
    global _inbox_instance
    if _inbox_instance is None:
        _inbox_instance = InboxManager()
    return _inbox_instance
