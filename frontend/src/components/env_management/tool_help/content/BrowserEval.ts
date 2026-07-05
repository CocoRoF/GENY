/** Tool detail — BrowserEval (geny-executor / browser family, an-web engine). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `BrowserEval evaluates a JavaScript expression in the current page's V8 context and returns the JSON-serialized result. The page's own scripts have already run; document and window are available.

It is the escape hatch when the semantic tools don't reach something — computed values, window globals set by the app, or DOM states with no clean selector. Prefer BrowserExtract for plain data extraction.`,
  bestFor: [
    'Reading app globals (window.__STATE__, dataLayer, …)',
    'Computed or derived values the DOM does not show as text',
    'One-off DOM queries too awkward for a CSS selector',
  ],
  avoidWhen: [
    'Plain text/attribute extraction — BrowserExtract is safer and cheaper',
    'Clicking/typing — BrowserAct fires proper events',
  ],
  gotchas: [
    'Errors if no page is open — call BrowserNavigate first.',
    'Runs inside the engine V8 with a CPU budget — infinite loops get killed.',
    'The result must be JSON-serializable; DOM nodes come back as strings.',
  ],
  examples: [
    {
      caption: 'Read an app global',
      body: `{"script": "window.__INITIAL_STATE__.user.id"}`,
      note: 'Returns the value JSON-serialized.',
    },
    {
      caption: 'Count matching nodes',
      body: `{"script": "document.querySelectorAll('.item').length"}`,
      note: 'Any expression works; the last value is returned.',
    },
  ],
  relatedTools: ['BrowserExtract', 'BrowserAct', 'BrowserSnapshot'],
  relatedStages: [],
  codeRef:
    'geny-executor / tools/built_in/browser_tools.py:BrowserEvalTool',
};

const ko: ToolDetailContent = {
  body: `BrowserEval은 현재 페이지의 V8 컨텍스트에서 JavaScript 표현식을 평가하고 JSON 직렬화된 결과를 반환합니다. 페이지 자체 스크립트는 이미 실행된 상태이며 document와 window를 사용할 수 있습니다.

시맨틱 도구가 닿지 않는 곳 — 계산된 값, 앱이 설정한 window 전역, 깔끔한 셀렉터가 없는 DOM 상태 — 을 위한 탈출구입니다. 단순 데이터 추출은 BrowserExtract를 우선하세요.`,
  bestFor: [
    '앱 전역 읽기(window.__STATE__, dataLayer, …)',
    'DOM에 텍스트로 드러나지 않는 계산/파생 값',
    'CSS 셀렉터로 표현하기 어려운 일회성 DOM 질의',
  ],
  avoidWhen: [
    '단순 텍스트/속성 추출 — BrowserExtract가 더 안전하고 저렴',
    '클릭/입력 — BrowserAct가 이벤트를 제대로 발화',
  ],
  gotchas: [
    '열린 페이지가 없으면 에러 — 먼저 BrowserNavigate 호출.',
    '엔진 V8의 CPU 예산 안에서 실행 — 무한 루프는 강제 종료됨.',
    '결과는 JSON 직렬화 가능해야 함; DOM 노드는 문자열로 반환.',
  ],
  examples: [
    {
      caption: '앱 전역 읽기',
      body: `{"script": "window.__INITIAL_STATE__.user.id"}`,
      note: '값을 JSON 직렬화해 반환.',
    },
    {
      caption: '매치 노드 개수 세기',
      body: `{"script": "document.querySelectorAll('.item').length"}`,
      note: '임의 표현식 가능; 마지막 값이 반환됨.',
    },
  ],
  relatedTools: ['BrowserExtract', 'BrowserAct', 'BrowserSnapshot'],
  relatedStages: [],
  codeRef:
    'geny-executor / tools/built_in/browser_tools.py:BrowserEvalTool',
};

export const browserEvalToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
