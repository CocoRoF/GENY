"""document_tools — edit2docs-backed doc_analyze / doc_edit + contracts.

First dedicated coverage for the document tools (the pre-migration
python-docx/openpyxl editors shipped with zero tests). Deterministic
engine paths only — no LLM key, and since the 2026-07 native-render
migration no LibreOffice either: previews/PDF/PNG come from edit2docs
render_doc and are asserted to actually exist.
"""

from __future__ import annotations

import json

import pytest

edit2docs = pytest.importorskip("edit2docs")

from tools.built_in import document_tools as dt  # noqa: E402
from tools.built_in.document_tools import (  # noqa: E402
    DocAnalyzeTool,
    DocConvertTool,
    DocEditTool,
    DocGenerateTool,
    ToolError,
)

SESSION = "doc-tools-test-session"


@pytest.fixture
def storage(tmp_path, monkeypatch):
    """Session storage root with an uploaded docx + xlsx."""
    monkeypatch.setattr(dt, "_storage_root", lambda session_id: tmp_path)
    uploads = tmp_path / "workspace" / "uploads"
    uploads.mkdir(parents=True)

    from edit2docs.documents.docx_engine import docx_from_markdown
    from edit2docs.documents.xlsx_engine import xlsx_from_spec

    (uploads / "report.docx").write_bytes(
        docx_from_markdown("# Title\n\nHello paragraph.\n\nSecond paragraph.")
    )
    (uploads / "sales.xlsx").write_bytes(
        xlsx_from_spec(
            {"sheets": [{"name": "Data", "headers": ["a", "b"], "rows": [[1, 2]]}]}
        )
    )
    return tmp_path


class TestDocAnalyze:
    def test_outline_docx(self, storage):
        out = json.loads(
            DocAnalyzeTool().run(session_id=SESSION, path="workspace/uploads/report.docx")
        )
        assert out["format"] == "docx"
        assert any("para" in item for item in out["outline"])

    def test_rejects_unsupported_format(self, storage):
        (storage / "workspace" / "uploads" / "x.txt").write_text("hi")
        with pytest.raises(ToolError, match="doc_analyze handles"):
            DocAnalyzeTool().run(session_id=SESSION, path="workspace/uploads/x.txt")

    def test_path_escape_blocked(self, storage):
        with pytest.raises(ToolError, match="escapes the session storage"):
            DocAnalyzeTool().run(session_id=SESSION, path="../../etc/passwd")


class TestDocEdit:
    def test_edit_creates_draft_and_preserves_original(self, storage):
        src = storage / "workspace" / "uploads" / "sales.xlsx"
        original = src.read_bytes()
        out = json.loads(
            DocEditTool().run(
                session_id=SESSION,
                path="workspace/uploads/sales.xlsx",
                edits=[{"action": "set_cell", "sheet": "Data", "cell": "B2", "value": 77}],
            )
        )
        assert out["ok"] is True
        assert out["applied"] == 1
        # Native render (no LibreOffice): the preview pager files exist.
        assert out.get("preview_pages") == ["workspace/drafts/sales/preview/page-1.png"]
        assert (storage / out["preview_pages"][0]).is_file()
        # Drafts convention: edit landed on the copy, original untouched.
        assert out["draft"] == "workspace/drafts/sales/sales.xlsx"
        assert (storage / out["draft"]).is_file()
        assert src.read_bytes() == original

        # doc_analyze now reads the draft (addresses match future edits).
        check = json.loads(
            DocAnalyzeTool().run(session_id=SESSION, path="workspace/uploads/sales.xlsx")
        )
        assert check["path"] == out["draft"]
        assert "77" in json.dumps(check)

    def test_soft_fail_statuses_surface(self, storage):
        out = json.loads(
            DocEditTool().run(
                session_id=SESSION,
                path="workspace/uploads/sales.xlsx",
                edits=[{"action": "set_cell", "sheet": "Nope", "cell": "A1", "value": 1}],
            )
        )
        assert out["ok"] is False
        assert out["failed"] == 1
        assert out["results"][0]["status"] != "applied"

    def test_docx_para_replace(self, storage):
        analyze = json.loads(
            DocAnalyzeTool().run(session_id=SESSION, path="workspace/uploads/report.docx")
        )
        target = next(
            item for item in analyze["outline"] if "Hello paragraph" in item.get("text", "")
        )
        out = json.loads(
            DocEditTool().run(
                session_id=SESSION,
                path="workspace/uploads/report.docx",
                edits=[{"action": "replace", "para": target["para"], "new_text": "Edited!"}],
            )
        )
        assert out["applied"] == 1
        check = DocAnalyzeTool().run(session_id=SESSION, path="workspace/uploads/report.docx")
        assert "Edited!" in check

    def test_empty_edits_rejected(self, storage):
        with pytest.raises(ToolError, match="non-empty"):
            DocEditTool().run(
                session_id=SESSION, path="workspace/uploads/report.docx", edits=[]
            )


class TestDocGenerate:
    def test_requires_api_key(self, storage, monkeypatch):
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        # The message points the user at the settings section now instead of
        # naming the env var — matching on the var name asserted an
        # implementation detail that the user-facing text stopped carrying.
        with pytest.raises(ToolError, match="Anthropic API key"):
            DocGenerateTool().run(
                session_id=SESSION, intent="a report", output="new.docx"
            )

    def test_rejects_bad_extension(self, storage, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
        with pytest.raises(ToolError, match="output must end in"):
            DocGenerateTool().run(
                session_id=SESSION, intent="a report", output="new.pdf"
            )


class TestDocConvert:
    def test_text_extraction_via_edit2docs(self, storage):
        out = json.loads(
            DocConvertTool().run(
                session_id=SESSION, path="workspace/uploads/report.docx", to="text"
            )
        )
        assert out["ok"] is True
        md = (storage / out["text_file"]).read_text(encoding="utf-8")
        assert "Hello paragraph" in md

    def test_unknown_target_rejected(self, storage):
        with pytest.raises(ToolError, match="Unsupported target"):
            DocConvertTool().run(
                session_id=SESSION, path="workspace/uploads/report.docx", to="html"
            )


class TestRoster:
    def test_tools_list_exports_four(self):
        names = {t.name for t in dt.TOOLS}
        assert names == {"doc_convert", "doc_analyze", "doc_edit", "doc_generate"}

    def test_capabilities_declared(self):
        for t in dt.TOOLS:
            assert t.CAPABILITIES is not None
