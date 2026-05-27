# Phase 1 — PR 1A PROGRESS

> [PLAN.md](./PLAN.md) 참조.
>
> 완료 시점: 2026-05-27 (작업).

---

## 진행 상황

### 1. 사전 작업 ✅
- [x] Geny 프론트엔드 구조 파악 (Sidebar / Header / i18n)
- [x] Voice Studio 진입점 결정: **Header.tsx** (Sidebar 아님 — 04 문서 오기 정정)
- [x] i18n 언어 확인: ko/en (ja/zh 없음 — 04 문서 오기 정정)
- [x] PLAN.md 작성

### 2. 신규 파일 생성 ✅
- [x] `frontend/src/app/voice-studio/layout.tsx`
- [x] `frontend/src/app/voice-studio/page.tsx` (entry redirect, server component)
- [x] `frontend/src/app/voice-studio/clone-design/page.tsx` (placeholder)
- [x] `frontend/src/app/voice-studio/voices/page.tsx` (실작동)
- [x] `frontend/src/app/voice-studio/batch/page.tsx` (placeholder)
- [x] `frontend/src/app/voice-studio/tools/page.tsx` (placeholder)
- [x] `frontend/src/app/voice-studio/settings/page.tsx` (placeholder)
- [x] `frontend/src/components/voice-studio/SideNav.tsx`
- [x] `frontend/src/components/voice-studio/VoiceCard.tsx`
- [x] `frontend/src/components/voice-studio/StudioPromoBanner.tsx`
- [x] `frontend/src/lib/voiceStudioApi.ts` (placeholder)

### 3. 수정 파일 ✅
- [x] `frontend/src/components/Header.tsx` — `Sliders` import + Voice Studio 아이콘 (TTS Voice 옆)
- [x] `frontend/src/app/tts-voice/page.tsx` — `<StudioPromoBanner />` 한 줄 삽입 (총 3줄 diff)
- [x] `frontend/src/lib/i18n/ko.ts` — `header.voiceStudio` + `ttsVoice.studioPromoBanner` + `voiceStudio` 네임스페이스 신규
- [x] `frontend/src/lib/i18n/en.ts` — 동일

### 4. 검증 ✅
- [x] `npm run build` (frontend) — **0 errors**, 17 routes (6 voice-studio + 기존 11)
- [x] `git diff frontend/src/app/tts-voice/page.tsx` — import 1줄 + 컴포넌트 1줄 + 빈줄 1줄 (총 3줄) 만 변경 — 565줄 본문 무변경 확인
- [x] i18n 인터폴레이션 `{n}` 패턴 — 기존 `{count}` 패턴과 호환 (interpolation regex `\{(\w+)\}`)

### 5. 배포 ✅
- [x] commit `feat(voice-studio): scaffold /voice-studio + voices catalog + header entry`
- [x] PR [#833](https://github.com/CocoRoF/Geny/pull/833) — `MERGEABLE` / GitGuardian SUCCESS → squash 머지 → main 커밋 `76b8970`
- [x] 2222 서버 `sudo git pull origin main` (17 files, 1216 insertions)
- [x] `sudo docker compose -f docker-compose.prod.yml up -d --build frontend` — frontend Recreated, backend Running 그대로
- [x] 운영 확인:
  - frontend Up 23s, backend Up 23m (healthy)
  - `/voice-studio/voices` HTML에 5탭 SideNav 링크 모두 존재
  - `/tts-voice` 정상 서빙 (배너는 client-side hydrate 후 표시, 의도된 패턴)
  - `GET /api/tts/engines` → `{"engines": ["edge_tts", "openai", "elevenlabs", "omnivoice"], "default": "omnivoice"}` 그대로

### 6. 마무리 ✅
- [x] PROGRESS.md 완료 처리
- [ ] Phase 1B PLAN.md 초안 — 다음 사이클

---

## 변경 파일 요약

### 신규 (12)
**Pages** (`frontend/src/app/voice-studio/`):
- `layout.tsx`
- `page.tsx` (entry redirect)
- `clone-design/page.tsx`, `voices/page.tsx`, `batch/page.tsx`, `tools/page.tsx`, `settings/page.tsx`

**Components** (`frontend/src/components/voice-studio/`):
- `SideNav.tsx`, `VoiceCard.tsx`, `StudioPromoBanner.tsx`

**Lib**:
- `frontend/src/lib/voiceStudioApi.ts` (placeholder)

**Docs**:
- `docs/voice-upgrade-plan/phase1/PLAN.md`
- `docs/voice-upgrade-plan/phase1/PROGRESS.md`

### 수정 (4)
- `frontend/src/components/Header.tsx` (+11 / -1)
- `frontend/src/app/tts-voice/page.tsx` (+3 / -0)
- `frontend/src/lib/i18n/ko.ts` (+53 / -0)
- `frontend/src/lib/i18n/en.ts` (+53 / -0)

**합계**: 신규 12 + 수정 4 = **16 파일**.

---

## 빌드 검증 결과

```
▲ Next.js 16.1.6 (Turbopack)
✓ Compiled successfully in 16.5s
✓ Generating static pages using 3 workers (17/17) in 507.2ms

Route (app)
... (기존)
├ ○ /tts-voice                ← 기존 유지
├ ○ /voice-studio             ← 신규 entry (redirect)
├ ○ /voice-studio/batch       ← 신규 placeholder
├ ○ /voice-studio/clone-design ← 신규 placeholder
├ ○ /voice-studio/settings    ← 신규 placeholder
├ ○ /voice-studio/tools       ← 신규 placeholder
└ ○ /voice-studio/voices      ← 신규 실작동
```

---

## 다음 단계

PR 1A push → 머지 → 서버 배포 → Phase 1B (Clone & Design 본격 구현).
