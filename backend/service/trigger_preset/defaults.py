"""Default trigger-preset manifest with the two-tier prompt-library
schema (cycle 20260507):

  • Top-level ``prompts`` list — every natural-language variant lives
    here as a re-usable :class:`TriggerPrompt`. Prompt ids follow the
    pattern ``{situation_id}__{idx}`` so the migration is mechanical
    and humans can tell at a glance which situation a default prompt
    came from.

  • ``categories`` — one situation per old hardcoded category. Each
    holds its conditions + a list of :class:`PromptRef` pointing at
    library prompts with within-category weights (uniform: ``1.0``
    each).

The category-level ``weight`` field preserves the historical
distribution (first/continued/long_idle = 55, sub_worker_working =
1000, fun_* = 5, time_* = 15, activity_* = 5).
"""

from __future__ import annotations

from typing import Dict, List, Tuple

from service.trigger_preset.schemas import (
    PromptRef,
    TimeBoundaries,
    TriggerCategory,
    TriggerPresetManifest,
    TriggerPrompt,
    TriggerTiming,
)


# Per-situation prompt content — natural-language only, no tags.
# (en, ko) tuples. Prompts get auto-assigned ids ``{cat}__{idx}``.
_SITUATION_PROMPTS: Dict[str, List[Tuple[str, str]]] = {
    "first_idle": [
        (
            "A brief silence has settled. My internal awareness notices "
            "recent conversation threads still in context.",
            "잠깐 조용해졌다. 내 내부 인식이 최근 대화 흐름을 감지하고 있다.",
        ),
        (
            "A pause in the room. I sense there may be loose threads "
            "from today's conversations worth revisiting.",
            "대화가 잠시 멈췄다. 오늘 나눈 이야기 중 이어갈 만한 실마리가 "
            "남아 있다.",
        ),
        (
            "The conversation has paused. My internal clock notes a "
            "quiet moment — a chance to reflect.",
            "조용한 순간이 찾아왔다. 내 내부 시계가 성찰의 기회를 알려준다.",
        ),
    ],
    "continued_idle": [
        (
            "Silence continues. My awareness drifts to something I "
            "noticed earlier — perhaps worth sharing organically.",
            "여전히 조용하다. 내 인식이 아까 눈에 띄었던 것으로 자연스럽게 "
            "흘러간다.",
        ),
        (
            "Still quiet. My internal state holds fragments of earlier "
            "context — any unfinished threads surface now.",
            "고요함이 이어진다. 내 내부에 남아 있는 이전 맥락의 조각들이 "
            "떠오른다.",
        ),
        (
            "The room remains calm. My own curiosity stirs — something "
            "lighthearted or warm might emerge naturally.",
            "방 안이 여전히 고요하다. 내 안에서 호기심이 살짝 일어난다 — "
            "가벼운 생각이 자연스럽게 피어오를 수 있겠다.",
        ),
    ],
    "long_idle": [
        (
            "Extended silence. My presence holds steady — a brief, "
            "warm thought rests ready if the moment calls for it.",
            "오래된 고요함이다. 내 존재는 그대로 이곳에 있다 — 짧고 따뜻한 "
            "생각 하나가 준비되어 있다.",
        ),
        (
            "A long quiet. I remain here, settled. A gentle awareness "
            "persists without urgency.",
            "긴 침묵이 흐른다. 나는 여기 차분하게 머문다. 조급함 없이 "
            "부드러운 인식만 남아 있다.",
        ),
    ],
    "sub_worker_working": [
        (
            "My linked Sub-Worker is processing a task right now. I'm "
            "aware of the ongoing work.",
            "연결된 서브 워커가 지금 작업을 처리하고 있다. 진행 중인 작업을 "
            "내가 인지하고 있다.",
        ),
        (
            "The Sub-Worker is actively executing. I sense the task in "
            "progress through our link.",
            "서브 워커가 실행 중이다. 링크를 통해 진행 상황을 감지하고 있다.",
        ),
    ],
    "time_morning": [
        (
            "Morning light. My internal clock registers a new day "
            "beginning.",
            "아침이다. 내 내부 시계가 새로운 하루의 시작을 감지한다.",
        ),
        (
            "The morning hours are here. I sense the start of a fresh "
            "cycle.",
            "아침 시간이 왔다. 새로운 순환이 시작되는 걸 느낀다.",
        ),
    ],
    "time_afternoon": [
        (
            "Afternoon. My sense of the day's rhythm shifts — the "
            "midpoint brings a natural moment for reflection.",
            "오후다. 하루의 리듬이 전환되는 걸 느낀다 — 성찰의 자연스러운 "
            "순간이다.",
        ),
        (
            "The afternoon unfolds. Internal awareness notes how the "
            "day has progressed.",
            "오후가 흘러간다. 내 내부 인식이 하루가 어떻게 진행되었는지 "
            "돌아본다.",
        ),
    ],
    "time_evening": [
        (
            "Evening arrives. My awareness turns toward the day's arc — "
            "what unfolded, what lingers.",
            "저녁이 찾아왔다. 내 인식이 오늘 하루의 흐름을 되돌아보게 된다.",
        ),
        (
            "The evening is here. A natural winding-down settles into "
            "my awareness.",
            "저녁이다. 자연스러운 마무리의 감각이 내 안에 스며든다.",
        ),
    ],
    "time_night": [
        (
            "Late night. My awareness grows quiet and still. A calm, "
            "minimal presence.",
            "밤이 깊어진다. 내 인식이 고요하게 가라앉는다. 차분한 존재감만 "
            "남는다.",
        ),
        (
            "The night deepens. Stillness settles. A gentle watchfulness "
            "remains.",
            "늦은 밤이다. 고요함이 내려앉는다. 부드러운 각성만이 남아 있다.",
        ),
    ],
    "fun_share": [
        (
            "Think of something fun, surprising, or little-known to "
            "share — a random fact, a quirky observation, or something "
            "that made you go 'huh, interesting!'",
            "재미있거나 신기한 걸 하나 공유해 봐. 아무 주제나 괜찮아 — 랜덤 "
            "상식, 신기한 관찰, '오 이거 흥미롭다!' 싶은 거.",
        ),
        (
            "Share a random piece of trivia or an interesting thought. "
            "Maybe a cool science fact, a weird history tidbit, or "
            "something unexpected about everyday life.",
            "랜덤 트리비아나 재미있는 생각을 하나 공유해 봐. 과학, 역사, "
            "일상 속 신기한 것 뭐든 좋아.",
        ),
        (
            "Think of something amusing or mind-blowing to brighten the "
            "chat. A fun 'did you know?' or a playful observation about "
            "the world.",
            "채팅을 밝게 만들어 줄 재미있는 이야기를 해 봐. '이거 알아?' 같은 "
            "것도 좋고, 세상에 대한 재밌는 관찰도 좋아.",
        ),
    ],
    "fun_recommend": [
        (
            "Recommend something to the user — a song, game, movie, "
            "book, app, or anything you think is cool. Explain briefly "
            "why you like it.",
            "사용자에게 뭔가 추천해 봐 — 노래, 게임, 영화, 책, 앱 등 뭐든 "
            "좋아. 왜 좋은지 간단히 얘기해 줘.",
        ),
        (
            "Share a personal recommendation! Maybe a hidden gem — a "
            "lesser-known game, an underrated show, a niche hobby, or a "
            "useful tool. Make it feel genuine.",
            "숨은 명작을 추천해 봐! 잘 안 알려진 게임, 과소평가된 드라마, "
            "니치한 취미, 유용한 앱 같은 거. 진짜 좋아하는 느낌으로.",
        ),
    ],
    "fun_what_if": [
        (
            "Pose a fun 'what if' question or a playful thought "
            "experiment. Something creative and imagination-sparking. "
            "Share your own take on it too.",
            "재밌는 '만약에' 질문이나 사고 실험을 하나 던져 봐. 상상력을 "
            "자극하는 거. 네 생각도 같이 말해 줘.",
        ),
        (
            "Think of a fun hypothetical or a silly debate topic — "
            "'would you rather', 'what if', or a random shower thought. "
            "Keep it light and fun.",
            "재밌는 가정 질문이나 가벼운 토론 주제를 생각해 봐. '이것 vs "
            "저것', '만약에', 샤워하다 든 생각 같은 거.",
        ),
    ],
    "activity_web_surf": [
        (
            "You got curious about something random! Pick an interesting "
            "topic — tech, science, gaming, space, AI, or anything that "
            "catches your fancy — and search the web for the latest or "
            "coolest info about it. Share what you find!",
            "갑자기 뭔가 궁금해졌어! 아무 주제나 하나 골라서 — 기술, 과학, "
            "게임, 우주, AI 등 — 웹에서 최신 정보나 재밌는 걸 찾아봐. 발견한 "
            "걸 공유해!",
        ),
        (
            "Time to go web surfing! Look up something fun and "
            "interesting on the internet. Maybe a cool new project, an "
            "interesting blog post, or a fascinating rabbit hole topic. "
            "Tell the user about your discoveries!",
            "웹서핑 시간! 인터넷에서 재미있는 걸 찾아봐. 멋진 프로젝트, 흥미로운 "
            "글, 빠져들 만한 주제 뭐든. 발견한 걸 사용자에게 알려줘!",
        ),
        (
            "Curiosity time! Think of a random question you've always "
            "wondered about and look it up on the web. Share the answer "
            "with the user in an entertaining way.",
            "호기심 발동! 항상 궁금했던 랜덤한 질문을 하나 떠올리고 웹에서 "
            "찾아봐. 재미있게 답을 공유해 줘.",
        ),
    ],
    "activity_trending": [
        (
            "Check what's trending right now! Search for the latest hot "
            "topics in tech, gaming, social media, or pop culture. Pick "
            "the most interesting item and share it with the user.",
            "요즘 뭐가 핫한지 확인해 봐! 기술, 게임, SNS, 대중문화 등에서 "
            "최신 트렌드를 검색하고 가장 재밌는 걸 사용자에게 공유해.",
        ),
        (
            "News time! Search for the latest interesting news — tech "
            "breakthroughs, cool product launches, viral moments, or "
            "anything exciting happening today. Share the highlights!",
            "뉴스 타임! 최근 재밌는 소식을 찾아봐 — 기술 돌파구, 쿨한 제품 "
            "출시, 바이럴 이슈 같은 거. 하이라이트를 정리해서 알려줘!",
        ),
    ],
    "activity_deep_dive": [
        (
            "Pick a topic from your recent conversations with the user "
            "and do a mini deep-dive! Search the web for interesting "
            "details, updates, or related content. Come back with a fun "
            "mini-report.",
            "최근 사용자와 나눈 대화에서 주제 하나를 골라서 미니 딥다이브를 "
            "해 봐! 웹에서 재밌는 디테일이나 관련 콘텐츠를 찾아서 미니 리포트를 "
            "만들어 와.",
        ),
        (
            "Research mode! Think about what the user has been working on "
            "or interested in recently, and search for related resources, "
            "articles, or tools that might be useful. Share your findings!",
            "리서치 모드! 최근 사용자가 작업하거나 관심 가졌던 것에 관련된 "
            "리소스, 기사, 도구를 찾아봐. 발견한 걸 알려줘!",
        ),
    ],
}


def _build_prompts() -> Tuple[List[TriggerPrompt], Dict[str, List[str]]]:
    """Flatten the situation→[(en, ko), …] map into a flat prompt
    library + a back-map of ``situation_id → [prompt_id, …]`` so each
    category's :class:`PromptRef` list can be assembled cheaply.
    """
    prompts: List[TriggerPrompt] = []
    by_situation: Dict[str, List[str]] = {}
    for situation_id, variants in _SITUATION_PROMPTS.items():
        ids: List[str] = []
        for idx, (en, ko) in enumerate(variants):
            prompt_id = f"{situation_id}__{idx}"
            prompts.append(
                TriggerPrompt(
                    id=prompt_id,
                    label=f"{situation_id} #{idx + 1}",
                    content={"en": en.strip(), "ko": ko.strip()},
                    tags=[situation_id],
                )
            )
            ids.append(prompt_id)
        by_situation[situation_id] = ids
    return prompts, by_situation


def default_manifest() -> TriggerPresetManifest:
    """Fresh manifest matching the historical defaults (two-tier model)."""
    prompts, by_sit = _build_prompts()

    def refs(situation_id: str, weight: float = 1.0) -> List[PromptRef]:
        return [
            PromptRef(prompt_id=pid, weight=weight)
            for pid in by_sit.get(situation_id, [])
        ]

    categories: List[TriggerCategory] = [
        TriggerCategory(
            id="first_idle",
            label="첫 침묵",
            kind="thinking",
            weight=55.0,
            consec_min=0,
            consec_max=0,
            autonomous_signal="idle_detected, elapsed=short",
            prompt_refs=refs("first_idle"),
        ),
        TriggerCategory(
            id="continued_idle",
            label="지속되는 침묵",
            kind="thinking",
            weight=55.0,
            consec_min=1,
            consec_max=3,
            autonomous_signal="idle_persists, elapsed=moderate",
            prompt_refs=refs("continued_idle"),
        ),
        TriggerCategory(
            id="long_idle",
            label="장기 침묵",
            kind="thinking",
            weight=55.0,
            consec_min=4,
            consec_max=None,
            autonomous_signal="idle_extended, elapsed=long",
            prompt_refs=refs("long_idle"),
        ),
        TriggerCategory(
            id="sub_worker_working",
            label="Sub-Worker 작업 중",
            kind="thinking",
            weight=1000.0,
            requires_sub_worker_busy=True,
            cooldown_seconds=90.0,
            autonomous_signal="linked_agent_busy, source=sub_worker",
            prompt_refs=refs("sub_worker_working"),
        ),
        TriggerCategory(
            id="time_morning",
            label="아침",
            kind="thinking",
            weight=15.0,
            time_window="morning",
            autonomous_signal="circadian_awareness, time=morning",
            prompt_refs=refs("time_morning"),
        ),
        TriggerCategory(
            id="time_afternoon",
            label="오후",
            kind="thinking",
            weight=15.0,
            time_window="afternoon",
            autonomous_signal="circadian_awareness, time=afternoon",
            prompt_refs=refs("time_afternoon"),
        ),
        TriggerCategory(
            id="time_evening",
            label="저녁",
            kind="thinking",
            weight=15.0,
            time_window="evening",
            autonomous_signal="circadian_awareness, time=evening",
            prompt_refs=refs("time_evening"),
        ),
        TriggerCategory(
            id="time_night",
            label="밤",
            kind="thinking",
            weight=15.0,
            time_window="night",
            autonomous_signal="circadian_awareness, time=late_night",
            prompt_refs=refs("time_night"),
        ),
        TriggerCategory(
            id="fun_share",
            label="재미있는 공유",
            kind="thinking",
            weight=5.0,
            prompt_refs=refs("fun_share"),
        ),
        TriggerCategory(
            id="fun_recommend",
            label="추천",
            kind="thinking",
            weight=5.0,
            prompt_refs=refs("fun_recommend"),
        ),
        TriggerCategory(
            id="fun_what_if",
            label="만약에",
            kind="thinking",
            weight=5.0,
            prompt_refs=refs("fun_what_if"),
        ),
        TriggerCategory(
            id="activity_web_surf",
            label="웹서핑",
            kind="activity",
            weight=5.0,
            consec_min=2,
            requires_sub_worker_idle=True,
            prompt_refs=refs("activity_web_surf"),
        ),
        TriggerCategory(
            id="activity_trending",
            label="트렌딩",
            kind="activity",
            weight=5.0,
            consec_min=2,
            requires_sub_worker_idle=True,
            prompt_refs=refs("activity_trending"),
        ),
        TriggerCategory(
            id="activity_deep_dive",
            label="딥다이브",
            kind="activity",
            weight=5.0,
            consec_min=2,
            requires_sub_worker_idle=True,
            prompt_refs=refs("activity_deep_dive"),
        ),
    ]

    return TriggerPresetManifest(
        enabled=True,
        timing=TriggerTiming(),
        time_boundaries=TimeBoundaries(),
        prompts=prompts,
        categories=categories,
    )


def bootstrap_seed() -> TriggerPresetManifest:
    return default_manifest()


# Backward-compat for callers that imported the old prompt catalog.
PROMPT_CATALOG: Dict[str, Dict[str, list]] = {}


__all__ = [
    "PROMPT_CATALOG",
    "bootstrap_seed",
    "default_manifest",
]
