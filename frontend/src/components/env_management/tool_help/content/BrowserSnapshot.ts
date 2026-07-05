/** Tool detail — BrowserSnapshot (geny-executor / browser family, an-web engine). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `BrowserSnapshot re-reads the CURRENT page in this session's tab as a semantic snapshot: a YAML tree of roles and names with [ref=nN] handles on every interactive element. It is the "look again" primitive after BrowserAct changed the page state without navigating (expanded menus, validation errors, dynamically inserted content).

Large pages truncate at the node budget (max_nodes, default 400) with a marker — drill into details with BrowserExtract instead of raising the budget blindly.`,
  bestFor: [
    'Re-reading the page after type/select/scroll actions',
    'Getting fresh [ref=...] handles when earlier ones went stale',
    'Checking form state and validation messages',
  ],
  avoidWhen: [
    'Right after BrowserNavigate or a navigating click — those already return the snapshot',
    'Pulling bulk data (tables, lists) — BrowserExtract is precise and cheaper',
  ],
  gotchas: [
    'Errors if no page is open — call BrowserNavigate first.',
    'Node budget truncation hides deep content; the marker tells you when it happened.',
  ],
  examples: [
    {
      caption: 'Re-read after an in-page action',
      body: `{}`,
      note: 'Returns URL, title, page type and the semantic tree.',
    },
    {
      caption: 'Wider budget for a dense page',
      body: `{"max_nodes": 800}`,
      note: 'Doubles the default node budget — costs proportionally more tokens.',
    },
  ],
  relatedTools: ['BrowserNavigate', 'BrowserAct', 'BrowserExtract'],
  relatedStages: [],
  codeRef:
    'geny-executor / tools/built_in/browser_tools.py:BrowserSnapshotTool',
};

const ko: ToolDetailContent = {
  body: `BrowserSnapshot은 이 세션 탭의 현재 페이지를 시맨틱 스냅샷 — 모든 상호작용 요소에 [ref=nN] 핸들이 달린 role/이름 YAML 트리 — 으로 다시 읽습니다. BrowserAct가 내비게이션 없이 페이지 상태를 바꿨을 때(메뉴 펼침, 검증 오류, 동적 콘텐츠 삽입) "다시 보기" 용도입니다.

큰 페이지는 노드 예산(max_nodes, 기본 400)에서 마커와 함께 잘립니다 — 예산을 무작정 올리기보다 BrowserExtract로 필요한 부분만 파고드세요.`,
  bestFor: [
    'type/select/scroll 액션 후 페이지 재확인',
    '이전 [ref=...] 핸들이 stale해졌을 때 새 핸들 획득',
    '폼 상태·검증 메시지 확인',
  ],
  avoidWhen: [
    'BrowserNavigate나 내비게이션 클릭 직후 — 이미 스냅샷이 반환됨',
    '표/리스트 등 대량 데이터 추출 — BrowserExtract가 정밀하고 저렴',
  ],
  gotchas: [
    '열린 페이지가 없으면 에러 — 먼저 BrowserNavigate 호출.',
    '노드 예산 잘림은 깊은 콘텐츠를 숨김; 잘리면 마커가 표시됨.',
  ],
  examples: [
    {
      caption: '페이지 내 액션 후 재확인',
      body: `{}`,
      note: 'URL, 제목, 페이지 타입, 시맨틱 트리 반환.',
    },
    {
      caption: '밀도 높은 페이지에 넓은 예산',
      body: `{"max_nodes": 800}`,
      note: '기본 노드 예산의 2배 — 토큰 비용도 비례해 증가.',
    },
  ],
  relatedTools: ['BrowserNavigate', 'BrowserAct', 'BrowserExtract'],
  relatedStages: [],
  codeRef:
    'geny-executor / tools/built_in/browser_tools.py:BrowserSnapshotTool',
};

export const browserSnapshotToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
