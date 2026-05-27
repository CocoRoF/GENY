# Phase 4 — PR 4A PROGRESS

> [PLAN_4A.md](./PLAN_4A.md) 참조.

---

## 진행 상황

### 1. 사전 작업
- [x] PLAN_4A.md 작성

### 2. Backend ✅
- [x] `event_bus.py` — asyncio Queue per subscriber, drop-on-full
- [x] `batch_store.py` — SQLite `batch_jobs` + per-job dir + state machine
- [x] `batch_runner.py` — per-job asyncio Task, calls synthesize_preview line-by-line, zip on finish (including cancelled), publishes batch.* events
- [x] `controller/voice_studio/batch.py` — POST start (cap 500), GET list/get, POST cancel, GET download
- [x] `controller/voice_studio/events.py` — SSE with hello + 15s keepalive
- [x] `__init__.py` — batch + events router include

### 3. Frontend ✅
- [x] `lib/voiceStudioEvents.ts` — EventSource wrapper with auto-reconnect (browser default)
- [x] `lib/voiceStudioApi.ts` — startBatch / listBatches / getBatch / cancelBatch / getBatchDownloadUrl + types
- [x] `BatchUploader.tsx` — TXT/CSV/JSON parsing, file upload + paste, defaults (profile/emotion/mode), preview, 500-line cap
- [x] `BatchJobRow.tsx` — state badge + progress bar + cancel/download + collapsible log
- [x] `app/voice-studio/batch/page.tsx` — SSE-driven auto-refresh (200ms debounced)

### 4. i18n ✅
- [x] `voiceStudio.batch.*` ko/en (title / state / errors / hints)

### 5. 검증 ✅
- [x] py_compile 6 파일 통과
- [x] `npm run build` 0 errors

### 6. 배포
- [ ] commit + PR + squash 머지
- [ ] sudo git pull + sudo docker compose --build backend frontend
- [ ] 운영 검증

### 7. 마무리
- [ ] PROGRESS_4A.md 완료 처리
- [ ] Phase 4B PLAN 초안
