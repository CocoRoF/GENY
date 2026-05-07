# Knowledge Whiteboard & VTuber Bridge

> *사용자 Opsidian 영역을 자유로운 지식 창고 / 화이트보드로 만들고, Curated 를 거쳐 VTuber 와 실시간으로 공유하는 기능 묶음의 설계 문서.*

작성: **2026-05-07**
상태: **계획 (구현 미시작)**
관련: [docs/VTUBER_ARCHITECTURE_REVIEW.md](../VTUBER_ARCHITECTURE_REVIEW.md), [docs/DUAL_AGENT_ARCHITECTURE_PLAN.md](../DUAL_AGENT_ARCHITECTURE_PLAN.md)

---

## 핵심 아이디어 한 페이지

1. **User Opsidian = 화이트보드** — 텍스트만 받던 개인 vault 를 이미지·캡처·블록 임베드까지 받는 자유 창고로 확장.
2. **Curated = VTuber 와의 다리** — 사용자가 명시 동작으로 공유한 것만 VTuber 가 본다.
3. **공유는 두 개 모드** — `Library` (영속·검색용 / 기존 큐레이션 경로) + `Spotlight` (휘발·즉시 / 신규).
4. **모든 입력은 `CaptureEvent` 로 수렴** — 스크린 캡처 / 클립보드 / 파일드롭 / (미래) 음성 등 어떤 소스든 같은 형식.
5. **확장은 플러그인** — 새 캡처 소스 = `registerCaptureSource({...})` 한 번으로 끝.
6. **VTuber 는 능동·수동 양방향** — 기존 `knowledge_search` (pull) + 신규 `[USER_SHARED]` 트리거와 시스템 프롬프트 spotlight 섹션 (push).
7. **에이전트의 본 기억 (`ViewLedger`)** — VTuber 가 어떤 노트를 몇 번, 어떤 맥락(`searched`/`listed`/`read`/`injected`/`mentioned`)으로 봤는지 추적. 같은 노트를 두 번째 마주칠 때 "처음 보는 듯" 다루지 않게 한다 ([02 §6.4](02_ARCHITECTURE.md#64-에이전트의-본-기억--viewledger)).

---

## 문서 인덱스

| 순서 | 문서 | 내용 |
|---|---|---|
| 1 | [01_ANALYSIS.md](01_ANALYSIS.md) | 현 상태 분석 — User Opsidian / Curated / VTuber 가 지금 어떻게 작동하는가, 갭 분석 |
| 2 | [02_ARCHITECTURE.md](02_ARCHITECTURE.md) | 목표 아키텍처 — `CaptureEvent`, Spotlight 모드, PromptBuilder 신규 섹션, 플러그인 표면 |
| 3 | [03_PLAN.md](03_PLAN.md) | 단계별 실행 계획 — 5 Phase, 각 Phase 의 DoD / 위험 / 트레이드오프 |

---

## 한눈에 보는 변경 영향 (요약)

| 영역 | 변경 정도 | 핵심 추가 |
|---|---|---|
| `UserOpsidianManager` | 작음 | `inbox` 카테고리, `_attachments/` 헬퍼 |
| `CuratedKnowledgeManager` | 작음 | spotlight 출처 메타 보존, 첨부 복사 |
| `CurationEngine` | **변경 없음** | — |
| `PromptBuilder` / `DynamicPersonaSystemBuilder` | 작음 | `SpotlightContextSection` 신규 + view 자연어 힌트 |
| `knowledge_*` 도구 | 작음 (각 한 줄) | `ViewLedger.decorate` 호출 + 이벤트 기록 |
| `thinking_trigger` 파이프라인 | 작음 | `[USER_SHARED]` 트리거 분기 (with `seen_before` 필드) |
| `chat_stream` WS | 작음 | `user_shared` 이벤트 타입 |
| `UserOpsidianView.tsx` | **슬롯 3개 추가** (코어 미수정) | Inbox 사이드바 / CaptureToolbar 슬롯 / AttachmentEmbed |
| 신규 모듈 | — | `SpotlightStore`, **`ViewLedger`**, `whiteboard_controller`, `captureSources.ts` 레지스트리, Inbox UI |

→ 핵심 발명품 **4 가지**: `CaptureEvent` 모델 / `SpotlightStore` / `SpotlightContextSection` / **`ViewLedger`**. 나머지는 전부 기존 자산 재활용.

---

## 단계 요약 (Phase 표)

| Phase | 한 줄 | 사용자 가치 |
|---|---|---|
| **P0** | 기반 다지기 (CaptureEvent + 첨부 + Inbox + 확장 후크 자리 + **ViewLedger 데이터 모델**) | (없음, 인프라) |
| **P1** | 화이트보드 UI (Inbox + 이미지 임베드 + 3 슬롯 선언) | 노트에 이미지를 붙일 수 있다 |
| **P2** | Spotlight 공유 + VTuber 실시간 인지 + **ViewLedger 통합** | "이거 봐줘" 가 동작 + VTuber 가 "전에 봤지?" 를 안다 |
| **P3** | 스크린 캡처 / 클립보드 / 파일드롭 + 비전 분기 | 화면 찍어 즉시 VTuber 와 대화 |
| **P4** | 분석 도구 (OCR / describe) + Library 강화 + 보안 + PostCaptureHook 일반화 + `mentioned` 휴리스틱 | 비전 비가용 모델도 안전, 영속화 매끄러움 |
| **P5** | **자동 정리 / 클러스터링** (`OrganizerStrategy` + SuggestionsBar + view 신호 활용) | Inbox 폭주 방지, 더 좋은 Curated 가 VTuber 에 |

상세는 [03_PLAN.md](03_PLAN.md) 참조.

---

## 확장 후크 약속 (Extensibility Hooks)

본 계획은 **사용자 요청에 따라 다음 기능들이 코어 변경 없이 플러그인 추가만으로 작동하도록** 설계 후크를 명시적으로 박아두었다. 후크 명세는 [02_ARCHITECTURE.md §11](02_ARCHITECTURE.md#11-확장-후크-명세-extensibility-hooks).

| 미래 기능 | 어느 후크 위에 올라타는가 | 추가되는 것 |
|---|---|---|
| **자유 캔버스 (Excalidraw)** | `CaptureType="drawing"` enum (P0) + `AttachmentEmbed` dispatch table (P1) + `registerCaptureSource` (P3) | 캔버스 모달 컴포넌트 + `whiteboard_render_drawing` 도구 |
| **음성 메모 / 자동 전사** | `CaptureType="audio"` enum (P0) + audio dispatch (P1) + `registerCaptureSource` (P3) + `PostCaptureHook` (P4) | 마이크 레코더 + `whiteboard_transcribe` 도구 |
| **브라우저 익스텐션** | `_resolve_user` 인증 어댑터 분기 자리 (P0) + `POST /api/opsidian/captures` (P0) | 익스텐션 자체 + 토큰 발급 UI |
| **자동 정리 / 클러스터링** | **Phase 5 로 본 계획에 포함** | (Phase 5 의 작업) |

후크 무결성 체크리스트가 매 PR 마다 검사된다 ([02 §11.8](02_ARCHITECTURE.md#118-후크-무결성-체크리스트-pr-단위), [03 검증 섹션](03_PLAN.md#검증--테스트-전략)).

---

## 비목표 (이번 사이클에서 안 함, 그러나 후크는 갖춤)

본 사이클에서 구현하지 않지만, 본 설계의 후크 위에서 **코어 변경 없이** 추가 가능:

- 자유 캔버스 (Excalidraw) — `CaptureType="drawing"` enum 자리 P0 부터 확보
- 음성 메모 / 자동 전사 — `CaptureType="audio"` 와 dispatch 자리 P0~P1 확보
- 브라우저 익스텐션 — 인증 어댑터 자리 P0 확보
- 모바일 카메라 — `<input capture>` 가 file_drop 변형으로 자연 수용

후크 부족으로 별도 사이클이 필요한 항목 (본 사이클 비목표 + 후크 미정):

- 협업 (다른 사용자와 화이트보드 공유)
- 화이트보드 → ChatRoom 자동 게시 (양방향)

---

## 다음 행동

1. 본 문서 묶음에 대한 검토 / 의사결정 (특히 Library vs Spotlight 분리, 캡처 소스 = 클라이언트 레지스트리 결정)
2. Phase 0 + Phase 1 의 최소 절반을 묶어 첫 PR 로 가는 범위 합의
3. 모델 capability (비전 가능 여부) 조회 위치 사전 확인 — Phase 0 의 작업으로 추가
