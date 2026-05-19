#!/usr/bin/env python3
"""Stdio MCP server that bridges to Geny's HTTP tool endpoint.

Phase I of docs/llm-backend-upgrade-plan/12_phase_i_claude_code_mcp_wrap.md.
Spawned as a subprocess by ``claude --mcp-config <json>`` with env vars
identifying the session + bearer token. The Claude Code CLI speaks MCP
JSON-RPC over our stdin/stdout; we forward each call to Geny's
``/api/internal/mcp/{session_id}/rpc`` endpoint and proxy the response
back unchanged.

Design choices:

  - Keep this script **standalone and dependency-free**: only Python
    stdlib (``urllib``) so it works in any container where ``python3``
    is on PATH, no ``pip install`` required at bridge launch time.
  - **Synchronous, line-by-line** stdio reader. Claude Code sends one
    JSON-RPC envelope per line; we never need pipelining.
  - **HTTP errors get translated to MCP errors** so the CLI sees a
    coherent protocol response instead of a bridge crash.

Env vars (set by Geny's MCP config when spawning claude):
  GENY_MCP_URL        — base URL (default http://127.0.0.1:8000)
  GENY_MCP_TOKEN      — bearer token (REQUIRED)
  GENY_MCP_SESSION_ID — session UUID (REQUIRED)
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request


_DEFAULT_URL = os.environ.get("GENY_MCP_URL", "http://127.0.0.1:8000").rstrip("/")
_TOKEN = os.environ.get("GENY_MCP_TOKEN", "")
_SESSION_ID = os.environ.get("GENY_MCP_SESSION_ID", "")
_TIMEOUT = float(os.environ.get("GENY_MCP_TIMEOUT_S", "300"))


def _write_response(response: dict) -> None:
    """Emit one MCP response line on stdout. Flush so the CLI sees
    it without buffering delay."""
    sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _err(req_id, code: int, message: str) -> dict:
    return {
        "jsonrpc": "2.0",
        "id": req_id,
        "error": {"code": code, "message": message},
    }


def _forward(envelope: dict) -> dict:
    """POST one JSON-RPC envelope to Geny and return the response.

    Translates transport errors (HTTP 4xx/5xx, connection refused,
    timeout) into MCP-shaped JSON-RPC errors so the CLI never sees a
    bridge crash."""
    req_id = envelope.get("id")

    if not _TOKEN or not _SESSION_ID:
        return _err(
            req_id,
            -32603,
            "bridge misconfigured: missing GENY_MCP_TOKEN or GENY_MCP_SESSION_ID",
        )

    url = f"{_DEFAULT_URL}/api/internal/mcp/{_SESSION_ID}/rpc"
    payload = json.dumps(envelope, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=payload,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {_TOKEN}",
        },
    )

    try:
        with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:
            body = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace") if e.fp else ""
        # The Geny endpoint returns its own JSON-RPC error envelope
        # on protocol failures (404 / 401 / 500). Try to surface it;
        # otherwise synthesize one.
        try:
            return json.loads(body)
        except json.JSONDecodeError:
            return _err(req_id, -32603, f"HTTP {e.code}: {body[:200]}")
    except urllib.error.URLError as e:
        return _err(req_id, -32603, f"transport error: {e.reason}")
    except Exception as e:  # noqa: BLE001
        return _err(req_id, -32603, f"bridge error: {e}")

    try:
        return json.loads(body)
    except json.JSONDecodeError:
        return _err(req_id, -32603, f"invalid JSON response: {body[:200]}")


def main() -> int:
    # Read line-delimited JSON-RPC from stdin until EOF.
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            envelope = json.loads(line)
        except json.JSONDecodeError:
            # Spec: server SHOULD NOT respond to malformed input;
            # log to stderr (CLI surfaces it under --debug=mcp).
            sys.stderr.write(f"geny_mcp_bridge: malformed JSON: {line[:120]}\n")
            sys.stderr.flush()
            continue

        # Notifications (no ``id``) per JSON-RPC spec don't expect a
        # response — but the CLI's MCP client awaits one for
        # ``notifications/initialized`` in practice. Forward
        # everything and let Geny decide whether to respond.
        response = _forward(envelope)
        _write_response(response)
    return 0


if __name__ == "__main__":
    sys.exit(main())
