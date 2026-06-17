"""Install a HookRunner from ~/.geny/hooks.yaml into a Geny session.

Two gates:

1. ``GENY_ALLOW_HOOKS=1`` env var (the host operator opts in to
   running subprocess hooks at all).
2. ``enabled: true`` in the hooks YAML file (the rule file itself
   says the hooks should fire).

Both default off. Returning ``None`` (no runner) leaves the
pipeline running with no hooks — same shape as a host that has
never seen the executor's hooks subsystem.

The runner instance is session-scoped: each ``_build_pipeline`` call
gets a fresh runner so per-session config edits take effect on the
next session creation, not the next turn of an existing session.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

HOOKS_YAML_NAME = "hooks.yaml"


def _hook_entry_id(event_value: str, entry: Any) -> str:
    """Stable id for one parsed hook entry.

    Matches the FE picker / ``service/env_defaults`` scheme exactly:
    ``"<event>::<command + args joined by space>"``. The executor
    splits the on-disk ``command`` list into ``command`` (head, str) +
    ``args`` (tail, list); we re-join them so a checkbox in the env
    editor maps 1:1 to a hook entry here.
    """
    cmd = getattr(entry, "command", "") or ""
    args = list(getattr(entry, "args", None) or [])
    return f"{event_value}::{' '.join([cmd, *args]).strip()}"


def _filter_config_by_host_selection(
    config: Any, selection: Optional[List[str]]
) -> Any:
    """Narrow a parsed HookConfig's entries by ``host_selections.hooks``.

    Mirrors :func:`service.permission.install._apply_host_selection`:
        ``None`` / ``["*"]`` → keep every entry (wildcard / legacy env).
        ``[]``               → keep none (explicit opt-out).
        literal list         → keep entries whose id is in the list.

    The runner reads ``config.entries`` (dict of event → list); we
    rebuild that dict in place to the kept subset. Ids not present in
    the config are ignored (a manifest may outlive a hook edit).
    """
    if selection is None or selection == ["*"]:
        return config
    entries = getattr(config, "entries", None) or {}
    wanted = set(selection)
    kept_map: Dict[Any, List[Any]] = {}
    total = 0
    kept = 0
    for event_key, event_entries in entries.items():
        event_value = getattr(event_key, "value", str(event_key))
        keep_list: List[Any] = []
        for entry in event_entries:
            total += 1
            if _hook_entry_id(event_value, entry) in wanted:
                keep_list.append(entry)
                kept += 1
        if keep_list:
            kept_map[event_key] = keep_list
    # HookConfig is a *frozen* dataclass — build a new instance rather
    # than mutating in place (fall back to pydantic copy / direct
    # assignment for forward-compat across executor builds).
    new_config = None
    import dataclasses as _dc

    if _dc.is_dataclass(config):
        try:
            new_config = _dc.replace(config, entries=kept_map)
        except Exception:
            new_config = None
    if new_config is None and hasattr(config, "model_copy"):
        try:
            new_config = config.model_copy(update={"entries": kept_map})
        except Exception:
            new_config = None
    if new_config is None:
        try:
            config.entries = kept_map
            new_config = config
        except Exception:
            logger.debug(
                "install_hook_runner: could not rewrite filtered "
                "config.entries; leaving config unfiltered",
                exc_info=True,
            )
            return config
    config = new_config
    if kept != total:
        logger.info(
            "install_hook_runner: host_selection filtered hooks "
            "(kept %d of %d entr%s)",
            kept, total, "y" if total == 1 else "ies",
        )
    return config


def hooks_yaml_path() -> Path:
    """User-scope hooks file path. Convention shared with the
    permissions install — ``~/.geny/`` is the per-user config root."""
    return Path.home() / ".geny" / HOOKS_YAML_NAME


def _build_config_from_settings_section() -> Optional[Any]:
    """settings.json:hooks reader (H.1, cycle 20260426_2 rewrite).

    Returns a parsed :class:`HookConfig` when settings.json declares
    one, ``None`` otherwise. Routes the section through
    ``geny_executor.hooks.parse_hook_config`` so the result is
    type-correct (events as :class:`HookEvent`, entries as
    :class:`HookConfigEntry`) — the prior path returned a
    HookConfig with raw dicts that the runner couldn't dispatch.

    Three issues were fixed in H.1:
      1. ``get_section`` returns the registered Pydantic model
         (:class:`HooksConfigSection`) when the section is registered,
         not a dict. The prior ``isinstance(section, dict)`` check
         short-circuited the modern path.
      2. The fallback constructor path stored raw dicts as
         ``entries`` values; ``HookRunner.fire`` reads them as
         :class:`HookConfigEntry` objects → silent no-op.
      3. ``parse_hook_config`` expects the wrapper shape
         ``{"enabled": ..., "hooks": {event: [...]}}`` while Geny
         persists ``{"enabled": ..., "entries": {EVENT: [...]}}``.
         We rebuild the wrapper here so settings.json keeps the
         (more discoverable) ``entries`` key while the executor sees
         what it expects.
    """
    try:
        from geny_executor.settings import get_default_loader
        from geny_executor.hooks import parse_hook_config
    except ImportError:
        return None

    raw_section = get_default_loader().get_section("hooks")
    if raw_section is None:
        return None

    # ``get_section`` may return a Pydantic model (when the section is
    # registered) or a raw dict (when it isn't). Both have the keys we
    # need; coerce to a dict so the rest of this function is uniform.
    if hasattr(raw_section, "model_dump"):
        section = raw_section.model_dump(exclude_none=True)
    elif isinstance(raw_section, dict):
        section = dict(raw_section)
    else:
        logger.warning(
            "install_hook_runner: unexpected settings.json:hooks shape %r — "
            "ignoring", type(raw_section).__name__,
        )
        return None

    # Translate Geny's on-disk shape into the wrapper
    # ``parse_hook_config`` consumes. Event keys are normalized to
    # lowercase here so legacy uppercase ("PRE_TOOL_USE") records keep
    # working until the controller rewrites them on the next save.
    entries_raw = section.get("entries") or {}
    if not isinstance(entries_raw, dict):
        logger.warning(
            "install_hook_runner: settings.json:hooks.entries must be a "
            "mapping, got %r — ignoring section", type(entries_raw).__name__,
        )
        return None
    hooks_lower: Dict[str, Any] = {}
    for event_name, raw_list in entries_raw.items():
        if not isinstance(event_name, str):
            continue
        hooks_lower[event_name.strip().lower()] = raw_list

    wrapper: Dict[str, Any] = {
        "enabled": bool(section.get("enabled", False)),
        "hooks": hooks_lower,
    }
    audit_log_path = section.get("audit_log_path")
    if audit_log_path:
        wrapper["audit_log_path"] = audit_log_path

    try:
        return parse_hook_config(wrapper, source="settings.json:hooks")
    except Exception as exc:
        logger.warning(
            "install_hook_runner: settings.json:hooks parse failed: %s; "
            "ignoring section", exc,
        )
        return None


def install_hook_runner(
    host_selection: Optional[List[str]] = None,
) -> Optional[Any]:
    """Resolve the env opt-in + config source (settings.json wins) and
    build a HookRunner.

    Args:
        host_selection: The env manifest's ``host_selections.hooks`` list
            (audit 2026-06-17). When a non-wildcard list is supplied, the
            parsed config is narrowed to exactly those hook entries before
            the runner is built — so the per-env hook picker actually
            takes effect instead of being dead UI. ``None``/``["*"]``
            keeps every enabled hook (legacy / wildcard behaviour).

    Returns:
        A :class:`HookRunner` instance when both gates open and the
        config resolves to an enabled state with at least one surviving
        entry; ``None`` otherwise.

    PR-D.2.2 — dual-read priority:
      1. settings.json:hooks section
      2. legacy ~/.geny/hooks.yaml fallback

    Failures (malformed config / unreadable file) are surfaced as a
    single warning + ``None`` return so the session still boots.
    """
    try:
        from geny_executor.hooks import (
            HookRunner,
            hooks_opt_in_from_env,
            load_hooks_config,
        )
    except ImportError:
        logger.debug("install_hook_runner: geny_executor.hooks unavailable; skipping")
        return None

    if not hooks_opt_in_from_env():
        # Quiet — most environments will not set the env var.
        return None

    # 1. settings.json:hooks (preferred).
    config = _build_config_from_settings_section()
    config_source = "settings.json:hooks"
    if config is not None:
        path = hooks_yaml_path()
        if path.exists():
            logger.warning(
                "install_hook_runner: settings.json:hooks wins; legacy "
                "%s still present (consider deleting after migration)",
                path,
            )
    else:
        # 2. Legacy yaml fallback.
        path = hooks_yaml_path()
        try:
            config = load_hooks_config(path)
        except Exception as exc:
            logger.warning(
                "install_hook_runner: failed to load %s: %s — hooks disabled",
                path, exc,
            )
            return None
        config_source = str(path)
        # Hint the operator about the migration path.
        if path.exists():
            logger.info(
                "install_hook_runner: yaml-only (consider migrating to "
                "settings.json via service.settings.migrator)",
            )

    if not getattr(config, "enabled", False):
        logger.debug(
            "install_hook_runner: %s parsed but enabled=false — no runner",
            config_source,
        )
        return None

    # Per-env narrowing (audit 2026-06-17). Applied after the enabled
    # gate so the host-global opt-in still governs whether hooks run at
    # all; the env manifest only narrows *which* enabled hooks fire.
    config = _filter_config_by_host_selection(config, host_selection)
    remaining = sum(
        len(v) for v in (getattr(config, "entries", None) or {}).values()
    )
    if (
        host_selection is not None
        and host_selection != ["*"]
        and remaining == 0
    ):
        logger.info(
            "install_hook_runner: host_selection left 0 hooks for this env "
            "(source=%s) — no runner",
            config_source,
        )
        return None

    runner = HookRunner(config=config)
    logger.info(
        "install_hook_runner: HookRunner active (config=%s, %d event(s))",
        config_source,
        sum(len(v) for v in (config.entries or {}).values()),
    )
    return runner


def attach_kwargs(host_selection: Optional[List[str]] = None) -> dict:
    """Convenience for ``agent_session._build_pipeline``.

    ``host_selection`` is forwarded so the env manifest's
    ``host_selections.hooks`` narrows which hooks fire (audit
    2026-06-17). Returns ``{"hook_runner": runner}`` when a runner was
    built, else ``{}`` so older executor builds without the kwarg keep
    working.
    """
    runner = install_hook_runner(host_selection=host_selection)
    if runner is None:
        return {}
    return {"hook_runner": runner}


__all__ = [
    "HOOKS_YAML_NAME",
    "attach_kwargs",
    "hooks_yaml_path",
    "install_hook_runner",
]
