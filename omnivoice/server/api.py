"""HTTP routes for the geny-omnivoice service."""

from __future__ import annotations

import base64
import json
import logging
from importlib.metadata import PackageNotFoundError, version
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response
from fastapi.responses import StreamingResponse

from server import engine, voices
from server.schemas import (
    HealthResponse,
    LanguagesResponse,
    ServiceInfoResponse,
    TTSRequest,
    TTSStreamRequest,
    VoicesResponse,
)
from server.settings import Settings, get_settings
from server.streaming import encode, media_type_for
from server.text_split import split_sentences

logger = logging.getLogger(__name__)

router = APIRouter()


def _service_version() -> str:
    try:
        return version("geny-omnivoice")
    except PackageNotFoundError:  # pragma: no cover - editable installs
        return "0.0.0+local"


@router.get("/", response_model=ServiceInfoResponse)
def root(settings: Annotated[Settings, Depends(get_settings)]) -> ServiceInfoResponse:
    return ServiceInfoResponse(
        service="geny-omnivoice",
        version=_service_version(),
        model=settings.model,
        device=settings.device,
        dtype=settings.dtype,
    )


@router.get("/health", response_model=HealthResponse)
def health(settings: Annotated[Settings, Depends(get_settings)]) -> HealthResponse:
    phase = engine.get_phase()
    # ``status`` is the legacy field; collapse intermediate phases to
    # ``loading`` so old clients that only inspect ``status`` keep
    # working. New clients should consume ``phase`` directly.
    if phase == "ok":
        legacy_status: str = "ok"
    elif phase == "error":
        legacy_status = "error"
    else:
        legacy_status = "loading"

    if not engine.is_loaded():
        return HealthResponse(
            status=legacy_status,  # type: ignore[arg-type]
            phase=phase,  # type: ignore[arg-type]
            model=settings.model,
            device=settings.device,
            dtype=settings.dtype,
            sampling_rate=0,
            auto_asr=settings.auto_asr,
            max_concurrency=settings.max_concurrency,
        )
    state = engine.get_state()
    return HealthResponse(
        status=legacy_status,  # type: ignore[arg-type]
        phase=phase,  # type: ignore[arg-type]
        model=settings.model,
        device=settings.device,
        dtype=settings.dtype,
        sampling_rate=state.sampling_rate,
        auto_asr=settings.auto_asr,
        max_concurrency=settings.max_concurrency,
    )


@router.get("/voices", response_model=VoicesResponse)
def get_voices(settings: Annotated[Settings, Depends(get_settings)]) -> VoicesResponse:
    return VoicesResponse(voices=voices.list_profiles(settings.voices_dir))


@router.get("/languages", response_model=LanguagesResponse)
def get_languages() -> LanguagesResponse:
    from omnivoice_core.utils.lang_map import LANG_NAMES

    return LanguagesResponse(languages=sorted(LANG_NAMES))


@router.post("/tts")
async def tts(req: TTSRequest) -> Response:
    if not engine.is_loaded():
        raise HTTPException(status_code=503, detail="model_not_ready")

    try:
        audio, sample_rate = await engine.synthesize(
            text=req.text,
            mode=req.mode,
            ref_audio_path=req.ref_audio_path,
            ref_text=req.ref_text,
            instruct=req.instruct,
            language=req.language,
            speed=req.speed,
            duration=req.duration,
            num_step=req.num_step,
            guidance_scale=req.guidance_scale,
            denoise=req.denoise,
            preprocess_prompt=req.preprocess_prompt,
            postprocess_output=req.postprocess_output,
            seed=req.seed,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Synthesis failed")
        raise HTTPException(status_code=500, detail=f"synthesis_failed: {exc}") from exc

    body = encode(audio, sample_rate, req.audio_format)
    headers = {
        "X-OmniVoice-Sample-Rate": str(sample_rate),
        "X-OmniVoice-Mode": req.mode,
    }
    return Response(content=body, media_type=media_type_for(req.audio_format), headers=headers)


@router.post("/tts/stream")
async def tts_stream(req: TTSStreamRequest) -> StreamingResponse:
    """Sentence-streaming TTS — yields one NDJSON frame per sentence.

    Wire format (each line a complete JSON object, newline-terminated):

    * ``{"seq": 0, "text": "Hello.", "format": "wav", "sample_rate": 24000,
      "audio_b64": "<base64 of WAV bytes>", ...}``
    * ``{"seq": 1, "text": "How are you?", ...}``
    * ``{"done": true, "total": 2, "sample_rate": 24000}``
      — terminator frame so clients know the stream finished cleanly.

    On a per-sentence error: a ``{"seq": N, "error": "..."}`` frame is
    emitted but the loop continues; subsequent sentences are still
    streamed. The terminator frame still includes the per-sentence
    success ``total``.

    Latency model: client receives sentence #1 once it's fully
    synthesised (single-GPU semaphore prevents pipelining), then #2,
    etc. For a 3-sentence response that would take ~25s as a single
    /tts call, the listener now hears speech start at ~8s instead.
    """
    if not engine.is_loaded():
        raise HTTPException(status_code=503, detail="model_not_ready")

    sentences = split_sentences(req.text, max_chars=req.max_sentence_chars)
    if not sentences:
        raise HTTPException(status_code=400, detail="empty_text")

    sample_rate = req.sample_rate
    media = media_type_for(req.audio_format)

    async def _gen():
        success = 0
        for seq, sentence in enumerate(sentences):
            sentence_seed = (
                req.seed + seq if (req.seed is not None and req.seed_jitter)
                else req.seed
            )
            try:
                audio, sr = await engine.synthesize(
                    text=sentence,
                    mode=req.mode,
                    ref_audio_path=req.ref_audio_path,
                    ref_text=req.ref_text,
                    instruct=req.instruct,
                    language=req.language,
                    speed=req.speed,
                    duration=None,  # let model size each sentence naturally
                    num_step=req.num_step,
                    guidance_scale=req.guidance_scale,
                    denoise=req.denoise,
                    preprocess_prompt=req.preprocess_prompt,
                    postprocess_output=req.postprocess_output,
                    seed=sentence_seed,
                )
                body = encode(audio, sr, req.audio_format)
                frame = {
                    "seq": seq,
                    "text": sentence,
                    "format": req.audio_format,
                    "media_type": media,
                    "sample_rate": int(sr),
                    "n_samples": int(audio.size),
                    "audio_b64": base64.b64encode(body).decode("ascii"),
                }
                success += 1
            except Exception as exc:  # pragma: no cover - logged below
                logger.exception("streaming sentence %d failed", seq)
                frame = {"seq": seq, "text": sentence, "error": str(exc)}
            yield (json.dumps(frame, ensure_ascii=False) + "\n").encode("utf-8")
        terminator = {
            "done": True,
            "total": success,
            "requested": len(sentences),
            "sample_rate": int(sample_rate),
        }
        yield (json.dumps(terminator) + "\n").encode("utf-8")

    return StreamingResponse(
        _gen(),
        media_type="application/x-ndjson",
        headers={
            "X-OmniVoice-Streaming": "sentence-ndjson",
            "X-OmniVoice-Sample-Rate": str(sample_rate),
            "X-OmniVoice-Sentence-Count": str(len(sentences)),
            "Cache-Control": "no-cache",
        },
    )
