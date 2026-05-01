# PR 5 — Opsidian Conversation tab

> Phase 2 / Plan §3 Phase 2 PR 5
> Status: ✅ 작성 완료 (TS 환경 부재로 컴파일 검증은 사용자 dev 환경 필요)
> Depends on: PR 4 (dms/daily 인덱스가 표시 대상)
> Blocks: 없음 (frontend-only)

## 산출물

| 파일 | 변경 |
|---|---|
| [`frontend/src/store/useObsidianStore.ts`](../../frontend/src/store/useObsidianStore.ts) | `ViewMode` 에 `'conversation'` 추가 |
| [`frontend/src/components/obsidian/ConversationView.tsx`](../../frontend/src/components/obsidian/ConversationView.tsx) | 신규 — Stream/Notes 토글 + StreamTab 임베드 + NotesBrowser 컴포넌트 |
| [`frontend/src/components/obsidian/ObsidianView.tsx`](../../frontend/src/components/obsidian/ObsidianView.tsx) | viewMode 분기에 `conversation` 케이스 추가 |
| [`frontend/src/components/obsidian/ObsidianSidebar.tsx`](../../frontend/src/components/obsidian/ObsidianSidebar.tsx) | view-mode switcher 에 Conversation 버튼 + `CATEGORY_ICONS` 에 conversations/dms/daily-journal/compactions 아이콘 |
| [`frontend/src/components/obsidian/RightPanel.tsx`](../../frontend/src/components/obsidian/RightPanel.tsx) | STM Entries 카운트 클릭 시 Conversation view 점프 (review.md P1 의 직접 답) |

## UX 결정

1. **두 sub-view 토글 (Stream / Notes)** — 같은 데이터의 두 각도. Stream 은 InteractionEvent 타임라인 (기존 StreamTab 재사용), Notes 는 vault tree 의 conversations/ + dms/ + daily-journal 노트.
2. **NotesBrowser 가 NoteViewer 재사용** — vault sidebar tree 컴포넌트 통째 재구현하지 않고 카테고리 필터링만 추가. 본문 렌더는 NoteViewer 가 그대로 함 — frontmatter Properties + markdown body + Linked references panel 모두 Obsidian 호환.
3. **Stream 이 default** — 사용자가 평소 보는 timeline 을 먼저. Notes 는 deep-dive.
4. **STM Entries 클릭으로 deep link** — 기존엔 dead 카운트였던 RightPanel 의 STM Entries 가 review.md P1 의 핵심 이슈였음. PR 5 가 이걸 살아 있는 진입점으로 만듦.

## 알려진 제약

- 이 sandbox 에 node/tsc 가 없어 TypeScript 컴파일 검증 못 함. 사용자 dev 환경에서 `tsc --noEmit` 로 type 검증 필요.
- Stream → Notes 점프 (event 행 클릭 → vault 노트 점프) 가 modal 안에서 직접 일어나지 않음 — frontmatter 의 conversation_ref 를 modal 이 노출하면 사용자가 수동으로 vault 점프. PR 6 이 스키마 확장 시 자동 점프 핸들러 추가 가능.
- `daily/` (사람 작성) 와 `daily-journal` (자동 생성) 의 카테고리가 frontmatter 에서 분리됐지만 디스크 위치는 같은 root level. 운영자에게 헷갈릴 수 있음 — 향후 daily-journal 만 별도 서브폴더로 옮길지 검토.

## 다음 액션

PR 6 — 카운터파트 fallback + frontmatter 인덱싱 확장 (MemoryFileInfo 에 event_id/kind/direction/counterpart 등 추가).
