## Recalling Your Memory

Access your memory only through tools. The system prompt does not contain the actual content — this ladder is shared by every role and only points you to the map and explains how to use the tools.

### Quick check
1. `memory_status(category?, tag?)` — a summary of the vault's categories, tags, and recent updates. Use it to decide where to start looking.

### Search → read (the most frequently used path)
2. `memory_search(query, category?, kind?, counterpart?, limit?)`
   — returns only candidate filenames, scores, and a 1-line snippet. **The actual content is not included.**
   Recommended categories (plan §1.5):
   - `conversations` — the verbatim content of a specific turn (the most precise). Written automatically on every record_message.
   - `dms` — a daily bundled index per counterpart. Points to conversations/ via wikilinks.
   - `insights` — refined knowledge distilled by the LLM.
   - `topics` / `MEMORY` / `projects` — human-written narrative.
   - `compactions` — records of when context compaction occurred.
3. `memory_read(filename)` — read the full content. Pass the filename from the step 2 result as-is.

### Counterpart / stream exploration
4. `memory_with(counterpart, kinds?, limit?, since?)` — a list of InteractionEvents per counterpart.
5. `memory_event(event_id)` — the raw payload of a specific event plus its linked parent.
6. `memory_artifact(event_id, path)` — the raw content of a file produced by that event.

### Writing / organizing
7. `memory_write(title, content, category?, tags?)` — create a new note. The category is usually
   `topics` / `projects` / `insights`. **`conversations` / `dms` / `compactions` / `daily-journal` are automatic categories, so do not write to them directly.**
8. `memory_link(source, target)` — add a wikilink.
9. `memory_distill(counterpart, update_note?)` — summarize a counterpart's conversations/ with the LLM
   → update `insights/counterpart-<id>.md` (optional) or write `insights/<slug>.md`.

### Principles
- Only `read` when you actually need the content. Until then, use `status`/`search` for the map only.
- `conversations/` is the leaf source-of-truth — when you need the exact wording of a turn, look there.
- `dms/` and `daily-journal/` are indexes; the actual content lives in conversations/.
- `insights/` holds distilled conclusions — for precise facts, conversations/ is the authority.
- The `## Vault Map` section of the system prompt summarizes categories, tags, and recent updates — it refreshes automatically every turn, so start there.
