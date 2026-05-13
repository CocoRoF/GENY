#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
#  Whisper STT entrypoint
#
#  Boots vLLM's OpenAI-compatible API server with the transcription
#  task for openai/whisper-large-v3. The model loads lazily on the
#  first request, so the healthcheck `start_period` in docker-compose
#  is generous (600s) to absorb the first-time HF download.
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

exec python -m vllm.entrypoints.openai.api_server \
    --model "${MODEL}" \
    --host 0.0.0.0 \
    --port "${PORT}" \
    --task transcription \
    --gpu-memory-utilization "${GPU_MEM_FRACTION}" \
    --dtype "${DTYPE}" \
    --max-model-len 448
