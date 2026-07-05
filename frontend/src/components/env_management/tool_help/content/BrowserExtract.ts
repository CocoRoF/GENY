/** Tool detail — BrowserExtract (geny-executor / browser family, an-web engine). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `BrowserExtract pulls data out of the current page by CSS selector — the precision complement to the snapshot's overview. Four modes: 'css' (visible text per match, default), 'structured' (text + attributes), 'json' (parse JSON islands like script[type="application/ld+json"]), and 'html' (raw HTML per match).

Use it when the snapshot's node budget hides what you need: full tables, long article bodies, lists of prices/links, or embedded structured data.`,
  bestFor: [
    'Scraping tables, lists, and repeated cards',
    'Reading a full article body the snapshot truncated',
    'Extracting embedded JSON-LD / data islands',
  ],
  avoidWhen: [
    'You just need the page overview — the snapshot is already there',
    'Interacting with elements — that is BrowserAct',
  ],
  gotchas: [
    'Errors if no page is open — call BrowserNavigate first.',
    'limit caps matches (default 100); results are JSON.',
  ],
  examples: [
    {
      caption: 'Extract all article headlines',
      body: `{"query": ".titleline > a", "mode": "css"}`,
      note: 'Visible text of each match.',
    },
    {
      caption: 'Structured rows with attributes',
      body: `{"query": "table.prices tr", "mode": "structured", "limit": 50}`,
      note: 'Text plus attributes (href, class, …) per row.',
    },
  ],
  relatedTools: ['BrowserNavigate', 'BrowserSnapshot', 'BrowserAct'],
  relatedStages: [],
  codeRef:
    'geny-executor / tools/built_in/browser_tools.py:BrowserExtractTool',
};

const ko: ToolDetailContent = {
  body: `BrowserExtract는 CSS 셀렉터로 현재 페이지에서 데이터를 추출합니다 — 스냅샷의 개요를 보완하는 정밀 도구. 4가지 모드: 'css'(매치별 가시 텍스트, 기본), 'structured'(텍스트+속성), 'json'(script[type="application/ld+json"] 같은 JSON 아일랜드 파싱), 'html'(매치별 raw HTML).

스냅샷의 노드 예산이 필요한 내용을 가릴 때 사용하세요: 전체 표, 긴 본문, 가격/링크 목록, 내장 구조화 데이터.`,
  bestFor: [
    '표·리스트·반복 카드 스크래핑',
    '스냅샷에서 잘린 전체 본문 읽기',
    '내장 JSON-LD / 데이터 아일랜드 추출',
  ],
  avoidWhen: [
    '페이지 개요만 필요 — 스냅샷에 이미 있음',
    '요소 상호작용 — 그건 BrowserAct',
  ],
  gotchas: [
    '열린 페이지가 없으면 에러 — 먼저 BrowserNavigate 호출.',
    'limit이 매치 수를 제한(기본 100); 결과는 JSON.',
  ],
  examples: [
    {
      caption: '모든 기사 제목 추출',
      body: `{"query": ".titleline > a", "mode": "css"}`,
      note: '매치별 가시 텍스트.',
    },
    {
      caption: '속성 포함 구조화 행',
      body: `{"query": "table.prices tr", "mode": "structured", "limit": 50}`,
      note: '행마다 텍스트 + 속성(href, class, …).',
    },
  ],
  relatedTools: ['BrowserNavigate', 'BrowserSnapshot', 'BrowserAct'],
  relatedStages: [],
  codeRef:
    'geny-executor / tools/built_in/browser_tools.py:BrowserExtractTool',
};

export const browserExtractToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
