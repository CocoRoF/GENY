/** Tool detail — browser_evaluate (Geny / browser family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `browser_evaluate runs arbitrary JavaScript in the context of the currently-loaded page and returns the result. The most powerful (and most permissive) browser tool — anything the browser console can do, this can do.

The script runs as if pasted into devtools — full DOM access, can read state, dispatch events, query selectors, manipulate forms, even inject UI. Returns the value of the last expression / explicit \`return\`. Async results need an \`await\` (or the script returns a Promise the tool resolves).

Three primary patterns:
  1. **Precise data extraction**: \`document.querySelectorAll('.product').length\` — grab structured data the navigate-and-read flow misses.
  2. **State inspection**: read window globals, localStorage, cookies, network state.
  3. **Custom interaction**: trigger events selectors can\'t reach (drag-drop, keyboard shortcuts, custom widget APIs).

Because it\'s arbitrary JS, this is the highest-risk browser tool. Don\'t pass user-controlled strings into the script body without sanitisation — XSS-style injection works inside the browser context just like in a real page.`,
  bestFor: [
    'Extracting structured data from JS-driven pages',
    'Reading state that isn\'t in the DOM (window globals, localStorage)',
    'Custom interactions selectors can\'t express',
  ],
  avoidWhen: [
    'A simpler tool fits — browser_click / browser_fill / browser_page_info should be tried first',
    'You\'re stuffing user-controlled text into the script — sanitisation is required',
    'Long-running scripts — keep them under a few seconds',
  ],
  gotchas: [
    'Returns the LAST expression / `return` value. Forgetting to return what you want gives `undefined`.',
    'Async results need `await` — synchronous-looking code that calls async APIs will return a Promise.',
    'Errors in the script bubble up as tool errors. Wrap risky code in try/catch if you want graceful degradation.',
    'No script-side timeout enforced by the tool. Long loops hang the browser; the host\'s outer timeout will kick in eventually.',
  ],
  examples: [
    {
      caption: 'Count visible products on a search page',
      body: `{
  "script": "return document.querySelectorAll('.product:not(.hidden)').length"
}`,
      note: 'Returns the integer count. Useful precursor to deciding whether to scroll for more.',
    },
  ],
  relatedTools: [
    'browser_navigate',
    'browser_click',
    'browser_fill',
    'browser_page_info',
  ],
  relatedStages: [],
  codeRef:
    'Geny / backend/tools/custom/browser_tools.py:BrowserEvaluateTool',
};

const ko: ToolDetailContent = {
  body: `browser_evaluate는 현재 로드된 페이지 컨텍스트에서 임의 JavaScript 실행하고 결과 반환. 가장 강력한(그리고 가장 permissive한) 브라우저 도구 — 브라우저 콘솔이 할 수 있는 모든 것 가능.

스크립트는 devtools에 paste된 것처럼 실행 — 풀 DOM 액세스, 상태 읽기, 이벤트 dispatch, 셀렉터 쿼리, 폼 조작, UI 주입까지. 마지막 표현식 / 명시적 \`return\`의 값 반환. 비동기 결과는 \`await\` 필요(또는 스크립트가 도구가 resolve할 Promise 반환).

세 주요 패턴:
  1. **정밀 데이터 추출**: \`document.querySelectorAll('.product').length\` — navigate-and-read flow가 놓치는 구조화 데이터 grab.
  2. **상태 검사**: window globals, localStorage, 쿠키, 네트워크 상태 읽기.
  3. **커스텀 상호작용**: 셀렉터로 도달 못 하는 이벤트 트리거(drag-drop, 키보드 shortcut, 커스텀 widget API).

임의 JS이므로 가장 고위험 브라우저 도구. 사용자 컨트롤 문자열을 sanitisation 없이 스크립트 body에 전달 금지 — 브라우저 컨텍스트의 XSS 스타일 injection은 실제 페이지처럼 작동.`,
  bestFor: [
    'JS 주도 페이지에서 구조화 데이터 추출',
    'DOM에 없는 상태 읽기(window globals, localStorage)',
    '셀렉터로 표현 불가한 커스텀 상호작용',
  ],
  avoidWhen: [
    '더 단순한 도구가 적합 — browser_click / browser_fill / browser_page_info 먼저 시도',
    '사용자 컨트롤 텍스트를 스크립트에 넣음 — sanitisation 필수',
    '장기 실행 스크립트 — 몇 초 미만 유지',
  ],
  gotchas: [
    '마지막 표현식 / `return` 값 반환. 원하는 것 return 잊으면 `undefined`.',
    '비동기 결과는 `await` 필요 — 비동기 API 호출하는 동기처럼 보이는 코드는 Promise 반환.',
    '스크립트 에러가 도구 에러로 bubble up. graceful degradation 원하면 위험 코드 try/catch wrap.',
    '도구가 강제하는 스크립트 측 timeout 없음. 긴 루프는 브라우저 hang; 호스트의 outer timeout이 결국 kick in.',
  ],
  examples: [
    {
      caption: '검색 페이지의 보이는 product 카운트',
      body: `{
  "script": "return document.querySelectorAll('.product:not(.hidden)').length"
}`,
      note: '정수 카운트 반환. 더 스크롤할지 결정 전 유용한 precursor.',
    },
  ],
  relatedTools: [
    'browser_navigate',
    'browser_click',
    'browser_fill',
    'browser_page_info',
  ],
  relatedStages: [],
  codeRef:
    'Geny / backend/tools/custom/browser_tools.py:BrowserEvaluateTool',
};

export const browserEvaluateToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
