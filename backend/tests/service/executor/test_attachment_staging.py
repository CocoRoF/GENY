"""Upload → agent loop plumbing (2026-07 chat-edit hardening).

Covers the three previously-untested links of the "upload a document,
edit it in chat, watch the canvas" loop:

1. ``_rewrite_local_attachment_url`` — /static/uploads/… → file:// URI
2. ``AgentSession._stage_attachments_to_workspace`` — file:// →
   ``<storage>/workspace/uploads/<name>`` copies (what the doc tools
   and the CanvasTab uploads section actually see)
3. upload MIME policy — pptx allowed, documents get the larger cap
"""

from __future__ import annotations

import types
from pathlib import Path

import pytest


# ── 1. URL → file:// rewrite ───────────────────────────────


class TestRewriteLocalAttachmentUrl:
    @pytest.fixture
    def upload_root(self, tmp_path, monkeypatch):
        import controller.chat_controller as cc

        root = tmp_path / "static" / "uploads"
        (root / "ab").mkdir(parents=True)
        (root / "ab" / "abc123.docx").write_bytes(b"PK\x03\x04fake")
        monkeypatch.setattr(cc, "_UPLOAD_ROOT", root)
        return root

    def test_rewrites_to_file_uri(self, upload_root):
        from controller.chat_controller import _rewrite_local_attachment_url

        att = _rewrite_local_attachment_url(
            {"name": "r.docx", "url": "/static/uploads/ab/abc123.docx"}
        )
        assert att["url"].startswith("file://")
        assert att["url"].endswith("abc123.docx")

    def test_missing_file_rejected(self, upload_root):
        from fastapi import HTTPException

        from controller.chat_controller import _rewrite_local_attachment_url

        with pytest.raises(HTTPException):
            _rewrite_local_attachment_url(
                {"name": "x", "url": "/static/uploads/zz/nope.docx"}
            )

    def test_traversal_rejected(self, upload_root):
        from fastapi import HTTPException

        from controller.chat_controller import _rewrite_local_attachment_url

        with pytest.raises(HTTPException):
            _rewrite_local_attachment_url(
                {"name": "x", "url": "/static/uploads/../../etc/passwd"}
            )

    def test_remote_url_passes_through(self, upload_root):
        from controller.chat_controller import _rewrite_local_attachment_url

        att = _rewrite_local_attachment_url(
            {"name": "x", "url": "https://example.com/a.png"}
        )
        assert att["url"] == "https://example.com/a.png"


# ── 2. staging into the session workspace ──────────────────


def _stage(storage: Path, attachments: list) -> list:
    """Run the unbound staging method on a minimal stand-in session."""
    from service.executor.agent_session import AgentSession

    dummy = types.SimpleNamespace(storage_path=str(storage), _session_id="test-sid")
    return AgentSession._stage_attachments_to_workspace(dummy, attachments)


class TestStageAttachmentsToWorkspace:
    def test_file_uri_lands_in_workspace_uploads(self, tmp_path):
        src = tmp_path / "deck.pptx"
        src.write_bytes(b"PK\x03\x04pptx-bytes")
        storage = tmp_path / "storage"
        staged = _stage(
            storage,
            [{"kind": "file", "name": "deck.pptx",
              "mime_type": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
              "url": src.as_uri(), "size": src.stat().st_size}],
        )
        assert len(staged) == 1
        entry = staged[0]
        assert entry["rel_path"] == "workspace/uploads/deck.pptx"
        target = storage / "workspace" / "uploads" / "deck.pptx"
        assert target.read_bytes() == b"PK\x03\x04pptx-bytes"
        assert Path(entry["abs_path"]) == target

    def test_non_file_urls_are_skipped(self, tmp_path):
        storage = tmp_path / "storage"
        staged = _stage(
            storage,
            [{"kind": "file", "name": "a.docx", "mime_type": "x",
              "url": "https://example.com/a.docx", "size": 1}],
        )
        assert staged == []
        assert not (storage / "workspace" / "uploads").exists() or not any(
            (storage / "workspace" / "uploads").iterdir()
        )

    def test_screen_observation_frames_skipped(self, tmp_path):
        src = tmp_path / "frame.png"
        src.write_bytes(b"\x89PNGxxx")
        staged = _stage(
            tmp_path / "storage",
            [{"kind": "image", "source": "screen_observation", "name": "frame.png",
              "mime_type": "image/png", "url": src.as_uri(), "size": 7}],
        )
        assert staged == []


# ── 3. upload MIME policy ──────────────────────────────────


class TestUploadPolicy:
    def test_pptx_mime_allowed(self):
        from controller.upload_controller import ALLOWED_FILE_MIMES

        assert (
            "application/vnd.openxmlformats-officedocument.presentationml.presentation"
            in ALLOWED_FILE_MIMES
        )

    def test_documents_get_larger_cap(self):
        from controller.upload_controller import (
            DOCUMENT_MIMES,
            MAX_DOCUMENT_BYTES,
            MAX_UPLOAD_BYTES,
        )

        assert MAX_DOCUMENT_BYTES > MAX_UPLOAD_BYTES
        assert (
            "application/vnd.openxmlformats-officedocument.presentationml.presentation"
            in DOCUMENT_MIMES
        )


# ── 4. staged note points office files at the doc tools ────


class TestDocToolFileChanges:
    def test_session_logger_extracts_doc_edit(self):
        from service.logging.session_logger import SessionLogger

        logger = SessionLogger.__new__(SessionLogger)
        fc = SessionLogger._extract_file_changes(
            logger,
            "doc_edit",
            {"path": "workspace/uploads/r.docx",
             "edits": [{"action": "replace", "para": 1, "new_text": "x"}]},
        )
        assert fc is not None
        assert fc["file_path"] == "workspace/uploads/r.docx"
        assert fc["operation"] == "edit"
        assert fc["lines_added"] == 1

    def test_session_logger_extracts_doc_generate(self):
        from service.logging.session_logger import SessionLogger

        logger = SessionLogger.__new__(SessionLogger)
        fc = SessionLogger._extract_file_changes(
            logger, "doc_generate", {"output": "report.docx", "intent": "Q3 보고서"}
        )
        assert fc is not None
        assert fc["operation"] == "create"
