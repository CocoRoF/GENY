# GAPT tool reference

Detailed reference for the `gapt_*` tools. Loaded on demand (Level 3) — only
pull this when you need exact arguments or the full workflow.

## Discovery

- **`gapt_overview()`** — one-shot snapshot: all projects + workspace capacity
  stats. Call this first to orient.
- **`gapt_list_projects()`** — all projects with id, slug, repo count.
- **`gapt_list_workspaces(project_id)`** — workspaces in a project (name,
  status, selections).

## Projects

- **`gapt_create_project(slug, display_name?, git_remote_url?)`** — create a new
  independent project space. `slug` is the stable id (lowercase-kebab). Returns
  the project record (with its `id`). If the slug already exists you'll get a
  409 — list first and reuse it.

## Workspaces (sandboxes)

- **`gapt_create_workspace(project_id, name)`** — spin up an isolated workspace
  (a sysbox container) in the project. Asynchronous: the workspace starts in
  `creating` and becomes `running` shortly after. It's usable as soon as the
  container is up.
- **`gapt_manage_workspace(workspace_id, action)`** — lifecycle: `action` is
  `start`, `stop`, or `delete`. Stopping frees the container; the worktree
  (files + git) persists and comes back on the next start.
- **`gapt_run_command(workspace_id, command, cwd?)`** — run a shell command
  inside the workspace and get its output. Use for git, builds, running code,
  inspecting files. `cwd` defaults to the workspace root (`/workspace`).

## Deployment

- **`gapt_list_environments(project_id)`** — deploy environments for a project
  (id, name, kind, history).
- **`gapt_deploy(environment_id, version?)`** — kick off a deployment. Omit
  `version` to deploy the latest.

## Typical end-to-end flow

1. `gapt_overview()` — see what already exists (avoid duplicate projects).
2. `gapt_create_project(slug="my-app")` — make the space (or reuse an existing).
3. `gapt_create_workspace(project_id, name="main")` — isolated sandbox.
4. `gapt_run_command(workspace_id, "git init && …")` — do the work.
5. `gapt_list_environments(project_id)` → `gapt_deploy(environment_id)` — ship.

## Notes

- A project is a fully isolated, persistent space — its files + git history
  survive across sessions. Come back to the same project later.
- When unsure whether a project exists, `gapt_overview()` before creating.
