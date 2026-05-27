"""
Voice Studio batch synthesis endpoints.

- ``POST   /api/voice-studio/batch``                   — start a new job
- ``GET    /api/voice-studio/batch``                   — list recent (cap 20)
- ``GET    /api/voice-studio/batch/{job_id}``          — single job snapshot
- ``POST   /api/voice-studio/batch/{job_id}/cancel``   — request cancel
- ``GET    /api/voice-studio/batch/{job_id}/download`` — result zip

Each line spawns one ``synthesize_preview`` call via
``OmniVoiceEngine``; concurrency is governed by omnivoice's own
``OMNIVOICE_MAX_CONCURRENCY`` semaphore so we don't need a second
layer here.
"""

from __future__ import annotations

from logging import getLogger
from typing import List, Literal, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from service.voice_studio.batch_runner import get_batch_runner
from service.voice_studio.batch_store import get_batch_store

router = APIRouter()
logger = getLogger(__name__)

MAX_LINES_PER_JOB = 500


class BatchLine(BaseModel):
    text: str
    profile: Optional[str] = None
    emotion: Optional[str] = None
    seed: Optional[int] = Field(default=None, ge=0)
    instruct: Optional[str] = None
    language: Optional[str] = None
    mode: Optional[Literal["clone", "design", "auto"]] = None


class BatchStartRequest(BaseModel):
    label: Optional[str] = None
    # Shared defaults — same shape as PreviewParams, mostly optional.
    profile: Optional[str] = None
    emotion: Optional[str] = "neutral"
    mode: Literal["clone", "design", "auto"] = "clone"
    language: Optional[str] = None
    instruct: Optional[str] = None
    num_step: Optional[int] = Field(default=None, ge=1, le=128)
    guidance_scale: Optional[float] = Field(default=None, ge=0.0, le=10.0)
    speed: Optional[float] = Field(default=1.0, gt=0.0, le=4.0)
    audio_format: Literal["wav", "mp3", "ogg", "pcm"] = "wav"
    sample_rate: Optional[int] = Field(default=None, ge=8000, le=48000)
    auto_asr: Optional[bool] = None
    denoise: Optional[bool] = None
    lines: List[BatchLine]


def _serialize_job(row: dict) -> dict:
    """Trim a raw DB row down to the shape the API exposes."""
    return {
        "id": row["id"],
        "created_at": row["created_at"],
        "started_at": row.get("started_at"),
        "finished_at": row.get("finished_at"),
        "state": row["state"],
        "total_lines": row["total_lines"],
        "completed_lines": row.get("completed_lines", 0),
        "error_lines": row.get("error_lines", 0),
        "label": row.get("label"),
        "log_text": row.get("log_text") or "",
        "has_zip": bool(row.get("zip_path")),
    }


@router.post("/batch")
async def start_batch(body: BatchStartRequest) -> dict:
    if not body.lines:
        raise HTTPException(status_code=400, detail="lines must not be empty")
    if len(body.lines) > MAX_LINES_PER_JOB:
        raise HTTPException(
            status_code=400,
            detail=f"too many lines: {len(body.lines)} > {MAX_LINES_PER_JOB}",
        )

    # Extract shared defaults; serialised verbatim into the job row.
    defaults = body.model_dump(exclude={"lines"}, exclude_none=True)
    lines = [line.model_dump(exclude_none=True) for line in body.lines]

    store = get_batch_store()
    job_id = store.insert(
        defaults=defaults,
        lines=lines,
        label=body.label,
    )

    runner = get_batch_runner()
    runner.start_job(job_id)

    return {"job_id": job_id, "state": "queued", "total_lines": len(lines)}


@router.get("/batch")
async def list_batches() -> dict:
    store = get_batch_store()
    jobs = [_serialize_job(j) for j in store.list_recent(limit=20)]
    return {"jobs": jobs, "count": len(jobs)}


@router.get("/batch/{job_id}")
async def get_batch(job_id: str) -> dict:
    store = get_batch_store()
    row = store.get(job_id)
    if not row:
        raise HTTPException(status_code=404, detail=f"batch job not found: {job_id}")
    return _serialize_job(row)


@router.post("/batch/{job_id}/cancel")
async def cancel_batch(job_id: str) -> dict:
    store = get_batch_store()
    row = store.get(job_id)
    if not row:
        raise HTTPException(status_code=404, detail=f"batch job not found: {job_id}")
    runner = get_batch_runner()
    ok = await runner.cancel(job_id)
    return {"ok": ok}


@router.get("/batch/{job_id}/download")
async def download_batch(job_id: str) -> FileResponse:
    store = get_batch_store()
    row = store.get(job_id)
    if not row:
        raise HTTPException(status_code=404, detail=f"batch job not found: {job_id}")
    zip_path = row.get("zip_path")
    if not zip_path:
        raise HTTPException(status_code=409, detail="zip not ready yet")
    return FileResponse(
        zip_path,
        media_type="application/zip",
        filename=f"voicestudio-batch-{job_id}.zip",
        headers={"Cache-Control": "private, max-age=60"},
    )
