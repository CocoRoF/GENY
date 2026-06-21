"""
Web Search Tools — built-in search tools powered by DDGS (DuckDuckGo Search).

Provides web text search, news search, and image search capabilities
using the ``ddgs`` metasearch library. These tools are automatically
loaded by MCPLoader (matches *_tools.py pattern) and registered as
built-in tools under the ``_builtin_tools`` MCP server.

Requires:
    pip install ddgs
"""

import json
from typing import Optional
from geny_executor.tools.base import ToolCapabilities
from tools.base import BaseTool


def _safe_ddgs_import():
    """Import DDGS with a clear error if not installed."""
    try:
        from ddgs import DDGS
        return DDGS
    except ImportError as exc:
        raise ImportError(
            "ddgs package is required for web search tools. "
            "Install it with: pip install ddgs"
        ) from exc


def _search_via_backend(backend_name: str, cfg: dict, query: str, max_results: int, region: str) -> list:
    """Delegate to geny-executor's pluggable web-search backend (Brave / Tavily /
    SearXNG), reusing the executor capability rather than duplicating it.

    ``cfg`` is the per-environment ``web_search`` Tool-Setting (backend + keys),
    injected from ``ctx.extras["web_search"]``. Returns normalized hit dicts
    (rank/title/url/snippet). Raises :class:`ToolError` on config/runtime error.
    """
    import asyncio
    from types import SimpleNamespace

    from geny_executor.tools.built_in._web_search_backends import (
        WebSearchBackendError,
        build_backend,
    )

    from tools.base import ToolError

    ctx = SimpleNamespace(extras={"web_search": cfg})
    try:
        backend = build_backend(backend_name, ctx)
        return asyncio.run(backend.search(query, max_results, region, "moderate"))
    except WebSearchBackendError as exc:
        raise ToolError(str(exc)) from exc
    except Exception as exc:
        raise ToolError(f"web search via {backend_name} failed: {exc}") from exc


class WebSearchTool(BaseTool):
    """Search the web using multiple search engines.

    Performs a metasearch across engines like Google, Bing, DuckDuckGo,
    Brave, and others. Returns titles, URLs, and snippets for each result.

    Use this to find current information, documentation, code examples,
    or any web-accessible content.
    """

    name = "web_search"
    description = (
        "Search the web for information. Returns titles, URLs, and snippets "
        "from multiple search engines. Use for finding documentation, articles, "
        "code examples, current events, or any web-accessible information."
    )
    CAPABILITIES = ToolCapabilities(
        concurrency_safe=True, read_only=True, idempotent=True,
        network_egress=True, max_result_chars=10_000,
    )

    def run(
        self,
        query: str,
        max_results: int = 5,
        region: str = "us-en",
        timelimit: Optional[str] = None,
        web_search_config: Optional[dict] = None,
    ) -> str:
        """Search the web.

        Args:
            query: Search query (e.g. "Python asyncio tutorial")
            max_results: Maximum number of results (default: 5, max: 20)
            region: Region code (e.g. "us-en", "ko-kr", "ja-jp"). Defaults to "us-en".
            timelimit: Time filter — "d" (day), "w" (week), "m" (month), "y" (year). None for all time.
        """
        import os

        max_results = min(max(1, max_results), 20)

        # Backend precedence: per-environment Tool Setting (host-injected, not
        # LLM-visible) → global Web Search config (GENY_WEBSEARCH_BACKEND env) →
        # DuckDuckGo. Non-ddg backends delegate to geny-executor's pluggable
        # backend, which reads keys from cfg or the BRAVE/TAVILY/SEARXNG env vars.
        cfg = web_search_config or {}
        backend_name = str(
            cfg.get("backend") or os.environ.get("GENY_WEBSEARCH_BACKEND") or "ddg"
        ).strip().lower()
        if backend_name and backend_name != "ddg":
            hits = _search_via_backend(backend_name, cfg, query, max_results, region)
            formatted = [
                {
                    "rank": h.get("rank", i),
                    "title": h.get("title", ""),
                    "url": h.get("url", ""),
                    "snippet": h.get("snippet", ""),
                }
                for i, h in enumerate(hits, 1)
            ]
            return json.dumps(
                {
                    "query": query,
                    "backend": backend_name,
                    "result_count": len(formatted),
                    "results": formatted,
                },
                indent=2,
                ensure_ascii=False,
            )

        DDGS = _safe_ddgs_import()

        try:
            results = DDGS().text(
                query,
                region=region,
                safesearch="moderate",
                timelimit=timelimit,
                max_results=max_results,
                backend="auto",
            )
        except Exception as e:
            return json.dumps({"error": f"Search failed: {e}"}, indent=2)

        if not results:
            return json.dumps({
                "results": [],
                "message": f"No results found for '{query}'.",
            }, indent=2)

        formatted = []
        for i, r in enumerate(results, 1):
            entry = {
                "rank": i,
                "title": r.get("title", ""),
                "url": r.get("href", ""),
                "snippet": r.get("body", ""),
            }
            formatted.append(entry)

        return json.dumps({
            "query": query,
            "result_count": len(formatted),
            "results": formatted,
        }, indent=2, ensure_ascii=False)


class NewsSearchTool(BaseTool):
    """Search for recent news articles.

    Searches news sources across Bing, DuckDuckGo, and Yahoo for
    the latest news on a topic. Returns headlines, sources, dates,
    and article URLs.
    """

    name = "news_search"
    description = (
        "Search for recent news articles on a topic. Returns headlines, "
        "sources, publication dates, and URLs. Use for current events, "
        "industry news, or any time-sensitive information."
    )
    CAPABILITIES = ToolCapabilities(
        concurrency_safe=True, read_only=True, idempotent=True,
        network_egress=True, max_result_chars=10_000,
    )

    def run(
        self,
        query: str,
        max_results: int = 5,
        region: str = "us-en",
        timelimit: Optional[str] = None,
    ) -> str:
        """Search for news.

        Args:
            query: News search query (e.g. "AI regulation 2026")
            max_results: Maximum number of results (default: 5, max: 20)
            region: Region code (e.g. "us-en", "ko-kr"). Defaults to "us-en".
            timelimit: Time filter — "d" (day), "w" (week), "m" (month). None for all time.
        """
        DDGS = _safe_ddgs_import()

        max_results = min(max(1, max_results), 20)

        try:
            results = DDGS().news(
                query,
                region=region,
                safesearch="moderate",
                timelimit=timelimit,
                max_results=max_results,
                backend="auto",
            )
        except Exception as e:
            return json.dumps({"error": f"News search failed: {e}"}, indent=2)

        if not results:
            return json.dumps({
                "results": [],
                "message": f"No news found for '{query}'.",
            }, indent=2)

        formatted = []
        for i, r in enumerate(results, 1):
            entry = {
                "rank": i,
                "title": r.get("title", ""),
                "url": r.get("url", ""),
                "source": r.get("source", ""),
                "date": r.get("date", ""),
                "snippet": r.get("body", ""),
            }
            formatted.append(entry)

        return json.dumps({
            "query": query,
            "result_count": len(formatted),
            "results": formatted,
        }, indent=2, ensure_ascii=False)


# =============================================================================
# Export list — MCPLoader auto-collects these
# =============================================================================

TOOLS = [
    WebSearchTool(),
    NewsSearchTool(),
]
