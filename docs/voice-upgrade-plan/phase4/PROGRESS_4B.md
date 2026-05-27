# Phase 4 — PR 4B PROGRESS

> [PLAN_4B.md](./PLAN_4B.md) 참조.

---

## 진행 상황

### 1. 사전 작업 ✅
- [x] backend deps 확인 (langdetect / librosa 없음 → 자체 구현으로 결정)
- [x] PLAN_4B.md 작성

### 2. Backend ✅
- [x] `service/voice_studio/tools/__init__.py`
- [x] `service/voice_studio/tools/language_detect.py` — Unicode block ratio
- [x] `service/voice_studio/tools/ref_analyzer.py` — wave + numpy 분석
- [x] `controller/voice_studio/tools.py` — 3 endpoints + 1 audio stream
- [x] `controller/voice_studio/__init__.py` — tools router include

### 3. Frontend ✅
- [x] `lib/voiceStudioApi.ts` — detectLanguage / analyzeRef / seedSearch
- [x] `components/voice-studio/tools/ToolCard.tsx` — 공통 collapsible
- [x] `components/voice-studio/tools/LanguageDetectTool.tsx`
- [x] `components/voice-studio/tools/CompareTool.tsx` — N synthesizePreview 병렬
- [x] `components/voice-studio/tools/SeedSearchTool.tsx`
- [x] `components/voice-studio/tools/RefAnalyzerTool.tsx`
- [x] `app/voice-studio/tools/page.tsx` — 4 카드 배치 + placeholder 제거

### 4. i18n ✅
- [x] `voiceStudio.tools.*` ko + en

### 5. 검증 ✅
- [x] py_compile 5 파일 통과
- [x] `npm run build` 0 errors, 17 routes 그대로

### 6. 배포 ✅
- [x] commit `feat(voice-studio): tools page (language detect / A/B compare / seed search / ref analyzer)`
- [x] PR [#840](https://github.com/CocoRoF/Geny/pull/840) → squash → main `a82bddb`
- [x] 2222 서버 `sudo git pull` + `docker compose ... up -d --build backend frontend`
- [x] 운영 검증:
  - containers: frontend Up 22s · backend Up 34s (healthy) · 다른 5개 unchanged
  - `detect-language` 한/영/일 모두 정확 (ja는 hiragana + han 동시 검출하여 ja 분류)
  - `analyze-ref` paimon_ko ref (4.8s, 16kHz, RMS -14.9dB, silence 8.3%) — 4.8s<5.0s 이므로 suggested_windows=[] (의도된 동작)
  - 회귀 `/api/tts/engines` 4엔진 그대로
