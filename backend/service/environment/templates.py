"""Default environment templates — WORKER + VTUBER seeds.

Mirrors :mod:`service.tool_preset.templates` for the environment layer.
Every session the user creates runs through one of two seed
:class:`EnvironmentManifest` templates — ``template-worker-env`` (task
work) or ``template-vtuber-env`` (conversation). Sub-Worker / solo
Worker / developer / researcher / planner all resolve to the worker
seed; only the VTuber role gets the lightweight vtuber seed.

The seeds are **materialized on disk** at app boot via
:func:`install_environment_templates`. Reasoning (from
``plan/02_default_env_per_role.md``):

- The seeded env is inspectable — users can open the environment
  editor and see what their worker does.
- Edits to the seed env persist in the user's database and are
  picked up on next session create, matching how
  :class:`~service.tool_preset.store.ToolPresetStore` behaves today.
- Matches the user's directive: the default envs are *the envs
  users see in the UI*, not invisible defaults.

The manifests themselves come from the library-owned
:func:`geny_executor.build_manifest` factory (2.2.0) — the canonical
preset → manifest builder. So "what the seed looks like" and "what an
ephemeral session looks like" never diverge, and Geny no longer
hand-mirrors the stage catalogue (the old
``service.executor.default_manifest`` compensation module is gone).
"""

from __future__ import annotations

from typing import TYPE_CHECKING, List, Optional

from geny_executor import EnvironmentManifest, build_manifest, build_manifest_for
from geny_executor import known_manifest_presets as known_presets

from service.environment.service import EnvironmentService

if TYPE_CHECKING:
    from service.tool_loader import ToolLoader

__all__ = [
    "WORKER_ENV_ID",
    "VTUBER_ENV_ID",
    "CLAUDE_CODE_WORKER_ENV_ID",
    "CLAUDE_CODE_VTUBER_ENV_ID",
    "create_worker_env",
    "create_vtuber_env",
    "create_claude_code_worker_env",
    "create_claude_code_vtuber_env",
    "install_environment_templates",
    # Re-export of the library's known_manifest_presets() under the
    # historical Geny name (frontend validation hook).
    "known_presets",
]


WORKER_ENV_ID = "template-worker-env"
VTUBER_ENV_ID = "template-vtuber-env"
# Dedicated Claude Code engine presets — the worker/vtuber stage blueprints
# locked to the ``claude_code_cli`` provider (geny-executor 2.4.0 catalog).
# Distinct from the default worker/vtuber seeds (which use whichever provider
# is *preferred*), so a user can run an API-backed worker AND a Claude-Code
# worker side by side.
CLAUDE_CODE_WORKER_ENV_ID = "template-claude-code-worker-env"
CLAUDE_CODE_VTUBER_ENV_ID = "template-claude-code-vtuber-env"


# Custom tools the VTuber persona should keep access to. Distinct
# from platform-layer builtins (which are identified via
# :data:`_PLATFORM_TOOL_SOURCES` — the file stem under
# ``backend/tools/built_in/*.py``) — this whitelist only controls
# which *custom* (``tools/custom/``) tools make it through. Excludes
# ``browser_*`` on purpose: the conversational persona shouldn't
# spawn a playwright browser on casual questions. Matches
# ``backend/tool_presets/template-vtuber-tools.json``.
_VTUBER_CUSTOM_TOOL_WHITELIST = frozenset(
    {
        "web_search", "news_search", "web_fetch",
        # Blog AI Agent delegation tools — the VTuber delegates to an
        # external blog AI. BLOG_AGENT_DELEGATION_PLAN.md § Phase 4.
        # Sub-Workers are blocked via _WORKER_CUSTOM_TOOL_DENY.
        "blog_agent_delegate",
        "blog_agent_status",
        "blog_agent_cancel",
        "blog_agent_list_posts",
        "blog_agent_get_post",
        # Whiteboard analysis tools — backing the bundled VTuber-only
        # skills `whiteboard-react-to-share` and `whiteboard-voice-notes`.
        # ``whiteboard_describe`` + ``whiteboard_extract_links`` were
        # latent (skills referenced them but they weren't in the roster);
        # ``whiteboard_transcribe`` ships in the voice-notes feature
        # (docs/voice-notes/02_PLAN.md W4) as the retry surface for the
        # auto-transcribe PostCaptureHook from W2.
        "whiteboard_describe",
        "whiteboard_extract_links",
        "whiteboard_transcribe",
    }
)


# Custom tools to *exclude* from the Worker (Sub-Worker / developer /
# researcher / planner) environment. Default Worker env opts into every
# external tool name from the loader; this set lets us subtract specific
# tools that should be VTuber-only without writing per-role whitelists.
#
# BLOG_AGENT_DELEGATION_PLAN.md § Phase 4 / decision #2 — blog_agent_*
# is VTuber-only by default. To enable for Sub-Workers an operator must
# (1) flip BlogAgentConfig.enabled_for_subworkers and (2) regenerate
# the env template (or hand-edit a custom env). The two-step gate is
# intentional: prevents an accidental UI toggle from giving Sub-Workers
# write access to the live blog.
_WORKER_CUSTOM_TOOL_DENY = frozenset(
    {
        "blog_agent_delegate",
        "blog_agent_status",
        "blog_agent_cancel",
        "blog_agent_list_posts",
        "blog_agent_get_post",
    }
)


def _resolve_worker_custom_deny() -> frozenset[str]:
    """Live-read BlogAgentConfig — when ``enabled_for_subworkers=True``
    the deny set becomes empty so Worker env picks up the tools on the
    next env regeneration."""
    try:
        from service.config.manager import get_config_manager
        cfg = get_config_manager().get_config("blog_agent")
        if cfg is not None and getattr(cfg, "enabled_for_subworkers", False):
            return frozenset()
    except Exception:
        pass
    return _WORKER_CUSTOM_TOOL_DENY


# Platform built-in source stems. :class:`ToolLoader` records each
# tool's source file stem in ``_tool_source`` — tools whose stem
# lives in this set are treated as platform-layer and always
# included in both worker and VTuber rosters. Cycle 20260420_8/
# plan/01 dropped the ``geny_`` prefix from tool names (so prefix
# matching no longer works); stem-based identification is stable
# against rename churn. New platform tools added under
# ``backend/tools/built_in/<stem>.py`` are picked up automatically
# as long as *stem* is listed here.
_PLATFORM_TOOL_SOURCES = frozenset({
    "geny_tools",
    "memory_tools",
    "knowledge_tools",
    # Cycle 20260430_2 Stage B/C — progressive memory inspection tools
    # (memory_status / memory_with / memory_event / memory_artifact /
    # memory_distill). Live alongside the existing memory_* family;
    # share the same paired-only / read-only / caller-scoped invariants.
    "memory_inspect_tools",
})


# Legacy prefix heuristic — only used by the fallback code path
# (callers that have not yet switched to the tool_loader-aware
# signature, e.g. older unit tests). Post-rename only ``memory_*``
# and ``knowledge_*`` actually carry prefixes; geny_* built-ins now
# ship un-prefixed. The fallback therefore under-matches — which is
# why callers in production must pass the tool_loader.
_LEGACY_PLATFORM_TOOL_PREFIXES = ("memory_", "knowledge_", "opsidian_")


# Framework-shipped built-in tool selection per role.
#
# Worker seeds get the full set (``["*"]``) — every tool registered in
# ``geny_executor.tools.built_in.BUILT_IN_TOOL_CLASSES``. This covers
# ``Read`` / ``Write`` / ``Edit`` / ``Bash`` / ``Glob`` / ``Grep`` for
# the Sub-Worker file-creation path, plus the meta / planning /
# interaction families. The executor sandboxes every write to
# ``ToolContext.working_dir`` — which :class:`AgentSession` sets to
# the session's ``storage_path`` — so Worker writes land in
# ``backend/storage/<session_id>/``.
#
# VTuber seeds get a curated subset. The persona must not write files
# or run shell — those side-effects stay delegated to its bound
# Sub-Worker via :func:`send_direct_message_internal` (Plan/01) — but
# read-only inspection, multi-turn planning, and direct interaction
# with the user are core to the persona's expressive surface and have
# no side-effects beyond the existing chat / storage_path read-path.
# Concretely:
#
# - ``Read`` / ``Glob`` / ``Grep``: read-only filesystem inspection
#   inside the session's ``storage_path``. Lets the persona consult
#   conversation logs and character-context files directly without a
#   round-trip through the Sub-Worker for a read.
# - ``TodoWrite`` / ``EnterPlanMode`` / ``ExitPlanMode``: structured
#   multi-turn planning. Pure state, no filesystem or network.
# - ``AskUserQuestion``: persona asks the user clarifying questions
#   inline.
# - ``PushNotification``: persona pushes proactive notifications
#   (emergent mood / event signalling) over the existing chat channel.
#
# Write / Edit / Bash / NotebookEdit / WebFetch / WebSearch / Agent /
# MCP / cron / task / messaging / dev / worktree / operator stay off
# — those either touch files, the network, or external systems, and
# the persona's design routes those through the Sub-Worker.
_WORKER_BUILT_IN_TOOL_NAMES: List[str] = ["*"]
_VTUBER_BUILT_IN_TOOL_NAMES: List[str] = [
    # Read-only filesystem inspection
    "Read",
    "Glob",
    "Grep",
    # Multi-turn planning
    "TodoWrite",
    "EnterPlanMode",
    "ExitPlanMode",
    # Direct user interaction
    "AskUserQuestion",
    "PushNotification",
]


# Platform tools a VTuber persona should *not* see even though they
# live in a :data:`_PLATFORM_TOOL_SOURCES` file. The VTuber already
# has a runtime-bound Sub-Worker (``AgentSession._linked_session_id``).
#
# - ``session_create`` tempts the LLM to mint a spurious new session
#   when it reads "## Sub-Worker Agent" literally as a name, routing
#   subsequent DMs to the wrong target.
# - ``session_list`` / ``session_info`` are address-discovery primitives
#   the VTuber shouldn't need; they exist for Sub-Worker use cases.
#   Exposing them invites the LLM to treat VTuber↔Sub-Worker DMing as
#   a discovery problem ("let me list sessions first…") instead of a
#   one-shot call to ``send_direct_message_internal``.
# - ``send_direct_message_external`` is the addressed DM variant; the
#   VTuber should *never* need to address anyone other than its own
#   counterpart. Leaving it on the VTuber's tool surface was the root
#   cause of the 01:15:28 → 01:15:37 trial-and-error log in cycle
#   20260420_8 (see analysis/01).
#
# Sub-Workers retain all of these.
_VTUBER_PLATFORM_DENY = frozenset({
    "session_create",
    "session_list",
    "session_info",
    "send_direct_message_external",
})


def _vtuber_tool_roster(
    all_tool_names: List[str],
    tool_loader: Optional["ToolLoader"] = None,
) -> List[str]:
    """Filter *all_tool_names* down to the set the VTuber should see.

    A tool lands in the roster when either:

    1. Its source stem is in :data:`_PLATFORM_TOOL_SOURCES` and its
       name is not in :data:`_VTUBER_PLATFORM_DENY`, **or**
    2. Its name is in :data:`_VTUBER_CUSTOM_TOOL_WHITELIST`.

    Anything else — notably ``browser_*`` — is excluded.

    *tool_loader* supplies the source-stem lookup
    (:meth:`ToolLoader.get_tool_source`). When omitted (test callers
    that do not have a loader around), the filter falls back to a
    legacy prefix heuristic that only catches ``memory_*`` /
    ``knowledge_*`` — correct for those tools but incomplete for the
    post-rename geny built-ins. Production call sites (boot path in
    ``main.py``) must pass the loader.

    Order is preserved from the input so the manifest's external
    list is stable across boots (helps diff-based review of the
    written ``.json`` seed).
    """
    if tool_loader is not None:
        def _is_platform(name: str) -> bool:
            return tool_loader.get_tool_source(name) in _PLATFORM_TOOL_SOURCES
    else:
        def _is_platform(name: str) -> bool:
            return name.startswith(_LEGACY_PLATFORM_TOOL_PREFIXES)

    return [
        name
        for name in all_tool_names
        if (_is_platform(name) and name not in _VTUBER_PLATFORM_DENY)
        or name in _VTUBER_CUSTOM_TOOL_WHITELIST
    ]


def create_worker_env(
    external_tool_names: Optional[List[str]] = None,
    *,
    provider: Optional[str] = None,
) -> EnvironmentManifest:
    """Default worker environment manifest.

    Uses the ``worker_adaptive`` stage chain — adaptive loop with
    ``binary_classify`` evaluation, ``aggressive_cache``, and
    ``max_turns=30``. Binds to every provider-backed tool supplied
    via *external_tool_names* — both Geny platform builtins
    (``geny_*``, ``memory_*``, ``knowledge_*``, ``opsidian_*``) and
    custom tools. The executor's manifest loader only registers
    names listed in ``.external``, so callers must pass the full
    union (not just the custom slice) to get platform tools into
    the session's tool registry.

    Worker seeds additionally opt into every framework built-in tool
    (:data:`_WORKER_BUILT_IN_TOOL_NAMES` = ``["*"]``). This gives
    Sub-Workers ``Write`` / ``Read`` / ``Edit`` / ``Bash`` / ``Glob`` /
    ``Grep`` — required to actually create files in the session's
    ``storage_path`` instead of falling back to ``memory_write``.

    The ``model`` block is left empty — session creation fills it in
    via :class:`PipelineConfig` based on the user's LLM settings.

    External tool names are filtered through :func:`_resolve_worker_custom_deny`
    so VTuber-only custom tools (e.g. ``blog_agent_*``) never land in the
    Sub-Worker tool roster unless the operator explicitly opts in via
    ``BlogAgentConfig.enabled_for_subworkers``. See
    BLOG_AGENT_DELEGATION_PLAN.md § Phase 4.
    """
    deny = _resolve_worker_custom_deny()
    filtered = [n for n in (external_tool_names or []) if n not in deny]
    manifest = build_manifest(
        "worker_adaptive",
        # build_manifest requires an explicit provider; keep Geny's
        # historical "anthropic" last-resort default for callers that
        # pass None (the install path resolves the real one).
        provider=provider or "anthropic",
        external_tools=filtered,
        built_in_tools=list(_WORKER_BUILT_IN_TOOL_NAMES),
    )
    manifest.metadata.id = WORKER_ENV_ID
    manifest.metadata.name = "Worker Environment"
    manifest.metadata.description = (
        "Default environment for worker / developer / researcher / "
        "planner roles. Adaptive loop with binary_classify evaluator."
    )
    return manifest


def create_vtuber_env(
    all_tool_names: Optional[List[str]] = None,
    tool_loader: Optional["ToolLoader"] = None,
    *,
    provider: Optional[str] = None,
) -> EnvironmentManifest:
    """Default VTuber environment manifest.

    Uses the ``vtuber`` stage chain — Stage 8 (Think) ships
    ``active=False`` (host can opt the persona into Extended Thinking),
    ``system_cache``, ``signal_based`` evaluation, ``max_turns=10``.

    *all_tool_names* is the full roster the boot-time
    :class:`ToolLoader` knows about (builtin + custom). The VTuber
    filter (:func:`_vtuber_tool_roster`) narrows that to platform-
    layer tools plus the three conversational web tools. When
    *all_tool_names* is omitted (e.g. tests) the factory falls back
    to the legacy three-web-tool roster, preserving prior
    behaviour for any caller that hasn't yet switched to the new
    signature.

    *tool_loader* is the same :class:`ToolLoader` instance that
    produced *all_tool_names*. Passing it enables stem-based platform
    identification (:data:`_PLATFORM_TOOL_SOURCES`). When omitted,
    the filter falls back to the legacy prefix heuristic — correct
    for ``memory_*`` / ``knowledge_*`` but blind to the post-rename
    ``geny_tools`` built-ins. Production call sites must pass it.

    Platform tools (``send_direct_message_internal`` etc.) must
    reach the VTuber: without them the VTuber cannot DM its
    Sub-Worker, read its inbox, store memories, or consult curated
    knowledge — every piece of functionality the VTuber↔Sub-Worker
    delegation relies on.
    """
    if all_tool_names:
        external = _vtuber_tool_roster(all_tool_names, tool_loader=tool_loader)
    else:
        external = ["web_search", "news_search", "web_fetch"]

    manifest = build_manifest(
        "vtuber",
        provider=provider or "anthropic",
        external_tools=external,
        built_in_tools=list(_VTUBER_BUILT_IN_TOOL_NAMES),
    )
    manifest.metadata.id = VTUBER_ENV_ID
    manifest.metadata.name = "VTuber Environment"
    manifest.metadata.description = (
        "Lightweight conversational environment for the VTuber persona."
    )
    _declare_owned_subagent(manifest)
    return manifest


def _declare_owned_subagent(
    manifest: "EnvironmentManifest", *, agent_type: str = "worker"
) -> None:
    """Declare that an agent running this env OWNS a persistent sub-agent.

    Cutover (2026-06-18): owning a geny-executor persistent sub-agent is no
    longer hardcoded to ``role==VTUBER`` — it is an ENVIRONMENT capability.
    The session manager reads ``host_selections.extras['owned_subagent']``
    and spawns the declared sub-agent for ANY agent on this env. A VTuber is
    then just "an agent on a vtuber env + an avatar". Stored in the generic
    ``extras`` map (executor 2.6.0), same pattern as the trigger binding.
    """
    try:
        extras = manifest.host_selections.extras
        if extras.get("owned_subagent") is None:
            extras["owned_subagent"] = {"type": agent_type}
    except Exception:  # noqa: BLE001 — never fail template build on this
        pass


def create_claude_code_worker_env(
    external_tool_names: Optional[List[str]] = None,
) -> EnvironmentManifest:
    """Worker environment backed by the Claude Code CLI provider.

    Same ``worker_adaptive`` stage blueprint + tool roster as
    :func:`create_worker_env`, but the provider is locked to
    ``claude_code_cli`` by the geny-executor catalog
    (``claude_code_worker`` preset). Lets a user run a Claude-Code-backed
    worker regardless of which provider is the global default.
    """
    deny = _resolve_worker_custom_deny()
    filtered = [n for n in (external_tool_names or []) if n not in deny]
    manifest = build_manifest_for(
        "claude_code_worker",
        external_tools=filtered,
        built_in_tools=list(_WORKER_BUILT_IN_TOOL_NAMES),
    )
    manifest.metadata.id = CLAUDE_CODE_WORKER_ENV_ID
    manifest.metadata.name = "Claude Code · Worker"
    manifest.metadata.description = (
        "Worker environment backed by the Claude Code CLI (subscription "
        "auth). Same adaptive loop + tools as the default worker, on the "
        "claude_code_cli provider."
    )
    return manifest


def create_claude_code_vtuber_env(
    all_tool_names: Optional[List[str]] = None,
    tool_loader: Optional["ToolLoader"] = None,
) -> EnvironmentManifest:
    """VTuber environment backed by the Claude Code CLI provider.

    Same ``vtuber`` blueprint + narrowed roster as
    :func:`create_vtuber_env`, locked to ``claude_code_cli`` via the
    catalog (``claude_code_vtuber`` preset).
    """
    if all_tool_names:
        external = _vtuber_tool_roster(all_tool_names, tool_loader=tool_loader)
    else:
        external = ["web_search", "news_search", "web_fetch"]
    manifest = build_manifest_for(
        "claude_code_vtuber",
        external_tools=external,
        built_in_tools=list(_VTUBER_BUILT_IN_TOOL_NAMES),
    )
    manifest.metadata.id = CLAUDE_CODE_VTUBER_ENV_ID
    manifest.metadata.name = "Claude Code · VTuber"
    manifest.metadata.description = (
        "Conversational VTuber environment backed by the Claude Code CLI."
    )
    _declare_owned_subagent(manifest)
    return manifest


def _resolve_active_provider() -> str:
    """Pick the Stage-6 provider for the boot-time template reseed.

    Builds the same :class:`geny_executor.CredentialBundle` live
    sessions use and asks the library which configured backend should
    win (``preferred_provider`` — claude_code_cli first, then vendor
    APIs). Never raises: config-unavailable early-boot callers and an
    empty bundle both land on Geny's conservative ``"anthropic"``
    default so ``install_environment_templates`` cannot crash boot.
    """
    try:
        from service.executor.credentials import CredentialBundleBuilder

        provider = CredentialBundleBuilder().build().preferred_provider()
    except Exception:  # noqa: BLE001 — defensive, very early-boot callers
        provider = None
    return provider or "anthropic"


def install_environment_templates(
    service: EnvironmentService,
    *,
    external_tool_names: Optional[List[str]] = None,
    tool_loader: Optional["ToolLoader"] = None,
) -> int:
    """Save default environment manifests to disk, overwriting existing.

    Mirrors :func:`service.tool_preset.templates.install_templates`.
    Called once at app boot after the tool preset templates are
    installed and the :class:`ToolLoader` has enumerated tools — so
    *external_tool_names* should be ``tool_loader.get_all_names()``
    (builtin + custom) for the worker env. Anything that does not
    land in ``manifest.tools.external`` will never reach the
    session's tool registry.

    The two template seed envs (``template-worker-env`` /
    ``template-vtuber-env``) are rewritten every boot from the
    canonical :func:`geny_executor.build_manifest` output. Custom envs —
    any id other than the two template seeds — are never touched.
    This keeps the seeds in lockstep with manifest-builder changes
    (e.g. a new stage added to the default chain) without needing a
    migration framework.

    Returns the number of environment files written (always equal to
    the seed count after the write loop completes).
    """
    all_names = list(external_tool_names or [])
    # Resolve the active backend ONCE per install so both seeds agree
    # on what the user's current default is. This is what makes the
    # boot-time template re-seed reflect "I logged in to Claude Code"
    # without the user having to also create a separate env manually.
    #
    # 2.2.0: the heuristic lives in the library now
    # (CredentialBundle.preferred_provider — same order the old
    # backend_resolver encoded: claude_code_cli, anthropic, openai,
    # google, vllm). ``None`` means "nothing configured"; keep Geny's
    # historical anthropic last-resort so the boot reseed never fails.
    active_provider = _resolve_active_provider()
    seeds: List[EnvironmentManifest] = [
        create_worker_env(external_tool_names=all_names, provider=active_provider),
        create_vtuber_env(
            all_tool_names=all_names,
            tool_loader=tool_loader,
            provider=active_provider,
        ),
        # Dedicated Claude Code engine presets (always claude_code_cli).
        create_claude_code_worker_env(external_tool_names=all_names),
        create_claude_code_vtuber_env(all_tool_names=all_names, tool_loader=tool_loader),
    ]
    for manifest in seeds:
        env_id = manifest.metadata.id
        service._write_manifest(env_id, manifest)
    return len(seeds)
