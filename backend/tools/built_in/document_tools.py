"""Document tools — edit2docs-powered analyze / edit / generate + convert.

workspace-canvas P3, re-engined in the 2026-07 migration: the old
python-docx/openpyxl/python-pptx ad-hoc editors (``docx_edit`` /
``xlsx_edit`` / ``pptx_edit``) were replaced by the `edit2docs
<https://pypi.org/project/edit2docs/>`_ engine — one address system
shared by outline (``doc_analyze``) and edits (``doc_edit``), per-edit
soft-fail statuses the agent can self-correct from, and full-document
generation (``doc_generate``). PDF/PNG/preview now run on
edit2docs' native pipeline (render_doc: per-page SVG → resvg → PyMuPDF,
page-N.png naming preserved for the CanvasTab pager); LibreOffice +
pdftoppm are only a fallback for legacy formats (odt/doc/ppt) and
machines where the native render fails.

The session-storage contract is unchanged: paths are relative to the
session storage root (e.g. ``workspace/uploads/deck.pptx``), editing a
non-draft file first copies it to ``workspace/drafts/<stem>/<name>``
(originals under ``workspace/uploads/`` are never mutated), previews
regenerate best-effort after each edit, and results reach the user via
SendUserFile.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
import threading
from logging import getLogger
from pathlib import Path
from typing import Any, Dict, List, Optional

from geny_executor.tools.base import ToolCapabilities

from tools.base import BaseTool, ToolError

logger = getLogger(__name__)

# LibreOffice headless is not concurrency-safe (shared profile) — serialize.
_SOFFICE_LOCK = threading.Lock()
_SOFFICE_TIMEOUT = 120
_PREVIEW_DPI = "96"
_MAX_PREVIEW_PAGES = 30

# Formats the edit2docs engine can outline/edit.
_EDITABLE_EXTS = (".docx", ".xlsx", ".pptx")
# Formats that get a PNG preview after edits — all three, now that the
# native grid renderer covers xlsx (LibreOffice previews used to skip it).
_PREVIEW_EXTS = (".docx", ".pptx", ".xlsx")


# ── session storage helpers ─────────────────────────────────────────


def _storage_root(session_id: str) -> Path:
    from service.executor import get_agent_session_manager

    manager = get_agent_session_manager()
    agent = manager.get_agent(session_id)
    storage = getattr(agent, "storage_path", None) if agent else None
    if not storage:
        try:
            from service.sessions.store import get_session_store

            rec = get_session_store().get(session_id)
            storage = (rec or {}).get("storage_path")
        except Exception:  # noqa: BLE001
            storage = None
    if not storage:
        raise ToolError("Session storage is not available for this session.")
    return Path(storage).resolve()


def _resolve(root: Path, path: str) -> Path:
    p = Path(path)
    target = (p if p.is_absolute() else root / p).resolve()
    try:
        target.relative_to(root)
    except ValueError:
        raise ToolError(f"Path escapes the session storage: {path}")
    return target


def _rel(root: Path, p: Path) -> str:
    return p.resolve().relative_to(root).as_posix()


def _ensure_draft(root: Path, src: Path) -> Path:
    """Return the working copy for ``src`` (drafts convention).

    Files already under ``workspace/drafts/`` are edited in place; anything
    else is copied to ``workspace/drafts/<stem>/<name>`` first so originals
    (esp. user uploads) stay pristine.
    """
    drafts_root = root / "workspace" / "drafts"
    try:
        src.relative_to(drafts_root)
        return src
    except ValueError:
        pass
    draft_dir = drafts_root / src.stem
    draft_dir.mkdir(parents=True, exist_ok=True)
    draft = draft_dir / src.name
    if not draft.exists():
        shutil.copy2(src, draft)
    return draft


# ── conversion / preview (LibreOffice + poppler) ────────────────────


def _find_soffice() -> Optional[str]:
    """PATH first, then the Debian slim install location (with
    --no-install-recommends the /usr/bin/soffice symlink is absent)."""
    found = shutil.which("soffice")
    if found:
        return found
    fallback = "/usr/lib/libreoffice/program/soffice"
    return fallback if Path(fallback).exists() else None


def _soffice(args: List[str], cwd: Path) -> None:
    binary = _find_soffice()
    if binary is None:
        raise ToolError(
            "LibreOffice (soffice) is not installed in this backend — document "
            "conversion/preview is unavailable. See README (recommended dependency)."
        )
    with _SOFFICE_LOCK:
        proc = subprocess.run(
            [binary, "--headless", "--norestore", *args],
            cwd=str(cwd), capture_output=True, timeout=_SOFFICE_TIMEOUT,
        )
    if proc.returncode != 0:
        raise ToolError(f"LibreOffice conversion failed: {proc.stderr.decode(errors='replace')[:400]}")


def _to_pdf(doc: Path, outdir: Path) -> Path:
    outdir.mkdir(parents=True, exist_ok=True)
    _soffice(["--convert-to", "pdf", "--outdir", str(outdir), str(doc)], cwd=outdir)
    pdf = outdir / (doc.stem + ".pdf")
    if not pdf.exists():
        raise ToolError("Conversion produced no PDF output.")
    return pdf


def _pdf_to_pngs(pdf: Path, outdir: Path) -> List[Path]:
    if shutil.which("pdftoppm") is None:
        raise ToolError("pdftoppm (poppler-utils) is not installed — PNG preview unavailable.")
    outdir.mkdir(parents=True, exist_ok=True)
    for old in outdir.glob("page-*.png"):
        old.unlink(missing_ok=True)
    subprocess.run(
        ["pdftoppm", "-png", "-r", _PREVIEW_DPI, "-l", str(_MAX_PREVIEW_PAGES),
         str(pdf), str(outdir / "page")],
        capture_output=True, timeout=_SOFFICE_TIMEOUT, check=True,
    )
    return sorted(outdir.glob("page-*.png"))


def _regen_preview(root: Path, draft: Path) -> Dict[str, Any]:
    """Best-effort preview regeneration for a draft; never raises.

    Native pipeline first (edit2docs render_doc → page-N.png, the same
    naming pdftoppm produced, so CanvasTab pages unchanged) — no
    LibreOffice, no global lock, per-session parallel. LibreOffice+
    pdftoppm remain only as a fallback for machines that still have
    them when the native render fails.
    """
    preview_dir = draft.parent / "preview"
    try:
        import edit2docs

        result = edit2docs.render_doc(
            str(draft), to="png", out_dir=str(preview_dir), dpi=96
        )
        return {"preview_pages": [_rel(root, Path(str(p))) for p in result.paths]}
    except Exception as exc:  # noqa: BLE001
        native_err = str(exc)[:200]
    try:
        pdf = _to_pdf(draft, preview_dir)
        pages = _pdf_to_pngs(pdf, preview_dir)
        return {"preview_pages": [_rel(root, p) for p in pages]}
    except Exception:  # noqa: BLE001
        return {"preview_error": native_err}


# ── edit2docs engine access ──────────────────────────────────────────


def _engine():
    try:
        import edit2docs  # noqa: PLC0415
    except ImportError:
        raise ToolError(
            "The edit2docs engine is not installed in this backend — "
            "document analyze/edit/generate is unavailable."
        )
    return edit2docs


def _anthropic_api_key() -> str:
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        raise ToolError(
            "doc_generate needs an Anthropic API key (ANTHROPIC_API_KEY env "
            "var on the backend). For key-free editing use doc_analyze + "
            "doc_edit."
        )
    return key


class _ThreadedTool(BaseTool):
    """Runs the sync ``run()`` off the event loop.

    The Geny dispatch awaits ``arun`` on the loop itself; document work
    (zip parsing, LibreOffice subprocesses behind a lock) would block
    every other session, so these tools hop to a worker thread.
    """

    async def arun(self, **kwargs) -> str:
        return await asyncio.to_thread(self.run, **kwargs)


# ── tools ────────────────────────────────────────────────────────────


class DocConvertTool(_ThreadedTool):
    """Convert an office document (pptx/docx/xlsx/…) to pdf, png previews, or text."""

    name = "doc_convert"
    # LibreOffice headless shares one profile (module lock) — serialize.
    CAPABILITIES = ToolCapabilities(
        concurrency_safe=False, idempotent=True, max_result_chars=20_000,
    )
    description = (
        "Convert a document in the session storage (pptx/docx/xlsx/odt/pdf/…) to "
        "another format. to='pdf' produces a PDF next to a draft copy; to='png' "
        "renders page/slide preview images; to='text' extracts markdown text via the "
        "edit2docs converter (pdf/docx/pptx/xlsx/html/epub/ipynb …) into a .md file "
        "(read it with Read). Paths are relative to the session storage, e.g. "
        "'workspace/uploads/deck.pptx'."
    )

    def run(self, session_id: str, path: str, to: str = "pdf") -> str:
        """Convert a document.

        Args:
            path: Source file path (relative to session storage or absolute inside it).
            to: Target — 'pdf', 'png' (per-page preview images), or 'text'.
        """
        root = _storage_root(session_id)
        src = _resolve(root, path)
        if not src.is_file():
            raise ToolError(f"File not found: {path}")
        to = (to or "pdf").lower().strip()
        draft = _ensure_draft(root, src)
        outdir = draft.parent

        native = draft.suffix.lower() in _EDITABLE_EXTS
        if to == "pdf":
            if native:
                import edit2docs

                result = edit2docs.render_doc(str(draft), to="pdf", out_dir=str(outdir))
                return json.dumps(
                    {"ok": True, "pdf": _rel(root, Path(str(result.paths[0])))},
                    ensure_ascii=False,
                )
            pdf = _to_pdf(draft, outdir)  # legacy formats (odt/doc/ppt…) need soffice
            return json.dumps({"ok": True, "pdf": _rel(root, pdf)}, ensure_ascii=False)
        if to == "png":
            if native:
                import edit2docs

                result = edit2docs.render_doc(
                    str(draft), to="png", out_dir=str(outdir / "preview"), dpi=96
                )
                return json.dumps(
                    {"ok": True,
                     "pages": [_rel(root, Path(str(p))) for p in result.paths]},
                    ensure_ascii=False,
                )
            pdf = _to_pdf(draft, outdir / "preview")
            pages = _pdf_to_pngs(pdf, outdir / "preview")
            return json.dumps(
                {"ok": True, "pages": [_rel(root, p) for p in pages]}, ensure_ascii=False
            )
        if to in ("text", "txt", "md", "markdown"):
            txt = self._extract_text(draft)
            out = outdir / (draft.stem + ".md")
            out.write_text(txt, encoding="utf-8")
            return json.dumps(
                {"ok": True, "text_file": _rel(root, out), "chars": len(txt),
                 "head": txt[:600]}, ensure_ascii=False
            )
        raise ToolError(f"Unsupported target format: {to} (use pdf / png / text)")

    @staticmethod
    def _extract_text(doc: Path) -> str:
        """Markdown extraction via edit2docs; LibreOffice fallback for the
        formats it does not ingest (e.g. legacy .ppt)."""
        try:
            from edit2docs.tools.convert import ConvertRequest, convert_to_markdown

            resp = convert_to_markdown(
                ConvertRequest(content=doc.read_bytes(), original_filename=doc.name)
            )
            text = getattr(resp, "markdown", "") or ""
            if text.strip():
                return text
            logger.info("edit2docs convert returned empty for %s — soffice fallback", doc.name)
        except ToolError:
            raise
        except Exception as exc:  # noqa: BLE001 — unsupported format / parse error
            logger.info("edit2docs convert failed for %s (%s) — soffice fallback", doc.name, exc)
        outdir = doc.parent
        _soffice(["--convert-to", "txt:Text", "--outdir", str(outdir), str(doc)], cwd=outdir)
        out = outdir / (doc.stem + ".txt")
        return out.read_text(encoding="utf-8", errors="replace") if out.exists() else ""


class DocAnalyzeTool(_ThreadedTool):
    """Outline a document — the address source for doc_edit."""

    name = "doc_analyze"
    CAPABILITIES = ToolCapabilities(
        concurrency_safe=True, read_only=True, idempotent=True,
        max_result_chars=60_000,
    )
    description = (
        "Analyze a .docx/.xlsx/.pptx in the session storage and return its "
        "addressable outline as JSON: DOCX paragraphs ({para, style, text}) and "
        "table cells ({table, row, col, text}); XLSX sheets with sample rows; PPTX "
        "slides with text shapes ({shape_id, para, text}). Use these addresses in "
        "doc_edit. Read-only — works on the draft copy if one exists, else the "
        "original."
    )

    def run(self, session_id: str, path: str) -> str:
        """Analyze a document's structure.

        Args:
            path: Document path (relative to session storage), .docx/.xlsx/.pptx.
        """
        engine = _engine()
        root = _storage_root(session_id)
        src = _resolve(root, path)
        if not src.is_file():
            raise ToolError(f"File not found: {path}")
        if src.suffix.lower() not in _EDITABLE_EXTS:
            raise ToolError(
                f"doc_analyze handles {', '.join(_EDITABLE_EXTS)} (use doc_convert "
                "to='text' for other formats)."
            )
        # Analyze the draft when it exists so addresses match what doc_edit
        # will touch; a fresh copy is byte-identical to the original anyway.
        drafts_root = root / "workspace" / "drafts"
        candidate = drafts_root / src.stem / src.name
        target = candidate if candidate.is_file() else src
        info = engine.analyze_doc(str(target))
        info["path"] = _rel(root, target)
        return json.dumps(info, ensure_ascii=False, default=str)


class DocEditTool(_ThreadedTool):
    """Address-based document editing (edit2docs set_doc_text)."""

    name = "doc_edit"
    # Writes the draft + regenerates previews behind the soffice lock.
    CAPABILITIES = ToolCapabilities(concurrency_safe=False, max_result_chars=30_000)
    description = (
        "Apply precise text edits to a .docx/.xlsx/.pptx in the session storage at "
        "addresses from doc_analyze. Edits a DRAFT copy under workspace/drafts/ "
        "(originals stay untouched) and regenerates PNG previews. edits is a JSON "
        "list, format-dispatched by extension — DOCX: "
        '{"action":"replace","para":3,"new_text":"…"} | {"action":"replace",'
        '"table":0,"row":1,"col":2,"new_text":"…"} | {"action":"insert_after",'
        '"para":3,"markdown":"…"} (para=-1 prepends) | {"action":"delete","para":3}. '
        'XLSX: {"action":"set_cell","sheet":"Sheet1","cell":"B2","value":123} | '
        '{"action":"append_rows","sheet":"…","rows":[[…]]} | {"action":"add_sheet",'
        '"sheet":"…","headers":[…],"rows":[[…]]}. PPTX: {"slide":0,"shape_id":2,'
        '"para":0,"new_text":"…"} (table cells add "row"/"col"). Optional '
        '"old_text"/"old_value" guards reject stale edits. Each edit returns status '
        "applied | stale | not_found | invalid with a reason — fix and resend only "
        "the failed ones. Send the finished file to the user with SendUserFile."
    )

    def run(self, session_id: str, path: str, edits: List[Dict[str, Any]]) -> str:
        """Apply address-based edits to a document.

        Args:
            path: Source document path (relative to session storage).
            edits: List of edit objects (see tool description for shapes).
        """
        engine = _engine()
        root = _storage_root(session_id)
        src = _resolve(root, path)
        if not src.is_file():
            raise ToolError(f"File not found: {path}")
        if src.suffix.lower() not in _EDITABLE_EXTS:
            raise ToolError(f"doc_edit handles {', '.join(_EDITABLE_EXTS)} files.")
        if not isinstance(edits, list) or not edits or not all(
            isinstance(e, dict) for e in edits
        ):
            raise ToolError("edits must be a non-empty JSON list of objects.")
        draft = _ensure_draft(root, src)
        result = engine.set_doc_text(str(draft), edits, output=str(draft))
        results = list(getattr(result, "results", []) or [])
        applied = int(getattr(result, "applied", 0) or 0)
        failed = [r for r in results if r.get("status") != "applied"]
        payload: Dict[str, Any] = {
            "ok": not failed,
            "draft": _rel(root, draft),
            "applied": applied,
            "failed": len(failed),
            "results": results,
        }
        if applied and draft.suffix.lower() in _PREVIEW_EXTS:
            payload.update(_regen_preview(root, draft))
        return json.dumps(payload, ensure_ascii=False, default=str)


class DocGenerateTool(_ThreadedTool):
    """Generate a new document from a natural-language intent (edit2docs)."""

    name = "doc_generate"
    CAPABILITIES = ToolCapabilities(
        concurrency_safe=False, network_egress=True, max_result_chars=20_000,
    )
    description = (
        "Generate a NEW .docx/.xlsx/.pptx document from a natural-language intent "
        "(the output extension picks the engine). Optional sources (session-storage "
        "paths or URLs — pdf/docx/xlsx/pptx/html/epub/ipynb …) ground the content. "
        "The file lands under workspace/drafts/<stem>/ with PNG previews. PPTX "
        "generation can take minutes. Requires ANTHROPIC_API_KEY on the backend."
    )

    def run(
        self,
        session_id: str,
        intent: str,
        output: str,
        sources: Optional[List[str]] = None,
        lang: str = "ko-KR",
    ) -> str:
        """Generate a document.

        Args:
            intent: What to create, in natural language.
            output: Output file name or path — must end in .docx/.xlsx/.pptx.
            sources: Optional grounding sources (session-storage paths or URLs).
            lang: Content language (default ko-KR).
        """
        return _run_coro_blocking(
            self._generate(session_id, intent, output, sources, lang)
        )

    async def arun(self, **kwargs) -> str:
        return await self._generate(
            kwargs["session_id"],
            kwargs.get("intent", ""),
            kwargs.get("output", ""),
            kwargs.get("sources"),
            kwargs.get("lang", "ko-KR"),
        )

    async def _generate(
        self,
        session_id: str,
        intent: str,
        output: str,
        sources: Optional[List[str]],
        lang: str,
    ) -> str:
        engine = _engine()
        api_key = _anthropic_api_key()
        root = await asyncio.to_thread(_storage_root, session_id)
        if not (intent or "").strip():
            raise ToolError("intent must not be empty.")
        name = Path(output or "").name
        if not name or Path(name).suffix.lower() not in _EDITABLE_EXTS:
            raise ToolError(f"output must end in one of {', '.join(_EDITABLE_EXTS)}.")
        # Generated documents follow the drafts convention so the CanvasTab
        # pager + SendUserFile flows work exactly like edited documents.
        out_dir = root / "workspace" / "drafts" / Path(name).stem
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = out_dir / name

        resolved_sources: List[str] = []
        for s in sources or []:
            s = str(s)
            if "://" in s:
                resolved_sources.append(s)
            else:
                p = _resolve(root, s)
                if not p.is_file():
                    raise ToolError(f"Source file not found: {s}")
                resolved_sources.append(str(p))

        kwargs: Dict[str, Any] = {"api_key": api_key, "lang": lang}
        if resolved_sources:
            kwargs["sources"] = resolved_sources
        model = os.environ.get("GENY_DOCS_MODEL")
        if model:
            kwargs["model"] = model
        result = await engine.async_generate_doc(intent, output=str(out_path), **kwargs)

        payload: Dict[str, Any] = {
            "ok": True,
            "draft": _rel(root, Path(str(getattr(result, "path", out_path)))),
            "page_count": getattr(result, "page_count", None),
            "warnings": list(getattr(result, "warnings", []) or []),
        }
        if out_path.suffix.lower() in _PREVIEW_EXTS:
            payload.update(await asyncio.to_thread(_regen_preview, root, out_path))
        return json.dumps(payload, ensure_ascii=False, default=str)


def _run_coro_blocking(coro) -> str:
    """asyncio.run that also works when a loop is already running
    (falls back to a dedicated thread — same bridge the old
    web_fetch_multiple used)."""
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)
    import concurrent.futures

    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(asyncio.run, coro).result()


TOOLS = [DocConvertTool(), DocAnalyzeTool(), DocEditTool(), DocGenerateTool()]
