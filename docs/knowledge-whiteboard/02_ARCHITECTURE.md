# 02 — 목표 아키텍처: Knowledge Whiteboard & VTuber Bridge

> *01의 갭 분석을 바탕으로, 사용자 영역을 화이트보드로 만들고 VTuber 와 실시간으로 공유할 수 있는 확장 가능한 시스템을 설계한다.*

작성일: **2026-05-07**
선행 문서: [01_ANALYSIS.md](01_ANALYSIS.md)

---

## 0. 디자인 원칙

1. **재사용 우선 / 발명 최소화** — 기존 `UserOpsidianManager`, `CuratedKnowledgeManager`, `CurationEngine`, `knowledge_*` 도구, `GenyPlugin` 표면을 그대로 쓴다.
2. **두 개의 공유 모드를 분리** — Library(영속·검색용) 와 Spotlight(휘발·즉시 반응) 는 다른 라이프사이클을 갖는다.
3. **하나의 공통 캡처 모델로 모든 입력을 수렴** — 텍스트, 이미지, 화면 캡처, 클립보드, 음성 모두 `CaptureEvent` 한 형식으로 흘러들어 동일 파이프라인을 탄다.
4. **확장은 플러그인으로** — 새 캡처 소스를 추가할 때 코어 코드 수정 없이 플러그인 등록만으로 가능해야 한다.
5. **VTuber 가 능동적으로 알 수 있게** — pull 만 하던 에이전트가 push 신호를 받을 수 있도록 트리거 채널을 만든다.

---

## 1. 시스템 다이어그램 (목표)

```
┌─────────────────── 입력 (확장 가능) ───────────────────┐
│  Screen Capture │ Clipboard │ File Drop │ Browser   │
│      Plugin     │  Plugin   │   Plugin  │   ...     │
└────────────┬───────────────────────────────────────┬┘
             │   모두 동일한 CaptureEvent 로 수렴       │
             ▼                                       ▼
        ┌────────────────────────────────────┐
        │   Capture Ingest API               │
        │   POST /api/opsidian/captures       │
        │   - 첨부 저장 (_attachments/)        │
        │   - Inbox 카테고리에 draft note     │
        └────────────────┬───────────────────┘
                         │
                         ▼
        ┌────────────────────────────────────┐
        │   User Opsidian (Whiteboard)        │
        │   ─────────────────────────────     │
        │   inbox / daily / topics / projects │
        │   /insights + _attachments/         │
        │                                     │
        │   ┌───── Whiteboard UI ─────┐       │
        │   │  Cards · Drag-Drop · 임베드│      │
        │   │  Markdown 에디터 + 첨부   │      │
        │   └────────────┬────────────┘       │
        └────────────────┼───────────────────┘
                         │ "Share with VTuber"
                ┌────────┴─────────┐
                ▼                  ▼
   ┌──────────────────┐  ┌─────────────────────┐
   │   LIBRARY 모드    │  │   SPOTLIGHT 모드     │
   │  영속 / 검색용     │  │  즉시 / 휘발성       │
   │                  │  │                    │
   │ CurationEngine    │  │ SpotlightStore     │
   │ → CuratedKnowledge│  │ (per session/turn) │
   │ (.md + vector)    │  │                    │
   └────────┬─────────┘  └──────────┬─────────┘
            │                        │
            │ knowledge_search       │ append_context
            │ knowledge_read (pull)  │ + WS push (push)
            ▼                        ▼
   ┌──────────────────────────────────────────┐
   │   VTuber / Agent 컨텍스트                  │
   │   - PromptBuilder + DynamicPersona        │
   │   - SpotlightContextSection (NEW)         │
   │   - [USER_SHARED] trigger (NEW)           │
   │   - 멀티모달 content blocks (이미지)        │
   └──────────────────────────────────────────┘
```

---

## 2. 핵심 추상화: `CaptureEvent`

모든 입력 소스가 한 형식으로 수렴해야 파이프라인 뒤쪽이 단순해진다.

### 2.1 타입 정의 (제안)

`backend/service/whiteboard/types.py` (신규)

```python
@dataclass
class CaptureEvent:
    capture_id: str            # UUID
    type: Literal["text", "image", "screenshot",
                  "audio", "link", "file", "code"]
    source: str                # "screen_capture" | "clipboard" | "browser" | ...
    payload: CapturePayload    # 타입별 페이로드
    metadata: dict[str, Any]   # 자유 메타 (window title, url, dpi, ...)
    created_at: datetime
    user_id: str
    session_id: Optional[str]  # 있으면 spotlight 후보

@dataclass
class CapturePayload:
    # 정확히 하나만 채워짐
    inline_text: Optional[str] = None
    attachment_path: Optional[str] = None  # _attachments/ 안의 상대경로
    inline_base64: Optional[str] = None    # 작은 이미지 한정
    ref_url: Optional[str] = None
```

**왜 단일 모델?**
- 캡처 소스(스크린샷, 클립보드, 음성 등)가 늘어나도 Inbox / 큐레이션 / VTuber 측 코드는 한 형식만 다루면 된다.
- 새 소스 추가 시 변경 비용이 "**플러그인 1개 추가**" 로 떨어진다.

### 2.2 저장 레이아웃 확장

```
{STORAGE_ROOT}/_user_opsidian/{username}/
├── inbox/                     ← 신규: 캡처가 처음 떨어지는 곳
│   └── 2026-05-07-091034.md   ← 캡처마다 1 draft note (자동 생성)
├── daily/ topics/ projects/ insights/
├── _attachments/              ← 신규: 바이너리 첨부
│   ├── 2026-05-07-091034.png
│   └── 2026-05-07-093210.webm
├── _captures.jsonl            ← 신규: CaptureEvent 감사 로그
└── _index.json
```

Inbox draft note 의 frontmatter:

```markdown
---
title: "Screen capture 2026-05-07 09:10:34"
category: inbox
capture_id: "01HXY..."
capture_type: screenshot
capture_source: screen_capture
attachments: ["_attachments/2026-05-07-091034.png"]
tags: [capture, unrefined]
importance: low
---
![[2026-05-07-091034.png]]

(사용자가 나중에 여기에 메모를 추가하거나 그대로 큐레이트)
```

→ **기존 마크다운 형식을 깨지 않고** 이미지/첨부를 포함한 노트가 된다. Obsidian 호환 wikilink-attachment 그대로 사용.

---

## 3. 사용자 영역 = 화이트보드

### 3.1 백엔드 변경 (최소)

| 추가 | 기존 |
|---|---|
| `inbox` 카테고리를 `UserOpsidianManager.CATEGORIES` 에 추가 | 나머지 4개 카테고리 그대로 |
| `_attachments/` 디렉터리 생성/조회 헬퍼 메서드 (`save_attachment`, `read_attachment`, `list_attachments`) | 노트 CRUD 는 그대로 |
| `_captures.jsonl` append-only 로그 | 추가 인덱스는 일단 없음 (필요 시 Phase 2+) |

신규 컨트롤러 엔드포인트 (controller [whiteboard_controller.py](../../backend/controller/) 신규):

```
POST /api/opsidian/captures             ← CaptureEvent 인입
  body: multipart (binary + json metadata)
  resp: { capture_id, draft_note_filename }

GET  /api/opsidian/captures              ← 최근 N건 (기본 50)
GET  /api/opsidian/attachments/{path}    ← 바이너리 다운로드
DELETE /api/opsidian/captures/{id}       ← (옵션) 캡처 폐기
```

### 3.2 프런트엔드 변경

[UserOpsidianView.tsx](../../frontend/src/components/user-opsidian/UserOpsidianView.tsx) 의 1334줄에 손을 깊이 대지 않고, **부속 컴포넌트로 기능을 추가**한다.

신규:

| 위치 | 책임 |
|---|---|
| `frontend/src/components/user-opsidian/InboxPanel.tsx` | Inbox 탭. 카드형 그리드(이미지 썸네일 + 메모) 으로 캡처 나열 |
| `frontend/src/components/user-opsidian/CaptureToolbar.tsx` | "스크린 캡처 / 붙여넣기 / 파일 드롭" 버튼들. 각 버튼은 등록된 캡처 소스 플러그인이 채움 |
| `frontend/src/components/user-opsidian/AttachmentEmbed.tsx` | `![[file.png]]` wikilink → `<img>` 렌더링 (ReactMarkdown 커스텀 컴포넌트) |
| `frontend/src/lib/captureSources.ts` | 클라이언트측 capture-source 레지스트리. `registerCaptureSource({ id, label, icon, run })` |

기존 `UserOpsidianView` 에는 (a) 사이드바에 `inbox` 카테고리 추가 (b) 본문 패널 상단에 `<CaptureToolbar>` 슬롯 (c) Markdown 렌더에 `AttachmentEmbed` 주입 — 이 세 줄만 손댄다.

### 3.3 "Whiteboard" 의미

처음에는 **Inbox + 첨부 임베드 + 카드 뷰** 만으로도 충분히 화이트보드 느낌이 된다.
드래그 가능한 자유 캔버스(예: Excalidraw 스타일) 는 Phase 5+ 에서 별도 검토 — 우선은 카드 그리드로 시작.

---

## 4. 공유 모드: Library vs Spotlight

이 분리가 본 설계의 가장 중요한 결정.

### 4.1 Library 모드 (기존 `curate` 의 확장)

- **무엇** — 노트를 `CuratedKnowledgeManager` 로 영속 승격. FAISS 벡터 갱신.
- **언제** — 사용자가 "VTuber 가 나중에 참고했으면" 하는 콘텐츠
- **VTuber 시점** — `knowledge_search`/`knowledge_read` 로 능동 pull
- **구현** — 기존 `curatedKnowledgeApi.curateNote` 그대로. 단, 첨부가 있으면 `_curated_knowledge/.../attachments/` 에 복사 + frontmatter 보존

### 4.2 Spotlight 모드 (신규)

- **무엇** — 지금 이 순간 VTuber 가 봐줬으면 하는 콘텐츠 (방금 찍은 화면 등)
- **언제** — 사용자가 "이거 봐봐 / 같이 얘기하자" 라고 할 때
- **VTuber 시점** — 다음 턴에 자동 주입 + WS 트리거로 즉시 알림
- **라이프사이클** — TTL 기반(예: 30분) 또는 사용자가 명시적으로 해제할 때까지 활성

#### 4.2.1 SpotlightStore (신규)

`backend/service/whiteboard/spotlight_store.py`:

```python
class SpotlightStore:
    """Per-session, in-memory + 옵션 disk 백업.
    VTuber 컨텍스트에 매 턴 끼워넣을 '지금 보고 있는 것' 목록."""

    def add(self, session_id: str, item: SpotlightItem) -> None: ...
    def list(self, session_id: str) -> list[SpotlightItem]: ...
    def clear(self, session_id: str, item_id: Optional[str] = None) -> None: ...
    def expire_due(self) -> int:  # ticker가 호출
        ...

@dataclass
class SpotlightItem:
    item_id: str
    source_filename: str         # _user_opsidian 또는 _curated_knowledge 의 노트
    title: str
    excerpt: str                 # 200~400자 발췌
    attachments: list[str]       # 첨부 경로
    expires_at: datetime
    pinned: bool = False         # 만료 무시
```

#### 4.2.2 VTuber 측 주입 (3 갈래로 동시에)

1. **`SpotlightContextSection` (PromptBuilder 신규 섹션)**
   - 우선순위 높음, 페르소나 직후
   - 활성 spotlight 항목들을 사람이 읽을 수 있는 형태로 system prompt 에 박는다
   - 첨부가 이미지면 vision-capable 모델일 때 **content block (image)** 으로 추가

2. **`[USER_SHARED]` 트리거 메시지**
   - `thinking_trigger` 와 같은 패턴
   - Spotlight 신규 등록 시 한 번만 발사 → VTuber가 능동 반응
   - 페이로드 예: `[USER_SHARED] type=screenshot title="..." excerpt="..."`

3. **`chat_stream` WebSocket 이벤트**
   - 프런트엔드의 VTuber 채팅 패널이 "사용자가 X를 공유했습니다" 시각 알림을 띄울 수 있게
   - 새 이벤트 타입: `{type: "user_shared", item: SpotlightItem}`

#### 4.2.3 영구화 경로

Spotlight 항목은 휘발성이지만 VTuber 와의 대화 자체에서 의미 있는 결론이 나오면 사용자가 명시 액션으로 Library 로 승격할 수 있어야 한다.
→ 기존 `knowledge_promote` 도구를 살짝 확장: spotlight 출처일 때 자동으로 `source: spotlight, captured_at: ...` 메타를 보존.

---

## 5. 캡처 소스 = 플러그인 (확장 표면)

핵심: **새 입력 종류를 추가할 때 코어 변경 없이** 플러그인만 추가하면 된다.

### 5.1 백엔드 측

기존 `GenyPlugin.contribute_tools` 위에 캡처 소스를 얹지 않는다 — 캡처는 사용자 측 액션이지 에이전트 측 액션이 아니기 때문. 대신 **HTTP 엔드포인트와 클라이언트 레지스트리** 두 곳에 등록한다.

서버 측 캡처는 이미 만든 `POST /api/opsidian/captures` 한 엔드포인트로 충분하다 — 플러그인은 클라이언트가 어떻게 그 엔드포인트를 호출하는지를 결정하면 된다.

선택적으로, 분석 가공이 필요한 캡처 (예: OCR / 객체 탐지) 는 **에이전트 도구** 로 등록되어 VTuber 가 후속 분석을 호출할 수 있게 한다:

```python
# 예: backend/tools/custom/whiteboard_tools.py 신규
class WhiteboardOCRTool(BaseTool):
    name = "whiteboard_ocr"  # spotlight item의 이미지에서 텍스트 추출
class WhiteboardDescribeTool(BaseTool):
    name = "whiteboard_describe"  # 비전 모델로 이미지 묘사
```

### 5.2 프런트엔드 측 — `CaptureSource` 레지스트리

`frontend/src/lib/captureSources.ts` (신규):

```ts
export type CaptureSource = {
  id: string;
  label: string;
  icon: ReactNode;
  /** 사용자 트리거 → CaptureEvent 페이로드 생성 → POST /api/opsidian/captures */
  run: (ctx: CaptureCtx) => Promise<CaptureEvent | null>;
  /** 자동 등록 시 환경 체크 (예: navigator.mediaDevices 가용?) */
  isAvailable?: () => boolean;
};

const registry = new Map<string, CaptureSource>();
export function registerCaptureSource(s: CaptureSource) { ... }
export function listCaptureSources(): CaptureSource[] { ... }
```

내장 소스 3개를 기본 등록:

| 소스 | 구현 요지 |
|---|---|
| `screen_capture` | `navigator.mediaDevices.getDisplayMedia()` → 1프레임 캡처 → blob → 업로드 |
| `clipboard_paste` | `navigator.clipboard.read()` → 이미지/텍스트 분기 |
| `file_drop` | `<input type="file">` 또는 drag-drop zone |

→ 외부 플러그인이 새 소스를 등록하려면 `registerCaptureSource({...})` 한 번만 부르면 된다. `CaptureToolbar` 가 자동으로 버튼을 그린다.

### 5.3 미래 확장 (사전 검증)

| 확장 | 설계가 이미 수용하는가? |
|---|---|
| 음성 메모 | ✓ `type: "audio"` + `_attachments/*.webm`. 분석은 후속 에이전트 도구 |
| 브라우저 익스텐션에서 보내기 | ✓ 익스텐션이 직접 `POST /api/opsidian/captures` |
| 모바일 카메라 | ✓ `<input capture="environment">` 로 file_drop 변형 |
| 화면 영역 OCR / 자동 분석 | ✓ Phase 4 의 `whiteboard_ocr` 도구 |
| 자유 캔버스 (Excalidraw) | △ 별도 콘텐츠 타입 `type: "drawing"` 추가 — 데이터 형식만 정의하면 OK |

---

## 6. VTuber 의 실시간 반응 경로

### 6.1 매 턴 시스템 프롬프트

```
... 페르소나 ...
[Spotlight Context]
The user has just shared the following with you:
1. [Screenshot, 09:10:34] "타임라인 분석 결과 화면"
   excerpt: ...
2. [Note, 08:45:00] "오늘의 회고 - 3번 항목 좀 봐줘"
[/Spotlight Context]
... DateTime ...
... MemoryContext ...
```

이미지 첨부가 있으면 system prompt 가 **content block 리스트** 로 빌드되어 vision 모델에 전달.

### 6.2 [USER_SHARED] 트리거

신규 spotlight 등록 직후 1회.

```
[USER_SHARED]
type: screenshot
title: 타임라인 분석 결과 화면
hint: 사용자가 방금 이 화면을 공유했습니다. 자연스럽게 화제로 꺼내거나 의견을 표현하세요.
```

기존 `[THINKING_TRIGGER]` 핸들러에 분기 추가만으로 충분. 핸들링은 [thinking_trigger.py](../../backend/service/vtuber/thinking_trigger.py) 와 같은 자리에 둔다.

### 6.3 VTuber → 사용자 측 시각 신호

`chat_stream` WebSocket 에 새 이벤트:
```json
{ "type": "user_shared", "item": { "title": "...", "type": "screenshot", "thumb_url": "..." } }
```
프런트엔드 채팅 UI가 메시지 위에 "공유됨" 핀 카드를 띄운다. 사용자가 "지금 같이 보고 있다" 는 감각을 갖게 하는 것이 이 이벤트의 목적.

### 6.4 에이전트의 "본 기억" — `ViewLedger`

> *VTuber 가 같은 노트를 여러 번 마주칠 때, 매번 처음 보는 듯 반응하면 "연속성을 가진 동반자" 환상이 즉시 깨진다. 이것을 막기 위한 핵심 인프라.*

#### 6.4.1 문제

다음 경로 모두에서 같은 노트가 반복 노출된다:

- 사용자가 같은 노트를 두 번째로 spotlight 함
- `knowledge_search` 의 같은 쿼리에 같은 결과
- spotlight 활성 동안 매 턴 시스템 프롬프트에 `injected`
- VTuber 가 한 번 언급한 노트를 며칠 뒤 다시 검색

이걸 추적하지 않으면 VTuber 가 "이 메모 처음 보는데…" 라고 반응해서 연속성이 깨진다.

#### 6.4.2 데이터 모델

`backend/service/whiteboard/view_ledger.py` (신규):

```python
@dataclass(frozen=True)
class ViewKey:
    agent_id: str       # 페르소나 / 캐릭터 식별자 (예: "cocoro", "default")
    note_id: str        # source_filename 또는 capture_id

@dataclass
class ViewRecord:
    key: ViewKey
    first_seen_at: datetime
    last_seen_at: datetime
    counts: dict[ViewEventType, int]   # 이벤트별 분리 카운트
    last_event: ViewEventType
    last_context: Optional[str]        # 짧은 맥락 메모 (검색쿼리, 세션id 등)

ViewEventType = Literal[
    "searched",   # search 결과에 등장 (스쳐 지나감, 약한 신호)
    "listed",     # list 메타에 포함 (약한 신호)
    "read",       # 본문 fetch (강한 신호)
    "injected",   # 시스템 프롬프트에 포함 (강한 신호)
    "mentioned",  # 응답 본문에서 직접 언급 (휴리스틱, 중간 신호)
]
```

**분리 카운트가 핵심**: `read` 1회와 `searched` 100회는 의미가 다르다. 합산이 아니라 이벤트 종류별로 따로 본다.

#### 6.4.3 저장

```
{STORAGE_ROOT}/_view_ledger/{username}/
├── {agent_id}.jsonl   ← append-only event log
└── {agent_id}.idx.json ← 메모리 인덱스의 disk 스냅샷 (lazy compact)
```

- 쓰기는 JSONL append (동시성 안전, 손실 최소)
- 읽기는 in-memory dict[(agent_id, note_id) → ViewRecord]
- 일일 ticker 가 jsonl 을 idx.json 으로 컴팩트

#### 6.4.4 결과 데코레이션 (지식 도구)

[backend/tools/built_in/knowledge_tools.py](../../backend/tools/built_in/knowledge_tools.py) 의 모든 결과 dict 에 view 메타 자동 부착:

```json
{
  "filename": "topics/api-debugging.md",
  "title": "API 디버깅 메모",
  "score": 0.83,
  "_view": {
    "seen": true,
    "counts": { "read": 3, "injected": 7, "searched": 12 },
    "first_seen_at": "2026-05-01T09:30:55Z",
    "last_seen_at": "2026-05-06T22:14:01Z",
    "last_event": "injected"
  }
}
```

각 도구가 결과 직렬화 직전에 `ViewLedger.decorate(agent_id, results)` 호출 + 호출 그 자체를 적절한 이벤트로 기록 (`searched` / `listed` / `read`). 이 한 곳만 통과시키면 모든 데코레이션이 일관된다.

#### 6.4.5 시스템 프롬프트의 view 힌트

`SpotlightContextSection` (§6.1, §11.5) 이 렌더 시 view 메타를 자연어로 변환해 박는다:

```
[Spotlight Context]
1. [Note, 09:10:34] "API 디버깅 메모"
   ⚑ 이전에 3 회 읽음, 7 회 컨텍스트 주입됨 / 마지막 노출 5 분 전
   excerpt: ...
2. [Screenshot, 08:15:22] "타임라인 분석 결과"
   ⚑ 처음 보는 자료
   excerpt: ...
```

같은 렌더 함수가 매번 `injected` 이벤트를 1 회 기록 → 다음 턴부터 카운트 반영.

#### 6.4.6 페르소나 가이드라인 한 줄

`DynamicPersonaSystemBuilder` 에 정적 가이드라인 1 줄 추가:

> 시스템 프롬프트의 `⚑` 힌트로 표시된 노트가 "이전에 본 자료" 면 처음 마주친 듯 다루지 말고 이전 맥락에 이어서 자연스럽게 다뤄라. ("지난 번 그 [API 디버깅] 메모에 이어서…" 같은 어법). 처음 보는 자료는 명시적으로 새 정보로 받아라.

이 한 줄이 view 메타의 모든 기능적 효과를 만든다 — 데이터를 넣어도 페르소나가 활용하지 않으면 의미 없으므로 가이드라인이 필수 페어.

#### 6.4.7 `mentioned` 이벤트 (옵션, 휴리스틱)

응답 후처리에서 본문 안에 노트 제목/파일명 패턴이 나타나면 `mentioned` 기록. 정규식 + 제목 fuzzy 매치로 가벼운 휴리스틱. 정확도는 낮지만 트렌드 신호로는 충분. 부정확한 false positive 가 다른 이벤트보다 위험이 적기 때문에 (mentioned 는 단지 통계).

P4 또는 P5 에서 활성화. P0~P3 에서는 자리만 비워둠.

#### 6.4.8 멀티 에이전트 / 멀티 사용자 격리

- `agent_id` 가 키의 일부 → 캐릭터 A 가 본 것은 캐릭터 B 의 카운트에 영향 없음
- 멀티 사용자 협업 (백로그) 시 `actor: "user:alice" | "agent:cocoro"` 까지 확장 가능
- 현재 single-agent 단일 사용자 환경에서도 미래 확장에 막히지 않게 키부터 미리 구조화

#### 6.4.9 신규 도구 (옵션)

에이전트가 자기 자신의 view 이력을 능동 조회하고 싶을 때:

```python
class KnowledgeViewsTool(BaseTool):
    name = "knowledge_views"
    # 옵션 1: 특정 노트의 view record 조회
    # 옵션 2: "내가 가장 자주 본 노트 top N" 조회
    # 옵션 3: "한 번도 안 본 노트 top N" 조회
```

P2 또는 P5 (Organizer 와 묶어서) 에 등록.

#### 6.4.10 Organizer 와의 시너지 (P5)

view 신호는 P5 의 클러스터링 입력으로 강력하다:

- `TopicPromotionStrategy`: "사용자가 spotlight 했고 / 에이전트가 자주 read 한" 노트 = Library 승격 후보
- `NearDuplicateStrategy`: 같은 클러스터에서 view 가 한쪽에만 집중되어 있다면 합치기 제안 시 우선순위
- 신규 `StaleNoteStrategy` (P5 백로그): "오래 전 만들고 한 번도 안 본 노트" 정리 제안

→ ViewLedger 는 P5 에서 추가 작업 없이 이미 활용 가능 (P0~P2 에 깔린 데이터를 그대로 입력으로 받음).

---

## 7. 보안 / 프라이버시

스크린 캡처는 민감하므로 다음 가드를 명시한다:

1. **사용자 로컬 동의 게이트** — `getDisplayMedia` 는 브라우저 기본 권한 다이얼로그가 있으나, 우리도 첫 사용 시 자체 안내 모달 띄움
2. **저장은 사용자 영역 안** — `_attachments/` 는 기존 `_user_opsidian/{username}/` 권한과 동일
3. **공유 게이트** — Spotlight/Library 로 옮기기 전까지 VTuber 는 못 본다. 사용자 명시 액션 필요
4. **TTL** — Spotlight 기본 30분 후 자동 만료 (옵션 핀)
5. **삭제 시 첨부도 삭제** — 노트 삭제 → 참조하던 첨부 GC

`backend/service/whiteboard/redaction.py` (옵션, 후속): 자동 PII/토큰 마스킹.

---

## 8. 모델 비전 호환성

- 현재 라우팅은 모델 비전 가능 여부를 알 수 있어야 함
- `SpotlightContextSection.render()` 가 모델 capability 를 받아 분기:
  - 비전 가능: content block 으로 이미지 직접 첨부
  - 비전 불가: "사용자가 [스크린샷: 타이틀] 을 공유했습니다 (이미지 첨부됨)" 텍스트 + `whiteboard_describe` 도구로 캡션 자동 생성 후 텍스트로 주입
- 비전 가능 여부 판단은 라우팅 메타에서 가져온다 (이미 `service/llm/` 또는 라우팅 단에 정보 존재할 가능성 — Phase 0에서 확인)

---

## 9. 데이터 라이프사이클 요약

```
캡처 입력 ─→ Inbox draft note (raw, importance=low)
              │
              ├─→ 사용자 편집 / 메모 추가 / 삭제
              │
              ├─→ "Library 로 큐레이트"  → CuratedKnowledge (FAISS, 영속)
              │
              └─→ "Spotlight 공유"       → SpotlightStore (TTL 30분)
                                              │
                                              ├─→ VTuber 시스템 프롬프트 (매 턴)
                                              ├─→ [USER_SHARED] 트리거 (1회)
                                              └─→ chat_stream user_shared 이벤트
                                              │
                                              └─→ (선택) Library 로 영구화
```

---

## 10. 변경 요약 (비대칭이 작은가?)

| 영역 | 변경 규모 |
|---|---|
| `UserOpsidianManager` | `inbox` 카테고리 + `_attachments/` 헬퍼 (≤ 50 lines) |
| `CuratedKnowledgeManager` | 첨부 복사 분기 (≤ 30 lines) |
| `CurationEngine` | 변경 없음 |
| 신규 `SpotlightStore` | ~150 lines |
| 신규 `ViewLedger` | ~200 lines (저장 + 데코레이트 + 컴팩트) |
| 신규 `whiteboard_controller.py` | ~150 lines (캡처/첨부 엔드포인트) |
| 신규 `SpotlightContextSection` (PromptBuilder) | ~80 lines + view 힌트 렌더 |
| `knowledge_tools.py` view 데코레이션 | 기존 도구 4개에 한 줄 호출 (≤ 30 lines 합계) |
| `thinking_trigger.py` 분기 추가 | ≤ 30 lines |
| `chat_stream.py` 이벤트 타입 추가 | ≤ 20 lines |
| `UserOpsidianView.tsx` | 슬롯 3개 추가, 코어 미수정 |
| 신규 React 컴포넌트 (Inbox/Toolbar/Embed) | ~600 lines 합계 |
| 신규 `captureSources.ts` 레지스트리 | ~100 lines + 내장 소스 3개 |

→ 핵심 발명품은 `CaptureEvent`, `SpotlightStore`, `SpotlightContextSection`, **`ViewLedger`** 4가지.
→ 그 외는 전부 기존 자산의 슬롯/확장이다.

---

## 11. 확장 후크 명세 (Extensibility Hooks)

> *"화이트보드 자동 정리는 본 계획 안에 포함하고, 자유 캔버스 / 음성 메모 / 브라우저 익스텐션은 코어 변경 없이 플러그인 추가만으로 작동해야 한다" 는 요구를 만족시키는 설계 후크 명세.*

본 절의 목적은 단순히 "나중에 만들 것" 을 적는 것이 아니라, **각 확장이 어느 추상화 위에 올라타는지 미리 못박는다**. 그래야 P0~P4 코드를 짤 때 무의식적으로 그 추상화를 깨뜨리지 않는다.

### 11.1 후크 매트릭스

| 확장 | 핵심 콘텐츠 타입 | 캡처 소스 | 분석 도구 | UI 슬롯 | VTuber 노출 |
|---|---|---|---|---|---|
| **자동 정리 / 클러스터링** | (메타) | (없음) | `OrganizerStrategy` (+`ViewLedger` 신호) | InboxPanel `<SuggestionsBar>` | (간접) Curated 품질 향상 |
| **에이전트 본 기억** | (메타, 모든 타입에 부착) | (없음) | `ViewLedger.decorate` | 시스템 프롬프트 `⚑` 힌트 | 모든 knowledge_* 결과에 view 메타 + spotlight 섹션에 자연어 힌트 |
| **자유 캔버스 (Excalidraw)** | `drawing` | `canvas_editor` 클라이언트 소스 | `whiteboard_describe` 재사용 + `whiteboard_render_drawing` (SVG→PNG) | `AttachmentEmbed` 의 `.excalidraw.json` 분기 | 비전 가능 모델: PNG 렌더 후 image content block |
| **음성 메모 / 자동 전사** | `audio` | `microphone_record` 클라이언트 소스 | `whiteboard_transcribe` (Whisper 류) | `AttachmentEmbed` 의 audio 분기 (재생기 + 전사 토글) | 자동 전사로 텍스트 발췌 (excerpt) 채움 |
| **브라우저 익스텐션** | `link` 또는 `screenshot` | (외부 클라이언트) `POST /api/opsidian/captures` 직접 호출 | `whiteboard_extract_links` 재사용 | (없음, 외부) | 기존 spotlight/library 경로 그대로 |

### 11.2 콘텐츠 타입 후크

`CaptureEvent.type` 의 enum 은 P0 부터 **`drawing` 과 `audio` 까지 미리 포함**한다. 데이터 모델 자리만 비워두는 것이 비용이 0이고, 나중에 추가 시 마이그레이션을 피한다.

```python
# backend/service/whiteboard/types.py (P0 부터)
CaptureType = Literal[
    "text", "image", "screenshot",
    "audio",       # ← P0 부터 enum 에 포함, 실제 처리는 후속
    "drawing",     # ← P0 부터 enum 에 포함, 실제 처리는 후속
    "link", "file", "code",
]
```

`AttachmentEmbed` (P1) 의 분기 함수도 처음부터 dispatch table 형태로 둔다:

```ts
const RENDERERS: Record<string, (path: string) => ReactNode> = {
  '.png':  (p) => <img src={attachUrl(p)} />,
  '.jpg':  (p) => <img src={attachUrl(p)} />,
  '.webm': (p) => <audio src={attachUrl(p)} controls />,  // P1 부터 미리
  '.mp3':  (p) => <audio src={attachUrl(p)} controls />,
  '.excalidraw.json': (p) => <ExcalidrawEmbed path={p} />, // 후속 등록
  // ...
};
```

새 타입 추가 = 이 테이블에 한 줄.

### 11.3 캡처 소스 후크 (이미 §5)

P3 의 `registerCaptureSource({...})` 클라이언트 레지스트리가 그대로 자유 캔버스 / 음성 메모 / 브라우저 익스텐션의 진입점이 된다.

- **자유 캔버스** — 캔버스 에디터 모달을 띄우고, 사용자가 "저장" 누르면 `.excalidraw.json` 페이로드를 `POST /api/opsidian/captures`. 자체 렌더가 캔버스 → SVG → PNG 썸네일 변환을 동시에 첨부.
- **음성 메모** — `getUserMedia({audio:true})` → MediaRecorder → blob (`audio/webm;codecs=opus`) → 업로드. 캡처 직후 자동으로 `whiteboard_transcribe` 호출 옵션.
- **브라우저 익스텐션** — 클라이언트 레지스트리에 등록되지 않는다 (외부 프로세스). 대신 동일 `POST /api/opsidian/captures` 를 사용한다. 인증은 §11.6 참조.

### 11.4 분석 도구 후크

P4 의 `whiteboard_*_tools.py` 파일은 **하나의 BaseTool 패턴** 을 반복하므로 새 도구 추가가 자연스럽다.

```python
# 추가 예시 (P5+ 또는 백로그)
class WhiteboardTranscribeTool(BaseTool):
    name = "whiteboard_transcribe"
    # audio item_id → 텍스트 전사 (Whisper 호출)

class WhiteboardRenderDrawingTool(BaseTool):
    name = "whiteboard_render_drawing"
    # drawing item_id → PNG 렌더 (vision 모델용)
```

이 도구들은 **자동 후속 트리거** 로 연결된다:
- 새 spotlight item 의 type 이 `audio` → 자동으로 `whiteboard_transcribe` → 결과를 item 의 `excerpt` 채움
- type 이 `drawing` 이고 모델이 비전 가능 → `whiteboard_render_drawing` → image content block 동봉
- type 이 `image/screenshot` 이고 비전 불가 → 기존 `whiteboard_describe`

이 후속 트리거 디스패치는 P4 에서 일반화한다 (`PostCaptureHook` — 한 자리에서 type → tool 매핑).

### 11.5 UI 슬롯 후크

`UserOpsidianView.tsx` 에 P1 에서 만드는 **3 개의 명시적 슬롯** 을 모든 확장이 재사용한다:

| 슬롯 | P1 채움 | 후속 채움 |
|---|---|---|
| `<CaptureToolbar>` | 내장 3 소스 (screen / clipboard / drop) | 자유 캔버스, 음성 메모 버튼 추가 |
| `<AttachmentEmbed>` | 이미지 / 비디오 / 오디오 | drawing, 사용자 정의 타입 |
| `<InboxPanel>` 상단 `<SuggestionsBar>` | (P1 에서는 빈 영역 차지만) | P5 자동 정리 제안 카드, 후속 확장 |

P1 시점에 위 세 슬롯이 명시적으로 빈 컨테이너로 존재해야 한다 — "나중에 끼워 넣을 곳" 을 미리 만든다.

### 11.6 외부 클라이언트 (브라우저 익스텐션) 인증 후크

P0 의 `POST /api/opsidian/captures` 는 처음에는 **세션 쿠키 기반** 으로만 인증한다. 익스텐션을 위해 P0 부터 **인증 어댑터 한 줄** 을 둔다:

```python
# whiteboard_controller.py
def _resolve_user(request) -> User:
    # 1) 세션 쿠키
    if user := session_user(request): return user
    # 2) Bearer "ingest token"  ← 익스텐션용 미래 분기 자리
    # if token := request.headers.get("X-Geny-Ingest-Token"):
    #     return ingest_token_to_user(token)
    raise Unauthorized()
```

→ 익스텐션 추가 시 토큰 발급 / 저장 UI + 토큰 검증 함수만 채우면 끝. CORS 는 `whiteboard_controller` 만 화이트리스트 도메인을 허용하도록 라우터 단에서 한정.

### 11.7 자동 정리 / 클러스터링 후크 (본 계획 내 포함)

**중요**: 이 확장은 백로그가 아닌 **본 계획 Phase 5 로 포함** 한다. 이유:
- 캡처 소스가 늘면 Inbox 가 빠르게 폭발 → 정리 도구가 없으면 화이트보드가 죽은 창고가 됨
- 임베딩 / FAISS 인프라가 이미 Curated 측에 존재 → 추가 의존성이 거의 없음

#### 추상화: `OrganizerStrategy`

```python
# backend/service/whiteboard/organizer.py
class OrganizerStrategy(Protocol):
    name: str
    def propose(
        self,
        notes: list[MemoryFileInfo],
        embeddings: dict[str, list[float]],
    ) -> list[OrganizationSuggestion]: ...

@dataclass
class OrganizationSuggestion:
    suggestion_id: str
    kind: Literal["cluster", "duplicate", "topic_promotion", "tag"]
    note_filenames: list[str]
    proposed_label: str          # 예: "API 디버깅"
    proposed_action: Literal["group", "merge", "promote_to_library", "tag"]
    confidence: float
    rationale: str               # LLM이 생성한 한 줄 설명
```

전략 등록도 매트릭스화:

```python
ORGANIZER_REGISTRY: dict[str, OrganizerStrategy] = {
    "embedding_cluster": EmbeddingClusterStrategy(),  # 기본
    "near_duplicate":    NearDuplicateStrategy(),      # 거의 같은 캡처 합치기 제안
    "topic_promotion":   TopicPromotionStrategy(),     # Library 로 올릴 만한 후보
    "stale_unseen":      StaleUnseenStrategy(),        # 오래 전 만들고 한 번도 안 본 노트 정리
}
```

`OrganizerStrategy.propose()` 의 입력에 **`ViewLedger` 스냅샷이 포함**된다 — view 신호는 클러스터링과 우선순위에 가장 유용한 보조 신호이다 (§6.4.10):

```python
class OrganizerStrategy(Protocol):
    def propose(
        self,
        notes: list[MemoryFileInfo],
        embeddings: dict[str, list[float]],
        view_snapshot: dict[str, ViewRecord],  # ← P5 시점에 추가
    ) -> list[OrganizationSuggestion]: ...
```

새 전략 = 새 클래스 + registry 한 줄. **자동 정리 후크는 `OrganizerStrategy` 인터페이스 그 자체** 다.

#### 실행 모델

- **Ticker** (`GenyPlugin.contribute_tickers`) 가 사용자 활동이 N 분 이상 idle 일 때 한 번 발화
- 또는 사용자가 InboxPanel 의 "✨ 정리 제안 받기" 버튼 클릭 시 즉시
- 결과는 `_organizer_suggestions.jsonl` append, **자동 적용하지 않음** — 사용자가 카드형 UI 에서 승인 / 기각 / 수정

#### UI: SuggestionsBar

- InboxPanel 최상단의 `<SuggestionsBar>` 슬롯 (§11.5)
- 카드 한 장 = 한 제안 ("이 5개 캡처가 'API 디버깅' 주제로 묶일 수 있어요. 묶기 / 무시")
- 사용자 액션은 감사 로그에 남고, 같은 제안은 N일 동안 다시 띄우지 않음

#### Curation 과의 관계

`OrganizerStrategy` 와 `CurationEngine` 은 **다른 일을 한다**:

| | Organizer | CurationEngine |
|---|---|---|
| 대상 | User Opsidian Inbox + 최근 노트 | User Opsidian → Curated 승격 |
| 출력 | 사용자에게 보여줄 제안 | 실제 저장 액션 |
| 트리거 | Ticker / 사용자 버튼 | Scheduler / 사용자 curate 버튼 |
| 자동 적용 | **하지 않음** | 자동 적용 |

→ 둘은 직교한다. Organizer 가 "이걸 Library 로 보내자" 제안 → 사용자 승인 → 그제야 CurationEngine 호출. Organizer 는 CurationEngine 을 추가로 침범하지 않는다.

### 11.8 후크 무결성 체크리스트 (PR 단위)

각 Phase PR 에서 다음 항목이 깨지지 않았는지 확인:

- [ ] `CaptureEvent.type` enum 이 `drawing`, `audio` 를 포함한다 (P0 이후)
- [ ] `AttachmentEmbed` dispatch table 이 신규 타입 1줄 추가만으로 동작 가능한 형태다
- [ ] `whiteboard_controller` 의 인증 함수가 어댑터 패턴이다 (세션 cookie / 토큰 분기점이 명시되어 있다)
- [ ] InboxPanel 에 `<SuggestionsBar>` / `<CaptureToolbar>` 슬롯이 선언만이라도 존재한다 (P1 부터)
- [ ] **`knowledge_*` 도구의 모든 결과 / `SpotlightContextSection` 렌더가 `ViewLedger.decorate` 를 통과한다** (P2 이후) — 우회 호출이 새로 생기면 view 데이터가 누락된다
- [ ] **`ViewLedger` 의 키가 `(agent_id, note_id)` 분리 형태를 유지한다** — 단일 키로 합치는 변경은 멀티 에이전트 격리를 깬다
- [ ] **`ViewEventType` enum 이 5종 (`searched`/`listed`/`read`/`injected`/`mentioned`) 분리 카운트** 를 유지한다 — 합산형으로 단순화하면 신호 손실

→ 이 체크리스트가 본 계획 안에서 "확장 후크가 살아있나" 의 단일 진실원이다.

---

다음 문서: [03_PLAN.md](03_PLAN.md) — 위 설계를 5 단계로 쪼갠 실행 계획 + 위험·검증 항목.
