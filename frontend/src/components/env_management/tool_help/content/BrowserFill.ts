/** Tool detail — browser_fill (Geny / browser family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `browser_fill types text into a form field — \`<input>\`, \`<textarea>\`, \`contenteditable\` elements. The browser focuses the element, clears existing content, and types the value as if a user typed it (one character at a time, dispatching real keyboard events).

The "as if typed" model matters: pages with input listeners, validators, autocomplete, debounced search-as-you-type get the same events real users trigger. Pasting via JavaScript would skip those listeners; browser_fill is more faithful.

Sequencing matters in multi-field flows:
  1. browser_fill the first field
  2. browser_fill subsequent fields (or Tab between them)
  3. browser_click the submit button

For sensitive content (passwords): browser_fill\'s value is logged in audit unless the host masks it. Most production deployments mask password fields automatically based on \`<input type="password">\`, but verify before trusting.`,
  bestFor: [
    'Filling form inputs with credentials, search queries, configuration values',
    'Typing into rich-text editors that listen for keystrokes',
    'Multi-step forms where each field affects what becomes visible next',
  ],
  avoidWhen: [
    'You can pass the data via URL params — skip the form entirely',
    'The field is not actually an input (some custom widgets need browser_evaluate)',
    'Bulk data — typing 10000 chars char-by-char is slow; consider an API instead',
  ],
  gotchas: [
    'Existing content is CLEARED before typing. Pass empty string to just clear.',
    'Real keyboard events fire — debounced listeners trigger appropriately, but at typing speed.',
    'Hidden fields fail silently in some host configs — the type event dispatches but the field doesn\'t accept it.',
    'Password fields: value may be audited unless masked. Verify host config before filling secrets.',
  ],
  examples: [
    {
      caption: 'Fill in a search box',
      body: `{
  "selector": "input[name=q]",
  "value": "anthropic claude code"
}`,
      note: 'Existing content cleared, new value typed character-by-character. Search-as-you-type fires correctly.',
    },
  ],
  relatedTools: [
    'browser_click',
    'browser_navigate',
    'browser_evaluate',
    'browser_page_info',
  ],
  relatedStages: [],
  codeRef:
    'Geny / backend/tools/custom/browser_tools.py:BrowserFillTool',
};

const ko: ToolDetailContent = {
  body: `browser_fill은 폼 필드에 텍스트 입력 — \`<input>\`, \`<textarea>\`, \`contenteditable\` 요소. 브라우저가 요소에 포커스, 기존 콘텐츠 clear, 사용자가 친 것처럼 값 입력(한 글자씩, 실제 키보드 이벤트 dispatch).

"입력한 것처럼" 모델 중요: input listener, validator, autocomplete, debounced search-as-you-type 페이지가 실제 사용자가 트리거하는 같은 이벤트 받음. JavaScript로 paste는 그런 listener 우회; browser_fill이 더 충실.

멀티 필드 flow에서 순서 중요:
  1. 첫 필드 browser_fill
  2. 후속 필드 browser_fill(또는 Tab으로 이동)
  3. submit 버튼 browser_click

민감 콘텐츠(비밀번호): 호스트가 마스킹 안 하면 browser_fill 값이 audit에 로깅. 대부분 운영 배포가 \`<input type="password">\` 기반 자동 마스킹하지만, 신뢰 전 검증.`,
  bestFor: [
    '자격증명, 검색 쿼리, 설정 값으로 폼 input 채우기',
    '키 입력 listening하는 rich-text 에디터에 typing',
    '각 필드가 다음 보이는 것에 영향 주는 멀티스텝 폼',
  ],
  avoidWhen: [
    'URL 파라미터로 데이터 전달 가능 — 폼 완전히 skip',
    '필드가 실제로 input 아님(일부 커스텀 widget은 browser_evaluate 필요)',
    '벌크 데이터 — 10000자 char-by-char typing 느림; API 검토',
  ],
  gotchas: [
    '기존 콘텐츠가 typing 전 CLEARED. 그냥 clear는 빈 문자열 전달.',
    '실제 키보드 이벤트 발화 — debounced listener 적절히 트리거, 단 typing 속도로.',
    '숨겨진 필드는 일부 호스트 설정에서 silent하게 실패 — type 이벤트 dispatch되지만 필드가 수락 안 함.',
    '비밀번호 필드: 마스킹 안 되면 값 audit될 수 있음. 비밀 채우기 전 호스트 설정 검증.',
  ],
  examples: [
    {
      caption: '검색 박스 채우기',
      body: `{
  "selector": "input[name=q]",
  "value": "anthropic claude code"
}`,
      note: '기존 콘텐츠 cleared, 새 값 char-by-char typing. Search-as-you-type 정확히 발화.',
    },
  ],
  relatedTools: [
    'browser_click',
    'browser_navigate',
    'browser_evaluate',
    'browser_page_info',
  ],
  relatedStages: [],
  codeRef:
    'Geny / backend/tools/custom/browser_tools.py:BrowserFillTool',
};

export const browserFillToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
