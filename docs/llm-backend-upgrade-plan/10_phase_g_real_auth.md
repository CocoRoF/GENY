# Phase G · Real Claude Code / Copilot Auth in the Settings Modal

> Follow-up to phases F1–F3. The `LLMBackendsPanel` shipped in F2 was
> view-only — users couldn't click a card, kick off Claude Code's real
> subscription OAuth, or test the connection in place. This phase makes
> the panel a fully-interactive control surface: every card is
> clickable, every backend has a per-provider editor modal, and the
> Claude Code / Copilot modals expose a real device-code login flow
> that writes the canonical `~/.claude/.credentials.json` (Pro/Max
> subscription) — not just an `ANTHROPIC_API_KEY` env var.

## Why this matters

`claude auth status --json` proves the real model:

```json
{"loggedIn": true, "authMethod": "claude.ai", "apiProvider": "firstParty",
 "email": "...", "orgId": "...", "subscriptionType": "max"}
```

When `subscriptionType == "max"`, every `claude` invocation is billed
against the user's Max plan quota, not the per-token API price. The
credential lives at `~/.claude/.credentials.json` and the CLI refreshes
the access token transparently using the refresh token stored
alongside it. The Geny backend already supports calling out to `claude`
via the `claude_code_cli` provider — but the container can't see the
host's credentials and doesn't ship the binary. Phase G fixes both
problems and gives users a one-click way to log in from inside the
Geny UI.

## End state

- Click any LLM backend card → backend-specific editor modal.
- Anthropic / OpenAI / Google / vLLM modals: API key paste + Test
  connection button (no separate "Claude API" config trip).
- Claude Code modal:
  - Status pill showing the auth state (Max / Pro / Console / not
    authenticated).
  - Auth-mode radio:
    - **A. Host mount** (default) — re-uses the host's
      `~/.claude/.credentials.json` already maintained by `claude
      auth login`. Modal shows whether the mount sees a valid
      credential file and a live "subscriptionType" badge.
    - **B. In-modal login** — when (A) isn't set up yet, the modal
      offers a "Sign in" button that runs `claude auth login`
      *inside the backend container*. The CLI's device-code URL +
      short code stream back via SSE; the user opens the URL in a
      new tab, signs in, and the modal updates to green when the
      CLI exits successfully. This satisfies the user's explicit
      requirement: a CLI-style flow runnable inside the modal.
    - **C. setup-token paste** — for users who want a long-lived
      subscription token without OAuth (multi-tenant / remote
      scenarios).
    - **D. API key (Console)** — Anthropic Console API key. Bills
      per-token via the API, not against any subscription. Same
      paste-and-go shape as the regular Anthropic card.
  - Live console pane (toggle) showing the most recent subprocess
    stdout/stderr — useful for debugging auth flow weirdness.
  - "Test connection" button runs `claude -p "ping"` in `--bare`
    mode and surfaces the response or the error.
  - "Sign out" button calls `claude auth logout`.
- Copilot modal mirrors Claude Code's shape — `gh auth login` runs in
  the container, displays the device code, polls for completion, and
  surfaces the eventual `gh auth status --show-token` output.

## Work breakdown

| # | Title | Repo |
|---|---|---|
| G0 | This plan doc | Geny |
| G1 | Dockerfile installs `claude` CLI; docker-compose mounts host `~/.claude` RW; verify root-running container can write through to host file | Geny |
| G2 | Backend endpoints: `/auth/status`, `/auth/login` (POST → job id), SSE `/auth/login/{job_id}/events`, `/auth/login/{job_id}/cancel`, `/auth/logout`, `/test`; same shape for Copilot | Geny |
| G3 | Frontend Claude Code modal: clickable card, 4 auth-mode radios, live SSE console, status pill, Test/Login/Logout buttons | Geny |
| G4 | Frontend Copilot modal: parallel shape, calls the gh-auth endpoints | Geny |
| G5 | Frontend modals for the other four backends: API key paste + Test | Geny |
| G6 | Prod deploy + verification: confirm Max-plan billing on a real session | Geny |

## Open questions

- **Container UID vs host file ownership**: the production container
  currently runs as root (Dockerfile has `USER geny` commented out),
  so the bind-mount can read/write the 1000-owned credential file.
  We keep that behaviour as-is for this phase — switching to a
  non-root user with UID mapping is out of scope.
- **Setup-token vs OAuth in the modal**: Claude Code's
  `claude setup-token` requires interactive subscription auth that
  itself goes through `auth login`, so we don't expose `setup-token`
  as a first-class path — option (C) accepts a user-supplied token
  rather than generating one.
- **SSE vs polling**: SSE keeps the modal feeling live and gracefully
  degrades to polling on the frontend side if the proxy strips
  Server-Sent Events; for the first cut we ship SSE.

## Rollback

Each PR lands its own rollback note in `progress/`. The Phase F2
panel keeps working unchanged if Phase G is reverted — the user just
loses the click-to-edit modal and falls back to the existing config
sub-tabs.
