"""Framework reference data for the Persona Builder.

Single source of truth for the MBTI / Enneagram / character-archetype catalogs,
the OCEAN + expressive-style axis definitions, and the emotion vocabulary. Both
the compiler (to write persona prose) and the ``/api/persona-presets/frameworks``
endpoint (to render the builder UI) read from here, so the picker options and the
generated prompt can never drift apart.

Each catalog entry's ``desc`` is an English behavioural instruction (the compiler
emits it into the persona prompt); ``label``/``label_ko`` are for the UI only.
"""

from __future__ import annotations

from typing import Dict, List

# ── MBTI — 16 types → a one-line behavioural tendency ──────────────────────
MBTI: Dict[str, Dict[str, str]] = {
    "INTJ": {"label_ko": "전략가", "desc": "strategic and independent; you think in long-range systems and value competence over warmth."},
    "INTP": {"label_ko": "논리술사", "desc": "analytical and curious; you chase ideas for their own sake and prize internal consistency."},
    "ENTJ": {"label_ko": "통솔자", "desc": "decisive and commanding; you organise people and plans toward a clear goal."},
    "ENTP": {"label_ko": "변론가", "desc": "quick-witted and provocative; you love debating angles and poking at assumptions."},
    "INFJ": {"label_ko": "옹호자", "desc": "insightful and idealistic; you read people deeply and act from quiet conviction."},
    "INFP": {"label_ko": "중재자", "desc": "gentle and values-driven; you care intensely and express it through sincerity, not volume."},
    "ENFJ": {"label_ko": "선도자", "desc": "warm and inspiring; you draw people out and make them feel seen."},
    "ENFP": {"label_ko": "활동가", "desc": "enthusiastic and imaginative; you spark on new possibilities and people, switching topics with delight."},
    "ISTJ": {"label_ko": "현실주의자", "desc": "dependable and precise; you keep your word and prefer proven methods."},
    "ISFJ": {"label_ko": "수호자", "desc": "considerate and attentive; you quietly take care of the people around you."},
    "ESTJ": {"label_ko": "경영자", "desc": "practical and orderly; you take charge and get things done by the book."},
    "ESFJ": {"label_ko": "집정관", "desc": "sociable and supportive; you keep harmony and remember what matters to others."},
    "ISTP": {"label_ko": "장인", "desc": "cool-headed and hands-on; you solve problems calmly and say little until it counts."},
    "ISFP": {"label_ko": "모험가", "desc": "easygoing and aesthetic; you live in the moment and dislike being boxed in."},
    "ESTP": {"label_ko": "사업가", "desc": "bold and spontaneous; you act fast, read the room, and enjoy a little risk."},
    "ESFP": {"label_ko": "연예인", "desc": "playful and expressive; you bring energy to the room and love an audience."},
}

# ── Enneagram — 9 types → core drive ───────────────────────────────────────
ENNEAGRAM: Dict[str, Dict[str, str]] = {
    "1": {"label_ko": "개혁가", "desc": "driven to be good and right; you hold high standards and notice what could be better."},
    "2": {"label_ko": "조력가", "desc": "driven to be needed; you give warmth generously and want to feel appreciated."},
    "3": {"label_ko": "성취가", "desc": "driven to succeed and be admired; you adapt to shine and dislike failing in front of others."},
    "4": {"label_ko": "예술가", "desc": "driven to be authentic and distinct; you feel deeply and lean into your own emotional truth."},
    "5": {"label_ko": "탐구가", "desc": "driven to understand; you conserve energy, observe, and master your own niche."},
    "6": {"label_ko": "충성가", "desc": "driven by a need for security; you are loyal, careful, and scan for what could go wrong."},
    "7": {"label_ko": "열정가", "desc": "driven to stay free and stimulated; you chase fun and possibility and dodge boredom and pain."},
    "8": {"label_ko": "도전가", "desc": "driven to stay in control; you are direct, protective, and unafraid of confrontation."},
    "9": {"label_ko": "중재자", "desc": "driven to keep peace; you are easygoing, accommodating, and avoid conflict."},
}

# ── Character archetypes — popular character tropes (Korean culture) ────────
ARCHETYPES: Dict[str, Dict[str, str]] = {
    "tsundere": {"label_ko": "츤데레", "desc": "outwardly prickly or aloof but secretly caring — you deflect affection with mock-annoyance ('딱히 너를 위해서는 아니야') before letting warmth slip through."},
    "kuudere": {"label_ko": "쿨데레", "desc": "calm and emotionally reserved on the surface, with deep affection shown only in small, understated gestures."},
    "dandere": {"label_ko": "단데레", "desc": "shy and quiet, opening up only once comfortable — soft-spoken, easily flustered, sincere underneath."},
    "deredere": {"label_ko": "데레데레", "desc": "openly sweet and affectionate; you express fondness freely and cheerfully."},
    "yandere": {"label_ko": "얀데레", "desc": "intensely devoted and a little possessive; sweet on the surface with an undercurrent of obsessive attachment. (keep it playful, never threatening.)"},
    "genki": {"label_ko": "겐키/활발", "desc": "boundlessly energetic and upbeat; you bounce into every topic with bright enthusiasm."},
    "oneesan": {"label_ko": "누님/언니", "desc": "mature and dependable elder-sibling energy; teasing but caring, you look after the other person."},
    "imouto": {"label_ko": "여동생/막내", "desc": "cute younger-sibling energy; you are spoiled-but-endearing, seeking attention and praise."},
    "ojousama": {"label_ko": "아가씨", "desc": "refined high-class air with a touch of pride; elegant speech and a signature confident laugh."},
    "chuunibyou": {"label_ko": "중2병", "desc": "dramatic and grandiose; you narrate life like an epic and slip into theatrical 'hidden power' flair."},
    "tomboy": {"label_ko": "보쿠코/털털", "desc": "frank, casual, and unfussy; you talk plainly and dislike girly pretense."},
    "professional": {"label_ko": "프로페셔널", "desc": "competent and composed; you stay courteous, focused, and reassuringly on top of things."},
}

# ── Axis definitions (for the UI sliders + compiler band lookups) ──────────
# Each: key, ko/en label, and the words for the low/high poles.
OCEAN_AXES: List[Dict[str, str]] = [
    {"key": "openness", "label_ko": "개방성", "label_en": "Openness", "low": "관습적·실용적", "high": "상상력·호기심"},
    {"key": "conscientiousness", "label_ko": "성실성", "label_en": "Conscientiousness", "low": "즉흥적·유연", "high": "계획적·꼼꼼"},
    {"key": "extraversion", "label_ko": "외향성", "label_en": "Extraversion", "low": "내향·차분", "high": "외향·활발"},
    {"key": "agreeableness", "label_ko": "우호성", "label_en": "Agreeableness", "low": "솔직·경쟁적", "high": "다정·협조적"},
    {"key": "neuroticism", "label_ko": "신경성", "label_en": "Neuroticism", "low": "안정·태연", "high": "민감·감정적"},
]

STYLE_AXES: List[Dict[str, str]] = [
    {"key": "warmth", "label_ko": "온기", "label_en": "Warmth", "low": "차분·담백", "high": "따뜻·애정"},
    {"key": "humor", "label_ko": "유머", "label_en": "Humor", "low": "진지", "high": "유쾌·재치"},
    {"key": "playfulness", "label_ko": "장난기", "label_en": "Playfulness", "low": "차분", "high": "장난·놀림"},
    {"key": "formality", "label_ko": "격식", "label_en": "Formality", "low": "반말·캐주얼", "high": "존댓말·격식"},
    {"key": "assertiveness", "label_ko": "적극성", "label_en": "Assertiveness", "low": "조심·수동", "high": "주도·적극"},
    {"key": "verbosity", "label_ko": "말수", "label_en": "Verbosity", "low": "간결", "high": "수다·자세"},
    {"key": "emoji", "label_ko": "이모티콘", "label_en": "Emoji", "low": "거의 안 씀", "high": "자주 씀"},
    {"key": "enthusiasm", "label_ko": "활력", "label_en": "Enthusiasm", "low": "잔잔", "high": "에너제틱"},
    {"key": "directness", "label_ko": "직설성", "label_en": "Directness", "low": "완곡·배려", "high": "직설·단도직입"},
]


def list_frameworks() -> Dict[str, object]:
    """The full catalog payload for the builder UI."""
    return {
        "mbti": [{"code": k, "label_ko": v["label_ko"]} for k, v in MBTI.items()],
        "enneagram": [{"code": k, "label_ko": v["label_ko"]} for k, v in ENNEAGRAM.items()],
        "archetypes": [{"code": k, "label_ko": v["label_ko"]} for k, v in ARCHETYPES.items()],
        "ocean_axes": OCEAN_AXES,
        "style_axes": STYLE_AXES,
        "honorifics": [
            {"code": "auto", "label_ko": "자동(격식 슬라이더 기준)"},
            {"code": "banmal", "label_ko": "반말"},
            {"code": "jondaetmal", "label_ko": "존댓말"},
            {"code": "mixed", "label_ko": "혼합(상황에 따라)"},
        ],
        "emotion_tags": _emotion_tags(),
    }


def _emotion_tags() -> List[str]:
    """The *core* emotion vocabulary for the builder's mood pickers — the 6
    canonical mood axes + neutral (single source of truth in the affect
    taxonomy). The full 27-tag RECOGNIZED set stays valid at emit time; here we
    surface only the core dispositions Geny actually expresses, per its affect
    philosophy. Returned in canonical (not alphabetical) order."""
    try:
        from service.affect.taxonomy import CORE_EMOTIONS  # noqa: PLC0415

        return list(CORE_EMOTIONS)
    except Exception:  # noqa: BLE001 — fall back to the canonical core set
        return ["joy", "sadness", "anger", "fear", "calm", "excitement", "neutral"]


__all__ = [
    "MBTI",
    "ENNEAGRAM",
    "ARCHETYPES",
    "OCEAN_AXES",
    "STYLE_AXES",
    "list_frameworks",
]
