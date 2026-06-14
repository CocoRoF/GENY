"""
Auth Middleware — FastAPI dependency for requiring authentication.

Usage in controllers:
    from service.auth.auth_middleware import require_auth

    @router.post("/protected")
    async def protected_endpoint(auth: dict = Depends(require_auth)):
        username = auth["sub"]
        ...

Design:
- Extracts JWT from Authorization header or cookie
- Returns decoded payload on success
- Raises HTTPException(401) on failure
- If AuthService is not initialized (no DB), allows all requests (dev fallback)
"""
import logging
import os

from fastapi import Depends, HTTPException, Request, WebSocket

from service.auth.auth_service import get_auth_service

logger = logging.getLogger("auth-middleware")

# Subprotocol marker used to smuggle a JWT through the browser WebSocket
# handshake. Browsers cannot set arbitrary headers on `new WebSocket(...)`,
# but they CAN pass subprotocols: `new WebSocket(url, ['geny-auth', '<jwt>'])`.
# The marker MUST be echoed back via `accept(subprotocol='geny-auth')` or the
# browser handshake fails — see require_ws_auth().
WS_AUTH_SUBPROTOCOL = "geny-auth"

# Custom WebSocket close code for "unauthorized". 4000-4999 is the
# application-private range; 4401 mirrors HTTP 401 for readability.
WS_UNAUTHORIZED_CODE = 4401


def _auth_strict() -> bool:
    """True when GENY_AUTH_STRICT is set to a truthy value.

    When strict AND no AuthService is available (no DB), the WS path REFUSES
    connections instead of silently allowing anonymous access. Default (unset)
    preserves today's behavior exactly — anonymous allowed in no-DB mode.
    """
    return os.getenv("GENY_AUTH_STRICT", "").strip().lower() in ("1", "true", "yes", "on")


async def require_auth(request: Request) -> dict:
    """
    FastAPI dependency that requires a valid JWT token.

    Token sources (checked in order):
    1. Authorization: Bearer <token> header
    2. geny_auth_token cookie

    Returns:
        Decoded JWT payload dict containing 'sub' (username), 'display_name'

    Raises:
        HTTPException(401): If no valid token is found
    """
    auth_service = get_auth_service()

    # If auth service is not available (no DB), allow all requests
    if auth_service is None:
        logger.debug("AuthService not initialized — skipping auth check (no DB mode)")
        return {"sub": "anonymous", "display_name": "Anonymous"}

    token = _extract_token(request)

    if not token:
        raise HTTPException(
            status_code=401,
            detail="Authentication required",
            headers={"WWW-Authenticate": "Bearer"},
        )

    try:
        payload = auth_service.verify_token(token)
        return payload
    except Exception as e:
        error_type = type(e).__name__
        if "ExpiredSignature" in error_type:
            raise HTTPException(
                status_code=401,
                detail="Token expired",
                headers={"WWW-Authenticate": "Bearer"},
            )
        raise HTTPException(
            status_code=401,
            detail="Invalid token",
            headers={"WWW-Authenticate": "Bearer"},
        )


async def optional_auth(request: Request) -> dict | None:
    """
    FastAPI dependency that optionally extracts auth info.
    Returns decoded payload if authenticated, None otherwise.
    Never raises — used for endpoints that behave differently based on auth state.
    """
    auth_service = get_auth_service()
    if auth_service is None:
        return None

    token = _extract_token(request)
    if not token:
        return None

    return auth_service.get_user_from_token(token)


def _extract_token(request: Request) -> str | None:
    """Extract JWT token from request headers or cookies."""
    # 1. Authorization: Bearer <token>
    auth_header = request.headers.get("Authorization")
    if auth_header and auth_header.startswith("Bearer "):
        return auth_header[7:]

    # 2. Cookie: geny_auth_token=<token>
    token = request.cookies.get("geny_auth_token")
    if token:
        return token

    return None


# ================================================================
#  WebSocket authentication
# ================================================================


def _parse_subprotocol_token(websocket: WebSocket) -> str | None:
    """Pull a JWT out of the Sec-WebSocket-Protocol header.

    The browser sends `new WebSocket(url, ['geny-auth', '<jwt>'])`, which
    becomes the request header `Sec-WebSocket-Protocol: geny-auth, <jwt>`.
    We take the element that immediately follows the ``geny-auth`` marker.
    Returns None when the marker is absent or has no following element.
    """
    raw = websocket.headers.get("sec-websocket-protocol")
    if not raw:
        return None

    parts = [p.strip() for p in raw.split(",") if p.strip()]
    for i, part in enumerate(parts):
        if part == WS_AUTH_SUBPROTOCOL:
            if i + 1 < len(parts):
                return parts[i + 1]
            return None
    return None


def _extract_ws_token(websocket: WebSocket) -> str | None:
    """Extract a JWT from a WebSocket handshake, in priority order.

    1. ``Authorization: Bearer <token>`` header — the desktop connector can
       set arbitrary headers, so it uses this directly.
    2. ``Sec-WebSocket-Protocol: geny-auth, <token>`` — browsers cannot set
       arbitrary WS headers but CAN pass subprotocols via
       ``new WebSocket(url, ['geny-auth', '<jwt>'])``. This is the preferred
       browser path: it avoids leaking the token in URLs / proxy logs.
    3. ``?token=<token>`` query param — last-resort fallback for clients that
       can do neither of the above. NOTE: query strings frequently end up in
       access logs / proxy logs / browser history, so this leaks the token;
       prefer the subprotocol path. Kept only for compatibility.
    4. ``geny_auth_token`` cookie — same-origin browser fallback (the cookie
       set by /api/auth/login is sent automatically on same-origin WS).
    """
    # 1. Authorization: Bearer <token>
    auth_header = websocket.headers.get("authorization")
    if auth_header and auth_header.startswith("Bearer "):
        return auth_header[7:]

    # 2. Sec-WebSocket-Protocol: geny-auth, <token>
    sub_token = _parse_subprotocol_token(websocket)
    if sub_token:
        return sub_token

    # 3. ?token=<token>  (log-leak caveat — see docstring)
    qp_token = websocket.query_params.get("token")
    if qp_token:
        return qp_token

    # 4. Cookie: geny_auth_token=<token>
    cookie_token = websocket.cookies.get("geny_auth_token")
    if cookie_token:
        return cookie_token

    return None


class WSAuthResult:
    """Outcome of a WebSocket auth attempt.

    Attributes:
        authorized: True if the connection may proceed.
        payload: Decoded JWT payload (or the anonymous stub) when authorized.
        subprotocol: The subprotocol the endpoint MUST echo back in
            ``websocket.accept(subprotocol=...)``. This is ``'geny-auth'`` only
            when the token arrived via the subprotocol path (otherwise the
            browser handshake would fail); ``None`` for header/query/cookie/
            anonymous paths.
    """

    __slots__ = ("authorized", "payload", "subprotocol")

    def __init__(self, authorized: bool, payload: dict | None, subprotocol: str | None):
        self.authorized = authorized
        self.payload = payload
        self.subprotocol = subprotocol


def _negotiated_subprotocol(websocket: WebSocket) -> str | None:
    """Return 'geny-auth' iff the client offered it, else None.

    The server may only echo a subprotocol the client actually offered. We
    echo ``geny-auth`` whenever it was offered so the browser handshake
    completes — regardless of which source the token finally came from.
    """
    raw = websocket.headers.get("sec-websocket-protocol")
    if not raw:
        return None
    offered = {p.strip() for p in raw.split(",") if p.strip()}
    return WS_AUTH_SUBPROTOCOL if WS_AUTH_SUBPROTOCOL in offered else None


async def require_ws_auth(websocket: WebSocket) -> WSAuthResult:
    """Validate a WebSocket handshake WITHOUT accepting it.

    The caller is responsible for accept()/close() — this keeps subprotocol
    negotiation in the caller's hands. Returns a :class:`WSAuthResult`:

    * ``authorized=True``  → caller should
      ``await websocket.accept(subprotocol=result.subprotocol)`` and proceed.
    * ``authorized=False`` → caller should
      ``await websocket.close(code=4401, reason=...)`` and return.

    Behavior matrix (mirrors require_auth, but WS-aware):
    * AuthService present  → always enforce (valid token required).
    * AuthService absent + GENY_AUTH_STRICT truthy → REFUSE (close 4401).
    * AuthService absent + not strict → allow anonymous (back-compat, the
      same posture require_auth has today).
    """
    auth_service = get_auth_service()

    # No DB / no auth configured.
    if auth_service is None:
        if _auth_strict():
            logger.warning("WS auth: strict mode + no AuthService — refusing connection")
            return WSAuthResult(authorized=False, payload=None, subprotocol=None)
        logger.debug("WS auth: AuthService not initialized — allowing anonymous (no-DB mode)")
        # Still echo the subprotocol if the client offered it, so a browser
        # that already speaks 'geny-auth' completes its handshake.
        return WSAuthResult(
            authorized=True,
            payload={"sub": "anonymous", "display_name": "Anonymous"},
            subprotocol=_negotiated_subprotocol(websocket),
        )

    token = _extract_ws_token(websocket)
    if not token:
        logger.info("WS auth: no token presented — rejecting")
        return WSAuthResult(authorized=False, payload=None, subprotocol=None)

    try:
        payload = auth_service.verify_token(token)
    except Exception as e:
        logger.info("WS auth: token rejected (%s)", type(e).__name__)
        return WSAuthResult(authorized=False, payload=None, subprotocol=None)

    return WSAuthResult(
        authorized=True,
        payload=payload,
        subprotocol=_negotiated_subprotocol(websocket),
    )


async def ws_auth_or_close(websocket: WebSocket) -> WSAuthResult | None:
    """Convenience helper endpoints call at the very top of the handler.

    * On success → returns an authorized :class:`WSAuthResult`. The endpoint
      MUST then call ``await websocket.accept(subprotocol=result.subprotocol)``.
    * On failure → closes the socket with code 4401 and returns ``None``. The
      endpoint should simply ``return`` immediately.

    The socket is NOT accepted here on success, so the caller controls the
    accepted subprotocol echo (required for the browser handshake).
    """
    result = await require_ws_auth(websocket)
    if not result.authorized:
        try:
            await websocket.close(code=WS_UNAUTHORIZED_CODE, reason="Authentication required")
        except Exception:
            # Socket may already be gone; nothing to do.
            pass
        return None
    return result
