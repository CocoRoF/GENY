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
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
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
