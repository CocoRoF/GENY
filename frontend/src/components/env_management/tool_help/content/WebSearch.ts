/** Tool detail — WebSearch (executor / web family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `WebSearch runs a query against a web search backend (DuckDuckGo by default in geny-executor) and returns ranked results. Each result is \`{title, url, snippet}\` — a quick orientation, not full page content. The intended pattern is "search → pick → WebFetch" — the agent surveys hits, picks one or two relevant ones, and fetches full content separately.

The backend is configurable per-deployment (DuckDuckGo / Brave / Google CSE / etc.). The default backend has no API key requirement but rate-limits aggressively; production deployments typically swap in a paid backend.

Result counts default to ~10. Some backends honour a \`max_results\` parameter; others ignore it and return their own page size. Don't depend on exact counts — design the agent to handle "fewer hits than expected".

Searches are read-only and side-effect free, but they DO leave a trace at the backend — the host's IP / API key shows up in search backend logs. For privacy-sensitive deployments, use a backend with appropriate retention guarantees.

Time-relevance: most backends weight recent pages higher for "current event" queries. For older / static information, consider adding date hints to the query (\"X site:docs.example.com\").`,
  bestFor: [
    'Research tasks where the agent needs to discover relevant URLs',
    'Fact-checking — survey multiple sources before referencing',
    'Locating documentation when you don\'t know the exact URL',
  ],
  avoidWhen: [
    'You already know the URL — skip search and WebFetch directly',
    'Searching internal / private content — backends only see public web',
    'Deeply technical queries best handled by Grep / LSP against the local repo',
  ],
  gotchas: [
    'Result count varies by backend; design for "small N" rather than expecting a specific number.',
    'Snippets are short (typically 1-3 sentences). For real content the agent must WebFetch.',
    'Some backends have aggressive rate limits — bursts of WebSearch calls fail with 429-style errors.',
    'Search rankings can drift between calls (live algorithms). Idempotency isn\'t guaranteed.',
  ],
  examples: [
    {
      caption: 'Find documentation for a library',
      body: `{
  "query": "geny-executor manifest tools.built_in",
  "max_results": 5
}`,
      note: 'Returns up to 5 hits with title / URL / snippet; agent picks one and WebFetches.',
    },
  ],
  relatedTools: ['WebFetch'],
  relatedStages: [],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/web_search_tool.py:WebSearchTool',
};

const ko: ToolDetailContent = {
  body: `WebSearch는 웹 검색 백엔드(geny-executor 기본은 DuckDuckGo)에 쿼리를 실행하고 랭킹된 결과를 반환합니다. 각 결과는 \`{title, url, snippet}\` — 빠른 orientation, 풀 페이지 콘텐츠 아님. 의도된 패턴은 "검색 → 선택 → WebFetch" — 에이전트가 히트 survey, 관련 한두 개 선택, 풀 콘텐츠는 별도 fetch.

백엔드는 배포별 설정 가능(DuckDuckGo / Brave / Google CSE 등). 기본 백엔드는 API 키 불필요하지만 rate-limit 공격적; 운영 배포는 보통 유료 백엔드로 교체.

결과 카운트 기본 ~10. 일부 백엔드는 \`max_results\` 파라미터 honour, 일부는 무시하고 자체 페이지 크기 반환. 정확한 카운트 의존 금지 — "예상보다 적은 히트" 처리하도록 에이전트 설계.

검색은 read-only이고 side-effect free, 하지만 백엔드에 trace 남김 — 호스트의 IP / API 키가 검색 백엔드 로그에 등장. 프라이버시 민감 배포는 적절한 retention 보장 백엔드 사용.

시간 적합성: 대부분의 백엔드가 "current event" 쿼리에 최근 페이지 weight. 오래된 / 정적 정보는 쿼리에 날짜 힌트 추가 고려("X site:docs.example.com").`,
  bestFor: [
    '에이전트가 관련 URL 발견 필요한 리서치 작업',
    '사실 확인 — 참조 전 여러 소스 survey',
    '정확한 URL 모를 때 문서 위치 찾기',
  ],
  avoidWhen: [
    'URL 이미 아는 경우 — 검색 skip하고 WebFetch 직접',
    '내부 / 프라이빗 콘텐츠 검색 — 백엔드는 공개 웹만 봄',
    '로컬 repo 대상 Grep / LSP가 더 적합한 깊이 있는 기술 쿼리',
  ],
  gotchas: [
    '결과 카운트는 백엔드별; 특정 숫자 기대 대신 "small N" 설계.',
    'Snippet은 짧음(보통 1-3문장). 실제 콘텐츠는 에이전트가 WebFetch 필요.',
    '일부 백엔드는 공격적 rate limit — WebSearch burst 호출이 429 스타일 에러로 실패.',
    '검색 랭킹은 호출 간 drift 가능(라이브 알고리즘). Idempotency 보장 안 됨.',
  ],
  examples: [
    {
      caption: '라이브러리 문서 찾기',
      body: `{
  "query": "geny-executor manifest tools.built_in",
  "max_results": 5
}`,
      note: 'title / URL / snippet과 함께 최대 5개 히트 반환; 에이전트가 하나 골라 WebFetch.',
    },
  ],
  relatedTools: ['WebFetch'],
  relatedStages: [],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/web_search_tool.py:WebSearchTool',
};

export const webSearchToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
