"""
Live2D Model Manager

Loads model_registry.json, manages available Live2D models,
and tracks agent-model assignments.
"""

import asyncio
import json
from pathlib import Path
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Set
from logging import getLogger

logger = getLogger(__name__)


@dataclass
class Live2dModelInfo:
    """Metadata for a single avatar model.

    Despite the historical class name, an entry here can describe either
    a Live2D Cubism puppet or a Spine puppet — the `runtime` field tells
    consumers which renderer to use. Class rename is deferred to keep
    this PR small; the manager docstring covers the wider role.

    Schema versioning lives at the top level of model_registry.json
    (`schema_version`), bumped to 2 when `runtime` was introduced.
    Pre-v2 registries had no `runtime` field — we treat them as
    Live2D-only on load.
    """
    name: str
    display_name: str
    description: str
    url: str
    thumbnail: Optional[str]
    kScale: float
    initialXshift: float
    initialYshift: float
    idleMotionGroupName: str
    emotionMap: Dict[str, int]
    tapMotions: Dict[str, Dict[str, int]]
    emotionMotionMap: Dict[str, str] = field(default_factory=dict)
    hiddenParts: List[str] = field(default_factory=list)
    runtime: str = "live2d"
    # Spine-specific: the .atlas file URL (sibling of the .skel/.json).
    # Live2D entries leave this None.
    atlas_url: Optional[str] = None
    # Stable identifier from geny-avatar's IndexedDB (e.g. "avt_xxx").
    # Used by the library-sync endpoint to dedupe: a re-sync of the
    # same puppet replaces this entry instead of accumulating
    # "(Editor 2)" / "(Editor 3)" duplicates. Hand-installed models
    # without a sidecar leave this None.
    puppet_id: Optional[str] = None
    # mtime (epoch seconds) of the source zip in /data/baked-imports at
    # the time this entry was last installed. Set when the auto-publish
    # watcher installs with `keep_source=True`; the watcher uses it to
    # detect "the zip on disk is newer than what we have registered"
    # (i.e. the user renamed or re-baked the puppet) and re-install.
    # Entries from legacy hand-installed paths leave this None.
    inbox_mtime: Optional[float] = None

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "display_name": self.display_name,
            "description": self.description,
            "url": self.url,
            "thumbnail": self.thumbnail,
            "kScale": self.kScale,
            "initialXshift": self.initialXshift,
            "initialYshift": self.initialYshift,
            "idleMotionGroupName": self.idleMotionGroupName,
            "emotionMap": self.emotionMap,
            "tapMotions": self.tapMotions,
            "emotionMotionMap": self.emotionMotionMap,
            "hiddenParts": self.hiddenParts,
            "runtime": self.runtime,
            "atlas_url": self.atlas_url,
            "puppet_id": self.puppet_id,
            "inbox_mtime": self.inbox_mtime,
        }


class Live2dModelManager:
    """
    Manages the avatar model registry and agent-model assignments.

    Originally Live2D-only (hence the class name); since the geny-avatar
    integration introduced `runtime` on each entry, this also manages
    Spine puppets in the same registry. Frontend dispatches the right
    renderer based on `entry.runtime`. Class rename is deferred — every
    consumer references `request.app.state.live2d_model_manager`, and a
    rename touches ~10 sites that aren't blockers for current work.

    Reads model_registry.json from the given directory, provides model
    lookup, and tracks which agent session uses which model.
    """

    def __init__(self, models_dir: str):
        self._models_dir = Path(models_dir)
        self._registry_path = self._models_dir / "model_registry.json"
        self._models: Dict[str, Live2dModelInfo] = {}
        self._default_model: str = ""
        self._agent_assignments: Dict[str, str] = {}  # session_id → model_name
        # Change listeners — each entry is an asyncio.Queue the
        # subscriber drains. Notified on any mutation
        # (add/replace/remove/reload) so SSE clients can push the new
        # model list to the browser without polling.
        self._change_listeners: Set["asyncio.Queue[None]"] = set()
        self._load_registry()

    def _load_registry(self):
        """Load model registry from JSON file."""
        if not self._registry_path.exists():
            logger.warning(f"Model registry not found: {self._registry_path}")
            return

        try:
            with open(self._registry_path, "r", encoding="utf-8") as f:
                data = json.load(f)

            schema_version = data.get("schema_version", 1)
            for model_data in data.get("models", []):
                info = Live2dModelInfo(
                    name=model_data["name"],
                    display_name=model_data.get("display_name", model_data["name"]),
                    description=model_data.get("description", ""),
                    url=model_data["url"],
                    thumbnail=model_data.get("thumbnail"),
                    kScale=model_data.get("kScale", 0.5),
                    initialXshift=model_data.get("initialXshift", 0),
                    initialYshift=model_data.get("initialYshift", 0),
                    idleMotionGroupName=model_data.get("idleMotionGroupName", "Idle"),
                    emotionMap=model_data.get("emotionMap", {"neutral": 0}),
                    tapMotions=model_data.get("tapMotions", {}),
                    emotionMotionMap=model_data.get("emotionMotionMap", {}),
                    hiddenParts=model_data.get("hiddenParts", []),
                    # Pre-v2 registries had no runtime field — fall back to
                    # live2d so old hand-crafted JSONs still load.
                    runtime=model_data.get("runtime", "live2d"),
                    atlas_url=model_data.get("atlas_url"),
                    puppet_id=model_data.get("puppet_id"),
                    inbox_mtime=model_data.get("inbox_mtime"),
                )
                self._models[info.name] = info

            self._default_model = data.get("default_model", "")
            self._agent_assignments = data.get("agent_model_assignments", {})

            logger.info(
                f"Loaded {len(self._models)} avatar models from registry "
                f"(schema_version={schema_version})"
            )
            for name, info in self._models.items():
                logger.info(f"  - {name} [{info.runtime}]: {info.display_name}")

        except Exception as e:
            logger.error(f"Failed to load model registry: {e}")

    @property
    def models(self) -> Dict[str, Live2dModelInfo]:
        return self._models

    @property
    def default_model_name(self) -> str:
        return self._default_model

    def list_models(self) -> List[Live2dModelInfo]:
        """Return list of all registered models."""
        return list(self._models.values())

    def get_model(self, name: str) -> Optional[Live2dModelInfo]:
        """Get model info by name."""
        return self._models.get(name)

    def find_by_puppet_id(self, puppet_id: str) -> Optional[Live2dModelInfo]:
        """Find an existing registry entry by its source-of-truth puppet ID.

        Used by the library-sync flow to detect re-uploads of the same
        geny-avatar puppet so we replace the registry entry instead of
        appending a fresh one. Returns None if no entry has matching
        puppet_id (covers hand-installed models which never carried one).
        """
        if not puppet_id:
            return None
        for info in self._models.values():
            if info.puppet_id == puppet_id:
                return info
        return None

    def get_default_model(self) -> Optional[Live2dModelInfo]:
        """Get the default model."""
        return self._models.get(self._default_model)

    def assign_model_to_agent(self, session_id: str, model_name: str):
        """Assign a Live2D model to an agent session."""
        if model_name not in self._models:
            raise ValueError(f"Unknown model: {model_name}. Available: {list(self._models.keys())}")
        self._agent_assignments[session_id] = model_name
        logger.info(f"Assigned model '{model_name}' to session '{session_id}'")

    def get_agent_model(self, session_id: str) -> Optional[Live2dModelInfo]:
        """Get the model assigned to an agent session."""
        model_name = self._agent_assignments.get(session_id)
        if not model_name:
            return None
        return self._models.get(model_name)

    def get_agent_model_name(self, session_id: str) -> Optional[str]:
        """Get the model name assigned to an agent session."""
        return self._agent_assignments.get(session_id)

    def unassign_model(self, session_id: str):
        """Remove model assignment for a session."""
        self._agent_assignments.pop(session_id, None)

    def get_all_assignments(self) -> Dict[str, str]:
        """Return all agent-model assignments."""
        return dict(self._agent_assignments)

    # ── Mutation (Phase C — geny-avatar baked imports) ──────────────

    def reload(self) -> None:
        """Re-read model_registry.json from disk. Idempotent — clears
        and rebuilds the in-memory model dict; agent assignments are
        preserved (assigned model names that vanished from the registry
        will resolve to None on next get_agent_model)."""
        self._models.clear()
        self._load_registry()
        self._notify_change()

    # ── Change notifications (SSE backbone) ─────────────────────────

    def subscribe_changes(self) -> "asyncio.Queue[None]":
        """Hand back a queue that gets a `None` item every time the
        registry mutates. Callers must pair this with
        ``unsubscribe_changes`` (typically in a ``finally:`` block) or
        the queue stays referenced forever. Queue depth is small
        because consumers just need a "something changed" edge — the
        full new model list is fetched separately via the existing
        ``/api/vtuber/models`` route."""
        # maxsize=8 is a backpressure cap. If a slow SSE client falls
        # behind we drop notifications rather than ballooning memory;
        # the client will catch up on its next refresh.
        q: "asyncio.Queue[None]" = asyncio.Queue(maxsize=8)
        self._change_listeners.add(q)
        return q

    def unsubscribe_changes(self, q: "asyncio.Queue[None]") -> None:
        self._change_listeners.discard(q)

    def _notify_change(self) -> None:
        """Wake every subscriber. Best-effort: queues at capacity are
        skipped (the consumer will get the next edge or the snapshot
        refresh fires anyway on reconnect)."""
        for q in list(self._change_listeners):
            try:
                q.put_nowait(None)
            except asyncio.QueueFull:
                # Listener fell behind — that's OK; the next refresh
                # the client does will pick up current state.
                pass
            except Exception as e:
                logger.debug(f"[model_registry] notify failed: {e}")

    def add_model(self, info: Live2dModelInfo, *, persist: bool = True) -> None:
        """Register a new model in-memory; optionally append the entry
        to model_registry.json so it survives a restart.

        Used by the baked-imports install endpoint after a successful
        unzip — the new entry shows up immediately on /api/vtuber/models
        without needing a backend reload.

        Raises ValueError if a model with the same `name` is already
        registered (caller is responsible for generating unique ids).
        """
        if info.name in self._models:
            raise ValueError(f"model already registered: {info.name}")
        self._models[info.name] = info
        if persist:
            self._persist_append(info)
        self._notify_change()

    def replace_model(self, info: Live2dModelInfo, *, persist: bool = True) -> None:
        """Update an existing entry in place, keyed by `info.name`.

        Why this exists separately from add_model + remove_model: the
        auto-publish watcher re-installs a puppet on rename / re-bake,
        and we want to preserve the registry primary key so existing
        ``agent_model_assignments`` (which map session_id → model.name)
        keep pointing at the live entry. A remove + add would also
        prune assignments, kicking active VTuber sessions back to "no
        model".

        Raises ValueError when the name isn't already registered.
        """
        if info.name not in self._models:
            raise ValueError(f"model not registered: {info.name}")
        self._models[info.name] = info
        if persist:
            self._persist_replace(info)
        self._notify_change()

    def _persist_replace(self, info: Live2dModelInfo) -> None:
        """Read-modify-write the on-disk registry: replace the model
        whose `name` matches `info.name` with the new dict, preserving
        the surrounding schema_version / default_model / assignments and
        the relative order of entries."""
        if not self._registry_path.exists():
            # No on-disk registry yet — emit the new entry as if appending.
            data: dict = {"schema_version": 2, "models": [info.to_dict()]}
        else:
            with open(self._registry_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            models = data.setdefault("models", [])
            replaced = False
            for i, m in enumerate(models):
                if m.get("name") == info.name:
                    models[i] = info.to_dict()
                    replaced = True
                    break
            if not replaced:
                models.append(info.to_dict())
        with open(self._registry_path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.write("\n")
        logger.info(
            f"[model_registry] replaced {info.name} [{info.runtime}] · {info.display_name}"
        )

    def _persist_append(self, info: Live2dModelInfo) -> None:
        """Read-modify-write the on-disk registry, appending one entry.
        Keeps existing schema_version + default_model + assignments and
        the original entries' field order."""
        if not self._registry_path.exists():
            # Bootstrap if the file vanished — write a minimal v2 doc.
            data: dict = {"schema_version": 2, "models": []}
        else:
            with open(self._registry_path, "r", encoding="utf-8") as f:
                data = json.load(f)
        data.setdefault("models", []).append(info.to_dict())
        # ensure_ascii=False keeps Korean descriptions readable on disk;
        # newline-terminate so editors don't show a "no newline" bar.
        with open(self._registry_path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.write("\n")
        logger.info(
            f"[model_registry] appended {info.name} [{info.runtime}] · {info.display_name}"
        )

    def remove_model(self, name: str, *, persist: bool = True) -> bool:
        """Drop a model entry by `name`. Returns True if it existed.

        Used by the baked-imports install endpoint when `replace_existing`
        is requested — prior `(Editor)` entries with the same suggested
        name are pruned before the new install lands so the user doesn't
        end up with `(Editor 2)` / `(Editor 3)` clutter from iterations.

        Also drops any agent assignments pointing at this model — those
        sessions fall back to whatever the next get_agent_model() does
        (typically returns None and the caller picks a default).
        """
        if name not in self._models:
            return False
        self._models.pop(name)
        self._agent_assignments = {
            sid: m for sid, m in self._agent_assignments.items() if m != name
        }
        if persist:
            self._persist_remove(name)
        self._notify_change()
        return True

    def _persist_remove(self, name: str) -> None:
        """Mirror remove_model() onto disk — drop the entry from `models`
        and any `agent_model_assignments` keyed at it."""
        if not self._registry_path.exists():
            return
        with open(self._registry_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        models = [m for m in data.get("models", []) if m.get("name") != name]
        data["models"] = models
        assignments = data.get("agent_model_assignments", {}) or {}
        data["agent_model_assignments"] = {
            sid: m for sid, m in assignments.items() if m != name
        }
        with open(self._registry_path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.write("\n")
        logger.info(f"[model_registry] removed {name}")
