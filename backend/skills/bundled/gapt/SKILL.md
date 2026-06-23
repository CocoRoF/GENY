---
name: gapt
description: Work with isolated, persistent GAPT project / workspace / sandbox spaces — create projects, run commands in sandboxes, and deploy. Use whenever the task needs an independent project space.
allowed_tools:
  - gapt_overview
  - gapt_list_projects
  - gapt_create_project
  - gapt_list_workspaces
  - gapt_create_workspace
  - gapt_manage_workspace
  - gapt_run_command
  - gapt_list_environments
  - gapt_deploy
execution_mode: inline
---

# GAPT — independent project & sandbox spaces

GAPT gives you **isolated, persistent project spaces** that are separate from
this chat session. Reach for this skill when the task needs its own project /
workspace / sandbox: a place to create code that persists, run builds in an
isolated container, or deploy something — distinct from your own per-session
workspace.

## Two ways to do the work — pick based on what you have

**A. You have the `gapt_*` tools yourself** (you'll see them in your toolset).
Then do it directly:

1. `gapt_overview` — see what projects/workspaces already exist. Start here.
2. `gapt_create_project` — make a new independent project space (give it a slug).
3. `gapt_create_workspace` — spin up an isolated workspace (sandbox container)
   in that project. It's async — it becomes usable shortly after creation.
4. `gapt_run_command` — run shell commands inside the workspace (git, build,
   run, etc.).
5. `gapt_list_environments` + `gapt_deploy` — deploy the project when asked.

Each project is fully isolated and **persists across sessions** — come back to
it later and its files + git history are still there.

**B. You do NOT have the `gapt_*` tools, but you have a `gapt` sub-worker.**
Then **delegate** the whole GAPT task to it: hand the sub-worker a clear,
self-contained instruction (what to create / run / deploy and in which
project), let it carry out the GAPT operations, and relay its result back to
the user in your own voice. Don't try to do GAPT work without the tools — the
sub-worker is the one carrying them.

## Notes
- Don't use this for ordinary file/shell work in your *current* session — that's
  what your normal Read/Write/Bash (or your own workspace) are for. This skill
  is specifically for **separate, named, persistent project spaces**.
- When unsure whether a project already exists, call `gapt_overview` (or ask the
  sub-worker to) before creating a duplicate.
