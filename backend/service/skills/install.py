"""Build a SkillRegistry + SkillToolProvider for a Geny session.

Two skill sources:

1. **Bundled** (``backend/skills/bundled/``) — first-party, always
   loaded. Reviewed alongside the code, so the security risk is the
   same as adding a built-in tool.
2. **User** (``~/.geny/skills/``) — operator-supplied. Gated by
   ``GENY_ALLOW_USER_SKILLS=1`` because a SKILL.md can spawn
   subprocesses (via the underlying tool list) that the host hasn't
   reviewed.

Returns a registry the agent_session passes through to the executor's
``SkillToolProvider``, which then registers a ``SkillTool`` per skill
under the ``skill__<id>`` name. The frontend slash-command parser
(G7.4) maps ``/<skill-id>`` to the corresponding tool call.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any, List, Optional, Tuple

logger = logging.getLogger(__name__)

USER_SKILLS_DIR_NAME = "skills"
SKILLS_OPT_IN_ENV = "GENY_ALLOW_USER_SKILLS"

# Bundled skills live in <repo>/backend/skills/bundled/. Resolved
# relative to this module so it works regardless of CWD.
_BUNDLED_REL = Path(__file__).resolve().parent.parent.parent / "skills" / "bundled"
BUNDLED_SKILLS_DIR: Path = _BUNDLED_REL


def bundled_skills_dir() -> Path:
    return BUNDLED_SKILLS_DIR


def user_skills_dir() -> Path:
    return Path.home() / ".geny" / USER_SKILLS_DIR_NAME


def _user_skills_opted_in() -> bool:
    """PR-D.2.3 — settings.json:skills.user_skills_enabled wins; legacy
    env var is the fallback for one operator-adoption cycle.

    settings.json explicit ``false`` overrides any env-set ``1`` —
    operators editing settings should win.
    """
    # 1. settings.json:skills.user_skills_enabled (preferred).
    try:
        from geny_executor.settings import get_default_loader
        section = get_default_loader().get_section("skills")
        if isinstance(section, dict) and "user_skills_enabled" in section:
            return bool(section.get("user_skills_enabled"))
    except ImportError:
        pass
    except Exception as exc:  # noqa: BLE001 — never block install on a bad section
        logger.warning("user_skills opt-in: settings.json read failed: %s", exc)

    # 2. Legacy env fallback.
    raw = os.environ.get(SKILLS_OPT_IN_ENV, "").strip().lower()
    if raw in {"1", "true", "yes", "on"}:
        # Hint operator about the migration path. Logged once per call;
        # call site is install_skill_registry which fires once per
        # session build.
        logger.info(
            "user_skills opt-in via %s env (consider migrating to "
            "settings.json:skills.user_skills_enabled)",
            SKILLS_OPT_IN_ENV,
        )
        return True
    return False


def install_skill_registry() -> Tuple[Optional[Any], List[Any]]:
    """Build a populated :class:`SkillRegistry`.

    Three skill sources, in priority order (first-wins on id collision):

    1. **Executor bundled** — the catalog shipped with
       ``geny-executor`` (Phase 10.4 + 10.6: verify / debug /
       lorem-ipsum / stuck / batch / simplify / skillify / loop).
       Always loaded; pinned to whatever version the requirements
       file pulls in.
    2. **Geny bundled** — first-party Geny-specific skills under
       ``backend/skills/bundled/``. Always loaded.
    3. **User** — operator-supplied skills under ``~/.geny/skills/``,
       gated by ``settings.json:skills.user_skills_enabled`` (or the
       legacy ``GENY_ALLOW_USER_SKILLS=1`` env var).

    Returns:
        ``(registry, skills)`` — registry is ``None`` when the executor
        isn't importable or no skills were found. ``skills`` is a list
        of the loaded :class:`Skill` instances (also empty when none).
    """
    try:
        from geny_executor.skills import SkillRegistry, load_skills_dir
    except ImportError:
        logger.debug("install_skill_registry: geny_executor.skills unavailable")
        return None, []

    registry = SkillRegistry()
    loaded: List[Any] = []

    # 1. Executor-bundled — always. New in geny-executor 1.6.x; the
    # import is best-effort so older executors keep working without
    # the catalog (they just don't ship it).
    try:
        from geny_executor.skills import load_bundled_skills

        executor_report = load_bundled_skills(strict=False)
        for skill in executor_report.loaded:
            try:
                registry.register(skill)
                loaded.append(skill)
            except ValueError as exc:
                logger.warning(
                    "install_skill_registry: executor-bundled %s collided: %s",
                    skill.id, exc,
                )
        if executor_report.errors:
            for path, err in executor_report.errors:
                logger.warning(
                    "install_skill_registry: executor-bundled error %s: %s",
                    path, err,
                )
    except ImportError:
        logger.debug(
            "install_skill_registry: executor lacks load_bundled_skills "
            "(pre-1.6.0); skipping executor catalog"
        )

    # 2. Geny-bundled — always.
    if BUNDLED_SKILLS_DIR.exists():
        report = load_skills_dir(BUNDLED_SKILLS_DIR, strict=False)
        for skill in report.loaded:
            try:
                registry.register(skill)
                loaded.append(skill)
            except ValueError as exc:
                logger.warning(
                    "install_skill_registry: Geny-bundled %s collided "
                    "with executor catalog: %s",
                    skill.id, exc,
                )
        if report.errors:
            for path, err in report.errors:
                logger.warning("install_skill_registry: bundled skill error %s: %s", path, err)

    # 3. User — opt-in.
    if _user_skills_opted_in():
        user_dir = user_skills_dir()
        if user_dir.exists():
            report = load_skills_dir(user_dir, strict=False)
            for skill in report.loaded:
                try:
                    registry.register(skill)
                    loaded.append(skill)
                except ValueError as exc:
                    logger.warning(
                        "install_skill_registry: user %s collided with "
                        "an existing skill: %s",
                        skill.id, exc,
                    )
            if report.errors:
                for path, err in report.errors:
                    logger.warning("install_skill_registry: user skill error %s: %s", path, err)
    else:
        logger.debug(
            "install_skill_registry: %s not set — user skills under %s skipped",
            SKILLS_OPT_IN_ENV, user_skills_dir(),
        )

    if loaded:
        # Three-way breakdown for visibility in the boot log.
        executor_count = sum(1 for s in loaded if _is_executor_bundled_skill(s))
        geny_count = sum(1 for s in loaded if _is_bundled_skill(s))
        user_count = len(loaded) - executor_count - geny_count
        logger.info(
            "install_skill_registry: %d skill(s) registered "
            "(%d executor-bundled, %d Geny-bundled, %d user)",
            len(loaded), executor_count, geny_count, user_count,
        )

    return (registry if loaded else None), loaded


def _is_bundled_skill(skill: Any) -> bool:
    """Return True when the skill was loaded from BUNDLED_SKILLS_DIR
    (Geny's first-party bundled tree).

    Skill objects across executor versions store their source path
    either at the top level (``source``) or under metadata
    (``metadata.source``). Try both. Anything under the bundled
    directory counts as bundled; everything else is user.
    """
    source = getattr(skill, "source", None)
    if source is None:
        meta = getattr(skill, "metadata", None)
        if meta is not None:
            source = getattr(meta, "source", None)
    if source is None:
        return False
    try:
        return BUNDLED_SKILLS_DIR in Path(source).parents
    except Exception:
        return False


def _is_executor_bundled_skill(skill: Any) -> bool:
    """Return True when the skill was loaded from the executor's own
    bundled tree (``geny_executor/skills/bundled/``)."""
    source = getattr(skill, "source", None)
    if source is None:
        return False
    try:
        from geny_executor.skills import bundled_skills_dir as exec_bundled_dir

        exec_dir = exec_bundled_dir()
    except Exception:
        return False
    try:
        return exec_dir in Path(source).parents
    except Exception:
        return False


def skill_source_kind(skill: Any) -> str:
    """Classify where a skill came from.

    Returns one of:
      * ``"executor"`` — shipped inside ``geny-executor`` itself
        (the 8-skill bundled catalog).
      * ``"geny"`` — first-party Geny-specific skill under
        ``backend/skills/bundled/``.
      * ``"user"`` — operator-supplied skill under
        ``~/.geny/skills/``.
      * ``"mcp"`` — bridged from an MCP server's prompts (Phase
        10.3 tagged these via ``metadata.extras['source_kind']``).
      * ``"unknown"`` — couldn't classify (very old shape, in-code
        registration via a host plugin, etc.).
    """
    # MCP-bridged skills carry the marker in extras (executor 1.6.0).
    metadata = getattr(skill, "metadata", None)
    extras = getattr(metadata, "extras", None) if metadata is not None else None
    if isinstance(extras, dict) and extras.get("source_kind") == "mcp":
        return "mcp"
    if _is_executor_bundled_skill(skill):
        return "executor"
    if _is_bundled_skill(skill):
        return "geny"
    source = getattr(skill, "source", None)
    if source is not None:
        try:
            if user_skills_dir() in Path(source).parents:
                return "user"
        except Exception:
            pass
    return "unknown"


def list_skills() -> List[dict]:
    """Return a JSON-serialisable summary of every loaded skill.

    Used by the ``/api/skills/list`` endpoint (G7.4) so the frontend
    panel knows which slash commands are available.

    PR-D.3.3 — surface the richer metadata shipped in executor 1.2.0
    (category / effort / examples). Reads ``skill.metadata`` when
    present so older executors that don't have these fields still
    serialise cleanly (every new field defaults to None / []).

    Phase 10 follow-up — adds ``source_kind`` so the SkillsTab UI can
    badge executor-bundled vs Geny-bundled vs user-supplied vs MCP-
    bridged skills distinctly.
    """
    _, skills = install_skill_registry()
    out: List[dict] = []
    for skill in skills:
        metadata = getattr(skill, "metadata", None)
        # metadata fields take priority; flat-attr fallbacks keep
        # very-old skill shapes working.
        def _get(field_name: str, default=None):
            if metadata is not None and hasattr(metadata, field_name):
                return getattr(metadata, field_name)
            return getattr(skill, field_name, default)

        out.append({
            "id": getattr(skill, "id", None),
            "name": _get("name"),
            "description": _get("description"),
            "model": _get("model_override") or getattr(skill, "model", None),
            "allowed_tools": list(_get("allowed_tools", []) or []),
            "category": _get("category"),
            "effort": _get("effort"),
            "examples": list(_get("examples", []) or []),
            "source_kind": skill_source_kind(skill),
        })
    return out


def attach_provider(registry: Any) -> Optional[Any]:
    """Build a :class:`SkillToolProvider` for the given registry.

    Returns ``None`` when the registry is empty or the executor isn't
    importable — callers treat ``None`` as "no provider to register".
    """
    if registry is None:
        return None
    try:
        from geny_executor.skills import SkillToolProvider
    except ImportError:
        return None
    return SkillToolProvider(registry)


async def bridge_mcp_prompts(registry: Any, mcp_manager: Any) -> int:
    """G10.4 — pull every connected MCP server's prompts into ``registry``.

    Each MCP prompt becomes a :class:`Skill` registered under
    ``mcp__<server>__<prompt>`` (the executor's id convention).
    Returns the number of skills added.

    No-op when:
    - the executor's ``mcp_prompts_to_skills`` helper isn't importable,
    - ``registry`` or ``mcp_manager`` is None,
    - no connected server exposes any prompts.
    """
    if registry is None or mcp_manager is None:
        return 0
    try:
        from geny_executor.skills import mcp_prompts_to_skills
    except ImportError:
        return 0

    try:
        skills = await mcp_prompts_to_skills(mcp_manager)
    except Exception as exc:
        logger.warning("bridge_mcp_prompts: helper raised: %s", exc)
        return 0

    added = 0
    for skill in skills:
        try:
            registry.register(skill)
            added += 1
        except Exception as exc:
            logger.warning(
                "bridge_mcp_prompts: failed to register %r: %s",
                getattr(skill, "id", "?"), exc,
            )
    if added:
        logger.info("bridge_mcp_prompts: %d MCP prompt(s) registered as skills", added)
    return added


__all__ = [
    "BUNDLED_SKILLS_DIR",
    "SKILLS_OPT_IN_ENV",
    "USER_SKILLS_DIR_NAME",
    "attach_provider",
    "bundled_skills_dir",
    "install_skill_registry",
    "list_skills",
    "skill_source_kind",
    "user_skills_dir",
]
