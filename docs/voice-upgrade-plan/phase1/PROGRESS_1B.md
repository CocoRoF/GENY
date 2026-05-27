# Phase 1 — PR 1B PROGRESS

> [PLAN_1B.md](./PLAN_1B.md) 참조.

---

## 진행 상황

### 1. 사전 작업 ✅
- [x] Backend 라우터 등록 패턴 파악 (`backend/main.py` 라인 68 / 789)
- [x] OmniVoice `TTSRequest` schema 확인 (`omnivoice/server/schemas.py`)
- [x] `_build_payload` + `_resolve_emotion_ref` 코드 검증
- [x] PLAN_1B.md 작성

### 2. Backend ✅
- [x] `backend/service/voice_studio/__init__.py`
- [x] `backend/service/voice_studio/synthesis_preview.py` — Pydantic `PreviewParams` + `PreviewResult` dataclass
- [x] `backend/service/vtuber/tts/engines/omnivoice_engine.py` — `synthesize_preview()` 메서드 추가 (기존 `synthesize_stream` 무변경)
- [x] `backend/controller/voice_studio/__init__.py` — sub-router 묶음 (prefix `/api/voice-studio`)
- [x] `backend/controller/voice_studio/languages.py` — `GET /languages` (omnivoice 프록시 + 1h 캐시)
- [x] `backend/controller/voice_studio/synthesis_preview.py` — `POST /synth/preview` (audio bytes + X-VoiceStudio-* 헤더)
- [x] `backend/main.py` — voice_studio_router include

### 3. Frontend deps + lib ✅
- [x] `frontend/package.json` — `wavesurfer.js@^7.12.7` 추가 (lockfile은 gitignore라 commit X)
- [x] `frontend/src/lib/voiceStudioApi.ts` — `synthesizePreview()` + `getLanguages()` + in-process language cache

### 4. Frontend components ✅
- [x] `WaveformPreview.tsx` — wavesurfer.js dynamic import (SSR-safe)
- [x] `LanguagePicker.tsx` — 646언어 검색 dropdown
- [x] `AdvancedParamsPanel.tsx` — collapsible panel (num_step/guidance/speed/duration/seed/format/sample_rate + denoise/auto_asr toggles)
- [x] `InstructPanel.tsx` — instruct textarea + 6 preset chips
- [x] `EmotionRefSection.tsx` — tts-voice EmotionRefCard 포트 (8 감정 + per-emotion prompt)
- [x] `SynthesizeCard.tsx` — 모두 조합 (text + mode + emotion + lang + advanced + waveform + same-seed regenerate)

### 5. Frontend page ✅
- [x] `frontend/src/app/voice-studio/clone-design/page.tsx` — placeholder 제거 + 본격 구현. Suspense boundary로 useSearchParams 감쌈 (Next.js prerender 요구)

### 6. i18n ✅
- [x] `voiceStudio.cloneDesign.*` 네임스페이스 ko/en (mode/emotion/language/instruct/advanced/generate/errors)

### 7. 검증 ✅
- [x] Backend `py_compile` 통과 (6 파일 모두 OK)
- [x] Frontend `npm run build` 0 errors, 17 routes (변동 없음)
- [x] 회귀 — 기존 `/api/tts/*` 미변경, `tts-voice` 페이지 미변경

### 8. 배포
- [ ] commit + PR + squash 머지
- [ ] 2222 서버 sudo git pull
- [ ] sudo docker compose --build backend frontend
- [ ] 운영 확인 — `/api/voice-studio/synth/preview` 헤더 + WAV bytes / UI 합성 시연

### 9. 마무리
- [ ] PROGRESS_1B.md 최종 완료 처리
- [ ] Phase 2A PLAN 초안
