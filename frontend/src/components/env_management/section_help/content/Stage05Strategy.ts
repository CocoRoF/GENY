/**
 * Help content for Stage 5 → Cache strategy slot (and the stage's
 * `cache_prefix` config field is rendered into the same section in
 * the curated editor, so we cover it here too).
 */

import type { SectionHelpContent, SectionHelpFactory } from '../types';

const en: SectionHelpContent = {
  title: 'Cache strategy',
  summary:
    "Inserts Anthropic-style `cache_control` markers into `state.system` and `state.messages` so the LLM provider can cache-hit on stable prefixes. **Only Claude models honour these markers** — OpenAI / Google have separate automatic caching and bypass this stage.",
  whatItDoes: `Stage 5 runs after Stage 3 (System) and Stage 4 (Guard) — by the time it executes, \`state.system\` and \`state.messages\` are finalized for this turn. The strategy's job is to walk those structures and add \`cache_control\` markers to the right blocks so the next LLM call benefits from prompt caching.

**The model gate.** Strategies internally check \`state.model.startswith("claude-")\`. Non-Claude models silently skip cache marking — the stage runs but is a no-op for them. This is correct (OpenAI / Google don't accept Anthropic's marker shape), but means the picker choice is irrelevant if your model isn't Claude.

**The system-prompt gate.** \`SystemCacheStrategy\` and \`AggressiveCacheStrategy\` need \`state.system\` to be a *list of content blocks*, not a plain string. If your Stage 3 builder returns a string (\`StaticPromptBuilder\` always does), the cache strategy converts it to a single-element list before marking — that works. But if Stage 3 returned an empty string, there's nothing to mark and the strategy quietly skips.

**\`cache_prefix\`.** A string prepended to cache keys for namespace isolation. Useful when several agents share a vendor account — different prefixes prevent accidental cache collisions across agents. Default empty.`,
  options: [
    {
      id: 'no_cache',
      label: 'None',
      description: `Pass-through. Adds no markers. \`should_bypass(state)\` returns \`true\` for this strategy, so the pipeline runner skips Stage 5's \`execute()\` entirely — zero overhead.

This is the default. Pipelines that don't run on Claude or that don't care about cache-hit rates leave the slot here.`,
      bestFor: [
        'Non-Claude pipelines (OpenAI, Google) — caching is automatic at the vendor level',
        'Short-session pipelines — cost savings from caching don\'t justify the complexity',
        'Pipelines where prompt content changes every turn — caching wouldn\'t hit anyway',
      ],
      avoidWhen: [
        'You\'re running Claude with stable system prompts — `system_cache` or better will save real money',
      ],
      gotchas: [
        'The stage\'s `should_bypass()` returns true here — the pipeline runner doesn\'t even call `execute()`. So `cache_prefix` is also unused (it\'s only read inside `execute()`).',
      ],
      codeRef:
        'geny-executor / s05_cache/artifact/default/strategies.py:NoCacheStrategy',
    },
    {
      id: 'system_cache',
      label: 'System only',
      description: `Adds a single \`cache_control: {type: "ephemeral"}\` marker to the **last block of \`state.system\`**.

If the system was a string, it's first converted to \`[{type: "text", text: "...", cache_control: {...}}]\`. If it was already a list of blocks, the last block gets the marker (and only if it doesn't already have one — won't overwrite).

The marker creates a cache breakpoint at the system/messages boundary. As long as the system prompt stays byte-identical across turns, Anthropic will cache-hit it; only the messages portion gets re-tokenized.`,
      bestFor: [
        'Most Claude pipelines with a stable system prompt and a tight prompt structure',
        'Cost-sensitive workloads where the system prompt is multiple KB',
        'The right starting point — promote to `aggressive_cache` only if you also want history caching',
      ],
      avoidWhen: [
        'System prompt changes every turn (e.g., persona is mostly date-stamped) — cache will miss every turn, paying the marker overhead for nothing',
        'You also want caching of the stable history prefix — use `aggressive_cache` instead',
      ],
      gotchas: [
        'The marker only stops at the **last** system block. If you have multiple blocks and want to cache only some of them, you\'ll have to author a custom strategy.',
        'Empty `state.system` after Stage 3 → the strategy skips silently. No marker to place, no event to inspect.',
      ],
      codeRef:
        'geny-executor / s05_cache/artifact/default/strategies.py:SystemCacheStrategy',
    },
    {
      id: 'aggressive_cache',
      label: 'Aggressive',
      description: `\`SystemCacheStrategy\` PLUS a second cache breakpoint inside \`state.messages\` at the **stable history boundary** (the message at index \`len(messages) - stable_history_offset - 1\`).

The pattern: assume the last \`stable_history_offset\` messages change every turn (recent user/assistant exchanges) but everything before that is stable history that's worth caching. Place a breakpoint right at that boundary so Anthropic caches the older portion.

Default offset of 4 means "the last 4 messages are volatile, everything before is stable" — works well for chat with multi-turn workflows.`,
      bestFor: [
        'Long-running Claude sessions with substantial stable history',
        'Multi-turn workflows where the early turns are reference material that doesn\'t change',
        'Multi-modal pipelines — image content blocks in stable history are expensive to re-tokenize, caching saves a lot',
      ],
      avoidWhen: [
        'Short sessions (< 5 messages) — the offset means you\'d be caching nothing',
        'Sessions where every message in history actually changes turn-over-turn (e.g., counter examples in a teaching pipeline)',
      ],
      config: [
        {
          name: 'stable_history_offset',
          label: 'Stable history offset',
          type: 'integer',
          default: '4',
          description:
            'Cache breakpoint goes at `len(messages) - offset - 1`. Lower = more of the tail is treated as volatile (less cache coverage but safer if history is unstable). Higher = more cache coverage but you bet the older messages don\'t change.',
        },
      ],
      gotchas: [
        'When `len(messages) <= offset`, the strategy silently skips the history breakpoint (still applies the system breakpoint). For early turns of a session you don\'t get history caching yet.',
        'The boundary message gets `cache_control` on its **last content block**, just like the system path. If your message has multiple content blocks (e.g., text + image), only the last one gets marked.',
        'Cache breakpoints have a 5-minute TTL on Anthropic. If turns are spaced out (e.g., interactive sessions with long pauses), the cache may not hit even though the markers are correct.',
      ],
      codeRef:
        'geny-executor / s05_cache/artifact/default/strategies.py:AggressiveCacheStrategy',
    },
  ],
  configFields: [
    {
      name: 'config.cache_prefix',
      label: 'Cache prefix',
      type: 'string',
      default: '""',
      description:
        'Stored on `stage.config`. Prepended to cache keys for namespace isolation when multiple agents share a vendor account. Default empty (single-agent setups). Note: this is event metadata only — Anthropic\'s actual cache key is content-derived, not key-derived.',
    },
  ],
  relatedSections: [
    {
      label: 'Stage 3 — System',
      body: 'For caching to work, Stage 3\'s prompt builder must produce content blocks (`composable` with `use_content_blocks=True`) — `static` builder produces plain strings that the cache strategy still converts, but you\'ll only get system caching, not block-level granularity.',
    },
    {
      label: 'Stage 6 — API',
      body: 'Stage 6\'s vendor translators handle the actual API call. For non-Claude models, the markers are stripped during translation (no-op). For Claude, the markers are passed straight through — the vendor SDK does the cache logic.',
    },
    {
      label: 'Stage 7 — Token',
      body: 'Cache hits show up in `state.token_usage.cache_read_input_tokens`. Stage 7\'s pricing calculator uses that to apply discounted rates (Anthropic charges 10% for cache reads, 25% extra for cache writes). Without Stage 7, the cost benefit is invisible.',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/stages/s05_cache/artifact/default/strategies.py',
};

const ko: SectionHelpContent = {
  title: '캐시 전략 (Cache strategy)',
  summary:
    'Anthropic 스타일 \`cache_control\` 마커를 \`state.system\` 과 \`state.messages\` 에 삽입해 LLM provider 가 stable prefix 에서 cache-hit 하도록. **Claude 모델만 이 마커를 honour 함** — OpenAI / Google 은 별도 자동 캐싱이 있고 이 단계를 우회.',
  whatItDoes: `5단계는 3단계 (System) 와 4단계 (Guard) 후에 실행 — 실행 시점에 \`state.system\` 과 \`state.messages\` 가 이번 턴에 대해 finalize 됨. 전략의 일은 그 구조를 walk 하면서 다음 LLM 호출이 prompt 캐싱에서 이익 보도록 올바른 블록에 \`cache_control\` 마커 추가.

**모델 게이트.** 전략이 내부적으로 \`state.model.startswith("claude-")\` 를 체크. 비-Claude 모델은 silent 하게 캐시 마킹 skip — 단계가 실행되지만 그들에게는 no-op. 이는 정확함 (OpenAI / Google 은 Anthropic 마커 모양을 받아들이지 않음) 이지만, 모델이 Claude 가 아니면 picker 선택이 무관.

**System prompt 게이트.** \`SystemCacheStrategy\` 와 \`AggressiveCacheStrategy\` 는 \`state.system\` 이 *content block 리스트* 여야 함, 평문 문자열이 아닌. 3단계 빌더가 문자열을 반환하면 (\`StaticPromptBuilder\` 가 항상 그러함), 캐시 전략이 마킹 전에 단일 element 리스트로 변환 — 작동함. 하지만 3단계가 빈 문자열을 반환했다면 마킹할 게 없고 전략이 조용히 skip.

**\`cache_prefix\`.** namespace 격리를 위해 캐시 키 앞에 prepend 되는 문자열. 여러 에이전트가 vendor 계정을 공유할 때 유용 — 다른 prefix 가 에이전트 간 우발적 캐시 충돌 방지. 기본값 비어있음.`,
  options: [
    {
      id: 'no_cache',
      label: '없음 (None)',
      description: `Pass-through. 마커 추가 안 함. \`should_bypass(state)\` 가 이 전략에 \`true\` 를 반환하므로 파이프라인 runner 가 5단계의 \`execute()\` 를 통째로 skip — 오버헤드 0.

기본값. Claude 에서 실행하지 않거나 cache-hit 비율을 신경쓰지 않는 파이프라인은 슬롯을 여기에 둠.`,
      bestFor: [
        '비-Claude 파이프라인 (OpenAI, Google) — 캐싱은 vendor 레벨에서 자동',
        '짧은 세션 파이프라인 — 캐싱 비용 절약이 복잡성을 정당화 못함',
        '프롬프트 내용이 매 턴 바뀌는 파이프라인 — 캐싱이 어차피 hit 안 됨',
      ],
      avoidWhen: [
        '안정된 시스템 프롬프트로 Claude 를 운영하고 있을 때 — `system_cache` 이상이 실제 비용을 절약',
      ],
      gotchas: [
        '여기서 단계의 `should_bypass()` 가 true 반환 — 파이프라인 runner 가 `execute()` 를 호출조차 안 함. 그래서 `cache_prefix` 도 미사용 (`execute()` 안에서만 읽힘).',
      ],
      codeRef:
        'geny-executor / s05_cache/artifact/default/strategies.py:NoCacheStrategy',
    },
    {
      id: 'system_cache',
      label: 'System only (시스템만)',
      description: `**\`state.system\` 의 마지막 블록**에 단일 \`cache_control: {type: "ephemeral"}\` 마커 추가.

system 이 문자열이었다면 먼저 \`[{type: "text", text: "...", cache_control: {...}}]\` 로 변환. 이미 블록 리스트였다면 마지막 블록이 마커 받음 (이미 있으면 안 함 — overwrite 안 됨).

마커는 system/messages 경계에 cache breakpoint 생성. 시스템 프롬프트가 턴 간 byte-identical 으로 유지되는 한 Anthropic 이 cache-hit; messages 부분만 재토큰화.`,
      bestFor: [
        '안정된 시스템 프롬프트와 빡빡한 프롬프트 구조의 대부분 Claude 파이프라인',
        '시스템 프롬프트가 여러 KB 인 비용 민감 워크로드',
        '올바른 시작점 — 히스토리 캐싱도 원할 때만 `aggressive_cache` 로 승격',
      ],
      avoidWhen: [
        '시스템 프롬프트가 매 턴 바뀔 때 (예: persona 가 대부분 날짜 스탬프됨) — 캐시가 매 턴 miss, 마커 오버헤드만 지불',
        '안정된 히스토리 prefix 의 캐싱도 원할 때 — `aggressive_cache` 사용',
      ],
      gotchas: [
        '마커는 **마지막** 시스템 블록에만 멈춤. 여러 블록이 있고 일부만 캐시하고 싶다면 커스텀 전략을 작성해야 함.',
        '3단계 후 빈 `state.system` → 전략이 silent 하게 skip. 배치할 마커 없음, inspect 할 이벤트 없음.',
      ],
      codeRef:
        'geny-executor / s05_cache/artifact/default/strategies.py:SystemCacheStrategy',
    },
    {
      id: 'aggressive_cache',
      label: '공격적 (Aggressive)',
      description: `\`SystemCacheStrategy\` + \`state.messages\` 안의 **안정된 히스토리 경계**에 두 번째 cache breakpoint (인덱스 \`len(messages) - stable_history_offset - 1\` 의 메시지).

패턴: 마지막 \`stable_history_offset\` 메시지는 매 턴 변한다고 가정 (최근 user/assistant 교환), 그 이전 모든 것은 캐싱할 가치 있는 안정 히스토리. 그 경계에 정확히 breakpoint 배치 = Anthropic 이 더 오래된 부분 캐시.

기본 offset 4 = "마지막 4 메시지는 휘발성, 그 이전은 안정" — 멀티턴 워크플로의 채팅에 잘 작동.`,
      bestFor: [
        '상당한 안정 히스토리가 있는 장기 Claude 세션',
        '초기 턴이 변하지 않는 참고 자료인 멀티턴 워크플로',
        '멀티모달 파이프라인 — 안정 히스토리의 이미지 content 블록은 재토큰화 비용이 비싸므로 캐싱이 많이 절약',
      ],
      avoidWhen: [
        '짧은 세션 (< 5 메시지) — offset 이 캐싱할 게 아무것도 없다는 뜻',
        '히스토리의 모든 메시지가 실제로 턴 마다 변하는 세션 (예: 가르침 파이프라인의 카운터 예제)',
      ],
      config: [
        {
          name: 'stable_history_offset',
          label: '안정 히스토리 오프셋',
          type: 'integer',
          default: '4',
          description:
            'Cache breakpoint 이 `len(messages) - offset - 1` 에 감. 낮을수록 = tail 의 더 많은 것이 휘발성으로 처리 (캐시 커버리지 적지만 히스토리가 불안정하면 안전). 높을수록 = 캐시 커버리지 많지만 더 오래된 메시지가 변하지 않는다는 데 베팅.',
        },
      ],
      gotchas: [
        '`len(messages) <= offset` 일 때 전략이 silent 하게 히스토리 breakpoint skip (시스템 breakpoint 는 여전히 적용). 세션 초기 턴에서는 히스토리 캐싱을 아직 못 받음.',
        '경계 메시지가 시스템 경로처럼 **마지막 content 블록** 에 `cache_control` 받음. 메시지에 여러 content 블록 (예: 텍스트 + 이미지) 있으면 마지막 것만 마킹.',
        'Anthropic 의 cache breakpoint 는 5분 TTL. 턴이 띄엄띄엄 (예: 긴 일시 정지가 있는 인터랙티브 세션) 이면 마커가 정확해도 캐시가 hit 안 할 수 있음.',
      ],
      codeRef:
        'geny-executor / s05_cache/artifact/default/strategies.py:AggressiveCacheStrategy',
    },
  ],
  configFields: [
    {
      name: 'config.cache_prefix',
      label: '캐시 prefix',
      type: 'string',
      default: '""',
      description:
        '`stage.config` 에 저장. 여러 에이전트가 vendor 계정을 공유할 때 namespace 격리를 위해 캐시 키 앞에 prepend. 기본값 비어있음 (단일 에이전트 설정). 참고: 이는 이벤트 메타데이터일 뿐 — Anthropic 의 실제 캐시 키는 content-derived 이지 key-derived 가 아님.',
    },
  ],
  relatedSections: [
    {
      label: '3단계 — System',
      body: '캐싱이 작동하려면 3단계의 prompt builder 가 content block 을 생성해야 함 (`composable` + `use_content_blocks=True`) — `static` 빌더는 평문 문자열 생성, 캐시 전략이 변환은 하지만 시스템 캐싱만 받고 블록 레벨 granularity 는 못 받음.',
    },
    {
      label: '6단계 — API',
      body: '6단계의 vendor translator 가 실제 API 호출을 처리. 비-Claude 모델은 변환 중 마커 제거 (no-op). Claude 는 마커를 그대로 전달 — vendor SDK 가 캐시 로직 수행.',
    },
    {
      label: '7단계 — Token',
      body: 'Cache hit 가 `state.token_usage.cache_read_input_tokens` 에 나타남. 7단계의 pricing calculator 가 그것을 사용해 할인 요율 적용 (Anthropic 은 cache read 에 10%, cache write 에 25% 추가 청구). 7단계 없이 비용 이익은 보이지 않음.',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/stages/s05_cache/artifact/default/strategies.py',
};

export const stage05StrategyHelp: SectionHelpFactory = (locale) =>
  locale === 'ko' ? ko : en;
