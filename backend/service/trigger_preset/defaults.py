"""Default trigger-preset manifest — *bit-compatible* with the
historical hardcoded ladder in :mod:`service.vtuber.thinking_trigger`.

A VTuber session that has no preset attached still routes through the
trigger service, so we ship the same defaults as a callable factory:

* :func:`default_manifest` — returns a fresh
  :class:`~service.trigger_preset.schemas.TriggerPresetManifest` that
  reproduces the historical ladder exactly (probabilities, phase
  boundaries, condition gates, prompt copy).

* :func:`bootstrap_seed` — a richer factory used to seed the very first
  user-facing preset on a clean install. Same payload as
  :func:`default_manifest` today; the indirection lets us evolve the
  bundled "starter pack" without breaking the no-preset fallback that
  must remain stable.

Probability mapping — historical → declarative
----------------------------------------------

The old code rolled a single ``random()`` and laddered through three
priority buckets (activity 15 %, fun 15 %, time 15 %, idle 55 %) plus a
sub-worker-busy override. The declarative form expresses the same
distribution as a weighted roulette per phase, with category-level
:class:`CategoryConditions` standing in for the previous if/else gates:

* ``activity_*`` carry ``requires_sub_worker_idle=True`` +
  ``min_consecutive=2`` so they only become eligible when the linked
  sub-worker is idle and the session has already fired ≥2 triggers
  (matches the old "sub_worker_available" check).
* ``time_*`` carry ``time_window=<morning|afternoon|evening|night>``
  so only the matching window is eligible at any instant. Weights of
  15 sum to the historical 15 % time bucket regardless of clock hour.
* ``sub_worker_working`` carries ``requires_sub_worker_busy=True`` and
  a 90 s cooldown — the runtime normalises around it, so when the
  sub-worker is busy *and* cooldown elapsed, this entry dominates the
  roulette (priority-override semantics preserved).
* The idle-stage entry per phase (``first_idle`` / ``continued_idle``
  / ``long_idle``) carries weight 55 — the historical fallback share.

Net result: identical behaviour for the no-preset path, while every
knob is now a first-class field operators can override.
"""

from __future__ import annotations

from typing import Dict, List

from service.trigger_preset.schemas import (
    CategoryConditions,
    PhaseEvent,
    TimeBoundaries,
    TriggerCategory,
    TriggerPhase,
    TriggerPresetManifest,
    TriggerTiming,
)


# ============================================================================
# Prompt catalog — locale-keyed lists per category id.
# ============================================================================
# Source of truth for the historical prompts that ship with Geny. The
# ``thinking_trigger`` runtime imports this dict for the no-preset
# fallback path; the preset service also seeds new presets from it via
# :func:`default_manifest`. Keep prompts here so there is exactly one
# place to edit the bundled copy.

PROMPT_CATALOG: Dict[str, Dict[str, List[str]]] = {
    "first_idle": {
        "en": [
            (
                "[THINKING_TRIGGER:first_idle] "
                "[autonomous_signal: idle_detected, elapsed=short] "
                "A brief silence has settled. My internal awareness notices "
                "recent conversation threads still in context."
            ),
            (
                "[THINKING_TRIGGER:first_idle] "
                "[autonomous_signal: idle_detected, elapsed=short] "
                "A pause in the room. I sense there may be loose threads "
                "from today's conversations worth revisiting."
            ),
            (
                "[THINKING_TRIGGER:first_idle] "
                "[autonomous_signal: idle_detected, elapsed=short] "
                "The conversation has paused. My internal clock notes "
                "a quiet moment — a chance to reflect."
            ),
        ],
        "ko": [
            (
                "[THINKING_TRIGGER:first_idle] "
                "[autonomous_signal: idle_detected, elapsed=short] "
                "잠깐 조용해졌다. 내 내부 인식이 최근 대화 흐름을 "
                "감지하고 있다."
            ),
            (
                "[THINKING_TRIGGER:first_idle] "
                "[autonomous_signal: idle_detected, elapsed=short] "
                "대화가 잠시 멈췄다. 오늘 나눈 이야기 중 "
                "이어갈 만한 실마리가 남아 있다."
            ),
            (
                "[THINKING_TRIGGER:first_idle] "
                "[autonomous_signal: idle_detected, elapsed=short] "
                "조용한 순간이 찾아왔다. 내 내부 시계가 "
                "성찰의 기회를 알려준다."
            ),
        ],
    },
    "continued_idle": {
        "en": [
            (
                "[THINKING_TRIGGER:continued_idle] "
                "[autonomous_signal: idle_persists, elapsed=moderate] "
                "Silence continues. My awareness drifts to something "
                "I noticed earlier — perhaps worth sharing organically."
            ),
            (
                "[THINKING_TRIGGER:continued_idle] "
                "[autonomous_signal: idle_persists, elapsed=moderate] "
                "Still quiet. My internal state holds fragments of "
                "earlier context — any unfinished threads surface now."
            ),
            (
                "[THINKING_TRIGGER:continued_idle] "
                "[autonomous_signal: idle_persists, elapsed=moderate] "
                "The room remains calm. My own curiosity stirs — "
                "something lighthearted or warm might emerge naturally."
            ),
        ],
        "ko": [
            (
                "[THINKING_TRIGGER:continued_idle] "
                "[autonomous_signal: idle_persists, elapsed=moderate] "
                "여전히 조용하다. 내 인식이 아까 눈에 띄었던 것으로 "
                "자연스럽게 흘러간다."
            ),
            (
                "[THINKING_TRIGGER:continued_idle] "
                "[autonomous_signal: idle_persists, elapsed=moderate] "
                "고요함이 이어진다. 내 내부에 남아 있는 "
                "이전 맥락의 조각들이 떠오른다."
            ),
            (
                "[THINKING_TRIGGER:continued_idle] "
                "[autonomous_signal: idle_persists, elapsed=moderate] "
                "방 안이 여전히 고요하다. 내 안에서 호기심이 "
                "살짝 일어난다 — 가벼운 생각이 자연스럽게 피어오를 수 있겠다."
            ),
        ],
    },
    "long_idle": {
        "en": [
            (
                "[THINKING_TRIGGER:long_idle] "
                "[autonomous_signal: idle_extended, elapsed=long] "
                "Extended silence. My presence holds steady — a brief, "
                "warm thought rests ready if the moment calls for it."
            ),
            (
                "[THINKING_TRIGGER:long_idle] "
                "[autonomous_signal: idle_extended, elapsed=long] "
                "A long quiet. I remain here, settled. A gentle "
                "awareness persists without urgency."
            ),
        ],
        "ko": [
            (
                "[THINKING_TRIGGER:long_idle] "
                "[autonomous_signal: idle_extended, elapsed=long] "
                "오래된 고요함이다. 내 존재는 그대로 이곳에 있다 — "
                "짧고 따뜻한 생각 하나가 준비되어 있다."
            ),
            (
                "[THINKING_TRIGGER:long_idle] "
                "[autonomous_signal: idle_extended, elapsed=long] "
                "긴 침묵이 흐른다. 나는 여기 차분하게 머문다. "
                "조급함 없이 부드러운 인식만 남아 있다."
            ),
        ],
    },
    "sub_worker_working": {
        "en": [
            (
                "[THINKING_TRIGGER:sub_worker_working] "
                "[autonomous_signal: linked_agent_busy, source=sub_worker] "
                "My linked Sub-Worker is processing a task right now. "
                "I'm aware of the ongoing work."
            ),
            (
                "[THINKING_TRIGGER:sub_worker_working] "
                "[autonomous_signal: linked_agent_busy, source=sub_worker] "
                "The Sub-Worker is actively executing. I sense the "
                "task in progress through our link."
            ),
        ],
        "ko": [
            (
                "[THINKING_TRIGGER:sub_worker_working] "
                "[autonomous_signal: linked_agent_busy, source=sub_worker] "
                "연결된 서브 워커가 지금 작업을 처리하고 있다. "
                "진행 중인 작업을 내가 인지하고 있다."
            ),
            (
                "[THINKING_TRIGGER:sub_worker_working] "
                "[autonomous_signal: linked_agent_busy, source=sub_worker] "
                "서브 워커가 실행 중이다. 링크를 통해 "
                "진행 상황을 감지하고 있다."
            ),
        ],
    },
    "time_morning": {
        "en": [
            (
                "[THINKING_TRIGGER:time_morning] "
                "[autonomous_signal: circadian_awareness, time=morning] "
                "Morning light. My internal clock registers a new day "
                "beginning."
            ),
            (
                "[THINKING_TRIGGER:time_morning] "
                "[autonomous_signal: circadian_awareness, time=morning] "
                "The morning hours are here. I sense the start of "
                "a fresh cycle."
            ),
        ],
        "ko": [
            (
                "[THINKING_TRIGGER:time_morning] "
                "[autonomous_signal: circadian_awareness, time=morning] "
                "아침이다. 내 내부 시계가 새로운 하루의 시작을 "
                "감지한다."
            ),
            (
                "[THINKING_TRIGGER:time_morning] "
                "[autonomous_signal: circadian_awareness, time=morning] "
                "아침 시간이 왔다. 새로운 순환이 시작되는 걸 "
                "느낀다."
            ),
        ],
    },
    "time_afternoon": {
        "en": [
            (
                "[THINKING_TRIGGER:time_afternoon] "
                "[autonomous_signal: circadian_awareness, time=afternoon] "
                "Afternoon. My sense of the day's rhythm shifts — "
                "the midpoint brings a natural moment for reflection."
            ),
            (
                "[THINKING_TRIGGER:time_afternoon] "
                "[autonomous_signal: circadian_awareness, time=afternoon] "
                "The afternoon unfolds. Internal awareness notes "
                "how the day has progressed."
            ),
        ],
        "ko": [
            (
                "[THINKING_TRIGGER:time_afternoon] "
                "[autonomous_signal: circadian_awareness, time=afternoon] "
                "오후다. 하루의 리듬이 전환되는 걸 느낀다 — "
                "성찰의 자연스러운 순간이다."
            ),
            (
                "[THINKING_TRIGGER:time_afternoon] "
                "[autonomous_signal: circadian_awareness, time=afternoon] "
                "오후가 흘러간다. 내 내부 인식이 하루가 "
                "어떻게 진행되었는지 돌아본다."
            ),
        ],
    },
    "time_evening": {
        "en": [
            (
                "[THINKING_TRIGGER:time_evening] "
                "[autonomous_signal: circadian_awareness, time=evening] "
                "Evening arrives. My awareness turns toward the day's "
                "arc — what unfolded, what lingers."
            ),
            (
                "[THINKING_TRIGGER:time_evening] "
                "[autonomous_signal: circadian_awareness, time=evening] "
                "The evening is here. A natural winding-down settles "
                "into my awareness."
            ),
        ],
        "ko": [
            (
                "[THINKING_TRIGGER:time_evening] "
                "[autonomous_signal: circadian_awareness, time=evening] "
                "저녁이 찾아왔다. 내 인식이 오늘 하루의 흐름을 "
                "되돌아보게 된다."
            ),
            (
                "[THINKING_TRIGGER:time_evening] "
                "[autonomous_signal: circadian_awareness, time=evening] "
                "저녁이다. 자연스러운 마무리의 감각이 "
                "내 안에 스며든다."
            ),
        ],
    },
    "time_night": {
        "en": [
            (
                "[THINKING_TRIGGER:time_night] "
                "[autonomous_signal: circadian_awareness, time=late_night] "
                "Late night. My awareness grows quiet and still. "
                "A calm, minimal presence."
            ),
            (
                "[THINKING_TRIGGER:time_night] "
                "[autonomous_signal: circadian_awareness, time=late_night] "
                "The night deepens. Stillness settles. "
                "A gentle watchfulness remains."
            ),
        ],
        "ko": [
            (
                "[THINKING_TRIGGER:time_night] "
                "[autonomous_signal: circadian_awareness, time=late_night] "
                "밤이 깊어진다. 내 인식이 고요하게 가라앉는다. "
                "차분한 존재감만 남는다."
            ),
            (
                "[THINKING_TRIGGER:time_night] "
                "[autonomous_signal: circadian_awareness, time=late_night] "
                "늦은 밤이다. 고요함이 내려앉는다. "
                "부드러운 각성만이 남아 있다."
            ),
        ],
    },
    "fun_share": {
        "en": [
            (
                "[THINKING_TRIGGER] Think of something fun, surprising, or "
                "little-known to share — a random fact, a quirky observation, "
                "or something that made you go 'huh, interesting!'"
            ),
            (
                "[THINKING_TRIGGER] Share a random piece of trivia or an "
                "interesting thought. Maybe a cool science fact, a weird "
                "history tidbit, or something unexpected about everyday life."
            ),
            (
                "[THINKING_TRIGGER] Think of something amusing or mind-blowing "
                "to brighten the chat. A fun 'did you know?' or a playful "
                "observation about the world."
            ),
        ],
        "ko": [
            (
                "[THINKING_TRIGGER] 재미있거나 신기한 걸 하나 공유해 봐. "
                "아무 주제나 괜찮아 — 랜덤 상식, 신기한 관찰, "
                "'오 이거 흥미롭다!' 싶은 거."
            ),
            (
                "[THINKING_TRIGGER] 랜덤 트리비아나 재미있는 생각을 하나 공유해 봐. "
                "과학, 역사, 일상 속 신기한 것 뭐든 좋아."
            ),
            (
                "[THINKING_TRIGGER] 채팅을 밝게 만들어 줄 재미있는 이야기를 해 봐. "
                "'이거 알아?' 같은 것도 좋고, 세상에 대한 재밌는 관찰도 좋아."
            ),
        ],
    },
    "fun_recommend": {
        "en": [
            (
                "[THINKING_TRIGGER] Recommend something to the user — a song, "
                "game, movie, book, app, or anything you think is cool. "
                "Explain briefly why you like it."
            ),
            (
                "[THINKING_TRIGGER] Share a personal recommendation! Maybe a "
                "hidden gem — a lesser-known game, an underrated show, a niche "
                "hobby, or a useful tool. Make it feel genuine."
            ),
        ],
        "ko": [
            (
                "[THINKING_TRIGGER] 사용자에게 뭔가 추천해 봐 — 노래, 게임, "
                "영화, 책, 앱 등 뭐든 좋아. 왜 좋은지 간단히 얘기해 줘."
            ),
            (
                "[THINKING_TRIGGER] 숨은 명작을 추천해 봐! 잘 안 알려진 게임, "
                "과소평가된 드라마, 니치한 취미, 유용한 앱 같은 거. "
                "진짜 좋아하는 느낌으로."
            ),
        ],
    },
    "fun_what_if": {
        "en": [
            (
                "[THINKING_TRIGGER] Pose a fun 'what if' question or a playful "
                "thought experiment. Something creative and imagination-sparking. "
                "Share your own take on it too."
            ),
            (
                "[THINKING_TRIGGER] Think of a fun hypothetical or a silly "
                "debate topic — 'would you rather', 'what if', or a random "
                "shower thought. Keep it light and fun."
            ),
        ],
        "ko": [
            (
                "[THINKING_TRIGGER] 재밌는 '만약에' 질문이나 사고 실험을 하나 "
                "던져 봐. 상상력을 자극하는 거. 네 생각도 같이 말해 줘."
            ),
            (
                "[THINKING_TRIGGER] 재밌는 가정 질문이나 가벼운 토론 주제를 "
                "생각해 봐. '이것 vs 저것', '만약에', 샤워하다 든 생각 같은 거."
            ),
        ],
    },
    "activity_web_surf": {
        "en": [
            (
                "[ACTIVITY_TRIGGER] You got curious about something random! "
                "Pick an interesting topic — tech, science, gaming, space, "
                "AI, or anything that catches your fancy — and search the web "
                "for the latest or coolest info about it. Share what you find!"
            ),
            (
                "[ACTIVITY_TRIGGER] Time to go web surfing! Look up something "
                "fun and interesting on the internet. Maybe a cool new project, "
                "an interesting blog post, or a fascinating rabbit hole topic. "
                "Tell the user about your discoveries!"
            ),
            (
                "[ACTIVITY_TRIGGER] Curiosity time! Think of a random question "
                "you've always wondered about and look it up on the web. "
                "Share the answer with the user in an entertaining way."
            ),
        ],
        "ko": [
            (
                "[ACTIVITY_TRIGGER] 갑자기 뭔가 궁금해졌어! 아무 주제나 하나 "
                "골라서 — 기술, 과학, 게임, 우주, AI 등 — 웹에서 최신 정보나 "
                "재밌는 걸 찾아봐. 발견한 걸 공유해!"
            ),
            (
                "[ACTIVITY_TRIGGER] 웹서핑 시간! 인터넷에서 재미있는 걸 찾아봐. "
                "멋진 프로젝트, 흥미로운 글, 빠져들 만한 주제 뭐든. "
                "발견한 걸 사용자에게 알려줘!"
            ),
            (
                "[ACTIVITY_TRIGGER] 호기심 발동! 항상 궁금했던 랜덤한 질문을 "
                "하나 떠올리고 웹에서 찾아봐. 재미있게 답을 공유해 줘."
            ),
        ],
    },
    "activity_trending": {
        "en": [
            (
                "[ACTIVITY_TRIGGER] Check what's trending right now! "
                "Search for the latest hot topics in tech, gaming, social media, "
                "or pop culture. Pick the most interesting item and share it "
                "with the user."
            ),
            (
                "[ACTIVITY_TRIGGER] News time! Search for the latest interesting "
                "news — tech breakthroughs, cool product launches, viral moments, "
                "or anything exciting happening today. Share the highlights!"
            ),
        ],
        "ko": [
            (
                "[ACTIVITY_TRIGGER] 요즘 뭐가 핫한지 확인해 봐! "
                "기술, 게임, SNS, 대중문화 등에서 최신 트렌드를 검색하고 "
                "가장 재밌는 걸 사용자에게 공유해."
            ),
            (
                "[ACTIVITY_TRIGGER] 뉴스 타임! 최근 재밌는 소식을 찾아봐 — "
                "기술 돌파구, 쿨한 제품 출시, 바이럴 이슈 같은 거. "
                "하이라이트를 정리해서 알려줘!"
            ),
        ],
    },
    "activity_deep_dive": {
        "en": [
            (
                "[ACTIVITY_TRIGGER] Pick a topic from your recent conversations "
                "with the user and do a mini deep-dive! Search the web for "
                "interesting details, updates, or related content. "
                "Come back with a fun mini-report."
            ),
            (
                "[ACTIVITY_TRIGGER] Research mode! Think about what the user "
                "has been working on or interested in recently, and search "
                "for related resources, articles, or tools that might be useful. "
                "Share your findings!"
            ),
        ],
        "ko": [
            (
                "[ACTIVITY_TRIGGER] 최근 사용자와 나눈 대화에서 주제 하나를 골라서 "
                "미니 딥다이브를 해 봐! 웹에서 재밌는 디테일이나 관련 콘텐츠를 "
                "찾아서 미니 리포트를 만들어 와."
            ),
            (
                "[ACTIVITY_TRIGGER] 리서치 모드! 최근 사용자가 작업하거나 "
                "관심 가졌던 것에 관련된 리소스, 기사, 도구를 찾아봐. "
                "발견한 걸 알려줘!"
            ),
        ],
    },
}


# ============================================================================
# Category catalog — id, label, kind, conditions, cooldown.
# ============================================================================
# Tuple shape: (id, label, kind, conditions kwargs, cooldown_seconds)


_CATEGORY_DEFS: List[tuple] = [
    # ── Idle-stage prompts (no gates; weight differs by phase) ──
    ("first_idle", "First idle", "thinking", {}, 0.0),
    ("continued_idle", "Continued idle", "thinking", {}, 0.0),
    ("long_idle", "Long idle", "thinking", {}, 0.0),
    # ── Sub-Worker working — priority override w/ cooldown ──
    (
        "sub_worker_working",
        "Sub-Worker is working",
        "thinking",
        {"requires_sub_worker_busy": True},
        90.0,
    ),
    # ── Time-of-day prompts ──
    (
        "time_morning",
        "Morning",
        "thinking",
        {"time_window": "morning"},
        0.0,
    ),
    (
        "time_afternoon",
        "Afternoon",
        "thinking",
        {"time_window": "afternoon"},
        0.0,
    ),
    (
        "time_evening",
        "Evening",
        "thinking",
        {"time_window": "evening"},
        0.0,
    ),
    (
        "time_night",
        "Night",
        "thinking",
        {"time_window": "night"},
        0.0,
    ),
    # ── Fun reflection prompts (no gates) ──
    ("fun_share", "Fun share", "thinking", {}, 0.0),
    ("fun_recommend", "Fun recommend", "thinking", {}, 0.0),
    ("fun_what_if", "Fun what-if", "thinking", {}, 0.0),
    # ── Activity triggers — Sub-Worker idle + ≥2 prior triggers ──
    (
        "activity_web_surf",
        "Activity: web surf",
        "activity",
        {"requires_sub_worker_idle": True, "min_consecutive": 2},
        0.0,
    ),
    (
        "activity_trending",
        "Activity: trending",
        "activity",
        {"requires_sub_worker_idle": True, "min_consecutive": 2},
        0.0,
    ),
    (
        "activity_deep_dive",
        "Activity: deep dive",
        "activity",
        {"requires_sub_worker_idle": True, "min_consecutive": 2},
        0.0,
    ),
]


def _build_categories() -> List[TriggerCategory]:
    """Build the default category list with the bundled prompt copy."""
    out: List[TriggerCategory] = []
    for cat_id, label, kind, cond_kwargs, cooldown in _CATEGORY_DEFS:
        prompts = PROMPT_CATALOG.get(cat_id, {})
        # Defensive copy so callers mutating the returned manifest
        # cannot bleed back into the module-level catalog.
        prompts_copy = {locale: list(items) for locale, items in prompts.items()}
        out.append(
            TriggerCategory(
                id=cat_id,
                label=label,
                kind=kind,  # type: ignore[arg-type]
                conditions=CategoryConditions(**cond_kwargs),
                cooldown_seconds=cooldown,
                prompts=prompts_copy,
            )
        )
    return out


# ============================================================================
# Default phase weights (mirror old roulette ladder)
# ============================================================================
# 15 % activity = 5 + 5 + 5 across three activity_* events
# 15 % fun = 5 + 5 + 5 across three fun_* events
# 15 % time = one of four time_* (only one passes the time_window gate
#   at any instant, so the remaining time_* events are filtered out and
#   the surviving event keeps the full 15 % share after normalisation).
# 55 % idle-stage prompt for the active phase
# 1000 sub_worker_working (priority override; gated to busy + cooldown)


def _phase_events(idle_category_id: str) -> List[PhaseEvent]:
    """Build the canonical event list for one phase.

    The roulette table is identical across phases except for which idle
    category receives the 55 % weight, mirroring the old idle-stage
    fallback that swapped first_idle / continued_idle / long_idle by
    consecutive count.
    """
    return [
        PhaseEvent(category_id="sub_worker_working", weight=1000.0),
        PhaseEvent(category_id="activity_web_surf", weight=5.0),
        PhaseEvent(category_id="activity_trending", weight=5.0),
        PhaseEvent(category_id="activity_deep_dive", weight=5.0),
        PhaseEvent(category_id="fun_share", weight=5.0),
        PhaseEvent(category_id="fun_recommend", weight=5.0),
        PhaseEvent(category_id="fun_what_if", weight=5.0),
        PhaseEvent(category_id="time_morning", weight=15.0),
        PhaseEvent(category_id="time_afternoon", weight=15.0),
        PhaseEvent(category_id="time_evening", weight=15.0),
        PhaseEvent(category_id="time_night", weight=15.0),
        PhaseEvent(category_id=idle_category_id, weight=55.0),
    ]


def default_manifest() -> TriggerPresetManifest:
    """Fresh :class:`TriggerPresetManifest` matching the historical ladder.

    Returned instance is fully owned by the caller — no aliasing back
    to module-level state, so callers can freely mutate.
    """
    return TriggerPresetManifest(
        enabled=True,
        timing=TriggerTiming(),
        time_boundaries=TimeBoundaries(),
        phases=[
            TriggerPhase(
                id="first_idle_phase",
                label="첫 침묵",
                min_consecutive=0,
                max_consecutive=0,
                events=_phase_events("first_idle"),
            ),
            TriggerPhase(
                id="continued_idle_phase",
                label="지속되는 침묵",
                min_consecutive=1,
                max_consecutive=3,
                events=_phase_events("continued_idle"),
            ),
            TriggerPhase(
                id="long_idle_phase",
                label="장기 침묵",
                min_consecutive=4,
                max_consecutive=None,
                events=_phase_events("long_idle"),
            ),
        ],
        categories=_build_categories(),
    )


def bootstrap_seed() -> TriggerPresetManifest:
    """Manifest used to seed the very first user-facing preset.

    Currently identical to :func:`default_manifest`; the indirection
    is here so we can ship richer "starter pack" preset bundles in
    the future without coupling that change to the no-preset fallback.
    """
    return default_manifest()


__all__ = [
    "PROMPT_CATALOG",
    "default_manifest",
    "bootstrap_seed",
]
