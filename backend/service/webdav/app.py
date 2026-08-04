"""
WsgiDAV application assembly for /dav.

The WSGI app is built once at backend startup and mounted under FastAPI
via a2wsgi. Auth is HTTP Basic against per-device app passwords ONLY —
never the account password and never JWTs: a mount credential must be
individually revocable, and no mainstream mount client can send Bearer.

Class 2 (LOCK/UNLOCK) is advertised with an in-memory lock table
(LockStorageDict). That is the industry-standard "pseudo-lock": Finder
refuses to mount read-write and Office opens documents read-only unless
LOCK succeeds, but neither needs locks to persist across a server
restart — a restart just means an idle-timeout'd lock, which clients
re-acquire. (Single-process deployment is already a hard assumption of
the storage layer's per-storage threading.Lock.)
"""
from __future__ import annotations

import logging
from typing import Optional

from wsgidav.dc.base_dc import BaseDomainController
from wsgidav.wsgidav_app import WsgiDAVApp

from service.webdav.provider import (
    AgentDirectory,
    GenyDAVProvider,
    default_agent_resolver,
)

logger = logging.getLogger(__name__)


class AppPasswordDomainController(BaseDomainController):
    """Basic auth → app-password verification.

    wsgidav instantiates this with (wsgidav_app, config). The verify
    callable is injectable via config["geny.verify"] so the protocol
    stack can be tested standalone.
    """

    def __init__(self, wsgidav_app, config):
        super().__init__(wsgidav_app, config)
        self._verify = (config.get("geny") or {}).get("verify")

    def get_domain_realm(self, path_info, environ):
        return "Geny Drive"

    def require_authentication(self, realm, environ):
        return True

    def supports_http_digest_auth(self):
        # Digest would force reversible-equivalent secret storage (HA1).
        # HTTPS-only Basic needs no registry surgery on any client we
        # target, so Digest buys nothing and costs storage soundness.
        return False

    def basic_auth_user(self, realm, user_name, password, environ):
        verify = self._verify
        if verify is None:
            from service.auth.app_password_service import get_app_password_service

            svc = get_app_password_service()
            if svc is None:
                return False
            verify = svc.verify
        try:
            ok = bool(verify(user_name, password))
        except Exception as e:  # noqa: BLE001
            logger.error(f"[dav] auth verification error: {e}")
            return False
        return ok

    def digest_auth_user(self, realm, user_name, environ):
        return False


def build_dav_wsgi_app(
    *,
    resolver=None,
    verify=None,
    mount_path: str = "/dav",
    verbose: int = 1,
):
    """Build the WsgiDAV WSGI callable.

    resolver/verify default to the live backend services; tests pass
    their own to run the full protocol stack against a temp directory
    with no backend at all.
    """
    directory = AgentDirectory(resolver or default_agent_resolver)
    provider = GenyDAVProvider(directory)

    config = {
        "provider_mapping": {"/": provider},
        "http_authenticator": {
            "domain_controller": AppPasswordDomainController,
            "accept_basic": True,
            "accept_digest": False,
            "default_to_digest": False,
        },
        "geny": {"verify": verify},
        # In-memory locks + dead properties: Class 2 for Finder/Office,
        # PROPPATCH for litmus `props`. Single-process by design.
        "lock_storage": True,
        "property_manager": True,
        "mount_path": mount_path,
        # Browsers hitting /dav get a minimal HTML listing — handy for
        # sanity checks; all real traffic is DAV verbs.
        "dir_browser": {"enabled": True, "davmount": False},
        "verbose": verbose,
        # OPTIONS / must succeed for Windows WebClient's root probe.
        "hotfixes": {"emulate_win32_lastmod": False},
    }
    app = WsgiDAVApp(config)
    return _lock_content_type_hotfix(app)


def _lock_content_type_hotfix(app):
    """UPSTREAM BUG SHIM — WsgiDAV 4.3.5, request_server.py:1283.

    The lock-CREATE response hardcodes ``Content-Type: application;
    charset=utf-8`` (the ``/xml`` is missing; the lock-REFRESH path a few
    lines up is correct). litmus' neon — and any strict client — then
    refuses to parse the activelock XML body, which breaks lock discovery
    and, downstream, Finder/Office write flows. Repair the header on LOCK
    responses only; delete this wrapper when upstream ships a fix.
    """

    def fixed(environ, start_response):
        def sr(status, headers, exc_info=None):
            if environ.get("REQUEST_METHOD", "").upper() == "LOCK":
                headers = [
                    (k, "application/xml; charset=utf-8")
                    if k.lower() == "content-type" and v.split(";")[0].strip() == "application"
                    else (k, v)
                    for k, v in headers
                ]
            return start_response(status, headers, exc_info)

        return app(environ, sr)

    return fixed


_dav_app: Optional[WsgiDAVApp] = None


def get_or_build_dav_app() -> WsgiDAVApp:
    global _dav_app
    if _dav_app is None:
        _dav_app = build_dav_wsgi_app()
    return _dav_app
