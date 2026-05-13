# ──────────────────────────────────────────────────────────────────────
#  Whisper STT — vLLM 기반 음성 전사 서비스
#
#  Hosts openai/whisper-large-v3 behind vLLM's OpenAI-compatible
#  /v1/audio/transcriptions endpoint. Profile-gated (audio-local)
#  alongside omnivoice on the same GPU.
#
#  GPU split (RTX 5070 / 12 GB):
#    omnivoice              0.50  (≈ 6 GB)
#    whisper-stt (this)     0.35  (≈ 4 GB)
#    ──────────────────────────────────────
#    total                  0.85  (≈ 10 GB) — 15% headroom for stability
#
#  Tuning: override WHISPER_GPU_MEMORY_FRACTION at deploy time if
#  the host has a different VRAM budget. Don't push the combined
#  fraction past 0.90.
# ──────────────────────────────────────────────────────────────────────

FROM nvidia/cuda:12.4.1-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# ffmpeg → resampling / format negotiation that vLLM's audio decoder
# needs. curl → image-level healthcheck. git → some HF model repos
# clone via git (fallback path inside transformers).
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 python3-pip python3-venv \
        ffmpeg curl git \
    && rm -rf /var/lib/apt/lists/*

# Isolate from the system python so a host package mismatch (e.g.
# ubuntu's python3 vs the wheels vLLM ships) doesn't poison the
# install.
RUN python3 -m venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH
RUN pip install --upgrade pip setuptools wheel

# vLLM 0.7.3 is the first release with stable whisper task support
# (per the vLLM docs the user referenced). Pinning exactly so we
# get the same code path every rebuild.
#
# transformers MUST be pinned to a 4.x release: vLLM 0.7.3 leaves
# the upper bound open, so a fresh build pulls transformers 5.x,
# whose WhisperTokenizer no longer exposes
# `all_special_tokens_extended` — vLLM 0.7.3 reads that attribute
# directly and the engine crashes on first boot. Verified on the
# prod server: transformers 5.8.1 → AttributeError, 4.48.x → boots.
# When upgrading vLLM later, re-check transformers compatibility in
# the same step.
RUN pip install --no-cache-dir \
        "vllm==0.7.3" \
        "transformers>=4.48.0,<4.49.0" \
        "librosa==0.10.2.post1" \
        "soundfile==0.12.1"

# HF model cache — bind to the docker volume so we don't re-download
# ~3 GB on every container rebuild.
ENV HUGGINGFACE_HUB_CACHE=/cache/huggingface \
    HF_HOME=/cache/huggingface \
    TRANSFORMERS_CACHE=/cache/huggingface
RUN mkdir -p /cache/huggingface

WORKDIR /app
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

EXPOSE 8001

# Healthcheck spec lives in docker-compose so it can vary per env
# (start_period in particular). Keep this image minimal.

ENTRYPOINT ["/app/entrypoint.sh"]
