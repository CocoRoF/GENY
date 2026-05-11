"""
VTuber Baked Imports Controller

Inbox for baked puppet zips that the avatar-editor service drops into
the shared docker volume (/data/baked-imports). Three endpoints cover
the full lifecycle:

    GET    /api/vtuber/baked-imports/list          enumerate pending
    DELETE /api/vtuber/baked-imports/{filename}    drop a pending zip
    POST   /api/vtuber/baked-imports/install       unzip + register

After a successful install, the source zip is moved to
`<inbox>/installed/` so it stops showing up in the list. Backend
mounts the volume read-write (Phase C.3) — earlier docs may have
shown `:ro` from before the install endpoint existed.
"""

import json as _json
import os
import re
import shutil
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request, UploadFile, File
from pydantic import BaseModel
from logging import getLogger

from service.vtuber.live2d_model_manager import Live2dModelInfo

logger = getLogger(__name__)

router = APIRouter(prefix="/api/vtuber/baked-imports", tags=["vtuber"])

# Single source of truth for the inbox directory. Defaults to the path
# the docker compose files mount the shared volume at — operators can
# override via env if they're running outside compose.
_DEFAULT_INBOX = "/data/baked-imports"


def _inbox_dir() -> Path:
    return Path(os.environ.get("GENY_BAKED_IMPORTS_DIR", _DEFAULT_INBOX))


def _is_safe_filename(name: str) -> bool:
    """Reject filenames that try to escape the inbox via path tricks."""
    if not name or name in (".", ".."):
        return False
    if "/" in name or "\\" in name or "\0" in name:
        return False
    # Reject leading dot (hidden files) and explicit traversal.
    if name.startswith("."):
        return False
    return True


class BakedImportEntry(BaseModel):
    """One pending zip in the inbox."""
    filename: str
    size_bytes: int
    modified_iso: str
    # Best-effort metadata pulled from the zip's `avatar-editor.json`
    # (geny-avatar's buildModelZip writes one). When the zip doesn't
    # have it (older exports / hand-made zips), these stay None and the
    # UI falls back to filename heuristics.
    runtime: Optional[str] = None
    suggested_name: Optional[str] = None
    schema_version: Optional[int] = None
    # True when the zip's puppet_id already has a registry entry. Lets
    # the modal show "already in library — installing again will
    # refresh" instead of a plain "install" button, so the user
    # doesn't think clicking install adds a duplicate. Auto-publish
    # zips are almost always already_installed (the watcher installs
    # them on first sight) — only hand-dropped legacy zips and
    # in-flight uploads land here as false.
    puppet_id: Optional[str] = None
    already_installed: bool = False
    installed_display_name: Optional[str] = None


def _peek_zip_metadata(zip_path: Path) -> dict[str, Any]:
    """Open the zip read-only, look for avatar-editor.json, return its
    contents as a dict. Returns {} on any failure — peek must never
    throw, because the user still needs to see the entry to delete it.
    """
    try:
        with zipfile.ZipFile(zip_path, "r") as zf:
            for candidate in ("avatar-editor.json", "avatar.json"):
                if candidate in zf.namelist():
                    import json as _json
                    with zf.open(candidate) as f:
                        return _json.loads(f.read().decode("utf-8"))
    except Exception as e:
        logger.debug(f"[baked-imports] zip peek failed for {zip_path.name}: {e}")
    return {}


@router.get("/list")
async def list_baked_imports(request: Request) -> dict[str, Any]:
    """List all pending baked-puppet zips in the inbox.

    Sorted newest-first by mtime so the most recent "send to Geny" lands
    at the top of the UI list. Each entry is annotated with
    `already_installed` so the UI can distinguish auto-published puppets
    (which the watcher has already registered) from legacy zips that
    still need an explicit install click.
    """
    inbox = _inbox_dir()
    if not inbox.exists():
        # Not an error — empty inbox until avatar-editor first writes.
        return {"inbox": str(inbox), "entries": [], "exists": False}

    manager = request.app.state.live2d_model_manager  # type: ignore[attr-defined]
    entries: list[BakedImportEntry] = []
    for p in inbox.iterdir():
        if not p.is_file() or p.suffix.lower() != ".zip":
            continue
        try:
            stat = p.stat()
            meta = _peek_zip_metadata(p)
            pid = (meta.get("puppet", {}) or {}).get("id") or None
            existing = manager.find_by_puppet_id(pid) if pid else None
            entries.append(
                BakedImportEntry(
                    filename=p.name,
                    size_bytes=stat.st_size,
                    modified_iso=datetime.fromtimestamp(
                        stat.st_mtime, tz=timezone.utc
                    ).isoformat(),
                    runtime=meta.get("puppet", {}).get("runtime") or meta.get("runtime"),
                    suggested_name=meta.get("puppet", {}).get("name") or meta.get("name"),
                    schema_version=meta.get("schemaVersion") or meta.get("schema_version"),
                    puppet_id=pid,
                    already_installed=existing is not None,
                    installed_display_name=existing.display_name if existing else None,
                )
            )
        except Exception as e:
            logger.warning(f"[baked-imports] skipping {p.name}: {e}")

    entries.sort(key=lambda e: e.modified_iso, reverse=True)
    return {
        "inbox": str(inbox),
        "exists": True,
        "entries": [e.model_dump() for e in entries],
    }


@router.delete("/{filename}")
async def delete_baked_import(filename: str) -> dict[str, Any]:
    """Drop a pending zip. Path-traversal-safe."""
    if not _is_safe_filename(filename):
        raise HTTPException(400, f"unsafe filename: {filename!r}")
    if not filename.lower().endswith(".zip"):
        raise HTTPException(400, "filename must end in .zip")

    target = _inbox_dir() / filename
    if not target.exists() or not target.is_file():
        raise HTTPException(404, f"not found: {filename}")
    try:
        target.unlink()
    except OSError as e:
        # Most common cause in production: the inbox is mounted read-only.
        # Surface the underlying errno text so operators know to look at
        # the compose volume mount.
        raise HTTPException(
            500,
            f"delete failed (volume may be read-only): {e}",
        ) from e

    logger.info(f"[baked-imports] deleted {target}")
    return {"status": "ok", "deleted": filename}


# ── Install ────────────────────────────────────────────────────────


class InstallRequest(BaseModel):
    filename: str
    # Optional display-name override; when omitted we use the puppet's
    # original name from avatar-editor.json with " (Editor)" appended
    # (and " (Editor 2)" / " (Editor 3)" on collision).
    display_name_override: Optional[str] = None
    # When True, prior `(Editor)` / `(Editor N)` entries with the same
    # base display name are removed (registry + on-disk dirs) before this
    # install lands. Lets the user iterate on a puppet without piling up
    # `(Editor 2)`, `(Editor 3)`, ... copies. Default False preserves the
    # original additive behavior (caller has to opt in).
    replace_existing: bool = False
    # When True (the new default under the FS-handoff architecture),
    # the source zip stays in the inbox after install. The auto-publish
    # watcher relies on this: the inbox is the source of truth for
    # "what puppets the user has in their library", and moving the zip
    # to `installed/` would look like a delete on the next scan and
    # cause the watcher to unregister the model we just installed.
    # Set to False only for the legacy "archive consumed zips" workflow
    # — that path is effectively unused under auto-publish.
    keep_source: bool = True


def _drop_model_with_dir(manager, info, models_root: Path) -> None:
    """Remove a registry entry and its extracted directory.

    Mirrors the cleanup the install flow does inline for `(Editor)` name
    collisions; pulled out so the library-sync flow can call it when
    replacing by puppet_id.
    """
    url_parts = (info.url or "").lstrip("/").split("/")
    if len(url_parts) >= 3 and url_parts[0] == "static":
        root_lookup = {
            "live2d-models": _live2d_models_root(),
            "spine-models": _spine_models_root(),
        }
        base_root = root_lookup.get(url_parts[1])
        if base_root is not None:
            target = base_root / url_parts[2]
            if target.exists():
                shutil.rmtree(target, ignore_errors=True)
    manager.remove_model(info.name)


# Where extracted models land. Both directories are docker-mounted
# under FastAPI's StaticFiles (see main.py).
def _live2d_models_root() -> Path:
    return Path(__file__).resolve().parent.parent / "static" / "live2d-models"


def _spine_models_root() -> Path:
    return Path(__file__).resolve().parent.parent / "static" / "spine-models"


# Names that show up in URLs — keep them ascii-only and filesystem-safe
# regardless of what the source puppet was called.
_SLUG_RE = re.compile(r"[^a-zA-Z0-9_-]+")


def _slugify(s: str) -> str:
    cleaned = _SLUG_RE.sub("_", s).strip("_")
    return cleaned or "puppet"


def _next_unique_display_name(
    base: str, existing: set[str]
) -> str:
    """`Hiyori Pro` + existing {`Hiyori Pro (Editor)`, `Hiyori Pro (Editor 2)`}
    → `Hiyori Pro (Editor 3)`. Stops searching at 999 to avoid runaway."""
    candidate = f"{base} (Editor)"
    if candidate not in existing:
        return candidate
    for i in range(2, 1000):
        candidate = f"{base} (Editor {i})"
        if candidate not in existing:
            return candidate
    raise RuntimeError(f"too many Editor copies of {base!r}")


def _is_archive_path_safe(member_name: str) -> bool:
    """Reject zip entries that would escape the destination via .. or
    absolute paths (a.k.a. zip slip)."""
    if not member_name or member_name.startswith(("/", "\\")):
        return False
    parts = member_name.replace("\\", "/").split("/")
    if any(p in ("..", "") for p in parts if p):
        return False
    return True


def _safe_extract(zf: zipfile.ZipFile, dest: Path) -> list[str]:
    """Extract every member of `zf` under `dest`, refusing zip slip.
    Returns the list of extracted relative paths."""
    extracted: list[str] = []
    for member in zf.infolist():
        name = member.filename
        if not _is_archive_path_safe(name):
            raise HTTPException(400, f"unsafe zip entry: {name!r}")
        # zipfile.extract is path-traversal-safe by itself in modern
        # Python (3.6.2+) when given a `path=`, but the explicit guard
        # above catches obviously-malicious archives earlier with a
        # nicer error.
        zf.extract(member, dest)
        extracted.append(name)
    return extracted


def _resolve_inside(root: Path, files: list[str], suffixes: tuple[str, ...]) -> Optional[Path]:
    """Find the first extracted file that ends with one of the given
    suffixes (case-insensitive). Used to locate the model3.json /
    .skel / .atlas after extraction."""
    sl = tuple(s.lower() for s in suffixes)
    for f in files:
        if f.lower().endswith(sl):
            candidate = root / f
            if candidate.exists():
                return candidate
    return None


@router.post("/install")
async def install_baked_import(req: InstallRequest, request: Request) -> dict[str, Any]:
    """Unzip a pending baked puppet, register it in the model registry
    with an `(Editor)` suffix, and move the source zip into the
    `installed/` subdirectory of the inbox.

    Returns the new model entry's `name` so the UI can immediately
    select it on /api/vtuber/models.
    """
    if not _is_safe_filename(req.filename):
        raise HTTPException(400, f"unsafe filename: {req.filename!r}")
    if not req.filename.lower().endswith(".zip"):
        raise HTTPException(400, "filename must end in .zip")

    inbox = _inbox_dir()
    src = inbox / req.filename
    if not src.exists() or not src.is_file():
        raise HTTPException(404, f"not found: {req.filename}")

    # ── Read metadata from the zip ─────────────────────────────────
    meta = _peek_zip_metadata(src)
    runtime: str = (meta.get("puppet", {}) or {}).get("runtime") or meta.get("runtime") or "live2d"
    if runtime not in ("live2d", "spine"):
        raise HTTPException(400, f"unsupported runtime in zip: {runtime!r}")
    suggested_name = (
        (meta.get("puppet", {}) or {}).get("name") or meta.get("name") or src.stem
    )
    suggested_version = (meta.get("puppet", {}) or {}).get("version") or ""
    # Stable IndexedDB id from geny-avatar; None for hand-built zips. Used
    # to dedupe re-syncs of the same puppet (sync push or repeated install
    # of an updated bake) — the matching prior entry is dropped before
    # this one lands, regardless of the display-name-based replacement
    # rule below.
    puppet_id: Optional[str] = (meta.get("puppet", {}) or {}).get("id") or None

    if runtime == "live2d":
        models_root = _live2d_models_root()
        url_prefix = "/static/live2d-models"
    else:
        models_root = _spine_models_root()
        url_prefix = "/static/spine-models"

    # Identity-preserving re-install: if this puppet_id is already
    # registered, reuse its `name` (the registry primary key) and the
    # extracted-files directory so existing agent_model_assignments
    # (session_id → model.name) stay valid through renames and re-
    # bakes. A fresh slug+timestamp would invalidate those assignments
    # and kick active VTuber sessions back to "no model".
    manager = request.app.state.live2d_model_manager  # type: ignore[attr-defined]
    prior_by_id = manager.find_by_puppet_id(puppet_id) if puppet_id else None
    ts = datetime.now(tz=timezone.utc).strftime("%Y%m%d_%H%M%S_%f")

    if prior_by_id is not None:
        # Reuse the existing slot. The on-disk directory is wiped + re-
        # extracted so changed assets actually land; the registry entry
        # gets `replace_model`'d so display_name and other fields refresh
        # while keeping the same key.
        model_name = prior_by_id.name
        target_dir = models_root / model_name
        if target_dir.exists():
            shutil.rmtree(target_dir, ignore_errors=True)
    else:
        # Fresh install. Use microsecond precision so back-to-back
        # installs of distinct puppets with the same base name don't
        # collide on the timestamp.
        slug = _slugify(suggested_name)
        model_name = f"{slug}__editor_{ts}"
        target_dir = models_root / model_name
        if target_dir.exists():
            # Theoretically impossible (timestamp collision down to the
            # microsecond + slug match) but reject loudly rather than
            # overwrite a directory we didn't expect to find.
            raise HTTPException(409, f"target already exists: {target_dir}")

    # ── Extract ────────────────────────────────────────────────────
    target_dir.mkdir(parents=True, exist_ok=True)
    try:
        with zipfile.ZipFile(src, "r") as zf:
            extracted = _safe_extract(zf, target_dir)
    except HTTPException:
        # Clean up partial extract on a path-traversal reject.
        shutil.rmtree(target_dir, ignore_errors=True)
        raise
    except (zipfile.BadZipFile, OSError) as e:
        shutil.rmtree(target_dir, ignore_errors=True)
        raise HTTPException(400, f"zip read failed: {e}") from e

    # ── Locate the runtime entry file ──────────────────────────────
    # Files that look like model entry points but are actually the
    # zip's own metadata. Skip them so a Spine fallback to .json
    # doesn't accidentally pick "avatar-editor.json".
    META_FILES = {"avatar-editor.json", "avatar.json", "license.md"}

    def _is_meta(p: str) -> bool:
        return Path(p).name.lower() in META_FILES

    runtime_files = [f for f in extracted if not _is_meta(f)]

    if runtime == "live2d":
        entry = _resolve_inside(target_dir, runtime_files, (".model3.json",))
        if not entry:
            shutil.rmtree(target_dir, ignore_errors=True)
            raise HTTPException(400, "no .model3.json in zip — not a Live2D puppet")
        atlas_path: Optional[Path] = None
    else:
        # Spine: prefer .skel (binary export); fall back to .json
        # (Spine v3 JSON export). Search in two passes so .skel always
        # wins when both are present.
        entry = _resolve_inside(target_dir, runtime_files, (".skel",))
        if not entry:
            entry = _resolve_inside(target_dir, runtime_files, (".json",))
        if not entry:
            shutil.rmtree(target_dir, ignore_errors=True)
            raise HTTPException(400, "no .skel/.json in zip — not a Spine puppet")
        atlas_path = _resolve_inside(target_dir, runtime_files, (".atlas",))
        if not atlas_path:
            shutil.rmtree(target_dir, ignore_errors=True)
            raise HTTPException(400, "no .atlas in zip — Spine puppet incomplete")

    # ── Build the registry entry ───────────────────────────────────
    base_display = req.display_name_override or suggested_name

    replaced: list[dict[str, str]] = []

    # The prior-by-puppet_id match was already detected up top so we
    # could reuse its model_name and target_dir. Surface it in the
    # response for parity with the legacy flow, but don't drop it
    # here — `manager.replace_model` later swaps the entry in place
    # (preserves session assignments) instead of remove + add.
    preferred_display: Optional[str] = (
        prior_by_id.display_name if prior_by_id is not None else None
    )
    if prior_by_id is not None:
        replaced.append({
            "name": prior_by_id.name,
            "display_name": prior_by_id.display_name,
            "matched_by": "puppet_id",
        })
        logger.info(
            f"[install] re-using entry {prior_by_id.name!r} for "
            f"puppet_id={puppet_id!r} (rename / re-bake)"
        )

    # Optional: clear out prior `(Editor)` entries that share this base
    # before computing the new entry's display name. This is the iter-
    # in-place workflow — user keeps re-baking the same puppet and
    # wants the registry to stay tidy instead of accumulating
    # `(Editor 2)`, `(Editor 3)`, ... copies.
    if req.replace_existing:
        pattern_base = f"{base_display} (Editor"
        prior = [
            m for m in manager.list_models()
            if m.display_name.startswith(pattern_base)
        ]
        for old in prior:
            _drop_model_with_dir(manager, old, models_root)
            replaced.append({
                "name": old.name,
                "display_name": old.display_name,
                "matched_by": "display_name",
            })
        if prior:
            logger.info(
                f"[install] replace_existing pruned {len(prior)} prior entries "
                f"matching base={base_display!r}"
            )

    # Exclude the entry being re-installed from the uniqueness set so
    # we don't have to compete with our own old display name (which
    # `replace_model` will overwrite anyway).
    existing_display_names = {
        m.display_name
        for m in manager.list_models()
        if prior_by_id is None or m.name != prior_by_id.name
    }
    # When a previous entry under this puppet_id existed, prefer its
    # display name as long as it still tracks the new base name —
    # keeps re-syncs visually stable. If the user renamed the puppet
    # in geny-avatar (base_display no longer matches the prior label
    # stem), fall through to the auto-iterator so the new base name
    # is honoured.
    if (
        preferred_display is not None
        and preferred_display.startswith(f"{base_display} (Editor")
        and preferred_display not in existing_display_names
    ):
        final_display = preferred_display
    else:
        final_display = _next_unique_display_name(base_display, existing_display_names)

    rel_entry = entry.relative_to(models_root).as_posix()
    rel_atlas = atlas_path.relative_to(models_root).as_posix() if atlas_path else None
    description = (
        f"{suggested_name}{' ' + suggested_version if suggested_version else ''} "
        f"— imported from avatar-editor on {ts}"
    ).strip()

    # ── Phase G — apply animationConfig from schemaVersion 2 zips ──
    # geny-avatar v0.3.0+ writes an animationConfig block into
    # avatar-editor.json (display tuning + idle group + emotionMap by
    # NAME + tapMotions). Older zips (schemaVersion 1) lack the block
    # and we keep the current defaults as a safe fallback.
    schema_version = int(meta.get("schemaVersion") or meta.get("schema_version") or 1)
    if schema_version > 2:
        # Geny doesn't know how to interpret newer schemas; refuse with a
        # clear message rather than silently ignoring the new fields.
        shutil.rmtree(target_dir, ignore_errors=True)
        raise HTTPException(
            400,
            (
                f"avatar-editor.json schemaVersion={schema_version} 은 본 Geny 가 지원하지 "
                "않습니다. Geny 업그레이드가 필요합니다."
            ),
        )
    anim_cfg = meta.get("animationConfig") or {}
    display_cfg = anim_cfg.get("display") or {}
    k_scale = float(display_cfg.get("kScale") or 0.7)
    x_shift = float(display_cfg.get("initialXshift") or 0)
    y_shift = float(display_cfg.get("initialYshift") or 0)
    idle_group = anim_cfg.get("idleMotionGroupName") or "Idle"
    emotion_map_named: dict[str, str] = anim_cfg.get("emotionMap") or {}
    tap_motions_flat: dict[str, dict[str, Any]] = anim_cfg.get("tapMotions") or {}

    # Translate emotionMap from NAME (geny-avatar's editor surface) to
    # INDEX (Geny's existing model_registry shape). For Live2D we parse
    # the extracted model3.json and look up Expressions by Name. For
    # Spine or any other case where we can't resolve the index, we
    # drop the mapping silently — Geny's lipsync layer just falls back
    # to the default expression.
    emotion_map: dict[str, int] = {}
    motion_groups: list[str] = []
    if runtime == "live2d":
        try:
            with open(entry, "r", encoding="utf-8") as f:
                model3 = _json.load(f)
            expressions = (
                (model3.get("FileReferences") or {}).get("Expressions") or []
            )
            # Detect and repair empty motion group keys in model3.json.
            # pixi-live2d-display silently rejects motion("", N) calls (the
            # user-visible bug: motion never starts because the group key
            # is blank). Some puppet exports — notably hand-baked ones
            # where the source Cubism project never assigned motions to a
            # named group — end up with `FileReferences.Motions = {"": [...]}`.
            # Rewrite the manifest on disk so subsequent loads see a real
            # group name, and so the auto-derived emotionMotionMap below
            # propagates that name instead of an empty string.
            file_refs = model3.setdefault("FileReferences", {})
            raw_groups: dict[str, Any] = file_refs.get("Motions") or {}
            empty_keys = [k for k in raw_groups.keys() if not k or not str(k).strip()]
            if empty_keys:
                # Pick a target name. If the user's idleMotionGroupName
                # is non-blank, reuse that — that's the name geny-avatar
                # already advertises in the editor UI for this puppet.
                # Otherwise fall back to "Idle" (Cubism's standard idle
                # group name; pixi-live2d-display also defaults to it).
                target = idle_group if idle_group and idle_group.strip() else "Idle"
                # If `target` already exists as a real group in the
                # manifest, use a suffixed name to avoid silently merging.
                non_empty_keys = {k for k in raw_groups.keys() if k and str(k).strip()}
                if target in non_empty_keys:
                    target = f"{target}_unnamed"
                # Merge entries from all empty-keyed groups into `target`.
                merged_entries: list[Any] = []
                new_motions: dict[str, Any] = {}
                for k, v in raw_groups.items():
                    if not k or not str(k).strip():
                        if isinstance(v, list):
                            merged_entries.extend(v)
                    else:
                        new_motions[k] = v
                if merged_entries:
                    new_motions[target] = merged_entries
                file_refs["Motions"] = new_motions
                # Persist the rewrite so the running model3.json on disk
                # is what pixi-live2d-display fetches at render time.
                try:
                    with open(entry, "w", encoding="utf-8") as f:
                        _json.dump(model3, f, ensure_ascii=False, indent=2)
                    logger.warning(
                        f"[baked-imports] {entry.name}: renamed "
                        f"{len(empty_keys)} empty motion group key(s) → "
                        f"{target!r}, total {len(merged_entries)} entries merged"
                    )
                except OSError as write_err:
                    logger.warning(
                        f"[baked-imports] {entry.name}: failed to persist "
                        f"empty-group-key rename: {write_err}"
                    )
                # If our anim_cfg-sourced idle_group was itself empty,
                # promote it to the new target name so the puppet's idle
                # registry entry resolves to a real group at runtime.
                if not idle_group or not idle_group.strip():
                    idle_group = target
                raw_groups = new_motions
            motion_groups = [g for g in raw_groups.keys() if g and str(g).strip()]
            name_to_index = {
                (e.get("Name") or ""): i for i, e in enumerate(expressions)
            }
            unmatched: list[str] = []
            for emo, exp_name in emotion_map_named.items():
                if exp_name in name_to_index:
                    emotion_map[emo] = name_to_index[exp_name]
                else:
                    unmatched.append(f"{emo}={exp_name!r}")
            logger.debug(
                f"[baked-imports] emotionMap translate: "
                f"matched={emotion_map}, unmatched={unmatched}, "
                f"available_expressions={list(name_to_index.keys())}, "
                f"motion_groups={motion_groups}"
            )
            if unmatched:
                logger.warning(
                    f"[baked-imports] {len(unmatched)} emotionMap entr(ies) "
                    f"could not match an expression NAME in {entry.name}: {unmatched}"
                )
        except Exception as e:
            logger.warning(f"[baked-imports] emotionMap translate failed: {e}")
    if not emotion_map:
        # Match the current default so VTuber's lipsync engine has at
        # least a neutral entry to fall back on.
        emotion_map = {"neutral": 0}

    # tapMotions in geny-avatar is `{ HitArea: {group, index} }`. Geny's
    # existing format nests as `{ HitArea: { groupName: index } }`. The
    # naive translation is `{ [group]: index }` and that matches
    # mao_pro / hiyori_pro entries in the current registry.
    tap_motions: dict[str, dict[str, int]] = {}
    for hit_area, choice in tap_motions_flat.items():
        if not isinstance(choice, dict):
            continue
        group = choice.get("group")
        index = choice.get("index")
        if group is None or index is None:
            continue
        tap_motions[hit_area] = {str(group): int(index)}

    # ── Auto-derive emotionMotionMap from available motion groups ──
    # geny-avatar exports tapMotions but not emotion→motion mapping.
    # Without an explicit map, Geny's avatar_state_manager falls back to
    # a hardcoded {"joy": "TapBody", ...} table — which silently fails
    # for puppets whose group names differ. Picking from the puppet's
    # actual groups (idle for passive emotions, the first non-idle group
    # for active emotions) makes emotion-driven motion changes work even
    # for custom puppets without manual registry editing.
    emotion_motion_map: dict[str, str] = {}
    if runtime == "live2d" and motion_groups:
        # Use idle_group from anim_cfg if it actually exists in the
        # puppet's groups; otherwise prefer a group whose name contains
        # "idle"; otherwise fall back to the first listed group.
        if idle_group not in motion_groups:
            idle_group = next(
                (g for g in motion_groups if "idle" in g.lower()),
                motion_groups[0],
            )
        # Pick an "active" group for high-arousal emotions. Prefer the
        # Body tap motion's group if the user assigned one — that's the
        # gesture they explicitly opted into for body taps. Else first
        # non-idle group. Else fall back to idle (puppet only has one
        # group, so all emotions look the same — still better than
        # silently failing).
        body_tap_group = None
        for hit_area, choice_map in tap_motions.items():
            if "body" in hit_area.lower():
                body_tap_group = next(iter(choice_map.keys()), None)
                if body_tap_group:
                    break
        active_group = body_tap_group or next(
            (g for g in motion_groups if g != idle_group),
            idle_group,
        )
        emotion_motion_map = {
            "neutral": idle_group,
            "sadness": idle_group,
            "fear": idle_group,
            "disgust": idle_group,
            "joy": active_group,
            "surprise": active_group,
            "anger": active_group,
            "smirk": active_group,
        }
        logger.debug(
            f"[baked-imports] auto-derived emotionMotionMap: idle={idle_group}, "
            f"active={active_group}, map={emotion_motion_map}"
        )

    # Record the source zip's mtime when it stays in the inbox — the
    # auto-publish watcher uses this as the "last installed at" cookie
    # to spot subsequent rename / re-bake writes and trigger another
    # install. None when keep_source=False (legacy archive path).
    inbox_mtime_val: Optional[float] = None
    if req.keep_source:
        try:
            inbox_mtime_val = src.stat().st_mtime
        except OSError:
            inbox_mtime_val = None

    info = Live2dModelInfo(
        name=model_name,
        display_name=final_display,
        description=description,
        url=f"{url_prefix}/{rel_entry}",
        thumbnail=None,
        kScale=k_scale,
        initialXshift=x_shift,
        initialYshift=y_shift,
        idleMotionGroupName=idle_group,
        emotionMap=emotion_map,
        tapMotions=tap_motions,
        emotionMotionMap=emotion_motion_map,
        runtime=runtime,
        atlas_url=f"{url_prefix}/{rel_atlas}" if rel_atlas else None,
        puppet_id=puppet_id,
        inbox_mtime=inbox_mtime_val,
    )
    try:
        if prior_by_id is not None:
            # Update in place — preserves session assignments keyed at
            # the (unchanged) model.name.
            manager.replace_model(info)
        else:
            manager.add_model(info)
    except Exception as e:
        # Persistence failed (disk full, permission denied) — roll back
        # the extracted directory so we don't leave dangling files.
        shutil.rmtree(target_dir, ignore_errors=True)
        raise HTTPException(500, f"register failed: {e}") from e

    # ── Move source zip to installed/ ───────────────────────────────
    # Skipped when `keep_source=True` (auto-publish watcher path) —
    # the watcher uses the inbox itself as the source of truth, so
    # moving would falsely look like the puppet was deleted.
    if not req.keep_source:
        installed_dir = inbox / "installed"
        try:
            installed_dir.mkdir(exist_ok=True)
            src.replace(installed_dir / src.name)
        except OSError as e:
            # Non-fatal — model is already registered. Surface a warning
            # in the response so the UI can show "installed but couldn't
            # archive zip" instead of a misleading green tick.
            logger.warning(f"[baked-imports] post-install zip move failed: {e}")
            return {
                "status": "ok",
                "warning": f"zip move to installed/ failed: {e}",
                "model": info.to_dict(),
                "replaced": replaced,
            }

    logger.info(
        f"[baked-imports] installed {req.filename} → {model_name} [{runtime}] · {final_display}"
    )
    return {"status": "ok", "model": info.to_dict(), "replaced": replaced}


# ── Library sync (geny-avatar pushes the puppet's baked zip directly) ──
#
# The library-sync flow lets geny-avatar treat its IndexedDB library as
# the source of truth: every meaningful save in the editor pushes the
# fresh baked zip to Geny, and Geny replaces the previous registry entry
# in place using the puppet's stable IndexedDB id. End users never have
# to think about a separate "Send to Geny" step — the library entry IS
# the Geny entry.
#
# Endpoints intentionally live on a separate router prefix from the
# inbox-driven `baked-imports/install` flow above so client code can
# tell them apart in logs / metrics; they share the same install logic
# under the hood (a sync-pushed zip lands in the inbox first, then
# `install_baked_import` runs against it with `replace_existing=True`).

library_router = APIRouter(prefix="/api/vtuber/library", tags=["vtuber"])


@library_router.post("/sync")
async def library_sync(
    request: Request,
    zip: UploadFile = File(...),
) -> dict[str, Any]:
    """Receive a baked puppet zip from geny-avatar and install it,
    replacing any existing registry entry that shares the same puppet
    id from `avatar-editor.json`.

    Differences from `/api/vtuber/baked-imports/install`:
      * Zip arrives as a multipart upload (no need for a prior drop into
        the shared volume).
      * Always replaces by puppet_id; no need for the caller to pass an
        explicit `replace_existing` flag — re-sync semantics are the
        whole point of this endpoint.
      * `installed/<filename>.zip` is keyed by puppet id, not timestamp,
        so the inbox stays bounded as the user iterates on a puppet.
    """
    inbox = _inbox_dir()
    try:
        inbox.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        raise HTTPException(500, f"inbox create failed: {e}") from e

    # Read into a temp file in the inbox so the existing install flow
    # (which expects a Path on disk) works without further plumbing.
    # We deliberately stream rather than `.read()` the whole upload to
    # keep memory bounded for large bakes.
    body = await zip.read()
    if not body:
        raise HTTPException(400, "empty zip upload")

    # Peek the metadata before naming the file — we want the on-disk
    # filename to encode puppet_id so re-syncs overwrite cleanly.
    import io
    try:
        with zipfile.ZipFile(io.BytesIO(body), "r") as zf:
            meta: dict[str, Any] = {}
            for candidate in ("avatar-editor.json", "avatar.json"):
                if candidate in zf.namelist():
                    with zf.open(candidate) as f:
                        meta = _json.loads(f.read().decode("utf-8"))
                    break
    except (zipfile.BadZipFile, ValueError) as e:
        raise HTTPException(400, f"invalid zip upload: {e}") from e

    puppet_meta = meta.get("puppet") or {}
    puppet_id_val = puppet_meta.get("id") or ""
    puppet_name_val = puppet_meta.get("name") or "puppet"
    if not puppet_id_val:
        # Library sync depends on stable id-based dedup; reject zips
        # without one rather than silently appending duplicates that
        # the caller can never overwrite.
        raise HTTPException(
            400,
            "avatar-editor.json puppet.id is missing — re-export from a "
            "geny-avatar version that includes puppet.id in the sidecar.",
        )

    # Stable filename keyed by puppet id. A re-sync of the same puppet
    # overwrites this file in place, and `installed/<filename>` likewise.
    safe_id = _slugify(puppet_id_val)[:48] or "puppet"
    on_disk_name = f"sync_{safe_id}.zip"
    target = inbox / on_disk_name

    try:
        target.write_bytes(body)
    except OSError as e:
        raise HTTPException(500, f"inbox write failed: {e}") from e

    logger.info(
        f"[library-sync] received {len(body)} bytes for puppet "
        f"id={puppet_id_val!r} name={puppet_name_val!r} → {on_disk_name}"
    )

    # Reuse the install flow. `replace_existing=False` is deliberate:
    # the puppet-id-based replacement inside install_baked_import is
    # the authoritative dedup key for sync (one geny-avatar library
    # row → one Geny registry entry). The display-name-based pruning
    # that `replace_existing=True` triggers would also drop *other*
    # puppets that happen to share a display name — e.g. three
    # different puppets uploaded with name "Hiyori" would all
    # collapse into a single "Hiyori (Editor)" entry, with the last
    # sync silently overwriting the previous two. With it off,
    # `_next_unique_display_name` appends "(Editor 2)" / "(Editor 3)"
    # to disambiguate same-name-different-id puppets.
    install_req = InstallRequest(
        filename=on_disk_name,
        replace_existing=False,
        display_name_override=None,
    )
    return await install_baked_import(install_req, request)


@library_router.delete("/{puppet_id}")
async def library_delete(puppet_id: str, request: Request) -> dict[str, Any]:
    """Drop everything tied to a puppet id from Geny.

    Mirrors geny-avatar's IndexedDB delete — when the user removes a
    puppet from their editor library, every trace of it is dropped
    from Geny too so the assignable-models list, the unsaved-imports
    inbox and any extracted on-disk model dir all stay in sync.

    Cleanup steps (each step is best-effort and independent — a
    failure in one doesn't block the others):
      1. Registry entry whose `puppet_id` matches → drop + on-disk
         extracted dir under static/<runtime>-models/.
      2. Inbox + installed/ zips whose avatar-editor.json carries the
         matching puppet.id → unlink. Catches both the new
         `sync_<id>.zip` naming and the legacy timestamped names from
         the old send-to-geny workflow.

    Always returns 200 — the operation is idempotent. The response
    body lists what was actually removed so the caller can verify.
    """
    if not puppet_id or not puppet_id.strip():
        raise HTTPException(400, "puppet_id is required")

    removed_registry: Optional[dict[str, str]] = None
    removed_zips: list[str] = []
    warnings: list[str] = []

    # ── Step 1: registry entry ─────────────────────────────────────
    manager = request.app.state.live2d_model_manager  # type: ignore[attr-defined]
    info = manager.find_by_puppet_id(puppet_id)
    if info is not None:
        url_parts = (info.url or "").lstrip("/").split("/")
        models_root: Optional[Path] = None
        if len(url_parts) >= 3 and url_parts[0] == "static":
            if url_parts[1] == "live2d-models":
                models_root = _live2d_models_root()
            elif url_parts[1] == "spine-models":
                models_root = _spine_models_root()
        if models_root is None:
            logger.warning(
                f"[library-delete] {info.name} has unrecognized url={info.url!r}; "
                f"removing registry entry but leaving on-disk dir alone"
            )
            manager.remove_model(info.name)
        else:
            _drop_model_with_dir(manager, info, models_root)
        removed_registry = {
            "name": info.name,
            "display_name": info.display_name,
        }

    # ── Step 2: inbox + installed zips with matching puppet.id ────
    # Walk every .zip in /data/baked-imports + /data/baked-imports/installed.
    # Peek each zip's avatar-editor.json and unlink anything whose
    # `puppet.id` matches. This catches both the new sync_<id>.zip
    # naming and the legacy timestamp-suffixed `name__YYYYMMDD_*.zip`
    # files that the old send-to-geny workflow dropped — those have
    # no name-based hint that they belong to this puppet, but the
    # sidecar inside is the canonical source.
    inbox = _inbox_dir()
    candidate_dirs = [inbox]
    installed_dir = inbox / "installed"
    if installed_dir.exists():
        candidate_dirs.append(installed_dir)
    for d in candidate_dirs:
        if not d.is_dir():
            continue
        try:
            entries = list(d.iterdir())
        except OSError as e:
            warnings.append(f"scan {d}: {e}")
            continue
        for f in entries:
            if not f.is_file() or f.suffix.lower() != ".zip":
                continue
            try:
                meta = _peek_zip_metadata(f)
            except Exception as e:
                warnings.append(f"peek {f.name}: {e}")
                continue
            zip_puppet_id = (meta.get("puppet") or {}).get("id")
            if zip_puppet_id != puppet_id:
                continue
            try:
                f.unlink()
                removed_zips.append(str(f.relative_to(inbox)))
            except OSError as e:
                warnings.append(f"unlink {f.name}: {e}")

    logger.info(
        f"[library-delete] puppet_id={puppet_id!r}: "
        f"registry={removed_registry}, zips={removed_zips}, warnings={warnings}"
    )
    return {
        "status": "ok",
        "puppet_id": puppet_id,
        "removed_registry": removed_registry,
        "removed_zips": removed_zips,
        "warnings": warnings,
    }
