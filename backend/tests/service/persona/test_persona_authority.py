"""The persona is the authority on character; memory is a record.

Production 2026-08-29: a session was moved onto a warm, playful ESFP
preset and went on describing itself as "차갑고 조용해. 감정 잘 안
드러내" — verbatim from its own evergreen note, where months as the
previous character had been distilled into "cold analytical clinical
counselor, structure-before-empathy-FIXED".

Both texts were in the prompt. The persona said one thing 6,000
characters earlier; the memory said the other, in the user's own words,
injected fresh every turn. Nothing anywhere said which one wins, and the
more specific, more recent, more emphatic text did — as it should,
absent a rule.

This pins the rule, and pins that stating it does not quietly authorise
discarding what the agent knows about the USER.
"""

from __future__ import annotations

from service.persona_presets import compile_persona
from service.persona_presets.models import (
    EmotionDefaults,
    PersonaPresetDefinition,
)


def _preset(**kw) -> PersonaPresetDefinition:
    base = dict(name="테스트", description="", mbti="ESFP")
    base.update(kw)
    return PersonaPresetDefinition(**base)


def test_a_compiled_persona_claims_authority_over_memory():
    text = compile_persona(_preset())
    assert text, "nothing compiled"
    lowered = text.lower()
    assert "who you are now" in lowered
    assert "long-term memory" in lowered
    assert "do not override" in lowered


def test_it_tells_the_agent_what_to_do_on_a_conflict():
    """A precedence rule the model cannot act on is decoration."""
    lowered = compile_persona(_preset()).lower()
    assert "disagree" in lowered
    assert "follow this section" in lowered


def test_user_facts_are_explicitly_exempt():
    """The dangerous reading: "ignore memory that contradicts me" taken as
    licence to drop the user's name, 호칭 and commitments."""
    lowered = compile_persona(_preset()).lower()
    assert "facts about the user" in lowered
    for kept in ("name", "preferences", "commitments"):
        assert kept in lowered


def test_the_clause_rides_along_with_the_character_itself():
    """It has to be inside the persona block: the whole failure was a rule
    living too far from the text it governs."""
    text = compile_persona(_preset())
    assert text.startswith("## Character")
    assert text.index("who you are NOW") > text.index("## Character")


def test_a_persona_with_nothing_to_say_makes_no_claim():
    """The clause claims authority over what memory says about character,
    so it must only appear when this section actually describes one. A
    preset carrying nothing but a speech default would otherwise tell the
    agent to disregard its remembered manner in favour of nothing."""
    empty = PersonaPresetDefinition(name="", description="", mbti="",
                                    enneagram="", archetype="")
    empty.emotion = EmotionDefaults(default_mood="", expressiveness=50,
                                    preferred_tags=[])
    out = compile_persona(empty)
    assert "who you are NOW" not in out, out
