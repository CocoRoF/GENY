"""Host-side memory tool catalogue prompt block.

Cycle 20260503_7. Companion to ``geny-executor`` 1.15.0's
``_MEMORY_USAGE_CLAUSE`` decoupling. The executor preset now ships
generic *policy* only ("consult memory before asking the user; trust
Pinned Facts"); the concrete *tool catalogue* — names, semantics,
ladder — belongs to the host (Geny) because Geny owns the tool
identities.

This module exposes :class:`HostMemoryToolsBlock`, a
:class:`PromptBlock` Geny appends to its system-prompt tail (after
``MemoryContextBlock``) so the agent sees:

  PersonaBlock              ← who the agent is
  DateTimeBlock             ← current time
  MemoryContextBlock        ← Pinned Facts + Relevant Knowledge (data)
  HostMemoryToolsBlock      ← Memory Usage policy + concrete tools

The block is static — no per-state context — so its ``render`` just
emits the constant string. Keep the catalogue here in lockstep with
the actual tools registered in ``backend/tools/built_in/memory_tools.py``.
"""

from __future__ import annotations

from typing import Any

from geny_executor.stages.s03_system.artifact.default.builders import (
    PromptBlock,
)


# The full Memory Usage clause for Geny: executor's policy +
# Geny's concrete tool ladder + write-path index. Centralised here
# (rather than scattered across preset prompts or agent_session.py)
# so a tool name change in ``memory_tools.py`` only ripples through
# this single file.
_HOST_MEMORY_USAGE_AND_TOOLS = """\
## Memory Usage

The host maintains a long-term memory for you. The **Pinned Facts**
section in this prompt — when present — holds must-know facts about
the user, the agent, and the ongoing work. Treat them as
authoritative; never claim ignorance of anything stated there.

When the user's intent is ambiguous and the answer might already be
remembered, **consult memory before asking a clarification question
the user may have already answered.** Walk the ladder:

  1. Read the **Pinned Facts** and **Vault Map** sections of this
     prompt — the answer is often already there.
  2. ``memory_categories`` — discover the vault's category map: every
     category with a 1-line description, file count, and last-modified
     timestamp. Use this when you don't know which folder owns the
     answer.
  3. ``memory_list(category=…)`` — list the files inside one
     category (filename, title, summary, importance, modified).
  4. ``memory_read(filename=…)`` — open a specific note's body.
  5. ``memory_search(query=…)`` — fuzzy / semantic search fallback
     when the vault map doesn't make the right folder obvious.

Write paths:

  - ``memory_pin`` — pin a fact so it is **always** injected into
    the system prompt (Pinned Facts tier). Use this for must-know
    facts about the user, the persona, and binding decisions.
  - ``memory_write`` — create a curated note under
    ``topics`` / ``projects`` / ``insights`` / ``daily``.
  - ``memory_update`` — modify an existing note.
  - ``memory_link`` — create a wikilink between two notes.

Do not announce the lookup; just do it."""


class HostMemoryToolsBlock(PromptBlock):
    """Static block that appends Geny's memory-usage policy + tool
    catalogue to the system prompt's tail.
    """

    @property
    def name(self) -> str:
        return "host_memory_tools"

    def render(self, state: Any) -> str:  # noqa: ARG002 — state unused
        return _HOST_MEMORY_USAGE_AND_TOOLS


__all__ = ["HostMemoryToolsBlock"]
