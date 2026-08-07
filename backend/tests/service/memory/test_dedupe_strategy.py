"""GenyDedupeStrategy — the one behaviour this subclass owns.

WHAT IS OURS AND WHAT IS NOT

``ProviderDrivenStrategy`` (the executor SDK) walks the new tail of
``state.messages`` and records each entry. We subclass it for exactly one
reason: to stamp ``msg["metadata"]`` with the InteractionEvent hint
``AgentSession._invoke_pipeline`` leaves in state, so the SDK's
``Turn.from_state_message`` can lift the typed fields.

The previous version of this file asserted the RECORDING: one write per
message, tool-role messages dropped, non-text blocks skipped, failures
swallowed. That behaviour moved into the SDK, and the strategy stopped
taking a memory manager at all — so every one of those tests constructed the
class with a signature it no longer has and failed on the constructor,
never reaching the assertion. They were testing someone else's code through
our seam, and they had been dead for long enough that nobody noticed.

What remains is the stamping contract, which is genuinely ours:
  · the first same-role message in a batch gets the hint verbatim;
  · subsequent same-role messages derive a FRESH event_id from the same
    template, so one VTuber turn emitting several assistant messages does
    not collapse them onto a single event.
"""

from __future__ import annotations

from typing import Any, Dict, List

from geny_executor.core.state import PipelineState

from service.memory.dedupe_strategy import _PENDING_KEY, GenyDedupeStrategy


def _state(messages: List[Dict[str, Any]], pending: Dict[str, Any] | None = None) -> PipelineState:
    state = PipelineState()
    state.messages = messages
    if pending is not None:
        # The hint lives in state.metadata and is keyed BY ROLE — that is how
        # AgentSession._invoke_pipeline leaves it.
        state.metadata[_PENDING_KEY] = pending
    return state


def _stamp(messages: List[Dict[str, Any]], pending: Dict[str, Any] | None = None) -> List[Dict[str, Any]]:
    strategy = GenyDedupeStrategy()
    state = _state(messages, pending)
    strategy._stamp_pending_metadata(state)
    return state.messages


def test_the_hint_lands_on_the_message() -> None:
    hint = {"user": {"event_id": "EVT-1", "kind": "user_chat", "direction": "inbound"}}
    out = _stamp([{"role": "user", "content": "안녕"}], hint)

    meta = out[0].get("metadata") or {}
    assert meta.get("event_id") == "EVT-1"
    assert meta.get("kind") == "user_chat"
    assert meta.get("direction") == "inbound"


def test_a_second_message_of_the_same_role_gets_its_own_event_id() -> None:
    """One turn that emits two assistant messages must not file both under a
    single event — that is the whole reason this subclass exists."""
    # A derived event needs the full dimensions (kind AND direction) — the
    # template cannot invent them, and returns nothing rather than guess.
    # A derived event needs the FULL dimensions. Real hints always carry
    # them — they are themselves built by make_event_metadata, where
    # counterpart_role is a required argument.
    hint = {
        "assistant": {
            "event_id": "EVT-1",
            "kind": "reflection",
            "direction": "internal",
            "counterpart_id": "self",
            "counterpart_role": "self",
        }
    }
    out = _stamp(
        [
            {"role": "assistant", "content": "first"},
            {"role": "assistant", "content": "second"},
        ],
        hint,
    )

    first = (out[0].get("metadata") or {}).get("event_id")
    second = (out[1].get("metadata") or {}).get("event_id")
    assert first == "EVT-1"
    assert second and second != first, "two messages shared one event id"
    assert (out[1].get("metadata") or {}).get("kind") == "reflection", (
        "the derived event lost the rest of the hint"
    )


def test_no_hint_leaves_the_messages_alone() -> None:
    out = _stamp([{"role": "user", "content": "안녕"}])
    assert not (out[0].get("metadata") or {}).get("event_id")


def test_a_message_that_already_carries_metadata_is_left_alone() -> None:
    """Stamping fills a gap; it does not overwrite. A caller that already
    attached metadata knows more about that message than the pending hint."""
    out = _stamp(
        [{"role": "user", "content": "안녕", "metadata": {"mine": "keep"}}],
        {"user": {"event_id": "EVT-1"}},
    )
    assert out[0]["metadata"] == {"mine": "keep"}


def test_stamping_never_raises_on_odd_message_shapes() -> None:
    """It runs on every turn, ahead of the recording it feeds. A malformed
    entry must not take the pipeline down with it."""
    out = _stamp(
        [
            {"role": "user", "content": [{"type": "image"}]},
            {"role": "tool", "content": ""},
            {"content": "no role at all"},
        ],
        {"user": {"event_id": "EVT-1"}},
    )
    assert len(out) == 3
