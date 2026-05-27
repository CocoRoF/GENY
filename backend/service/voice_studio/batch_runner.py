"""
Per-job asyncio background worker for Voice Studio batch synthesis.

Jobs run sequentially line-by-line via
:meth:`OmniVoiceEngine.synthesize_preview`. omnivoice's own
``OMNIVOICE_MAX_CONCURRENCY`` semaphore handles GPU serialization
internally, so the runner doesn't add another layer.

History insert is intentionally skipped here — a 200-line batch would
flood the (cap-20) history list. Only ad-hoc Synthesize-card runs hit
history.
"""

from __future__ import annotations

import asyncio
import json
import logging
import zipfile
from pathlib import Path
from typing import Any, Dict, List, Optional

from .batch_store import get_batch_store
from .event_bus import get_event_bus
from .synthesis_preview import PreviewParams

logger = logging.getLogger(__name__)


class BatchRunner:
    def __init__(self) -> None:
        self._tasks: Dict[str, asyncio.Task] = {}
        self._cancel: Dict[str, bool] = {}
        self._lock = asyncio.Lock()

    def is_running(self, job_id: str) -> bool:
        t = self._tasks.get(job_id)
        return bool(t and not t.done())

    def start_job(self, job_id: str) -> None:
        if job_id in self._tasks and not self._tasks[job_id].done():
            logger.info("batch_runner: job %s already running", job_id)
            return
        self._cancel.pop(job_id, None)
        task = asyncio.create_task(self._run(job_id), name=f"voice-studio-batch:{job_id}")
        self._tasks[job_id] = task
        task.add_done_callback(lambda t, jid=job_id: self._tasks.pop(jid, None))

    async def cancel(self, job_id: str) -> bool:
        if job_id not in self._tasks:
            return False
        self._cancel[job_id] = True
        return True

    # ── Internals ───────────────────────────────────────────────────────

    async def _run(self, job_id: str) -> None:
        store = get_batch_store()
        bus = get_event_bus()

        job = store.get(job_id)
        if not job:
            logger.error("batch_runner: job %s not found at start", job_id)
            return

        try:
            defaults: Dict[str, Any] = json.loads(job["defaults_json"])
            lines: List[Dict[str, Any]] = json.loads(job["lines_json"])
        except Exception as e:
            store.mark_failed(job_id, f"bad job json: {e}")
            await bus.publish("batch.failed", {"id": job_id, "reason": str(e)})
            return

        store.mark_running(job_id)
        await bus.publish("batch.started", {"id": job_id, "total": len(lines)})

        completed = 0
        errors = 0
        line_states: List[Dict[str, Any]] = []

        # Load engine handle once.
        from service.vtuber.tts.tts_service import get_tts_service
        engine = get_tts_service().get_engine("omnivoice")
        if engine is None:
            store.mark_failed(job_id, "OmniVoice engine not registered")
            await bus.publish("batch.failed", {"id": job_id, "reason": "omnivoice missing"})
            return

        for seq, line in enumerate(lines, start=1):
            if self._cancel.get(job_id):
                store.append_log(job_id, f"[seq {seq}] cancelled before start")
                break

            # Merge defaults <- per-line overrides
            params_dict = {**defaults, **{k: v for k, v in line.items() if v is not None and v != ""}}
            try:
                params = PreviewParams.model_validate(params_dict)
            except Exception as e:
                errors += 1
                store.append_log(job_id, f"[seq {seq}] invalid params: {e}")
                line_states.append({"seq": seq, "ok": False, "error": f"invalid params: {e}"})
                store.update_progress(job_id, completed=completed, errors=errors)
                await bus.publish(
                    "batch.progress",
                    {"id": job_id, "completed": completed, "errors": errors, "total": len(lines)},
                )
                continue

            if not params.text or not params.text.strip():
                errors += 1
                store.append_log(job_id, f"[seq {seq}] empty text")
                line_states.append({"seq": seq, "ok": False, "error": "empty text"})
                store.update_progress(job_id, completed=completed, errors=errors)
                await bus.publish(
                    "batch.progress",
                    {"id": job_id, "completed": completed, "errors": errors, "total": len(lines)},
                )
                continue

            try:
                result = await engine.synthesize_preview(params)
            except Exception as e:
                errors += 1
                logger.exception("batch_runner: synth failed seq=%d", seq)
                store.append_log(job_id, f"[seq {seq}] synth failed: {e}")
                line_states.append({"seq": seq, "ok": False, "error": str(e)})
                store.update_progress(job_id, completed=completed, errors=errors)
                await bus.publish(
                    "batch.progress",
                    {"id": job_id, "completed": completed, "errors": errors, "total": len(lines)},
                )
                continue

            audio_path = store.line_audio_path(job_id, seq)
            try:
                audio_path.write_bytes(result.audio_bytes)
            except OSError as e:
                errors += 1
                store.append_log(job_id, f"[seq {seq}] write failed: {e}")
                line_states.append({"seq": seq, "ok": False, "error": f"write: {e}"})
                store.update_progress(job_id, completed=completed, errors=errors)
                continue

            completed += 1
            line_states.append({
                "seq": seq,
                "ok": True,
                "audio": audio_path.name,
                "duration": result.duration,
                "rtf": result.rtf,
                "seed_used": result.seed_used,
            })
            store.update_progress(job_id, completed=completed, errors=errors)
            await bus.publish(
                "batch.progress",
                {"id": job_id, "completed": completed, "errors": errors, "total": len(lines)},
            )

        # Always try to write manifest + zip whatever lines were produced.
        cancelled = bool(self._cancel.get(job_id))
        try:
            manifest = {
                "job_id": job_id,
                "total_lines": len(lines),
                "completed_lines": completed,
                "error_lines": errors,
                "cancelled": cancelled,
                "defaults": defaults,
                "lines": line_states,
            }
            manifest_path = store.job_dir(job_id) / "manifest.json"
            manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
            zip_path = store.job_dir(job_id) / "result.zip"
            _make_zip(store.job_dir(job_id), zip_path)
        except Exception as e:
            store.mark_failed(job_id, f"zip stage: {e}")
            await bus.publish("batch.failed", {"id": job_id, "reason": str(e)})
            return

        if cancelled:
            store.mark_cancelled(job_id, str(zip_path))
            await bus.publish("batch.cancelled", {"id": job_id})
        else:
            store.mark_done(job_id, str(zip_path))
            await bus.publish("batch.done", {"id": job_id})

        self._cancel.pop(job_id, None)


def _make_zip(job_dir: Path, dst: Path) -> None:
    """Pack every file in ``job_dir`` (except an existing result.zip) into ``dst``."""
    if dst.exists():
        dst.unlink()
    with zipfile.ZipFile(dst, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for f in sorted(job_dir.iterdir()):
            if f.is_file() and f.name != dst.name:
                zf.write(f, arcname=f.name)


_runner: Optional[BatchRunner] = None


def get_batch_runner() -> BatchRunner:
    global _runner
    if _runner is None:
        _runner = BatchRunner()
    return _runner
