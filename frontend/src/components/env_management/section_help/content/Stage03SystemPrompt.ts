/**
 * Help content for Stage 3 → System prompt textarea (visible only when
 * the Builder slot is set to `static`).
 *
 * Source of truth: geny-executor /
 *   src/geny_executor/stages/s03_system/artifact/default/builders.py
 *   src/geny_executor/stages/s03_system/artifact/default/stage.py
 *   (StaticPromptBuilder.configure + SystemStage.update_config)
 */

import type { SectionHelpContent, SectionHelpFactory } from '../types';

const en: SectionHelpContent = {
  title: 'System prompt',
  summary:
    "The fixed text the LLM sees as its **system message** every turn. Stored at `stage.config.prompt`; round-tripped through `StaticPromptBuilder.configure()` so manifest restore preserves what you typed.",
  whatItDoes: `When the Builder slot is set to \`static\`, the textarea here is the *only* place the system prompt actually lives. There's no template engine, no conditional sections, no per-turn rewriting — the literal contents go straight into \`state.system\` and from there to the LLM's \`system\` parameter.

**Where the value travels:**

- you type → \`stage.config.prompt\` (in the manifest)
- on stage restore → \`SystemStage.update_config\` → \`StaticPromptBuilder.configure({"prompt": "..."})\`
- per turn, in \`execute()\` → \`builder.build(state)\` → \`state.system\`
- Stage 6 (API) reads \`state.system\` and ships it to the LLM

**What it is NOT:**

- not a template — \`{user_name}\` style placeholders are *not* expanded for static builder. \`stage.config.template_vars\` exists but only \`composable\` builders read it (and only if you build a custom block that does so).
- not auto-prepended with persona / rules / memory — what you type is exactly what the LLM sees. If you want structured composition, switch the Builder to \`composable\`.

**Length and cost:** the prompt is sent on **every** turn. A 10 KB system prompt at \`$3 / 1M input tokens\` ≈ \`$0.0075\` per turn just for the system message. Stage 5 (Cache) can amortise this on Anthropic models if Stage 3 is in \`composable + use_content_blocks=True\` mode — but \`static\` produces a plain string that can't be cache-marked.`,
  configFields: [
    {
      name: 'config.prompt',
      label: 'Prompt text',
      type: 'string',
      default: '""',
      description:
        'Raw system prompt text. Stored on `stage.config`. Empty string = empty system message (NOT the executor\'s default fallback `"You are a helpful assistant."` — that fallback only kicks in if no `prompt` field is set at all).',
    },
    {
      name: 'config.template_vars',
      label: 'Template variables',
      type: 'object',
      default: '{}',
      description:
        'Key-value pairs available to `composable` builders that opt into reading them. **Ignored by `static`** — the static builder writes the prompt literally, no substitution.',
    },
  ],
  options: [],
  relatedSections: [
    {
      label: 'Builder (this stage)',
      body: 'The textarea is only meaningful when the builder is `static`. Switching to `composable` or `dynamic_persona` makes the textarea content irrelevant — the prompt comes from blocks or a host provider instead.',
    },
    {
      label: 'Stage 6 — API',
      body: '`state.system` is shipped as the LLM\'s `system` parameter. Vendor-specific translators (OpenAI, Google) handle format differences — for plain string prompts there\'s no translation needed.',
    },
    {
      label: 'Stage 5 — Cache',
      body: 'Static prompts are plain strings — they can\'t carry `cache_control` markers, so Stage 5\'s cache strategies have nothing to mark on them. For cacheable system prompts, switch the Builder to `composable` with `use_content_blocks=True`.',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/stages/s03_system/artifact/default/stage.py:SystemStage.update_config',
};

const ko: SectionHelpContent = {
  title: '시스템 프롬프트 (System prompt)',
  summary:
    'LLM 이 매 턴 **시스템 메시지** 로 보는 고정 텍스트. \`stage.config.prompt\` 에 저장; \`StaticPromptBuilder.configure()\` 로 round-trip 되어 매니페스트 restore 가 입력한 것을 보존합니다.',
  whatItDoes: `Builder 슬롯이 \`static\` 으로 설정되면 여기 textarea 가 시스템 프롬프트가 실제로 사는 *유일한* 곳입니다. 템플릿 엔진 없음, 조건부 섹션 없음, 턴별 재작성 없음 — 리터럴 내용이 \`state.system\` 으로 직행, 거기서 LLM 의 \`system\` 파라미터로.

**값이 이동하는 경로:**

- 입력 → \`stage.config.prompt\` (매니페스트에)
- stage restore 시 → \`SystemStage.update_config\` → \`StaticPromptBuilder.configure({"prompt": "..."})\`
- 매 턴 \`execute()\` 에서 → \`builder.build(state)\` → \`state.system\`
- 6단계 (API) 가 \`state.system\` 을 읽어 LLM 으로 전송

**이것이 *아닌* 것:**

- 템플릿 아님 — \`{user_name}\` 스타일 placeholder 는 static 빌더에서 *확장되지 않음*. \`stage.config.template_vars\` 는 존재하지만 \`composable\` 빌더만 읽음 (그것을 읽는 커스텀 블록을 빌드한 경우만).
- persona / rules / memory 가 자동으로 prepend 되지 않음 — 입력한 것이 정확히 LLM 이 보는 것. 구조적 조합을 원하면 Builder 를 \`composable\` 로 전환.

**길이와 비용:** 프롬프트는 **매 턴** 전송됩니다. 10 KB 시스템 프롬프트가 \`$3 / 1M 입력 토큰\` 에서 ≈ \`$0.0075\` per 턴 (시스템 메시지만). 5단계 (Cache) 가 Anthropic 모델에서 이를 amortise 할 수 있지만 — 3단계가 \`composable + use_content_blocks=True\` 모드일 때만. \`static\` 은 cache 마커 못 다는 평문 문자열 생성.`,
  configFields: [
    {
      name: 'config.prompt',
      label: '프롬프트 텍스트',
      type: 'string',
      default: '""',
      description:
        'Raw 시스템 프롬프트 텍스트. `stage.config` 에 저장. 빈 문자열 = 빈 시스템 메시지 (실행기의 기본 fallback `"You are a helpful assistant."` 가 *아님* — 그 fallback 은 `prompt` 필드 자체가 설정되지 않은 경우만 작동).',
    },
    {
      name: 'config.template_vars',
      label: '템플릿 변수',
      type: 'object',
      default: '{}',
      description:
        '읽기 opt-in 한 `composable` 빌더에서 사용 가능한 키-값 쌍. **`static` 은 무시** — static 빌더는 프롬프트를 리터럴로 씀, 치환 없음.',
    },
  ],
  options: [],
  relatedSections: [
    {
      label: 'Builder (이 단계)',
      body: 'textarea 는 빌더가 `static` 일 때만 의미 있음. `composable` 이나 `dynamic_persona` 로 전환하면 textarea 내용이 무관해짐 — 프롬프트가 블록 또는 호스트 provider 에서 옴.',
    },
    {
      label: '6단계 — API',
      body: '`state.system` 이 LLM 의 `system` 파라미터로 전송. vendor 별 translator (OpenAI, Google) 가 형식 차이를 처리 — 평문 문자열 프롬프트는 변환 불필요.',
    },
    {
      label: '5단계 — Cache',
      body: 'Static 프롬프트는 평문 문자열 — `cache_control` 마커를 운반 못 함, 따라서 5단계의 캐시 전략이 마킹할 게 없음. 캐시 가능한 시스템 프롬프트는 Builder 를 `composable` + `use_content_blocks=True` 로 전환.',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/stages/s03_system/artifact/default/stage.py:SystemStage.update_config',
};

export const stage03SystemPromptHelp: SectionHelpFactory = (locale) =>
  locale === 'ko' ? ko : en;
