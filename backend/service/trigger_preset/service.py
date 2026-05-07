"""Trigger Preset persistence service — JSON-per-id under
``./data/trigger_presets/``.

Mirrors :class:`service.environment.service.EnvironmentService` so the
operational surface is symmetric with the Environment system: same
``./data`` neighbourhood, same id-as-filename layout, same
``ENVIRONMENT_STORAGE_PATH``-style env var override.

Cache invalidation
------------------
Every mutating call (``create`` / ``update_metadata`` /
``replace_manifest`` / ``duplicate`` / ``delete``) bumps a process-wide
``_version`` counter. The :class:`ThinkingTriggerService` reads
``get_version()`` on every fire to invalidate its in-memory preset
cache — this keeps live reload free of bookkeeping (no observer
registry, no pub-sub) at the cost of one cheap counter check per tick.
"""

from __future__ import annotations

import copy
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from threading import RLock
from typing import Any, Dict, List, Optional
from uuid import uuid4

from service.trigger_preset.defaults import default_manifest
from service.trigger_preset.exceptions import (
    TriggerPresetNotFoundError,
    TriggerPresetValidationError,
)
from service.trigger_preset.schemas import (
    TriggerPresetManifest,
    TriggerPresetRecord,
)

__all__ = [
    "TriggerPresetService",
    "TriggerPresetNotFoundError",
    "TriggerPresetValidationError",
]


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _fresh_id() -> str:
    return uuid4().hex[:12]


def _default_storage_path() -> str:
    """Storage root, defaults to ``./data/trigger_presets``.

    Override via ``TRIGGER_PRESET_STORAGE_PATH`` for ops parity with the
    ``ENVIRONMENT_STORAGE_PATH`` knob.
    """
    return (
        os.getenv("TRIGGER_PRESET_STORAGE_PATH")
        or "./data/trigger_presets"
    ).strip()


class TriggerPresetService:
    """CRUD over trigger preset records on disk.

    Thread-safe for concurrent reads + serialised writes via an internal
    ``RLock``. The lock guards both the filesystem mutation and the
    version counter so a reader observing a higher version can trust
    the corresponding file already reflects the change.
    """

    def __init__(self, storage_path: Optional[str] = None) -> None:
        path = storage_path or _default_storage_path()
        self._storage = Path(path)
        self._storage.mkdir(parents=True, exist_ok=True)
        self._lock = RLock()
        self._version = 0

    @property
    def storage_path(self) -> Path:
        return self._storage

    # ── Versioning (cache invalidation) ───────────────────────

    def get_version(self) -> int:
        """Monotonic counter incremented on every mutation.

        Consumers (notably the thinking-trigger runtime) compare a
        cached version against this on each tick to know whether their
        cached :class:`TriggerPresetRecord` is still fresh. No locking
        required — int reads are atomic on CPython and a stale read
        just costs one extra reload.
        """
        return self._version

    def _bump_version(self) -> None:
        # Called inside ``self._lock`` so the increment + write are atomic
        # relative to other mutators.
        self._version += 1

    # ── File layout ───────────────────────────────────────────

    def _path(self, preset_id: str) -> Path:
        return self._storage / f"{preset_id}.json"

    def _read_record(self, preset_id: str) -> Optional[TriggerPresetRecord]:
        path = self._path(preset_id)
        if not path.exists():
            return None
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return None
        try:
            return TriggerPresetRecord.model_validate(data)
        except Exception:  # noqa: BLE001 — tolerate stale / malformed files
            return None

    def _write_record(self, record: TriggerPresetRecord) -> None:
        path = self._path(record.id)
        payload = record.model_dump(mode="json")
        path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    # ── Read API ──────────────────────────────────────────────

    def get(self, preset_id: str) -> Optional[TriggerPresetRecord]:
        return self._read_record(preset_id)

    def list_all(self) -> List[Dict[str, Any]]:
        """Return UI-friendly summary dicts for every stored preset."""
        result: List[Dict[str, Any]] = []
        for f in sorted(self._storage.glob("*.json")):
            try:
                data = json.loads(f.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                continue
            try:
                record = TriggerPresetRecord.model_validate(data)
            except Exception:  # noqa: BLE001
                continue
            result.append(self._summarize(record))
        # newest-first so the FE renders most recent activity at the top.
        result.sort(key=lambda r: r.get("updated_at", ""), reverse=True)
        return result

    @staticmethod
    def _summarize(record: TriggerPresetRecord) -> Dict[str, Any]:
        return {
            "id": record.id,
            "name": record.name,
            "description": record.description,
            "tags": list(record.tags),
            "created_at": record.created_at,
            "updated_at": record.updated_at,
            "enabled": record.manifest.enabled,
            "category_count": len(record.manifest.categories),
            "prompt_count": len(record.manifest.prompts),
        }

    # ── Write API ─────────────────────────────────────────────

    def create(
        self,
        name: str,
        *,
        description: str = "",
        tags: Optional[List[str]] = None,
        manifest: Optional[TriggerPresetManifest] = None,
        clone_from: Optional[str] = None,
    ) -> str:
        """Create a new preset and return its id.

        Resolution order for the manifest body:

        * explicit ``manifest`` argument (full body)
        * ``clone_from`` deep-copies a sibling preset's manifest
        * fallback: :func:`default_manifest` — the historical ladder
        """
        with self._lock:
            if manifest is not None:
                body = manifest
            elif clone_from is not None:
                source = self._read_record(clone_from)
                if source is None:
                    raise TriggerPresetNotFoundError(clone_from)
                body = TriggerPresetManifest.model_validate(
                    copy.deepcopy(source.manifest.model_dump(mode="json"))
                )
            else:
                body = default_manifest()

            preset_id = _fresh_id()
            now = _iso_now()
            record = TriggerPresetRecord(
                id=preset_id,
                name=name,
                description=description,
                tags=list(tags or []),
                created_at=now,
                updated_at=now,
                manifest=body,
            )
            self._write_record(record)
            self._bump_version()
            return preset_id

    def update_metadata(
        self,
        preset_id: str,
        *,
        name: Optional[str] = None,
        description: Optional[str] = None,
        tags: Optional[List[str]] = None,
    ) -> TriggerPresetRecord:
        """Patch top-level metadata only (name / description / tags)."""
        with self._lock:
            record = self._read_record(preset_id)
            if record is None:
                raise TriggerPresetNotFoundError(preset_id)
            if name is not None:
                record.name = name
            if description is not None:
                record.description = description
            if tags is not None:
                record.tags = list(tags)
            record.updated_at = _iso_now()
            self._write_record(record)
            self._bump_version()
            return record

    def replace_manifest(
        self,
        preset_id: str,
        manifest: TriggerPresetManifest,
    ) -> TriggerPresetRecord:
        """Overwrite the manifest body wholesale."""
        with self._lock:
            record = self._read_record(preset_id)
            if record is None:
                raise TriggerPresetNotFoundError(preset_id)
            record.manifest = manifest
            record.updated_at = _iso_now()
            self._write_record(record)
            self._bump_version()
            return record

    def duplicate(self, preset_id: str, new_name: str) -> str:
        """Deep-copy under a new id + name and return that id."""
        with self._lock:
            source = self._read_record(preset_id)
            if source is None:
                raise TriggerPresetNotFoundError(preset_id)
            cloned_body = TriggerPresetManifest.model_validate(
                copy.deepcopy(source.manifest.model_dump(mode="json"))
            )
            new_id = _fresh_id()
            now = _iso_now()
            record = TriggerPresetRecord(
                id=new_id,
                name=new_name,
                description=source.description,
                tags=list(source.tags),
                created_at=now,
                updated_at=now,
                manifest=cloned_body,
            )
            self._write_record(record)
            self._bump_version()
            return new_id

    def delete(self, preset_id: str) -> bool:
        with self._lock:
            path = self._path(preset_id)
            if not path.exists():
                return False
            try:
                path.unlink()
            except OSError:
                return False
            self._bump_version()
            return True

    # ── Reset to defaults ─────────────────────────────────────

    def reset_to_defaults(self, preset_id: str) -> TriggerPresetRecord:
        """Replace this preset's manifest with the bundled defaults.

        Convenience wrapper used by the "기본값으로 초기화" affordance
        in the UI. Preserves the preset's id / name / metadata so links
        from VTuber sessions stay valid.
        """
        return self.replace_manifest(preset_id, default_manifest())
