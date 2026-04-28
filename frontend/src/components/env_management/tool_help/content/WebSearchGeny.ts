/** Tool detail — web_search (Geny / web family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `web_search runs a search query against Geny\'s configured search backend (DuckDuckGo by default; configurable per-deployment). Returns a list of \`{title, url, snippet}\` results — same shape as the executor\'s WebSearch but using the Geny-side configuration.

The two implementations exist because Geny has its own search-backend wiring (custom API keys, host-specific result filtering) that the executor doesn\'t need to know about. Behaviour is otherwise identical: ranked results, snippets too short for full content, "search → pick → fetch" pattern.

Filters host-specific. Some Geny deployments add region / language / safe-search controls; check your deployment.`,
  bestFor: [
    'Discovering URLs on the public web',
    'Pre-flight before web_fetch',
    'Quick "what does the internet say about X?" queries',
  ],
  avoidWhen: [
    'You already know the URL — web_fetch directly',
    'Searching internal repos / private content — backend only sees public web',
    'Looking for news specifically — news_search has time-weighted ranking',
  ],
  gotchas: [
    'Backend-defined result count. Don\'t depend on a specific N.',
    'Snippets are short — full content needs web_fetch.',
    'Aggressive rate-limiting on the default backend. Production deployments swap in paid backends.',
    'Rankings drift between calls — searches aren\'t idempotent.',
  ],
  examples: [
    {
      caption: 'Find documentation for an unfamiliar library',
      body: `{
  "query": "playwright python launch_persistent_context"
}`,
      note: 'Returns ranked results. Agent picks one and web_fetches.',
    },
  ],
  relatedTools: ['web_fetch', 'web_fetch_multiple', 'news_search'],
  relatedStages: [],
  codeRef:
    'Geny / backend/tools/custom/web_search_tools.py:WebSearchTool',
};

const ko: ToolDetailContent = {
  body: `web_search는 Geny의 설정된 검색 백엔드(기본 DuckDuckGo; 배포별 설정 가능)에 검색 쿼리 실행. \`{title, url, snippet}\` 결과 리스트 반환 — 실행기의 WebSearch와 같은 형태지만 Geny 측 설정 사용.

두 구현 존재 이유: Geny가 자체 검색 백엔드 와이어링(커스텀 API 키, 호스트 특정 결과 필터링) 보유 — 실행기가 알 필요 없음. 그 외 동작은 동일: ranked 결과, 풀 콘텐츠 부족한 짧은 snippet, "검색 → 선택 → fetch" 패턴.

필터 호스트 특정. 일부 Geny 배포는 region / language / safe-search 컨트롤 추가; 배포 확인.`,
  bestFor: [
    '공개 웹의 URL 발견',
    'web_fetch 전 사전 확인',
    '빠른 "인터넷에서 X에 대해 뭐라 하나?" 쿼리',
  ],
  avoidWhen: [
    'URL 이미 아는 경우 — web_fetch 직접',
    '내부 repo / private 콘텐츠 검색 — 백엔드는 공개 웹만 봄',
    '뉴스 특정 찾기 — news_search가 시간 가중 ranking',
  ],
  gotchas: [
    '백엔드 정의 결과 카운트. 특정 N 의존 금지.',
    'Snippet 짧음 — 풀 콘텐츠는 web_fetch.',
    '기본 백엔드의 공격적 rate-limiting. 운영 배포는 유료 백엔드로 swap.',
    '호출 간 랭킹 drift — 검색 idempotent 아님.',
  ],
  examples: [
    {
      caption: '낯선 라이브러리 문서 찾기',
      body: `{
  "query": "playwright python launch_persistent_context"
}`,
      note: 'Ranked 결과 반환. 에이전트가 하나 골라 web_fetch.',
    },
  ],
  relatedTools: ['web_fetch', 'web_fetch_multiple', 'news_search'],
  relatedStages: [],
  codeRef:
    'Geny / backend/tools/custom/web_search_tools.py:WebSearchTool',
};

export const webSearchGenyToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
