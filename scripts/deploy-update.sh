#!/usr/bin/env bash
# Pull latest Geny + latest geny-avatar (always tracks origin/main, not
# the pinned commit), then rebuild the avatar-editor + backend
# containers.  Designed for the prod server's update flow — run as
# the user that owns docker (typically root or via sudo).
#
# Why `--remote` instead of plain `submodule update`:
#   The default submodule update checks out the commit recorded in the
#   parent repo's index. That means Geny has to bump the submodule
#   pointer + commit + push every time geny-avatar pushes a fix —
#   double bookkeeping for fast-iteration hobby work. With `--remote`
#   git fetches the submodule's `branch` (set in .gitmodules to `main`)
#   and fast-forwards, so the server always rolls with whatever
#   geny-avatar's main is right now.
#
# Trade-off: on the dev machine, `git status` will show
#   "modified: vendor/geny-avatar (new commits)" when the submodule is
#   ahead of the recorded pin. That's expected here. Don't `git add`
#   that change unless you want to lock the pin (e.g., for a release).

set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> git pull"
git pull --ff-only

echo "==> submodule update --remote (latest main of geny-avatar)"
git submodule update --init --recursive --remote

echo "==> submodule status"
git submodule status

# Default to the prod compose unless caller overrides.
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
PROFILES="${PROFILES:---profile tts-local}"
SERVICES="${SERVICES:-avatar-editor backend}"

echo "==> docker compose up -d --build  (file=${COMPOSE_FILE}, services=${SERVICES})"
# shellcheck disable=SC2086 # word-splitting on PROFILES is intentional
docker compose -f "${COMPOSE_FILE}" ${PROFILES} up -d --build ${SERVICES}

echo "==> done. status:"
docker ps --filter name=geny --format 'table {{.Names}}\t{{.Status}}'
