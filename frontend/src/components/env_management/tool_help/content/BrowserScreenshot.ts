/** Tool detail — browser_screenshot (Geny / browser family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `browser_screenshot captures the current browser viewport (or a specific element) as a PNG image. Returns image content the LLM can render directly — useful when the agent needs to "see" what the user sees, or when the visual matters more than the DOM (charts, layout issues, design review).

Two scopes:
  - Default: viewport-only screenshot (what would fit on the user\'s screen)
  - \`fullPage: true\`: capture the entire scrollable height
  - \`selector: "..."\`: capture a single element\'s bounding box (e.g., a chart card)

The screenshot reflects the current rendered state — animations may be mid-frame, lazy content may not have loaded yet. browser_evaluate \`await new Promise(r => setTimeout(r, 500))\` before screenshotting can help when content is racing.

Image content blocks are large (typically 200KB-2MB encoded) — generous use of screenshots inflates the conversation and ages the prompt cache. Prefer browser_page_info or browser_evaluate when text-level data is enough.`,
  bestFor: [
    'Visual debugging ("what does the page actually look like?")',
    'Capturing charts / images / design renders for the user',
    'Pre/post screenshots around an interaction (before browser_click, after)',
  ],
  avoidWhen: [
    'Text-level data is enough — browser_page_info or browser_evaluate',
    'You\'re scraping at scale — screenshots eat tokens',
    'The page is animated — captures may be mid-frame',
  ],
  gotchas: [
    'Large encoded payloads. Don\'t batch many screenshots in one turn.',
    'Animated content captures mid-frame. Wait via browser_evaluate setTimeout if needed.',
    'Element-mode (`selector`) requires the element to be visible — off-screen elements still capture but at their actual position, possibly returning a zero-pixel image.',
    'Some sites disable canvas-style screenshot via CSP or specific anti-screenshot scripts; in those cases the result may be partial or blank.',
  ],
  examples: [
    {
      caption: 'Capture a specific chart on a dashboard',
      body: `{
  "selector": "#metrics-chart"
}`,
      note: 'Returns a PNG image block of just the chart, not the whole viewport.',
    },
  ],
  relatedTools: [
    'browser_navigate',
    'browser_page_info',
    'browser_evaluate',
  ],
  relatedStages: [],
  codeRef:
    'Geny / backend/tools/custom/browser_tools.py:BrowserScreenshotTool',
};

const ko: ToolDetailContent = {
  body: `browser_screenshot는 현재 브라우저 뷰포트(또는 특정 요소)를 PNG 이미지로 캡처합니다. LLM이 직접 렌더링할 수 있는 이미지 콘텐츠 반환 — 에이전트가 사용자가 보는 것을 "봐야" 할 때, 또는 DOM보다 시각이 더 중요할 때(차트, 레이아웃 이슈, 디자인 리뷰) 유용.

두 스코프:
  - 기본: 뷰포트만 스크린샷(사용자 화면에 fit하는 것)
  - \`fullPage: true\`: 전체 스크롤 가능 높이 캡처
  - \`selector: "..."\`: 단일 요소의 bounding box 캡처(예: 차트 카드)

스크린샷은 현재 렌더링 상태 반영 — 애니메이션 mid-frame일 수 있고, lazy 콘텐츠 아직 로드 안 됐을 수 있음. 콘텐츠 race 시 스크린샷 전 browser_evaluate \`await new Promise(r => setTimeout(r, 500))\`이 도움.

이미지 콘텐츠 블록은 큼(보통 200KB-2MB 인코딩) — 관대한 스크린샷 사용은 대화 부풀리고 prompt cache 노화. 텍스트 레벨 데이터로 충분하면 browser_page_info나 browser_evaluate 선호.`,
  bestFor: [
    '시각 디버깅("페이지 실제 어떻게 보이나?")',
    '사용자용 차트 / 이미지 / 디자인 렌더 캡처',
    '상호작용 전후 pre/post 스크린샷(browser_click 전, 후)',
  ],
  avoidWhen: [
    '텍스트 레벨 데이터 충분 — browser_page_info 또는 browser_evaluate',
    '대규모 스크래핑 — 스크린샷이 토큰 소비',
    '페이지가 애니메이션 — 캡처가 mid-frame일 수 있음',
  ],
  gotchas: [
    '큰 인코딩 페이로드. 한 턴에 많은 스크린샷 배치 금지.',
    '애니메이션 콘텐츠 mid-frame 캡처. 필요 시 browser_evaluate setTimeout으로 wait.',
    'Element-mode(`selector`)는 요소가 보여야 — off-screen 요소도 캡처하지만 실제 위치에서 zero-pixel 이미지 반환 가능.',
    '일부 사이트가 CSP나 특정 anti-screenshot 스크립트로 canvas 스타일 스크린샷 비활성화; 그 경우 결과가 부분적이거나 blank.',
  ],
  examples: [
    {
      caption: '대시보드의 특정 차트 캡처',
      body: `{
  "selector": "#metrics-chart"
}`,
      note: '전체 뷰포트 아닌 차트만의 PNG 이미지 블록 반환.',
    },
  ],
  relatedTools: [
    'browser_navigate',
    'browser_page_info',
    'browser_evaluate',
  ],
  relatedStages: [],
  codeRef:
    'Geny / backend/tools/custom/browser_tools.py:BrowserScreenshotTool',
};

export const browserScreenshotToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
