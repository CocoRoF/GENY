# GAPT ⇄ Geny — how to test, and how it was transplanted

This is the practical companion to the design report
([`../analysis/gapt-integration-plan.md`](../analysis/gapt-integration-plan.md)).
It explains **(1) how to test** the live integration on the `:2222` host and
**(2) exactly how GAPT was transplanted** into `geny-executor` and `Geny`.

---

## 1. How to test

### 1a. The GAPT web UI (through Geny's domain)

GAPT's own SPA + API are served under Geny's host, behind nginx:

- **UI:** `https://geny-x.hrletsgo.me/_gapt/app/`
- **API health:** `https://geny-x.hrletsgo.me/_gapt/api/...` (cookie-auth)
- **Login:** id `admin`, password = `GAPT_ADMIN_PASSWORD` in
  `/home/hrjang/docker_web/Geny/deploy/gapt/.env` on the host:

  ```bash
  ssh -p 2222 hrjang@116.47.69.209 \
    "sudo grep GAPT_ADMIN_PASSWORD /home/hrjang/docker_web/Geny/deploy/gapt/.env"
  ```

From the UI you can create a project, create a workspace (a sandbox container),
browse files, open a terminal, run dev servers, and trigger previews/deploys —
all the GAPT capabilities, now hosted inside Geny.

### 1b. The Geny-session integration (agent runs *inside* a GAPT workspace)

This is the headline: a Geny agent session, when **sandbox mode** is on, runs
its `claude_code_cli` agent inside a GAPT workspace container instead of on the
host. It is **opt-in** (default off, so normal chat is untouched).

**Enable it** (one-time, on the host):

```bash
ssh -p 2222 hrjang@116.47.69.209
cd /home/hrjang/docker_web/Geny
# turn the flag on for the backend
sudo sed -i '/^GENY_GAPT_WORKSPACES=/d' .env; echo 'GENY_GAPT_WORKSPACES=1' | sudo tee -a .env
sudo docker compose -f docker-compose.prod.yml up -d --no-deps backend
sudo docker network connect gapt-net geny-backend-prod 2>/dev/null || true
```

**Then test from the Geny UI / connector:**
1. Start a new **Agent** session (claude_code_cli backend).
2. Ask it: *"create a file hello.txt with the text 'from the sandbox', then list the directory"*.
3. Verify the file landed **inside the GAPT workspace**, not on the host:
   - GAPT UI → the `geny` project → the workspace named after the session id →
     Files → `hello.txt`. **Or** on the host:
     ```bash
     # find the session's workspace container and look inside /workspace
     sudo docker ps --format '{{.Names}}' | grep '^gapt-ws-'
     sudo docker exec <gapt-ws-...> ls -la /workspace
     ```
4. Confirm it did **not** write to the Geny backend container's filesystem
   (the agent only sees `/workspace` in its own sandbox).

**Turn it back off:** set `GENY_GAPT_WORKSPACES=0` in `.env` and recreate the
backend. Any GAPT outage with the flag on falls back to host execution
(provisioning is best-effort), so the flag is safe to leave on.

### 1c. Direct verification (no UI) — the exact executor path

This is what the integration does internally, runnable from the host:

```bash
# provision a workspace + bring its container live (the executor's pre-spawn step)
sudo docker exec geny-backend-prod sh -lc 'cd /app && python -c "
import asyncio
from service.gapt import get_gapt_client, GaptWorkspaceProvider
async def main():
    c = get_gapt_client()
    h = await GaptWorkspaceProvider(c).ensure_workspace(project_slug=\"geny\", workspace_name=\"manual-test\")
    await h.ensure()
    print(h.container_name)
    await c.aclose()
asyncio.run(main())
"'
# then exec into it exactly as the executor's ContainerCLIRunner does:
WS=$(sudo docker ps --format '{{.Names}}' | grep '^gapt-ws-' | tail -1)
sudo docker exec geny-backend-prod docker exec -w /workspace "$WS" sh -c 'echo hi; pwd; whoami; claude --version'
# → hi / /workspace / ubuntu / 2.1.x (Claude Code) — running INSIDE the sandbox
```

### 1d. Cleanup of test workspaces

```bash
# list, then delete via the GAPT API (or the UI):
sudo docker exec geny-backend-prod sh -lc 'cd /app && python -c "
import asyncio
from service.gapt import get_gapt_client
async def main():
    c=get_gapt_client(); print(await c.list_workspaces(\"<project_id>\")); await c.aclose()
asyncio.run(main())"'
```

---

## 2. How it was transplanted (architecture)

"Sandboxing" was split into three layers, each homed where it belongs:

### L1 — the sandbox *execution primitive* → absorbed into **geny-executor**

The executor now owns "run the agent CLI inside a container", as first-class,
reusable API (no host-side hacks):

- `geny_executor.llm_client.ContainerCLIRunner` (2.21.0) — a `CLIProcessRunner`
  subclass whose `_spawn` becomes
  `docker exec -i -w <workdir> --env … <container> claude <argv>`. Inherits the
  timeout / SIGTERM→SIGKILL / stream-json machinery unchanged.
- `SandboxHandle` Protocol — the minimal thing it needs: `container_name` + an
  idempotent async `ensure()`.
- `build_container_cli_client(sandbox=…, **client_kwargs)` (2.21.0) — build a
  `ClaudeCodeCLIClient` whose every spawn runs in the container; the host no
  longer needs the agent binary installed (the launcher check moved to runtime,
  2.21.1).
- **`Pipeline.attach_runtime(sandbox=…)` (2.22.0)** — the host-friendly seam:
  attach a `SandboxHandle` and the pipeline wraps the `claude_code_cli` client
  it resolves *from the credential bundle* with `ContainerCLIRunner` — **reusing
  the exact kwargs it already computed** (api_key, mcp_config, allow_tools,
  workspace_dir, CLI MCP passthrough). SDK providers ignore it. (See
  `core/pipeline.py::_build_client_for`.)

GAPT's old bespoke `SandboxedCLIProcessRunner` was deleted and now imports this.

### L2 — the sandbox/project *platform* → **GAPT**, vendored into Geny

GAPT (Postgres-backed project/workspace/sandbox model, per-workspace containers,
git/fs/terminal/services/preview/deploy, 41-tool MCP) stays the owner and is wired
in as a **git submodule at `Geny/gapt/`** (tracks `main`; `git pull` auto-rolls it
via `.githooks/post-merge`; on a `git reset`-style deploy run
`git submodule update --init --recursive gapt`).
On `:2222` it runs as its **own compose stack** (`gapt-server` / `gapt-postgres`
/ `gapt-caddy` / redis / seaweedfs) on the `gapt-net` network, **behind Geny's
nginx** (`/_gapt`, `/preview` → `gapt-caddy`); GAPT's own cloudflared stays off.
Deploy: GAPT's tunnel compose + [`../../deploy/gapt/docker-compose.geny.yml`](../../deploy/gapt/docker-compose.geny.yml).
Workspace isolation runtime: `sysbox-runc` is installed on the host (used by
GAPT's `Sandbox` model; the persistent workspace container currently runs on
`runc` — passing `--runtime=sysbox-runc` to `WorkspaceSandbox` is a GAPT-side
refinement).

### L3 — *consumption* → **Geny** delegates

- `Geny/backend/service/gapt/` — `GaptClient` (async HTTP for `/_gapt/api/**`,
  single-admin cookie auth; the cookie is sent manually because GAPT marks it
  `Secure` and the jar would drop it over the internal http hop),
  `GaptWorkspaceProvider` (idempotent get-or-create project+workspace), and
  `GaptSandboxHandle` (satisfies the executor's `SandboxHandle`;
  `ensure()` runs a trivial command so GAPT brings the container live —
  `/start` is a no-op when already "running").
- `agent_session_manager.create_agent_session` — when `GENY_GAPT_WORKSPACES` is
  on and GAPT is reachable, provisions `project=geny / workspace=<session_id>`
  and passes the handle as `gapt_sandbox=`. Best-effort → falls back to host.
- `AgentSession._build_pipeline` — passes `attach_kwargs["sandbox"]=handle` to
  `attach_runtime` (executor ≥2.22.0). One line; the executor does the rest.
- `geny-backend` joins `gapt-net`, mounts `/var/run/docker.sock`, and carries
  the `docker` CLI — so `ContainerCLIRunner` can `docker exec` into the
  workspace, and `GaptClient` can reach `gapt-server`.

### End-to-end flow

```
Geny session create (flag on)
  └─ GaptWorkspaceProvider.ensure_workspace → GAPT creates project+workspace
       └─ GaptSandboxHandle(container=gapt-ws-<wid>)
  └─ AgentSession._build_pipeline → attach_runtime(sandbox=handle)
       └─ executor resolves claude_code_cli client + wraps it in ContainerCLIRunner
  per turn:
  └─ runner.ensure() → GAPT brings gapt-ws-<wid> live
  └─ docker exec -w /workspace gapt-ws-<wid> claude <argv>   (via docker.sock)
       └─ the agent's Read/Write/Bash/git all run INSIDE the sandbox /workspace
```

Geny keeps its moat (persona, voice, emotion, memory, sub-agents) host-side; only
the agent's code execution moves into the GAPT workspace.
