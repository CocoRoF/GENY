# Phase 2 — PR 2B PROGRESS

> [PLAN_2B.md](./PLAN_2B.md) 참조.

---

## 진행 상황

### 1. 사전 작업
- [x] backend persistent storage 패턴 확인 (`/data/*` + named volume)
- [x] PLAN_2B.md 작성

### 2. Backend ✅
- [x] `backend/service/voice_studio/history_store.py` — SQLite + audio blob + cap 20 (FIFO eviction)
- [x] `backend/controller/voice_studio/history.py` — list / audio (FileResponse) / replay (re-synth) / delete
- [x] `backend/controller/voice_studio/save_as_ref.py` — 서버사이드 ref 복사 (tts_controller helpers 재사용)
- [x] `backend/controller/voice_studio/synthesis_preview.py` 수정 — history insert (best-effort) + X-VoiceStudio-History-Id 헤더
- [x] `backend/controller/voice_studio/__init__.py` — history + save_as_ref router include

### 3. Docker compose ✅
- [x] `docker-compose.prod.yml` — `GENY_VOICE_STUDIO_DATA_DIR=/data/voice_studio` env + `geny-voice-studio-prod` volume
- [x] `docker-compose.dev.yml` — `geny-voice-studio-dev`
- [x] `docker-compose.yml` — `geny-voice-studio`
- [x] `docker compose -f <each>.yml config` — 3 파일 모두 정상 (volume + env 노출됨)

### 4. Frontend ✅
- [x] `lib/voiceStudioApi.ts` — getHistory / getHistoryAudioUrl / deleteHistory / replayHistory / saveAsRef + historyId 헤더 surface
- [x] `components/voice-studio/HistoryPanel.tsx` — collapsible, auto-refresh on refreshKey, per-row Play/Replay/Download/Save-as-ref/Delete
- [x] `components/voice-studio/SaveAsRefModal.tsx` — non-template profiles only, default emotion = current Synthesize card emotion
- [x] `components/voice-studio/SynthesizeCard.tsx` 수정 — historyRefreshKey state + Save-as-ref 버튼 + HistoryPanel + Modal mount

### 5. i18n ✅
- [x] `voiceStudio.history.*` ko/en
- [x] `voiceStudio.saveAsRef.*` ko/en

### 6. 검증 ✅
- [x] py_compile 5 파일 통과
- [x] `npm run build` 0 errors, 17 routes (변동 없음)
- [x] docker compose config 3 파일 모두 정상

### 7. 배포
- [ ] commit + PR + squash 머지
- [ ] sudo git pull + sudo docker compose --build backend frontend
- [ ] 운영 검증 — history insert / audio stream / save-as-ref / replay

### 8. 마무리
- [ ] PROGRESS_2B.md 완료 처리
- [ ] Phase 3 PLAN 초안
