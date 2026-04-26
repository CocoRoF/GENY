# C.1 — "Next session" banner on Library / Session-Env tabs

**PR:** TBD
**Status:** Merged TBD
**Files changed:**
- `frontend/src/components/layout/NextSessionBanner.tsx` (new) — small persistent info strip with two variants (`library` / `session`).
- `frontend/src/components/layout/index.ts` — export `NextSessionBanner`.
- `frontend/src/components/tabs/EnvironmentTab.tsx` — mount `<NextSessionBanner variant="library" />` below the scope header.
- `frontend/src/components/tabs/SessionEnvironmentRootTab.tsx` — mount `<NextSessionBanner variant="session" />` below the scope header.
- `frontend/src/lib/i18n/{en,ko}.ts` — add `nextSessionBanner.{library,session}.{title,body}` strings.

## What it changes

A small banner appears under the scope header on Library and Session-Env tabs. Two copies:
- **Library** — "Applies to the next session. Library changes (permissions, hooks, skills, MCP, manifests) are read when a new session starts. Active sessions keep their startup snapshot."
- **Session** — "Read-only snapshot of this session. Edits to the underlying environment manifest take effect when the session is recreated. Restart the session to pick up changes."

## Why

Audit (cycle 20260426_1, analysis/02 §B.1, §B.5) found the user has no signal that mutations to permissions / hooks / skills / MCP / manifest land on a per-session snapshot — active sessions keep their boot-time runtime. Without the banner the natural conclusion is "the UI is broken" when a freshly-saved rule does nothing to the current session.

Live-reload (sprint E.1) is the actionable answer once it ships; until then this banner is the only signal.

## Tests

Type-only changes on the FE side; no unit tests added. CI lint + tsc + Next build is the gate.

## i18n

Both en/ko translations included.

## Out of scope

- Live reload itself (E.1).
- Per-row "would affect N active sessions" hints (D.3 covers this for the manifest editor specifically).
