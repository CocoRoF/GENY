# PR-4 Progress — Messenger `MessageList` attachment 렌더

**Branch:** `feat/20260424_3-pr4-messenger-render-attachments`
**Base:** `main @ 610fde3` (PR-3 merged)

## Changes

### `frontend/src/components/messenger/MessageList.tsx`

- `ChatAttachment` import + `Paperclip` 아이콘 추가
- 공유 컴포넌트 `AttachmentList({ attachments })` 도입 — user / agent 두 메시지 버블에서 재사용
  - **Image (`kind==='image'` + `url|data` 존재)**: `<a href=... target="_blank">` 로 감싼 썸네일 `<img>` — max 180×180, object-cover, rounded
  - **File / 기타**: `<Paperclip>` + 파일명 chip (download 링크는 href 있을 때 `<a>`, 없으면 div)
  - `att.url` 우선, 없으면 `att.data` (base64 data URI) fallback — 타입엔 있지만 VTuber 패널에서도 렌더되지 않던 edge case 커버
- `UserMessage`:
  - `msg.content` 가 비어있어도 (첨부만 있는 메시지) 컴포넌트가 빈 blank 가 아니게 content 블록 조건부 렌더
  - 첨부 있으면 `<AttachmentList>` 렌더
- `AgentMessage`:
  - `<ChatMarkdown>` 뒤에 `<AttachmentList>` 렌더 — 향후 agent 응답이 attachment 를 포함하게 되면 자동 표시 (현재 backend 는 agent 쪽 attachment 저장 안 하지만 대비)
  - `FileChangeSummary` 와 공존

## Verification

- 기존 VTuber 에서 올린 첨부 있는 메시지가 Messenger 타임라인에 썸네일로 보임
- PR-3 로 Messenger 에서 직접 업로드한 파일도 자기 메시지에 썸네일로 보임
- WebSocket 으로 들어오는 새 메시지의 attachment 도 동일하게 렌더 (타입 + 데이터 경로 공통)
- 파일 타입 (이미지 아닌 것): Paperclip + 이름 chip + 다운로드 링크

## Cycle close

전체 4 PR 머지 후:
- [ ] 업로드 영속화: `docker compose restart backend` 후에도 파일 살아남음 (PR-1)
- [ ] nginx `/static/uploads/` 200 (PR-1)
- [ ] 파일 없는 URL 로 broadcast → 400 + 명확한 에러 (PR-2)
- [ ] Messenger 에서 이미지 첨부 → 업로드 → 송신 (PR-3)
- [ ] Messenger 타임라인에서 썸네일 렌더 (PR-4)

Cycle 20260424_3 close.
