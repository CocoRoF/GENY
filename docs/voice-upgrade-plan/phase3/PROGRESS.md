# Phase 3 — PR 3 PROGRESS

> [PLAN.md](./PLAN.md) 참조.

---

## 진행 상황

### 1. 사전 작업
- [x] tts_controller cache endpoints 확인 (`/api/tts/cache/stats`, `DELETE /api/tts/cache`)
- [x] TTSEngine ABC 본체 + config_manager API 확인
- [x] PLAN.md 작성

### 2. Backend ✅
- [x] `backend/service/vtuber/tts/base.py` — 8 ClassVar 메타 + `is_available` 기본 구현
- [x] `backend/service/vtuber/tts/engines/omnivoice_engine.py` — 메타 채움
- [x] `backend/service/vtuber/tts/engines/edge_tts_engine.py` — 메타
- [x] `backend/service/vtuber/tts/engines/openai_tts_engine.py` — 메타 + `is_available` API key check
- [x] `backend/service/vtuber/tts/engines/elevenlabs_engine.py` — 메타 + `is_available` API key + voice_id check
- [x] `backend/service/voice_studio/settings_store.py` — key-value SQLite (WAL, JSON values)
- [x] `backend/service/voice_studio/engine_registry.py` — parallel `is_available()` probe + default 영속 (settings_store + tts_general_config mirror)
- [x] `backend/controller/voice_studio/engines.py` — `GET /engines`, `POST /engines/default`
- [x] `backend/controller/voice_studio/defaults.py` — `GET / PUT /settings/omnivoice-defaults` (config_manager로 OmniVoiceConfig 영속)
- [x] `backend/controller/voice_studio/__init__.py` — engines + defaults router include

### 3. Frontend ✅
- [x] `lib/voiceStudioApi.ts` — `getEngines` / `setDefaultEngine` / `getOmniVoiceDefaults` / `putOmniVoiceDefaults` / `getCacheStats` / `clearCache`
- [x] `components/voice-studio/EngineMatrixCard.tsx` — 4 엔진 행 표 + default 라디오 + ↻ refresh
- [x] `components/voice-studio/OmniVoiceDefaultsCard.tsx` — 6 필드 (num_step/guidance/speed/duration/denoise/audio_format) + dirty 표시 + Save
- [x] `components/voice-studio/CacheCard.tsx` — 6 stat tile + Clear 버튼 (confirm dialog)
- [x] `app/voice-studio/settings/page.tsx` — 3 카드 mount

### 4. i18n ✅
- [x] `voiceStudio.settings.*` ko/en (engines / omnivoiceDefaults / cache 모두)

### 5. 검증 ✅
- [x] py_compile 10 파일 통과
- [x] `npm run build` 0 errors, 17 routes (변동 없음)

### 6. 배포
- [ ] commit + PR + squash 머지
- [ ] sudo git pull + sudo docker compose --build backend frontend
- [ ] 운영 검증

### 7. 마무리
- [ ] PROGRESS.md 완료 처리
- [ ] Phase 4 PLAN 초안
