/** Tool detail — web_fetch (Geny / web family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `web_fetch retrieves a single URL from the host network — server-side, no JS execution. Geny\'s lightweight cousin to the executor\'s WebFetch with very similar semantics; the distinction is mostly historical (Geny shipped with its own implementation before the executor catalog existed).

Same trade-offs as the executor WebFetch: fast for static content, blind to SPAs, no cookie persistence between calls. For JS-rendered pages use browser_navigate.

Returns the response body (HTML stripped of scripts; JSON / text passed through; small images base64-encoded). Default 30s timeout; pass a longer timeout for slow servers.`,
  bestFor: [
    'Reading a known static URL (docs, blog posts, README)',
    'Calling REST APIs with simple JSON',
    'Verifying a link before referencing',
  ],
  avoidWhen: [
    'Page needs JavaScript — browser_navigate',
    'Doing search — web_search',
    'Need many URLs — web_fetch_multiple',
  ],
  gotchas: [
    'Server-side network — host IP is the source. Some content is geo-locked.',
    'No JS rendering — SPAs return their loading-state HTML.',
    'Default 30s timeout. Slow servers need explicit `timeout_ms`.',
    'Body cap (~10MB). Larger payloads truncate.',
  ],
  examples: [
    {
      caption: 'Fetch a JSON endpoint',
      body: `{
  "url": "https://api.example.com/data.json"
}`,
      note: 'Returns the JSON body verbatim.',
    },
  ],
  relatedTools: ['web_fetch_multiple', 'web_search', 'browser_navigate'],
  relatedStages: [],
  codeRef:
    'Geny / backend/tools/custom/web_fetch_tools.py:WebFetchTool',
};

const ko: ToolDetailContent = {
  body: `web_fetch는 호스트 네트워크에서 단일 URL retrieve — 서버 측, JS 실행 없음. 실행기의 WebFetch와 매우 유사한 시맨틱의 Geny의 가벼운 사촌; 구별은 대부분 역사적(실행기 카탈로그 존재 전 Geny가 자체 구현 ship).

실행기 WebFetch와 같은 trade-off: 정적 콘텐츠에 빠름, SPA에 blind, 호출 간 쿠키 영속 없음. JS 렌더 페이지는 browser_navigate.

응답 body 반환(scripts 제거된 HTML; JSON / 텍스트 통과; 작은 이미지 base64 인코딩). 기본 30초 timeout; 느린 서버는 더 긴 timeout 전달.`,
  bestFor: [
    '알려진 정적 URL 읽기(문서, 블로그 포스트, README)',
    '단순 JSON으로 REST API 호출',
    '참조 전 링크 검증',
  ],
  avoidWhen: [
    '페이지가 JavaScript 필요 — browser_navigate',
    '검색 — web_search',
    '많은 URL 필요 — web_fetch_multiple',
  ],
  gotchas: [
    '서버 측 네트워크 — 호스트 IP가 소스. 일부 콘텐츠 geo-lock.',
    'JS 렌더링 없음 — SPA는 로딩 상태 HTML 반환.',
    '기본 30초 timeout. 느린 서버는 명시적 `timeout_ms` 필요.',
    'Body cap(~10MB). 큰 페이로드 truncate.',
  ],
  examples: [
    {
      caption: 'JSON 엔드포인트 fetch',
      body: `{
  "url": "https://api.example.com/data.json"
}`,
      note: 'JSON body verbatim 반환.',
    },
  ],
  relatedTools: ['web_fetch_multiple', 'web_search', 'browser_navigate'],
  relatedStages: [],
  codeRef:
    'Geny / backend/tools/custom/web_fetch_tools.py:WebFetchTool',
};

export const webFetchGenyToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
