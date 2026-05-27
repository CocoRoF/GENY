"""
Dependency-free language detector for Voice Studio Tools.

Uses Unicode block ratios — accurate for Korean / Japanese / Chinese /
English and the common Latin/Cyrillic/Arabic/Devanagari scripts; falls
back to ``unknown`` otherwise. The heuristic favours ja over zh when
both Han + kana are present, which is the only reliable disambiguator
without a real language model.

We intentionally don't ship the ``langdetect`` PyPI package — keeping
backend deps untouched matters more here than catching every minor
language.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict


def _in(ch: str, start: str, end: str) -> bool:
    return start <= ch <= end


@dataclass(slots=True)
class LangDetectResult:
    language: str
    confidence: float  # 0.0 ~ 1.0
    detail: Dict[str, float]

    def to_dict(self) -> dict:
        return {
            "language": self.language,
            "confidence": round(self.confidence, 4),
            "detail": {k: round(v, 4) for k, v in self.detail.items()},
        }


_BUCKETS = (
    "hangul", "hiragana", "katakana", "han",
    "latin", "cyrillic", "arabic", "devanagari", "other",
)


def _classify(ch: str) -> str:
    if _in(ch, "가", "힯"):
        return "hangul"
    if _in(ch, "぀", "ゟ"):
        return "hiragana"
    if _in(ch, "゠", "ヿ"):
        return "katakana"
    if _in(ch, "一", "鿿") or _in(ch, "㐀", "䶿"):
        return "han"
    if ("a" <= ch.lower() <= "z"):
        return "latin"
    if _in(ch, "Ѐ", "ӿ"):
        return "cyrillic"
    if _in(ch, "؀", "ۿ"):
        return "arabic"
    if _in(ch, "ऀ", "ॿ"):
        return "devanagari"
    return "other"


def detect_language(text: str) -> LangDetectResult:
    if not text:
        return LangDetectResult(language="unknown", confidence=0.0, detail={})

    # Only count letters / scripts; skip digits, punctuation, whitespace.
    counts = {b: 0 for b in _BUCKETS}
    n_letters = 0
    for ch in text:
        if ch.isspace() or ch.isdigit():
            continue
        if not ch.isalpha() and _classify(ch) == "other":
            continue
        bucket = _classify(ch)
        counts[bucket] += 1
        n_letters += 1

    if n_letters == 0:
        return LangDetectResult(language="unknown", confidence=0.0, detail={})

    ratios: Dict[str, float] = {b: c / n_letters for b, c in counts.items() if c > 0}

    # Disambiguation order:
    #   hangul (any meaningful share) → ko
    #   hiragana or katakana present → ja
    #   han only → zh
    #   latin dominant → en
    #   else top script
    if ratios.get("hangul", 0) >= 0.30:
        lang, conf = "ko", ratios["hangul"]
    elif ratios.get("hiragana", 0) + ratios.get("katakana", 0) >= 0.05:
        lang = "ja"
        conf = ratios.get("hiragana", 0) + ratios.get("katakana", 0) + ratios.get("han", 0)
        conf = min(conf, 1.0)
    elif ratios.get("han", 0) >= 0.30:
        lang, conf = "zh", ratios["han"]
    elif ratios.get("latin", 0) >= 0.50:
        lang, conf = "en", ratios["latin"]
    elif ratios.get("cyrillic", 0) >= 0.40:
        lang, conf = "ru", ratios["cyrillic"]
    elif ratios.get("arabic", 0) >= 0.40:
        lang, conf = "ar", ratios["arabic"]
    elif ratios.get("devanagari", 0) >= 0.40:
        lang, conf = "hi", ratios["devanagari"]
    else:
        # Pick the biggest non-other bucket; downgrade confidence so the
        # UI can show "unsure".
        usable = {k: v for k, v in ratios.items() if k != "other"}
        if not usable:
            return LangDetectResult(language="unknown", confidence=0.0, detail=ratios)
        top = max(usable.items(), key=lambda kv: kv[1])
        guess_lang = {
            "latin": "en",
            "hangul": "ko",
            "hiragana": "ja",
            "katakana": "ja",
            "han": "zh",
            "cyrillic": "ru",
            "arabic": "ar",
            "devanagari": "hi",
        }.get(top[0], "unknown")
        lang, conf = guess_lang, top[1] * 0.6  # discount

    return LangDetectResult(language=lang, confidence=min(max(conf, 0.0), 1.0), detail=ratios)
