/**
 * Help content for Stage 19 → Summarizer slot.
 */

import type { SectionHelpContent, SectionHelpFactory } from '../types';

const en: SectionHelpContent = {
  title: 'Summarizer',
  summary:
    "Produces a `SummaryRecord` for the just-finished turn. Lands at `state.shared['turn_summary']` (current turn) and appended to `state.shared['summary_history']` (audit log). Forwarded to the memory provider if Stage 18 is wired.",
  whatItDoes: `Stage 19 runs in the post-loop tail (after the loop terminates) and produces a structured summary of the turn. The summary is consumed by:

- Stage 20 (Persist) — checkpoint records embed the summary
- Stage 18 memory provider — long-term memory writes the summary, not the raw turn
- host analytics — audit log via \`state.shared['summary_history']\`

The summarizer's job is to extract the salient bits — what was said, decided, learned. Different summarizers trade computational cost (no LLM call) against fidelity (LLM-extracted summary).`,
  options: [
    {
      id: 'no_summary',
      label: 'None',
      description: `Returns \`None\` — no summary record is produced. Stage 19 effectively becomes a no-op.

Default for pipelines that don't need turn-by-turn summaries (chat agents that rely on raw history alone, ephemeral pipelines).`,
      bestFor: [
        'Pipelines without long-term memory needs',
        'Pipelines where the host generates summaries externally',
        'Cost-sensitive workloads — no extra processing per turn',
      ],
      avoidWhen: [
        'Long-running agents — without summaries, Stage 20 checkpoints get bloated with raw transcripts',
      ],
      codeRef:
        'geny-executor / s19_summarize/artifact/default/summarizers.py:NoSummarizer',
    },
    {
      id: 'rule_based',
      label: 'Rule-based',
      description: `Local extraction without an LLM call. Splits the assistant text into sentences, takes the first \`max_sentences\` as abstract, takes more as key_facts (deduplicated, capped at \`max_facts\`), extracts capitalised tokens as entities (capped at \`max_entities\`), tags the record with \`extra_tags + 'rule_based'\`.

Cheap, deterministic, no LLM cost. The summary is shallow — captures structure but not meaning. Good for pipelines where you want SOME summary without paying per-turn LLM cost.`,
      bestFor: [
        'Cost-sensitive long-running agents',
        'Pipelines with lots of turns where LLM-summarisation would be expensive',
        'Default for new pipelines that want summaries — start cheap, upgrade to LLM only if needed',
      ],
      avoidWhen: [
        'You need real semantic summaries — rule-based catches structure, not meaning. Use a custom LLM-summarizer instead.',
      ],
      config: [
        {
          name: 'max_sentences',
          label: 'Max abstract sentences',
          type: 'integer',
          default: '3',
          description:
            'First N sentences of the assistant text become the summary abstract.',
        },
        {
          name: 'max_facts',
          label: 'Max key facts',
          type: 'integer',
          default: '5',
          description:
            'Cap on key_facts list (deduped sentences after the abstract).',
        },
        {
          name: 'max_entities',
          label: 'Max entities',
          type: 'integer',
          default: '8',
          description:
            'Cap on extracted capitalised tokens (proper nouns, brand names, etc.).',
        },
        {
          name: 'extra_tags',
          label: 'Extra tags',
          type: 'list[string]',
          default: '[]',
          description:
            'Tags appended after the default `rule_based` tag. Useful for downstream filtering ("only show summaries tagged `customer_support`").',
        },
      ],
      gotchas: [
        'Sentence splitting is regex-based on `.!?` boundaries. Markdown formatting / code blocks / abbreviations can produce wrong splits.',
        'Capitalised-token entity extraction has no notion of word context — `"DAILY"` from a calendar app gets extracted as if it were a proper noun.',
      ],
      codeRef:
        'geny-executor / s19_summarize/artifact/default/summarizers.py:RuleBasedSummarizer',
    },
  ],
  relatedSections: [
    {
      label: 'Importance grader (next slot)',
      body: 'Importance grader assigns a severity to the summary (LOW / MEDIUM / HIGH / CRITICAL). Stage 20\'s `on_significant` frequency policy keys off HIGH+CRITICAL grades.',
    },
    {
      label: 'Stage 18 — Memory',
      body: 'Reflective memory strategies use Stage 19\'s summary as input — they don\'t re-summarise the raw turn. Pair `rule_based` summarizer + `reflective` memory for two-pass distillation.',
    },
    {
      label: 'Stage 20 — Persist',
      body: 'Checkpoints written by Stage 20 include the summary. With `no_summary`, checkpoints embed raw turn data — which is verbose.',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/stages/s19_summarize/artifact/default/summarizers.py',
};

const ko: SectionHelpContent = {
  title: '요약기 (Summarizer)',
  summary:
    '방금 끝난 턴의 \`SummaryRecord\` 생산. \`state.shared[\'turn_summary\']\` (현재 턴) 에 land 하고 \`state.shared[\'summary_history\']\` (감사 로그) 에 append. 18단계가 wire 됐으면 메모리 provider 로 forward.',
  whatItDoes: `19단계는 post-loop tail (루프 종료 후) 에서 실행되고 턴의 구조화된 요약 생산. 요약은 다음에서 소비:

- 20단계 (Persist) — 체크포인트 레코드가 요약 임베드
- 18단계 메모리 provider — 장기 메모리가 raw 턴이 아닌 요약 씀
- 호스트 분석 — \`state.shared['summary_history']\` 통한 감사 로그

Summarizer 의 일은 핵심 비트 추출 — 무엇이 말해졌고, 결정됐고, 배웠는지. 다른 summarizer 들이 계산 비용 (LLM 호출 없음) 대 fidelity (LLM 추출 요약) trade.`,
  options: [
    {
      id: 'no_summary',
      label: '없음',
      description: `\`None\` 반환 — 요약 레코드 생산 안 됨. 19단계가 사실상 no-op 됨.

턴별 요약 필요 없는 파이프라인의 기본값 (raw 히스토리에만 의존하는 채팅 에이전트, 임시 파이프라인).`,
      bestFor: [
        '장기 메모리 needs 없는 파이프라인',
        '호스트가 외부에서 요약 생성하는 파이프라인',
        '비용 민감 워크로드 — 턴당 추가 처리 없음',
      ],
      avoidWhen: [
        '장기 에이전트 — 요약 없이 20단계 체크포인트가 raw 트랜스크립트로 부풀음',
      ],
      codeRef:
        'geny-executor / s19_summarize/artifact/default/summarizers.py:NoSummarizer',
    },
    {
      id: 'rule_based',
      label: '규칙 기반 (Rule-based)',
      description: `LLM 호출 없는 로컬 추출. 어시스턴트 텍스트를 문장으로 split, 첫 \`max_sentences\` 를 abstract 로, 더 많은 것을 key_facts (중복 제거, \`max_facts\` cap) 로, 대문자 토큰을 entities (\`max_entities\` cap) 로 추출, 레코드를 \`extra_tags + 'rule_based'\` 로 태그.

싸고, 결정적, LLM 비용 없음. 요약이 얕음 — 구조를 캡처하지만 의미는 아님. 턴당 LLM 비용 안 내고 SOME 요약 원하는 파이프라인에 좋음.`,
      bestFor: [
        '비용 민감 장기 에이전트',
        'LLM 요약화가 비쌀 많은 턴의 파이프라인',
        '요약 원하는 새 파이프라인의 기본값 — 싸게 시작, 필요할 때만 LLM 으로 업그레이드',
      ],
      avoidWhen: [
        '실제 시맨틱 요약 필요할 때 — rule-based 가 구조 잡지만 의미는 아님. 커스텀 LLM-summarizer 사용.',
      ],
      config: [
        {
          name: 'max_sentences',
          label: '최대 abstract 문장 수',
          type: 'integer',
          default: '3',
          description:
            '어시스턴트 텍스트의 첫 N 문장이 요약 abstract 가 됨.',
        },
        {
          name: 'max_facts',
          label: '최대 key facts 수',
          type: 'integer',
          default: '5',
          description:
            'key_facts 리스트의 cap (abstract 후 중복 제거된 문장).',
        },
        {
          name: 'max_entities',
          label: '최대 entities 수',
          type: 'integer',
          default: '8',
          description:
            '추출된 대문자 토큰의 cap (고유명사, 브랜드명 등).',
        },
        {
          name: 'extra_tags',
          label: '추가 태그',
          type: 'list[string]',
          default: '[]',
          description:
            '기본 `rule_based` 태그 후에 append 되는 태그. 하류 필터링에 유용 ("`customer_support` 태그된 요약만 보기").',
        },
      ],
      gotchas: [
        '문장 split 이 `.!?` 경계의 regex 기반. Markdown 포맷팅 / 코드 블록 / 약어가 잘못된 split 생산 가능.',
        '대문자 토큰 entity 추출이 단어 컨텍스트 인식 없음 — 캘린더 앱의 `"DAILY"` 가 고유명사처럼 추출됨.',
      ],
      codeRef:
        'geny-executor / s19_summarize/artifact/default/summarizers.py:RuleBasedSummarizer',
    },
  ],
  relatedSections: [
    {
      label: '중요도 평가 (다음 슬롯)',
      body: 'Importance grader 가 요약에 severity 할당 (LOW / MEDIUM / HIGH / CRITICAL). 20단계의 `on_significant` 빈도 policy 가 HIGH+CRITICAL 등급에 key.',
    },
    {
      label: '18단계 — Memory',
      body: 'Reflective 메모리 strategy 가 19단계의 요약을 입력으로 사용 — raw 턴을 재요약 안 함. `rule_based` summarizer + `reflective` 메모리 짝지어 2-pass 증류.',
    },
    {
      label: '20단계 — Persist',
      body: '20단계가 쓰는 체크포인트가 요약 포함. `no_summary` 면 체크포인트가 raw 턴 데이터 임베드 — 장황함.',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/stages/s19_summarize/artifact/default/summarizers.py',
};

export const stage19SummarizerHelp: SectionHelpFactory = (locale) =>
  locale === 'ko' ? ko : en;
