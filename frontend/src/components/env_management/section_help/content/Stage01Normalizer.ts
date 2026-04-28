/**
 * Help content for Stage 1 → Normalizer slot.
 *
 * Source of truth: geny-executor /
 *   src/geny_executor/stages/s01_input/artifact/default/normalizers.py
 *   src/geny_executor/stages/s01_input/types.py (NormalizedInput)
 *
 * Markup convention (Prose / InlineMarkup):
 *   `code`     → mono pill
 *   **bold**   → semibold
 *   blank line → paragraph break
 *   "- " prefix → bullet (consecutive lines fold into one list)
 */

import type { SectionHelpContent, SectionHelpFactory } from '../types';

const en: SectionHelpContent = {
  title: 'Normalizer',
  summary:
    "Rewrites the validated raw input into `NormalizedInput` — the canonical shape the rest of the pipeline expects. Strips whitespace, applies Unicode NFC, and (for multimodal payloads) translates attachments into Anthropic content blocks.",
  whatItDoes: `**Stage 1's pipeline is** \`validate → normalize → state.add_message\`. Once the validator says "OK", the normalizer's job is to coerce whatever shape the host passed into one consistent record.

**Inputs the normalizer accepts:**

- a plain string
- a dict with \`text\` or \`content\` keys
- a dict with \`images\` / \`files\` / \`attachments\` keys (multimodal)
- an already-built \`NormalizedInput\`

**Output:** a \`NormalizedInput\` object holding \`text\`, \`images\` (Anthropic blocks), \`files\`, \`metadata\`, \`session_id\`, and \`raw_input\` (kept for diagnostics). Stage 1 then calls \`state.add_message("user", normalized.to_message_content())\` — that final method flattens text + image blocks into the message-content shape Stage 6 will eventually send to the LLM.

**Which normalizer to pick** decides what shape attachments end up in. The default is multimodal-aware: if it sees \`images\` / \`files\` / \`attachments\` keys, it transparently delegates to Multimodal. So most agents never have to switch — the default Just Works for both pure-text and image-bearing turns.`,
  options: [
    {
      id: 'default',
      label: 'Default (text-first, multimodal-aware)',
      description: `Standard trim + Unicode NFC normalization, with **automatic delegation** to Multimodal when attachments are present.

**Text-only path:**

- strip whitespace
- \`unicodedata.normalize("NFC", text)\`
- wrap in \`NormalizedInput\`

**Dict path with no attachments:**

- pull \`dict["text"]\` (or \`dict["content"]\`) as the text field
- preserve \`dict["metadata"]\` if present

**Dict path with attachments:** auto-delegate to \`MultimodalNormalizer\` (see below).

This is what every default-manifest preset (vtuber / worker_adaptive / worker_easy) ships with — and it covers ~95% of real agents.`,
      bestFor: [
        'Pure text chat agents — the trim + NFC behaviour matches user expectations',
        'Agents that may receive attachments occasionally — auto-delegation means no per-turn switching',
        'New pipelines — start here and only change if you have a specific reason',
      ],
      avoidWhen: [
        'You explicitly want attachments rejected — pick a custom normalizer or filter at the host before Stage 1',
      ],
      gotchas: [
        '**NFC normalization changes characters.** `"café"` (decomposed: `c + a + f + e + ´`) becomes `"café"` (precomposed: `c + a + f + é`). This is what most systems want — string equality with Korean / Japanese / accented input works correctly — but the input you stored may differ byte-for-byte from what the user typed.',
        'A dict input *without* `text` / `content` keys ends up with `text=""`. Most stages then act as if the user sent an empty turn — make sure your host wraps user input under one of those two keys.',
      ],
      codeRef:
        'geny-executor / s01_input/artifact/default/normalizers.py:DefaultNormalizer',
    },
    {
      id: 'multimodal',
      label: 'Multimodal (text + images + files)',
      description: `Same trim behaviour as Default, plus full attachment handling. All shapes are converted into **Anthropic content blocks** before storage.

**Accepted attachment shapes:**

- Anthropic-canonical: \`{"type": "image", "source": {"type": "base64"|"url", ...}}\` — passed through unchanged
- Lenient client form (Geny backend / executor-web HTTP layer): \`{"kind": "image", "mime_type": "image/png", "data": "<b64>"}\` or with \`url\` instead of \`data\`
- Legacy short form: \`{"media_type": "image/png", "base64": "..."}\`

**Local file inlining.** URLs that look like \`file://\` URIs or absolute filesystem paths are read from disk and inlined as base64. Anthropic rejects non-HTTPS URLs, so this avoids vendor errors at translation time.

**File attachments** (PDFs, etc.) currently get a stub \`{"type": "file", ...}\` block — full document support is a TODO at the executor level.

**Note:** Default already auto-delegates here when attachments are present. Picking Multimodal explicitly is mostly redundant, but useful when you want catalog introspection to surface "multimodal" as the active normalizer for documentation / audit purposes.`,
      bestFor: [
        'Agents whose host always sends multimodal payloads (declarative clarity over relying on auto-delegation)',
        'Pipelines where catalog introspection should surface `multimodal` as the active normalizer (documentation / audit)',
      ],
      avoidWhen: [
        'You can rely on Default to delegate — picking Multimodal explicitly is a no-op for most agents',
      ],
      gotchas: [
        '**No length / size validation on attachments.** A 10 MB image is base64-encoded and stored verbatim in `state.messages` — Stage 6 will then ship it to the LLM. Large multimodal payloads can blow the context window.',
        '`file://` URIs and absolute paths are inlined transparently. Convenient locally, but the host must trust the path source — symlink attacks could exfiltrate file contents.',
        'PDF / file attachments get a stub `{"type": "file", ...}` block today. PDF text extraction / OCR is a TODO.',
        '**NFC is NOT applied** to multimodal text — only to text in the Default path. Known asymmetry; future executor versions may unify it.',
      ],
      codeRef:
        'geny-executor / s01_input/artifact/default/normalizers.py:MultimodalNormalizer',
    },
  ],
  relatedSections: [
    {
      label: 'Validator (previous slot in this stage)',
      body: 'The validator runs first and decides whether normalization happens at all. The normalizer trusts that the input is acceptable.',
    },
    {
      label: 'Stage 2 — Context',
      body: 'Stage 2 reads back the user message that Stage 1 just appended via `state.add_message`. Whatever shape the normalizer wrote is what Stage 2 sees.',
    },
    {
      label: 'Stage 6 — API',
      body: "Stage 6 (or whatever LLM stage you're using) eventually translates the message content blocks into the vendor-specific request format. Anthropic blocks pass through cleanly; OpenAI / Google translators handle the format conversion.",
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/stages/s01_input/artifact/default/normalizers.py',
};

const ko: SectionHelpContent = {
  title: '정규화기 (Normalizer)',
  summary:
    '검증된 raw 입력을 `NormalizedInput` — 파이프라인 나머지가 기대하는 표준 모양 — 으로 재작성합니다. 공백 제거, Unicode NFC 적용, (멀티모달 페이로드의 경우) 첨부 파일을 Anthropic content block 으로 변환.',
  whatItDoes: `**1단계의 파이프라인은** \`validate → normalize → state.add_message\`. 검증기가 "OK" 라고 하면, normalizer 의 일은 호스트가 전달한 어떤 모양도 일관된 레코드 하나로 강제 변환하는 것.

**Normalizer 가 받는 입력:**

- 평범한 문자열
- \`text\` 또는 \`content\` 키가 있는 dict
- \`images\` / \`files\` / \`attachments\` 키가 있는 dict (멀티모달)
- 이미 만들어진 \`NormalizedInput\`

**출력:** \`text\`, \`images\` (Anthropic 블록), \`files\`, \`metadata\`, \`session_id\`, \`raw_input\` (진단용 원본) 을 보관하는 \`NormalizedInput\` 객체. 1단계는 이후 \`state.add_message("user", normalized.to_message_content())\` 를 호출 — 그 메서드가 text + image 블록을 6단계가 LLM 에 보낼 message-content 모양으로 평탄화합니다.

**어떤 normalizer 를 선택하느냐**가 첨부 파일이 어떤 모양으로 끝나는지 결정합니다. 기본값은 멀티모달 인식: \`images\` / \`files\` / \`attachments\` 키가 보이면 Multimodal 에 투명하게 위임. 그래서 대부분의 에이전트는 전환할 필요가 없음 — 기본값이 순수 텍스트와 이미지 포함 턴 둘 다 그냥 작동합니다.`,
  options: [
    {
      id: 'default',
      label: '기본 (Default — 텍스트 우선, 멀티모달 인식)',
      description: `표준 trim + Unicode NFC 정규화 + 첨부가 있을 때 Multimodal 에 **자동 위임**.

**텍스트 전용 경로:**

- 공백 제거
- \`unicodedata.normalize("NFC", text)\`
- \`NormalizedInput\` 으로 wrap

**첨부 없는 dict 경로:**

- \`dict["text"]\` (또는 \`dict["content"]\`) 를 text 필드로
- \`dict["metadata"]\` 가 있으면 보존

**첨부 있는 dict 경로:** \`MultimodalNormalizer\` 에 자동 위임 (아래 참조).

모든 default-manifest preset (vtuber / worker_adaptive / worker_easy) 이 이 옵션과 함께 출하되며 — 실제 에이전트의 ~95% 를 커버합니다.`,
      bestFor: [
        '순수 텍스트 채팅 에이전트 — trim + NFC 동작이 사용자 기대와 일치',
        '가끔 첨부를 받을 수 있는 에이전트 — 자동 위임 덕에 매 턴 normalizer 를 전환할 필요 없음',
        '새 파이프라인 — 여기서 시작하고 특별한 이유가 있을 때만 변경',
      ],
      avoidWhen: [
        '첨부를 명시적으로 거부하고 싶을 때 — 1단계 전에 호스트에서 필터링하거나 커스텀 normalizer 를 작성',
      ],
      gotchas: [
        '**NFC 정규화는 문자를 바꿉니다.** `"café"` (분해: `c + a + f + e + ´`) 는 `"café"` (결합: `c + a + f + é`) 로 됩니다. 대부분의 시스템이 원하는 동작 — 한국어 / 일본어 / 악센트 입력에서 문자열 동등성이 올바르게 작동 — 이지만, 저장된 입력이 사용자가 입력한 것과 바이트 단위로 다를 수 있습니다.',
        '`text` / `content` 키 없는 dict 입력은 `text=""` 가 됩니다. 그러면 대부분의 단계가 빈 턴으로 행동합니다 — 호스트가 사용자 입력을 그 두 키 중 하나로 wrap 하는지 확인하세요.',
      ],
      codeRef:
        'geny-executor / s01_input/artifact/default/normalizers.py:DefaultNormalizer',
    },
    {
      id: 'multimodal',
      label: '멀티모달 (Multimodal — 텍스트 + 이미지 + 파일)',
      description: `Default 와 동일한 trim 동작 + 완전한 첨부 처리. 모든 모양을 저장 전 **Anthropic content block** 으로 변환합니다.

**수용되는 첨부 모양:**

- Anthropic-canonical: \`{"type": "image", "source": {"type": "base64"|"url", ...}}\` — 변경 없이 그대로
- lenient client 형태 (Geny 백엔드 / executor-web HTTP 레이어): \`{"kind": "image", "mime_type": "image/png", "data": "<b64>"}\` 또는 \`data\` 대신 \`url\`
- 레거시 short 형태: \`{"media_type": "image/png", "base64": "..."}\`

**로컬 파일 inlining.** \`file://\` URI 처럼 보이거나 절대 파일시스템 경로인 URL 은 디스크에서 읽어 base64 로 인라인. Anthropic 이 non-HTTPS URL 을 거부하므로, vendor 변환 시점의 에러를 회피합니다.

**파일 첨부** (PDF 등) 는 현재 \`{"type": "file", ...}\` 스텁 블록을 받습니다 — 완전한 document 지원은 실행기 레벨 TODO.

**참고:** Default 가 첨부가 있을 때 자동으로 여기 위임하므로, Multimodal 을 명시적으로 선택하는 것은 대부분 중복입니다. 다만 카탈로그 introspection 이 활성 normalizer 로 "multimodal" 을 표면화해야 할 때 (문서화 / 감사) 유용.`,
      bestFor: [
        '호스트가 항상 멀티모달 페이로드를 보내는 에이전트 (자동 위임에 의존하기보다 선언적 명확성)',
        '카탈로그 introspection 이 활성 normalizer 로 `multimodal` 을 표면화해야 하는 파이프라인 (문서화 / 감사)',
      ],
      avoidWhen: [
        'Default 의 위임에 의존할 수 있을 때 — 대부분 에이전트에 명시적 Multimodal 선택은 no-op',
      ],
      gotchas: [
        '**첨부에 길이 / 크기 검증 없음.** 10 MB 이미지는 base64 로 인코딩되어 그대로 `state.messages` 에 저장 — 6단계가 그것을 LLM 에 보냅니다. 큰 멀티모달 페이로드는 컨텍스트 윈도우를 날릴 수 있습니다.',
        '`file://` URI 와 절대 경로는 base64 로 투명하게 인라인. 로컬에서는 편리하지만 호스트가 경로 출처를 신뢰해야 합니다 — symlink 공격이 파일 내용을 유출시킬 수 있음.',
        'PDF / 파일 첨부는 오늘 `{"type": "file", ...}` 스텁 블록만 받습니다. PDF 텍스트 추출 / OCR 은 TODO.',
        '**NFC 가 멀티모달 텍스트에는 적용되지 않음** — Default 경로의 텍스트에만. 알려진 비대칭이며 향후 실행기 버전이 통일할 수 있습니다.',
      ],
      codeRef:
        'geny-executor / s01_input/artifact/default/normalizers.py:MultimodalNormalizer',
    },
  ],
  relatedSections: [
    {
      label: '검증기 (이 단계의 이전 슬롯)',
      body: '검증기가 먼저 실행되어 정규화가 일어날지 자체를 결정합니다. normalizer 는 입력이 수용 가능하다고 가정.',
    },
    {
      label: '2단계 — Context',
      body: '2단계는 1단계가 `state.add_message` 로 추가한 사용자 메시지를 다시 읽습니다. normalizer 가 쓴 모양이 그대로 2단계가 보는 것.',
    },
    {
      label: '6단계 — API',
      body: '6단계 (혹은 사용 중인 LLM 단계) 가 결국 message content block 을 vendor-specific 요청 형식으로 변환합니다. Anthropic 블록은 그대로 통과; OpenAI / Google translator 가 형식 변환을 처리.',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/stages/s01_input/artifact/default/normalizers.py',
};

export const stage01NormalizerHelp: SectionHelpFactory = (locale) =>
  locale === 'ko' ? ko : en;
