"""Native HTTP tool — authenticated REST calls (GET/POST/PUT/PATCH/DELETE).

Complements WebFetch (GET → markdown) with full method + headers + JSON body for
calling arbitrary APIs. Always available (no config); the agent supplies the URL +
auth header per call. Returns status + headers summary + body (truncated).
"""

from __future__ import annotations

import json as _json
from logging import getLogger
from typing import Any, Dict, Optional

from tools.base import BaseTool, ToolError

logger = getLogger(__name__)

_MAX_BODY = 12000
_ALLOWED = {"GET", "POST", "PUT", "PATCH", "DELETE"}


class HttpRequestTool(BaseTool):
    """Make an HTTP request to a REST API and return the response."""

    name = "http_request"
    description = (
        "Call an HTTP/REST API: choose method, URL, optional headers (e.g. "
        "Authorization), query params, and a JSON body. Returns status + response "
        "body. Use this for APIs; use WebFetch to read web pages as text."
    )

    def run(
        self,
        url: str,
        method: str = "GET",
        headers: Optional[Dict[str, str]] = None,
        params: Optional[Dict[str, Any]] = None,
        json_body: Optional[Dict[str, Any]] = None,
        body: str = "",
    ) -> str:
        """Make an HTTP request.

        Args:
            url: Full request URL (https).
            method: HTTP method — GET, POST, PUT, PATCH, or DELETE.
            headers: Optional request headers (e.g. {"Authorization": "Bearer ..."}).
            params: Optional query-string parameters.
            json_body: Optional JSON request body (object) — sets Content-Type.
            body: Optional raw string body (used when json_body is not given).
        """
        import httpx

        m = (method or "GET").upper().strip()
        if m not in _ALLOWED:
            raise ToolError(f"Unsupported method {m!r} (allowed: {', '.join(sorted(_ALLOWED))})")
        if not (url.startswith("http://") or url.startswith("https://")):
            raise ToolError("url must start with http:// or https://")

        # SSRF guard (audit S5): block cloud-metadata / loopback / private
        # targets on the initial URL and every redirect hop, so a
        # model-driven http_request can't steal IMDS credentials or reach
        # internal admin APIs. GENY_ALLOW_PRIVATE_URLS=1 opts out.
        from geny_executor.security import SSRFError, validate_url as _ssrf_validate

        def _ssrf_hook(request):
            _ssrf_validate(str(request.url))

        try:
            _ssrf_validate(url)
        except SSRFError as e:
            raise ToolError(f"blocked (SSRF guard): {e}")

        kw: Dict[str, Any] = {"headers": headers or {}, "params": params or {}}
        if json_body is not None:
            kw["json"] = json_body
        elif body:
            kw["content"] = body

        try:
            with httpx.Client(
                timeout=30,
                follow_redirects=True,
                event_hooks={"request": [_ssrf_hook]},
            ) as c:
                r = c.request(m, url, **kw)
        except SSRFError as e:
            raise ToolError(f"blocked (SSRF guard): {e}")
        except Exception as e:  # noqa: BLE001
            raise ToolError(f"HTTP request failed: {e}")

        ctype = r.headers.get("content-type", "")
        text = r.text or ""
        # Pretty-print JSON when possible for readability.
        if "json" in ctype:
            try:
                text = _json.dumps(r.json(), ensure_ascii=False, indent=2)
            except Exception:  # noqa: BLE001
                pass
        if len(text) > _MAX_BODY:
            text = text[:_MAX_BODY] + f"\n…(truncated, {len(r.text)} chars total)"
        return f"HTTP {r.status_code} {r.reason_phrase}\nContent-Type: {ctype}\n\n{text}"


TOOLS = [HttpRequestTool()]
