/** Tool detail — gift (Geny / game family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `gift is the creature-interaction tool for non-food offerings — flowers, toys, small objects the user wants to give the creature. Like feed, it nudges the creature\'s mutation buffer (typically affection / mood / collected-items) when game features are active, and degrades to a narrated reaction otherwise.

Gift kinds branch reactions:
  - \`flower\`: a soft / appreciative reaction. Reads as a simple gesture.
  - \`toy\`: a playful / energetic reaction. Often nudges the creature toward play behaviour next.
  - \`accessory\`: cosmetic / preening reaction.
  - \`special\`: host-defined event items (e.g., birthday gifts, seasonal items).

Where feed is about sustenance, gift is about delight. The agent picks gift when the user\'s message reads like a present rather than food.

Same provider gating as feed: real state effects only when GENY_GAME_FEATURES is on and a CreatureStateProvider is wired in. Otherwise it\'s a narrated experience.`,
  bestFor: [
    'User offers a flower / toy / accessory to the creature',
    'Celebrating a milestone with a special-kind gift',
    'Building rapport in a long-running creature companion deployment',
  ],
  avoidWhen: [
    'The offering is food — feed is the right tool',
    'User wants to play — play is more direct than gifting a toy when you actually want to play',
    'Non-creature deployment — same as feed, the tool fires but does nothing meaningful',
  ],
  gotchas: [
    'Same no-op-when-disabled behaviour as feed.',
    'Some hosts thread gift items into a "collected" inventory; without the inventory provider it\'s ephemeral.',
    'Toy gifts often raise the play affordance. Pair with play next turn for natural flow.',
  ],
  examples: [
    {
      caption: 'Give the creature a flower',
      body: `{
  "kind": "flower",
  "name": "daisy"
}`,
      note: 'Soft narrated reaction. Affection / mood nudge if game state is active.',
    },
  ],
  relatedTools: ['feed', 'play', 'talk'],
  relatedStages: [],
  codeRef:
    'Geny / backend/service/game/tools/gift.py:GiftTool',
};

const ko: ToolDetailContent = {
  body: `gift는 음식 아닌 제공을 위한 크리처 상호작용 도구 — 꽃, 장난감, 사용자가 크리처에게 주고 싶은 작은 물건. feed처럼 게임 features 활성 시 크리처의 mutation 버퍼(보통 애정 / 기분 / 수집 아이템) nudge하고, 그 외엔 narrated 반응으로 degrade.

Gift kinds가 반응 분기:
  - \`flower\`: 부드러운 / appreciative 반응. 단순 제스처로 읽힘.
  - \`toy\`: 장난스러운 / energetic 반응. 종종 크리처를 다음 play 행동으로 nudge.
  - \`accessory\`: cosmetic / preening 반응.
  - \`special\`: 호스트 정의 이벤트 아이템(예: 생일 선물, 계절 아이템).

feed가 sustenance에 관한 것이라면 gift는 delight에 관한 것. 사용자 메시지가 음식보다 선물처럼 읽힐 때 에이전트가 gift 선택.

feed와 같은 provider gating: GENY_GAME_FEATURES on이고 CreatureStateProvider 와이어업됐을 때만 실제 상태 효과. 그 외엔 narrated 경험.`,
  bestFor: [
    '사용자가 크리처에게 꽃 / 장난감 / 액세서리 제안',
    'special-kind gift로 milestone 축하',
    '장기 크리처 동반자 배포에서 rapport 구축',
  ],
  avoidWhen: [
    '제공이 음식 — feed가 적절한 도구',
    '사용자가 놀고 싶음 — 실제 놀고 싶을 때 장난감 선물보다 play가 더 직접적',
    '비크리처 배포 — feed와 같음, 도구는 발화하지만 의미 없음',
  ],
  gotchas: [
    'feed와 같은 비활성-시-no-op 동작.',
    '일부 호스트는 gift 아이템을 "collected" inventory로 thread; inventory provider 없으면 ephemeral.',
    '장난감 선물은 종종 play affordance 상승. 자연스러운 흐름 위해 다음 턴에 play와 페어.',
  ],
  examples: [
    {
      caption: '크리처에게 꽃 주기',
      body: `{
  "kind": "flower",
  "name": "daisy"
}`,
      note: '부드러운 narrated 반응. 게임 상태 활성이면 애정 / 기분 nudge.',
    },
  ],
  relatedTools: ['feed', 'play', 'talk'],
  relatedStages: [],
  codeRef:
    'Geny / backend/service/game/tools/gift.py:GiftTool',
};

export const giftToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
