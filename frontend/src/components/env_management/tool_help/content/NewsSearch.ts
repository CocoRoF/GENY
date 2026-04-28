/** Tool detail — news_search (Geny / web family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `news_search runs a query against a news-focused search backend — same shape as web_search but with time-weighted ranking that surfaces recent articles ahead of older ones. Use it when "the answer is whatever was reported recently" matters more than relevance to the literal phrasing.

Returns: \`{title, url, snippet, published_at, source}\`. The \`published_at\` field is the differentiator — agents can filter or rank further using the timestamp.

Common queries:
  - "What\'s happening with X today?"
  - "Has Y been announced yet?"
  - Background research that needs recency more than authority

Where web_search rankings drift on algorithm details, news_search rankings explicitly weight recency. A query about "Anthropic" that returns last week\'s news on web_search may surface today\'s news on news_search.`,
  bestFor: [
    'Time-sensitive queries — "today\'s news on X"',
    'Verifying whether an event happened recently',
    'Background research where recency matters',
  ],
  avoidWhen: [
    'You want enduring documentation — web_search ranks by relevance',
    'You need full article content — news_search returns snippets; follow up with web_fetch',
    'Internal news / private content — backend only sees public news',
  ],
  gotchas: [
    'Ranking weights recency. A perfectly-relevant 2020 article won\'t outrank a vaguely-related yesterday\'s article.',
    'Snippet quality varies — some sources put the lede in snippet, others put boilerplate.',
    '`published_at` is the source\'s claim, not validated. Stale clocks on the source side can mislead.',
    'Rate limits same as web_search — bursts can fail.',
  ],
  examples: [
    {
      caption: 'Find recent news on a topic',
      body: `{
  "query": "anthropic new model release"
}`,
      note: 'Returns articles weighted by recency. Pick the most relevant and web_fetch for full content.',
    },
  ],
  relatedTools: ['web_search', 'web_fetch'],
  relatedStages: [],
  codeRef:
    'Geny / backend/tools/custom/web_search_tools.py:NewsSearchTool',
};

const ko: ToolDetailContent = {
  body: `news_search는 뉴스 중심 검색 백엔드에 쿼리 실행 — web_search와 같은 형태지만 옛 기사보다 최근 기사를 위로 표면화하는 시간 가중 랭킹. "답이 최근에 보도된 무엇이든"이 문자 그대로의 표현 관련도보다 중요할 때 사용.

반환: \`{title, url, snippet, published_at, source}\`. \`published_at\` 필드가 차별점 — 에이전트가 타임스탬프로 추가 필터 / 랭킹 가능.

흔한 쿼리:
  - "오늘 X에 대해 뭐 일어나고 있나?"
  - "Y가 발표됐나?"
  - Authority보다 recency 필요한 백그라운드 리서치

web_search 랭킹이 알고리즘 디테일로 drift하는 반면 news_search 랭킹은 명시적으로 recency weight. "Anthropic" 쿼리가 web_search에서 지난주 뉴스 반환할 수 있지만 news_search에서는 오늘의 뉴스 표면화.`,
  bestFor: [
    '시간 민감 쿼리 — "오늘의 X 뉴스"',
    '이벤트가 최근 일어났는지 검증',
    'Recency 중요한 백그라운드 리서치',
  ],
  avoidWhen: [
    '지속적 문서 원함 — web_search가 관련도로 랭킹',
    '풀 article 콘텐츠 필요 — news_search는 snippet 반환; web_fetch로 follow-up',
    '내부 뉴스 / private 콘텐츠 — 백엔드는 공개 뉴스만 봄',
  ],
  gotchas: [
    '랭킹이 recency weight. 완벽히 관련 있는 2020 article이 vaguely 관련 있는 어제 article보다 위로 랭크 안 됨.',
    'Snippet 품질 다양 — 일부 소스는 lede를 snippet에, 다른 곳은 boilerplate.',
    '`published_at`은 소스의 주장, 검증 안 됨. 소스 측 stale 시계가 misled 가능.',
    'Rate limit은 web_search와 같음 — burst 실패.',
  ],
  examples: [
    {
      caption: 'topic의 최근 뉴스 찾기',
      body: `{
  "query": "anthropic new model release"
}`,
      note: 'Recency weight된 article 반환. 가장 관련 있는 것 골라 풀 콘텐츠는 web_fetch.',
    },
  ],
  relatedTools: ['web_search', 'web_fetch'],
  relatedStages: [],
  codeRef:
    'Geny / backend/tools/custom/web_search_tools.py:NewsSearchTool',
};

export const newsSearchToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
