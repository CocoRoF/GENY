/** Tool detail — BrowserNavigate (geny-executor / browser family, an-web engine). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `BrowserNavigate opens a URL in this session's browser tab using the an-web engine — a pip-installable headless engine (httpx + embedded V8) that executes the page's JavaScript without any Chromium download. It returns a semantic snapshot of the rendered page: roles, names, and [ref=nN] handles for every interactive element, instead of raw HTML or pixels.

The tab persists per agent session: cookies, localStorage, and history survive between calls, so login flows work (navigate → BrowserAct type/click → navigate to a protected page).

Different from WebFetch: WebFetch is a one-shot stateless fetch (optionally JS-rendered with render_js:true). BrowserNavigate maintains an interactive session you can act on with BrowserAct and read again with BrowserSnapshot.

For script-heavy sites that take long to settle, pass timeout (e.g. 3) to cap the settle budget and accept a partial render.`,
  bestFor: [
    'Opening SPA/React pages whose content is client-rendered',
    'Starting any multi-step web flow (login, forms, pagination)',
    'Reading a page you will interact with next',
  ],
  avoidWhen: [
    'One-shot reads of static pages — WebFetch is faster and stateless',
    'Pure API endpoints — WebFetch returns the raw body directly',
  ],
  gotchas: [
    'Requires the an-web engine (pip install geny-executor[browser], Python ≥ 3.12); without it the tool returns an install-hint error.',
    'Large pages truncate at the snapshot node budget — use BrowserExtract for full details.',
    'iframes are not executed and screenshots are not supported (semantic-first design).',
    'The tab is per session — parallel tool calls in one session serialize.',
  ],
  examples: [
    {
      caption: 'Open a JS-rendered page',
      body: `{"url": "https://news.ycombinator.com"}`,
      note: 'Returns page metadata + a YAML semantic tree with [ref=...] handles.',
    },
    {
      caption: 'Script-heavy site, capped settle',
      body: `{"url": "https://example-spa.com", "timeout": 3}`,
      note: 'Accepts a partial render after 3s instead of waiting for full settle.',
    },
  ],
  relatedTools: ['BrowserAct', 'BrowserSnapshot', 'BrowserExtract', 'WebFetch'],
  relatedStages: [],
  codeRef:
    'geny-executor / tools/built_in/browser_tools.py:BrowserNavigateTool',
};

const ko: ToolDetailContent = {
  body: `BrowserNavigate는 an-web 엔진(httpx + 내장 V8, Chromium 다운로드 불필요)으로 이 세션의 브라우저 탭에서 URL을 엽니다. 페이지의 JavaScript를 실행한 뒤, raw HTML이나 픽셀 대신 렌더링된 페이지의 시맨틱 스냅샷 — role, 이름, 그리고 모든 상호작용 요소의 [ref=nN] 핸들 — 을 반환합니다.

탭은 에이전트 세션별로 유지됩니다: 쿠키·localStorage·히스토리가 호출 간 보존되어 로그인 플로우가 동작합니다 (navigate → BrowserAct로 입력/클릭 → 보호된 페이지로 navigate).

WebFetch와의 차이: WebFetch는 일회성 무상태 fetch(render_js:true로 JS 렌더 선택 가능)이고, BrowserNavigate는 BrowserAct로 조작하고 BrowserSnapshot으로 다시 읽는 상호작용 세션을 유지합니다.

스크립트가 많은 사이트는 timeout(예: 3)으로 settle 예산을 제한해 부분 렌더를 받아들일 수 있습니다.`,
  bestFor: [
    '클라이언트 렌더링되는 SPA/React 페이지 열기',
    '멀티스텝 웹 플로우 시작(로그인, 폼, 페이지네이션)',
    '이후 상호작용할 페이지 읽기',
  ],
  avoidWhen: [
    '정적 페이지의 일회성 읽기 — WebFetch가 더 빠르고 무상태',
    '순수 API 엔드포인트 — WebFetch가 body를 그대로 반환',
  ],
  gotchas: [
    'an-web 엔진 필요(pip install geny-executor[browser], Python ≥ 3.12); 없으면 설치 안내 에러 반환.',
    '큰 페이지는 스냅샷 노드 예산에서 잘림 — 상세는 BrowserExtract 사용.',
    'iframe 미실행, 스크린샷 미지원(시맨틱 우선 설계).',
    '탭은 세션당 하나 — 같은 세션의 병렬 호출은 직렬화됨.',
  ],
  examples: [
    {
      caption: 'JS 렌더 페이지 열기',
      body: `{"url": "https://news.ycombinator.com"}`,
      note: '페이지 메타데이터 + [ref=...] 핸들이 달린 YAML 시맨틱 트리 반환.',
    },
    {
      caption: '스크립트 무거운 사이트, settle 제한',
      body: `{"url": "https://example-spa.com", "timeout": 3}`,
      note: '전체 settle 대신 3초 후 부분 렌더 수용.',
    },
  ],
  relatedTools: ['BrowserAct', 'BrowserSnapshot', 'BrowserExtract', 'WebFetch'],
  relatedStages: [],
  codeRef:
    'geny-executor / tools/built_in/browser_tools.py:BrowserNavigateTool',
};

export const browserNavigateToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
