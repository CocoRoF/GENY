/** Tool detail — WebFetch (executor / web family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `WebFetch retrieves a single URL and returns its content. Designed for static HTTP-fetchable resources — pages that don't require JavaScript execution. For JS-rendered sites, the agent needs the Geny browser tools (browser_navigate / browser_evaluate).

The fetch is server-side from the executor process — the LLM doesn't get to run code in the user's browser. This means the request comes from the host's network and uses the host's egress credentials. Authenticated APIs typically need an explicit token via header (passed in the call), not implicit cookies.

Response handling:
  - HTML: stripped of scripts / styles, returned as readable text. The agent gets the article content, not the page chrome.
  - JSON: returned as-is for further parsing.
  - Plain text / Markdown: passed through.
  - Binary: base64-encoded for non-image types; images returned as image content blocks.
  - Other: a content-type-aware reader picks the closest representation.

Default timeout 30 seconds. Pages that take longer are aborted; the agent gets an error and can retry with a longer timeout. The body size is capped (~10MB) to protect the context window — paginated APIs are usually a better fit for large datasets.`,
  bestFor: [
    'Reading static documentation pages, blog posts, README files',
    'Calling REST APIs with simple JSON payloads',
    'Fetching public datasets or text resources by URL',
    'Verifying an external link\'s content before referencing it',
  ],
  avoidWhen: [
    'The page requires JavaScript to render — use browser_navigate instead',
    'The URL is behind a login wall the agent can\'t authenticate to — fail before fetching',
    'You need to interact with the page (click, fill forms) — browser tools are the right surface',
    'You\'re scraping at scale — set up a pipeline with rate limits, not Bash + WebFetch loops',
  ],
  gotchas: [
    'Server-side fetch — the request comes from the host network, not the user\'s browser. Some content gates by IP / region.',
    'HTML is stripped to readable text. JS-driven content (SPAs, async-loaded pages) often comes back empty.',
    'Default 30s timeout. Slow pages need explicit timeout_ms; runaway fetches don\'t hang the loop forever.',
    'Body size capped — large responses get truncated with a marker; fetch a more specific URL or use pagination.',
    'Cookies don\'t persist across calls. Authenticated requests need the auth header passed every call.',
  ],
  examples: [
    {
      caption: 'Fetch a JSON API endpoint',
      body: `{
  "url": "https://api.github.com/repos/anthropics/claude-code",
  "headers": {"Accept": "application/json"}
}`,
      note: 'Returns the JSON body. Auth headers added per call when needed.',
    },
  ],
  relatedTools: ['WebSearch', 'browser_navigate'],
  relatedStages: [],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/web_fetch_tool.py:WebFetchTool',
};

const ko: ToolDetailContent = {
  body: `WebFetch는 단일 URL을 가져와 콘텐츠를 반환합니다. 정적 HTTP fetch 가능한 리소스용 — JavaScript 실행이 필요 없는 페이지. JS 렌더 사이트는 Geny browser 도구(browser_navigate / browser_evaluate)가 필요.

Fetch는 실행기 프로세스에서 서버 측에서 일어남 — LLM이 사용자 브라우저에서 코드 실행하는 게 아님. 즉 요청이 호스트 네트워크에서 오고 호스트의 egress credentials 사용. 인증된 API는 보통 implicit 쿠키가 아닌 명시적 토큰을 헤더로 전달(호출 시).

응답 처리:
  - HTML: scripts / styles 제거, 읽을 수 있는 텍스트로 반환. 에이전트는 페이지 chrome이 아닌 article 콘텐츠 받음.
  - JSON: 그대로 반환, 추가 파싱용.
  - Plain text / Markdown: 통과.
  - Binary: 이미지 아닌 타입은 base64 인코딩; 이미지는 image 콘텐츠 블록으로 반환.
  - 기타: content-type 인식 reader가 가장 가까운 표현 선택.

기본 timeout 30초. 더 긴 페이지는 abort; 에이전트가 에러 받고 더 긴 timeout으로 재시도 가능. body 크기 캡(~10MB) — 컨텍스트 창 보호; 큰 데이터셋은 보통 페이지네이션 API가 더 적합.`,
  bestFor: [
    '정적 문서 페이지, 블로그 포스트, README 파일 읽기',
    '단순 JSON 페이로드의 REST API 호출',
    'URL로 공개 데이터셋 또는 텍스트 리소스 fetch',
    '참조 전 외부 링크 콘텐츠 검증',
  ],
  avoidWhen: [
    '페이지가 렌더에 JavaScript 필요 — browser_navigate 사용',
    'URL이 에이전트가 인증 못 하는 로그인 wall 뒤 — fetch 전 실패',
    '페이지와 상호작용 필요(클릭, 폼 채우기) — browser 도구가 적합',
    '대규모 스크래핑 — Bash + WebFetch 루프 대신 rate limit 있는 파이프라인 셋업',
  ],
  gotchas: [
    '서버 측 fetch — 사용자 브라우저 아닌 호스트 네트워크에서 요청. 일부 콘텐츠는 IP / 지역으로 게이트.',
    'HTML은 읽을 수 있는 텍스트로 strip. JS 주도 콘텐츠(SPA, 비동기 로드 페이지)는 종종 빈 결과 반환.',
    '기본 30초 timeout. 느린 페이지는 명시적 timeout_ms 필요; 폭주 fetch가 루프 영원히 hang 안 함.',
    'Body 크기 캡 — 큰 응답은 마커와 함께 truncation; 더 구체적 URL fetch 또는 페이지네이션 사용.',
    '쿠키는 호출 간 영속 안 됨. 인증 요청은 매 호출 auth 헤더 전달 필요.',
  ],
  examples: [
    {
      caption: 'JSON API 엔드포인트 fetch',
      body: `{
  "url": "https://api.github.com/repos/anthropics/claude-code",
  "headers": {"Accept": "application/json"}
}`,
      note: 'JSON body 반환. 필요 시 호출당 auth 헤더 추가.',
    },
  ],
  relatedTools: ['WebSearch', 'browser_navigate'],
  relatedStages: [],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/web_fetch_tool.py:WebFetchTool',
};

export const webFetchToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
