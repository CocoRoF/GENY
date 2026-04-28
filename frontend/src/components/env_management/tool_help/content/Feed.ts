/** Tool detail — feed (Geny / game family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `feed is one of the four creature-interaction tools (alongside gift / play / talk) that surface in VTuber / agent-companion deployments. The agent calls it when the user offers food / a snack to the creature; the tool nudges the creature\'s mutation buffer (hunger / mood / energy stats) and returns a narrated response.

The mutation only takes effect when GENY_GAME_FEATURES is enabled and a CreatureStateProvider is wired into the pipeline. Without a provider, feed degrades to a narrated-only response — the creature "says" something appropriate but no state changes. This means the tool is always callable; behaviour just becomes cosmetic in non-game contexts.

The kind of food influences the creature\'s reaction. \`treat\` types lift mood; \`balanced\` types lift hunger and energy modestly; \`special\` items unlock event-specific reactions defined by the host. Hosts can extend the kind taxonomy via the rules registry.

Designed for emotional resonance, not utility — the agent isn\'t expected to feed for any "computational" reason. It\'s a scripted user-facing affordance.`,
  bestFor: [
    'VTuber / companion deployments where the user is interacting with a creature',
    'Reacting to user input that names a food or eating intent',
    'Maintaining the creature\'s emotional state in the game loop',
  ],
  avoidWhen: [
    'No game features enabled — the call works but has no state effect',
    'You\'re not in a creature deployment — the tool exists but won\'t make sense',
  ],
  gotchas: [
    'No-op (cosmetic) when GENY_GAME_FEATURES is off. The narration still appears.',
    '`kind` taxonomy is extensible per-host. Unknown kinds fall back to a generic reaction.',
    'Mutation is committed to state.shared at call time — concurrent game tools can race in unusual deployments.',
  ],
  examples: [
    {
      caption: 'Feed the creature a snack',
      body: `{
  "kind": "treat",
  "name": "strawberry"
}`,
      note: 'Returns a narrated reaction; mood and hunger stats nudge if the game state provider is active.',
    },
  ],
  relatedTools: ['gift', 'play', 'talk'],
  relatedStages: [],
  codeRef:
    'Geny / backend/service/game/tools/feed.py:FeedTool',
};

const ko: ToolDetailContent = {
  body: `feed는 VTuber / 에이전트 동반자 배포에서 표면화되는 네 크리처 상호작용 도구(gift / play / talk와 함께) 중 하나. 사용자가 크리처에게 음식 / 간식을 제안할 때 에이전트가 호출; 도구가 크리처의 mutation 버퍼(배고픔 / 기분 / 에너지 stats) nudge하고 narrated 응답 반환.

GENY_GAME_FEATURES 활성이고 CreatureStateProvider가 파이프라인에 와이어업된 경우만 mutation 효과. provider 없으면 feed가 narrated-only 응답으로 degrade — 크리처가 적절한 무언가 "말함"하지만 상태 변화 없음. 즉 도구는 항상 호출 가능; 게임 아닌 컨텍스트에서 동작이 그저 cosmetic 됨.

음식 종류가 크리처의 반응에 영향. \`treat\` 타입은 기분 lift; \`balanced\` 타입은 배고픔과 에너지 modest lift; \`special\` 아이템은 호스트가 정의한 이벤트 특정 반응 unlock. 호스트가 rules 레지스트리로 kind 분류 확장 가능.

감정적 공명용 설계, 유틸리티 아님 — 에이전트가 어떤 "계산적" 이유로 feed 기대 안 됨. 스크립트된 사용자 대면 affordance.`,
  bestFor: [
    '사용자가 크리처와 상호작용하는 VTuber / 동반자 배포',
    '음식이나 식사 의도를 named한 사용자 입력에 반응',
    '게임 루프에서 크리처의 감정 상태 유지',
  ],
  avoidWhen: [
    '게임 features 비활성 — 호출은 작동하지만 상태 효과 없음',
    '크리처 배포 아님 — 도구는 존재하지만 의미 없음',
  ],
  gotchas: [
    'GENY_GAME_FEATURES off일 때 no-op(cosmetic). Narration은 여전히 등장.',
    '`kind` 분류는 호스트별 extensible. 알려지지 않은 kind는 generic 반응으로 fallback.',
    'Mutation은 호출 시점에 state.shared에 commit — 비정상 배포에서 동시 게임 도구 race 가능.',
  ],
  examples: [
    {
      caption: '크리처에게 간식 feed',
      body: `{
  "kind": "treat",
  "name": "strawberry"
}`,
      note: 'narrated 반응 반환; 게임 상태 provider 활성이면 기분과 배고픔 stats nudge.',
    },
  ],
  relatedTools: ['gift', 'play', 'talk'],
  relatedStages: [],
  codeRef:
    'Geny / backend/service/game/tools/feed.py:FeedTool',
};

export const feedToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
