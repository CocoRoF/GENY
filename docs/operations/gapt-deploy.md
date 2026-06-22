# Deploying GAPT alongside Geny (single host, behind Geny's nginx)

GAPT (`geny-adapted-project-toolkit`, vendored under [`gapt/`](../../gapt/)) is
the sandbox/project/devops platform Geny delegates project & workspace work to.
On the shared prod host it runs as its **own compose stack** on the `gapt-net`
docker network, fronted by **Geny's existing nginx** (no separate public edge).

See the design + rationale: [`../analysis/gapt-integration-plan.md`](../analysis/gapt-integration-plan.md).

## Topology (locked)

```
cloudflared ─▶ geny nginx (geny-x.hrletsgo.me)
                 ├─ /                → geny-frontend
                 ├─ /api             → geny-backend
                 ├─ /_gapt/*         → gapt-caddy (127.0.0.1:38080)  ── GAPT SPA + API
                 └─ /preview/<slug>/ → gapt-caddy (127.0.0.1:38080)  ── workspace previews
geny-backend ──(gapt-net)──▶ gapt-server:8088/_gapt/api   (GaptClient)
geny-backend ──(docker.sock)──▶ docker exec gapt-ws-<wid>  (executor ContainerCLIRunner)
```

GAPT's own cloudflared stays **off** (it lives behind the base compose's
`tunnel` profile — we never pass `--profile tunnel`). Caddy publishes only
`127.0.0.1:38080`; Geny's nginx proxies to it.

## ⚠️ Host hazard

This host runs **two** production stacks (Geny + new-web) and has a slow,
multi-GB buildkit cold-start. **Never `systemctl restart docker`** — it causes a
5–15 min outage of both stacks and Geny needs a manual `compose up -d`. Bringing
up GAPT is *additive* (new containers) and safe — no daemon restart. For
daemon.json changes use `systemctl reload docker` (SIGHUP). sysbox-runc is
already installed + enabled (see the integration plan's progress log).

## Prerequisites (host, one-time)

```bash
# 1) latest Geny main + the gapt submodule (gapt/ is a git submodule, so a
#    bare reset leaves it empty — sync it explicitly after).
cd /home/hrjang/docker_web/Geny && sudo git fetch origin && sudo git reset --hard origin/main
sudo git submodule sync --recursive
sudo git submodule update --init --recursive gapt   # populate/roll gapt/

# 2) workspace storage dirs, owned by uid 1000 (the gapt user)
sudo mkdir -p /workspace /var/lib/gapt-bare /home/hrjang/.claude
sudo chown -R 1000:1000 /workspace /var/lib/gapt-bare /home/hrjang/.claude

# 3) env file (secrets) — fill from .env.example, generate with: openssl rand -hex 32
cp deploy/gapt/.env.example deploy/gapt/.env && $EDITOR deploy/gapt/.env
#    set GAPT_DOCKER_GID to:  getent group docker | cut -d: -f3
```

## Bring up

```bash
cd /home/hrjang/docker_web/Geny
sudo docker compose \
  -f gapt/compose/docker-compose.tunnel.yml \
  -f deploy/gapt/docker-compose.geny.yml \
  --env-file deploy/gapt/.env up -d --build
# migrations run automatically (server entrypoint: alembic upgrade head)

# verify (on the host)
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:38080/health   # → 200
```

Also build the per-workspace sandbox image (used by `docker run --runtime=sysbox-runc`):

```bash
sudo docker build -f gapt/docker/workspace/Dockerfile -t gapt-workspace:latest gapt/docker/workspace
```

## nginx route (Geny → GAPT)

Add to the geny nginx server block (then `docker exec geny-nginx-prod nginx -s reload`):

```nginx
location /_gapt/   { proxy_pass http://127.0.0.1:38080; include /etc/nginx/proxy_params; proxy_buffering off; }
location /preview/ { proxy_pass http://127.0.0.1:38080; include /etc/nginx/proxy_params; proxy_buffering off; }
```

## Geny backend wiring (P3)

`geny-backend` joins `gapt-net` and mounts `/var/run/docker.sock` so it can call
the GAPT API and `docker exec` into workspace containers. See the compose
override in the main stack + `backend/service/gapt/`.

## Enable sessions-in-sandbox

Off by default. To route Geny sessions through a per-session GAPT workspace:

```bash
# Geny root .env
GENY_GAPT_WORKSPACES=1
sudo docker compose -f docker-compose.prod.yml up -d --no-deps --force-recreate backend
sudo docker exec geny-nginx-prod nginx -s reload
```

When set, `agent_session_manager` provisions a `gapt-ws-<session>` container per
session (best-effort; falls back to host exec on failure). The executor's
fs/shell tools then run inside that container via `docker exec` — for **all**
backends (claude_code_cli + the anthropic/openai/google SDK providers).

## Claude Code auth in workspaces

The `claude_code_cli` backend needs Geny's claude.ai login available inside the
workspace. GAPT bind-mounts `/home/hrjang/.claude` → `/home/ubuntu/.claude` in
each workspace; claude only needs `.credentials.json` there (it regenerates
`.claude.json` itself). Geny stores its login in the `geny-claude-creds-prod`
volume (`/root/.claude/.credentials.json`, refreshed in place).

Seed it once, then keep it fresh with a root cron (the token rotates; the copy
must track Geny's primary):

```bash
# one-time seed
sudo docker cp geny-backend-prod:/root/.claude/.credentials.json /home/hrjang/.claude/.credentials.json
sudo chown 1000:1000 /home/hrjang/.claude/.credentials.json

# periodic re-sync (root crontab) — keeps workspaces aligned to Geny's login
*/15 * * * * /usr/bin/docker cp geny-backend-prod:/root/.claude/.credentials.json /home/hrjang/.claude/.credentials.json >/dev/null 2>&1 && /bin/chown 1000:1000 /home/hrjang/.claude/.credentials.json
```

Verify inside a workspace: `claude auth status` → `loggedIn: true`. SDK backends
(anthropic/openai/…) don't need this — they use API keys from the cred bundle.
