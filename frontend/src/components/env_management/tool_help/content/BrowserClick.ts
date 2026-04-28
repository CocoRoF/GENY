/** Tool detail — browser_click (Geny / browser family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `browser_click clicks an element on the currently-loaded browser page. Pass a CSS selector; the browser locates the matching element, scrolls it into view, and dispatches a click event. Used after browser_navigate to interact with buttons, links, accordions, dropdowns — anything reactive to a click.

The browser session must already have a page loaded; calling browser_click before any browser_navigate errors. The selector targets the FIRST matching element when multiple match — use a more specific selector if the page has duplicates.

Reaction depends on the page:
  - A link click navigates to the target URL (page state updates)
  - A button click triggers form submit / API call / DOM mutation
  - An expanding panel reveals new content the agent then re-reads

Returns the page state after the click — basic info on the new URL (if changed) and a refreshed interactive-element catalogue.

Click events are real DOM events — onclick handlers fire, JavaScript runs, side effects happen. This isn\'t simulated; the browser actually executes whatever the click triggers.`,
  bestFor: [
    'Submitting forms after browser_fill',
    'Expanding accordions / showing hidden content',
    'Triggering JS-driven flows (open modal, refresh data)',
  ],
  avoidWhen: [
    'No page loaded — call browser_navigate first',
    'You can navigate via URL directly — skip the click and browser_navigate',
    'Selector matches many elements unintentionally — refine the selector',
  ],
  gotchas: [
    'First-match-wins for ambiguous selectors. Test specificity in browser_evaluate before clicking destructive buttons.',
    'Real side effects fire (form submission, payment, etc.). Be deliberate about what gets clicked.',
    'Some elements need scroll-into-view; the browser handles that, but extremely lazy-loaded items may not be in the DOM yet.',
    'JavaScript-disabled clicks (`pointer-events: none`) behave differently — the click may register without effect.',
  ],
  examples: [
    {
      caption: 'Click the submit button',
      body: `{
  "selector": "button[type=submit]"
}`,
      note: 'Dispatches a real click event on the first matching button. Form submits, page state updates.',
    },
  ],
  relatedTools: [
    'browser_navigate',
    'browser_fill',
    'browser_evaluate',
    'browser_page_info',
  ],
  relatedStages: [],
  codeRef:
    'Geny / backend/tools/custom/browser_tools.py:BrowserClickTool',
};

const ko: ToolDetailContent = {
  body: `browser_click은 현재 로드된 브라우저 페이지의 요소 클릭. CSS 셀렉터 전달; 브라우저가 매칭 요소 찾고 view에 스크롤, 클릭 이벤트 dispatch. browser_navigate 후 버튼, 링크, accordion, dropdown — 클릭에 reactive한 모든 것 — 상호작용에 사용.

브라우저 세션에 페이지 이미 로드되어 있어야; browser_navigate 전 browser_click 호출은 에러. 셀렉터는 여러 매칭 시 첫 번째 매칭 요소 타겟 — 페이지에 중복 있으면 더 구체적 셀렉터 사용.

페이지에 따른 반응:
  - 링크 클릭은 타겟 URL로 navigate(페이지 상태 업데이트)
  - 버튼 클릭은 form submit / API 호출 / DOM mutation 트리거
  - 확장 패널은 에이전트가 다시 읽는 새 콘텐츠 노출

클릭 후 페이지 상태 반환 — 새 URL(변경 시)에 대한 기본 정보와 새로 고쳐진 상호작용 요소 카탈로그.

클릭 이벤트는 실제 DOM 이벤트 — onclick 핸들러 발화, JavaScript 실행, 사이드이펙트 발생. 시뮬레이션 아님; 브라우저가 실제로 클릭이 트리거하는 것 실행.`,
  bestFor: [
    'browser_fill 후 form submit',
    'accordion 확장 / 숨겨진 콘텐츠 표시',
    'JS 주도 flow 트리거(모달 열기, 데이터 새로고침)',
  ],
  avoidWhen: [
    '페이지 로드 안 됨 — 먼저 browser_navigate',
    'URL로 직접 navigate 가능 — 클릭 skip하고 browser_navigate',
    '셀렉터가 의도하지 않게 많은 요소 매칭 — 셀렉터 정제',
  ],
  gotchas: [
    '모호한 셀렉터는 first-match-wins. destructive 버튼 클릭 전 browser_evaluate로 specificity 테스트.',
    '실제 사이드이펙트 발화(form 제출, 결제 등). 클릭하는 것 deliberate.',
    '일부 요소는 scroll-into-view 필요; 브라우저가 처리하지만 극도로 lazy-loaded 아이템은 아직 DOM에 없을 수 있음.',
    'JavaScript-disabled 클릭(`pointer-events: none`)은 다르게 동작 — 클릭은 register되지만 효과 없음.',
  ],
  examples: [
    {
      caption: 'submit 버튼 클릭',
      body: `{
  "selector": "button[type=submit]"
}`,
      note: '첫 매칭 버튼에 실제 클릭 이벤트 dispatch. Form 제출, 페이지 상태 업데이트.',
    },
  ],
  relatedTools: [
    'browser_navigate',
    'browser_fill',
    'browser_evaluate',
    'browser_page_info',
  ],
  relatedStages: [],
  codeRef:
    'Geny / backend/tools/custom/browser_tools.py:BrowserClickTool',
};

export const browserClickToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
