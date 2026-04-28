/**
 * Help content for Stage 2 → Strategy slot.
 *
 * Source of truth: geny-executor /
 *   src/geny_executor/stages/s02_context/artifact/default/strategies.py
 * (SimpleLoadStrategy / HybridStrategy / ProgressiveDisclosureStrategy)
 */

import type { SectionHelpContent, SectionHelpFactory } from '../types';

const en: SectionHelpContent = {
  title: 'Context strategy',
  summary:
    "Decides how the conversation history in `state.messages` is shaped before the LLM call. Runs first in Stage 2 — *before* memory retrieval and compaction.",
  whatItDoes: `\`state.messages\` already holds whatever the prior turns appended (assistant replies + tool turns + this turn's user message). The context strategy decides how much of that history actually gets carried into the LLM call.

The strategy's only job is to mutate \`state.messages\` in place. It runs **synchronously** as the first step of Stage 2's \`execute()\`, before any memory work or compaction:

- \`strategy.build_context(state)\` (this slot)
- \`retriever.retrieve(query, state)\` (next slot)
- token-budget check → \`compactor.compact(state)\` if needed (next slot)

**Why pick non-default?** \`simple_load\` (the default) is a no-op — it leaves the history exactly as the previous turns left it. The other two trim aggressively, which matters when:

- you can't trust upstream to keep history sane (e.g., multi-day sessions)
- the LLM you call has a tight context window
- you want a deterministic ceiling on prompt size before compaction even kicks in

**Strategy vs Compactor.** Strategy runs *every turn* and is cheap. Compactor only fires when the running token estimate crosses 80% of the context-window budget. Use strategy for routine shape-keeping, compactor as the safety net.`,
  options: [
    {
      id: 'simple_load',
      label: 'Simple load',
      description: `**No-op.** Leaves \`state.messages\` exactly as the previous turns left it.

This is the default. It assumes the rest of the pipeline (compactor, the host's own pruning, an upstream service) already handles size management — Stage 2 doesn't need to second-guess.`,
      bestFor: [
        'Most pipelines — the executor\'s 80%-budget compactor + your host\'s own session bounds usually keep things under control',
        'Pipelines where you want the compactor to be the *only* trimming layer (deterministic — strategy never touches messages)',
        'Short sessions where history will never grow large enough to matter',
      ],
      avoidWhen: [
        'You explicitly need a turn-cap regardless of token count — pick `hybrid` or `progressive_disclosure` instead',
      ],
      gotchas: [
        '`simple_load` does NOT call the compactor. The compactor runs later in `execute()` based on estimated tokens; the strategy and the compactor are independent.',
      ],
      codeRef:
        'geny-executor / s02_context/artifact/default/strategies.py:SimpleLoadStrategy',
    },
    {
      id: 'hybrid',
      label: 'Hybrid (recent N turns + memory)',
      description: `Trim history to the **last \`max_recent_turns\` turn-pairs** (each pair = 1 user message + 1 assistant message, so the cap is \`max_recent_turns × 2\` messages).

Whenever \`state.messages\` is longer than the cap, the oldest entries are dropped on the spot. No summary marker is inserted — the older turns are simply gone from this turn's call.

Memory retrieval (the **Retriever** slot) still runs after this trim, so any persistent facts you want to keep visible should live in memory chunks rather than in raw history.`,
      bestFor: [
        'Long-running chat agents with a known healthy turn-cap (e.g., last 20 exchanges)',
        'Agents where pure recency is the right heuristic (older turns rarely cited)',
        'Pipelines paired with a strong memory retriever — the retriever covers \"what did we discuss earlier?\" queries',
      ],
      avoidWhen: [
        'The first turn carries critical context (e.g., a long task brief). Hybrid would drop it once the cap is hit. Use `progressive_disclosure` instead.',
      ],
      config: [
        {
          name: 'max_recent_turns',
          label: 'Max recent turns',
          type: 'integer',
          default: '20',
          description:
            'Number of most recent user+assistant turn pairs to keep. The actual message cap is `max_recent_turns × 2`. Stored at `strategy_configs.strategy.max_recent_turns`.',
        },
      ],
      gotchas: [
        'A turn pair is **always** counted as user+assistant, even if your pipeline injects extra system / tool-result messages between them. Edge cases (e.g., tool-result turns) get lumped into the count and may be dropped earlier than expected.',
        'No summary placeholder is inserted. The dropped turns leave no trace — the LLM has no signal that older context existed.',
      ],
      codeRef:
        'geny-executor / s02_context/artifact/default/strategies.py:HybridStrategy',
    },
    {
      id: 'progressive_disclosure',
      label: 'Progressive disclosure',
      description: `Keeps the **first message + last \`summary_threshold\` turn-pairs**, replacing everything in between with a single summary marker:

\`\`\`
[Previous conversation summarized. N messages omitted.]
\`\`\`

When \`state.messages\` is shorter than \`summary_threshold × 2\`, the strategy is a no-op — the marker only appears once history actually grows past the threshold.

The first message is always preserved because it usually carries the original task brief, persona instructions, or other anchor context.`,
      bestFor: [
        'Long sessions where the *first* user turn (a long brief, a goal statement, a system constraint stated by the user) must always be visible',
        'Workflows where users routinely refer back to early decisions ("as I said at the start...") — the marker keeps the LLM aware that older turns existed',
        'Agents that work on a fixed task with rolling sub-conversation around it',
      ],
      avoidWhen: [
        'Your first message is just "hi" or a generic greeting — preserving it wastes a slot',
        'You want a real summary of what got dropped. The marker is a static placeholder string, not a generated summary. For real summaries, use the `summary` compactor or a custom LLM-based strategy.',
      ],
      config: [
        {
          name: 'summary_threshold',
          label: 'Summary threshold (turn pairs)',
          type: 'integer',
          default: '10',
          description:
            'Once history exceeds `summary_threshold × 2` messages, older turns (between the first message and the recent ones) collapse into the summary marker. Stored at `strategy_configs.strategy.summary_threshold`.',
        },
      ],
      gotchas: [
        'The marker is a **static literal string** — it does not contain an actual summary of the dropped turns. If you need real summarisation, set the **Compactor** to `summary` (still placeholder) or build an LLM-based one.',
        'The marker is injected as a `user` role message. Some LLMs treat alternating user/assistant strictly — adding a user-role marker right before the recent turns may or may not work cleanly with your model.',
      ],
      codeRef:
        'geny-executor / s02_context/artifact/default/strategies.py:ProgressiveDisclosureStrategy',
    },
  ],
  relatedSections: [
    {
      label: 'Compactor (next slot in this stage)',
      body: 'Strategy runs every turn. Compactor only runs when estimated tokens cross 80% of the context-window budget. Strategy = routine; compactor = safety net.',
    },
    {
      label: 'Retriever (next-next slot in this stage)',
      body: 'After the strategy reshapes history, the retriever pulls memory chunks based on the *last user message*. The retriever sees the post-strategy `state.messages`.',
    },
    {
      label: 'Stage 18 — Memory',
      body: 'Stage 18 captures memory between turns; Stage 2\'s retriever reads back what Stage 18 stored. Pair `hybrid` strategy with a strong Stage 18 setup so trimmed turns don\'t lose their lessons.',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/stages/s02_context/artifact/default/strategies.py',
};

const ko: SectionHelpContent = {
  title: '컨텍스트 전략 (Context strategy)',
  summary:
    'LLM 호출 전에 \`state.messages\` 의 대화 히스토리를 어떻게 모양 잡을지 결정. 2단계에서 가장 먼저 실행 — 메모리 검색과 압축 *이전*.',
  whatItDoes: `\`state.messages\` 에는 이미 이전 턴들이 추가한 모든 것 (어시스턴트 답변 + 도구 턴 + 이번 턴 사용자 메시지) 이 담겨 있습니다. 컨텍스트 전략은 그 히스토리 중 얼마만큼이 실제로 LLM 호출까지 운반될지 결정합니다.

전략의 유일한 일은 \`state.messages\` 를 in-place 로 변형하는 것. 2단계 \`execute()\` 의 첫 단계로 **동기 실행**되며, 메모리 작업이나 압축 이전:

- \`strategy.build_context(state)\` (이 슬롯)
- \`retriever.retrieve(query, state)\` (다음 슬롯)
- 토큰 예산 체크 → 필요 시 \`compactor.compact(state)\` (다음 슬롯)

**기본값이 아닌 걸 왜 골라야 하나?** \`simple_load\` (기본값) 는 no-op — 이전 턴들이 남긴 히스토리 그대로 둠. 다른 두 옵션은 적극적으로 잘라내는데, 이는 다음 상황에 중요:

- 상위 레이어가 히스토리를 합리적으로 유지한다고 신뢰할 수 없을 때 (예: 다일 세션)
- 호출하는 LLM 의 컨텍스트 윈도우가 빡빡할 때
- 압축이 시작되기 전에 프롬프트 크기에 결정론적 ceiling 이 필요할 때

**Strategy vs Compactor.** Strategy 는 *매 턴* 실행되며 cheap. Compactor 는 실행 중 토큰 추정치가 컨텍스트 윈도우 예산의 80% 를 넘을 때만 trigger. 일상적 모양 유지는 strategy, safety net 은 compactor.`,
  options: [
    {
      id: 'simple_load',
      label: '단순 로드 (Simple load)',
      description: `**No-op.** 이전 턴들이 남긴 \`state.messages\` 그대로 둡니다.

이것이 기본값. 파이프라인 나머지 (compactor, 호스트의 자체 pruning, 상위 서비스) 가 이미 크기 관리를 한다고 가정 — 2단계는 두 번 추측하지 않음.`,
      bestFor: [
        '대부분의 파이프라인 — 실행기의 80% 예산 compactor + 호스트의 세션 경계가 보통 충분히 통제',
        'compactor 를 *유일한* 트리밍 계층으로 두고 싶은 파이프라인 (결정론적 — strategy 는 메시지를 절대 건드리지 않음)',
        '히스토리가 크기 문제를 일으킬 만큼 커지지 않는 짧은 세션',
      ],
      avoidWhen: [
        '토큰 수와 무관하게 명시적인 turn-cap 이 필요할 때 — `hybrid` 나 `progressive_disclosure` 를 대신 선택',
      ],
      gotchas: [
        '`simple_load` 가 compactor 를 호출하지 않습니다. compactor 는 \`execute()\` 의 나중 단계에서 추정 토큰을 기반으로 실행 — strategy 와 compactor 는 독립적입니다.',
      ],
      codeRef:
        'geny-executor / s02_context/artifact/default/strategies.py:SimpleLoadStrategy',
    },
    {
      id: 'hybrid',
      label: '하이브리드 (Hybrid — 최근 N 턴 + 메모리)',
      description: `히스토리를 **마지막 \`max_recent_turns\` 턴 쌍** 으로 자릅니다 (각 쌍 = user 메시지 1개 + assistant 메시지 1개, 따라서 메시지 cap 은 \`max_recent_turns × 2\`).

\`state.messages\` 가 cap 보다 길어지면 가장 오래된 항목을 즉시 drop. 요약 마커는 삽입되지 않음 — 오래된 턴은 이번 턴 호출에서 그냥 사라집니다.

메모리 검색 (**Retriever** 슬롯) 은 이 트리밍 *이후* 실행되므로, 계속 보이게 하고 싶은 영구 사실은 raw 히스토리가 아닌 메모리 청크에 두어야 합니다.`,
      bestFor: [
        '알려진 healthy turn-cap 이 있는 장기 채팅 에이전트 (예: 마지막 20 교환)',
        '순수 최근성이 올바른 휴리스틱인 에이전트 (오래된 턴이 거의 인용되지 않음)',
        '강력한 memory retriever 와 짝지어진 파이프라인 — retriever 가 "전에 뭐 얘기했지?" 쿼리를 커버',
      ],
      avoidWhen: [
        '첫 턴이 critical 한 컨텍스트 (예: 긴 작업 brief) 를 운반할 때. Hybrid 는 cap 도달 시 그것을 drop. `progressive_disclosure` 를 대신 사용.',
      ],
      config: [
        {
          name: 'max_recent_turns',
          label: '최대 최근 턴 수',
          type: 'integer',
          default: '20',
          description:
            '유지할 가장 최근 user+assistant 턴 쌍 개수. 실제 메시지 cap 은 `max_recent_turns × 2`. `strategy_configs.strategy.max_recent_turns` 에 저장.',
        },
      ],
      gotchas: [
        '턴 쌍은 **항상** user+assistant 로 카운트 — 파이프라인이 그 사이에 추가 system / tool-result 메시지를 주입하더라도. Edge case (예: tool-result 턴) 가 카운트에 묶여 예상보다 일찍 drop 될 수 있음.',
        '요약 placeholder 가 삽입되지 않음. drop 된 턴은 흔적을 남기지 않음 — LLM 은 오래된 컨텍스트가 존재했다는 신호를 받지 못합니다.',
      ],
      codeRef:
        'geny-executor / s02_context/artifact/default/strategies.py:HybridStrategy',
    },
    {
      id: 'progressive_disclosure',
      label: '점진적 공개 (Progressive disclosure)',
      description: `**첫 메시지 + 마지막 \`summary_threshold\` 턴 쌍** 을 유지하고, 그 사이의 모든 것을 단일 요약 마커로 대체:

\`\`\`
[Previous conversation summarized. N messages omitted.]
\`\`\`

\`state.messages\` 가 \`summary_threshold × 2\` 보다 짧으면 이 전략은 no-op — 마커는 히스토리가 임계값을 실제로 넘었을 때만 나타남.

첫 메시지는 항상 보존 — 보통 원래 작업 brief, 페르소나 지침, 또는 기타 anchor 컨텍스트를 운반하기 때문.`,
      bestFor: [
        '*첫* 사용자 턴 (긴 brief, 목표 진술, 사용자가 명시한 시스템 제약) 이 항상 보여야 하는 장기 세션',
        '사용자가 일상적으로 초기 결정으로 다시 참조하는 워크플로 ("처음에 말했듯이...") — 마커가 LLM 에게 오래된 턴이 존재했음을 인식시킴',
        '주위에 rolling 서브 대화가 있는 고정 작업 에이전트',
      ],
      avoidWhen: [
        '첫 메시지가 "안녕" 이나 일반 인사일 때 — 보존하는 것이 슬롯 낭비',
        'drop 된 것의 실제 요약을 원할 때. 마커는 정적 placeholder 문자열이지 생성된 요약이 아님. 실제 요약은 `summary` compactor (이것도 placeholder) 또는 LLM 기반 커스텀.',
      ],
      config: [
        {
          name: 'summary_threshold',
          label: '요약 임계값 (턴 쌍)',
          type: 'integer',
          default: '10',
          description:
            '히스토리가 `summary_threshold × 2` 메시지를 넘으면 오래된 턴 (첫 메시지와 최근 사이의) 이 요약 마커로 collapse. `strategy_configs.strategy.summary_threshold` 에 저장.',
        },
      ],
      gotchas: [
        '마커는 **정적 리터럴 문자열** — drop 된 턴의 실제 요약을 포함하지 않음. 실제 요약이 필요하면 **Compactor** 를 `summary` 로 (이것도 placeholder) 또는 LLM 기반으로 빌드.',
        '마커는 `user` role 메시지로 주입. 일부 LLM 은 user/assistant 교대를 엄격하게 다룸 — 최근 턴들 직전에 user role 마커를 추가하면 모델에 따라 작동이 달라질 수 있음.',
      ],
      codeRef:
        'geny-executor / s02_context/artifact/default/strategies.py:ProgressiveDisclosureStrategy',
    },
  ],
  relatedSections: [
    {
      label: '압축기 (이 단계의 다음 슬롯)',
      body: 'Strategy 는 매 턴 실행. Compactor 는 추정 토큰이 컨텍스트 윈도우 예산의 80% 를 넘을 때만 실행. Strategy = 일상; compactor = safety net.',
    },
    {
      label: '리트리버 (이 단계의 다음다음 슬롯)',
      body: 'strategy 가 히스토리를 재구성한 후, retriever 가 *마지막 사용자 메시지* 를 기반으로 메모리 청크를 가져옵니다. retriever 는 strategy 적용 후의 `state.messages` 를 봅니다.',
    },
    {
      label: '18단계 — Memory',
      body: '18단계는 턴 사이 메모리를 캡처; 2단계의 retriever 가 18단계가 저장한 것을 다시 읽습니다. trim 된 턴이 그 교훈을 잃지 않도록 `hybrid` 전략을 강력한 18단계 설정과 짝지으세요.',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/stages/s02_context/artifact/default/strategies.py',
};

export const stage02StrategyHelp: SectionHelpFactory = (locale) =>
  locale === 'ko' ? ko : en;
