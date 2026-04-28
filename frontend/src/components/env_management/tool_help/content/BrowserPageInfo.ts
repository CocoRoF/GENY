/** Tool detail — browser_page_info (Geny / browser family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `browser_page_info returns a structured snapshot of the current page — URL, title, and the catalogue of interactive elements (links, buttons, form fields). Cheaper than browser_navigate (no re-fetch) and richer than browser_screenshot (text vs image).

Use it as a "where am I and what can I do?" probe between actions. After browser_click changes the page, browser_page_info confirms the new state without consuming a screenshot worth of tokens.

Returns:
  - \`url\`: current address
  - \`title\`: \`<title>\` tag content
  - \`links\`: \`{href, text, selector}\` for each \`<a>\`
  - \`buttons\`: \`{text, selector, type}\` for clickable buttons
  - \`form_fields\`: \`{name, type, value, selector}\` for inputs / textareas
  - optional ARIA / role metadata depending on host config

The interactive catalogue is the precursor for browser_click / browser_fill — the agent reads page_info, picks a target, then acts. Selectors returned are stable enough to use directly with the action tools.`,
  bestFor: [
    'Verifying page state after an interaction',
    'Discovering clickable / fillable elements without a screenshot',
    'Cheap "what changed?" check between browser_click steps',
  ],
  avoidWhen: [
    'You need actual content (article body, etc.) — browser_navigate response or browser_evaluate',
    'You need visual layout — browser_screenshot',
    'You\'re looking for non-interactive elements — they\'re not in the catalogue',
  ],
  gotchas: [
    'Catalogue is best-effort — heavily-customised UI frameworks may not produce clean entries.',
    'ARIA / role metadata depends on host. Don\'t depend on it being present.',
    'Selectors returned aim for stability, but heavy DOM mutation (React re-renders) can invalidate them. Re-call if a selector fails.',
    'Doesn\'t catch shadow-DOM elements by default — some web components hide content from this catalogue.',
  ],
  examples: [
    {
      caption: 'Inspect what\'s actionable on the current page',
      body: `{}`,
      note: 'Returns URL, title, and catalogues for links / buttons / form fields.',
    },
  ],
  relatedTools: [
    'browser_navigate',
    'browser_click',
    'browser_fill',
    'browser_screenshot',
  ],
  relatedStages: [],
  codeRef:
    'Geny / backend/tools/custom/browser_tools.py:BrowserPageInfoTool',
};

const ko: ToolDetailContent = {
  body: `browser_page_info는 현재 페이지의 구조화 스냅샷 반환 — URL, title, 상호작용 요소 카탈로그(링크, 버튼, 폼 필드). browser_navigate보다 저렴(re-fetch 없음)하고 browser_screenshot보다 풍부(텍스트 vs 이미지).

액션 간 "어디 있고 뭘 할 수 있나?" probe로 사용. browser_click이 페이지 변경한 후 스크린샷 가치 토큰 소비 없이 browser_page_info가 새 상태 확인.

반환:
  - \`url\`: 현재 주소
  - \`title\`: \`<title>\` 태그 콘텐츠
  - \`links\`: 각 \`<a>\`에 대한 \`{href, text, selector}\`
  - \`buttons\`: 클릭 가능 버튼의 \`{text, selector, type}\`
  - \`form_fields\`: input / textarea의 \`{name, type, value, selector}\`
  - 호스트 설정에 따른 선택적 ARIA / role 메타데이터

상호작용 카탈로그는 browser_click / browser_fill의 precursor — 에이전트가 page_info 읽고 타겟 선택, 그 후 액션. 반환된 셀렉터는 액션 도구와 직접 사용할 만큼 stable.`,
  bestFor: [
    '상호작용 후 페이지 상태 검증',
    '스크린샷 없이 클릭 가능 / 채울 수 있는 요소 발견',
    'browser_click 단계 간 저렴한 "뭐 변했나?" 체크',
  ],
  avoidWhen: [
    '실제 콘텐츠 필요(article body 등) — browser_navigate 응답 또는 browser_evaluate',
    '시각 레이아웃 필요 — browser_screenshot',
    '비상호작용 요소 찾기 — 카탈로그에 없음',
  ],
  gotchas: [
    '카탈로그는 best-effort — 많이 커스터마이즈된 UI 프레임워크는 깔끔한 entry 생성 안 할 수 있음.',
    'ARIA / role 메타데이터는 호스트 의존. 존재 의존 금지.',
    '반환된 셀렉터는 안정성 목표하지만 무거운 DOM mutation(React re-render)이 무효화 가능. 셀렉터 실패 시 재호출.',
    '기본적으로 shadow-DOM 요소 캐치 안 함 — 일부 웹 컴포넌트가 이 카탈로그에서 콘텐츠 숨김.',
  ],
  examples: [
    {
      caption: '현재 페이지에서 actionable한 것 검사',
      body: `{}`,
      note: 'URL, title, 링크 / 버튼 / 폼 필드 카탈로그 반환.',
    },
  ],
  relatedTools: [
    'browser_navigate',
    'browser_click',
    'browser_fill',
    'browser_screenshot',
  ],
  relatedStages: [],
  codeRef:
    'Geny / backend/tools/custom/browser_tools.py:BrowserPageInfoTool',
};

export const browserPageInfoToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
