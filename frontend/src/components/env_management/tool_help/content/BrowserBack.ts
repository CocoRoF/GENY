/** Tool detail — BrowserBack (geny-executor / browser family, an-web engine). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `BrowserBack goes back one entry in this session's browser history and returns the previous page's semantic snapshot — the standard move after drilling into a detail page from a listing.

History is per session tab and survives across tool calls; cookies and storage stay intact through the back navigation.`,
  bestFor: [
    'Returning to a search/listing page after opening a result',
    'Stepping back through a multi-page flow',
  ],
  avoidWhen: [
    'Jumping to a known URL — BrowserNavigate is direct',
    'No page has been opened yet',
  ],
  gotchas: [
    'Errors when the history is empty (nothing to go back to).',
    'The page is re-fetched — dynamic content may differ from the first visit.',
  ],
  examples: [
    {
      caption: 'Back to the results list',
      body: `{}`,
      note: 'No arguments. Returns the previous page + snapshot.',
    },
  ],
  relatedTools: ['BrowserNavigate', 'BrowserSnapshot'],
  relatedStages: [],
  codeRef:
    'geny-executor / tools/built_in/browser_tools.py:BrowserBackTool',
};

const ko: ToolDetailContent = {
  body: `BrowserBack은 이 세션의 브라우저 히스토리를 한 단계 되돌아가 이전 페이지의 시맨틱 스냅샷을 반환합니다 — 목록에서 상세 페이지로 들어갔다 돌아올 때의 표준 동작입니다.

히스토리는 세션 탭별로 유지되며, back 내비게이션 중에도 쿠키·스토리지는 그대로 보존됩니다.`,
  bestFor: [
    '검색/목록 페이지에서 결과를 열었다가 복귀',
    '멀티 페이지 플로우 되짚기',
  ],
  avoidWhen: [
    '아는 URL로 바로 이동 — BrowserNavigate가 직접적',
    '아직 연 페이지가 없음',
  ],
  gotchas: [
    '히스토리가 비어 있으면 에러(되돌아갈 곳 없음).',
    '페이지를 다시 가져오므로 동적 콘텐츠는 첫 방문과 다를 수 있음.',
  ],
  examples: [
    {
      caption: '결과 목록으로 복귀',
      body: `{}`,
      note: '인자 없음. 이전 페이지 + 스냅샷 반환.',
    },
  ],
  relatedTools: ['BrowserNavigate', 'BrowserSnapshot'],
  relatedStages: [],
  codeRef:
    'geny-executor / tools/built_in/browser_tools.py:BrowserBackTool',
};

export const browserBackToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
