# Progress/01 — Counterpart message tool + VTuber session-create deny

**PR.** [CocoRoF/Geny#188](https://github.com/CocoRoF/Geny/pull/188) — `feat/counterpart-message-tool` (cycle 20260420_7, PR-1)
**Merged.** 2026-04-20
**Plan.** `plan/01_counterpart_message_tool.md`

---

## Symptom

VTuber agents, after warm-start or fresh-create, would call
`geny_session_create(session_name="Sub-Worker Agent")` to "find" their
paired Sub-Worker — reading the `## Sub-Worker Agent` header in the
seeded system prompt literally as a session name. The spurious session
replaced the real `_linked_session_id` for addressing purposes, so every
`geny_send_direct_message` routed to a freshly-minted unrelated target.

Users saw: "I DM'd the Sub-Worker but nobody got it."

## Root cause

See `analysis/01_linked_counterpart_discovery.md`. The VTuber had two
tools that pointed at the same goal:

1. `geny_send_direct_message(target_session_id, content)` — works if
   the LLM remembers the counterpart's UUID from the system prompt.
2. `geny_session_create(session_name, ...)` — LLM interprets literally,
   mints a new session, forgets the original binding.

No single tool modeled the "talk to my paired counterpart" intent, so
the LLM fell back to whichever option fit its current hallucination.

## The change

### New tool — `backend/tools/built_in/geny_tools.py`

```python
class GenyMessageCounterpartTool(BaseTool):
    name = "geny_message_counterpart"
    description = (
        "Send a message to your bound counterpart agent — "
        "for a VTuber this is its Sub-Worker; for a Sub-Worker this "
        "is its paired VTuber. No target is required..."
    )
    def run(self, session_id: str, content: str) -> str:
        ...
        counterpart_id = getattr(self_agent, "_linked_session_id", None)
        if not counterpart_id:
            return json.dumps({"error": "no linked counterpart ..."})
        ...
```

Symmetric by design: neither end needs to know the other's UUID. The
`session_id` argument is injected by the tool bridge probe (cycle 6
fix), so the LLM never sees addressing metadata at all — removing the
class of hallucination that powered the defect.

### VTuber tool roster — `service/environment/templates.py`

Added `_VTUBER_PLATFORM_DENY = frozenset({"geny_session_create"})` and
rewrote `_vtuber_tool_roster` to drop denied platform names:

```python
return [
    name for name in all_tool_names
    if (name.startswith(_PLATFORM_TOOL_PREFIXES)
        and name not in _VTUBER_PLATFORM_DENY)
    or name in _VTUBER_CUSTOM_TOOL_WHITELIST
]
```

Sub-Workers keep `geny_session_create` (they legitimately spawn helper
sessions); only VTubers lose it.

### Prompts

- `backend/prompts/vtuber.md`: every `geny_send_direct_message` mention
  replaced with `geny_message_counterpart`. UUIDs no longer leak into
  the system prompt.
- `service/langgraph/agent_session_manager.py`: warm-restart and
  fresh-create injection blocks reworked to reference
  `geny_message_counterpart` and stop embedding counterpart UUIDs.

## Tests

`tests/service/langgraph/test_counterpart_message_tool.py` — new, 10
cases:

- schema opacity (LLM cannot see `session_id`)
- probe injection adds `session_id`
- bidirectional delivery (VTuber→Sub and Sub→VTuber)
- failure modes: no linked counterpart, counterpart deleted, empty
  content

`tests/service/environment/test_templates.py` — added
`test_vtuber_env_denies_session_create`,
`test_worker_env_still_receives_session_create`.

66/66 pass after merge.

## Ship verification

Merged into main as commit `4a11d58`. Runtime smoke after rollout:
VTuber sessions correctly route DMs to their linked Sub-Worker without
spawning spurious sessions — observed zero `geny_session_create` calls
from VTuber roles in the 20260420 log window.
