"""LLM backend health + Claude Code login + Copilot CLI status routes.

Phase E4 of the LLM backend upgrade cycle. The frontend uses these
endpoints to:

  * Render a "backend health" card per provider on Settings → LLM
    Backends.
  * Surface a *real* login flow for Claude Code: the API key path
    (parity with Anthropic) and the subscription path (run
    ``claude auth login`` in a terminal). The endpoint also reports
    the binary version, which auth mode is active, and whether a
    quick smoke test passed.
  * Same for ``gh copilot``: detect binary, ``gh auth status``,
    extension installed yes/no.
  * List the registered sub-agent types so the frontend's catalog
    page can render them without re-walking the registry.

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
from service.config.sub_config.general.api_config import APIConfig
from service.config.sub_config.general.cli_backends_config import (
    CLIBackendClaudeCodeConfig,
    CLIBackendCopilotConfig,
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
    detail: Optional[str] = None
    binary_path: Optional[str] = None
    binary_version: Optional[str] = None
    auth_ok: Optional[bool] = None
    auth_method: Optional[str] = None    # "api_key" | "subscription" | "extension"
    install_help: Optional[str] = None


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
    "copilot_cli": "GitHub Copilot (CLI)",
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


async def _check_anthropic(bundle) -> ProviderHealth:
    creds = bundle.get("anthropic")
    have = bool(creds.api_key)
    return ProviderHealth(
        provider="anthropic",
        label=PROVIDER_LABELS["anthropic"],
        kind="api",
        available=have,
        detail=("ANTHROPIC_API_KEY configured." if have else "No API key set."),
        auth_method="api_key" if have else None,
        auth_ok=have or None,
    )


async def _check_openai(bundle) -> ProviderHealth:
    creds = bundle.get("openai")
    have = bool(creds.api_key)
    return ProviderHealth(
        provider="openai",
        label=PROVIDER_LABELS["openai"],
        kind="api",
        available=have,
        detail=("OPENAI_API_KEY configured." if have else "No API key set."),
        auth_method="api_key" if have else None,
        auth_ok=have or None,
    )


async def _check_google(bundle) -> ProviderHealth:
    creds = bundle.get("google")
    have = bool(creds.api_key)
    return ProviderHealth(
        provider="google",
        label=PROVIDER_LABELS["google"],
        kind="api",
        available=have,
        detail=("GOOGLE_API_KEY configured." if have else "No API key set."),
        auth_method="api_key" if have else None,
        auth_ok=have or None,
    )


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
            else "Set base_url in API settings to enable vLLM."
        ),
        auth_method=None,
        auth_ok=have_url or None,
    )


async def _check_claude_code(bundle, claude_cfg: CLIBackendClaudeCodeConfig) -> ProviderHealth:
    """Probe the Claude Code CLI: binary, --version, and a non-mutating
    'auth' inspection. Auth methods:
      - api_key   : ANTHROPIC_API_KEY in the env (or in the config)
      - subscription : ``claude auth status`` reports an active session
      - none      : neither path is available; user must log in or paste a key
    """
    label = PROVIDER_LABELS["claude_code_cli"]
    install_help = (
        "Install Claude Code (https://docs.anthropic.com/claude/code/) and ensure "
        "`claude` is on PATH. Then either paste ANTHROPIC_API_KEY in settings or "
        "run `claude auth login` in a terminal."
    )
    if not claude_cfg.enabled:
        return ProviderHealth(
            provider="claude_code_cli",
            label=label,
            kind="cli",
            available=False,
            detail="Claude Code backend disabled in settings.",
            install_help=install_help,
        )
    binary = _detect("claude", claude_cfg.binary_path or os.environ.get("CLAUDE_CODE_BINARY", ""))
    if not binary:
        return ProviderHealth(
            provider="claude_code_cli",
            label=label,
            kind="cli",
            available=False,
            detail="claude binary not found on PATH.",
            install_help=install_help,
        )

    # --version is fast and side-effect-free.
    version = None
    rc, out, _err = await _run_cmd([binary, "--version"], timeout=4.0)
    if rc == 0 and out:
        version = out.splitlines()[0].strip()

    # Auth detection. Prefer the explicit API key path; if absent, look
    # for an active subscription by asking the CLI itself.
    bundle_creds = bundle.get("claude_code_cli")
    api_key = bundle_creds.api_key or os.environ.get("ANTHROPIC_API_KEY", "")
    auth_method: Optional[str] = None
    auth_ok: Optional[bool] = None

    if api_key:
        auth_method = "api_key"
        auth_ok = True
    else:
        # Try a quick auth status probe. The CLI's exact subcommand
        # surface evolves; we try a couple of conservative forms and
        # never block on long timeouts.
        for probe in (["auth", "status"], ["auth", "whoami"], ["--auth-status"]):
            rc, _o, _e = await _run_cmd([binary, *probe], timeout=3.0)
            if rc == 0:
                auth_method = "subscription"
                auth_ok = True
                break
        if auth_ok is None:
            auth_method = None
            auth_ok = False

    return ProviderHealth(
        provider="claude_code_cli",
        label=label,
        kind="cli",
        available=bool(auth_ok),
        detail=(
            f"binary at {binary}; version={version or 'unknown'}; "
            f"auth={auth_method or 'unauthenticated'}."
        ),
        binary_path=binary,
        binary_version=version,
        auth_method=auth_method,
        auth_ok=auth_ok,
        install_help=install_help if not auth_ok else None,
    )


async def _check_copilot(bundle, copilot_cfg: CLIBackendCopilotConfig) -> ProviderHealth:
    label = PROVIDER_LABELS["copilot_cli"]
    install_help = (
        "Install GitHub CLI (https://cli.github.com/), run `gh auth login`, "
        "then `gh extension install github/gh-copilot`."
    )
    if not copilot_cfg.enabled:
        return ProviderHealth(
            provider="copilot_cli",
            label=label,
            kind="cli",
            available=False,
            detail="Copilot CLI backend disabled in settings.",
            install_help=install_help,
        )
    gh = _detect("gh", copilot_cfg.gh_binary_path or os.environ.get("GH_BINARY", ""))
    if not gh:
        return ProviderHealth(
            provider="copilot_cli",
            label=label,
            kind="cli",
            available=False,
            detail="gh binary not found on PATH.",
            install_help=install_help,
        )
    version = None
    rc, out, _ = await _run_cmd([gh, "--version"], timeout=4.0)
    if rc == 0 and out:
        version = out.splitlines()[0].strip()

    # gh auth status — non-zero means not logged in.
    rc_auth, _, err_auth = await _run_cmd([gh, "auth", "status"], timeout=4.0)
    auth_ok = (rc_auth == 0)

    # Copilot extension probe (best-effort).
    ext_installed = False
    rc_ext, out_ext, _ = await _run_cmd([gh, "extension", "list"], timeout=4.0)
    if rc_ext == 0 and "github/gh-copilot" in out_ext:
        ext_installed = True

    available = bool(auth_ok and ext_installed)
    parts = [f"binary at {gh}"]
    if version:
        parts.append(f"version={version}")
    parts.append(f"auth_ok={auth_ok}")
    parts.append(f"copilot_extension={'installed' if ext_installed else 'missing'}")

    return ProviderHealth(
        provider="copilot_cli",
        label=label,
        kind="cli",
        available=available,
        detail="; ".join(parts),
        binary_path=gh,
        binary_version=version,
        auth_method=("extension" if ext_installed and auth_ok else None),
        auth_ok=(auth_ok and ext_installed),
        install_help=None if available else install_help,
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
    copilot_cfg = cm.load_config(CLIBackendCopilotConfig)

    results = await asyncio.gather(
        _check_anthropic(bundle),
        _check_openai(bundle),
        _check_google(bundle),
        _check_vllm(bundle),
        _check_claude_code(bundle, claude_cfg),
        _check_copilot(bundle, copilot_cfg),
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


@router.post(
    "/cli/copilot/recheck",
    response_model=ProviderHealth,
    dependencies=[Depends(require_auth)],
)
async def recheck_copilot() -> ProviderHealth:
    cm = get_config_manager()
    bundle = CredentialBundleBuilder(cm).build()
    cfg = cm.load_config(CLIBackendCopilotConfig)
    return await _check_copilot(bundle, cfg)


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
    """One in-flight subprocess (``claude auth login`` / ``gh auth login``)
    plus a bounded buffer of stdout/stderr lines for SSE streaming."""

    def __init__(self, kind: str, argv: List[str]) -> None:
        self.kind = kind          # "claude_code" | "copilot"
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


# ── Common job spawn ──────────────────────────────────────────────────


async def _start_auth_job(kind: str, argv: List[str]) -> _AuthJob:
    _reap_old_jobs()
    job = _AuthJob(kind=kind, argv=argv)
    try:
        proc = await asyncio.create_subprocess_exec(
            *argv,
            stdin=asyncio.subprocess.DEVNULL,
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
    """Ping the CLI in --bare mode. Returns ok=True if the CLI exits 0
    and emits any text response. The intent is "is the credential
    file actually usable", not "is the model on form"."""
    binary = _claude_binary()
    started = time.monotonic()
    rc, out, err = await _run_cmd(
        [binary, "--print", "--bare", "--output-format", "json", "ping"],
        timeout=20.0,
    )
    elapsed_ms = int((time.monotonic() - started) * 1000)
    ok = rc == 0 and bool(out.strip())
    return TestConnectionResponse(
        ok=ok,
        duration_ms=elapsed_ms,
        detail=("response received" if ok else f"exit code {rc}"),
        raw_stdout_tail=out[-400:] if out else None,
        raw_stderr_tail=err[-400:] if err else None,
    )


# ── Copilot CLI auth ──────────────────────────────────────────────────


def _gh_binary() -> str:
    binary = shutil.which("gh") or os.environ.get("GH_BINARY", "")
    if not binary or not os.path.exists(binary):
        raise HTTPException(status_code=400, detail="gh CLI not available in this container")
    return binary


@router.get(
    "/cli/copilot/auth/status",
    dependencies=[Depends(require_auth)],
)
async def copilot_auth_status() -> Dict[str, Any]:
    binary = _gh_binary()
    # gh auth status doesn't have --json; we surface text + exit code.
    rc, out, err = await _run_cmd([binary, "auth", "status"], timeout=5.0)
    rc_ext, ext_out, _ = await _run_cmd([binary, "extension", "list"], timeout=5.0)
    extension_installed = (rc_ext == 0 and "github/gh-copilot" in ext_out)
    return {
        "logged_in": rc == 0,
        "auth_status_text": out or err,
        "extension_installed": extension_installed,
    }


@router.post(
    "/cli/copilot/auth/login",
    response_model=AuthLoginStartResponse,
    dependencies=[Depends(require_auth)],
)
async def copilot_auth_login() -> AuthLoginStartResponse:
    binary = _gh_binary()
    # Web-based device flow — gh prints the device code + URL to stderr.
    argv = [binary, "auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web"]
    job = await _start_auth_job("copilot", argv)
    return AuthLoginStartResponse(
        job_id=job.job_id, kind=job.kind, argv=argv,
        hint="gh prints a one-time code + URL. Open the URL in a browser, paste the code, return here.",
    )


@router.post(
    "/cli/copilot/auth/logout",
    dependencies=[Depends(require_auth)],
)
async def copilot_auth_logout() -> Dict[str, Any]:
    binary = _gh_binary()
    rc, out, err = await _run_cmd([binary, "auth", "logout", "--hostname", "github.com"], timeout=10.0)
    return {"ok": rc == 0, "stdout": out, "stderr": err}


@router.post(
    "/cli/copilot/test",
    response_model=TestConnectionResponse,
    dependencies=[Depends(require_auth)],
)
async def copilot_test() -> TestConnectionResponse:
    binary = _gh_binary()
    started = time.monotonic()
    rc, out, err = await _run_cmd([binary, "copilot", "-p", "ping", "--", ""], timeout=20.0)
    elapsed_ms = int((time.monotonic() - started) * 1000)
    ok = rc == 0 and bool(out.strip())
    return TestConnectionResponse(
        ok=ok, duration_ms=elapsed_ms,
        detail=("response received" if ok else f"exit code {rc}"),
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
