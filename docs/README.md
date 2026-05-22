# Geny — Documentation

Geny is a multi-agent VTuber platform: a personality-facing **VTuber** agent paired with task-facing **Sub-Worker** agents, both running on [geny-executor 2.1.0](https://github.com/CocoRoF/geny-executor)'s 21-stage pipeline.

This folder is the topic-oriented technical reference. For a higher-level overview and quickstart, see the top-level [README.md](../README.md) ([Korean](../README_ko.md)).

## Topic pages

| Page | What it covers |
| ---- | -------------- |
| [architecture.md](architecture.md) | End-to-end stack, two execution loops, request lifecycle |
| [providers.md](providers.md) | Five LLM backends and how to wire each one up |
| [sessions.md](sessions.md) | VTuber ↔ Sub-Worker pairing and the delegation protocol |
| [environments.md](environments.md) | EnvironmentManifest editor, templates, CRUD API |
| [error_codes.md](error_codes.md) | Stable error code list, propagation, i18n mapping |

## Where things live

| Concern                    | Path                                                                         |
| -------------------------- | ---------------------------------------------------------------------------- |
| Executor wrapper           | [backend/service/executor/](../backend/service/executor/)                    |
| High-level orchestration   | [backend/service/execution/](../backend/service/execution/)                  |
| SSE event stream           | [backend/service/logging/](../backend/service/logging/)                      |
| VTuber subsystem           | [backend/service/vtuber/](../backend/service/vtuber/)                        |
| Environment / manifest     | [backend/service/environment/](../backend/service/environment/)              |
| Provider keys / creds      | [backend/service/credentials/](../backend/service/credentials/)              |
| Tool registry              | [backend/service/tool_loader.py](../backend/service/tool_loader.py)          |
| MCP server registry        | [backend/service/mcp_loader.py](../backend/service/mcp_loader.py)            |
| Frontend log card          | [frontend/src/components/execution/LogEntryCard.tsx](../frontend/src/components/execution/LogEntryCard.tsx) |
| Frontend env editor        | [frontend/src/components/environment/](../frontend/src/components/environment/) |
| i18n strings               | [frontend/src/lib/i18n/](../frontend/src/lib/i18n/)                          |

## Related repos

| Repo                  | Purpose                                                            |
| --------------------- | ------------------------------------------------------------------ |
| [geny-executor](https://github.com/CocoRoF/geny-executor) | Pipeline library Geny runs on (v2.1.0+) |
| [geny-executor-web](https://github.com/CocoRoF/geny-executor-web) | Web console for the executor (separate deploy) |
| [geny-avatar](../geny-avatar/) (submodule) | 2D Live Avatar editor — Next.js + Pixi + Spine/Live2D + AI |

## Project history (legacy docs)

Earlier-cycle reports and porting plans are preserved under [_archive/](_archive/) and [analysis/](analysis/). They are kept for context but should be treated as historical — they predate the executor 2.1.0 integration and may reference removed code paths (e.g. LangGraph, github-copilot CLI backend).

Notable archives:

- [_archive/langgraph-era/](_archive/langgraph-era/) — pre-executor pipeline design
- [_archive/executor-migration-v1/](_archive/executor-migration-v1/) — initial executor port
- [_archive/vtuber-porting-v1/](_archive/vtuber-porting-v1/) — VTuber subsystem v1 port
- [_archive/debugging-logs/](_archive/debugging-logs/) — diagnostic write-ups
- [analysis/](analysis/) — point-in-time deep dives (memory direction audit, regression analyses)

Sprint-level work logs live in `../dev_docs/<YYYYMMDD>_<N>/` (`analysis/`, `plan/`, `progress/`). The current cycle index is reachable from the repo root.

## Conventions

- All topic pages here are EN. The top-level README is bilingual; if you need KO topic pages, open an issue.
- Cross-link with relative paths so links work in GitHub, IDE preview, and offline checkouts.
- When something here drifts from the code, fix the doc — these pages are the contract the rest of the team reads.
