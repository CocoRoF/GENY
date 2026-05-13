#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
#  Whisper STT entrypoint
#
#  Boots vLLM's OpenAI-compatible API server with the transcription
#  task for openai/whisper-large-v3. The model loads lazily on the
#  first request, so the healthcheck `start_period` in docker-compose
#  is generous (600s) to absorb the first-time HF download.
#
#  Uses the `vllm serve` CLI shipped by the upstream image (in
#  /usr/local/bin/vllm). The earlier `python -m
#  vllm.entrypoints.openai.api_server` invocation broke on the
#  upstream image because it only ships `python3`, not a `python`
#  shim, and `exec python` aborts with `not found`.
# ──────────────────────────────────────────────────────────────────────
set -euo pipefail

MODEL="${WHISPER_MODEL:-openai/whisper-large-v3}"
PORT="${WHISPER_PORT:-8001}"
GPU_MEM_FRACTION="${WHISPER_GPU_MEMORY_FRACTION:-0.35}"
DTYPE="${WHISPER_DTYPE:-auto}"

echo "[whisper-stt] starting vLLM"
echo "[whisper-stt]   model    = ${MODEL}"
echo "[whisper-stt]   port     = ${PORT}"
echo "[whisper-stt]   gpu_frac = ${GPU_MEM_FRACTION}"
echo "[whisper-stt]   dtype    = ${DTYPE}"

# `--task transcription` was the explicit selector under vllm 0.7/0.8.
# vllm ≥ 0.10 introspects the model architecture and routes Whisper
# automatically to the audio/transcription path — the CLI rejects
# the flag now (`unrecognized arguments: --task transcription`).
# Loading the model alone is enough; the OpenAI-compatible
# /v1/audio/transcriptions endpoint comes up for free.
#
# `--enforce-eager` disables vLLM's inductor (torch.compile) +
# cudagraph capture pipeline. On the prod RTX 5070 (sm_120) the
# default VLLM_COMPILE path stalled at the "Using FLASH_ATTN
# attention backend" step and never made it to listening — the
# encoder-decoder + sm_120 + inductor combo hangs (or takes 30 min+
# even on a hot cache). Whisper-large-v3 at ~1.5 B params is small
# enough that eager mode gives us plenty of headroom on this GPU
# (RTF still well below 1 for 30 s chunks). Drop the flag if a
# future vllm release publishes precompiled kernels for Blackwell.
exec vllm serve "${MODEL}" \
    --host 0.0.0.0 \
    --port "${PORT}" \
    --gpu-memory-utilization "${GPU_MEM_FRACTION}" \
    --dtype "${DTYPE}" \
    --max-model-len 448 \
    --enforce-eager
