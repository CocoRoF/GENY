/** Tool detail — browser_close (Geny / browser family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `browser_close shuts down the Playwright browser session, releasing all resources and clearing all state — cookies, localStorage, page state, network history. The next browser_navigate will boot a fresh browser; nothing carries over.

Use cases:
  - End-of-flow cleanup ("done browsing; release the resources")
  - Reset for a clean slate (login as a different user, test in incognito-like state)
  - Memory pressure: long sessions with many open pages can balloon RAM

Idempotent — closing an already-closed (or never-opened) browser returns success without error. The next navigate will simply boot a new browser.

Cost / resource note: the browser is a heavy subprocess (Chrome instance). Long sessions that don\'t close it accumulate memory. Hosts may auto-close after a host-defined idle period; explicit browser_close is still cleaner.`,
  bestFor: [
    'End of a browse-driven task',
    'Resetting between unrelated browse flows in the same session',
    'Memory cleanup in long sessions',
  ],
  avoidWhen: [
    'You\'re mid-flow — closing now means re-bootstrapping next call',
    'Brief pauses — the browser idle is fine',
  ],
  gotchas: [
    'Idempotent — calling on a never-opened browser returns success without doing anything.',
    'All state lost: subsequent browser_navigate is a fresh-incognito-like boot.',
    'Some host configs auto-close after idle; check whether explicit close is even necessary.',
    'In-flight network requests are abandoned. Pending downloads / uploads die with the browser.',
  ],
  examples: [
    {
      caption: 'Cleanup after browsing is done',
      body: `{}`,
      note: 'No arguments. Browser closed; subsequent browser_* tools start fresh.',
    },
  ],
  relatedTools: ['browser_navigate', 'browser_page_info'],
  relatedStages: [],
  codeRef:
    'Geny / backend/tools/custom/browser_tools.py:BrowserCloseTool',
};

const ko: ToolDetailContent = {
  body: `browser_close는 Playwright 브라우저 세션 셧다운, 모든 리소스 해제 및 모든 상태 clear — 쿠키, localStorage, 페이지 상태, 네트워크 history. 다음 browser_navigate는 새 브라우저 부팅; 아무것도 carry over 안 됨.

사용 사례:
  - End-of-flow cleanup("브라우징 끝; 리소스 해제")
  - 깨끗한 슬레이트 리셋(다른 사용자로 로그인, incognito 같은 상태로 테스트)
  - 메모리 압박: 많은 페이지 연 장기 세션은 RAM 부풀어 오를 수 있음

Idempotent — 이미 닫힌(또는 한 번도 안 연) 브라우저 닫기는 에러 없이 성공 반환. 다음 navigate가 단순히 새 브라우저 부팅.

비용 / 리소스 노트: 브라우저는 무거운 서브프로세스(Chrome 인스턴스). 닫지 않는 장기 세션은 메모리 누적. 호스트가 호스트 정의 idle 기간 후 자동 닫기 가능; 명시적 browser_close는 여전히 더 깔끔.`,
  bestFor: [
    '브라우즈 주도 task 끝',
    '같은 세션에서 무관한 브라우즈 flow 간 리셋',
    '장기 세션의 메모리 cleanup',
  ],
  avoidWhen: [
    'Flow 중간 — 지금 닫으면 다음 호출에 re-bootstrap',
    '짧은 일시정지 — 브라우저 idle은 fine',
  ],
  gotchas: [
    'Idempotent — 한 번도 안 연 브라우저 호출은 아무것도 안 하고 성공 반환.',
    '모든 상태 손실: 후속 browser_navigate는 fresh-incognito 같은 부팅.',
    '일부 호스트 설정은 idle 후 자동 닫기; 명시적 close가 필요한지 확인.',
    '실행 중 네트워크 요청 abandon. Pending 다운로드 / 업로드는 브라우저와 함께 죽음.',
  ],
  examples: [
    {
      caption: '브라우징 끝난 후 cleanup',
      body: `{}`,
      note: '인자 없음. 브라우저 닫힘; 후속 browser_* 도구가 fresh하게 시작.',
    },
  ],
  relatedTools: ['browser_navigate', 'browser_page_info'],
  relatedStages: [],
  codeRef:
    'Geny / backend/tools/custom/browser_tools.py:BrowserCloseTool',
};

export const browserCloseToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
