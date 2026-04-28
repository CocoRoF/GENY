/**
 * Help content for Stage 2 → Compactor slot.
 *
 * Source of truth: geny-executor /
 *   src/geny_executor/stages/s02_context/artifact/default/compactors.py
 * (TruncateCompactor / SummaryCompactor / SlidingWindowCompactor —
 * LLMSummaryCompactor exists in the same file but is NOT in the
 * default registry, so it's not exposed in the curated picker.)
 */

import type { SectionHelpContent, SectionHelpFactory } from '../types';

const en: SectionHelpContent = {
  title: 'History compactor',
  summary:
    "The safety net for context overflow. Runs **only when the running token estimate crosses 80% of `state.context_window_budget`** — otherwise the compactor is silent.",
  whatItDoes: `Stage 2's \`execute()\` ends with a token-budget check:

\`\`\`
estimated_tokens = sum(len(content) // 4 for m in state.messages)
if estimated_tokens > state.context_window_budget * 0.8:
    await self._compactor.compact(state)
    state.add_event("context.compacted", ...)
\`\`\`

The estimator is rough (4 characters ≈ 1 token, no per-model tokenizer call) — it's intentionally pessimistic so compaction kicks in *before* the next API call hits a hard context limit.

When the trigger fires, the compactor mutates \`state.messages\` to fit. The three built-in shapes differ in **what they keep** and **what they leave behind**:

- \`truncate\` — drops oldest messages, leaves nothing
- \`summary\` — replaces dropped messages with a placeholder pair
- \`sliding_window\` — keeps a fixed-size window, collapses the rest into one marker

**Strategy vs Compactor** (same point made in the Strategy help). Strategy runs every turn; compactor only when over budget. They're independent layers — the strategy may already have trimmed before the compactor even looks.

**LLM-based compaction.** The executor ships a \`LLMSummaryCompactor\` that calls a model to produce a real summary, but it's NOT in the default registry — it requires the host to wire \`resolve_cfg\` / \`has_override\` / \`client_getter\` callbacks at instantiation time. If you want LLM-backed summarisation, plug it in via Advanced.`,
  options: [
    {
      id: 'truncate',
      label: 'Truncate',
      description: `Keep the **last \`keep_last\` messages** verbatim, drop everything older.

The simplest possible compactor — no marker, no summary, just hard truncation. Older context is gone from this turn's call. If you've configured a memory retriever, the dropped facts may still come back via the retriever; otherwise they're invisible.`,
      bestFor: [
        'Stateless or near-stateless agents — the compactor only fires under emergency, and you accept that "emergency" means context loss',
        'Pipelines paired with a strong Stage 18 + retriever — the retriever covers what the compactor drops',
        'Test environments where deterministic context shape matters more than fidelity',
      ],
      avoidWhen: [
        'The first message contains the task brief or persona — `truncate` will drop it once the budget triggers. Use `sliding_window` (which keeps a marker) or `progressive_disclosure` strategy instead.',
        'You\'re relying on conversational continuity. Truncation is brutal — turns disappear silently.',
      ],
      config: [
        {
          name: 'keep_last',
          label: 'Keep last (messages)',
          type: 'integer',
          default: '20',
          description:
            'After compaction `state.messages` will hold at most this many messages — the most recent ones. Stored at `strategy_configs.compactor.keep_last`.',
        },
      ],
      gotchas: [
        '`keep_last` counts messages (including tool-result and system-injected messages), not turn pairs. The visible user/assistant cap depends on how many other roles your pipeline injects.',
        'No marker is inserted. If the LLM reads the truncated history mid-conversation, it has no signal that earlier turns existed.',
      ],
      codeRef:
        'geny-executor / s02_context/artifact/default/compactors.py:TruncateCompactor',
    },
    {
      id: 'summary',
      label: 'Summary (placeholder)',
      description: `Keep the last \`keep_recent\` messages, and replace the dropped messages with a **two-message placeholder**:

\`\`\`
user:      [Summary of N previous messages. ...]
assistant: Understood, I have the context from our previous conversation.
\`\`\`

Or, if \`summary_text\` is non-empty, that custom string is used in place of the first placeholder.

**This is NOT a real summary** — it's a static placeholder pair that signals to the LLM that older turns existed without actually conveying their content. Real summarisation requires \`LLMSummaryCompactor\` (not in the default registry; wire it in Advanced).`,
      bestFor: [
        'Quick prototypes where you want SOME indication that history was trimmed (vs `truncate` which is silent)',
        'Pipelines where the LLM should know "we talked earlier" but the actual content of the earlier talk doesn\'t matter',
      ],
      avoidWhen: [
        'You actually need the summary content for the LLM to act on. The placeholder is a literal sentence — no facts, no decisions, nothing. Use `LLMSummaryCompactor` (Advanced) for real summarisation.',
        'You\'re paying for output tokens by the inch. The placeholder pair adds ~50 tokens every turn the compactor fires.',
      ],
      config: [
        {
          name: 'keep_recent',
          label: 'Keep recent (messages)',
          type: 'integer',
          default: '10',
          description:
            'Number of most recent messages preserved verbatim. Older messages are replaced by the placeholder pair. Stored at `strategy_configs.compactor.keep_recent`.',
        },
        {
          name: 'summary_text',
          label: 'Custom summary text',
          type: 'string',
          default: '""',
          description:
            'When non-empty, this string replaces the auto-generated `[Summary of N previous messages. ...]` placeholder. Useful when you want a specific framing (e.g., "[Earlier discussion about persona setup omitted]").',
        },
      ],
      gotchas: [
        'The injected `assistant` placeholder ("Understood, I have the context...") is hardcoded — there\'s no config to change it. If your prompt is sensitive to assistant-role wording, that line is going to be there.',
        'The placeholder pair counts toward the next turn\'s token estimate. If your budget is *very* tight, the compactor + placeholder could itself blow the next budget check, triggering re-compaction on the same data.',
      ],
      codeRef:
        'geny-executor / s02_context/artifact/default/compactors.py:SummaryCompactor',
    },
    {
      id: 'sliding_window',
      label: 'Sliding window',
      description: `Maintain a **fixed window of \`window_size\` messages** at the tail of \`state.messages\`. Whatever overflows past that window is replaced by a single user-role marker:

\`\`\`
user: [N earlier messages summarized and compacted.]
\`\`\`

Functionally similar to \`summary\` but with one marker instead of a placeholder pair, and a single \`window_size\` knob instead of \`keep_recent\` + \`summary_text\`.`,
      bestFor: [
        'Pipelines that prefer a single tunable for trimming size (vs `summary`\'s two)',
        'Stateless-ish micro-conversations where you want a hard ceiling on prompt size and don\'t care about the lost content',
      ],
      avoidWhen: [
        'You need the LLM to acknowledge older context (the marker is user-role only — no acknowledgement turn-pair like `summary`)',
        'The first message contains the task brief. The window slides, so the very first message will eventually fall off the end.',
      ],
      config: [
        {
          name: 'window_size',
          label: 'Window size (messages)',
          type: 'integer',
          default: '30',
          description:
            'Fixed size of the rolling window. After compaction `state.messages` will hold the marker + up to `window_size` recent messages. Stored at `strategy_configs.compactor.window_size`.',
        },
      ],
      gotchas: [
        'The marker is injected as `user` role. Same caveat as `progressive_disclosure` strategy — strict alternating-role models may behave oddly with two consecutive user messages.',
        'Like `summary`, the marker is a literal placeholder — no actual summary of the dropped content.',
      ],
      codeRef:
        'geny-executor / s02_context/artifact/default/compactors.py:SlidingWindowCompactor',
    },
  ],
  relatedSections: [
    {
      label: 'Strategy (previous slot in this stage)',
      body: 'Strategy runs every turn and may pre-trim history. Compactor runs only on budget overflow. Pipelines often pair `simple_load` strategy + a real compactor, OR a trimming strategy + `truncate` compactor as a backstop.',
    },
    {
      label: 'Stage 18 — Memory',
      body: 'When the compactor drops content, Stage 18 (Memory) is what survives the loss — anything Stage 18 stored is retrievable next turn via Stage 2\'s retriever. Without Stage 18, dropped content is gone for good.',
    },
    {
      label: 'Advanced — `LLMSummaryCompactor`',
      body: 'Real summarisation lives in `LLMSummaryCompactor` (in the same file, not in the default registry). Plug it in via Advanced if you want a model-generated summary instead of a placeholder.',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/stages/s02_context/artifact/default/compactors.py',
};

const ko: SectionHelpContent = {
  title: '히스토리 압축기 (Compactor)',
  summary:
    '컨텍스트 오버플로우 safety net. **추정 토큰이 \`state.context_window_budget\` 의 80% 를 넘을 때만** 실행 — 그 외엔 compactor 는 침묵.',
  whatItDoes: `2단계의 \`execute()\` 는 토큰 예산 체크로 끝납니다:

\`\`\`
estimated_tokens = sum(len(content) // 4 for m in state.messages)
if estimated_tokens > state.context_window_budget * 0.8:
    await self._compactor.compact(state)
    state.add_event("context.compacted", ...)
\`\`\`

추정기는 거침 — 4 문자 ≈ 1 토큰, 모델별 tokenizer 호출 없음 — 의도적으로 비관적이라 다음 API 호출이 hard context limit 에 부딪치기 *전에* 압축이 작동합니다.

trigger 가 발화하면 compactor 가 \`state.messages\` 를 맞도록 변형. 세 가지 빌트인 형태가 **무엇을 유지하고** **무엇을 남기는지** 에서 다름:

- \`truncate\` — 오래된 메시지 drop, 아무것도 남기지 않음
- \`summary\` — drop 된 메시지를 placeholder pair 로 교체
- \`sliding_window\` — 고정 크기 윈도우 유지, 나머지를 마커 하나로 collapse

**Strategy vs Compactor** (Strategy 도움말의 같은 요점). Strategy 는 매 턴 실행; compactor 는 예산 초과 시만. 독립 레이어 — strategy 가 이미 trim 했을 수도 있어서 compactor 가 보기 전.

**LLM 기반 압축.** 실행기는 \`LLMSummaryCompactor\` 를 함께 ship 하지만 (모델을 호출해 실제 요약 생성), 기본 registry 에 **없음** — 호스트가 인스턴스 생성 시 \`resolve_cfg\` / \`has_override\` / \`client_getter\` 콜백을 wire 해야 합니다. LLM 기반 요약을 원하면 Advanced 로 plug-in 하세요.`,
  options: [
    {
      id: 'truncate',
      label: 'Truncate (잘라내기)',
      description: `**마지막 \`keep_last\` 메시지** 를 그대로 유지, 더 오래된 것은 모두 drop.

가장 단순한 compactor — 마커 없음, 요약 없음, 단순 hard 잘라내기. 오래된 컨텍스트는 이번 턴 호출에서 사라짐. 메모리 retriever 를 설정했다면 drop 된 사실이 retriever 를 통해 돌아올 수도 있고; 그렇지 않으면 보이지 않음.`,
      bestFor: [
        'Stateless 또는 거의 stateless 에이전트 — compactor 가 emergency 에서만 발동하며, "emergency" 가 컨텍스트 손실을 의미함을 수용',
        '강력한 18단계 + retriever 와 짝지어진 파이프라인 — retriever 가 compactor 가 drop 한 것을 커버',
        '컨텍스트 모양의 결정성이 충실도보다 더 중요한 테스트 환경',
      ],
      avoidWhen: [
        '첫 메시지가 작업 brief 나 페르소나를 포함할 때 — `truncate` 는 예산이 trigger 되면 그것을 drop. `sliding_window` (마커 유지) 또는 `progressive_disclosure` 전략을 대신 사용.',
        '대화 연속성에 의존하고 있을 때. Truncation 은 잔인 — 턴이 silent 하게 사라짐.',
      ],
      config: [
        {
          name: 'keep_last',
          label: '유지할 마지막 메시지 수',
          type: 'integer',
          default: '20',
          description:
            '압축 후 `state.messages` 는 최대 이 개수의 가장 최근 메시지를 보유. `strategy_configs.compactor.keep_last` 에 저장.',
        },
      ],
      gotchas: [
        '`keep_last` 는 메시지 (tool-result 와 system-injected 메시지 포함) 를 카운트하지, 턴 쌍이 아님. 보이는 user/assistant cap 은 파이프라인이 주입하는 다른 role 의 수에 따라 달라짐.',
        '마커가 삽입되지 않음. 대화 도중 LLM 이 트렁케이트된 히스토리를 읽으면, 이전 턴이 존재했다는 신호가 없음.',
      ],
      codeRef:
        'geny-executor / s02_context/artifact/default/compactors.py:TruncateCompactor',
    },
    {
      id: 'summary',
      label: '요약 (Summary — placeholder)',
      description: `마지막 \`keep_recent\` 메시지를 유지하고, drop 된 메시지를 **2-메시지 placeholder** 로 교체:

\`\`\`
user:      [Summary of N previous messages. ...]
assistant: Understood, I have the context from our previous conversation.
\`\`\`

또는, \`summary_text\` 가 비어있지 않으면 그 커스텀 문자열이 첫 placeholder 자리에 사용됨.

**이것은 실제 요약이 아닙니다** — drop 된 턴의 실제 내용을 전달하지 않고, 오래된 턴이 존재했다는 것만 LLM 에 신호하는 정적 placeholder pair. 실제 요약은 \`LLMSummaryCompactor\` (기본 registry 에 없음; Advanced 에서 wire) 가 필요.`,
      bestFor: [
        '히스토리가 trim 되었다는 신호 정도는 원하는 빠른 프로토타입 (`truncate` 는 silent)',
        'LLM 이 "전에 얘기했어" 정도는 알아야 하지만 그 내용은 중요하지 않은 파이프라인',
      ],
      avoidWhen: [
        'LLM 이 실제로 행동할 수 있는 요약 내용이 필요할 때. placeholder 는 리터럴 문장 — 사실 없음, 결정 없음, 아무것도 없음. 실제 요약은 `LLMSummaryCompactor` (Advanced) 사용.',
        '출력 토큰을 inch 단위로 지불할 때. placeholder pair 는 compactor 가 발화하는 매 턴마다 ~50 토큰 추가.',
      ],
      config: [
        {
          name: 'keep_recent',
          label: '유지할 최근 메시지 수',
          type: 'integer',
          default: '10',
          description:
            '그대로 보존되는 가장 최근 메시지 수. 더 오래된 메시지는 placeholder pair 로 교체. `strategy_configs.compactor.keep_recent` 에 저장.',
        },
        {
          name: 'summary_text',
          label: '커스텀 요약 텍스트',
          type: 'string',
          default: '""',
          description:
            '비어있지 않으면 자동 생성되는 `[Summary of N previous messages. ...]` placeholder 를 이 문자열로 교체. 특정 framing 을 원할 때 유용 (예: "[페르소나 설정에 관한 초기 논의 생략]").',
        },
      ],
      gotchas: [
        '주입되는 `assistant` placeholder ("Understood, I have the context...") 는 하드코딩 — 변경 config 없음. 프롬프트가 assistant role 표현에 민감하다면 그 줄이 거기 있게 됩니다.',
        'placeholder pair 가 다음 턴의 토큰 추정에 카운트됨. 예산이 *매우* 빡빡하면 compactor + placeholder 자체가 다음 예산 체크를 초과해 같은 데이터에서 재압축이 trigger 될 수 있음.',
      ],
      codeRef:
        'geny-executor / s02_context/artifact/default/compactors.py:SummaryCompactor',
    },
    {
      id: 'sliding_window',
      label: '슬라이딩 윈도우 (Sliding window)',
      description: `\`state.messages\` 의 꼬리에 **고정 크기 \`window_size\` 메시지 윈도우** 를 유지. 그 윈도우를 벗어나는 모든 것을 단일 user-role 마커로 교체:

\`\`\`
user: [N earlier messages summarized and compacted.]
\`\`\`

기능적으로 \`summary\` 와 비슷하지만 placeholder pair 대신 마커 하나, \`keep_recent\` + \`summary_text\` 두 개 대신 \`window_size\` 단일 knob.`,
      bestFor: [
        'trim 크기를 위한 단일 tunable 을 선호하는 파이프라인 (`summary` 는 두 개)',
        '프롬프트 크기에 hard ceiling 을 원하고 잃어버린 내용을 신경쓰지 않는 거의 stateless 한 마이크로 대화',
      ],
      avoidWhen: [
        'LLM 이 오래된 컨텍스트를 인정해주길 원할 때 (마커는 user-role 만 — `summary` 의 acknowledgement turn-pair 같은 게 없음)',
        '첫 메시지가 작업 brief 를 포함할 때. 윈도우가 슬라이딩하므로 첫 메시지가 결국 끝에서 떨어져 나감.',
      ],
      config: [
        {
          name: 'window_size',
          label: '윈도우 크기 (메시지)',
          type: 'integer',
          default: '30',
          description:
            '롤링 윈도우의 고정 크기. 압축 후 `state.messages` 는 마커 + 최대 `window_size` 의 최근 메시지를 보유. `strategy_configs.compactor.window_size` 에 저장.',
        },
      ],
      gotchas: [
        '마커는 `user` role 로 주입. `progressive_disclosure` 전략과 동일한 caveat — 엄격한 alternating-role 모델은 연속된 user 메시지 두 개에서 이상하게 행동할 수 있음.',
        '`summary` 처럼 마커는 리터럴 placeholder — drop 된 내용의 실제 요약이 아님.',
      ],
      codeRef:
        'geny-executor / s02_context/artifact/default/compactors.py:SlidingWindowCompactor',
    },
  ],
  relatedSections: [
    {
      label: '전략 (이 단계의 이전 슬롯)',
      body: 'Strategy 는 매 턴 실행하며 히스토리를 미리 trim 할 수 있음. Compactor 는 예산 초과 시에만 실행. 파이프라인은 보통 `simple_load` strategy + 실제 compactor, 또는 trimming strategy + `truncate` compactor 를 backstop 으로 짝짓기.',
    },
    {
      label: '18단계 — Memory',
      body: 'compactor 가 내용을 drop 할 때 18단계 (Memory) 가 손실에서 살아남는 것 — 18단계가 저장한 것은 다음 턴에 2단계의 retriever 를 통해 검색 가능. 18단계 없이 drop 된 내용은 영구히 사라집니다.',
    },
    {
      label: 'Advanced — `LLMSummaryCompactor`',
      body: '실제 요약은 같은 파일의 `LLMSummaryCompactor` 에 있음 (기본 registry 에 없음). 모델 생성 요약을 placeholder 대신 원하면 Advanced 에서 plug-in.',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/stages/s02_context/artifact/default/compactors.py',
};

export const stage02CompactorHelp: SectionHelpFactory = (locale) =>
  locale === 'ko' ? ko : en;
