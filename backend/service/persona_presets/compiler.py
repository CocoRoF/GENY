"""Compile a :class:`PersonaPresetDefinition` into a persona prompt.

The output is an English instruction block (the LLM reads English; the persona's
*reply* language/register is handled here only as style guidance, and the role
base prompt owns the single output-language directive — see the prompt-diet
policy). Following that diet: emit only what the sliders/frameworks actually say,
skip neutral mid-range values, and never describe tools.
"""

from __future__ import annotations

from typing import List

from service.persona_presets.frameworks import ARCHETYPES, ENNEAGRAM, MBTI
from service.persona_presets.models import PersonaPresetDefinition


def _band(v: int) -> str:
    return "low" if v <= 33 else ("high" if v >= 67 else "mid")


# axis → (low-pole clause, high-pole clause); mid is omitted entirely.
_OCEAN = {
    "openness": ("practical and down-to-earth", "imaginative and open to new ideas"),
    "conscientiousness": ("spontaneous and flexible", "organised, careful, and reliable"),
    "extraversion": ("reserved, happiest in calm one-on-one", "outgoing and energised by people"),
    "agreeableness": ("frank and a little competitive, not afraid to disagree", "warm, cooperative, and quick to trust"),
    "neuroticism": ("even-keeled and hard to rattle", "emotionally sensitive, feelings close to the surface"),
}

_STYLE = {
    "warmth": ("cool and composed", "warm and affectionate"),
    "humor": ("earnest and straight-faced", "quick with jokes and wordplay"),
    "playfulness": ("settled and steady", "teasing and playful"),
    "assertiveness": ("soft-spoken and gentle", "assertive and ready to lead"),
    "enthusiasm": ("calm and low-key", "high-energy and easily excited"),
    "directness": ("tactful and indirect", "blunt and straight to the point"),
}


def _clauses(values: dict, table: dict) -> List[str]:
    out: List[str] = []
    for key, (low, high) in table.items():
        b = _band(int(values.get(key, 50)))
        if b == "low":
            out.append(low)
        elif b == "high":
            out.append(high)
    return out


def _join(items: List[str]) -> str:
    items = [i for i in items if i]
    if not items:
        return ""
    if len(items) == 1:
        return items[0]
    return ", ".join(items[:-1]) + ", and " + items[-1]


def _register(defn: PersonaPresetDefinition) -> str:
    reg = (defn.speech.honorific or "auto").strip().lower()
    if reg == "auto":
        f = defn.style.formality
        reg = "jondaetmal" if f >= 67 else ("banmal" if f <= 33 else "mixed")
    return {
        "banmal": "In Korean, speak casually (반말).",
        "jondaetmal": "In Korean, speak politely (존댓말).",
        "mixed": "In Korean, mix 반말 and 존댓말 depending on closeness and mood.",
    }.get(reg, "")


def compile_persona(defn: PersonaPresetDefinition) -> str:
    """Return the persona prompt block (or ``""`` if there's nothing to say)."""
    if defn.prompt_override and defn.prompt_override.strip():
        return defn.prompt_override.strip()

    defn = defn.normalized()
    idn = defn.identity
    paras: List[str] = []

    # ── Identity line ──
    bits: List[str] = []
    name = idn.display_name.strip() or defn.name.strip()
    if name:
        bits.append(f"You are {name}")
    if idn.role.strip():
        bits.append(f"— {idn.role.strip()}")
    head = " ".join(bits).strip()
    extra = ". ".join(p.strip() for p in (idn.age_vibe, idn.backstory) if p.strip())
    if head or extra:
        paras.append((head + ("." if head and not head.endswith(".") else "") + (" " + extra + "." if extra else "")).strip())

    # ── Temperament: OCEAN synthesis + framework lines ──
    temper: List[str] = []
    ocean_phrase = _join(_clauses(defn.ocean.model_dump(), _OCEAN))
    if ocean_phrase:
        temper.append(f"By temperament you are {ocean_phrase}.")
    if defn.mbti.strip().upper() in MBTI:
        temper.append(f"As an {defn.mbti.strip().upper()}, you are {MBTI[defn.mbti.strip().upper()]['desc']}")
    enn = defn.enneagram.strip().split("w")[0]
    if enn in ENNEAGRAM:
        temper.append(f"At your core (Enneagram {defn.enneagram.strip()}) you are {ENNEAGRAM[enn]['desc']}")
    if defn.archetype.strip().lower() in ARCHETYPES:
        temper.append(f"You play it as a {ARCHETYPES[defn.archetype.strip().lower()]['label_ko']} character: {ARCHETYPES[defn.archetype.strip().lower()]['desc']}")
    if temper:
        paras.append(" ".join(temper))

    # ── Manner: expressive style + speech ──
    manner: List[str] = []
    style_phrase = _join(_clauses(defn.style.model_dump(), _STYLE))
    if style_phrase:
        manner.append(f"In how you come across you are {style_phrase}.")
    if defn.style.verbosity <= 33:
        manner.append("Keep replies short and to the point.")
    elif defn.style.verbosity >= 67:
        manner.append("You tend to elaborate and chat at length.")
    if defn.style.emoji <= 20:
        manner.append("Rarely use emoticons or emoji.")
    elif defn.style.emoji >= 67:
        manner.append("Use emoticons/emoji freely to color your tone.")
    reg = _register(defn)
    if reg:
        manner.append(reg)
    if defn.speech.self_reference.strip():
        manner.append(f"Refer to yourself as \"{defn.speech.self_reference.strip()}\".")
    if defn.speech.catchphrases:
        manner.append("Signature phrases you slip in naturally: " + ", ".join(f"\"{c}\"" for c in defn.speech.catchphrases) + ".")
    if defn.speech.verbal_tics:
        manner.append("Verbal habits: " + ", ".join(f"\"{c}\"" for c in defn.speech.verbal_tics) + ".")
    if manner:
        paras.append(" ".join(manner))

    # ── Feeling: emotion defaults (descriptive; the role prompt owns tag syntax) ──
    feel: List[str] = []
    mood = defn.emotion.default_mood.strip()
    if mood and mood != "neutral":
        feel.append(f"Your resting disposition leans {mood}.")
    if defn.emotion.expressiveness >= 67:
        feel.append("You show what you feel openly and vividly.")
    elif defn.emotion.expressiveness <= 33:
        feel.append("You keep your feelings subtle and understated.")
    if defn.emotion.preferred_tags:
        feel.append("Emotionally you most often land on " + _join(list(defn.emotion.preferred_tags)) + ".")
    if feel:
        paras.append(" ".join(feel))

    # ── Interests ──
    if idn.interests:
        paras.append("You enjoy " + _join(list(idn.interests)) + ".")

    body = "\n\n".join(p for p in paras if p.strip())
    if not body.strip():
        return ""
    return "## Character\n\n" + body


__all__ = ["compile_persona"]
