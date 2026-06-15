# Session persistence & restore-on-restart

## Problem

Sessions disappear on redeploy / backend restart / crash. The UI lists
sessions from `AgentSessionManager._local_agents` (an in-memory dict), which
starts **empty** on every boot. Worse, the graceful shutdown hook
(`main.py::stop_all_sessions`) **soft-deletes** every live session, so even
the persistent store marks them `is_deleted=True` after a clean restart.

`docs/sessions.md` claims *"Sessions are persisted; reloading the app picks
them back up"* — this was never implemented.

## What already survives (no change needed)

- **Session metadata** → PostgreSQL `sessions` table (primary) + `sessions.json`
  backup, via `service/sessions/store.py`. Holds every creation param
  (role, model, env_id, linked_session_id, chat_room_id, trigger_preset_id,
  system_prompt, total_cost, status, is_deleted, …).
- **Per-session storage** → `geny-agent-sessions-prod` named volume
  (`$GENY_AGENT_STORAGE_ROOT/<session_id>/`): transcripts (STM jsonl),
  `memory/` vault, `checkpoints/`. Survives `docker compose up --build`.
- **Chat history** → `service/chat/conversation_store.py` (DB).
- A working **reconstruction path** already exists in the controller's
  `POST /api/agents/{id}/restore` — re-creates the `AgentSession` with the
  **same `session_id`** (preserves storage_path → memory/transcripts reload)
  and cascades to the linked VTuber↔Sub-Worker peer.

## Decision: LAZY restore

Boot stays cheap; sessions reappear instantly from the store; the heavy
`AgentSession` (pipeline / memory / VTuber loops) is reconstructed only when
the user opens or messages the session. Avoids auto-starting VTuber
autonomous loops at boot and scales with session count.

## Changes

### Backend
1. **Shutdown** (`main.py::stop_all_sessions`): replace `store.soft_delete(sid)`
   with `store.update(sid, {"status": "stopped"})`. Soft-delete is now
   reserved for explicit user delete only. Sessions stay non-deleted →
   reappear after restart. (A crash skips this hook entirely; the store
   still holds them non-deleted, so the same restore path covers it.)
2. **Manager `_rehydrate(session_id, *, cascade=True)`**: extract the
   reconstruction logic from the controller restore endpoint into a reusable
   method (build `CreateSessionRequest` from `store.get_creation_params`,
   `create_agent_session(session_id=…, env_id=…, trigger_preset_id=…)`,
   restore system_prompt override + chat_room_id, cascade linked peer).
3. **Manager `async ensure_session_live(session_id)`**: return the live
   `AgentSession` if present; else, if a non-deleted store record exists,
   `_rehydrate` it into `_local_agents` and return it; else `None`.
4. **List endpoint** (`GET /api/agents`): merge live sessions with dormant
   non-deleted store records (`store.list_active()` minus live), rendering
   dormant ones as `SessionInfo(status="stopped")`. This is what makes the
   sidebar show pre-restart sessions again.
5. **`POST /api/agents/{id}/resume`**: idempotent — `ensure_session_live`
   then return `SessionInfo`. Frontend calls it when opening a dormant
   session.
6. **Hydrate-on-access**: call `ensure_session_live` at the top of the
   message paths (`POST /{id}/invoke`, chat room broadcast) so sending to a
   dormant session transparently resumes it.
7. **Refactor** `POST /{id}/restore` to `store.restore()` + `_rehydrate`
   (un-delete then reconstruct) — one reconstruction implementation.

### Frontend
- `agentApi.resume(id)` → `POST /api/agents/{id}/resume`.
- Sidebar already shows the merged list (status `stopped`); add a subtle
  "복원됨/중지됨" indicator and keep stopped sessions selectable.
- On opening a `stopped` session, call `resume(id)`; reflect the live status
  once it returns. Relax `ChatTab` `status === 'running'` gates so a dormant
  session can be opened and resumed (not silently hidden).

## Out of scope
- Resuming an **in-flight turn** that was interrupted mid-execution: the LLM
  call is gone. We restore the conversation/memory so the user continues;
  the interrupted turn is not replayed.
