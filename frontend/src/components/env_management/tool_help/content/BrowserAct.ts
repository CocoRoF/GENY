/** Tool detail — BrowserAct (geny-executor / browser family, an-web engine). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `BrowserAct interacts with the current page in this session's tab. One tool, seven actions: click, type (set text; append:true to append), select (dropdowns), clear, submit (forms), scroll, and wait_for (network_idle | dom_stable | selector | element_visible).

Elements are targeted three ways: a snapshot ref ("n42" from BrowserNavigate/BrowserSnapshot output), visible text ("text=Sign in"), or a CSS selector ("#login", ".price"). Refs are exact; text matching ranks exact > interactive > shortest name.

Clicking a link navigates and inlines the new page's snapshot in the response — no follow-up BrowserSnapshot needed. Non-navigating actions return the effect summary; re-read with BrowserSnapshot when you need the updated tree.`,
  bestFor: [
    'Clicking links/buttons found in a snapshot',
    'Filling and submitting forms (type → click/submit)',
    'Waiting for async content (wait_for network_idle / selector)',
  ],
  avoidWhen: [
    'No page is open yet — BrowserNavigate first',
    'Hover/drag/keyboard-combo interactions — not supported by the engine',
  ],
  gotchas: [
    'Refs go stale after DOM changes — re-snapshot and use fresh handles.',
    'type replaces the field content by default; pass append:true to add.',
    'A click that opens a new page returns that page inline (budgeted at 150 nodes).',
  ],
  examples: [
    {
      caption: 'Click by snapshot ref',
      body: `{"action": "click", "target": "n42"}`,
      note: 'n42 comes from the [ref=n42] handle in a snapshot.',
    },
    {
      caption: 'Fill a login form',
      body: `{"action": "type", "target": "#email", "text": "user@example.com"}`,
      note: 'Then type the password and click the submit button.',
    },
    {
      caption: 'Wait for async content',
      body: `{"action": "wait_for", "condition": "selector", "selector": ".results", "timeout_ms": 8000}`,
      note: 'Blocks until the selector appears or the timeout hits.',
    },
  ],
  relatedTools: ['BrowserNavigate', 'BrowserSnapshot', 'BrowserExtract'],
  relatedStages: [],
  codeRef:
    'geny-executor / tools/built_in/browser_tools.py:BrowserActTool',
};

const ko: ToolDetailContent = {
  body: `BrowserAct는 이 세션 탭의 현재 페이지와 상호작용합니다. 도구 하나에 7개 액션: click, type(텍스트 설정; append:true면 덧붙임), select(드롭다운), clear, submit(폼), scroll, wait_for(network_idle | dom_stable | selector | element_visible).

요소 지정은 세 가지: 스냅샷 ref("n42" — BrowserNavigate/BrowserSnapshot 출력의 핸들), 가시 텍스트("text=로그인"), CSS 셀렉터("#login", ".price"). ref는 정확 지정이고, 텍스트 매칭은 정확일치 > 상호작용 요소 > 최단 이름 순으로 랭킹됩니다.

링크 클릭은 내비게이션 후 새 페이지의 스냅샷을 응답에 인라인합니다 — 후속 BrowserSnapshot이 필요 없습니다. 내비게이션 없는 액션은 효과 요약만 반환하며, 갱신된 트리가 필요하면 BrowserSnapshot으로 다시 읽으세요.`,
  bestFor: [
    '스냅샷에서 찾은 링크/버튼 클릭',
    '폼 입력·제출(type → click/submit)',
    '비동기 콘텐츠 대기(wait_for network_idle / selector)',
  ],
  avoidWhen: [
    '아직 연 페이지가 없음 — 먼저 BrowserNavigate',
    'hover/drag/키 조합 상호작용 — 엔진 미지원',
  ],
  gotchas: [
    'DOM이 바뀌면 ref가 stale — 재스냅샷 후 새 핸들 사용.',
    'type은 기본적으로 필드 내용을 교체; 덧붙이려면 append:true.',
    '새 페이지를 여는 클릭은 그 페이지를 인라인 반환(150 노드 예산).',
  ],
  examples: [
    {
      caption: '스냅샷 ref로 클릭',
      body: `{"action": "click", "target": "n42"}`,
      note: 'n42는 스냅샷의 [ref=n42] 핸들.',
    },
    {
      caption: '로그인 폼 입력',
      body: `{"action": "type", "target": "#email", "text": "user@example.com"}`,
      note: '이어서 비밀번호 입력 후 제출 버튼 클릭.',
    },
    {
      caption: '비동기 콘텐츠 대기',
      body: `{"action": "wait_for", "condition": "selector", "selector": ".results", "timeout_ms": 8000}`,
      note: '셀렉터가 나타나거나 타임아웃까지 대기.',
    },
  ],
  relatedTools: ['BrowserNavigate', 'BrowserSnapshot', 'BrowserExtract'],
  relatedStages: [],
  codeRef:
    'geny-executor / tools/built_in/browser_tools.py:BrowserActTool',
};

export const browserActToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
