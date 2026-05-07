# 01 — 현재 상태 분석 (Knowledge Whiteboard 도입 전)

> *VTuber와 사용자의 지식을 잇는 다리(Bridge)를 새로 설계하기 전에, 지금의 Opsidian / Curated / VTuber 파이프라인이 어디에 어떻게 흩어져 있는지부터 정리한다.*

작성일: **2026-05-07**
대상: User Opsidian → Curated Knowledge → VTuber 컨텍스트 주입 경로

---

## 1. 현재의 큰 그림

```
┌─────────────────────────┐      ┌──────────────────────────┐      ┌────────────────────────┐
│  User Opsidian (개인)    │  →   │  Curated Knowledge (공용) │  →   │  VTuber / Agent 컨텍스트 │
│  /_user_opsidian/{user} │      │  /_curated_knowledge/{u} │      │  knowledge_search/read  │
└─────────────────────────┘      └──────────────────────────┘      └────────────────────────┘
        ↑                                  ↑
        │                                  │
   사용자 직접 편집                  CurationEngine 5-stage
   (UserOpsidianView)              (Triage→Analyze→Transform
                                    →Enrich→Store)
```

핵심 데이터 흐름은 **한 방향**이고, **텍스트 전용**이며, **자동화에 가까운 큐레이션**으로 작동한다.
실시간 공유나 멀티모달(이미지/캡처) 지원은 없다.

---

## 2. User Opsidian — 현재 구현

### 2.1 백엔드

| 위치 | 역할 |
|---|---|
| [backend/service/memory/user_opsidian.py](../../backend/service/memory/user_opsidian.py) | `UserOpsidianManager` — 사용자별 파일 기반 vault. Single-tenant `MemoryProvider` |
| [backend/controller/user_opsidian_controller.py](../../backend/controller/user_opsidian_controller.py) | `/api/opsidian/*` REST: list / search / write / update / delete |
| [backend/service/memory/types.py](../../backend/service/memory/types.py) | `MemoryFileInfo`, `MemoryEntry` — YAML frontmatter + Markdown body |

저장 구조:

```
{STORAGE_ROOT}/_user_opsidian/{username}/
├── daily/      ← 일지 / 오늘의 메모
├── topics/     ← 주제별 정리
├── projects/   ← 프로젝트 단위
├── insights/   ← 통찰 / 리플렉션
├── _index.json ← 매 write마다 재빌드
└── *.md        ← 루트 노트
```

각 노트 형식:

```markdown
---
title: "..."
tags: [...]
importance: critical|high|medium|low
category: daily|topics|projects|insights
links: [...]
---
<Markdown 본문>
```

### 2.2 프런트엔드

| 위치 | 역할 |
|---|---|
| [frontend/src/components/user-opsidian/UserOpsidianView.tsx](../../frontend/src/components/user-opsidian/UserOpsidianView.tsx) | 메인 편집기 (1334 lines). 사이드바 + 본문 마크다운 에디터 + 우측 패널 |
| [frontend/src/components/user-opsidian/CurationSettingsPanel.tsx](../../frontend/src/components/user-opsidian/CurationSettingsPanel.tsx) | 자동 큐레이션 규칙 설정 |
| [frontend/src/components/opsidian/](../../frontend/src/components/opsidian/) | 공용 위젯 (MarkdownToolbar, WikilinkPicker, QuickSwitcher 등) 재사용 |

UI 특성:
- **순수 마크다운 편집**. 이미지·첨부·캡처는 지원하지 않음
- 큐레이션 액션 존재 — `handleCurate` ([UserOpsidianView.tsx:731](../../frontend/src/components/user-opsidian/UserOpsidianView.tsx#L731))이 `curatedKnowledgeApi.curateNote({ source_filename, use_llm: true })` 를 호출해 단일 노트를 Curated 로 승격
- 그래프 뷰 / 검색 / 카테고리 필터 모두 텍스트 기반

---

## 3. Curated Knowledge — 현재 구현

### 3.1 큐레이션 파이프라인

[backend/service/memory/curation_engine.py](../../backend/service/memory/curation_engine.py) 의 5단계:

1. **Triage** — 규칙 기반 1차 필터 (importance, length, age 등)
2. **Analyze** — 옵션) LLM 으로 품질 / 주제 / 영속성 평가
3. **Transform** — 카테고리별 변환 전략 (요약 압축, 구조화)
4. **Enrich** — 자동 태그·링크 보강
5. **Store** — `CuratedKnowledgeManager` 에 기록 + 감사 로그

스케줄러 ([curation_scheduler.py](../../backend/service/memory/curation_scheduler.py)) 가 5분 주기로 자동 발화하거나, UI에서 노트 단위로 수동 트리거 가능.

### 3.2 저장 구조

```
{STORAGE_ROOT}/_curated_knowledge/{username}/
├── topics/
├── decisions/
├── insights/
├── projects/
└── reference/
```

옵션: FAISS 벡터 인덱스 (`LTMConfig.curated_vector_enabled=true`)

### 3.3 VTuber/Agent 노출 경로

[backend/tools/built_in/knowledge_tools.py](../../backend/tools/built_in/knowledge_tools.py) 가 자동 등록되어 에이전트 도구로 제공:

| Tool | 동작 |
|---|---|
| `knowledge_search` | 키워드 또는 벡터 검색 (Curated 우선, User Opsidian 은 config gate) |
| `knowledge_read` | 파일명으로 본문 가져오기 |
| `knowledge_list` | 카테고리/태그 필터링 목록 |
| `knowledge_promote` | 세션 메모를 Curated 로 승격 (옵트인) |

→ **VTuber 는 능동적으로 Curated 만 읽는다.** User Opsidian 은 기본 비공개.

---

## 4. VTuber 측 컨텍스트 흐름

### 4.1 프롬프트 조립

[backend/service/prompt/builder.py](../../backend/service/prompt/builder.py) 의 `PromptBuilder` 가 섹션 단위로 system prompt 를 조립.
[backend/service/persona/dynamic_builder.py](../../backend/service/persona/dynamic_builder.py) 의 `DynamicPersonaSystemBuilder` 가 매 턴마다 `PersonaProvider.resolve()` 를 호출해 페르소나 + 정적 tail 블록(DateTime, MemoryContext) 을 합친다.

### 4.2 메모리 주입

[backend/service/memory/manager.py](../../backend/service/memory/manager.py) 의 `SessionMemoryManager.build_memory_context(query)` 가 ~8KB 예산 안에서:
- Short-term: 최근 대화
- Long-term: durable facts (`memory/MEMORY.md`)
- Vector: 옵션 시 의미 검색

→ Curated Knowledge 는 **에이전트가 도구로 능동 검색** 하는 경로일 뿐, 자동으로 system prompt 에 들어가지 않는다.

### 4.3 실시간 트리거

[backend/service/vtuber/thinking_trigger.py](../../backend/service/vtuber/thinking_trigger.py) 가 idle/event 기반으로 `[THINKING_TRIGGER]` 를 주입.
서브워커 결과는 `[SUB_WORKER_RESULT]` 패턴으로 들어옴.

→ 같은 패턴으로 **`[USER_SHARED]`** 트리거를 새로 정의할 수 있는 자리가 비어 있다.

### 4.4 WebSocket

| 경로 | 용도 |
|---|---|
| `/ws/vtuber/agents/{session_id}/state` | 아바타 표정·모션 |
| `/ws/chat/rooms/{room_id}` | 메시지·진행상태 |
| `/ws/agents/{session_id}/execute` | 도구 실행 스트림 |

→ 사용자 → VTuber 방향의 **"방금 이걸 봐줘" 신호 채널은 없다.** chat_stream 에 새 이벤트 타입을 추가하거나 별도 stream 을 만들어야 한다.

### 4.5 플러그인 확장 표면

[backend/service/plugin/protocol.py](../../backend/service/plugin/protocol.py) 의 `GenyPlugin` 이 7개 contribute 포인트를 정의:

1. `contribute_prompt_blocks` — 프롬프트 섹션 추가
2. `contribute_emitters` — 이벤트 emitter
3. `contribute_tickers` — 주기 작업
4. `contribute_tools` — 에이전트 도구
5. `contribute_session_listeners` — 라이프사이클
6. `contribute_attach_runtime` — 세션 런타임
7. (init) — 상태 셋업

→ 새 캡처 소스(스크린, 클립보드, 음성 메모 등)를 **플러그인으로 등록**할 수 있는 자리가 이미 마련되어 있다.

---

## 5. 비전 도구 / 캡처의 현재 상태

| 위치 | 비고 |
|---|---|
| [backend/tools/custom/browser_tools.py](../../backend/tools/custom/browser_tools.py) `browser_take_screenshot` | Playwright 기반 페이지 스크린샷. **에이전트 측 도구**일 뿐, 사용자 화면 캡처는 아님 |
| 사용자 화면 캡처 | **존재하지 않음** |
| 이미지 첨부 / 멀티모달 노트 | **존재하지 않음** (Markdown 텍스트만 저장) |
| 비전 모델 호출 | 라우팅 단에서 모델은 비전 가능하나, 이미지 페이로드를 노트/대화에 첨부하는 경로 미구현 |

---

## 6. 갭 분석 — 우리가 원하는 것 vs 지금 있는 것

| 원하는 것 | 현재 갭 |
|---|---|
| User 영역을 "**지식 창고 / 화이트보드**" 처럼 자유롭게 | 카테고리 4개 + 마크다운만. 이미지·캡처·블록형 콘텐츠 불가 |
| Curated 로 옮겨 **VTuber와 공유** | 단건 `curate` 액션은 있으나, 공유 시점·주목도(spotlight)·실시간 반영 개념 없음 |
| **확장성** (스크린 캡처 등 신규 입력) | 플러그인 표면은 있으나 멀티모달 캡처 → 노트 → 큐레이션 파이프라인이 일관되게 정의되지 않음 |
| VTuber 가 사용자가 방금 공유한 것을 **즉시 인지** | `knowledge_search` 능동 검색만 가능. 푸시·트리거·spotlight 부재 |
| 캡처 / 첨부의 **저장과 참조** | `_attachments/` 디렉터리, wikilink-attachment, 이미지 임베드 모두 미구현 |

---

## 7. 활용 가능한 자산 (재발명 금지)

새 기능을 위해 다음을 그대로 또는 살짝 늘려서 쓴다:

| 자산 | 어떻게 활용 |
|---|---|
| `UserOpsidianManager` / `CuratedKnowledgeManager` | 기존 single-tenant 파일 저장 그대로. `_attachments/` 만 옆에 추가 |
| `CurationEngine` 5-stage | 그대로 유지. 단계별 규칙에 "spotlight 모드" 분기만 추가 |
| `knowledge_*` 도구 | 이미 등록되어 있고 VTuber 가 사용 중. 새 spotlight 도구만 1~2개 추가 |
| `GenyPlugin.contribute_tools/prompt_blocks` | 캡처 소스 플러그인의 표준 진입점 |
| `PersonaProvider.append_context` ([backend/service/persona/](../../backend/service/persona/)) | spotlight 컨텍스트를 매 턴 페르소나 tail에 끼우는 가장 깨끗한 자리 |
| `[THINKING_TRIGGER]` / `[SUB_WORKER_RESULT]` 패턴 | `[USER_SHARED]` 트리거의 설계 모델 |
| WebSocket `chat_stream` | `user_shared` 이벤트를 추가할 채널 |

---

## 8. 결론

현 상태는 "**텍스트 전용 / 단방향 / 비실시간**" 노트 시스템에 가깝다.
사용자 영역을 화이트보드로, Curated 를 실시간 공유 다리로 전환하려면 다음 4개 축을 새로 깐다:

1. **콘텐츠 모델 확장** — 첨부(이미지/캡처) + 블록 임베딩
2. **캡처 소스 플러그인 표면** — 스크린·클립보드·드롭 등을 일관된 `CaptureEvent` 로 수렴
3. **공유 모드 분리** — Library(영속) vs Spotlight(즉시·휘발) 두 갈래
4. **VTuber 실시간 인지 채널** — `[USER_SHARED]` 트리거 + 멀티모달 페이로드

다음 문서: [02_ARCHITECTURE.md](02_ARCHITECTURE.md) — 위 4개 축의 구체 설계.
