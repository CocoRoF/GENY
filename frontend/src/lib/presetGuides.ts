/**
 * presetGuides — per-preset "설명보기" content.
 *
 * The 10 seed presets follow a {backend} × {persona} grid, so the explanation
 * is composed from a backend part + a persona part + the shared all-tools note,
 * keyed off the template env id. Adding a backend/persona only needs a new
 * entry here. Returns Markdown (rendered by MarkdownRenderer in a modal).
 */

type Locale = 'ko' | 'en';
type Backend = 'claude-code' | 'claude' | 'openai' | 'local' | 'default';
type Persona = 'vtuber' | 'general';

function backendOf(id: string): Backend {
  if (id.includes('claude-code')) return 'claude-code';
  if (id.includes('claude')) return 'claude';
  if (id.includes('openai')) return 'openai';
  if (id.includes('local')) return 'local';
  return 'default'; // template-worker-env / template-vtuber-env
}

function personaOf(id: string): Persona {
  return id.includes('vtuber') ? 'vtuber' : 'general';
}

const BACKEND_KO: Record<Backend, string> = {
  'claude-code':
    'Anthropic **Claude** 모델을 **Claude Code CLI**로 구동합니다. claude.ai **구독 인증**을 그대로 사용하므로 별도 API 키가 필요 없고, MCP·도구 패스스루가 가장 풍부합니다. 가장 추천하는 기본 백엔드예요.',
  claude:
    'Anthropic **Claude** 모델을 **API 키**로 직접 호출합니다. `ANTHROPIC_API_KEY`가 필요하고, 사용한 토큰만큼 과금됩니다. CLI 구독 없이 키만으로 쓰고 싶을 때.',
  openai:
    '**OpenAI**(GPT 계열) 모델을 사용합니다. `OPENAI_API_KEY`가 필요합니다. OpenAI 생태계를 쓰거나 GPT 계열을 선호할 때.',
  local:
    '로컬에서 도는 **Ollama** 모델을 사용합니다. 클라우드 키가 필요 없어 **프라이버시·오프라인**에 유리합니다. **설정 → LLM 백엔드**에서 base URL과 모델을 지정하세요.',
  default:
    '현재 **로그인/설정된 백엔드를 자동으로 따라갑니다** — Claude Code에 로그인했으면 Claude Code, API 키를 넣었으면 그 백엔드를 씁니다. 역할 기본 환경이라 "그냥 잘 되는" 선택입니다.',
};

const BACKEND_EN: Record<Backend, string> = {
  'claude-code':
    'Runs Anthropic **Claude** via the **Claude Code CLI** using your claude.ai **subscription** auth — no API key needed, richest MCP/tool passthrough. The recommended default.',
  claude:
    'Calls Anthropic **Claude** directly with an **API key** (`ANTHROPIC_API_KEY`), billed per token. Use when you want keys without the CLI subscription.',
  openai: 'Uses **OpenAI** (GPT) models. Needs `OPENAI_API_KEY`.',
  local:
    'Uses a local **Ollama** model — no cloud key, private/offline. Set the base URL + model under Settings → LLM Backends.',
  default:
    'Follows your **active login** automatically (Claude Code if logged in, otherwise your configured key backend). The role-default "just works" choice.',
};

const PERSONA_KO: Record<Persona, { body: string; when: string }> = {
  general: {
    body:
      '**범용 작업 환경**입니다. 적응형 루프(`worker_adaptive`)로 필요한 만큼 반복하고, 평가 단계가 작업 완료를 판단합니다. 페르소나 꾸밈 없이 결과에 집중합니다.',
    when: '파일 작업·코딩·조사·자동화 등 "일을 시키는" 용도.',
  },
  vtuber: {
    body:
      '**VTuber 페르소나 환경**입니다. 가벼운 대화형 루프(`vtuber`) 위에서 동작하며, Geny의 세션 레이어가 **감정·음성(TTS)·아바타**를 입힙니다. 전용 **소유 서브에이전트(동반자)** 를 가져 무거운 작업을 위임할 수 있어요.',
    when: '캐릭터로 대화·반응하는 컴패니언/방송 용도.',
  },
};

const PERSONA_EN: Record<Persona, { body: string; when: string }> = {
  general: {
    body:
      'A **general-purpose** env on the adaptive loop (`worker_adaptive`) — iterates as needed, an evaluator decides completion. No persona dressing; result-focused.',
    when: 'Files, code, research, automation — getting work done.',
  },
  vtuber: {
    body:
      'A **VTuber-persona** env on the light conversational loop (`vtuber`); Geny\'s session layer adds **affect, voice (TTS), and avatar**, and it **owns a companion sub-agent** to offload heavy work.',
    when: 'A character that chats/reacts — companion / streaming.',
  },
};

export function presetGuide(
  env: { id: string; name: string; description?: string },
  locale: Locale = 'ko',
): string {
  const b = backendOf(env.id);
  const p = personaOf(env.id);
  const ko = locale === 'ko';
  const backendTxt = (ko ? BACKEND_KO : BACKEND_EN)[b];
  const persona = (ko ? PERSONA_KO : PERSONA_EN)[p];

  if (ko) {
    return [
      `# ${env.name}`,
      '',
      '## 백엔드 (LLM)',
      backendTxt,
      '',
      '## 작동 방식',
      persona.body,
      '',
      '## 도구',
      '**모든 도구 사용** — 내장 도구 전체 + 모든 외부/플랫폼 도구를 기본으로 가집니다. 특정 환경만 좁히고 싶으면 편집기에서 조정하세요.',
      '',
      '## 언제 쓰나',
      persona.when,
      '',
      '---',
      '_21단계 매니페스트로 동작하며, 실제 모델은 세션을 만들 때 채워집니다. 이 프리셋을 누르면 복제본으로 시작해 새 이름으로 저장합니다._',
    ].join('\n');
  }
  return [
    `# ${env.name}`,
    '',
    '## Backend (LLM)',
    backendTxt,
    '',
    '## How it works',
    persona.body,
    '',
    '## Tools',
    '**All tools** by default — every built-in + all external/platform tools. Narrow per-env in the editor if you want a quieter setup.',
    '',
    '## When to use',
    persona.when,
    '',
    '---',
    '_Runs as a 21-stage manifest; the concrete model is filled in at session creation. Picking a preset starts a clone you save under a new name._',
  ].join('\n');
}
