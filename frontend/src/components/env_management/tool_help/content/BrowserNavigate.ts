/** Tool detail — browser_navigate (Geny / browser family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `browser_navigate launches (or reuses) a real Playwright-managed browser, navigates to a URL, and returns the rendered page content — fully JS-executed, post-hydration. The first call in a session boots the browser; subsequent calls reuse it, so navigation between pages is fast.

Different from WebFetch: WebFetch is server-side HTTP, can\'t run JavaScript, returns the raw HTTP response stripped of scripts. browser_navigate runs a headless Chrome that hydrates SPAs, executes inline scripts, fires events. Use it for any modern web app or async-loaded content.

Returns:
  - rendered HTML / text content of the page
  - the final URL after redirects
  - basic interactive-element catalogue (links, buttons, form fields) — useful precursor to browser_click / browser_fill

Persistent browser session: cookies, localStorage, and login state survive between calls. The agent can browser_navigate to a login page, browser_fill credentials, browser_click submit, then browser_navigate to a protected page — the session carries the auth state.

Headless by default. Some host configs allow head-on for debugging; production defaults to headless to save resources.`,
  bestFor: [
    'JS-rendered SPAs that WebFetch can\'t see',
    'Multi-step browse flows where session state matters (login → action)',
    'Pre-flight before browser_click / browser_fill / browser_evaluate',
  ],
  avoidWhen: [
    'Static HTML / JSON — WebFetch is faster and cheaper',
    'You only need search results — WebSearch',
    'Rate-sensitive scraping at scale — Playwright is heavy; consider an HTTP-level pipeline',
  ],
  gotchas: [
    'First call boots the browser (slow, ~2-5s). Subsequent calls fast.',
    'Cookies / session persist across calls — by design, but means stale state can confuse later turns. browser_close to reset.',
    'Page content is the post-hydration snapshot. Some pages render content asynchronously — repeat navigation or wait via browser_evaluate if content seems incomplete.',
    'Headless detection: some sites refuse headless Chrome. The host may need to expose a non-headless mode for those sites.',
  ],
  examples: [
    {
      caption: 'Navigate to a JS-rendered page',
      body: `{
  "url": "https://app.example.com/dashboard"
}`,
      note: 'Returns rendered content + interactive elements. Browser session stays open for follow-ups.',
    },
  ],
  relatedTools: [
    'browser_click',
    'browser_fill',
    'browser_evaluate',
    'browser_screenshot',
    'browser_page_info',
    'browser_close',
    'WebFetch',
  ],
  relatedStages: [],
  codeRef:
    'Geny / backend/tools/custom/browser_tools.py:BrowserNavigateTool',
};

const ko: ToolDetailContent = {
  body: `browser_navigate는 실제 Playwright 관리 브라우저를 launch(또는 재사용), URL로 navigate, 렌더링된 페이지 콘텐츠 반환 — 풀 JS 실행, post-hydration. 세션의 첫 호출이 브라우저 부팅; 후속 호출이 재사용 — 페이지 간 navigation 빠름.

WebFetch와 다름: WebFetch는 서버 측 HTTP, JavaScript 실행 불가, scripts 제거된 raw HTTP 응답 반환. browser_navigate는 SPA 하이드레이트, 인라인 스크립트 실행, 이벤트 발화하는 headless Chrome 실행. 모든 모던 웹 앱이나 비동기 로드 콘텐츠에 사용.

반환:
  - 페이지의 렌더링된 HTML / 텍스트 콘텐츠
  - 리다이렉트 후 최종 URL
  - 기본 상호작용 요소 카탈로그(링크, 버튼, 폼 필드) — browser_click / browser_fill의 유용한 precursor

영속 브라우저 세션: 쿠키, localStorage, 로그인 상태가 호출 간 살아남음. 에이전트가 로그인 페이지로 browser_navigate, 자격증명 browser_fill, submit browser_click, 보호된 페이지로 browser_navigate — 세션이 auth 상태 carry.

기본 headless. 일부 호스트 설정은 디버깅 위해 head-on 허용; 운영은 리소스 절약 위해 headless 기본.`,
  bestFor: [
    'WebFetch가 못 보는 JS 렌더링 SPA',
    '세션 상태 중요한 멀티스텝 브라우즈 flow(로그인 → 액션)',
    'browser_click / browser_fill / browser_evaluate 전 사전 확인',
  ],
  avoidWhen: [
    '정적 HTML / JSON — WebFetch가 더 빠르고 저렴',
    '검색 결과만 필요 — WebSearch',
    '대규모 rate-sensitive 스크래핑 — Playwright 무거움; HTTP 레벨 파이프라인 검토',
  ],
  gotchas: [
    '첫 호출이 브라우저 부팅(느림, ~2-5초). 후속 호출 빠름.',
    '쿠키 / 세션이 호출 간 영속 — 설계상이지만 stale 상태가 나중 턴 혼란 가능. 리셋은 browser_close.',
    '페이지 콘텐츠는 post-hydration 스냅샷. 일부 페이지는 비동기 렌더 — 콘텐츠 불완전해 보이면 navigation 반복 또는 browser_evaluate로 wait.',
    'Headless 감지: 일부 사이트가 headless Chrome 거부. 호스트가 그런 사이트용 non-headless 모드 노출 필요할 수 있음.',
  ],
  examples: [
    {
      caption: 'JS 렌더링 페이지로 navigate',
      body: `{
  "url": "https://app.example.com/dashboard"
}`,
      note: '렌더링된 콘텐츠 + 상호작용 요소 반환. 브라우저 세션이 follow-up용으로 열려 있음.',
    },
  ],
  relatedTools: [
    'browser_click',
    'browser_fill',
    'browser_evaluate',
    'browser_screenshot',
    'browser_page_info',
    'browser_close',
    'WebFetch',
  ],
  relatedStages: [],
  codeRef:
    'Geny / backend/tools/custom/browser_tools.py:BrowserNavigateTool',
};

export const browserNavigateToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
