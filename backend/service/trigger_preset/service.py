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
import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from threading import RLock
from typing import Any, Dict, List, Optional
from uuid import uuid4

from service.trigger_preset.defaults import default_manifest

logger = logging.getLogger(__name__)
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


# Stable id for the bundled default preset Geny seeds on first boot. Sessions
# with no explicitly-attached preset resolve to THIS record (see
# thinking_trigger._resolve_manifest), so editing it in 트리거 관리 changes the
# default behavior for everyone. Seeded once from default_manifest(); never
# overwritten afterwards, so user edits survive restarts.
DEFAULT_PRESET_ID = "default"


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

    def __init__(
        self,
        storage_path: Optional[str] = None,
        app_db: Any = None,
    ) -> None:
        path = storage_path or _default_storage_path()
        self._storage = Path(path)
        self._storage.mkdir(parents=True, exist_ok=True)
        self._lock = RLock()
        self._version = 0
        self._app_db = app_db

    @property
    def storage_path(self) -> Path:
        return self._storage

    # ── DB wiring ─────────────────────────────────────────────

    def set_database(self, app_db: Any) -> None:
        """Attach the AppDatabaseManager and reconcile both backends."""
        with self._lock:
            self._app_db = app_db
            logger.info("TriggerPresetService: database backend attached")
            try:
                self._reconcile_locked()
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "TriggerPresetService: reconcile failed (continuing): %s", exc,
                )
            try:
                self._seed_default_locked()
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "TriggerPresetService: default-preset seed failed (continuing): %s", exc,
                )

    def _seed_default_locked(self) -> None:
        """Ensure the bundled default preset (``DEFAULT_PRESET_ID``) exists.

        Idempotent — only writes when the record is missing, so a user's edits
        to the default preset survive restarts. Seeded from
        :func:`default_manifest`, which already includes the screen-observation
        category, so screen-aware proactive speech is on out of the box.
        Must be called with ``self._lock`` held (RLock; ``set_database`` holds it).
        """
        if self._read_record(DEFAULT_PRESET_ID) is not None:
            return
        now = _iso_now()
        record = TriggerPresetRecord(
            id=DEFAULT_PRESET_ID,
            name="기본 (화면 관찰 포함)",
            description=(
                "Geny 기본 트리거 프리셋 — idle 반영 + 화면 관찰 발화. "
                "직접 수정하거나 '새 드래프트'로 복제해서 쓰세요."
            ),
            tags=["default"],
            created_at=now,
            updated_at=now,
            manifest=default_manifest(),
        )
        self._write_record(record)
        self._bump_version()
        logger.info(
            "TriggerPresetService: seeded bundled default preset (%s)", DEFAULT_PRESET_ID,
        )

    def _default_pointer_path(self) -> Path:
        return self._storage / "_active_default.txt"

    def get_active_default_id(self) -> str:
        """The preset id currently DESIGNATED as the default — used by VTuber
        sessions that neither pass an explicit preset nor have one mapped on
        their environment. Operators set this via :meth:`set_active_default`
        (the 트리거 관리 "기본값으로 설정" action). Falls back to the bundled
        ``DEFAULT_PRESET_ID`` when unset or pointing at a deleted preset, so a
        default always resolves."""
        try:
            raw = self._default_pointer_path().read_text(encoding="utf-8").strip()
        except OSError:
            raw = ""
        if raw and self._read_record(raw) is not None:
            return raw
        return DEFAULT_PRESET_ID

    def set_active_default(self, preset_id: str) -> None:
        """Designate *preset_id* as the active default preset. Validates it
        exists. Bumps the version so live trigger resolution re-reads it."""
        with self._lock:
            if self._read_record(preset_id) is None:
                raise TriggerPresetNotFoundError(preset_id)
            self._default_pointer_path().write_text(preset_id, encoding="utf-8")
            self._bump_version()

    def get_default(self) -> Optional[TriggerPresetRecord]:
        """Return the currently-DESIGNATED default preset record (seeding the
        bundled one if nothing exists yet)."""
        rec = self.get(self.get_active_default_id())
        if rec is None:
            with self._lock:
                self._seed_default_locked()
            rec = self.get(DEFAULT_PRESET_ID)
        return rec

    @property
    def _db_available(self) -> bool:
        if self._app_db is None:
            return False
        try:
            return self._app_db.db_manager._is_pool_healthy()
        except Exception:
            return False

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
        """DB-first read; falls back to JSON file on miss / outage."""
        if self._db_available:
            try:
                row = self._app_db.db_manager.execute_query_one(
                    "SELECT data FROM trigger_presets WHERE preset_id = %s",
                    (preset_id,),
                )
                record = _row_to_record(row)
                if record is not None:
                    return record
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "TriggerPresetService: DB read failed for %s, trying file: %s",
                    preset_id, exc,
                )
        return self._read_record_from_file(preset_id)

    def _read_record_from_file(self, preset_id: str) -> Optional[TriggerPresetRecord]:
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
        """UPSERT to DB; always mirror to the JSON file."""
        payload_obj = record.model_dump(mode="json")
        payload_json = json.dumps(payload_obj, ensure_ascii=False, default=str)

        if self._db_available:
            try:
                self._app_db.db_manager.execute_insert(
                    """
                    INSERT INTO trigger_presets (preset_id, name, data)
                    VALUES (%s, %s, %s::jsonb)
                    ON CONFLICT (preset_id)
                    DO UPDATE SET
                        name = EXCLUDED.name,
                        data = EXCLUDED.data,
                        updated_at = CURRENT_TIMESTAMP
                    """,
                    (record.id, record.name, payload_json),
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "TriggerPresetService: DB write failed for %s, falling back to file: %s",
                    record.id, exc,
                )

        # Mirror to disk regardless — fallback / DR copy.
        path = self._path(record.id)
        path.write_text(
            json.dumps(payload_obj, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    def _delete_from_db(self, preset_id: str) -> bool:
        affected = self._app_db.db_manager.execute_update_delete(
            "DELETE FROM trigger_presets WHERE preset_id = %s",
            (preset_id,),
        )
        return bool(affected and affected > 0)

    def _list_records_from_db(self) -> List[TriggerPresetRecord]:
        rows = self._app_db.db_manager.execute_query(
            "SELECT data FROM trigger_presets ORDER BY name ASC",
        )
        if not rows:
            return []
        out: List[TriggerPresetRecord] = []
        for row in rows:
            rec = _row_to_record(row)
            if rec is not None:
                out.append(rec)
        return out

    # ── Read API ──────────────────────────────────────────────

    def get(self, preset_id: str) -> Optional[TriggerPresetRecord]:
        return self._read_record(preset_id)

    def list_all(self) -> List[Dict[str, Any]]:
        """Return UI-friendly summary dicts for every stored preset.

        Prefers DB rows; merges in any JSON-only orphans (e.g. presets
        created while the DB was unreachable).
        """
        seen: Dict[str, Dict[str, Any]] = {}
        if self._db_available:
            try:
                for record in self._list_records_from_db():
                    seen[record.id] = self._summarize(record)
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "TriggerPresetService: DB list failed, falling back to files: %s",
                    exc,
                )

        for f in sorted(self._storage.glob("*.json")):
            try:
                data = json.loads(f.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                continue
            try:
                record = TriggerPresetRecord.model_validate(data)
            except Exception:  # noqa: BLE001
                continue
            if record.id in seen:
                continue
            seen[record.id] = self._summarize(record)

        result = list(seen.values())
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
        """Remove from DB + file. Returns True if anything was removed."""
        with self._lock:
            db_removed = False
            if self._db_available:
                try:
                    db_removed = self._delete_from_db(preset_id)
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        "TriggerPresetService: DB delete failed for %s: %s",
                        preset_id, exc,
                    )

            file_removed = False
            path = self._path(preset_id)
            if path.exists():
                try:
                    path.unlink()
                    file_removed = True
                except OSError:
                    pass

            if db_removed or file_removed:
                self._bump_version()
                return True
            return False

    # ── Reset to defaults ─────────────────────────────────────

    def reset_to_defaults(self, preset_id: str) -> TriggerPresetRecord:
        """Replace this preset's manifest with the bundled defaults.

        Convenience wrapper used by the "기본값으로 초기화" affordance
        in the UI. Preserves the preset's id / name / metadata so links
        from VTuber sessions stay valid.
        """
        return self.replace_manifest(preset_id, default_manifest())

    # ── Reconcile ─────────────────────────────────────────────

    def _reconcile_locked(self) -> None:
        """Align DB + JSON-file backends at startup. DB wins on conflict.

        Must be called with ``self._lock`` held — invoked from
        ``set_database`` which already takes it.

        Strategy mirrors ToolPresetStore (Phase 2A) and
        EnvironmentService (Phase 2B):
          1. DB rows mirror to disk.
          2. File-only records push up to the DB.
          3. Orphans on either side stay; deletes are explicit.
        """
        if not self._db_available:
            logger.info("TriggerPresetService: reconcile skipped (DB unavailable)")
            return

        try:
            db_records = {r.id: r for r in self._list_records_from_db()}
        except Exception as exc:  # noqa: BLE001
            logger.warning("TriggerPresetService: reconcile DB read failed: %s", exc)
            return

        file_records: Dict[str, TriggerPresetRecord] = {}
        for f in sorted(self._storage.glob("*.json")):
            try:
                data = json.loads(f.read_text(encoding="utf-8"))
                record = TriggerPresetRecord.model_validate(data)
            except (json.JSONDecodeError, OSError):
                continue
            except Exception:  # noqa: BLE001
                continue
            file_records[record.id] = record

        mirrored = 0
        for record in db_records.values():
            try:
                self._path(record.id).write_text(
                    json.dumps(
                        record.model_dump(mode="json"),
                        ensure_ascii=False,
                        indent=2,
                    ),
                    encoding="utf-8",
                )
                mirrored += 1
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "TriggerPresetService: reconcile mirror failed for %s: %s",
                    record.id, exc,
                )

        pushed = 0
        for preset_id, record in file_records.items():
            if preset_id in db_records:
                continue
            try:
                payload_json = json.dumps(
                    record.model_dump(mode="json"),
                    ensure_ascii=False,
                    default=str,
                )
                self._app_db.db_manager.execute_insert(
                    """
                    INSERT INTO trigger_presets (preset_id, name, data)
                    VALUES (%s, %s, %s::jsonb)
                    ON CONFLICT (preset_id)
                    DO UPDATE SET
                        name = EXCLUDED.name,
                        data = EXCLUDED.data,
                        updated_at = CURRENT_TIMESTAMP
                    """,
                    (record.id, record.name, payload_json),
                )
                pushed += 1
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "TriggerPresetService: reconcile push failed for %s: %s",
                    preset_id, exc,
                )

        logger.info(
            "TriggerPresetService: reconcile done — db_rows=%d, files=%d, mirrored=%d, pushed=%d",
            len(db_records), len(file_records), mirrored, pushed,
        )


def _row_to_record(row: Any) -> Optional[TriggerPresetRecord]:
    """Decode a ``trigger_presets.data`` row into a TriggerPresetRecord."""
    if row is None:
        return None
    raw = row.get("data") if isinstance(row, dict) else row[0]
    if raw is None:
        return None
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError as exc:
            logger.error("Failed to parse trigger_preset JSON from DB: %s", exc)
            return None
    try:
        return TriggerPresetRecord.model_validate(raw)
    except Exception as exc:  # noqa: BLE001
        logger.error("Failed to validate TriggerPresetRecord from DB row: %s", exc)
        return None
