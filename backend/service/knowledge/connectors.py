"""Continuous knowledge collection — API / web / DB connectors.

A ``KnowledgeSource`` describes one recurring collection job:

* ``api``  — HTTP request (method/url/headers/body); JSON payloads flow
  through Contextifier's structure-aware rendering.
* ``web``  — fetch a page (httpx by default; ``render_js: true`` uses the
  an-web engine for JS-heavy sites). Optional ``sitemap: true`` expands a
  sitemap.xml (same-host, ``max_pages`` capped).
* ``db``   — SQLAlchemy query (postgres/mysql/sqlite dsn); rows render as
  a markdown record list, ``key_column`` names each record.

Every fetch lands through ``KnowledgeService.ingest_text`` with a STABLE
``doc_key`` (source id + item locator) — re-collections update the same
document card / replace its qdrant points, and unchanged content is a
content-hash no-op ("unchanged"). Schedules are cron expressions
(croniter); the scheduler is a plain asyncio loop (CurationScheduler
pattern) checking every 60s.

Source configs contain credentials (headers, dsn) → they persist in a
0600 JSON file under the user's vault directory, NOT as vault notes.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import time
import uuid
from datetime import datetime, timezone
from logging import getLogger
from pathlib import Path
from typing import Any, Dict, List, Optional

from service.knowledge.service import get_knowledge_service

logger = getLogger(__name__)

_SOURCES_FILENAME = "_knowledge_sources.json"
_CHECK_INTERVAL_S = 60.0
_FETCH_TIMEOUT_S = 45.0
_MAX_PAGES_DEFAULT = 20
_MAX_DB_ROWS = 2000

SOURCE_TYPES = ("api", "web", "db")


# ── source persistence ────────────────────────────────────────────────


def _sources_path(username: str) -> Path:
    from service.memory.user_opsidian import get_user_opsidian_manager

    vault_dir = Path(get_user_opsidian_manager(username).memory_dir)
    return vault_dir / _SOURCES_FILENAME


def load_sources(username: str) -> List[Dict[str, Any]]:
    path = _sources_path(username)
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except (OSError, ValueError):
        logger.warning("knowledge: sources file unreadable", exc_info=True)
        return []


def save_sources(username: str, sources: List[Dict[str, Any]]) -> None:
    path = _sources_path(username)
    path.write_text(
        json.dumps(sources, ensure_ascii=False, indent=2), encoding="utf-8",
    )
    try:
        os.chmod(path, 0o600)  # configs may carry credentials
    except OSError:
        pass


def upsert_source(username: str, source: Dict[str, Any]) -> Dict[str, Any]:
    sources = load_sources(username)
    source_id = source.get("id") or uuid.uuid4().hex[:10]
    source["id"] = source_id
    source.setdefault("enabled", True)
    source.setdefault("schedule", "0 * * * *")  # hourly default
    for i, existing in enumerate(sources):
        if existing.get("id") == source_id:
            # Preserve run bookkeeping across edits.
            for key in ("last_run_at", "last_result"):
                source.setdefault(key, existing.get(key))
            sources[i] = source
            break
    else:
        sources.append(source)
    save_sources(username, sources)
    return source


def delete_source(username: str, source_id: str) -> bool:
    sources = load_sources(username)
    kept = [s for s in sources if s.get("id") != source_id]
    if len(kept) == len(sources):
        return False
    save_sources(username, kept)
    return True


# ── fetchers ─────────────────────────────────────────────────────────


async def _fetch_api(source: Dict[str, Any]) -> List[Dict[str, str]]:
    import httpx

    cfg = source.get("config") or {}
    url = cfg.get("url", "")
    if not url:
        raise ValueError("api source requires config.url")
    async with httpx.AsyncClient(timeout=_FETCH_TIMEOUT_S, follow_redirects=True) as client:
        res = await client.request(
            (cfg.get("method") or "GET").upper(),
            url,
            headers=cfg.get("headers") or {},
            json=cfg.get("body") if cfg.get("body") else None,
        )
        res.raise_for_status()
    content_type = res.headers.get("content-type", "")
    ext = "json" if "json" in content_type else "txt"
    return [{
        "title": source.get("name") or url,
        "text": res.text,
        "ext": ext,
        "locator": url,
    }]


def _html_ext(text: str) -> str:
    return "html" if re.search(r"<\s*(html|body|div|p)\b", text[:4000], re.I) else "txt"


async def _fetch_web(source: Dict[str, Any]) -> List[Dict[str, str]]:
    import httpx
    from urllib.parse import urlparse

    cfg = source.get("config") or {}
    url = cfg.get("url", "")
    if not url:
        raise ValueError("web source requires config.url")
    max_pages = min(int(cfg.get("max_pages", _MAX_PAGES_DEFAULT)), 100)

    urls = [url]
    if cfg.get("sitemap"):
        async with httpx.AsyncClient(timeout=_FETCH_TIMEOUT_S, follow_redirects=True) as client:
            res = await client.get(url)
            res.raise_for_status()
        host = urlparse(url).netloc
        locs = re.findall(r"<loc>\s*([^<\s]+)\s*</loc>", res.text)
        urls = [u for u in locs if urlparse(u).netloc == host][:max_pages]
        if not urls:
            raise ValueError("sitemap contained no same-host <loc> entries")

    docs: List[Dict[str, str]] = []
    render_js = bool(cfg.get("render_js"))
    for page_url in urls[:max_pages]:
        try:
            if render_js:
                text = await _render_with_anweb(page_url)
                ext = "txt"
            else:
                async with httpx.AsyncClient(
                    timeout=_FETCH_TIMEOUT_S, follow_redirects=True,
                    headers={"User-Agent": "GenyKnowledge/1.0"},
                ) as client:
                    res = await client.get(page_url)
                    res.raise_for_status()
                text = res.text
                ext = _html_ext(text)
            docs.append({
                "title": f"{source.get('name') or 'web'} — {page_url}",
                "text": text,
                "ext": ext,
                "locator": page_url,
            })
        except Exception as exc:  # noqa: BLE001 — per-page best-effort
            logger.warning("knowledge web fetch failed: %s (%s)", page_url, exc)
    if not docs:
        raise RuntimeError("no pages fetched")
    return docs


async def _render_with_anweb(url: str) -> str:
    """JS-rendered page → visible text via the an-web engine."""
    from an_web import ANWebEngine

    async with ANWebEngine() as engine:
        session = await engine.create_session()
        try:
            result = await session.navigate(url, timeout=_FETCH_TIMEOUT_S)
            if not isinstance(result, dict) or result.get("status") != "ok":
                raise RuntimeError(f"an-web navigate failed: {result}")
            # an-web 0.9 has no public document accessor yet.
            doc = getattr(session, "_current_document", None)
            body = getattr(doc, "body", None)
            text = body.inner_text if body is not None else ""
            if not text.strip():
                raise RuntimeError("an-web rendered an empty body")
            return text
        finally:
            await session.close()


async def _fetch_db(source: Dict[str, Any]) -> List[Dict[str, str]]:
    cfg = source.get("config") or {}
    dsn = cfg.get("dsn", "")
    query = cfg.get("query", "")
    if not dsn or not query:
        raise ValueError("db source requires config.dsn and config.query")

    def _run_query() -> List[Dict[str, Any]]:
        from sqlalchemy import create_engine, text

        engine = create_engine(dsn, pool_pre_ping=True)
        try:
            with engine.connect() as conn:
                result = conn.execute(text(query))
                cols = list(result.keys())
                return [
                    dict(zip(cols, row))
                    for row in result.fetchmany(_MAX_DB_ROWS)
                ]
        finally:
            engine.dispose()

    rows = await asyncio.to_thread(_run_query)
    if not rows:
        raise RuntimeError("query returned no rows")
    key_column = (cfg.get("key_column") or "").strip()
    lines: List[str] = [f"# {source.get('name') or 'db source'}", ""]
    for row in rows:
        head = str(row.get(key_column, "")) if key_column else ""
        lines.append(f"## {head}" if head else "## record")
        for col, value in row.items():
            lines.append(f"- {col}: {value}")
        lines.append("")
    return [{
        "title": source.get("name") or "db",
        "text": "\n".join(lines),
        "ext": "md",
        "locator": f"{dsn.split('@')[-1]}::{query[:60]}",
    }]


_FETCHERS = {"api": _fetch_api, "web": _fetch_web, "db": _fetch_db}


# ── one collection run ───────────────────────────────────────────────


async def run_source(username: str, source: Dict[str, Any]) -> Dict[str, Any]:
    """Fetch + ingest one source. Updates the source's run bookkeeping.
    Returns a run report (also stored as ``last_result``)."""
    started = datetime.now(timezone.utc).isoformat()
    stype = source.get("type", "")
    fetcher = _FETCHERS.get(stype)
    report: Dict[str, Any] = {"started_at": started, "ok": False}
    try:
        if fetcher is None:
            raise ValueError(f"unknown source type: {stype}")
        docs = await fetcher(source)
        svc = get_knowledge_service(username)
        ingested, unchanged, failed = 0, 0, 0
        for doc in docs:
            # Titles carry URLs — flatten path separators so the vault
            # filename (Path(...).name) keeps the whole label.
            safe_title = (
                re.sub(r'[\\/:*?"<>|]+', "-", doc["title"]).strip() or "document"
            )
            out = await svc.ingest_text(
                title=safe_title[:120],
                text=doc["text"],
                source_type=stype,
                source_ref=doc["locator"],
                extension=doc["ext"],
                doc_key=f"{source['id']}::{doc['locator']}",
            )
            status = out.get("status")
            if status == "ready":
                ingested += 1
            elif status == "unchanged":
                unchanged += 1
            else:
                failed += 1
        report.update(
            ok=failed == 0,
            fetched=len(docs), ingested=ingested,
            unchanged=unchanged, failed=failed,
        )
    except Exception as exc:  # noqa: BLE001 — recorded on the source
        report.update(ok=False, error=str(exc)[:300])
        logger.warning(
            "knowledge source run failed: %s/%s",
            username, source.get("id"), exc_info=True,
        )

    # Persist bookkeeping.
    sources = load_sources(username)
    for row in sources:
        if row.get("id") == source.get("id"):
            row["last_run_at"] = started
            row["last_result"] = report
    save_sources(username, sources)
    return report


def _due(source: Dict[str, Any], now: float) -> bool:
    if not source.get("enabled", True):
        return False
    schedule = str(source.get("schedule") or "").strip()
    last = source.get("last_run_at")
    if not last:
        return True  # never ran → run now
    try:
        from croniter import croniter

        last_dt = datetime.fromisoformat(last)
        next_at = croniter(schedule, last_dt).get_next(datetime)
        return next_at.timestamp() <= now
    except Exception:  # noqa: BLE001 — bad cron → don't loop-fire
        return False


class KnowledgeCollectionScheduler:
    """Asyncio loop firing due sources (CurationScheduler pattern).

    Users are discovered from existing ``_knowledge_sources.json`` files
    under the ``_user_opsidian`` root — no registration step."""

    def __init__(self) -> None:
        self._task: Optional[asyncio.Task] = None
        self._running: Dict[str, float] = {}  # source_id → started monotonic

    def start(self) -> None:
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._loop(), name="knowledge.scheduler")

    def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            self._task = None

    @staticmethod
    def _discover_usernames() -> List[str]:
        try:
            from service.utils.platform import DEFAULT_STORAGE_ROOT

            root = Path(DEFAULT_STORAGE_ROOT) / "_user_opsidian"
            if not root.exists():
                return []
            return [
                p.parent.name for p in root.glob(f"*/{_SOURCES_FILENAME}")
            ]
        except Exception:  # noqa: BLE001
            return []

    async def _loop(self) -> None:
        # Brief settle so the first due source doesn't race app startup,
        # but far shorter than a full cycle (was a 60s cold gap).
        first = True
        while True:
            try:
                await asyncio.sleep(10 if first else _CHECK_INTERVAL_S)
                first = False
                now = time.time()
                fired = 0
                for username in self._discover_usernames():
                    for source in load_sources(username):
                        sid = str(source.get("id"))
                        if sid in self._running:
                            continue
                        if not _due(source, now):
                            continue
                        self._running[sid] = time.monotonic()

                        async def _run(u=username, s=source, key=sid):
                            try:
                                await run_source(u, s)
                            finally:
                                self._running.pop(key, None)

                        asyncio.create_task(
                            _run(), name=f"knowledge.collect:{sid}",
                        )
                        fired += 1
                if fired:
                    logger.info("knowledge scheduler: fired %d source(s)", fired)
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 — the loop must survive
                logger.warning("knowledge scheduler tick failed", exc_info=True)


_scheduler: Optional[KnowledgeCollectionScheduler] = None


def get_knowledge_scheduler() -> KnowledgeCollectionScheduler:
    global _scheduler
    if _scheduler is None:
        _scheduler = KnowledgeCollectionScheduler()
    return _scheduler
