# Progress/02 — Seed-env overwrite on boot

**PR.** `fix/seed-env-overwrite` (Phase 1 · PR #2 of 9)
**Plan.** `plan/01_tool_execution_fix.md` §PR #2
**Date.** 2026-04-20

---

## What changed

`backend/service/environment/templates.py` — `install_environment_templates`:

- Dropped the `if service.load(env_id) is None:` guard.
- Now writes both `template-worker-env` and `template-vtuber-env`
  every boot from the canonical `build_default_manifest` output.
- Return value changed from "new envs written" to "total seeds
  written" (always `len(seeds)`), and the docstring updated to
  describe the new behaviour.

`backend/main.py` — the call-site comment updated to match: the
step seeds unconditionally and is not a first-boot-only no-op.

## Why

PR #1 added stages 10/11/14 to the default builder, but
on-disk seed envs predated that change still carried the
pre-fix shape. With zero users and no custom edits to preserve,
the safe policy is the simple one — rebuild the two template
seeds from the builder on every boot. Any id other than the two
template seeds is left alone, so custom envs remain user-owned.

Keeping the seeds in lockstep with the builder also removes a
permanent migration surface: future additions to the canonical
manifest (new stage, strategy rename, etc.) propagate to disk
on the next boot, no schema-version bump needed.

## Verification

1. `python3 -m py_compile backend/service/environment/templates.py` — OK.
2. `python3 -m py_compile backend/main.py` — OK.
3. Behavioural check:
   - Existing seed env on disk (whatever shape) → overwritten on
     next boot with current `build_default_manifest` output.
   - Custom env (id ≠ `template-worker-env` / `template-vtuber-env`)
     → untouched.

Formal test file deferred — no backend test harness is wired up
in this workspace. PR #3 (integration smoke) will verify via
end-to-end tool execution that the seeded env actually drives
the fixed pipeline.

## Out of scope

- Preserving user edits to the two seed ids (no users exist;
  dismissed by user directive).
- Introducing a manifest version field or migration framework.

## Rollback

Revert both files. On revert, stale on-disk seeds again shadow
any builder change until the file is manually deleted — that's
the regression we just closed.
