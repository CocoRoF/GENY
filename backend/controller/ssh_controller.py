"""SSH controller — test a server connection from the Settings editor.

``POST /api/ssh/test`` dry-runs a single server draft (need NOT be saved first):
it opens an SSH connection, runs a trivial command to confirm auth + reach, and
returns ``{success, latency_ms?, error?}``. Mirrors the MCP custom "test
connection" pattern. The actual connect is delegated to the executor's SSH
helper so there is a single SSH implementation shared with the agent tools.
"""

from __future__ import annotations

from logging import getLogger
from typing import Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from service.auth.auth_middleware import require_auth

logger = getLogger(__name__)

router = APIRouter(prefix="/api/ssh", tags=["ssh"])


class SSHTestRequest(BaseModel):
    host: str
    port: int = 22
    user: str = ""
    password: Optional[str] = None
    private_key: Optional[str] = None
    passphrase: Optional[str] = None
    strict_host_key: bool = False


class SSHTestResponse(BaseModel):
    success: bool
    latency_ms: Optional[float] = None
    error: Optional[str] = None


@router.post("/test", response_model=SSHTestResponse)
async def test_ssh_connection(
    body: SSHTestRequest, _auth=Depends(require_auth)
) -> SSHTestResponse:
    """Verify a server draft is reachable + authenticates. Never raises."""
    server = {
        "name": "preflight",
        "host": body.host,
        "port": body.port,
        "user": body.user,
        "password": body.password,
        "private_key": body.private_key,
        "passphrase": body.passphrase,
        "strict_host_key": body.strict_host_key,
    }
    try:
        from geny_executor.tools._ssh import ssh_test_connection

        result = await ssh_test_connection(server, connect_timeout=15.0)
    except Exception as exc:  # noqa: BLE001 — never leak a stack to the client
        logger.debug("ssh test failed to run", exc_info=True)
        return SSHTestResponse(success=False, error=f"{type(exc).__name__}: {exc}")

    return SSHTestResponse(
        success=bool(result.get("success")),
        latency_ms=result.get("latency_ms"),
        error=result.get("error"),
    )
