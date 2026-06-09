"""LLM backend health + Claude Code login routes.

Phase E4 of the LLM backend upgrade cycle. The frontend uses these
endpoints to:

  * Render a "backend health" card per provider on Settings → LLM
    Backends.
  * Surface a *real* login flow for Claude Code: the API key path
    (parity with Anthropic) and the subscription path (run
    ``claude auth login`` in a terminal). The endpoint also reports
    the binary version, which auth mode is active, and whether a
    quick smoke test passed.
  * List the registered sub-agent types so the frontend's catalog
    page can render them without re-walking the registry.

Cycle 20260520 — the ``gh copilot`` CLI routes were removed.
``gh copilot`` is one-shot text-in / text-out with no streaming, no
tool round-trip, and no MCP support, so it could never host Geny's
Sub-Worker delegation or Stage-10 dispatch. See
``service/executor/credentials.py`` module docstring + the matching
removal commit for the full rationale.

All routes are guarded by ``require_auth``.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import time
import uuid
from typing import Any, AsyncIterator, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from service.auth.auth_middleware import require_auth
from service.config import get_config_manager
from service.config.sub_config.general.cli_backends_config import (
    CLIBackendClaudeCodeConfig,
)
from service.executor.credentials import CredentialBundleBuilder


router = APIRouter(prefix="/api/llm-backends", tags=["llm-backends"])


# ---------------------------------------------------------------------------
# Response shapes
# ---------------------------------------------------------------------------


class ProviderHealth(BaseModel):
    provider: str
    label: str
    kind: str                            # "api" | "cli"
    available: bool
    # ``detail`` / ``install_help`` are the English fallback strings — the
    # frontend renders ``detail_code`` + ``detail_params`` through its
    # i18n module first and falls back to these strings only when the
    # code is missing or unknown (handles deploy ordering / unknown
    # backends).
    detail: Optional[str] = None
    detail_code: Optional[str] = None
    detail_params: Optional[Dict[str, str]] = None
    binary_path: Optional[str] = None
    binary_version: Optional[str] = None
    auth_ok: Optional[bool] = None
    auth_method: Optional[str] = None    # "api_key" | "subscription" | "extension"
    install_help: Optional[str] = None
    install_help_code: Optional[str] = None


class BackendsHealthResponse(BaseModel):
    providers: List[ProviderHealth]


class SubagentInfo(BaseModel):
    agent_type: str
    description: str
    provider: Optional[str] = None
    allowed_tools: List[str] = []
    model_override: Optional[str] = None


class SubagentsResponse(BaseModel):
    items: List[SubagentInfo]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


PROVIDER_LABELS: Dict[str, str] = {
    "anthropic": "Anthropic",
    "openai": "OpenAI",
    "google": "Google Gemini",
    "vllm": "vLLM (self-host)",
    "claude_code_cli": "Claude Code (CLI)",
}


async def _run_cmd(argv: List[str], timeout: float = 5.0) -> tuple[int, str, str]:
    """Run a short command (e.g. ``claude --version``) and capture
    stdout/stderr. Returns (returncode, stdout, stderr). On timeout or
    spawn failure returns (-1, "", error_text)."""
    try:
        proc = await asyncio.create_subprocess_exec(
            *argv,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError as e:
        return (-1, "", str(e))
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        return (-1, "", "command timed out")
    return (
        proc.returncode or 0,
        stdout.decode("utf-8", errors="replace").strip(),
        stderr.decode("utf-8", errors="replace").strip(),
    )


def _detect(name: str, override: Optional[str]) -> Optional[str]:
    if override:
        p = override
        if os.path.exists(p) and os.access(p, os.X_OK):
            return p
        return None
    return shutil.which(name)


# ---------------------------------------------------------------------------
# Health checks
# ---------------------------------------------------------------------------


def _api_key_health(provider: str, env_var: str, bundle) -> ProviderHealth:
    creds = bundle.get(provider)
    have = bool(creds.api_key)
    return ProviderHealth(
        provider=provider,
        label=PROVIDER_LABELS[provider],
        kind="api",
        available=have,
        detail=(f"{env_var} configured." if have else "No API key set."),
        detail_code="api.key_configured" if have else "api.key_missing",
        detail_params={"env": env_var},
        auth_method="api_key" if have else None,
        auth_ok=have or None,
    )


async def _check_anthropic(bundle) -> ProviderHealth:
    return _api_key_health("anthropic", "ANTHROPIC_API_KEY", bundle)


async def _check_openai(bundle) -> ProviderHealth:
    return _api_key_health("openai", "OPENAI_API_KEY", bundle)


async def _check_google(bundle) -> ProviderHealth:
    return _api_key_health("google", "GOOGLE_API_KEY", bundle)


async def _check_vllm(bundle) -> ProviderHealth:
    creds = bundle.get("vllm")
    have_url = bool(creds.base_url)
    return ProviderHealth(
        provider="vllm",
        label=PROVIDER_LABELS["vllm"],
        kind="api",
        available=have_url,
        detail=(
            f"base_url={creds.base_url}" if have_url
            else "vLLM base URL not set. Open this card and paste the OpenAI-compatible endpoint."
        ),
        detail_code="vllm.base_url_set" if have_url else "vllm.base_url_missing",
        detail_params={"url": creds.base_url or ""},
        auth_method=None,
        auth_ok=have_url or None,
    )


def _read_claude_oauth_expires_at_ms() -> Optional[int]:
    """Return the OAuth ``expiresAt`` (ms epoch) from the credential
    file the CLI maintains, or ``None`` when the file is missing /
    malformed / uses a different auth method.

    The file lives at ``~/.claude/.credentials.json``. Schema
    (subscription path)::

        {"claudeAiOauth": {
            "accessToken": "...",
            "refreshToken": "...",
            "expiresAt": 1779107407695,
            "subscriptionType": "max",
            ...
        }}
    """
    import json as _json
    from pathlib import Path as _Path
    try:
        creds_path = _Path(os.path.expanduser("~/.claude/.credentials.json"))
        if not creds_path.exists():
            return None
        data = _json.loads(creds_path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return None
    oauth = (data or {}).get("claudeAiOauth") or {}
    raw = oauth.get("expiresAt")
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


async def _check_claude_code(bundle, claude_cfg: CLIBackendClaudeCodeConfig) -> ProviderHealth:
    """Probe the Claude Code CLI: binary, --version, and a non-mutating
    'auth' inspection. Auth methods:
      - api_key   : ANTHROPIC_API_KEY in the env (or in the config)
      - subscription : ``claude auth status`` reports an active session
      - none      : neither path is available; user must log in or paste a key

    Subscription path further validates the OAuth ``expiresAt`` from
    ``~/.claude/.credentials.json``. An expired token gets flagged
    as ``auth_ok=False`` with a Korean re-login hint so the card
    doesn't show "준비됨" (ready) on a stale credential.
    """
    label = PROVIDER_LABELS["claude_code_cli"]
    install_help = (
        "Install Claude Code (https://docs.anthropic.com/claude/code/) and ensure "
        "`claude` is on PATH. Then either paste ANTHROPIC_API_KEY through this "
        "card or run `claude auth login` in the in-modal terminal."
    )
    if not claude_cfg.enabled:
        return ProviderHealth(
            provider="claude_code_cli",
            label=label,
            kind="cli",
            available=False,
            detail="Claude Code backend disabled. Open this card to enable it.",
            detail_code="claude_code.disabled",
            install_help=install_help,
            install_help_code="claude_code.install_help",
        )
    binary = _detect("claude", claude_cfg.binary_path or os.environ.get("CLAUDE_CODE_BINARY", ""))
    if not binary:
        return ProviderHealth(
            provider="claude_code_cli",
            label=label,
            kind="cli",
            available=False,
            detail="`claude` binary not found on PATH.",
            detail_code="claude_code.binary_missing",
            install_help=install_help,
            install_help_code="claude_code.install_help",
        )

    # --version is fast and side-effect-free.
    version = None
    rc, out, _err = await _run_cmd([binary, "--version"], timeout=4.0)
    if rc == 0 and out:
        version = out.splitlines()[0].strip()

    # Auth detection — strictly honour the mode the user picked in the
    # LLM Backends → Claude Code (CLI) modal (persisted as
    # ``claude_cli.auth_mode``). No heuristics, no "guess from what's
    # available": if the user picked OAuth login, the card reflects
    # OAuth even with an API key configured elsewhere; if the user
    # picked api_key, the card reflects api_key even with a logged-in
    # OAuth session present. The previous heuristic-based detection
    # caused the card to disagree with the modal — see PR history
    # (#863 / #864) for the dead ends.
    auth_method: Optional[str] = None
    auth_ok: Optional[bool] = None
    auth_expired = False
    auth_expires_at_ms: Optional[int] = None

    mode = (getattr(claude_cfg, "auth_mode", "") or "host_mount").strip()

    if mode == "api_key":
        # User chose API key explicitly. Only this path forwards
        # ``ANTHROPIC_API_KEY`` to the spawned subprocess.
        api_key = claude_cfg.api_key or os.environ.get("ANTHROPIC_API_KEY", "")
        auth_method = "api_key"
        auth_ok = bool(api_key)
    else:
        # All three subscription-style modes (host_mount /
        # in_modal_login / setup_token) read auth state from the CLI's
        # own credential persistence. Probe + expiry cross-check.
        for probe in (["auth", "status"], ["auth", "whoami"], ["--auth-status"]):
            rc, _o, _e = await _run_cmd([binary, *probe], timeout=3.0)
            if rc == 0:
                auth_method = "subscription"
                auth_ok = True
                break
        if auth_method is None:
            # Mode says "subscription" but the CLI reports nothing.
            # Don't silently fall through to api_key — surface the
            # mismatch so the user knows they need to (re-)login.
            auth_method = "subscription"
            auth_ok = False

        # CLI returns ``loggedIn: true`` whenever the credential file
        # is present, even with an expired access token whose refresh
        # has been failing (the case the user hit on 2026-05-18 —
        # card said "준비됨", every session crashed with stream-json
        # 401). Cross-check ``expiresAt`` against the wall clock.
        if auth_ok:
            auth_expires_at_ms = _read_claude_oauth_expires_at_ms()
            if auth_expires_at_ms is not None:
                now_ms = int(time.time() * 1000)
                if now_ms >= auth_expires_at_ms:
                    auth_ok = False
                    auth_expired = True

    if auth_expired:
        # Render a Korean message identifying the precise next step
        # — point at this very card so the user can re-login without
        # leaving the page.
        from datetime import datetime, timezone
        try:
            expired_at = datetime.fromtimestamp(
                (auth_expires_at_ms or 0) / 1000, timezone.utc,
            ).strftime("%Y-%m-%d %H:%M UTC")
        except Exception:  # noqa: BLE001
            expired_at = "(unknown)"
        detail = (
            f"OAuth 토큰이 만료됐어요 (만료: {expired_at}). "
            f"이 카드의 ‘다시 로그인 / Sign in’ 버튼으로 인증을 갱신해주세요. "
            f"binary={binary}, version={version or 'unknown'}."
        )
        detail_code = "claude_code.auth_expired"
        login_hint = (
            "Subscription token expired. Press this card's "
            "‘Sign in’ button to refresh the OAuth credential."
        )
    elif not auth_ok:
        detail = (
            f"binary at {binary}; version={version or 'unknown'}; "
            f"auth={auth_method or 'unauthenticated'}."
        )
        detail_code = "claude_code.unauthenticated"
        login_hint = install_help
    else:
        detail = (
            f"binary at {binary}; version={version or 'unknown'}; "
            f"auth={auth_method or 'unauthenticated'}."
        )
        detail_code = "claude_code.ready"
        login_hint = None

    return ProviderHealth(
        provider="claude_code_cli",
        label=label,
        kind="cli",
        available=bool(auth_ok),
        detail=detail,
        detail_code=detail_code,
        detail_params={
            "path": binary,
            "version": version or "unknown",
            "auth": auth_method or "unauthenticated",
            # ``detail_params`` is typed as ``Dict[str, str]`` for
            # i18n placeholder substitution; stringify both new
            # entries so pydantic accepts the model.
            "expired": "true" if auth_expired else "false",
            "expires_at_ms": str(auth_expires_at_ms) if auth_expires_at_ms is not None else "",
        },
        binary_path=binary,
        binary_version=version,
        auth_method=auth_method,
        auth_ok=auth_ok,
        install_help=login_hint,
        install_help_code=(
            "claude_code.auth_expired" if auth_expired
            else ("claude_code.install_help" if login_hint else None)
        ),
    )


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("/health", response_model=BackendsHealthResponse, dependencies=[Depends(require_auth)])
async def get_backends_health() -> BackendsHealthResponse:
    """Per-provider health probe. Surfaces what the UI needs to render
    the LLM backends settings card: which providers are usable now,
    what's missing, and how the user can finish the setup."""
    cm = get_config_manager()
    bundle = CredentialBundleBuilder(cm).build()
    claude_cfg = cm.load_config(CLIBackendClaudeCodeConfig)

    results = await asyncio.gather(
        _check_anthropic(bundle),
        _check_openai(bundle),
        _check_google(bundle),
        _check_vllm(bundle),
        _check_claude_code(bundle, claude_cfg),
    )
    return BackendsHealthResponse(providers=list(results))


@router.post(
    "/cli/claude-code/recheck",
    response_model=ProviderHealth,
    dependencies=[Depends(require_auth)],
)
async def recheck_claude_code() -> ProviderHealth:
    """Re-run only the Claude Code CLI health check (cheap; the UI
    calls this after a settings save or after the user reports
    completing ``claude auth login``)."""
    cm = get_config_manager()
    bundle = CredentialBundleBuilder(cm).build()
    cfg = cm.load_config(CLIBackendClaudeCodeConfig)
    return await _check_claude_code(bundle, cfg)


@router.get(
    "/subagents",
    response_model=SubagentsResponse,
    dependencies=[Depends(require_auth)],
)
async def list_subagents() -> SubagentsResponse:
    """List the registered sub-agent types so the frontend's Sub-agent
    Catalog can render them without depending on the manifest."""
    try:
        from service.agent_types import SubagentRegistryBuilder

        reg = SubagentRegistryBuilder().build()
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"failed to build subagent registry: {e}")
    if reg is None:
        return SubagentsResponse(items=[])
    items: List[SubagentInfo] = []
    for at in reg.list_types():
        d = reg.get(at)
        items.append(SubagentInfo(
            agent_type=at,
            description=getattr(d, "description", ""),
            provider=getattr(d, "provider", None),
            allowed_tools=list(getattr(d, "allowed_tools", ()) or ()),
            model_override=getattr(d, "model_override", None),
        ))
    return SubagentsResponse(items=items)


# ---------------------------------------------------------------------------
# Phase G — Interactive auth flows (claude / gh) driven by the modal.
#
# The flow:
#   1. POST /auth/{kind}/login → spawn subprocess, return ``job_id``.
#   2. GET  /auth/{kind}/login/{job_id}/events → SSE stream of stdout/stderr
#                                                 lines. Closes when the
#                                                 subprocess exits.
#   3. POST /auth/{kind}/login/{job_id}/cancel → kill the subprocess.
#
# Jobs are kept in-memory only — the modal is a per-user, per-tab affair
# and we don't need them to survive a backend restart. A reaper drops
# jobs older than 1h or in a terminal state.
# ---------------------------------------------------------------------------


class _AuthJob:
    """One in-flight subprocess (``claude auth login``) plus a bounded
    buffer of stdout/stderr lines for SSE streaming."""

    def __init__(self, kind: str, argv: List[str]) -> None:
        self.kind = kind          # "claude_code"
        self.argv = argv
        self.job_id = uuid.uuid4().hex
        self.started_at = time.time()
        self.proc: Optional[asyncio.subprocess.Process] = None
        self.lines: asyncio.Queue[Optional[Dict[str, Any]]] = asyncio.Queue(maxsize=512)
        self.history: List[Dict[str, Any]] = []
        self.exit_code: Optional[int] = None
        self.finished_at: Optional[float] = None
        self._writer_task: Optional[asyncio.Task] = None

    def is_finished(self) -> bool:
        return self.exit_code is not None

    async def push(self, payload: Dict[str, Any]) -> None:
        self.history.append(payload)
        try:
            self.lines.put_nowait(payload)
        except asyncio.QueueFull:
            # Drop a single intermediate line rather than block the
            # subprocess. The history list still has everything.
            pass


_AUTH_JOBS: Dict[str, _AuthJob] = {}
_AUTH_JOB_RETENTION_S = 60 * 60   # 1h


def _reap_old_jobs() -> None:
    cutoff = time.time() - _AUTH_JOB_RETENTION_S
    for jid, job in list(_AUTH_JOBS.items()):
        if (job.finished_at or job.started_at) < cutoff:
            _AUTH_JOBS.pop(jid, None)


async def _stream_subprocess(job: _AuthJob) -> None:
    """Background coroutine: copy the subprocess's stdout/stderr into the
    job's queue + history, push a final ``exit`` event, drop a sentinel
    so the SSE consumer can close."""
    proc = job.proc
    assert proc is not None

    async def _drain(stream: Optional[asyncio.StreamReader], channel: str) -> None:
        if stream is None:
            return
        while True:
            chunk = await stream.readline()
            if not chunk:
                return
            text = chunk.decode("utf-8", errors="replace").rstrip("\r\n")
            await job.push({"channel": channel, "text": text, "ts": time.time()})

    await asyncio.gather(
        _drain(proc.stdout, "stdout"),
        _drain(proc.stderr, "stderr"),
    )
    rc = await proc.wait()
    job.exit_code = rc
    job.finished_at = time.time()
    await job.push({"channel": "exit", "text": f"exit code {rc}", "ts": time.time(), "exit_code": rc})
    # Sentinel for the SSE generator.
    try:
        job.lines.put_nowait(None)
    except asyncio.QueueFull:
        pass

    # A successful ``claude auth login`` writes the OAuth credentials
    # but does not flip our backend-enabled gate — without that flip the
    # next session create still fails the bundle.has(claude_code_cli)
    # check and returns the misleading "자격증명이 설정되지 않았습니다"
    # error. Promote the enable flag here, and pin ``auth_mode`` to the
    # method the user just completed (modal login) so the health card +
    # subprocess wiring reflect the explicit choice without the user
    # having to also click the radio.
    if job.kind == "claude_code" and rc == 0:
        try:
            from service.config import get_config_manager
            from service.config.sub_config.general.cli_backends_config import (
                CLIBackendClaudeCodeConfig,
            )

            cm = get_config_manager()
            cfg = cm.load_config(CLIBackendClaudeCodeConfig)
            mutated = False
            if not cfg.enabled:
                cfg.enabled = True
                mutated = True
            if getattr(cfg, "auth_mode", "") != "in_modal_login":
                cfg.auth_mode = "in_modal_login"
                mutated = True
            if mutated:
                cm.save_config(cfg)
        except Exception:  # noqa: BLE001
            pass


# ── Common job spawn ──────────────────────────────────────────────────


async def _start_auth_job(kind: str, argv: List[str]) -> _AuthJob:
    _reap_old_jobs()
    job = _AuthJob(kind=kind, argv=argv)
    try:
        # stdin=PIPE so the modal can forward an interactive prompt's
        # response (Claude's "paste your auth code" / gh's "paste device
        # code"). Both CLIs read these from stdin; the previous
        # DEVNULL wiring left the user staring at the URL with no way
        # to finish the flow.
        proc = await asyncio.create_subprocess_exec(
            *argv,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=True,  # killpg-able on cancel
        )
    except FileNotFoundError as e:
        raise HTTPException(status_code=400, detail=f"binary not found: {e}")
    job.proc = proc
    _AUTH_JOBS[job.job_id] = job
    # Kick off the drain task; we don't await it.
    job._writer_task = asyncio.create_task(_stream_subprocess(job))
    return job


# ── Response shapes ───────────────────────────────────────────────────


class AuthStatusResponse(BaseModel):
    raw: Dict[str, Any]                    # claude auth status --json output (verbatim)
    logged_in: Optional[bool] = None
    auth_method: Optional[str] = None
    subscription_type: Optional[str] = None
    email: Optional[str] = None
    org_name: Optional[str] = None


class AuthLoginStartResponse(BaseModel):
    job_id: str
    kind: str
    argv: List[str]
    hint: str


class TestConnectionResponse(BaseModel):
    ok: bool
    duration_ms: int
    detail: str
    raw_stdout_tail: Optional[str] = None
    raw_stderr_tail: Optional[str] = None


# ── Claude Code auth ──────────────────────────────────────────────────


def _claude_binary() -> str:
    binary = shutil.which("claude") or os.environ.get("CLAUDE_CODE_BINARY", "")
    if not binary or not os.path.exists(binary):
        raise HTTPException(status_code=400, detail="claude CLI not available in this container")
    return binary


@router.get(
    "/cli/claude-code/auth/status",
    response_model=AuthStatusResponse,
    dependencies=[Depends(require_auth)],
)
async def claude_code_auth_status() -> AuthStatusResponse:
    binary = _claude_binary()
    rc, out, err = await _run_cmd([binary, "auth", "status", "--json"], timeout=5.0)
    if rc != 0:
        # CLI prints JSON even on "not logged in" usually; if not, surface
        # the stderr as a synthetic record.
        try:
            raw = json.loads(out) if out.strip() else {}
        except Exception:
            raw = {}
        raw.setdefault("loggedIn", False)
        raw.setdefault("error", err.strip()[:300])
        return AuthStatusResponse(raw=raw, logged_in=bool(raw.get("loggedIn")))
    try:
        raw = json.loads(out)
    except json.JSONDecodeError:
        raise HTTPException(status_code=502, detail=f"claude auth status returned non-JSON: {out[:200]}")
    return AuthStatusResponse(
        raw=raw,
        logged_in=bool(raw.get("loggedIn")),
        auth_method=raw.get("authMethod"),
        subscription_type=raw.get("subscriptionType"),
        email=raw.get("email"),
        org_name=raw.get("orgName"),
    )


@router.post(
    "/cli/claude-code/auth/login",
    response_model=AuthLoginStartResponse,
    dependencies=[Depends(require_auth)],
)
async def claude_code_auth_login(
    use_console: bool = False,
    email: Optional[str] = None,
) -> AuthLoginStartResponse:
    """Spawn ``claude auth login`` and return a job id the client can
    follow via SSE. ``use_console=True`` switches to Anthropic Console
    (API-usage billing); default is the Claude.ai subscription flow."""
    binary = _claude_binary()
    argv = [binary, "auth", "login"]
    if use_console:
        argv.append("--console")
    else:
        argv.append("--claudeai")
    if email:
        argv += ["--email", email]
    job = await _start_auth_job("claude_code", argv)
    return AuthLoginStartResponse(
        job_id=job.job_id, kind=job.kind, argv=argv,
        hint=(
            "Subscribe via the URL the CLI prints. The credential lands in "
            "~/.claude/.credentials.json — which the backend mounts RW."
        ),
    )


@router.post(
    "/cli/claude-code/auth/logout",
    dependencies=[Depends(require_auth)],
)
async def claude_code_auth_logout() -> Dict[str, Any]:
    binary = _claude_binary()
    rc, out, err = await _run_cmd([binary, "auth", "logout"], timeout=10.0)
    return {"ok": rc == 0, "stdout": out, "stderr": err}


@router.post(
    "/cli/claude-code/test",
    response_model=TestConnectionResponse,
    dependencies=[Depends(require_auth)],
)
async def claude_code_test() -> TestConnectionResponse:
    """Ping the CLI to confirm credentials are usable.

    Two correctness gates:

      1. ``--bare`` is **only** safe for the API-key auth path. The
         CLI explicitly documents ``--bare`` as "Anthropic auth is
         strictly ANTHROPIC_API_KEY or apiKeyHelper … OAuth and
         keychain are never read." Subscription users who just
         completed OAuth login would otherwise always get
         ``"Not logged in · Please run /login"`` even though the
         credential file is perfectly fine — which is exactly what
         the user hit on 2026-05-19.

      2. ``--print --output-format json`` returns rc=0 even when the
         response envelope carries ``is_error: true`` (e.g. invalid
         credentials, rate limit, model unavailable). Treat that
         envelope as a failure so the UI button reflects the real
         state instead of misleading "exit code 0".

    Auth-method detection: an ANTHROPIC_API_KEY in env (or via the
    bundle) means we're on the API-key path → include ``--bare``.
    Otherwise we're on the subscription OAuth path → drop it.
    """
    binary = _claude_binary()

    use_bare = bool(os.environ.get("ANTHROPIC_API_KEY", "").strip())
    argv = [binary, "--print"]
    if use_bare:
        argv.append("--bare")
    argv += ["--output-format", "json", "ping"]

    started = time.monotonic()
    rc, out, err = await _run_cmd(argv, timeout=20.0)
    elapsed_ms = int((time.monotonic() - started) * 1000)

    is_error_envelope = False
    envelope_msg = ""
    api_error_status: Optional[int] = None
    if out.strip():
        try:
            envelope = json.loads(out)
            if isinstance(envelope, dict) and envelope.get("is_error"):
                is_error_envelope = True
                envelope_msg = str(envelope.get("result") or envelope.get("error") or "").strip()
                api_status_raw = envelope.get("api_error_status")
                if api_status_raw is not None:
                    try:
                        api_error_status = int(api_status_raw)
                    except (TypeError, ValueError):
                        api_error_status = None
        except (ValueError, json.JSONDecodeError):
            pass

    ok = rc == 0 and bool(out.strip()) and not is_error_envelope
    if ok:
        detail = "response received"
    elif is_error_envelope:
        # Surface the CLI's own message — that's what the user
        # needs to act on (e.g. "Not logged in", "rate limit").
        if api_error_status == 401 or "Not logged in" in envelope_msg:
            detail = (
                "인증이 만료되었거나 유효하지 않습니다. "
                "위 ‘구독 로그인 시작’ 버튼으로 다시 로그인하세요. "
                f"(CLI: {envelope_msg or 'auth failed'})"
            )
        else:
            detail = (
                f"CLI 응답에 에러 — {envelope_msg or 'unknown error'}"
                + (f" (HTTP {api_error_status})" if api_error_status else "")
            )
    else:
        detail = f"exit code {rc}"
    return TestConnectionResponse(
        ok=ok,
        duration_ms=elapsed_ms,
        detail=detail,
        raw_stdout_tail=out[-400:] if out else None,
        raw_stderr_tail=err[-400:] if err else None,
    )


# ── Shared SSE stream / cancel for any auth job ──────────────────────


def _job_or_404(job_id: str) -> _AuthJob:
    job = _AUTH_JOBS.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail=f"unknown auth job {job_id}")
    return job


@router.get(
    "/auth/login/{job_id}/events",
    dependencies=[Depends(require_auth)],
)
async def auth_login_events(job_id: str) -> StreamingResponse:
    """Server-Sent Events stream of an auth job's subprocess output.

    Each event is a JSON object: ``{channel, text, ts[, exit_code]}``.
    ``channel`` is ``stdout`` / ``stderr`` / ``exit``. The stream closes
    when the subprocess exits and a final ``exit`` event has been sent.

    The endpoint replays the job's history first so a client that
    connects after the URL was already printed doesn't miss it.
    """
    job = _job_or_404(job_id)

    async def gen() -> AsyncIterator[bytes]:
        # Replay history first.
        for entry in list(job.history):
            yield f"data: {json.dumps(entry)}\n\n".encode("utf-8")
        # Then live-tail until sentinel.
        while True:
            try:
                entry = await asyncio.wait_for(job.lines.get(), timeout=30.0)
            except asyncio.TimeoutError:
                # Heartbeat — keeps the SSE connection alive through proxies.
                yield b": heartbeat\n\n"
                if job.is_finished():
                    return
                continue
            if entry is None:
                return
            yield f"data: {json.dumps(entry)}\n\n".encode("utf-8")

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",   # tell nginx to skip its proxy buffering
        },
    )


@router.post(
    "/auth/login/{job_id}/cancel",
    dependencies=[Depends(require_auth)],
)
async def auth_login_cancel(job_id: str) -> Dict[str, Any]:
    job = _job_or_404(job_id)
    if job.proc is None or job.is_finished():
        return {"ok": True, "already_finished": True}
    proc = job.proc
    try:
        if proc.returncode is None:
            # killpg → kill the new session we started above.
            import signal
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
            except ProcessLookupError:
                pass
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}
    return {"ok": True, "already_finished": False}


class AuthInputRequest(BaseModel):
    """Body for ``POST /auth/login/{job_id}/input``.

    ``text`` is written to the subprocess's stdin verbatim, plus a
    trailing newline (CLI prompts almost universally read line-by-line).
    Set ``append_newline=False`` for the rare prompt that wants raw
    bytes.
    """
    text: str
    append_newline: bool = True


@router.post(
    "/auth/login/{job_id}/input",
    dependencies=[Depends(require_auth)],
)
async def auth_login_input(job_id: str, body: AuthInputRequest) -> Dict[str, Any]:
    """Forward one line of user input to the auth subprocess's stdin.

    ``claude auth login`` and ``gh auth login`` both pause after
    printing the device-code URL, then read the user's auth-code
    response from stdin. The frontend modal posts the user's pasted
    code here; we write it to the CLI and echo it into the job history
    so the live console pane shows what was sent.
    """
    job = _job_or_404(job_id)
    if job.proc is None or job.is_finished():
        raise HTTPException(status_code=409, detail="job already finished")
    stdin = job.proc.stdin
    if stdin is None or stdin.is_closing():
        raise HTTPException(status_code=409, detail="stdin not available")
    payload = body.text + ("\n" if body.append_newline else "")
    try:
        stdin.write(payload.encode("utf-8"))
        await stdin.drain()
    except (BrokenPipeError, ConnectionResetError) as e:
        raise HTTPException(status_code=409, detail=f"stdin write failed: {e}")
    # Echo into job history so the live console shows what was submitted.
    # Mask anything that looks like a token (keep first 12 chars only)
    # so a stray copy/paste doesn't permanently log a long-lived
    # credential into the in-memory history.
    masked = body.text[:12] + ("…" if len(body.text) > 12 else "")
    await job.push({
        "channel": "stdin",
        "text": f"(submitted {len(body.text)} chars: {masked})",
        "ts": time.time(),
    })
    return {"ok": True}


@router.get(
    "/auth/login/{job_id}",
    dependencies=[Depends(require_auth)],
)
async def auth_login_state(job_id: str) -> Dict[str, Any]:
    """Polling fallback for clients that can't use SSE — returns the
    full history snapshot + exit_code if known."""
    job = _job_or_404(job_id)
    return {
        "job_id": job_id,
        "kind": job.kind,
        "argv": job.argv,
        "started_at": job.started_at,
        "finished_at": job.finished_at,
        "exit_code": job.exit_code,
        "history": list(job.history),
    }
