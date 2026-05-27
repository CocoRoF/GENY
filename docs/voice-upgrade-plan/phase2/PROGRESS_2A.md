# Phase 2 — PR 2A PROGRESS

> [PLAN_2A.md](./PLAN_2A.md) 참조.

---

## 진행 상황

### 1. 사전 작업
- [x] 04 문서 + EmotionRefSection 코드 확인
- [x] PLAN_2A.md 작성

### 2. Frontend lib ✅
- [x] `frontend/src/lib/audioUtils.ts` — decodeAudio / encodeWav / blobToWav + pickMediaRecorderMime helper

### 3. Frontend components ✅
- [x] `frontend/src/components/voice-studio/RecorderModal.tsx` — MediaRecorder + permission/secure-context/unsupported guards + preview + "trim next" path
- [x] `frontend/src/components/voice-studio/TrimmerModal.tsx` — wavesurfer.js + regions plugin (dynamic import for SSR safety), draggable region, preview, encode-on-confirm

### 4. Frontend 수정 ✅
- [x] `frontend/src/components/voice-studio/EmotionRefSection.tsx` — Mic + Scissors 버튼 추가, RecorderModal + TrimmerModal mount 1쌍 + activeEmotion state로 8 카드 공유

### 5. i18n ✅
- [x] `voiceStudio.recorder.*` ko/en
- [x] `voiceStudio.trimmer.*` ko/en

### 6. 검증 ✅
- [x] `npm run build` 0 errors, 17 routes 유지
- [x] 회귀 — 기존 ⬆/🗑/per-emotion prompt 코드는 변경하지 않음 (액션 버튼 추가만)

### 7. 배포
- [ ] commit + PR + squash 머지
- [ ] sudo git pull + sudo docker compose --build frontend (backend 무변경)
- [ ] 운영 시연 확인

### 8. 마무리
- [ ] PROGRESS_2A.md 완료 처리
- [ ] Phase 2B PLAN 초안
