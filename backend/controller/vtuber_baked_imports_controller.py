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

from fastapi import APIRouter, HTTPException, Request
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
async def list_baked_imports() -> dict[str, Any]:
    """List all pending baked-puppet zips in the inbox.

    Sorted newest-first by mtime so the most recent "send to Geny" lands
    at the top of the UI list.
    """
    inbox = _inbox_dir()
    if not inbox.exists():
        # Not an error — empty inbox until avatar-editor first writes.
        return {"inbox": str(inbox), "entries": [], "exists": False}

    entries: list[BakedImportEntry] = []
    for p in inbox.iterdir():
        if not p.is_file() or p.suffix.lower() != ".zip":
            continue
        try:
            stat = p.stat()
            meta = _peek_zip_metadata(p)
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

    # ── Compute target directory + slugged model name ──────────────
    # Use microsecond precision so back-to-back installs of the same
    # source puppet don't collide on the timestamp.
    ts = datetime.now(tz=timezone.utc).strftime("%Y%m%d_%H%M%S_%f")
    slug = _slugify(suggested_name)
    model_name = f"{slug}__editor_{ts}"

    if runtime == "live2d":
        models_root = _live2d_models_root()
        url_prefix = "/static/live2d-models"
    else:
        models_root = _spine_models_root()
        url_prefix = "/static/spine-models"

    target_dir = models_root / model_name
    if target_dir.exists():
        # Theoretically impossible (timestamp collision down to the
        # second + slug match) but reject loudly rather than overwrite.
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
    manager = request.app.state.live2d_model_manager  # type: ignore[attr-defined]
    base_display = req.display_name_override or suggested_name

    # Optional: clear out prior `(Editor)` entries that share this base
    # before computing the new entry's display name. This is the iter-
    # in-place workflow — user keeps re-baking the same puppet and
    # wants the registry to stay tidy instead of accumulating
    # `(Editor 2)`, `(Editor 3)`, ... copies.
    replaced: list[dict[str, str]] = []
    if req.replace_existing:
        pattern_base = f"{base_display} (Editor"
        prior = [
            m for m in manager.list_models()
            if m.display_name.startswith(pattern_base)
        ]
        for old in prior:
            url_parts = old.url.lstrip("/").split("/")
            # Expected layout: static / <runtime>-models / <model_dir> / ...
            if len(url_parts) >= 3 and url_parts[0] == "static":
                root_lookup = {
                    "live2d-models": _live2d_models_root(),
                    "spine-models": _spine_models_root(),
                }
                base_root = root_lookup.get(url_parts[1])
                if base_root is not None:
                    target = base_root / url_parts[2]
                    if target.exists():
                        # ignore_errors keeps the registry consistent even if
                        # the on-disk dir was already pruned out-of-band.
                        shutil.rmtree(target, ignore_errors=True)
            manager.remove_model(old.name)
            replaced.append({"name": old.name, "display_name": old.display_name})
        if replaced:
            logger.info(
                f"[install] replace_existing pruned {len(replaced)} prior entries "
                f"matching base={base_display!r}"
            )

    existing_display_names = {m.display_name for m in manager.list_models()}
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
    )
    try:
        manager.add_model(info)
    except Exception as e:
        # Persistence failed (disk full, permission denied) — roll back
        # the extracted directory so we don't leave dangling files.
        shutil.rmtree(target_dir, ignore_errors=True)
        raise HTTPException(500, f"register failed: {e}") from e

    # ── Move source zip to installed/ ───────────────────────────────
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
