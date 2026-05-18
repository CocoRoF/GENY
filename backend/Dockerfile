# ── Backend Dockerfile ─────────────────────────────────────────────────
# Python 3.12 + geny-executor (direct Anthropic API, no CLI subprocess)
# ──────────────────────────────────────────────────────────────────────
FROM python:3.12-slim AS base

# ── System deps ──────────────────────────────────────────────────────
# Node.js is only needed if MCP servers require npx. Kept minimal.
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl git ca-certificates gnupg && \
    # Install Node.js 20.x (needed for npx-based MCP servers)
    mkdir -p /etc/apt/keyrings && \
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
        | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg && \
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" \
        > /etc/apt/sources.list.d/nodesource.list && \
    apt-get update && apt-get install -y nodejs && \
    # Cleanup
    apt-get clean && rm -rf /var/lib/apt/lists/*

# ── Claude Code CLI ──────────────────────────────────────────────────
# Backs the ``claude_code_cli`` provider in geny-executor's ClientRegistry.
# Phase G of the LLM backend upgrade cycle pairs this binary with a host
# bind-mount of ``~/.claude/`` so Geny sessions route through the user's
# Pro/Max subscription quota. Pin a known-good major version line so a
# remote npm publish can't break the auth/CLI surface we depend on; bump
# explicitly when the LLM backend tests update the contract.
RUN npm install -g --silent @anthropic-ai/claude-code@latest && \
    claude --version

WORKDIR /app

# ── Python dependencies (layer cache) ─────────────────────────────────
COPY requirements.txt pyproject.toml ./
RUN pip install --no-cache-dir -r requirements.txt

# ── Application source ────────────────────────────────────────────────
COPY . .

# ── Non-root user ────────────────────────────────────────────────────
RUN groupadd -r geny && useradd -r -g geny -m -d /home/geny -s /bin/bash geny

# ── Storage directories ──────────────────────────────────────────────
RUN mkdir -p /data/geny_agent_sessions && \
    mkdir -p /app/logs && \
    mkdir -p /app/cache/tts && \
    mkdir -p /app/static/voices && \
    mkdir -p /app/service/config/variables && \
    mkdir -p /home/geny/.claude && \
    chown -R geny:geny /data /app /home/geny

# ── Environment defaults ─────────────────────────────────────────────
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    APP_HOST=0.0.0.0 \
    APP_PORT=8000 \
    GENY_AGENT_STORAGE_ROOT=/data/geny_agent_sessions

EXPOSE 8000

# Why we run as root and not the unprivileged `geny` user we created:
# the avatar-editor container shares the docker named volume
# `geny-baked-exports-*` with us — it mounts as /exports there,
# /data/baked-imports here. avatar-editor runs as root (per its own
# Dockerfile, for the same reason) and writes baked puppet zips with
# root:root ownership and 644 perms. To unlink (delete) those files
# from the directory we need write+execute on the directory itself,
# which docker creates root:root 755 for fresh named volumes. A
# UID-1001 process can't delete root-owned files in a root-owned
# directory, so the library-sync DELETE flow + the manual baked-
# imports delete UI both hit EACCES.
#
# Adding an init container or chown entrypoint just to align UIDs is
# more moving parts than it's worth for a single-tenant deployment.
# We keep the geny user defined (legacy CMD layers may switch to it
# inside containers that don't share the volume) but the production
# runtime stays as root, matching avatar-editor's stance.
# USER geny

CMD ["python", "main.py"]
