"""
Voice Studio Tools (Phase 4B) endpoints.

- ``POST /api/voice-studio/tools/detect-language`` — text → ISO code
- ``POST /api/voice-studio/tools/analyze-ref``     — wav upload → metrics
- ``POST /api/voice-studio/tools/seed-search``     — N seed samples
- ``GET  /api/voice-studio/tools/seed-search/{batch}/{seed}/audio`` — stream

Dependency-free (numpy only). Seed-search reuses the existing
``OmniVoiceEngine.synthesize_preview`` path; nothing is written to the
synthesis history (search results stay scoped to a batch dir under
``<voice_studio_data>/tools/seed_search/``).
"""

from __future__ import annotations

import secrets
from logging import getLogger
from pathlib import Path
from typing import List, Literal, Optional

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from service.voice_studio.history_store import _resolve_data_dir
from service.voice_studio.synthesis_preview import PreviewParams
from service.voice_studio.tools.language_detect import detect_language
from service.voice_studio.tools.ref_analyzer import MAX_INPUT_BYTES, analyze_ref

router = APIRouter()
logger = getLogger(__name__)


class DetectLanguageRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=5000)


@router.post("/tools/detect-language")
async def detect_language_route(body: DetectLanguageRequest) -> dict:
    return detect_language(body.text).to_dict()


@router.post("/tools/analyze-ref")
async def analyze_ref_route(file: UploadFile = File(...)) -> dict:
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="empty upload")
    if len(raw) > MAX_INPUT_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"wav too large: {len(raw)} > {MAX_INPUT_BYTES}",
        )
    try:
        result = analyze_ref(raw)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        logger.exception("analyze_ref failed")
        raise HTTPException(status_code=500, detail=f"analyze failed: {e}") from e
    return result.to_dict()


class SeedSearchRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=2000)
    profile: str = Field(..., min_length=1)
    emotion: str = "neutral"
    mode: Literal["clone", "design", "auto"] = "clone"
    language: Optional[str] = None
    num_step: Optional[int] = Field(default=None, ge=1, le=128)
    n: int = Field(default=5, ge=1, le=10)
    seeds: Optional[List[int]] = None


def _seed_search_dir() -> Path:
    base = _resolve_data_dir() / "tools" / "seed_search"
    base.mkdir(parents=True, exist_ok=True)
    return base


@router.post("/tools/seed-search")
async def seed_search_route(body: SeedSearchRequest) -> dict:
    from service.vtuber.tts.tts_service import get_tts_service

    engine = get_tts_service().get_engine("omnivoice")
    if engine is None:
        raise HTTPException(status_code=503, detail="OmniVoice engine not registered")

    seeds = (body.seeds[: body.n] if body.seeds else [
        int.from_bytes(secrets.token_bytes(4), "big") for _ in range(body.n)
    ])
    if not seeds:
        raise HTTPException(status_code=400, detail="no seeds resolved")

    batch_id = secrets.token_hex(8)
    out_dir = _seed_search_dir() / batch_id
    out_dir.mkdir(parents=True, exist_ok=True)

    results: List[dict] = []
    for seed in seeds:
        params_dict = {
            "text": body.text,
            "profile": body.profile,
            "emotion": body.emotion,
            "mode": body.mode,
            "language": body.language,
            "num_step": body.num_step,
            "seed": int(seed),
            "audio_format": "wav",
        }
        params_dict = {k: v for k, v in params_dict.items() if v is not None}
        params = PreviewParams.model_validate(params_dict)
        try:
            res = await engine.synthesize_preview(params)
        except Exception as e:
            logger.warning("seed-search: seed=%s failed: %s", seed, e)
            results.append({"seed": int(seed), "error": str(e)})
            continue
        out_path = out_dir / f"{int(seed)}.wav"
        out_path.write_bytes(res.audio_bytes)
        results.append({
            "seed": int(seed),
            "audio_url": f"/api/voice-studio/tools/seed-search/{batch_id}/{int(seed)}/audio",
            "duration": round(res.duration, 3),
            "rtf": round(res.rtf, 4),
            "seed_used": res.seed_used,
        })

    return {"batch_id": batch_id, "n": len(seeds), "results": results}


@router.get("/tools/seed-search/{batch_id}/{seed}/audio")
async def seed_search_audio(batch_id: str, seed: int) -> FileResponse:
    if "/" in batch_id or "\\" in batch_id or ".." in batch_id:
        raise HTTPException(status_code=400, detail="invalid batch id")
    path = _seed_search_dir() / batch_id / f"{int(seed)}.wav"
    if not path.exists():
        raise HTTPException(status_code=404, detail="seed audio not found")
    return FileResponse(
        str(path),
        media_type="audio/wav",
        headers={"Cache-Control": "private, max-age=60"},
    )
