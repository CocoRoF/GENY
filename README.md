![](img/Geny_full_logo.png)
# 🧞 Geny — *Geny Execute, Not You*

> 지니가 할게, 넌 가만히 있어.

A multi-agent VTuber + autonomous worker platform. Pair a chatty Live2D / Spine VTuber with a tool-running Sub-Worker, watch them collaborate inside a 3D city, swap any of five LLM backends with one config click.

[한국어 README](README_ko.md) · [Architecture](docs/architecture.md) · [LLM Providers](docs/providers.md) · [Sessions & Delegation](docs/sessions.md) · [Environments](docs/environments.md) · [Error Codes](docs/error_codes.md)

---

## What Geny is

| Concept | What it does |
|---|---|
| **VTuber session** | The conversational face. Live2D / Spine avatar, persona prompt, TTS, emotion tags. Talks to the user; delegates real work to a paired Sub-Worker. |
| **Sub-Worker session** | The execution layer. Tool-using agent — file ops, shell, web fetch, MCP-bridged host tools. Reports results back through structured `[SUB_WORKER_RESULT]` messages. |
| **Environment** | A serialisable [`EnvironmentManifest`](docs/environments.md) that pins every pipeline stage + provider + tool set. One artifact, deterministic reproduction. |
| **3D City Playground** | Three.js / React Three Fiber dashboard — agents appear as characters walking a procedural city. |
| **Five LLM backends** | `anthropic` / `openai` / `google` / `vllm` (self-host) / `claude_code_cli` — switch per env, no code change. |
| **Stable error codes** | Every executor failure surfaces with a stable `exec.<component>.<reason>` code. Frontend renders localised, actionable Korean / English prompts. |

The backend is built on [`geny-executor 2.1.0`](https://github.com/CocoRoF/geny-executor) — a 21-stage manifest-driven agent pipeline (no LangChain, no LangGraph). The frontend is Next.js 16 with R3F-powered 3D, Pixi.js for whiteboard / 2D overlays, and a Korean/English i18n layer.

---

## Architecture (high level)

```
┌────────────────────────── Geny ──────────────────────────────────┐
│                                                                  │
│  Frontend (Next.js 16 + R3F + Pixi)                              │
│   ├── 3D City Playground (Three.js / R3F)                        │
│   ├── VTuber chat panel + Live2D / Spine avatar                  │
│   ├── Environment editor (21-stage manifest UI)                  │
│   ├── LLM Backends settings (5 provider cards)                   │
│   ├── Memory / Knowledge / Whiteboard tabs                       │
│   └── Logs tab (i18n'd error codes, tool traces, stage events)   │
│                                                                  │
│  Backend (FastAPI)                                               │
│   ├── controller/  ← FastAPI routes (sessions, env, vtuber, …)   │
│   ├── service/                                                   │
│   │   ├── executor/    ← geny-executor 2.1.0 hookup              │
│   │   ├── environment/ ← manifest store + templates              │
│   │   ├── llm_patches/ ← Korean error envelopes + CLI tool tap   │
│   │   ├── memory/      ← session memory v2 + vector retrieval    │
│   │   ├── permission/  ← per-tool ACL evaluator                  │
│   │   ├── vtuber/      ← Live2D / Spine library + thinking-trig  │
│   │   └── chat/        ← chat-room store + delegation routing    │
│   ├── tools/  ← auto-loaded Python tools (send DM, memory, …)    │
│   ├── mcp/    ← auto-loaded MCP server configs                   │
│   ├── scripts/geny_mcp_bridge.py ← per-session MCP wrap for CLI  │
│   └── prompts/  ← role markdown (vtuber.md, worker.md, …)        │
│                                                                  │
│  geny-executor 2.1.0  (PyPI dep)                                 │
│   ├── 21-stage agent pipeline                                    │
│   ├── 5 LLM client implementations                               │
│   └── ExecutorErrorCode taxonomy                                 │
└──────────────────────────────────────────────────────────────────┘
```

Full architecture writeup → [`docs/architecture.md`](docs/architecture.md).

---

## Key features

### 🎭 VTuber ↔ Sub-Worker pairing
Every VTuber session is auto-paired with a Sub-Worker. The VTuber handles conversation and personality; the Sub-Worker does real work. Delegation flows through a single MCP-bridged tool (`mcp__geny__send_direct_message_internal`) — see [`docs/sessions.md`](docs/sessions.md).

### 🧠 Five LLM backends, one selector
Settings → LLM Backends gives each of the 5 providers (Anthropic / OpenAI / Google / vLLM / Claude Code CLI) its own card with health probe + auth flow. Stage 6 of any environment picks one via dropdown — see [`docs/providers.md`](docs/providers.md).

### 🛠️ Manifest-driven environments
Pipelines are defined as `EnvironmentManifest` JSON artifacts — 21 stages, one strategy per slot, version-controlled. The Environment editor in the UI lets you customise any preset (worker / VTuber / Sub-Worker) without touching code — see [`docs/environments.md`](docs/environments.md).

### 🌐 Per-session MCP wrap (Claude Code CLI)
When a session pins `claude_code_cli` as its Stage 6 backend, Geny attaches a per-session MCP bridge so the spawned CLI's LLM sees **Geny's tool registry** as `mcp__geny__<tool>` — file ops, web fetch, memory, blog publisher, sub-worker delegation — all callable natively inside the CLI's agentic loop.

### 🏷️ Stable error codes + i18n
Every executor exception carries a stable `exec.<component>.<reason>` code. The session log renders the matching Korean (or English) message + recommended next step instead of the raw English server error — see [`docs/error_codes.md`](docs/error_codes.md).

### 🏙️ 3D city playground
Active sessions appear as walking characters in a procedural Kenney-asset city. A* pathfinding, bone-animated avatars, time-of-day cycle. R3F + Drei + Three.js.

### 🎨 Live2D + Spine + AI-baked avatars
Geny ships with a separate puppet-editor service ([`geny-avatar`](https://github.com/CocoRoF/geny-avatar)) wired in as a git submodule. Upload a Spine or Cubism puppet, decompose layers, paint masks, regenerate textures with AI, and bake the model straight into Geny's VTuber library.

### 🔊 TTS / STT / voice notes
edge-tts for output, Whisper for input, OmniVoice integration for multi-speaker scenes. Voice-notes feature lets users dictate into the whiteboard.

### 📚 Knowledge whiteboard + memory v2
Session memory routed through `geny-executor`'s Stage 2 (Context) + Stage 18 (Memory) — progressive disclosure, vault map, vector retrieval. Knowledge whiteboard exposes a collaborative Pixi.js canvas for diagram-style sessions.

### 🤖 Multi-pod ready
Redis-backed session metadata sharding lets multiple backend pods serve one user — useful for cloud deployments.

---

## Project structure

```
geny/
├── README.md / README_ko.md          # this hub
├── img/                              # logos and screenshots
├── docs/                             # topic-page docs (architecture, sessions, …)
├── backend/                          # FastAPI + geny-executor host
│   ├── main.py                       # app entry + executor wiring
│   ├── pyproject.toml                # pins geny-executor >= 2.1.0
│   ├── controller/                   # FastAPI routes
│   │   ├── agent_controller.py       # session + stream + invoke
│   │   ├── llm_backends_controller.py# 5-provider health + auth
│   │   ├── mcp_bridge_controller.py  # per-session MCP RPC
│   │   ├── vtuber_*.py               # VTuber library + chat + thinking
│   │   ├── memory_*.py               # memory + knowledge + opsidian
│   │   ├── chat_controller.py        # chat-room CRUD
│   │   ├── environment_controller.py # manifest editor backend
│   │   └── …                         # cron, whiteboard, voice-notes, ...
│   ├── service/
│   │   ├── executor/                 # AgentSessionManager + AgentSession
│   │   ├── environment/              # manifest store + templates
│   │   ├── llm_patches.py            # Korean error envelopes + CLI tool tap
│   │   ├── memory/                   # session memory v2
│   │   ├── permission/               # per-tool ACL
│   │   ├── vtuber/                   # Live2D / Spine library + triggers
│   │   ├── chat/                     # chat-room store + delegation routing
│   │   ├── config/                   # ConfigManager + settings cards
│   │   ├── logging/                  # SessionLogger (now with error_code)
│   │   └── …
│   ├── tools/                        # auto-loaded Python tools
│   │   ├── built_in/                 # ships: messaging, memory, knowledge
│   │   └── custom/                   # web_search, browser, whiteboard, blog
│   ├── mcp/                          # auto-loaded MCP server configs
│   ├── scripts/geny_mcp_bridge.py    # stdio bridge for CLI MCP wrap
│   └── prompts/                      # role markdown (vtuber.md, worker.md, …)
├── frontend/                         # Next.js 16 + R3F + Pixi
│   └── src/
│       ├── components/               # tabs, modals, panels, env_management/…
│       ├── lib/                      # api.ts, i18n/, modelCatalog.ts, …
│       ├── store/                    # Zustand stores
│       └── types/                    # shared TypeScript types
├── vendor/geny-avatar/               # puppet-editor submodule
└── docker-compose.{yml,dev,prod}.yml # compose stacks
```

For the developer-facing internal architecture maps see [`backend/docs/`](backend/docs/) and [`docs/architecture.md`](docs/architecture.md).

---

## Tech stack

| Layer | Technology |
|---|---|
| **Frontend** | Next.js 16, React 19, TypeScript, Tailwind CSS v4, Zustand 5, Pixi.js |
| **3D engine** | Three.js, React Three Fiber, Drei |
| **Avatars** | Live2D Cubism, Spine 4, [geny-avatar](https://github.com/CocoRoF/geny-avatar) editor |
| **Backend** | Python 3.11+, FastAPI, Uvicorn |
| **Agent pipeline** | [`geny-executor 2.1.0`](https://github.com/CocoRoF/geny-executor) (21 stages, 5 providers) |
| **LLM SDKs** | `anthropic`, `openai`, `google-genai` + vLLM (OpenAI-compatible) + Claude Code CLI subprocess |
| **MCP** | host-attached servers + per-session CLI MCP wrap |
| **TTS / STT** | edge-tts (output), Whisper (input), OmniVoice (multi-speaker) |
| **Persistence** | PostgreSQL (sessions, memory, knowledge), Redis (multi-pod metadata, optional) |
| **Container** | Docker Compose (dev / prod profiles + named volumes for OAuth credential survival) |

---

## Installation

### 🐳 Docker (recommended)

```bash
# 1. Clone with submodules (geny-avatar + geny-licensed-assets)
git clone --recurse-submodules https://github.com/CocoRoF/Geny.git
cd Geny

# 2. Configure
cp backend/.env.example backend/.env
# Edit backend/.env — at minimum set ANTHROPIC_API_KEY (or use OAuth via Settings)

# 3. Run
docker compose up --build
```

Open **http://localhost:3000**.

Compose profiles:

| File | Use |
|---|---|
| `docker-compose.yml` | Default dev stack |
| `docker-compose.dev.yml` / `dev-core.yml` | Dev with hot-reload bind mounts |
| `docker-compose.prod.yml` / `prod-core.yml` | Production behind nginx |

Custom ports + data dirs documented in [`docs/architecture.md`](docs/architecture.md).

### Manual setup

For non-Docker development see the expandable section in [`docs/architecture.md`](docs/architecture.md). Minimum requirements: Python 3.11+, Node.js 18+, Claude Code CLI (`npm i -g @anthropic-ai/claude-code`), and at least one provider's credentials.

---

## Avatar Editor (geny-avatar)

Geny ships with a Next.js puppet-editor service ([`geny-avatar`](https://github.com/CocoRoF/geny-avatar)) wired in as a git submodule under `vendor/geny-avatar`. Upload a Spine or Cubism puppet, decompose layers, paint masks, regenerate textures with AI (gpt-image-2 / SAM), and bake the model directly into Geny's VTuber library (appears with the `(Editor)` suffix).

`vendor/geny-avatar` tracks `main` via a versioned `post-merge` hook ([`.githooks/post-merge`](.githooks/post-merge)) — the server fast-forwards the submodule on every `git pull` without a pointer-bump dance.

```bash
git config core.hooksPath .githooks       # one-time per clone
git pull                                  # fast-forwards vendor/geny-avatar
docker compose -f docker-compose.prod.yml --profile tts-local up -d --build avatar-editor backend
```

Detailed integration → [`docs/_archive/`](docs/_archive/) (geny-avatar integration sprints).

---

## Environment variables

Configure in `backend/.env`:

| Variable | Description | Default |
|---|---|---|
| `APP_HOST` | Server bind address | `0.0.0.0` |
| `APP_PORT` | Server port | `8000` |
| `DEBUG_MODE` | Verbose logging | `false` |
| `ANTHROPIC_API_KEY` | Anthropic key (or use OAuth via Settings) | — |
| `OPENAI_API_KEY` | OpenAI key (or paste via Settings) | — |
| `GOOGLE_API_KEY` | Google GenAI key | — |
| `GITHUB_TOKEN` | GitHub PAT for PR automation | — |
| `USE_REDIS` | Enable Redis multi-pod metadata | `false` |
| `REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD` | Redis | `localhost` / `6379` / — |
| `GENY_AGENT_STORAGE_ROOT` | Session storage path | `/data/geny_agent_sessions` (Docker) |

Frontend's `API_URL` env (shell, build-time) overrides the backend target — see [`docs/architecture.md`](docs/architecture.md).

---

## Quick API tour

Geny exposes REST + SSE under `/api/`. The most commonly used:

```bash
# Create a VTuber session (auto-pairs a Sub-Worker)
curl -X POST http://localhost:8000/api/sessions \
  -H "Content-Type: application/json" \
  -d '{
    "session_name": "geny-1",
    "role": "vtuber",
    "env_id": "template-vtuber-env",
    "character_display_name": "Geny"
  }'

# List sessions
curl http://localhost:8000/api/sessions

# Send a chat message to the VTuber (auto-delegates to Sub-Worker for complex tasks)
curl -X POST http://localhost:8000/api/chat/rooms/<room_id>/messages \
  -H "Content-Type: application/json" \
  -d '{"content": "test.txt 만들어서 자기소개 적어놔"}'

# Stream session logs (SSE)
curl -N http://localhost:8000/api/command/logs/<session_id>/stream
```

| Endpoint family | Purpose |
|---|---|
| `/api/sessions` | Session CRUD + status |
| `/api/agent/sessions/{id}/invoke` | One-shot invoke |
| `/api/command/logs/{id}/stream` | SSE log stream (carries error_code for i18n) |
| `/api/chat/rooms/*` | Chat-room store (VTuber ↔ user messaging) |
| `/api/environments` | Manifest CRUD + templates |
| `/api/llm-backends` | 5-provider health, auth, login flows |
| `/api/internal/mcp/{sid}/rpc` | Per-session MCP bridge (CLI wrap) |
| `/api/vtuber/library` | Live2D / Spine model registry |
| `/api/memory/*` | Session memory + knowledge whiteboard |

Full API reference → `/docs` (FastAPI auto-generated) when the backend is running.

---

## 🔌 MCP & custom tools

### Auto-loaded MCP servers

Drop a `.json` into `backend/mcp/` and it's available in every session that pulls it in via env manifest:

```jsonc
// backend/mcp/github.json
{
  "type": "http",
  "url": "https://api.github.com/mcp/",
  "description": "GitHub MCP server"
}
```

See [`backend/mcp/README.md`](backend/mcp/README.md).

### Auto-registered Python tools

Drop a `*_tool.py` into `backend/tools/custom/`:

```python
# backend/tools/custom/search_db_tools.py
from tools.base import tool

@tool
def search_database(query: str) -> str:
    """Search the database for records"""
    return f"Results for: {query}"

TOOLS = [search_database]
```

See [`backend/tools/README.md`](backend/tools/README.md).

### Per-session MCP wrap (Claude Code CLI)

When a session's Stage 6 provider is `claude_code_cli`, Geny attaches its own tool registry to the spawned CLI's LLM via a stdio MCP bridge (`scripts/geny_mcp_bridge.py`). The CLI's LLM sees `send_direct_message_internal`, `memory_write`, `web_search`, etc. as `mcp__geny__<tool>` and calls them natively — see [`docs/sessions.md`](docs/sessions.md) for the full flow.

---

## Error handling + i18n

Every executor exception carries a stable [`ExecutorErrorCode`](https://github.com/CocoRoF/geny-executor/blob/main/docs/error_codes.md) like `exec.cli.auth_failed`. The backend threads it through `SessionLogger` onto the SSE payload; the frontend renders the localised message + actionable next step via `executor.<code>` i18n lookup. End-user sees:

> Claude Code CLI 인증이 만료됐어요. 설정 → LLM 백엔드 → Claude Code (CLI) 카드의 ‘다시 로그인’을 누르거나 `ANTHROPIC_API_KEY` 를 붙여넣어 주세요.

instead of the raw English server message. Detailed flow → [`docs/error_codes.md`](docs/error_codes.md).

---

## Cross-platform support

- **Windows**: `%LOCALAPPDATA%\geny_agent_sessions`, auto-detects `.cmd`/`.exe` executables.
- **macOS / Linux**: `/tmp/geny_agent_sessions` (host) → `/data/geny_agent_sessions` (container).

---

## Community

| Contributor | What | Link |
|---|---|---|
| <a href="https://github.com/SonAIengine"><img src="https://avatars.githubusercontent.com/u/166786347?v=4&s=48" width="48" height="48" alt="Son Seong Jun" title="Son Seong Jun"/></a> [`graph-tool-call`](https://github.com/SonAIengine/graph-tool-call) | Inspiration for Tool-Search-Logic | — |

---

## License

MIT.

---

## Versioning + history

| Date | Highlight |
|---|---|
| 2026-05-22 | Doc refresh — README EN/KO, docs/* topic pages |
| 2026-05-22 | Phase 2: executor error codes → frontend i18n (PR #830) |
| 2026-05-21 | geny-executor 2.1.0 — `ExecutorErrorCode` taxonomy + structured event payloads |
| 2026-05-20 | geny-executor 2.0.6 — copilot_cli removed + 4 compat patches upstreamed |
| 2026-05-19 | Phase I — claude_code_cli MCP wrap (per-session bridge + tool_use strip + observability tap) |
| 2026-04-29 | host_selections (env-scoped hooks / skills / permission picker) |

See the [GitHub commit history](https://github.com/CocoRoF/Geny/commits/main) for the full log.

---

> _현재 사용자 모드: 한국어가 주 — 영어는 ENG 버튼으로 즉시 전환 가능._
