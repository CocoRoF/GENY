# PR-2 Progress — Surface attachment failures

**Branch:** `fix/20260424_3-pr2-surface-attachment-errors`
**Base:** `main @ e4ef98a` (PR-1 merged)

## Changes

### `backend/controller/chat_controller.py` — `_rewrite_local_attachment_url`

세 가지 안전장치 추가 (기존 silent 매핑에서 explicit failure 로):

1. **Path traversal defense** — `/static/uploads/` prefix 를 떼고 붙여 만든 `abs_path.resolve()` 가 `_UPLOAD_ROOT.resolve()` 하위인지 `relative_to()` 로 검증. 벗어나면 warning 로그 + `HTTPException(400)`.
2. **Existence check** — `abs_path.is_file()` 가 False 면 warning 로그 + `HTTPException(400)` (broadcast 자체를 400 으로 실패시킴, downstream silent drop 없음).
3. **Logging** — 실패 케이스 각각에 `logger.warning(...)` 추가, URL·resolved path 포함. 어떤 파일이 미싱인지 즉시 드러남.

### Scope

`_rewrite_local_attachment_url` 은 `broadcast_to_room:490` 한 지점에서만 호출. list comprehension 안에서 예외 올리면 broadcast 전체가 400 으로 실패 — 사용자 메시지 / attachments_payload 저장 전이라 partial state 문제 없음 (`user_msg_data` 는 line 494 에서 구성).

### geny-executor 쪽은 의도적으로 미수정

`MultimodalNormalizer._resolve_local_image_source` 의 `None` 반환 경로 (normalizers.py:42–46, 184–189) 는 더 근본적인 개선 대상이지만 PyPI 패키지 릴리스 주기가 있어 이번 PR 에서는 제외. Backend 가 파일 존재를 강하게 검증하므로 executor 에 도달하는 경로는 항상 유효 — silent drop 경로 자체가 실용상 도달 불가.

향후 geny-executor 0.32.x 에서 `_resolve_local_image_source` 실패를 `logger.error` + raise 로 격상하면 이중 안전망 완성.

## Verification

```bash
# 1. 정상 업로드 → broadcast: 기존 성공 경로 유지
POST /api/uploads (file attached)           # → 200, {url: "/static/uploads/ab/<sha>.png"}
POST /api/chat/rooms/{id}/broadcast          # → 200, attachment processed

# 2. 파일 수동 삭제 후 broadcast
rm backend/static/uploads/ab/<sha>.png
POST /api/chat/rooms/{id}/broadcast w/ that attachment
# → 400, {detail: "attachment not found on server: /static/uploads/ab/<sha>.png"}
# → 로그: "attachment missing on disk: url='/static/uploads/...' path=... — refusing broadcast"

# 3. Path traversal
POST /api/chat/rooms/{id}/broadcast w/ url: "/static/uploads/../../etc/passwd"
# → 400, {detail: "invalid attachment url: ..."}
# → 로그: "rejected attachment outside upload root: ..."
```

## Risk

- Low — 기존 정상 경로는 검증 통과 후 동일한 `abs_path.as_uri()` 반환.
- 사용자가 드물게 "업로드 직후 즉시 broadcast" 하지만 디스크 sync 지연으로 is_file 이 False 일 가능성 → upload_controller 가 `fsync` 를 하는지 확인 필요. 하지만 FastAPI `UploadFile` 은 동기적 close 후 200 응답을 돌려주므로 실질적 race 는 아님.

## Next

PR-3: Messenger `MessageInput` 에 VTuber 패턴 파일 UI 포팅 + `useMessengerStore.sendMessage` 확장.
