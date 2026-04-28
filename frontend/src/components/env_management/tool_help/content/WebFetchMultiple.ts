/** Tool detail — web_fetch_multiple (Geny / web family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `web_fetch_multiple fetches a list of URLs in parallel from the host network. Returns a list of \`{url, status, body, error?}\` records — one per requested URL. Errors are per-URL; one failure doesn\'t kill the whole batch.

Use it for fan-out fetches: gather data from N similar endpoints, scrape a list of pages, batch-fetch competition pricing across vendor URLs. The parallelism is bounded server-side (typical: 5-10 concurrent), so passing 50 URLs runs ~5-10 batches sequentially.

Each URL is subject to the same constraints as web_fetch — no JS rendering, host-IP origin, body size cap. Aggregate response can be large; the tool truncates per-URL bodies past a threshold (typically 100KB each) to keep the response bounded.

Errors come back as \`{url, error}\` entries. Common failures: timeout, 4xx/5xx HTTP, DNS failure. The agent should treat partial-success as the norm and proceed with the URLs that did return.`,
  bestFor: [
    'Bulk fetch from a known URL list',
    'Comparison shopping / aggregator workflows',
    'Refreshing a snapshot of multiple data sources at once',
  ],
  avoidWhen: [
    'Single URL — web_fetch is simpler',
    'JS-rendered pages — browser_navigate per page (sequential)',
    'Hundreds of URLs — consider a dedicated pipeline outside the agent loop',
  ],
  gotchas: [
    'Per-URL body cap (typically smaller than single web_fetch). Aggregate response stays bounded.',
    'Server-side concurrency limit — passing 50 URLs is sequential batches under the hood.',
    'Errors are per-URL, not all-or-nothing. Always inspect each entry.',
    'No global timeout — the slowest URL drives the wall-clock cost. For predictable timing, batch smaller.',
  ],
  examples: [
    {
      caption: 'Fetch three documentation pages in parallel',
      body: `{
  "urls": [
    "https://docs.example.com/auth",
    "https://docs.example.com/sessions",
    "https://docs.example.com/permissions"
  ]
}`,
      note: 'Returns three records, one per URL, each with status / body / error?.',
    },
  ],
  relatedTools: ['web_fetch', 'web_search', 'browser_navigate'],
  relatedStages: [],
  codeRef:
    'Geny / backend/tools/custom/web_fetch_tools.py:WebFetchMultipleTool',
};

const ko: ToolDetailContent = {
  body: `web_fetch_multiple은 호스트 네트워크에서 URL 리스트를 병렬 fetch. \`{url, status, body, error?}\` 레코드 리스트 반환 — 요청된 URL당 하나. 에러는 URL별; 한 실패가 전체 배치를 죽이지 않음.

Fan-out fetch에 사용: N개 유사 엔드포인트에서 데이터 수집, 페이지 리스트 스크래프, vendor URL 간 경쟁 pricing 배치 fetch. 병렬성은 서버 측 bounded(보통 5-10 동시), 50 URL 전달은 ~5-10 배치 순차 실행.

각 URL은 web_fetch와 같은 제약 — JS 렌더링 없음, 호스트 IP origin, body 크기 cap. 집계 응답이 클 수 있음; 도구가 임계값 초과(보통 각 100KB) URL별 body truncate해 응답 bounded 유지.

에러는 \`{url, error}\` 항목으로 옴. 흔한 실패: timeout, 4xx/5xx HTTP, DNS 실패. 에이전트가 partial-success를 norm으로 취급하고 반환된 URL로 진행해야.`,
  bestFor: [
    '알려진 URL 리스트에서 벌크 fetch',
    '비교 쇼핑 / aggregator 워크플로',
    '여러 데이터 소스 스냅샷 한 번에 새로고침',
  ],
  avoidWhen: [
    '단일 URL — web_fetch가 더 간단',
    'JS 렌더 페이지 — 페이지당 browser_navigate(순차)',
    '수백 URL — 에이전트 루프 외 dedicated 파이프라인 검토',
  ],
  gotchas: [
    'URL별 body cap(보통 단일 web_fetch보다 작음). 집계 응답 bounded 유지.',
    '서버 측 동시성 제한 — 50 URL 전달은 내부적으로 순차 배치.',
    '에러는 URL별, all-or-nothing 아님. 항상 각 항목 검사.',
    '글로벌 timeout 없음 — 가장 느린 URL이 wall-clock 비용 주도. 예측 가능한 타이밍은 더 작은 배치.',
  ],
  examples: [
    {
      caption: '문서 페이지 셋 병렬 fetch',
      body: `{
  "urls": [
    "https://docs.example.com/auth",
    "https://docs.example.com/sessions",
    "https://docs.example.com/permissions"
  ]
}`,
      note: 'URL당 하나, 각 status / body / error?와 함께 세 레코드 반환.',
    },
  ],
  relatedTools: ['web_fetch', 'web_search', 'browser_navigate'],
  relatedStages: [],
  codeRef:
    'Geny / backend/tools/custom/web_fetch_tools.py:WebFetchMultipleTool',
};

export const webFetchMultipleToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
