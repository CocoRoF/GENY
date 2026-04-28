/**
 * Help content for Stage 1 → Validator slot.
 *
 * Source of truth: geny-executor /
 *   src/geny_executor/stages/s01_input/artifact/default/validators.py
 * (DefaultValidator / PassthroughValidator / StrictValidator /
 * SchemaValidator)
 */

import type { SectionHelpContent, SectionHelpFactory } from '../types';

const en: SectionHelpContent = {
  title: 'Validator',
  summary:
    "The first gate. Decides whether incoming input is even allowed to enter the pipeline. Runs synchronously before any LLM call — failing here aborts the turn with a StageError.",
  whatItDoes:
    "Stage 1 receives raw input from the host (string, dict, or NormalizedInput). The validator runs first and answers a single question: \"Is this input valid?\" — returning either None (proceed) or an error string (reject).\n\nA rejection raises StageError(\"Input validation failed: <reason>\") and the pipeline never reaches Stage 2 (context), Stage 6 (api), or any LLM call. Token usage stays at zero.\n\nThe validator only inspects raw input. It cannot read state.messages, model config, or anything from prior turns. If you need cross-turn checks, do them in Stage 4 (guard) instead.",
  options: [
    {
      id: 'default',
      label: 'Default',
      description:
        "Standard length and type validation. Rejects None, anything that turns into a string shorter than min_length, and anything longer than max_length. Strips whitespace before measuring.\n\nThis is what most chat agents want — it catches obvious junk (empty submissions, accidentally-pasted megabytes) without false-rejecting legitimate text.",
      bestFor: [
        'Chat agents accepting natural-language user messages',
        'API agents whose input is expected to be free-form text',
        'Default for most VTuber / worker pipelines',
      ],
      avoidWhen: [
        'You want to accept exactly empty input (use Passthrough)',
        'You want to reject inputs by content shape (use Schema)',
      ],
      config: [
        {
          name: 'min_length',
          label: 'Minimum length',
          type: 'integer',
          default: '1',
          description:
            'Inputs whose stripped length is below this value are rejected. Hardcoded in __init__ — currently NOT runtime-configurable via manifest (no configure() method on DefaultValidator).',
        },
        {
          name: 'max_length',
          label: 'Maximum length',
          type: 'integer',
          default: '1,000,000',
          description:
            'Upper cap on stripped input length. Same constraint as min_length: ctor-only, not runtime-configurable.',
        },
      ],
      gotchas: [
        "min_length / max_length are ctor parameters but the executor's slot.swap creates a fresh instance via cls() — so manifest values for these fields are silently dropped today.",
        'A None input is rejected with "Input cannot be None" before length is even checked.',
      ],
      codeRef:
        'geny-executor / s01_input/artifact/default/validators.py:DefaultValidator',
    },
    {
      id: 'passthrough',
      label: 'Passthrough',
      description:
        "No validation at all — always returns None. Use only for trusted internal pipelines where the host has already validated the input upstream, or for testing the rest of the pipeline without the validator getting in the way.\n\nThis is the only validator that has zero failure modes. Even None inputs pass through (Stage 1's normalizer will then handle the str(None) coercion).",
      bestFor: [
        'Testing — running a pipeline scenario with crafted edge-case inputs',
        'Internal pipelines whose input is constructed by trusted code, not user-typed',
        'Replaying snapshotted inputs that already passed validation in a prior run',
      ],
      avoidWhen: [
        'Any production agent receiving user input',
        'Any agent connected to an external HTTP endpoint',
      ],
      gotchas: [
        'A None input WILL reach Stage 2. The default normalizer coerces it to "None" (literal string). Most downstream stages treat that as a degenerate user message.',
      ],
      codeRef:
        'geny-executor / s01_input/artifact/default/validators.py:PassthroughValidator',
    },
    {
      id: 'strict',
      label: 'Strict',
      description:
        "DefaultValidator's checks plus a substring blocklist. Each pattern is matched case-insensitively against the stripped, lowercased text. Any match rejects the turn with \"Input contains blocked pattern\".\n\nMax length defaults to 100,000 (vs Default's 1M) so very long inputs are also rejected. Useful for prompts where you want to forbid certain keywords (jailbreak attempts, banned commands) without standing up an LLM-based moderator.",
      bestFor: [
        'Public-facing endpoints with a known set of disallowed terms',
        'Children-targeted agents where banned-word lists are policy-mandated',
        'Compliance pipelines that need a synchronous, auditable rejection path',
      ],
      avoidWhen: [
        'You need semantic moderation (a regex / substring list cannot do that — use an LLM moderation step earlier in the host or in Stage 4)',
        "Input is naturally short snippets that may legitimately contain blocked words in non-harmful context (the matcher has no notion of context)",
      ],
      config: [
        {
          name: 'blocked_patterns',
          label: 'Blocked patterns',
          type: 'list[string]',
          default: '[]',
          description:
            "Substrings to reject (case-insensitive). Inputs containing any pattern are rejected before any LLM call. Stored at strategy_configs.validator.blocked_patterns. As of executor v1.3.1+, configure() applies these at runtime.",
        },
        {
          name: 'max_length',
          label: 'Maximum length',
          type: 'integer',
          default: '100,000',
          description:
            "Stricter than Default's 1M ceiling. Configurable via the same configure() method.",
        },
      ],
      gotchas: [
        'Pattern matching is plain substring, not word-boundary aware — "ass" would match "class" and "assess".',
        'Matching is case-insensitive but otherwise literal. No regex support.',
        'Empty input is rejected with a different message ("Input cannot be empty") than too-short (Default).',
      ],
      codeRef:
        'geny-executor / s01_input/artifact/default/validators.py:StrictValidator',
    },
    {
      id: 'schema',
      label: 'Schema',
      description:
        "Validates that the input is a dict and that the dict contains all keys listed in the schema's 'required' array. Use this for server-to-server agents that should only accept structured JSON requests.\n\nNOTE: The current implementation only checks 'required' keys. It does NOT validate types, enums, ranges, or any other JSON Schema construct — those are silently ignored. If you need full Draft-7 validation, plug your own validator implementation in Advanced.",
      bestFor: [
        "API-style agents whose input is always a known JSON shape (e.g., {action, payload})",
        'Webhook receivers where the schema doubles as documentation of accepted requests',
        'Pipelines where rejecting malformed bodies before any LLM cost is critical',
      ],
      avoidWhen: [
        'Inputs are free-form text — Schema rejects all non-dict inputs',
        "You need real type / enum / range validation — this validator only enforces the 'required' keys list",
      ],
      config: [
        {
          name: 'schema',
          label: 'JSON Schema',
          type: 'object',
          required: true,
          description:
            "JSON object stored at strategy_configs.validator.schema. The executor reads schema.required (a string list) and rejects inputs missing any of those keys. Other JSON Schema fields (type, properties, additionalProperties, etc.) are stored but not enforced today.",
        },
      ],
      gotchas: [
        "If the input is not a dict, the validator rejects with \"Input must be a dictionary for schema validation\" before checking 'required'.",
        "Only the top-level 'required' array is consulted. Nested schemas, properties, and types are ignored.",
        'The schema dict is round-tripped via configure() / get_config() — if you set it via the curated Schema textarea, the value persists in the manifest as-is.',
      ],
      codeRef:
        'geny-executor / s01_input/artifact/default/validators.py:SchemaValidator',
    },
  ],
  relatedSections: [
    {
      label: 'Normalizer (next slot in this stage)',
      body: 'After validation passes, the normalizer rewrites the input into NormalizedInput. The validator only inspects; the normalizer transforms.',
    },
    {
      label: 'Stage 4 — Guard',
      body: "Cross-turn checks (cost / iteration / token budgets, tool permission lists) belong in Stage 4. The validator only sees this turn's raw input, not pipeline state.",
    },
    {
      label: 'Stage 9 — Parse',
      body: "If you want to validate the LLM's output (not the user's input), use Stage 9's structured_output parser, not the input validator.",
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/stages/s01_input/artifact/default/validators.py',
};

const ko: SectionHelpContent = {
  title: '검증기 (Validator)',
  summary:
    '첫 번째 게이트. 들어오는 입력이 파이프라인에 진입할 자격이 있는지 결정합니다. LLM 호출 전에 동기 실행 — 여기서 실패하면 StageError 로 턴이 중단됩니다.',
  whatItDoes:
    "1단계는 호스트로부터 raw 입력 (문자열 / dict / NormalizedInput) 을 받습니다. 검증기가 가장 먼저 실행되며 단일 질문에 답합니다 — \"이 입력이 유효한가?\". None 을 반환하면 통과, 에러 문자열을 반환하면 거부.\n\n거부 시 StageError(\"Input validation failed: <reason>\") 를 발생시키고 파이프라인은 2단계 (context), 6단계 (api), 어떤 LLM 호출에도 도달하지 않습니다. 토큰 사용량은 0 으로 유지.\n\n검증기는 raw 입력만 봅니다. state.messages, 모델 설정, 이전 턴의 어떤 것도 읽을 수 없습니다. 턴 간 검증이 필요하면 4단계 (guard) 에서 처리하세요.",
  options: [
    {
      id: 'default',
      label: '기본 (Default)',
      description:
        '표준 길이 및 타입 검증. None, 문자열 변환 후 min_length 보다 짧은 것, max_length 보다 긴 것을 거부. 측정 전에 공백을 제거합니다.\n\n대부분의 채팅 에이전트가 원하는 동작 — 정상 텍스트는 false-reject 하지 않으면서 명백한 쓰레기 (빈 제출, 실수로 붙여넣은 메가바이트 단위 텍스트) 는 잡아냅니다.',
      bestFor: [
        '자연어 사용자 메시지를 받는 채팅 에이전트',
        '자유 형식 텍스트가 입력으로 예상되는 API 에이전트',
        '대부분의 VTuber / worker 파이프라인 기본값',
      ],
      avoidWhen: [
        '정확히 빈 입력을 받아야 할 때 (Passthrough 사용)',
        '내용 모양으로 입력을 거부해야 할 때 (Schema 사용)',
      ],
      config: [
        {
          name: 'min_length',
          label: '최소 길이',
          type: 'integer',
          default: '1',
          description:
            '공백 제거 후 길이가 이 값 미만이면 거부. __init__ 에 하드코딩 — 현재 매니페스트로 런타임 변경 불가 (DefaultValidator 에 configure() 메서드 없음).',
        },
        {
          name: 'max_length',
          label: '최대 길이',
          type: 'integer',
          default: '1,000,000',
          description:
            '공백 제거 후 입력 길이의 상한. min_length 와 동일 제약: ctor 전용, 런타임 변경 불가.',
        },
      ],
      gotchas: [
        'min_length / max_length 는 ctor 파라미터지만 실행기의 slot.swap 이 cls() 로 새 인스턴스를 만들어 — 매니페스트 값이 현재 silently 무시됩니다.',
        'None 입력은 길이 검사 전에 "Input cannot be None" 으로 거부됩니다.',
      ],
      codeRef:
        'geny-executor / s01_input/artifact/default/validators.py:DefaultValidator',
    },
    {
      id: 'passthrough',
      label: 'Passthrough',
      description:
        '검증 없음 — 항상 None 반환. 호스트가 이미 상위에서 입력을 검증한 신뢰된 내부 파이프라인이거나, 검증기 방해 없이 나머지 파이프라인을 테스트할 때만 사용.\n\n이 검증기는 실패 모드가 0 인 유일한 옵션입니다. None 입력도 그대로 통과 (1단계의 normalizer 가 str(None) 변환을 처리).',
      bestFor: [
        '테스트 — 정교한 엣지 케이스 입력으로 파이프라인 시나리오 실행',
        '신뢰된 코드가 입력을 만들고 사용자가 직접 입력하지 않는 내부 파이프라인',
        '이미 이전 실행에서 검증을 통과한 스냅샷 입력 재생',
      ],
      avoidWhen: [
        '사용자 입력을 받는 모든 프로덕션 에이전트',
        '외부 HTTP 엔드포인트에 연결된 모든 에이전트',
      ],
      gotchas: [
        'None 입력이 그대로 2단계까지 도달합니다. 기본 normalizer 가 "None" (리터럴 문자열) 으로 강제 변환합니다. 대부분의 하류 단계는 이를 비정상 사용자 메시지로 취급.',
      ],
      codeRef:
        'geny-executor / s01_input/artifact/default/validators.py:PassthroughValidator',
    },
    {
      id: 'strict',
      label: 'Strict',
      description:
        'DefaultValidator 의 검사 + 부분 문자열 차단 목록. 각 패턴은 공백 제거된 소문자 텍스트와 대소문자 무시로 매칭. 일치하면 "Input contains blocked pattern" 으로 턴 거부.\n\n최대 길이는 100,000 으로 기본값 (Default 의 1M 대비) — 매우 긴 입력도 거부됩니다. LLM 기반 모더레이터를 세우지 않고도 특정 키워드 (탈옥 시도, 금지 명령) 를 막아야 할 때 유용.',
      bestFor: [
        '금지어 목록이 알려진 공개 엔드포인트',
        '아동 대상 에이전트로 금지어 목록이 정책상 필수',
        '동기, 감사 가능한 거부 경로가 필요한 컴플라이언스 파이프라인',
      ],
      avoidWhen: [
        '의미 기반 모더레이션이 필요할 때 (regex / substring 으로는 불가 — 호스트나 4단계에서 LLM 모더레이션 단계 추가)',
        '입력이 본질적으로 짧은 스니펫이고 비유해 맥락에서 차단어를 합법적으로 포함할 수 있을 때 (matcher 는 맥락을 모름)',
      ],
      config: [
        {
          name: 'blocked_patterns',
          label: '차단 패턴',
          type: 'list[string]',
          default: '[]',
          description:
            '거부할 부분 문자열 (대소문자 무시). 입력에 패턴 중 하나라도 포함되면 LLM 호출 전에 거부됩니다. strategy_configs.validator.blocked_patterns 에 저장. executor v1.3.1+ 부터 configure() 가 런타임에 적용합니다.',
        },
        {
          name: 'max_length',
          label: '최대 길이',
          type: 'integer',
          default: '100,000',
          description:
            'Default 의 1M 대비 더 엄격. 동일한 configure() 로 변경 가능.',
        },
      ],
      gotchas: [
        '패턴 매칭은 단순 부분 문자열로 단어 경계 인식 안 함 — "ass" 가 "class" 나 "assess" 에도 매칭됩니다.',
        '대소문자 무시지만 그 외엔 리터럴. regex 미지원.',
        '빈 입력은 너무 짧음 (Default) 와 다른 메시지 ("Input cannot be empty") 로 거부.',
      ],
      codeRef:
        'geny-executor / s01_input/artifact/default/validators.py:StrictValidator',
    },
    {
      id: 'schema',
      label: 'Schema',
      description:
        "입력이 dict 인지 + dict 가 스키마의 'required' 배열에 있는 모든 키를 포함하는지 검증. 구조화된 JSON 요청만 받아야 하는 server-to-server 에이전트에 사용.\n\n주의: 현재 구현은 'required' 키만 검사합니다. 타입 / enum / 범위 / 다른 JSON Schema 구문은 무시됩니다 — 전체 Draft-7 검증이 필요하면 Advanced 에서 자체 검증기 구현을 plug-in 하세요.",
      bestFor: [
        '입력이 항상 알려진 JSON 모양인 API 에이전트 (예: {action, payload})',
        '스키마가 허용 요청의 문서를 겸하는 webhook 수신기',
        'LLM 비용 발생 전 잘못된 body 거부가 critical 한 파이프라인',
      ],
      avoidWhen: [
        '입력이 자유 형식 텍스트일 때 — Schema 는 dict 가 아닌 모든 입력을 거부',
        "실제 type / enum / 범위 검증이 필요할 때 — 이 검증기는 'required' 키 목록만 강제",
      ],
      config: [
        {
          name: 'schema',
          label: 'JSON Schema',
          type: 'object',
          required: true,
          description:
            "strategy_configs.validator.schema 에 저장되는 JSON 객체. 실행기는 schema.required (문자열 리스트) 를 읽고 그 키 중 하나라도 없는 입력을 거부. 다른 JSON Schema 필드 (type, properties, additionalProperties 등) 는 저장은 되지만 현재 강제되지 않습니다.",
        },
      ],
      gotchas: [
        "입력이 dict 가 아니면 'required' 검사 전에 \"Input must be a dictionary for schema validation\" 으로 거부.",
        "최상위 'required' 배열만 참조됩니다. 중첩 스키마, properties, types 는 무시.",
        '스키마 dict 는 configure() / get_config() 로 round-trip 됩니다 — curated Schema textarea 로 설정하면 그 값이 매니페스트에 그대로 보존.',
      ],
      codeRef:
        'geny-executor / s01_input/artifact/default/validators.py:SchemaValidator',
    },
  ],
  relatedSections: [
    {
      label: '정규화기 (이 단계의 다음 슬롯)',
      body: '검증 통과 후 normalizer 가 입력을 NormalizedInput 으로 재작성합니다. validator 는 검사만, normalizer 는 변환을 담당.',
    },
    {
      label: '4단계 — Guard',
      body: '턴 간 검증 (비용 / 반복 / 토큰 예산, 도구 권한 목록) 은 4단계에 둡니다. validator 는 이번 턴의 raw 입력만 보고 파이프라인 state 를 모릅니다.',
    },
    {
      label: '9단계 — Parse',
      body: 'LLM 의 출력 (사용자 입력이 아닌) 을 검증하려면 9단계의 structured_output parser 를 사용하세요. 입력 validator 가 아닙니다.',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/stages/s01_input/artifact/default/validators.py',
};

export const stage01ValidatorHelp: SectionHelpFactory = (locale) =>
  locale === 'ko' ? ko : en;
