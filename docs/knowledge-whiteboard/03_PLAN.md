# 03 — 단계별 실행 계획

> *02 의 목표 아키텍처를 5 개 Phase 로 쪼갠다. 각 Phase 는 독립적으로 출시 가능해야 하고, 다음 Phase 에 의존하지 않는다.*

작성일: **2026-05-07**
선행 문서: [01_ANALYSIS.md](01_ANALYSIS.md), [02_ARCHITECTURE.md](02_ARCHITECTURE.md)

---

## Phase 표

| Phase | 한 줄 요약 | 사용자에게 보이는 가치 | 추정 규모 |
|---|---|---|---|
| **P0** | 기반 다지기 (CaptureEvent + 첨부 저장 + Inbox + **확장 후크 자리** + **ViewLedger 데이터 모델**) | 없음 (인프라) | 1~2 일 |
| **P1** | 화이트보드 UI (Inbox 카드뷰 + 이미지 임베드 + 캡처 툴바 + **3 슬롯 선언**) | 노트에 이미지·첨부를 붙일 수 있음 | 2~3 일 |
| **P2** | Spotlight 공유 + VTuber 실시간 인지 + **ViewLedger 통합 (도구·시스템 프롬프트 데코레이션)** | "이거 봐줘" 가 동작 + VTuber 가 "전에 봤던 거지?" 를 안다 | 3~4 일 |
| **P3** | 스크린 캡처 / 클립보드 / 파일드롭 내장 소스 + 비전 모델 분기 | 화면을 찍어 VTuber와 즉시 이야기 | 2~3 일 |
| **P4** | 분석 도구 (OCR / describe) + Library 영구화 강화 + 보안 + **PostCaptureHook 일반화** + `mentioned` 휴리스틱 | VTuber가 캡처를 자동 묘사하고 영속화 | 2~3 일 |
| **P5** | **자동 정리 / 클러스터링** (`OrganizerStrategy` + SuggestionsBar + **view 신호 활용**) | Inbox 폭주를 막는다 — VTuber에게 더 좋은 Curated 가 쌓인다 | 3~4 일 |

> 추정 규모는 1인 풀스택 작업 기준. 병렬 작업하면 단축 가능.

각 Phase 는 자기 완결 PR로 출시되며, 끝났다고 판정하는 **Definition of Done (DoD)** 을 명시한다.

---

## Phase 0 — 기반 다지기

### 목표
신규 데이터 모델과 저장 경로만 추가한다. **사용자에게 보이는 변화는 없다.** UI 작업과 분리해서 안전하게 머지하기 위함.

### 작업

1. **타입/모델 추가** (확장 후크 미리 박기)
   - [backend/service/whiteboard/types.py](../../backend/service/whiteboard/) (신규 폴더): `CaptureEvent`, `CapturePayload`, `SpotlightItem` dataclass 정의
   - **`CaptureType` enum 에 `audio`, `drawing` 미리 포함** — 실제 처리는 후속이지만 데이터 모델 자리만 미리 만든다 (마이그레이션 비용 0). 02 §11.2 참조
   - **인증 어댑터 패턴**: `whiteboard_controller._resolve_user(request)` 가 세션 cookie / Bearer ingest token 분기점을 코드 주석으로라도 표시 (브라우저 익스텐션 후크). 02 §11.6 참조
   - 단, 신규 타입의 동작 코드와 토큰 검증은 P1+ 또는 백로그까지 비활성

2. **저장 경로 확장**
   - `UserOpsidianManager.CATEGORIES` 에 `inbox` 추가
   - `_attachments/` 디렉터리 생성 헬퍼 (`ensure_attachments_dir`, `save_attachment`, `read_attachment`, `list_attachments`)
   - `_captures.jsonl` append-only 로깅 헬퍼
   - **`_view_ledger/` 디렉터리** 생성 헬퍼만. 실제 사용은 P2

3. **ViewLedger 데이터 모델 + 빈 구현** (확장 후크 — 02 §6.4)
   - `backend/service/whiteboard/view_ledger.py` 신규
   - `ViewKey`, `ViewRecord`, `ViewEventType` enum (5종 분리 카운트) 정의
   - `ViewLedger` 클래스: `record(key, event_type, context=None)`, `get(key) -> ViewRecord`, `decorate(agent_id, items, fields=("filename",)) -> items_with_view`
   - **이 단계에서는 함수 시그니처와 JSONL append 동작만**. 도구 통합은 P2 에서
   - 단위 테스트: 동시 append, 키 격리 (`agent_id` 다르면 따로), 5종 이벤트 카운트 분리

4. **컨트롤러 골격**
   - `backend/controller/whiteboard_controller.py` (신규)
   - `POST /api/opsidian/captures` 엔드포인트 — 첨부 저장 + Inbox draft note 생성 + capture_id 반환
   - `GET /api/opsidian/attachments/{path}` — 바이너리 다운로드

5. **마이그레이션 / 호환성**
   - 기존 사용자 vault 에 `inbox/` 폴더만 lazy 생성. 기존 노트 영향 없음

### Definition of Done
- 단위 테스트: CaptureEvent 인입 → 첨부 파일 + Inbox draft note 생성 → 다시 다운로드 가능
- 단위 테스트: ViewLedger 가 동일 (agent_id, note_id) 에 대해 5종 이벤트를 분리 카운트하고 다른 agent_id 와 격리
- 기존 `/api/opsidian/*` 엔드포인트 모든 회귀 통과
- 사용자 UI 는 무변경 (Inbox 카테고리는 사이드바에 보이지 않음, ViewLedger 는 작성만 가능 / 도구 통합 없음)

### 위험
- 첨부 디렉터리 권한 (멀티 사용자 storage root 의 chmod) → 기존 `_user_opsidian/{user}/` 와 동일 정책 사용
- 큰 파일 업로드 한계 → 50MB 기본, env 로 조절

---

## Phase 1 — 화이트보드 UI

### 목표
사용자가 Inbox 를 보고, 캡처를 카드형으로 훑고, 노트 안에 이미지를 임베드할 수 있다. **VTuber 연동은 아직 없다.**

### 작업

1. **사이드바 / 카테고리**
   - [UserOpsidianView.tsx](../../frontend/src/components/user-opsidian/UserOpsidianView.tsx) `CATEGORY_ICONS`, `CATEGORY_COLORS` 에 `inbox` 추가
   - 사이드바에 "📥 Inbox" 표시 + 미정리 캡처 개수 배지

2. **Inbox 카드 뷰**
   - 신규 `InboxPanel.tsx`: 캡처 목록 카드 그리드
     - 이미지면 썸네일, 텍스트면 발췌, 음성이면 파형/플레이 버튼
     - 카드 클릭 → 노트 편집 모드로 전환 (기존 NoteViewer 재사용)
     - 카드 우상단: "정리됨 표시" / 삭제 / 공유 버튼

3. **첨부 임베드 렌더 (dispatch table)**
   - 신규 `AttachmentEmbed.tsx`: ReactMarkdown 의 커스텀 컴포넌트로 등록
   - `![[file.png]]` wikilink 패턴을 `<img src="/api/opsidian/attachments/...">` 로 치환
   - **확장자 → 렌더러 dispatch table** 형태로 작성 — 새 타입 추가 = 한 줄 (02 §11.2)
   - P1 에서 채울 항목: 이미지 (.png/.jpg/.webp), 비디오 (.mp4/.webm), 오디오 (.webm/.mp3) 미리 등록 (음성 메모 후속용 자리)
   - `.excalidraw.json` 등 신규 타입은 후속 등록 자리만 비워둠

4. **3 개의 명시적 UI 슬롯** (확장 후크 — 02 §11.5)
   - `<CaptureToolbar>` (본문 패널 상단) — 등록된 capture-source 버튼 자동 렌더. P1 에서는 빈 상태
   - `<AttachmentEmbed>` (마크다운 렌더 내부) — 위 3번 항목
   - `<SuggestionsBar>` (InboxPanel 최상단) — 자동 정리 제안 카드 자리. P1 에서는 빈 컨테이너만 (P5 에서 채움)
   - 슬롯 자체를 P1 에 만들어두는 것이 핵심. 후속 Phase 가 신규 컴포넌트를 끼워 넣을 때 `UserOpsidianView.tsx` 본체를 다시 건드리지 않게 한다.

5. **드래그-드롭 / 붙여넣기 (가벼운 형태로 우선)**
   - 본문 영역에 드롭 → 첨부로 업로드 → wikilink 자동 삽입
   - 이건 P3 의 `file_drop` 소스 등록보다 먼저 들어가도 됨 (간단)

### Definition of Done
- 사용자가 Inbox 에서 캡처를 보고 클릭해 편집할 수 있다
- 마크다운에 `![[file.png]]` 를 적으면 이미지로 렌더된다
- 본문에 파일을 드래그하면 첨부로 업로드되고 링크가 자동 삽입된다
- E2E: 더미 Inbox draft note 가 카드 → 편집 → 큐레이트 (Library 모드로 기존 Curate 그대로) 까지 동작

### 위험
- ReactMarkdown 커스텀 노드 충돌 — 기존 `WikilinkPicker` / 위키링크 처리 코드와 중복 점검 필요
- 카드 그리드 성능 — 1000개 이상 시 가상 스크롤 (react-window) 도입 고려

---

## Phase 2 — Spotlight 공유 모드 + VTuber 실시간 인지 + ViewLedger 통합

### 목표
사용자가 노트 / Inbox 항목을 "Spotlight" 로 공유하면 VTuber 가 다음 턴부터 즉시 인지하고 반응한다.
**그리고 같은 노트가 두 번째로 마주칠 때 VTuber 는 그 사실을 안다** — 모든 knowledge_* 도구 결과와 spotlight 시스템 프롬프트에 view 메타가 부착된다.

### 작업

1. **SpotlightStore (백엔드)**
   - `backend/service/whiteboard/spotlight_store.py` 신규
   - in-memory dict (session_id → list[SpotlightItem]) + ticker 만료
   - 옵션) 디스크 백업 `_user_opsidian/{user}/_spotlight.json`

2. **공유 API**
   - `POST /api/opsidian/spotlight` — `{source_filename, mode: "spotlight"|"library"|"both", ttl_minutes?}` 받아서:
     - `library`: 기존 `curatedKnowledgeApi.curateNote` 호출
     - `spotlight`: SpotlightStore 에 추가
     - `both`: 둘 다
   - `DELETE /api/opsidian/spotlight/{item_id}` — 해제
   - `GET /api/opsidian/spotlight` — 현재 세션의 활성 항목

3. **PromptBuilder 신규 섹션**
   - `backend/service/prompt/sections/spotlight_context.py` 신규 (또는 [sections.py](../../backend/service/prompt/sections.py) 에 함수 추가)
   - `SpotlightContextSection`: 활성 항목들을 사람이 읽을 텍스트로 렌더
   - 이미지 첨부가 있고 모델이 비전 가능하면 content block list 반환 (이미지 포함)
   - 비전 불가 모델: 텍스트 placeholder + (P4 에서 자동 캡션)
   - **렌더 시 `ViewLedger.decorate(agent_id, items)` 통과 필수** — 각 항목에 `⚑ 이전에 N회 본 자료` 또는 `⚑ 처음 보는 자료` 자연어 힌트 부착, 동시에 `injected` 이벤트 1회 기록 (작업 5)

4. **DynamicPersonaSystemBuilder 통합**
   - 정적 tail 블록 리스트에 `SpotlightContextSection` 추가
   - 페르소나 직후, MemoryContext 직전 위치 (우선순위 조정)
   - **페르소나 가이드라인 1줄 추가** ([backend/service/persona/](../../backend/service/persona/) 정적 가이드라인 자리에): "`⚑` 표시가 '이전에 본 자료' 면 처음 마주친 듯 다루지 말고 이전 맥락에 이어서 말하라. 처음 보는 자료는 새 정보로 받아라." (02 §6.4.6)

5. **ViewLedger ↔ knowledge_*  도구 통합** (핵심 신규 — 02 §6.4.4)
   - [backend/tools/built_in/knowledge_tools.py](../../backend/tools/built_in/knowledge_tools.py) 의 4개 도구(`knowledge_search`, `knowledge_read`, `knowledge_list`, `knowledge_promote`) 결과 직렬화 직전에 `ViewLedger.decorate(agent_id, results)` 한 줄 호출
   - 각 도구는 호출과 동시에 적절한 이벤트 기록:
     - `knowledge_search` → 매 hit 에 `searched`
     - `knowledge_list` → 매 항목에 `listed`
     - `knowledge_read` → 해당 파일에 `read`
     - `knowledge_promote` → 해당 파일에 `read` + `mentioned`
   - `SpotlightContextSection.render` → 매 spotlight 항목에 `injected` (작업 3)
   - `agent_id` 추출: 세션에서 활성 페르소나/캐릭터 식별자 (이미 `PersonaProvider` 가 보유). P0 에 식별 위치 메모해 두기
   - **회귀 안전장치**: 데코레이션이 실패해도 도구 결과 자체는 손상되지 않도록 best-effort try/except — view 가 누락되는 것이 도구 실패보다 낫다

6. **`[USER_SHARED]` 트리거**
   - 새 spotlight 항목 add 시점에 emitter 가 `thinking_trigger.py` 와 같은 패턴으로 `[USER_SHARED] type=... title=... excerpt=... seen_before=true|false` 메시지를 다음 턴 입력 큐에 1회 주입
   - **`seen_before` 필드** 는 ViewLedger 조회 결과 — 같은 노트를 두 번째 spotlight 할 때 트리거 자체에 그 사실이 박힘
   - VTuber 페르소나 가이드라인 한 줄 추가: "사용자가 공유한 콘텐츠를 자연스럽게 화제로 꺼내라. 이미 본 자료라면 이어서 말하라."

7. **WebSocket 이벤트**
   - [chat_stream.py](../../backend/ws/) 에 `user_shared` 이벤트 타입 추가
   - 프런트엔드 `VTuberChatPanel` 에 핀 카드 컴포넌트 추가 (썸네일 + 제목 + 해제 버튼 + **이전 노출 횟수 작은 배지**)

8. **UserOpsidianView 의 공유 UI**
   - 기존 "Curate" 버튼을 "Share with VTuber" 드롭다운으로 변경
     - "📚 Library (검색용으로 보내기)"
     - "🎯 Spotlight (지금 같이 보기)"
     - "🌟 Both"
   - 선택지 옆에 **"VTuber 가 이전에 N회 본 자료입니다"** 작은 안내 (ViewLedger 조회) — 사용자도 같은 정보를 본다

### Definition of Done
- 사용자가 노트를 Spotlight 로 공유하면 ≤ 5초 안에 VTuber 가 반응한다 (WS 트리거 + 다음 턴 즉시 인지)
- 공유 후 30분 후 자동으로 컨텍스트에서 사라진다
- 두 명 이상의 동시 사용자에서 spotlight 가 세션별로 격리된다
- E2E: "이 노트 봐줘" → VTuber 채팅에 핀 카드 표시 → VTuber 가 노트 내용을 언급
- **E2E: 같은 노트를 두 번째 spotlight 했을 때 VTuber 의 응답이 1회차와 다른 어법 (전제: "이전에 ⚑ 표시" 인지) 으로 나옴** — 휴리스틱 검증 (응답 텍스트에 "이전", "지난번", "다시", "또" 등 회상 어휘 포함률 측정)
- **단위: `knowledge_search` 가 같은 쿼리에 같은 결과 → 두 번째 호출 결과의 `_view.counts.searched` 가 1 만큼 증가**
- **단위: `SpotlightContextSection` 렌더 시 모든 항목에 `_view` 메타 포함**

### 위험
- 멀티 세션 (한 사용자가 여러 채팅 세션) 시 spotlight 적용 범위 모호 → 기본은 active session 만, UI 에서 "모든 내 세션에 공유" 옵션
- `[USER_SHARED]` 트리거가 `[THINKING_TRIGGER]` 와 충돌 (idle 발화) → 우선순위 정의: USER_SHARED 가 우선
- ViewLedger 가 도구의 hot path 에 들어감 → 데코레이션은 in-memory dict 조회 + best-effort write. 동시성 안전 위해 lock 한 개 (도구 결과당) 이상은 두지 않음
- `agent_id` 식별이 세션 메타에서 누락된 경우 → fallback `"default"` 키로 기록 (격리 약화 위험은 single-agent 환경에서 무시 가능)
- view 데코레이션이 빠진 신규 도구 추가 시 ViewLedger 가 데이터를 놓침 → §11.8 후크 무결성 체크리스트로 PR 단계에서 잡음

---

## Phase 3 — 캡처 소스 (스크린 / 클립보드 / 파일 드롭) + 비전 분기

### 목표
P1 의 빈 `CaptureToolbar` 슬롯을 채운다. 사용자는 화면을 찍어 즉시 VTuber 와 이야기할 수 있다.

### 작업

1. **CaptureSource 클라이언트 레지스트리**
   - `frontend/src/lib/captureSources.ts` 신규 — 02 §5.2 명세
   - `registerCaptureSource`, `listCaptureSources`, `useCaptureSources` 훅

2. **내장 소스 3종**
   - **screen_capture** — `navigator.mediaDevices.getDisplayMedia()` → 캔버스 1프레임 캡처 → blob (`image/png`) → `POST /api/opsidian/captures`
     - "전체 화면 / 창 / 탭" 선택 다이얼로그는 브라우저 기본 UI 사용
     - 캡처 직후 미니 미리보기 모달 → "Spotlight / Library / 둘 다 / 그냥 Inbox에"
   - **clipboard_paste** — `navigator.clipboard.read()` → 이미지/텍스트 분기 → 업로드
   - **file_drop** — 본문 패널 전체에 dropzone (P1에서 이미 만들었으면 재사용)

3. **CaptureToolbar 채우기**
   - `useCaptureSources()` 로 등록된 소스를 버튼으로 자동 렌더
   - 미가용 소스 (예: HTTPS 가 아닌 환경의 `getDisplayMedia`) 는 비활성/숨김

4. **즉시 공유 지름길 (UX)**
   - 캡처 성공 모달에서 단축키 `S` → Spotlight, `L` → Library, `B` → Both, `Enter` → Inbox 만
   - "다음부터 이 선택 기억" 토글

5. **비전 모델 분기 (백엔드)**
   - `SpotlightContextSection` 이 모델 capability 조회 → 분기
     - 비전: image content block 추가
     - 비텍스트: P4 의 자동 캡션이 들어올 때까지는 "[이미지 첨부됨, 제목/캡션만 표시]" 텍스트
   - 모델 capability 조회 위치는 P0 에 식별만 하고 P3 에서 사용

### Definition of Done
- 사용자가 "스크린 캡처" 버튼 → 화면 선택 → 캡처 → "Spotlight" 한 클릭 → VTuber가 다음 턴에 화면을 보고 반응
- 클립보드에서 이미지를 복사한 뒤 본문에 붙여넣으면 첨부로 업로드되고 링크 삽입
- 모든 캡처에는 capture_id 가 부여되어 `_captures.jsonl` 에 기록
- 비전 가능 모델에서는 이미지를 직접 인식, 비전 불가 모델은 텍스트만으로도 안전하게 동작

### 위험
- `getDisplayMedia` 권한 거부 / 환경 미지원 → 친절한 에러 + 대체 안내 (파일 드롭)
- 큰 캡처 (4K) 페이로드 → 클라이언트에서 max-edge 1920px 리사이즈 + JPEG 변환 옵션
- 민감 정보 노출 사고 → 캡처 직후 미리보기 모달에서 사용자가 확인 후 명시 액션 필요 (자동 업로드 금지)

---

## Phase 4 — 분석 도구 + Library 강화 + 보안

### 목표
VTuber 가 캡처를 더 잘 다룬다. Library 영구화가 매끄러워진다. 프라이버시 가드가 명문화된다.

### 작업

1. **분석 도구**
   - `backend/tools/custom/whiteboard_tools.py` (신규)
     - `whiteboard_describe(item_id)` — vision 모델로 이미지 묘사 → 캡션 생성
     - `whiteboard_ocr(item_id)` — 텍스트 추출 (Tesseract or vision LLM)
     - `whiteboard_extract_links(item_id)` — 링크/URL 자동 추출
   - 새 도구 추가가 한 파일 안에서 BaseTool 패턴 반복으로 자연스러운 형태가 되도록 작성 (음성 전사 / drawing 렌더는 후속에 같은 파일로 추가)

2. **PostCaptureHook 일반화** (확장 후크 — 02 §11.4)
   - 신규 `backend/service/whiteboard/post_capture_hook.py`: type → 자동 분석 도구 매핑 + 디스패처
   - P4 등록 항목:
     - `image`/`screenshot` + 비전 비가용 모델 → `whiteboard_describe` 호출 후 결과를 spotlight item `excerpt` 채움
   - 후속 등록 자리 (코드 변경 없이 추가):
     - `audio` → `whiteboard_transcribe` (음성 메모 후속)
     - `drawing` → `whiteboard_render_drawing` + 비전 가능 시 image content block 동봉
   - 매핑은 일반 dict 로 노출되어 외부 플러그인이 `register_post_capture_hook("audio", tool)` 한 줄로 추가 가능

3. **`mentioned` 휴리스틱 활성화** (ViewLedger — 02 §6.4.7)
   - 응답 후처리에서 본문 안에 노트 제목 / 파일명 패턴이 나타나면 `ViewLedger.record(key, "mentioned", context=session_id)`
   - 정규식 + 활성 spotlight + 최근 read 한 노트 제목 fuzzy 매치 (편집거리 임계 + 길이 가중)
   - 정확도가 낮을 수 있으나 `mentioned` 카운트는 통계 신호로만 쓰이므로 false positive 의 비용이 낮음
   - 토글 가능 (env: `WHITEBOARD_TRACK_MENTIONED=true`). 부정확 신호를 원치 않으면 끌 수 있음

2. **Library 영구화 경로 강화**
   - `knowledge_promote` 도구 확장: `source: spotlight` 메타 보존
   - 첨부 복사: spotlight 에서 library 로 갈 때 `_curated_knowledge/{user}/_attachments/` 로 복사 (참조 깨짐 방지)
   - Curated 측 임베디드 첨부 렌더 (CuratedKnowledgeView 도 P1 의 `AttachmentEmbed` 재사용)

3. **삭제 GC**
   - `UserOpsidianManager.delete_note` 가 첨부 참조 카운트 기반 GC
   - 고아 첨부 청소 ticker (1주에 1회)

4. **보안 / 프라이버시**
   - `_user_opsidian/{user}/` 권한 점검
   - 캡처 권한 안내 모달 (첫 사용 시) — 어디 저장되고 누가 보는지 명시
   - 옵션: PII redaction (`backend/service/whiteboard/redaction.py`) — email/주민번호/카드번호 마스킹
   - Spotlight TTL 환경 변수화 (기본 30분, 사용자별 조정 가능)

5. **감사 로그**
   - `_captures.jsonl` 에 모든 캡처 / 공유 / 만료 이벤트 기록
   - 옵션: `/api/opsidian/audit` 엔드포인트로 사용자 본인이 조회

### Definition of Done
- 비전 불가 모델에서도 VTuber 가 이미지 내용을 텍스트로 정확히 묘사한다
- 노트 삭제 시 더 이상 어디서도 참조되지 않는 첨부가 자동 삭제된다
- 첫 캡처 사용 시 동의 다이얼로그가 한 번 표시된다
- TTL / 정책이 환경 변수로 조정 가능

### 위험
- OCR / vision LLM 비용 → 비전 가능 모델일 때는 호출 생략, 비가용일 때만 (toggle)
- Redaction 의 false negative → 옵트인 / 명시 옵션으로만 활성

---

## Phase 5 — 자동 정리 / 클러스터링 (본 계획 내 포함)

### 목표
Inbox 가 폭주하지 않도록, 임베딩 기반 클러스터링으로 "이 N개를 한 주제로 묶을까요?", "Library 로 올릴 만해요", "거의 같은 캡처를 합칠까요?" 를 **사용자에게 제안**한다. **자동 적용은 하지 않는다.**

### 작업

1. **OrganizerStrategy 추상화** (02 §11.7)
   - `backend/service/whiteboard/organizer.py` 신규
   - `OrganizerStrategy` Protocol + `OrganizationSuggestion` dataclass
   - `propose()` 시그니처는 `(notes, embeddings, view_snapshot)` 3 입력 — view 신호가 1급 입력 (02 §11.7)
   - `ORGANIZER_REGISTRY` 모듈 레벨 dict (전략 등록표)

2. **기본 전략 4개**
   - `EmbeddingClusterStrategy` — 임베딩 코사인 유사도로 2~10 클러스터, LLM 한 번 호출로 클러스터 라벨 생성. view 합산이 높은 클러스터부터 우선 제시
   - `NearDuplicateStrategy` — 유사도 0.92 이상은 "거의 같음" 으로 묶기 제안. view 가 한쪽에 쏠린 쌍을 우선 (사용자가 새 캡처를 자주 만들지만 한쪽만 본 케이스)
   - `TopicPromotionStrategy` — "사용자가 spotlight 했고 / 에이전트가 자주 read 한" 노트를 Library 후보로 제안. view 신호가 핵심 입력
   - **`StaleUnseenStrategy` (신규)** — 생성 후 N일이 지났고 모든 view 이벤트 카운트가 0 인 노트를 "정리 / 삭제 / 아카이브" 제안. ViewLedger 가 없으면 만들 수 없는 전략
   - 임베딩 클라이언트는 기존 `provider_bridge` 의 그것을 재사용 (Curated FAISS 와 동일 모델)

3. **실행 모델**
   - `GenyPlugin.contribute_tickers` 로 등록되는 `whiteboard_organizer_ticker`
     - 사용자가 N분 idle (마지막 캡처 / 노트 편집으로부터)
     - 마지막 실행으로부터 최소 24시간 경과
   - 또는 InboxPanel 의 "✨ 정리 제안 받기" 버튼 클릭 시 즉시
   - 결과는 `_organizer_suggestions.jsonl` 에 append, 상태 (active/accepted/rejected/snoozed) 트랙

4. **API**
   - `POST /api/opsidian/organizer/run` — 즉시 실행 (옵션: `strategy=` 로 특정 전략만)
   - `GET /api/opsidian/organizer/suggestions` — active 제안 목록
   - `POST /api/opsidian/organizer/suggestions/{id}/accept` — 적용 (그룹화 / 머지 / 승격 / 태그 부여)
   - `POST /api/opsidian/organizer/suggestions/{id}/reject` — 기각 (같은 제안 30일 내 재발 방지)

5. **UI: SuggestionsBar**
   - P1 에서 만들어둔 InboxPanel `<SuggestionsBar>` 슬롯을 채움
   - 카드 한 장 = 한 제안. 썸네일 미리보기 + 제안 라벨 + rationale + Accept / Snooze / Reject 버튼
   - Accept 시 즉시 노트 메타 갱신 (Curated 승격이라면 기존 `curatedKnowledgeApi.curateNote` 재사용)

6. **CurationEngine 과의 경계**
   - Organizer 는 **제안만**, CurationEngine 은 **실행**. 02 §11.7 매트릭스 참조
   - Organizer 가 "Library 로 올리자" 제안 → 사용자 Accept → 그제야 CurationEngine 호출
   - 이 경계가 깨지면 자동 정리가 사용자 동의 없이 Curated 를 오염시킬 수 있음. 코드 리뷰 시 명시적으로 본다

7. **엣지 케이스 / 비용**
   - Inbox 가 비거나 노트가 적으면 Organizer 는 noop
   - LLM 라벨 생성 비용 절감: 클러스터 1개당 한 번의 짧은 호출 (≤ 100 토큰)
   - 임베딩 캐시: 노트 hash → 임베딩 매핑을 `_organizer_cache.jsonl` 로 보존

### Definition of Done
- 30개 이상의 캡처가 쌓인 Inbox 에서 ticker 가 자동 발화하면 의미 있는 클러스터 제안 (1~5 개) 이 SuggestionsBar 에 나타난다
- 사용자가 Accept 하면 노트가 실제로 묶이거나 Library 로 승격되거나 태그가 부여된다
- Reject 한 제안은 30일 동안 다시 안 뜬다
- Organizer 는 어떤 경우에도 사용자 동의 없이 노트를 삭제 / 이동 / Curated 로 보내지 않는다 (단위 테스트로 보호)
- 새 전략 추가가 `ORGANIZER_REGISTRY[...] = MyStrategy()` 한 줄로 가능 (E2E 테스트로 검증)
- **`StaleUnseenStrategy` 가 ViewLedger 의 빈 키 (한 번도 안 본 노트) 를 정확히 식별**한다 (단위 테스트)
- **`TopicPromotionStrategy` 가 view 신호 없이 만든 후보와 view 신호로 만든 후보를 다르게 정렬**한다 (단위 테스트)

### 위험
- 임베딩 모델이 한국어 / 영어 혼용 노트에서 품질 떨어질 수 있음 → 다국어 모델 사용 + 사용자가 라벨 편집 가능
- 사용자가 제안에 피로감 → 동시 표시 최대 3개 + Snooze 옵션 + 사용자 활동 idle 시에만 발화
- LLM 라벨이 부정확 → 사용자가 제안 카드에서 라벨 인라인 편집 가능

---

## 백로그 (Phase 6+, 명시적 비즉시)

다음 항목은 본 사이클 비목표지만, 02 §11 의 후크 위에 **코어 변경 없이** 올라타야 한다:

| 항목 | 어느 후크 위에 | 추가되는 모듈만 |
|---|---|---|
| 자유 캔버스 (Excalidraw) | `CaptureType="drawing"` (P0 enum) + `AttachmentEmbed` dispatch (P1) + `registerCaptureSource` (P3) | 캔버스 모달 컴포넌트, `whiteboard_render_drawing` 도구 |
| 음성 메모 + 자동 전사 | `CaptureType="audio"` (P0 enum) + `AttachmentEmbed` audio (P1) + `registerCaptureSource` (P3) + `PostCaptureHook` (P4) | 마이크 레코더 컴포넌트, `whiteboard_transcribe` 도구 |
| 브라우저 익스텐션 | `_resolve_user` 인증 어댑터 (P0) + 동일 `POST /api/opsidian/captures` (P0) | 익스텐션 자체 + 토큰 발급 / 관리 UI |
| 모바일 카메라 | `<input capture="environment">` 가 file_drop 의 변형 (P3) | 거의 없음 |
| 협업 (멀티 사용자 화이트보드 공유) | (새 후크 필요) | 별도 검토 |
| 화이트보드 → ChatRoom 자동 게시 | `chat_stream` user_shared 이벤트 (P2) 의 역방향 | 별도 검토 |

**핵심 약속**: 위 표의 "코어 변경 없이" 가 깨지지 않도록, 02 §11.8 의 후크 무결성 체크리스트가 매 PR 에서 검사된다.

별도 검토가 필요한 항목 (협업, 자동 게시) 은 후크가 부족하므로 우선 본 계획이 안정화된 후 별도 분석 사이클을 돈다.

---

## 검증 / 테스트 전략

### 단위 / 통합
- `UserOpsidianManager` — `_attachments` CRUD, capture jsonl append
- `SpotlightStore` — TTL, 세션 격리, ticker 만료
- `SpotlightContextSection` — vision/non-vision 분기, 빈 상태, 다중 항목 우선순위, **view 메타 필수 부착**
- `whiteboard_controller` — 멀티파트 업로드, 잘못된 페이로드 거부, 인증 어댑터의 분기 자리 존재
- `ViewLedger` — 5종 이벤트 분리 카운트, 동시 append 안전성, agent_id 격리, decorate 가 결과 객체를 변경하지 않고 새 객체 반환 (불변성), 컴팩트 ticker
- `knowledge_*` 도구 4종 — 각 결과가 `_view` 메타를 갖고 호출 시 적절한 이벤트가 ledger 에 기록됨
- `OrganizerStrategy` (P5) — 빈 입력에서 noop, 제안 결과의 deterministic 직렬화, registry 등록 한 줄 동작, view_snapshot 입력 처리
- `PostCaptureHook` (P4) — 신규 type 등록 시 dispatch 가 작동

### E2E (Playwright)
- "스크린 캡처 → Spotlight → VTuber 응답에 키워드 포함" 시나리오
- "본문에 이미지 드롭 → 저장 → 다시 열기 → 이미지 표시"
- "Spotlight 30 분 후 자동 만료"
- "노트 삭제 → 첨부 GC"
- **"같은 노트를 두 번째 Spotlight 했을 때 VTuber 응답에 회상 어휘가 포함" — 1회차 응답과 2회차 응답을 비교 (P2)**
- **"`knowledge_search` 동일 쿼리 반복 시 결과의 `_view.counts.searched` 가 호출마다 증가" (P2)**
- "Inbox 30개 → Organizer 실행 → SuggestionsBar 에 카드 표시 → Accept → 실제 그룹화" (P5)
- "Organizer Reject → 30일 내 같은 제안 미발생" (P5)
- **"한 번도 안 본 노트가 N일 묵으면 `StaleUnseenStrategy` 가 정리 제안 카드를 띄움" (P5)**

### 회귀
- 기존 User Opsidian / Curated Knowledge / VTuber 채팅 테스트 풀이 모두 통과
- 페르소나 / 메모리 컨텍스트 출력에 spotlight 가 빈 경우 변화 없음을 확인
- Organizer 는 사용자 동의 없이 절대 자동 적용하지 않음 (P5 invariant 테스트)
- **ViewLedger 데코레이션 실패 / disable 상태에서도 `knowledge_*` 도구가 정상 동작** (best-effort 보호)

### 후크 무결성 (매 PR 검사 — 02 §11.8 미러)
- [ ] `CaptureType` enum 이 `audio`, `drawing` 포함
- [ ] `AttachmentEmbed` dispatch table 형태 유지
- [ ] `_resolve_user` 어댑터 분기 자리 명시적 존재
- [ ] `<CaptureToolbar>` / `<AttachmentEmbed>` / `<SuggestionsBar>` 슬롯이 InboxPanel/UserOpsidianView 에 선언 존재
- [ ] **모든 `knowledge_*` 도구 결과가 `ViewLedger.decorate` 통과** (P2 이후)
- [ ] **`SpotlightContextSection.render` 가 `ViewLedger.decorate` 통과 + `injected` 이벤트 기록** (P2 이후)
- [ ] **`ViewKey = (agent_id, note_id)` 분리 유지, `ViewEventType` 5종 유지**

---

## 결정 / 트레이드오프 메모

본 계획에서 **택한 결정** 과 **버린 대안**:

| 택함 | 버린 대안 | 이유 |
|---|---|---|
| Markdown + wikilink-attachment 형식 유지 | Notion-style 블록형 콘텐츠 모델 | 기존 자산 보존, Obsidian 호환, 단순함 |
| Library / Spotlight 분리 | 단일 "공유" 액션 | 라이프사이클이 다름 (영속 vs 휘발). 합치면 결국 분기 코드가 더 복잡 |
| 캡처 소스 = **클라이언트 레지스트리** | 백엔드 플러그인으로만 표현 | 캡처는 사용자 측 액션, 클라이언트가 자연 위치 |
| `[USER_SHARED]` 트리거 + 시스템 프롬프트 섹션 둘 다 | 한쪽만 | 트리거 없이는 즉시성 없음, 섹션 없이는 다음 턴 이후 사라짐. 보완 관계 |
| TTL 기반 spotlight | 명시 해제만 | 사용자가 잊고 떠나는 케이스 방어 |
| 비전 가능/불가 자동 분기 | 비전 모델만 지원 | 멀티모델 환경에서 안전. P4 의 캡션 폴백으로 균일 UX |
| Organizer = 제안만, 자동 적용 금지 | 자동 적용 (Auto-tag/auto-merge) | 사용자 신뢰 보존. 자동 적용은 한번 잘못되면 화이트보드 전체 신뢰가 깨짐 |
| 자동 정리를 본 계획에 포함 (P5) | 백로그로 미룸 | Inbox 폭주 시 화이트보드가 죽은 창고가 됨. 임베딩 인프라가 이미 있으므로 추가 비용도 낮음 |
| 확장은 후크 위에서만 (코어 미수정) | Phase 별로 그때그때 코어 수정 | 자유 캔버스 / 음성 / 익스텐션 등 후속 기능이 코어를 다시 건드리지 않게 |
| ViewLedger = 이벤트 종류별 분리 카운트 | 단일 합산 카운터 | `searched` 100회와 `read` 1회는 의미가 다름. 합치면 신호 손실, 분리해도 비용은 dict[5 keys] 한 번 |
| ViewLedger 키 = `(agent_id, note_id)` | `note_id` 만 | 멀티 에이전트 / 멀티 페르소나 환경에서 격리 필수. 미래 확장에 대비해 처음부터 키 분리 |
| view 메타를 시스템 프롬프트에 자연어로 (`⚑ 이전에 N회 본 자료`) | 구조화된 JSON 만 | LLM 이 자연어 힌트를 페르소나 어법에 더 잘 통합. 페르소나 가이드라인 1줄과 페어로 동작 |
| `mentioned` 휴리스틱 = 옵션 (env 토글) | 기본 활성 또는 비활성 영구 | false positive 위험은 있으나 통계 신호로 가치 있음. 사용자가 끌 수 있게 |

---

## 첫 PR 의 권장 범위

**Phase 0 + Phase 1 의 최소 절반** 을 한 PR 로 묶어 사용자에게 "Inbox 카테고리 + 이미지 임베드" 까지 보이게 한다. 이렇게 해야 첫 출시도 사용자 가치를 가진다 (인프라 PR 만 지나가는 침묵을 피한다).

이후 P2 (Spotlight) 부터는 PR 단위 = Phase 단위가 자연스럽다.
