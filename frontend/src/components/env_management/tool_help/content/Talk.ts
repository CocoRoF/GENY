/** Tool detail — talk (Geny / game family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `talk marks a conversational beat — a meta-action for narrative pacing in creature deployments. UNLIKE feed / gift / play, talk is NOT for ordinary dialogue; it\'s a structured pause that signals "this turn was just talking, not a game action".

The intended use is rare: when the agent needs to emit a "nothing happens" beat in a story-driven creature interaction. Most of the time the agent\'s natural reply IS the talk; this tool only fires when the host\'s game loop expects an explicit beat.

Returns a narrated response acknowledging the talk beat. No state changes — pure cosmetic / pacing tool.

For ordinary chat, the agent\'s normal response is the right channel. Don\'t reach for talk just because the user said something.`,
  bestFor: [
    'Story-driven creature deployments where the host loop expects explicit beats',
    'Narrative pacing — emitting a "we just had a moment" turn',
  ],
  avoidWhen: [
    'Ordinary conversation — just respond normally',
    'Real game actions — feed / gift / play are the correct tools',
    'Non-creature deployments — talk has no place',
  ],
  gotchas: [
    'Almost never needed in standard deployments. Reaching for it usually indicates the agent should just respond directly.',
    '`kind` is host-defined — what the host considers a meaningful beat varies.',
    'No state effect even with game features on. It\'s purely pacing.',
  ],
  examples: [
    {
      caption: 'Emit a quiet conversational beat',
      body: `{
  "kind": "quiet"
}`,
      note: 'Narrated as a small companion moment. No state changes.',
    },
  ],
  relatedTools: ['feed', 'gift', 'play'],
  relatedStages: [],
  codeRef:
    'Geny / backend/service/game/tools/talk.py:TalkTool',
};

const ko: ToolDetailContent = {
  body: `talk는 대화 비트 표시 — 크리처 배포의 내러티브 pacing용 meta-action. feed / gift / play와 달리 talk는 일반 대화용 아님; "이 턴은 그저 말하기, 게임 액션 아님" 신호하는 구조화 pause.

의도된 사용은 드묾: story-driven 크리처 상호작용에서 에이전트가 "아무 일도 안 일어남" 비트 emit 필요할 때. 대부분의 경우 에이전트의 자연스러운 답이 곧 talk; 호스트의 게임 루프가 명시적 비트 기대할 때만 이 도구 발화.

talk 비트 acknowledge하는 narrated 응답 반환. 상태 변화 없음 — 순수 cosmetic / pacing 도구.

일반 채팅은 에이전트의 normal 응답이 적절한 채널. 사용자가 무언가 말했다고 talk에 손 뻗지 마세요.`,
  bestFor: [
    '호스트 루프가 명시적 비트 기대하는 story-driven 크리처 배포',
    '내러티브 pacing — "방금 순간 있었음" 턴 emit',
  ],
  avoidWhen: [
    '일반 대화 — 그냥 normal 응답',
    '실제 게임 액션 — feed / gift / play가 올바른 도구',
    '비크리처 배포 — talk 자리 없음',
  ],
  gotchas: [
    '표준 배포에서 거의 필요 없음. 손 뻗는다는 건 보통 에이전트가 직접 응답해야 함을 의미.',
    '`kind`는 호스트 정의 — 호스트가 의미 있는 비트로 여기는 게 다양.',
    '게임 features on이어도 상태 효과 없음. 순수 pacing.',
  ],
  examples: [
    {
      caption: 'quiet 대화 비트 emit',
      body: `{
  "kind": "quiet"
}`,
      note: '작은 동반자 순간으로 narrated. 상태 변화 없음.',
    },
  ],
  relatedTools: ['feed', 'gift', 'play'],
  relatedStages: [],
  codeRef:
    'Geny / backend/service/game/tools/talk.py:TalkTool',
};

export const talkToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
