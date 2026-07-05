/** Tool detail — BrowserClose (geny-executor / browser family, an-web engine). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `BrowserClose closes this session's browser tab, releasing its JavaScript runtime (V8 heap) and connection pool, and discarding cookies, storage, and history. The next BrowserNavigate boots a fresh tab with none of the old state.

Idempotent — closing a never-opened tab returns success. Idle tabs are also reaped automatically after a timeout, but explicit close is cleaner for long sessions.`,
  bestFor: [
    'End of a browse-driven task',
    'Resetting to a clean state between unrelated flows (e.g. different login)',
    'Freeing memory in long sessions',
  ],
  avoidWhen: [
    "Mid-flow — closing discards the login/cookie state you'll need next call",
  ],
  gotchas: [
    'All state is lost: the next BrowserNavigate is a fresh, cookie-less tab.',
    'Idempotent — safe to call even if no tab is open.',
  ],
  examples: [
    {
      caption: 'Cleanup after browsing is done',
      body: `{}`,
      note: 'No arguments. Subsequent Browser* tools start a fresh tab.',
    },
  ],
  relatedTools: ['BrowserNavigate', 'BrowserSnapshot'],
  relatedStages: [],
  codeRef:
    'geny-executor / tools/built_in/browser_tools.py:BrowserCloseTool',
};

const ko: ToolDetailContent = {
  body: `BrowserClose는 이 세션의 브라우저 탭을 닫아 JavaScript 런타임(V8 힙)과 연결 풀을 해제하고, 쿠키·스토리지·히스토리를 폐기합니다. 다음 BrowserNavigate는 이전 상태가 전혀 없는 새 탭으로 시작합니다.

Idempotent — 연 적 없는 탭을 닫아도 성공을 반환합니다. 유휴 탭은 타임아웃 후 자동 정리되지만, 긴 세션에서는 명시적 close가 더 깔끔합니다.`,
  bestFor: [
    '브라우즈 중심 작업의 마무리',
    '무관한 플로우 사이의 초기화(예: 다른 계정 로그인)',
    '긴 세션의 메모리 확보',
  ],
  avoidWhen: [
    '플로우 중간 — 다음 호출에 필요한 로그인/쿠키 상태가 사라짐',
  ],
  gotchas: [
    '모든 상태 손실: 다음 BrowserNavigate는 쿠키 없는 새 탭.',
    'Idempotent — 열린 탭이 없어도 안전하게 호출 가능.',
  ],
  examples: [
    {
      caption: '브라우징 종료 후 정리',
      body: `{}`,
      note: '인자 없음. 이후 Browser* 도구는 새 탭으로 시작.',
    },
  ],
  relatedTools: ['BrowserNavigate', 'BrowserSnapshot'],
  relatedStages: [],
  codeRef:
    'geny-executor / tools/built_in/browser_tools.py:BrowserCloseTool',
};

export const browserCloseToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
