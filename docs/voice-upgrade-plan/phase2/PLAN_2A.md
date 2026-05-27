# Phase 2 — PR 2A: 마이크 인-페이지 녹음 + Waveform 트리밍 PLAN

> Voice Studio Clone & Design 페이지의 감정 ref 워크플로우 강화.
> 사용자가 .wav 파일을 어디서 구해 업로드하는 대신, **브라우저 안에서 직접
> 녹음 → 트리밍 → 업로드**까지 한 번에 끝낸다.
>
> Backend 0 변경. 기존 `ttsApi.uploadRef()` 그대로 사용.
> wavesurfer.js 는 PR 1B에서 이미 추가됨.
>
> 사용자 메모리 `feedback_verify_code_over_docs.md` 준수 — EmotionRefSection
> 의 실제 액션 버튼 배치를 확인하고 작성.

---

## 0. 스코프 요약

### 포함 (PR 2A)
- **`lib/audioUtils.ts`** — Blob/AudioBuffer → 16-bit PCM WAV @ 24kHz 변환 + duration 측정 헬퍼.
- **`RecorderModal.tsx`** — `MediaRecorder` API. 마이크 권한 요청 → 녹음 → 정지 → 결과 미리듣기 → "트리밍 진행" or "그대로 업로드".
- **`TrimmerModal.tsx`** — wavesurfer.js + regions plugin. 5–15s 권장 영역 강조 + 시작/끝 점 드래그로 trim region 선택 → 잘라서 wav blob 생성 → upload 콜백.
- **`EmotionRefSection.tsx`** 수정 — 각 emotion card 에 🎙 (녹음) + ✂ (트리밍, ref 있을 때만) 액션 버튼 추가. 두 모달과 wire.
- **i18n** — ko/en 신규 키 (`voiceStudio.recorder.*`, `voiceStudio.trimmer.*`).

### 제외 (PR 2A 아님)
- Backend 변경 — 0. 기존 `POST /api/tts/profiles/{name}/ref` (`ttsApi.uploadRef`) 그대로.
- 합성 결과를 ref로 저장 — Phase 2B 로 분리. 현재 PR 은 "녹음/트리밍"에 집중.
- 합성 히스토리 — Phase 2B.
- auto_asr UI 강화 — 이미 PR 1B 의 AdvancedParamsPanel 에 토글 있음. Phase 2 에서 더 손대지 않음.
- 신규 패키지 — PR 1B 의 `wavesurfer.js` 만 사용. 자체 WAV 인코더로 외부 의존 추가 회피.

### 호환 보장
- 기존 `tts-voice` 페이지 무변경.
- 기존 `EmotionRefCard` 동작 (▶ 재생 / ⬆ 파일 업로드 / 🗑 삭제 / per-emotion prompt) 그대로.
- 추가된 🎙 / ✂ 버튼은 비-template 프로필에서만 활성 (기존 `isTemplate` 가드 재사용).
- 마이크 권한 거부 / 비-HTTPS 환경 / MediaRecorder 미지원 모두 graceful degrade.

---

## 1. 영향 범위

### 1.1 신규 파일

- `frontend/src/lib/audioUtils.ts` — 변환 유틸 (no React, browser API only)
- `frontend/src/components/voice-studio/RecorderModal.tsx`
- `frontend/src/components/voice-studio/TrimmerModal.tsx`

### 1.2 수정 파일

- `frontend/src/components/voice-studio/EmotionRefSection.tsx`
  - import RecorderModal + TrimmerModal
  - 각 카드의 액션 버튼 영역에 🎙 / ✂ 추가
  - 두 모달의 open/close state 관리
  - upload 콜백을 기존 `onUpload` 로 forward (multipart File 객체로)
- `frontend/src/lib/i18n/ko.ts` + `en.ts` — 신규 키
- (선택) `frontend/src/app/tts-voice/page.tsx` — 기존 페이지에도 같은 모달을 옵셔널로 노출할지? **결정: 안 함**. tts-voice 는 무변경. 사용자가 신기능을 쓰려면 Voice Studio 로 이동.

---

## 2. 구체 변경 명세

### 2.1 `lib/audioUtils.ts`

3 함수 export:

```typescript
/**
 * Decode an arbitrary audio Blob (webm/opus, ogg, mp3, ...) into an
 * AudioBuffer using the browser's AudioContext.
 */
export async function decodeAudio(blob: Blob): Promise<AudioBuffer> { ... }

/**
 * Encode an AudioBuffer (optionally sliced to [startSec, endSec]) into
 * a 16-bit PCM WAV blob at the target sample rate. Mono output.
 *
 * Default targetSampleRate = 24000 — matches OmniVoice's expected ref
 * audio rate and keeps file size small.
 */
export function encodeWav(
  buffer: AudioBuffer,
  opts?: { startSec?: number; endSec?: number; targetSampleRate?: number },
): Blob { ... }

/** Convenience: Blob → wav Blob via decodeAudio → encodeWav. */
export async function blobToWav(
  blob: Blob,
  opts?: { startSec?: number; endSec?: number; targetSampleRate?: number },
): Promise<Blob> { ... }
```

**구현 디테일**:
- decodeAudio: `new AudioContext().decodeAudioData(arrayBuffer)`. Safari 등 webkit prefix 처리.
- encodeWav: 표준 RIFF WAV 헤더 (44 bytes) + interleaved int16 PCM. 다채널 입력 시 평균하여 mono 다운믹스.
- targetSampleRate 가 buffer.sampleRate 와 다르면 linear interpolation 으로 resample.
- output blob `type: 'audio/wav'`.

### 2.2 `RecorderModal.tsx`

**Props**:
```typescript
interface RecorderModalProps {
  open: boolean;
  onClose: () => void;
  /** Called with the final wav blob when user confirms. */
  onConfirm: (wav: Blob, durationSec: number) => void;
  /** If true, opens Trimmer after recording finishes. */
  trimAfterRecord?: boolean;
}
```

**상태 머신**:
```
idle → requesting-permission → recording → recorded → (optionally) trimming → confirmed → close
                              └── error (permission denied / unsupported)
```

**UI**:
- 큰 마이크 버튼 (record ⏺ / stop ⏹).
- VU meter (record 중 RMS 시각화 — `AnalyserNode` + canvas).
- 녹음 시간 카운터 (0:00 → 0:12.34 ...).
- 녹음 끝나면 audio preview (`<audio>` element) + Trim 또는 그대로 Confirm.
- 오류 메시지: 권한 거부 / `MediaRecorder` 미지원 / non-secure context (HTTP) 안내.

**MediaRecorder 사양**:
- mimeType 우선순위: `audio/webm;codecs=opus` → `audio/webm` → `audio/mp4` → 빈 string (브라우저 default).
- audio constraints: `{ audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 48000 } }` — 마이크 입력은 48k로 받고, encodeWav 가 24k로 리샘플.
- 최대 60초 (UI에 시각적 limit).
- 정지 후 `dataavailable` chunks 모아 Blob 생성 → decodeAudio → encodeWav (resample to 24k) → onConfirm.

### 2.3 `TrimmerModal.tsx`

**Props**:
```typescript
interface TrimmerModalProps {
  open: boolean;
  /** Source audio (any decoded format). Closing wipes it. */
  source: Blob | null;
  onClose: () => void;
  /** Called with the trimmed wav (already 24k mono int16). */
  onConfirm: (wav: Blob, durationSec: number) => void;
}
```

**UI**:
- wavesurfer.js + regions plugin (`wavesurfer.js/dist/plugins/regions.esm.js`).
- 권장 영역(5–15s) 시각화: 1개 region pre-seeded with 시작 0s, 종료 = min(15s, duration). 사용자가 양쪽 핸들 드래그.
- 하단: 선택 구간의 길이 표시 + 권장 안내 ("5–15s 권장 · 현재 N.NN s").
- 액션: ▶ 미리듣기 (선택 구간만) / Confirm / Cancel.

**구현 디테일**:
- wavesurfer ready 후 region 자동 생성.
- region update 이벤트로 시작/끝 sec 추적.
- Confirm 시 `blobToWav(source, { startSec, endSec })` → onConfirm.
- 60초 미만 / 길이 < 1초 가드.

### 2.4 `EmotionRefSection.tsx` 수정

각 카드의 액션 행에 2개 버튼 추가 (uploading 상태에서는 숨김):

```tsx
{/* 기존 ▶ Play */}
{hasRef && <button onClick={togglePlay}>...</button>}

{!isTemplate && (
  <>
    {/* 기존 ⬆ Upload */}
    <button onClick={() => fileRef.current?.click()}>...</button>

    {/* 신규 🎙 Record */}
    <button onClick={() => setRecorderOpen(true)} title={t('voiceStudio.recorder.openTitle')}>
      <Mic size={12} />
    </button>

    {/* 신규 ✂ Trim — ref 있을 때만 */}
    {hasRef && (
      <button onClick={async () => {
        const url = ttsApi.getRefAudioUrl(profileName, emotion);
        const blob = await (await fetch(url)).blob();
        setTrimSource(blob);
        setTrimmerOpen(true);
      }} title={t('voiceStudio.trimmer.openTitle')}>
        <Scissors size={12} />
      </button>
    )}

    {/* 기존 🗑 Delete */}
    ...
  </>
)}
```

**모달 wire**:
- 카드 단위 또는 section 단위에서 RecorderModal / TrimmerModal 1쌍 띄우는 게 단순. 현재 선택된 emotion 을 state로 들고 있다가 `onConfirm` → `onUpload` 호출. 8 카드가 한 번에 하나의 모달만 보면 되므로 section level 이 깔끔.

→ 결정: `EmotionRefSection` 의 outer state 로 두 모달 + activeEmotion 관리.

**Upload flow**:
- onConfirm 받은 wav blob → `new File([blob], 'rec.wav', { type: 'audio/wav' })` → 기존 `onUpload(emotion, file, text?, lang?)` 호출 → 기존 `ttsApi.uploadRef` → 백엔드는 PR 0 이후의 `tts_controller.upload_reference_audio` 그대로 처리.

### 2.5 i18n 신규 키 (ko + en)

`voiceStudio.recorder.*`:
- `openTitle` = 마이크로 녹음
- `title` = "마이크 녹음"
- `start` / `stop` / `retry` / `confirm` / `cancel`
- `permissionDenied` / `unsupported` / `nonSecure` (HTTPS 안내) / `recording` / `recorded`
- `durationLabel` (`{sec}` interpolation)
- `hint` — 짧은 안내 (5–15초가 적절함)

`voiceStudio.trimmer.*`:
- `openTitle` = 잘라내기
- `title` = "오디오 자르기"
- `cancel` / `confirm`
- `regionHint` (`5–15s 권장 · 현재 {sec}s`)
- `tooShort` (< 1s) / `tooLong` (> 60s)

---

## 3. 작업 순서

1. branch `feature/voice-studio-phase2a` 생성
2. `lib/audioUtils.ts` 작성
3. `RecorderModal.tsx` (Trimmer 없이 단독 동작 가능)
4. `TrimmerModal.tsx`
5. `EmotionRefSection.tsx` 에 두 모달 wire + 액션 버튼 추가
6. i18n ko/en 신규 키
7. `npm run build` 0 errors
8. commit + PR + 머지 + 배포 + 운영 시연

---

## 4. 검증 절차

### 4.1 정적 검증

```bash
cd /home/geny-workspace/Geny/frontend
npm run build 2>&1 | tail -30
# → 0 errors, 17 routes (변동 없음)
```

### 4.2 런타임 검증

**`/voice-studio/clone-design` 에서**:
- 비-template 프로필 선택 (e.g. `mao_pro`, `shlee` — `is_template: false` 인 것).
- 어떤 emotion 카드의 🎙 클릭 → RecorderModal 표시.
  - 권한 허용 → 녹음 시작 → 5초 정도 말하고 정지 → preview 재생 정상.
  - "트리밍 진행" → TrimmerModal 표시.
  - region 드래그 → 길이 표시 갱신.
  - Confirm → wav 업로드 → 카드의 ref 표시 갱신.
- ref 가 있는 카드의 ✂ 클릭 → 기존 ref 를 TrimmerModal 에 로드 → 자르고 다시 업로드.
- 권한 거부 시: 친절한 안내 + 모달 닫힘.
- HTTPS 가 아닌 환경: "HTTPS 또는 localhost 가 필요" 안내.
- template 프로필 (paimon_ko/ruan_mei/ellen_joe): 🎙 / ✂ 버튼 안 보임 (기존 `isTemplate` 가드).
- 회귀: 기존 ⬆ 파일 업로드 / 🗑 삭제 / per-emotion prompt 편집 모두 정상.

---

## 5. 리스크

| 리스크 | 완화 |
|---|---|
| HTTPS 아닌 환경에서 `getUserMedia` 실패 | `window.isSecureContext` 검사 + 안내 |
| Safari iOS — webm 미지원 | mimeType polyfill 우선순위 (`audio/mp4`), 그래도 안 되면 안내 |
| 자체 WAV 인코더 버그 (PCM little-endian / sample rate calc 잘못) | 단위 테스트로 sanity check (선택). 또는 24kHz fixed + 1ch + int16 단순화. |
| AudioContext autoplay policy → user gesture 필요 | Modal open 자체가 gesture 안에서 발생 → OK |
| wavesurfer.js regions plugin SSR 충돌 | `'use client'` + dynamic import 내부에서 plugin import |
| 큰 녹음 (60초 24k mono int16 = ~2.9MB) → upload 느림 | 최대 길이 60초 cap + UI 표시 |

---

## 6. PR 정보

- 브랜치: `feature/voice-studio-phase2a`
- 제목: `feat(voice-studio): in-page mic recording + waveform trimming for emotion refs`
- 본문 요지:
  - 마이크 녹음 + 트리밍 모달 2개 + audioUtils.ts.
  - EmotionRefSection에 🎙 / ✂ 버튼 추가.
  - 백엔드 0 변경 — 기존 `ttsApi.uploadRef` 재사용.
  - 권한/비-secure/미지원 graceful 처리.

---

## 7. 다음 단계

PR 2A 머지 + 서버 배포 → Phase 2B (합성 히스토리 + 합성 결과를 ref로 저장).
