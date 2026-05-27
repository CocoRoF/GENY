# Phase 1 — PR 1B: Clone & Design 본격 구현 PLAN

> Voice Studio 메인 페이지 (`/voice-studio/clone-design`) 본격 구현.
> OmniVoice의 풀 파라미터 표면(mode/instruct/num_step/guidance/duration/denoise/auto_asr/seed/format/sample_rate)을 모두 UI에 노출.
> 신규 백엔드 엔드포인트 2개 + 신규 프론트엔드 컴포넌트 6개.
>
> Backend 0 회귀가 KPI — 기존 `/api/tts/*` 30+ 엔드포인트 동결 유지.
> 기존 omnivoice 마이크로서비스 코드 무변경.
>
> 사용자 메모리 `feedback_verify_code_over_docs.md` 준수 — `_build_payload` / `_resolve_emotion_ref` 코드 검증 후 작성.

---

## 0. 스코프 요약

### 포함 (PR 1B)
- **Backend**: 신규 `voice_studio/` 라우터 모듈 (synthesis_preview + languages 2개 엔드포인트) + omnivoice_engine에 `synthesize_preview()` 추가.
- **Frontend**: `/voice-studio/clone-design` placeholder → 본격 메인 페이지.
  - `SynthesizeCard` (텍스트 + mode + emotion + ▶ Generate + waveform)
  - `AdvancedParamsPanel` (num_step / guidance / speed / duration / denoise / auto_asr / seed / format / sample_rate)
  - `InstructPanel` (instruct + presets)
  - `LanguagePicker` (646언어 검색 select)
  - `WaveformPreview` (wavesurfer.js wrap)
  - `EmotionRefSection` (기존 `tts-voice`의 `EmotionRefCard` 패턴을 voice-studio 로 포트)
- **Dependency**: `wavesurfer.js` (frontend 신규 패키지)
- **i18n**: ko/en 신규 키.

### 제외 (PR 1B 아님)
- 마이크 인-페이지 녹음 / Waveform 트리밍 — PR 2A
- 합성 히스토리 / save-as-ref — PR 2B
- 엔진 메타데이터 + Settings — Phase 3
- Batch / Tools — Phase 4

### 호환 보장
- 기존 `/api/tts/*` 30+ 엔드포인트 시그너처 동결.
- omnivoice 마이크로서비스 코드 무변경.
- 신규 라우터는 `/api/voice-studio/*` prefix.
- 기존 `tts-voice` 페이지 무변경.
- 기존 `ttsApi` 객체 무변경.

---

## 1. Backend 변경 명세

### 1.1 신규 파일

**Routers** (`backend/controller/voice_studio/`):
- `__init__.py` — sub-routers를 묶어 `router` 객체 1개로 export.
- `languages.py` — `GET /api/voice-studio/languages` (omnivoice `/languages` 프록시 + 1h 메모리 캐시).
- `synthesis_preview.py` — `POST /api/voice-studio/synth/preview`.

**Service** (`backend/service/voice_studio/`):
- `__init__.py`
- `synthesis_preview.py` — Pydantic 모델 `PreviewParams` + `PreviewResult` + omnivoice 호출 wrapper. profile / emotion → ref_audio_path resolution은 omnivoice_engine 의 `_resolve_emotion_ref` 재사용.

### 1.2 수정 파일

- `backend/service/vtuber/tts/engines/omnivoice_engine.py` — 신규 메서드 `synthesize_preview(params)` 추가. 기존 `synthesize_stream` / `_build_payload` 무변경.
- `backend/main.py` — `from controller.voice_studio import router as voice_studio_router` 추가 + `app.include_router(voice_studio_router)` 한 줄.

### 1.3 신규 엔드포인트 상세

#### `GET /api/voice-studio/languages`

OmniVoice 마이크로서비스의 `/languages` 응답을 프록시 + 메모리 캐시 (1시간 TTL).

**응답 (예시)**:
```json
{
  "languages": [
    {"code": "ko", "name": "Korean"},
    {"code": "en", "name": "English"},
    {"code": "ja", "name": "Japanese"},
    ...
    {"code": "abk", "name": "Abkhazian"}
  ],
  "count": 646,
  "cached_at": "2026-05-27T07:00:00Z"
}
```

OmniVoice의 `/languages` 응답 형식이 정확히 어떤지는 omnivoice/server/api.py 의 LanguagesResponse 를 확인하고 그대로 forward 또는 stable 형태로 정규화한다.

#### `POST /api/voice-studio/synth/preview`

**Request body (Pydantic)**:
```python
class PreviewParams(BaseModel):
    text: str = Field(..., min_length=1, max_length=2000)
    profile: Optional[str] = None
    emotion: Optional[str] = "neutral"
    mode: Literal["clone", "design", "auto"] = "clone"
    instruct: Optional[str] = None
    language: Optional[str] = None  # ISO code or empty (auto)
    speed: float = Field(1.0, gt=0.0, le=4.0)
    duration_seconds: Optional[float] = Field(None, gt=0.0)
    num_step: Optional[int] = Field(None, ge=1, le=128)
    guidance_scale: Optional[float] = Field(None, ge=0.0, le=10.0)
    denoise: Optional[bool] = None
    auto_asr: Optional[bool] = None
    seed: Optional[int] = Field(None, ge=0)
    audio_format: Literal["wav", "mp3", "ogg", "pcm"] = "wav"
    sample_rate: Optional[int] = Field(None, ge=8000, le=48000)
```

**Response**:
- `Content-Type`: `audio/wav` (또는 요청 format)
- **헤더**:
  - `X-VoiceStudio-Sample-Rate: 24000`
  - `X-VoiceStudio-RTF: 0.42` (omnivoice RTF 헤더 forward)
  - `X-VoiceStudio-Seed-Used: 12345` (effective seed)
  - `X-VoiceStudio-Duration-Seconds: 3.21`
  - `X-VoiceStudio-Engine: omnivoice`
- **Body**: raw audio bytes.

**Backend 흐름**:
```python
# controller/voice_studio/synthesis_preview.py
@router.post("/synth/preview")
async def preview(params: PreviewParams):
    from service.vtuber.tts.tts_service import get_tts_service
    omnivoice = get_tts_service().get_engine("omnivoice")
    result = await omnivoice.synthesize_preview(params)
    return Response(
        content=result.audio_bytes,
        media_type={
            "wav": "audio/wav", "mp3": "audio/mpeg",
            "ogg": "audio/ogg", "pcm": "application/octet-stream",
        }[params.audio_format],
        headers={
            "X-VoiceStudio-Sample-Rate": str(result.sample_rate),
            "X-VoiceStudio-RTF": f"{result.rtf:.4f}",
            "X-VoiceStudio-Seed-Used": str(result.seed_used or ""),
            "X-VoiceStudio-Duration-Seconds": f"{result.duration:.4f}",
            "X-VoiceStudio-Engine": "omnivoice",
        },
    )
```

### 1.4 `omnivoice_engine.synthesize_preview` 상세

기존 `synthesize_stream` 의 흐름과 다른 점: **풀 파라미터 표면 직접 forward, adaptive num_step 안 함, config default 와 user override 명확히 분리**.

```python
@dataclass
class PreviewResult:
    audio_bytes: bytes
    sample_rate: int
    rtf: float
    seed_used: Optional[int]
    duration: float

async def synthesize_preview(self, params: "PreviewParams") -> PreviewResult:
    """
    Voice Studio Synthesize 카드 전용 풀-파라미터 합성.

    기존 ``synthesize_stream`` 은 채팅용으로 adaptive num_step + config default
    적용을 자동 수행한다. 이 메서드는 사용자가 advanced 패널에서 명시한 값을
    그대로 forward (None인 필드만 config default 사용). UI에서 dial in 한
    그대로 합성한다.
    """
    from service.config.manager import get_config_manager
    from service.config.sub_config.tts.omnivoice_config import OmniVoiceConfig
    config = get_config_manager().load_config(OmniVoiceConfig)
    if not config.enabled:
        raise ValueError("OmniVoice is not enabled")

    # Profile / emotion → ref_audio_path resolution (clone / auto mode)
    profile = params.profile or config.voice_profile or ""
    mode = params.mode

    payload: dict = {
        "text": params.text,
        "mode": mode,
        "language": params.language or None,
        "speed": float(params.speed),
        "duration": float(params.duration_seconds) if params.duration_seconds else None,
        "num_step": int(params.num_step if params.num_step is not None else config.num_step),
        "guidance_scale": float(params.guidance_scale if params.guidance_scale is not None else config.guidance_scale),
        "denoise": bool(params.denoise if params.denoise is not None else config.denoise),
        "audio_format": params.audio_format,
        "sample_rate": int(params.sample_rate or 24000),
    }
    if params.seed is not None:
        payload["seed"] = int(params.seed)

    if mode in ("clone", "auto") and profile:
        ref_audio_path, prompt_text, _ = _resolve_emotion_ref(
            profile, params.emotion or "neutral"
        )
        if ref_audio_path:
            payload["mode"] = "clone"
            payload["ref_audio_path"] = ref_audio_path
            if prompt_text:
                payload["ref_text"] = prompt_text
            elif (params.auto_asr if params.auto_asr is not None else config.auto_asr):
                payload["ref_text"] = None
        elif mode == "clone":
            raise ValueError(
                f"OmniVoice mode=clone: profile '{profile}' has no ref audio for emotion '{params.emotion}'"
            )
        else:
            payload["mode"] = "auto"

    if mode == "design":
        instruct = (params.instruct or "").strip()
        if not instruct:
            raise ValueError("OmniVoice mode=design requires instruct")
        payload["instruct"] = instruct
    elif params.instruct:
        payload["instruct"] = params.instruct.strip()

    # Remove None values so omnivoice uses its own defaults for omitted keys
    payload = {k: v for k, v in payload.items() if v is not None}

    api_url = config.api_url.rstrip("/")
    timeout = max(float(config.timeout_seconds or 0.0), 180.0)
    client = await _get_client(api_url, read_timeout=timeout)
    logger.info(
        "voice-studio preview: mode=%s profile=%s lang=%s text_len=%d",
        payload.get("mode"), profile, payload.get("language"), len(params.text),
    )
    resp = await client.post(f"{api_url}/tts", json=payload)
    resp.raise_for_status()
    return PreviewResult(
        audio_bytes=resp.content,
        sample_rate=int(resp.headers.get("X-OmniVoice-Sample-Rate") or 24000),
        rtf=float(resp.headers.get("X-OmniVoice-RTF") or 0.0),
        seed_used=int(resp.headers.get("X-OmniVoice-Seed")) if resp.headers.get("X-OmniVoice-Seed") else params.seed,
        duration=float(resp.headers.get("X-OmniVoice-Duration") or 0.0),
    )
```

> 주: `PreviewParams` Pydantic 모델은 `service/voice_studio/synthesis_preview.py` 에서 정의하고 engine 메서드는 그 타입을 사용. 또는 forward reference 로 `"PreviewParams"` 문자열 + `TYPE_CHECKING` 가드. 후자가 깔끔.

### 1.5 `_resolve_emotion_ref` 재사용

기존 `omnivoice_engine.py` 에 `_resolve_emotion_ref(profile, emotion)` 함수가 이미 있음 (private). PR 1B 에서는:
- 옵션 A: `synthesize_preview` 가 같은 파일에 있으므로 그대로 import 없이 사용.
- 옵션 B: `_resolve_emotion_ref` 를 `service/voice_studio/voice_resolution.py` 로 추출 + 두 곳에서 import.

→ **옵션 A 선택**. PR 1B 스코프를 최소화. 추출은 향후 필요 시.

---

## 2. Frontend 변경 명세

### 2.1 신규 dependency

`frontend/package.json` 에 추가:
```json
"@wavesurfer/react": "^1.0.x"
```

또는 vanilla `wavesurfer.js` (`"wavesurfer.js": "^7.x"`). React wrapper 가 더 자연스럽다. 설치는 `bun add @wavesurfer/react` (서버에서 build 시점에 `bun install` 트리거됨).

> 대체안: wavesurfer.js 직접 import + `useEffect` 로 wrap. **단순성을 위해 vanilla wavesurfer.js 사용 권장** (deps 줄이고 SSR 안전).

### 2.2 신규 파일

**Components** (`frontend/src/components/voice-studio/`):
- `SynthesizeCard.tsx` — 메인 카드. 텍스트 + Mode + Emotion + Language + Generate + waveform.
- `AdvancedParamsPanel.tsx` — 토글 가능 ▾ 패널. num_step / guidance / speed / duration / denoise / auto_asr / seed / format / sample_rate.
- `InstructPanel.tsx` — Mode=design 또는 instruct override 입력. presets (Warm/Cold/Young/Old/Energetic/Calm).
- `LanguagePicker.tsx` — 646언어 검색 가능 dropdown. 처음 load 시 `voiceStudioApi.getLanguages()` 호출 + in-memory 캐시.
- `WaveformPreview.tsx` — wavesurfer.js wrap. blob URL → waveform 렌더 + play/pause + duration display.
- `EmotionRefSection.tsx` — 기존 `tts-voice/page.tsx` 의 `EmotionRefCard` 패턴 포트. 8 감정 카드 + 업로드/재생/삭제 + per-emotion prompt 편집.

### 2.3 수정 파일

- `frontend/src/app/voice-studio/clone-design/page.tsx` — placeholder 제거, 메인 페이지 본격 구현.
  ```tsx
  'use client';

  import { useEffect, useState, useCallback, useMemo } from 'react';
  import { useSearchParams } from 'next/navigation';
  import { ttsApi, type VoiceProfile } from '@/lib/api';
  import { useI18n } from '@/lib/i18n';
  import SynthesizeCard from '@/components/voice-studio/SynthesizeCard';
  import EmotionRefSection from '@/components/voice-studio/EmotionRefSection';

  export default function CloneDesignPage() {
    const { t } = useI18n();
    const params = useSearchParams();
    const profileFromUrl = params.get('profile') || undefined;

    const [profiles, setProfiles] = useState<VoiceProfile[]>([]);
    const [selectedName, setSelectedName] = useState<string | undefined>(profileFromUrl);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const loadProfiles = useCallback(async () => {
      try {
        setLoading(true);
        const res = await ttsApi.listProfiles();
        setProfiles(res.profiles || []);
        if (!selectedName && res.profiles?.length) {
          const active = res.profiles.find((p) => p.active);
          setSelectedName((active || res.profiles[0]).name);
        }
        setError(null);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    }, [selectedName]);

    useEffect(() => { loadProfiles(); }, []);  // eslint-disable-line react-hooks/exhaustive-deps

    const selected = useMemo(
      () => profiles.find((p) => p.name === selectedName) || null,
      [profiles, selectedName],
    );

    if (loading) return <div className="px-6 py-12 text-center text-[var(--text-muted)]">...</div>;
    if (error) return <div className="px-6 py-4 mx-6 mt-6 rounded-lg ...">{error}</div>;

    return (
      <div className="max-w-5xl mx-auto px-6 py-6 space-y-5">
        {/* Profile selector */}
        <div className="flex items-center gap-3">
          <span className="text-[0.75rem] text-[var(--text-muted)]">{t('voiceStudio.cloneDesign.profile')}</span>
          <select
            value={selectedName ?? ''}
            onChange={(e) => setSelectedName(e.target.value || undefined)}
            className="px-2.5 py-1.5 rounded-md bg-[var(--bg-tertiary)] border border-[var(--border-color)] text-[0.8125rem] text-[var(--text-primary)] outline-none focus:border-[var(--primary-color)]"
          >
            {profiles.map((p) => (
              <option key={p.name} value={p.name}>
                {p.display_name || p.name}{p.active ? ' ★' : ''}
              </option>
            ))}
          </select>
        </div>

        <SynthesizeCard profile={selected} />
        {selected && <EmotionRefSection profile={selected} onRefresh={loadProfiles} />}
      </div>
    );
  }
  ```

### 2.4 `voiceStudioApi.ts` 확장

```typescript
import type { VoiceProfile } from './api';

export interface PreviewParams {
  text: string;
  profile?: string;
  emotion?: string;
  mode?: 'clone' | 'design' | 'auto';
  instruct?: string;
  language?: string;
  speed?: number;
  duration_seconds?: number;
  num_step?: number;
  guidance_scale?: number;
  denoise?: boolean;
  auto_asr?: boolean;
  seed?: number;
  audio_format?: 'wav' | 'mp3' | 'ogg' | 'pcm';
  sample_rate?: number;
}

export interface PreviewResult {
  blob: Blob;
  blobUrl: string;       // caller is responsible for URL.revokeObjectURL
  sampleRate: number;
  rtf: number;
  seedUsed?: number;
  durationSeconds: number;
  engine: string;
}

export interface LanguageItem {
  code: string;
  name: string;
}

const PREVIEW_URL = '/api/voice-studio/synth/preview';
const LANGS_URL = '/api/voice-studio/languages';

export const voiceStudioApi = {
  async synthesizePreview(params: PreviewParams, signal?: AbortSignal): Promise<PreviewResult> {
    const res = await fetch(PREVIEW_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`synth/preview failed: ${res.status} ${text}`);
    }
    const blob = await res.blob();
    return {
      blob,
      blobUrl: URL.createObjectURL(blob),
      sampleRate: parseInt(res.headers.get('X-VoiceStudio-Sample-Rate') || '24000', 10),
      rtf: parseFloat(res.headers.get('X-VoiceStudio-RTF') || '0'),
      seedUsed: res.headers.get('X-VoiceStudio-Seed-Used')
        ? parseInt(res.headers.get('X-VoiceStudio-Seed-Used') || '0', 10) : undefined,
      durationSeconds: parseFloat(res.headers.get('X-VoiceStudio-Duration-Seconds') || '0'),
      engine: res.headers.get('X-VoiceStudio-Engine') || 'omnivoice',
    };
  },

  async getLanguages(signal?: AbortSignal): Promise<LanguageItem[]> {
    const res = await fetch(LANGS_URL, { signal });
    if (!res.ok) throw new Error(`languages failed: ${res.status}`);
    const data = await res.json();
    return data.languages || [];
  },
};
```

### 2.5 컴포넌트 개략 디자인

각 컴포넌트는 200~400 줄 수준. 정확한 코드는 작업 단계에서 작성하되 PLAN 에서는 인터페이스만:

```ts
// SynthesizeCard
interface SynthesizeCardProps { profile: VoiceProfile | null }
// 내부 상태: text, mode, emotion, language, advanced, instruct, busy, result, error
// 액션: handleGenerate (POST /synth/preview), handleDownload, handleRegenerateSameSeed

// AdvancedParamsPanel
interface AdvancedParamsPanelProps {
  values: AdvancedParams;
  onChange: (next: AdvancedParams) => void;
}
type AdvancedParams = Pick<PreviewParams,
  'num_step' | 'guidance_scale' | 'speed' | 'duration_seconds' |
  'denoise' | 'auto_asr' | 'seed' | 'audio_format' | 'sample_rate'
>;

// InstructPanel
interface InstructPanelProps {
  value: string;
  onChange: (s: string) => void;
}

// LanguagePicker
interface LanguagePickerProps {
  value: string;        // ISO code or '' = auto
  onChange: (code: string) => void;
}

// WaveformPreview
interface WaveformPreviewProps {
  src: string | null;        // blob URL
  durationLabel?: string;    // "0:03.21 / RTF 0.42"
}
// wavesurfer 인스턴스 useEffect로 mount/unmount, src 바뀌면 load
```

### 2.6 i18n 신규 키

`voiceStudio.cloneDesign.*` 네임스페이스 신규:
- `profile`, `mode.label`, `mode.clone`, `mode.design`, `mode.auto`
- `emotion.label`, `emotion.{neutral,joy,anger,sadness,fear,surprise,disgust,smirk}`
- `language.label`, `language.auto`, `language.searchPlaceholder`
- `instruct.label`, `instruct.placeholder`, `instruct.presets.label`
- `instruct.preset.{warm, cold, young, old, energetic, calm}`
- `advanced.label`, `advanced.numStep`, `advanced.guidance`, `advanced.speed`, `advanced.duration`, `advanced.denoise`, `advanced.autoAsr`, `advanced.seed`, `advanced.random`, `advanced.sampleRate`, `advanced.audioFormat`, `advanced.autoAsrHint`
- `generate`, `regenerateSameSeed`, `download`, `generating`
- `result.duration` ("0:03.21"), `result.rtf` ("RTF 0.42"), `result.seedUsed` ("seed {n}")
- `errors.{missingText, designNeedsInstruct, cloneNeedsRef}`
- `emotionRefs.{title, hint, noRef, upload, ...}` — 기존 ttsVoice 키 재사용 가능

### 2.7 EmotionRefSection 포팅

기존 `tts-voice/page.tsx` 의 `EmotionRefCard` 컴포넌트 + `ProfileDetail` 의 `handleUpload` / `handleDeleteRef` / `handleUpdateEmotionRef` 로직을 그대로 `EmotionRefSection.tsx` 로 포트. 같은 `ttsApi.uploadRef` / `deleteRef` / `updateEmotionRef` / `getRefAudioUrl` 호출.

다만 voice-studio 의 일관된 i18n 네임스페이스 사용. 기존 `ttsVoice.emotionRefs.*` 키를 재사용해도 OK (i18n 갱신 최소화), 또는 `voiceStudio.emotionRefs.*` 신규로 분리.

→ **결정**: 기존 `ttsVoice.emotionRefs.*` / `ttsVoice.noRef` / `ttsVoice.play` 등 그대로 재사용. EmotionRefSection 에서 `t('ttsVoice.emotionRefs')` 같은 호출만.

---

## 3. 작업 순서 (구현 순서)

1. **Backend 먼저**:
   - omnivoice_engine.py 에 `synthesize_preview` + `PreviewResult` dataclass 추가
   - service/voice_studio/synthesis_preview.py — `PreviewParams` Pydantic
   - controller/voice_studio/__init__.py + languages.py + synthesis_preview.py
   - main.py 에 voice_studio_router include
   - `python -m py_compile` 통과 확인
   - 백엔드 실행 후 curl 로 `POST /api/voice-studio/synth/preview` 응답 확인 — local 환경에 omnivoice 컨테이너가 없으면 502, 그래도 라우터/Pydantic 검증은 가능
2. **Frontend deps**:
   - `bun add wavesurfer.js` (또는 `@wavesurfer/react`)
   - lock 파일 갱신
3. **Frontend lib**:
   - `voiceStudioApi.ts` 확장
4. **Frontend components**: 순서 — WaveformPreview → LanguagePicker → AdvancedParamsPanel → InstructPanel → EmotionRefSection (포트) → SynthesizeCard (위 모두 조합)
5. **Frontend page**: `clone-design/page.tsx` 본격 구현
6. **i18n**: ko/en 신규 키
7. **Build**: `npm run build` 0 errors
8. **PR + 머지 + 서버 배포**: backend + frontend 모두 rebuild 필요
9. **운영 검증**: `/api/voice-studio/synth/preview` 호출 200, audio bytes 반환. UI 직접 시연.

---

## 4. 검증 절차

### 4.1 정적 검증

```bash
cd /home/geny-workspace/Geny/backend
python3 -m py_compile \
  service/vtuber/tts/engines/omnivoice_engine.py \
  service/voice_studio/synthesis_preview.py \
  controller/voice_studio/__init__.py \
  controller/voice_studio/languages.py \
  controller/voice_studio/synthesis_preview.py \
  main.py
# → all OK

cd /home/geny-workspace/Geny/frontend
npm run build 2>&1 | tail -20
# → 0 errors, 17 routes (no diff in route count)
```

### 4.2 런타임 검증 (서버 배포 후)

```bash
# 1) /api/voice-studio/languages
curl -s http://localhost:8000/api/voice-studio/languages | jq '.count, .languages[0]'
# → count >= 600, first item {code, name}

# 2) /api/voice-studio/synth/preview
curl -s -X POST http://localhost:8000/api/voice-studio/synth/preview \
  -H 'Content-Type: application/json' \
  -d '{
    "text": "안녕하세요. 오늘은 날씨가 좋네요.",
    "profile": "ellen_joe",
    "emotion": "neutral",
    "mode": "clone",
    "language": "ko",
    "num_step": 16,
    "seed": 12345
  }' \
  -D /tmp/headers.txt -o /tmp/out.wav
# → /tmp/out.wav exists, X-VoiceStudio-* headers populated

# 3) UI: /voice-studio/clone-design 진입 → 합성 미리듣기 동작
#    - text 입력 + Generate → 2초 이내 첫 audio
#    - instruct 입력 → mode=design 호출 → 다른 톤
#    - num_step 8 vs 32 → 시간 차이 청각 / 측정
#    - seed 고정 → 같은 결과 (bytewise 가능)
#    - 646언어 picker 검색 동작
#    - 회귀: 에이전트 채팅 TTS / /tts-voice 페이지 정상
```

### 4.3 회귀 체크리스트

- [ ] 기존 `/api/tts/*` 30+ 엔드포인트 동작 (변경 없음)
- [ ] 에이전트 채팅 `/speak/stream` 정상
- [ ] `/tts-voice` 페이지 정상 (배너 + 8 감정 카드)
- [ ] `/voice-studio/voices` 카드 그리드 정상
- [ ] omnivoice 마이크로서비스 코드 변경 없음 → 컨테이너 재시작 없이 backend 만 재기동

---

## 5. 리스크

| 리스크 | 완화 |
|---|---|
| `synthesize_preview` 도 omnivoice 직렬화 큐 (Semaphore) 거침 → 동시 호출 시 대기 | 정상 동작. 사용자에게 progress 표시 (frontend) |
| OmniVoice 첫 합성 cold start 30s+ | UI에 "generating..." + timeout 180s |
| wavesurfer.js SSR 충돌 | `'use client'` + dynamic import 또는 useEffect mount |
| blob URL 메모리 누수 | useEffect cleanup 에서 `URL.revokeObjectURL` |
| 너무 큰 PR (~1000 LOC) | 작업 단위 명시 (위 §3). 한 PR로 가지만 git history 에 의도 명시 |
| 646언어 데이터 1회 fetch 100KB+ | `cache: 'force-cache'` + 1h 메모리 캐시 (frontend) |
| `seed: undefined` ↔ `0` 혼동 | Pydantic Optional[int]은 None 만 omit. seed 0 은 의미 있는 값. 명시 |
| omnivoice 응답 헤더에 `X-OmniVoice-Seed` 없을 때 | 응답 헤더 없으면 input seed 그대로 반환 |
| `profile` URL query 가 잘못된 경우 | useState 가 자동으로 첫 active 또는 첫 profile fallback |

---

## 6. PR 정보

- 브랜치: `feature/voice-studio-phase1b`
- 제목: `feat(voice-studio): Clone & Design page with full OmniVoice parameter surface`
- 본문 요지:
  - `/api/voice-studio/synth/preview` + `/languages` 신규.
  - omnivoice_engine.py 에 `synthesize_preview` 추가 (기존 synthesize_stream 무변경).
  - `/voice-studio/clone-design` 본격 구현: SynthesizeCard + AdvancedParamsPanel + InstructPanel + LanguagePicker + WaveformPreview + EmotionRefSection 포트.
  - 기존 `/tts-voice` + `/api/tts/*` 모두 그대로.

---

## 7. 다음 단계

PR 1B 머지 + 서버 배포 + 사용자 시연 → Phase 2A (마이크 녹음 + Waveform 트리밍).
