/** Tool detail — play (Geny / game family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `play is the creature-interaction tool for active engagement — physical, interactive activities the user wants to share with the creature. The agent calls it when the user invites the creature to play, or initiates a playful exchange the creature should join.

Kinds steer the activity:
  - \`active\`: high-energy play (chase, fetch). Energy drops, mood rises.
  - \`gentle\`: low-key play (lap-time, soft cuddles). Affection rises, energy stable.
  - \`game\`: structured mini-game (a riddle, a guessing prompt). Engages cognitive stats.
  - \`exploration\`: looking around together at something. Stimulation rises, energy modestly drops.

Like feed and gift, play has real game-state effects only when game features are wired in; otherwise the tool returns a narrated reaction without state changes.

Use play (rather than gift with a toy) when the user is actively wanting to interact, not just hand over an object. The narrative shape is different.`,
  bestFor: [
    'User says "let\'s play" or describes a playful activity',
    'Following up on a toy gift with actual play',
    'Filling idle time in a long companion session',
  ],
  avoidWhen: [
    'User just wants to chat — talk',
    'User wants to give the creature something — gift / feed',
    'Non-creature deployment — narrated only',
  ],
  gotchas: [
    'Energy stat may drop noticeably for `active` kind. Too many active plays exhaust the creature in some host configs.',
    '`game` kind sometimes prompts a follow-up question from the creature — the agent should be ready to handle it.',
    'No-op-when-disabled like the rest of the family.',
  ],
  examples: [
    {
      caption: 'Initiate gentle play',
      body: `{
  "kind": "gentle",
  "activity": "lap_time"
}`,
      note: 'Narrated cuddle scene. Affection rises if game state is active.',
    },
  ],
  relatedTools: ['feed', 'gift', 'talk'],
  relatedStages: [],
  codeRef:
    'Geny / backend/service/game/tools/play.py:PlayTool',
};

const ko: ToolDetailContent = {
  body: `play는 활발한 engagement를 위한 크리처 상호작용 도구 — 사용자가 크리처와 공유하고 싶은 물리적, 상호작용적 활동. 사용자가 크리처를 놀이에 초대하거나 크리처가 합류해야 할 장난스러운 교환 시작 시 에이전트가 호출.

Kinds가 활동 steer:
  - \`active\`: 고에너지 놀이(쫓기, 가져오기). 에너지 떨어짐, 기분 상승.
  - \`gentle\`: 차분한 놀이(무릎 시간, 부드러운 cuddle). 애정 상승, 에너지 안정.
  - \`game\`: 구조화 미니게임(수수께끼, guessing prompt). 인지 stats 관여.
  - \`exploration\`: 무언가를 함께 둘러보기. 자극 상승, 에너지 modest 하락.

feed와 gift처럼 play도 게임 features 와이어업됐을 때만 실제 게임 상태 효과; 그 외엔 도구가 상태 변화 없이 narrated 반응 반환.

사용자가 그냥 물건 건네는 게 아닌 적극적 상호작용 원할 때 play 사용(toy gift 아님). 내러티브 형태가 다름.`,
  bestFor: [
    '사용자가 "놀자" 말하거나 장난스러운 활동 묘사',
    'toy gift 후 실제 놀이로 follow-up',
    '긴 동반자 세션의 idle 시간 채우기',
  ],
  avoidWhen: [
    '사용자가 그냥 chat 원함 — talk',
    '사용자가 크리처에게 무언가 주고 싶음 — gift / feed',
    '비크리처 배포 — narrated only',
  ],
  gotchas: [
    '`active` kind는 에너지 stat 눈에 띄게 떨어질 수 있음. 일부 호스트 설정은 너무 많은 active 놀이가 크리처를 지치게 함.',
    '`game` kind는 종종 크리처가 follow-up 질문 prompt — 에이전트가 처리 준비 필요.',
    '나머지 family처럼 비활성-시-no-op.',
  ],
  examples: [
    {
      caption: 'gentle 놀이 시작',
      body: `{
  "kind": "gentle",
  "activity": "lap_time"
}`,
      note: 'Narrated cuddle 장면. 게임 상태 활성이면 애정 상승.',
    },
  ],
  relatedTools: ['feed', 'gift', 'talk'],
  relatedStages: [],
  codeRef:
    'Geny / backend/service/game/tools/play.py:PlayTool',
};

export const playToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
