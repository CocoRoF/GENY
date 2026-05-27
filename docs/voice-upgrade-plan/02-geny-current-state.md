# 02 — Geny 현재 TTS 스택 정밀 분석

> 대상: `/home/geny-workspace/Geny`
>
> 이 문서는 "지금 우리에게 무엇이 있고, 무엇이 없는가"의 정밀 스냅샷이다.
> 추측 없이 코드/디렉토리 1차 출처만 사용했다.

---

## 1. 프론트엔드 — `frontend/src/app/tts-voice/page.tsx` (565줄, 단일 페이지)

### 1.1 화면 구조

```
┌─────────────────────────────────────────────────────────┐
│ Sidebar (w-72)            │ Main                        │
│  ← Back to app            │  Top bar (title + ACTIVE)   │
│  + New                    │ ─────────────────────────── │
│                           │  Toast (success/error)      │
│  [Mic] paimon_ko    ★ 8   │                             │
│  [Mic] ruan_mei       3   │  ProfileDetail              │
│  [Mic] ellen_joe      0   │   ├ [Template] [Activate]   │
│  [Mic] my_voice    ★ 5   │   └ Emotion Refs (8 cards)  │
│                           │      ● neutral  [▶][⬆][🗑]   │
│                           │      ● joy      [▶][⬆][🗑]   │
│                           │      ● anger    ...          │
└─────────────────────────────────────────────────────────┘
```

### 1.2 기능

- **프로필 리스트**: `ttsApi.listProfiles()`로 사이드바.
- **프로필 선택**: `getProfile(name)` (없으면 list 데이터 fallback).
- **신규 생성 폼**: `name` (slug), `display_name`, `language` (ko/ja/en/zh) → POST.
- **Activate**: 한 번에 하나의 프로필이 GPT-SoVITS / OmniVoice의 활성 voice가 됨 → 별 배지.
- **감정 카드 8개** (`EMOTIONS` 상수에 하드코딩):
  - `neutral`, `joy`, `anger`, `sadness`, `fear`, `surprise`, `disgust`, `smirk`
  - 각 카드: 색상 점 + 라벨 + 액션 버튼 (▶ Play / ⬆ Upload / 🗑 Delete) + (있을 때) prompt_text input + prompt_lang select
  - Play: `getRefAudioUrl(name, emotion)` 로 audio 태그 stream
  - Upload: `.wav` 파일 → multipart `uploadRef(name, emotion, file, text?, lang?)`
  - Template 프로필은 read-only (`is_template` 분기)

### 1.3 빠진 것 (UX 측면)

- ❌ **합성 미리듣기**: ref만 들을 수 있지, "이 프로필로 임의 텍스트 합성"이 불가.
- ❌ **녹음 in-page**: 파일 업로드만 가능, 마이크 입력 안 됨.
- ❌ **waveform 트리밍**: 통째 wav만 받음, 5초 자르는 UX 없음.
- ❌ **보이스 디자인**: `instruct` 문자열 입력 없음 (백엔드 OmniVoice는 지원하는데 UI가 없음).
- ❌ **엔진 선택**: edge/openai/elevenlabs/gpt-sovits/omnivoice 중 어디로 합성될지 UI가 모름.
- ❌ **A/B 비교**: 같은 텍스트를 다른 프로필/엔진으로 비교 불가.
- ❌ **더빙 / 다이얼라이제이션 / 일괄처리 / 갤러리** 등은 자체 페이지가 없음.

### 1.4 다른 TTS 진입점

- `/app/tts-voice` 외에 별도 TTS 페이지 없음.
- 에이전트 채팅에서 자동 재생되는 흐름은 `/api/tts/agents/{sid}/speak/*` 호출이 백엔드에서 발화하지만 UI는 사이드바 audio 컨트롤 정도만 노출.

---

## 2. 프론트엔드 API — `frontend/src/lib/api.ts` (lines 2718–2898)

### 2.1 `VoiceProfile` 타입

```typescript
interface VoiceProfile {
  name: string;
  display_name: string;
  language?: string;
  is_template?: boolean;
  prompt_text?: string;        // 프로필 전체 default
  prompt_lang?: string;
  emotion_refs?: Record<string, { file: string; prompt_text?: string; prompt_lang?: string }>;
  has_refs?: Record<string, boolean>;
  active?: boolean;
  gpt_sovits_settings?: Record<string, unknown>;
}
```

### 2.2 `ttsApi` 메서드 (총 18개)

**합성**
- `speak(sid, text, emotion, lang, engine, signal)` → raw bytes
- `speakStream(sid, text, emotion, lang, engine, signal)` → NDJSON (`{seq, text, audio_b64, format, sample_rate}`)

**보이스 발견**
- `voices(lang?)` → 엔진별 VoiceInfo 리스트
- `preview(engine, voiceId, text?)` → 단일 합성 결과
- `status()` / `engines()`

**프로필 CRUD**
- `listProfiles()` / `getProfile(name)`
- `createProfile({name, display_name, language, prompt_text, prompt_lang})`
- `updateProfile(name, body)`
- `activateProfile(name)`
- `uploadRef(name, emotion, file, text?, lang?)` (multipart)
- `deleteRef(name, emotion)`
- `updateEmotionRef(name, emotion, {prompt_text, prompt_lang})`
- `getRefAudioUrl(name, emotion)` (URL 생성, 재생용)

**세션별 프로필**
- `getSessionProfile(sid)` / `assignSessionProfile(sid, name)` / `unassignSessionProfile(sid)`

### 2.3 스트리밍 헬퍼

`frontend/src/lib/`:
- `ttsSentenceStream.ts` — `/speak/stream` 의 NDJSON 파싱
- `ttsChunkStream.ts` — `/speak/chunks` 의 NDJSON 파싱 (프론트가 미리 분리한 sentences를 batch로 보냄)

---

## 3. 백엔드 — TTS 컨트롤러 (`backend/controller/tts_controller.py`, ~1450줄, 단일 파일)

### 3.1 합성 엔드포인트 3종

| Endpoint | Body | Response | 용도 |
|---|---|---|---|
| `POST /api/tts/agents/{sid}/speak` | text, emotion, language, engine? | raw audio bytes (chunked) | 한 번에 다 받기 |
| `POST /api/tts/agents/{sid}/speak/stream` | 동일 | NDJSON sentence chunks | 서버사이드 문장 분리 + 점진 재생 |
| `POST /api/tts/agents/{sid}/speak/chunks` | sentences[] | NDJSON | 프론트가 미리 분리한 배치 (OmniVoice semaphore가 동시성 제어) |

세 가지 모두:
1. 텍스트 sanitize
2. session profile 조회
3. 감정별 speed/pitch 적용 (config 기반)
4. 캐시 조회 (SHA256 키)
5. 엔진 health-check → 실패 시 edge_tts fallback

### 3.2 프로필 라우트 (9개)

| Method | Path | 동작 |
|---|---|---|
| GET | `/api/tts/profiles` | 리스트 |
| GET | `/api/tts/profiles/{name}` | 상세 + available_refs |
| POST | `/api/tts/profiles` | 생성 + profile.json + gpt_sovits_settings stub |
| PUT | `/api/tts/profiles/{name}` | 메타 업데이트 |
| POST | `/api/tts/profiles/{name}/ref` | ref wav 업로드 (multipart) |
| DELETE | `/api/tts/profiles/{name}/ref/{emotion}` | ref 삭제 |
| GET | `/api/tts/profiles/{name}/ref/{emotion}/audio` | wav stream |
| PUT | `/api/tts/profiles/{name}/ref/{emotion}` | prompt 메타 업데이트 |
| POST | `/api/tts/profiles/{name}/activate` | GPT-SoVITS/OmniVoice의 active voice로 설정 |

내장 템플릿: `/static/voices_seed/` → 부팅 시 `/static/voices/`에 자동 복사. 템플릿 프로필은 `_guard_template`로 read-only 강제.

### 3.3 세션 프로필 (3개)

- `GET /agents/{sid}/profile`, `PUT`, `DELETE`

### 3.4 메타/유틸

- `GET /voices`, `GET /voices/{engine}/{voice_id}/preview`, `GET /status`, `GET /engines`
- `GET /cache/stats`, `DELETE /cache`

### 3.5 라우터 패턴 분석

**1450줄 단일 파일** — 별도 라우터로 분리되어 있지 않음. OmniVoice-Studio의 `dub_core.py`(36 kLOC)도 큰 편이지만, 그쪽은 `tts_stream`, `dub_export`, `dub_generate`, `dub_translate` 등으로 도메인별 분리. 우리는 한 파일에 다 있어서 **확장 시 분리 리팩토링 필요**.

---

## 4. 백엔드 TTS 서비스 — `backend/service/vtuber/tts/`

### 4.1 디렉토리

```
tts/
├── base.py           ABC (TTSEngine, TTSRequest, TTSChunk, TTSSentenceChunk, VoiceInfo)
├── tts_service.py    오케스트레이터 싱글톤 (392줄)
├── cache.py          파일 + index LRU 캐시
└── engines/
    ├── edge_tts_engine.py
    ├── openai_tts_engine.py
    ├── elevenlabs_engine.py
    ├── gpt_sovits_engine.py
    └── omnivoice_engine.py    (26.3 KB — 가장 큼)
```

### 4.2 `TTSEngine` ABC — `base.py`

```python
@dataclass
class TTSRequest:
    text: str
    emotion: str = "neutral"
    language: str | None = None
    speed: float = 1.0
    pitch_shift: int = 0
    audio_format: AudioFormat = AudioFormat.MP3
    sample_rate: int = 24000
    voice_profile: VoiceProfile | None = None

class TTSEngine(ABC):
    @abstractmethod
    async def synthesize_stream(self, request) -> AsyncIterator[TTSChunk]: ...
    async def synthesize_sentence_stream(self, request) -> AsyncIterator[TTSSentenceChunk]: ...
    async def synthesize_single_sentence(self, request) -> TTSSentenceChunk: ...
    async def synthesize(self, request) -> bytes: ...
    async def get_voices(self, language=None) -> list[VoiceInfo]: ...
    async def health_check(self) -> bool: ...
    def apply_emotion(self, request): ...  # config의 speed/pitch 매핑 적용
```

⚠️ **OmniVoice-Studio의 `TTSBackend`와 비교하면 누락된 메타데이터**:
- ❌ `display_name`, `sample_rate` (class 레벨), `supported_languages`, `gpu_compat`
- ❌ `supports_voice_design`, `license`
- ❌ `is_available() -> (bool, reason)` (현재 `health_check() -> bool` 만 있음, 사유 없음)

### 4.3 `tts_service.py` 오케스트레이션

- 5 엔진 등록 (`_engines` dict): edge_tts(기본/fallback) / openai / elevenlabs / gpt_sovits / omnivoice
- `get_engine(name?)` — 미존재/health-fail 시 `edge_tts` fallback
- `speak(text, emotion, language, engine_name?, voice_profile?)` — LRU 캐시 + fallback chain
- `speak_sentences(text, ...)` — 서버사이드 문장 분리 (`streaming_mode` config 기반: off/auto/always)
- `speak_single_sentence(text, ...)` — 프론트가 분리한 1문장 처리
- `get_all_voices(lang?)`, `get_status()`

### 4.4 캐시 — `cache.py`

- 키: SHA256(text + "|" + emotion + "|" + engine + "|" + voice_id)
- 디렉토리: `/app/cache/tts/` + `_index.json` (LRU)
- TTL, max-size 설정 가능 (`tts_general_config.cache_*`)

### 4.5 `omnivoice_engine.py` (26.3 KB)

가장 큰 엔진 파일 — HTTP 클라이언트 (httpx) + `/Geny/omnivoice` 마이크로서비스 호출. clone/design/auto 모드 분기, ref_audio_path mapping (voice profile dir → 절대경로).

---

## 5. TTS 설정 — `backend/service/config/sub_config/tts/`

| 파일 | 주요 설정 |
|---|---|
| `tts_general_config.py` | `enabled`, `provider` (5종 enum), `auto_speak`, `default_language`, **emotion 매핑**(per-emotion speed/pitch), `audio_format`, `sample_rate`, **streaming 모드** (off/auto/always + min/max chars), 캐시 설정 |
| `omnivoice_config.py` | `api_url`(http://omnivoice:9881), `timeout`, `mode`(clone/design/auto), `voice_profile`, `instruct`, `language`, `num_step`, `guidance_scale`, `speed`, `duration_seconds`, `denoise`, `auto_asr`, `audio_format` |
| `gpt_sovits_config.py` | `api_url`(http://gpt-sovits:8000/tts), `voice_profile`, `ref_audio_dir`, `container_ref_dir`, emotion overrides |
| `edge_tts_config.py`, `elevenlabs_config.py`, `openai_tts_config.py` | API 키, voice id, model |

감정 매핑 예 (`tts_general_config.py`):
```python
emotion_speed = {"joy": 1.1, "anger": 1.2, "sadness": 0.9, "fear": 1.3, "surprise": 1.2, ...}
emotion_pitch = {"joy": 50, "anger": 20, "sadness": -50, "fear": 80, "surprise": 100, ...}
```

---

## 6. 디스크 — `backend/static/voices/`

내장 4종 (또는 그 수준):
```
voices/
├── paimon_ko/
│   ├── profile.json
│   ├── ref_neutral.wav
│   ├── ref_joy.wav
│   └── ...
├── ruan_mei/
└── ellen_joe/

voices_seed/   ← 부팅 시 voices/로 자동 복사 (template)
```

`profile.json` 스키마:
```json
{
  "name": "paimon_ko",
  "display_name": "파이몬 (한국어)",
  "language": "ko",
  "is_template": true,
  "prompt_text": "...",
  "prompt_lang": "ko",
  "emotion_refs": {
    "neutral": {"file": "ref_neutral.wav", "prompt_text": "...", "prompt_lang": "ko"},
    "joy": {...}
  },
  "gpt_sovits_settings": { "top_k": 5, "top_p": 1.0 }
}
```

⚠️ `gpt_sovits_settings`은 GPT-SoVITS 시절 유산. OmniVoice 전환 후 이 필드의 미래는 미정 (sample_rate, dtype, num_step 등 OmniVoice 파라미터로 마이그레이션 검토 필요).

---

## 7. OmniVoice 마이크로서비스 — `Geny/omnivoice/`

**별도 FastAPI 서비스, 포트 9881.** Geny 메인 백엔드가 `http://omnivoice:9881/...` HTTP로 호출.

### 7.1 디렉토리

```
omnivoice/
├── Dockerfile                CUDA 12.8 + PyTorch 2.8
├── omnivoice_core/           vendored k2-fsa/OmniVoice subset
│   ├── models/omnivoice.py
│   └── utils/{audio,duration,lang_map,text,voice_design,common}.py
├── server/
│   ├── main.py               FastAPI app + lifespan model load
│   ├── api.py                HTTP routes
│   ├── engine.py             threading.Lock + asyncio.Semaphore + sentence streaming
│   ├── voices.py             /voices 디렉토리 스캔
│   ├── streaming.py          wav/mp3/ogg/pcm encoding
│   ├── schemas.py
│   └── settings.py           OMNIVOICE_* env vars
├── baselines/
└── tests/
```

### 7.2 HTTP API

| Method | Path | Notes |
|---|---|---|
| GET | `/` | ServiceInfoResponse (version, model id, device, dtype) |
| GET | `/health` | phase ∈ {loading, warming, compiling, ok, error} + sampling_rate + max_concurrency |
| GET | `/voices` | 프로필 리스트 |
| GET | `/languages` | 600+ 언어명 |
| POST | `/tts` | 단발 합성 → audio bytes + X-OmniVoice-* 헤더 |
| POST | `/tts/stream` | 문장 단위 NDJSON (`seq`, `text`, `audio_b64`, `done` terminator) |

### 7.3 `engine.py` — 동시성 모델

- **`threading.Lock`**: OmniVoice는 thread-safe가 아님 → CUDA 에러 방지를 위해 GPU 호출 직렬화.
- **`asyncio.Semaphore`** (`OMNIVOICE_MAX_CONCURRENCY`): 큐 깊이 제한.
- **문장 스트리밍**: 모든 문장을 concurrent task로 제출 → GPU lock이 실제 모델 호출만 직렬화 → 결과를 buffer에서 seq 순서로 emit.

→ OmniVoice-Studio의 `core/job_queue.py` GPU 슬롯 큐와 같은 결의 디자인이 이미 있다. **Studio 레이어에서 잡 수준의 큐를 추가하더라도 OmniVoice 서비스 내부 슬롯과 직교**.

### 7.4 환경 변수 (`OMNIVOICE_*`)

| Var | Default | Description |
|---|---|---|
| `OMNIVOICE_MODEL` | `k2-fsa/OmniVoice` | HF repo id 또는 절대 경로 |
| `OMNIVOICE_DEVICE` | `cuda:0` | `cuda:N` / `cpu` / `mps` |
| `OMNIVOICE_DTYPE` | `float16` | `float16` / `bfloat16` / `float32` |
| `OMNIVOICE_PORT` | `9881` | uvicorn |
| `OMNIVOICE_VOICES_DIR` | `/voices` | profile dir mount |
| `OMNIVOICE_HF_CACHE` | `/models/hf-cache` | |
| `OMNIVOICE_AUTO_ASR` | `false` | Whisper 자동 transcript |
| `OMNIVOICE_ASR_MODEL` | `openai/whisper-large-v3-turbo` | |
| `OMNIVOICE_MAX_CONCURRENCY` | `4` | RTX 5070 12GB fp16 기준 |
| `OMNIVOICE_DEFAULT_NUM_STEP` | `16` | 32=quality, 16=balanced, 8–12=speed |
| `OMNIVOICE_GPU_MEMORY_FRACTION` | `0.85` | per-process VRAM cap |

---

## 8. Whisper STT — `whisper-stt/`

**현 상태: Dockerfile + entrypoint.sh만 존재 (placeholder).**

실제 Whisper 호출은 `backend/skills/bundled/whiteboard_voice_notes/` 스킬이 W2 PostCaptureHook에서 `whiteboard_transcribe(capture_id=...)` 호출로 이뤄짐. Whisper-large-v3 사용.

→ **dictation widget을 구현하려면 이 placeholder 위에 진짜 Whisper 서비스(faster-whisper 권장)를 올려야 한다.**

`docs/voice-notes/` 에 `01_DESIGN.md`, `02_PLAN.md`, `README.md` 가 있음 — voice-notes 스킬의 design 문서.

---

## 9. Geny가 이미 가진 것 vs OmniVoice-Studio 매핑

| 기능 | Geny 현재 | OmniVoice-Studio |
|---|---|---|
| 보이스 프로필 + 감정 ref | ✅ (8 감정) | ✅ |
| 합성 미리듣기 | ❌ | ✅ (CloneDesignTab) |
| 보이스 디자인(`instruct`) 입력 UI | ❌ (백엔드는 됨) | ✅ |
| 자연어로 보이스 디자인(ref 없이) | ❌ | ✅ (VoxCPM2) |
| 마이크 in-page 녹음 | ❌ | ✅ |
| Waveform 트리밍 | ❌ | ✅ (AudioTrimmer) |
| A/B 비교 | ❌ | ✅ (CompareModal) |
| 다중 엔진 picker UI | ❌ (백엔드는 5종) | ✅ (Settings + EngineCompatibilityMatrix) |
| 엔진 메타데이터 (gpu_compat, license, sample_rate) | ❌ | ✅ |
| 라이선스 게이트 다이얼로그 | ❌ | ✅ (Supertonic) |
| 더빙 파이프라인 | ❌ | ✅ (DubTab) |
| Diarization | ❌ | ✅ (pyannote 3.1) |
| Voice Gallery / 마켓 | ❌ | ✅ |
| Batch 큐 | ❌ | ✅ |
| Dictation widget | ❌ (스킬 내부에만) | ✅ (글로벌 단축키) |
| MCP server | ❌ (Geny 다른 MCP는 있음) | ✅ |
| OpenAI 호환 API | ❌ | ✅ |
| Watermark | ❌ | ✅ (AudioSeal) |
| 646언어 picker | ❌ (백엔드는 됨) | ✅ |
| Emotion vector (8-float) | △ (8 emotion 카드만) | ✅ (IndexTTS2) |
| Duration 제어 (립싱크) | ❌ | ✅ |
| GPU 슬롯 큐 | △ (omnivoice 내부에만) | ✅ (전역 job_queue) |
| Event Bus / SSE | ❌ | ✅ |
| Setup Wizard | ❌ (compose가 대신) | ✅ |
| Subprocess 엔진 격리 | ❌ | ✅ (SubprocessBackend) |

✅ = 보유, △ = 부분 보유, ❌ = 없음.

---

## 10. 결론 — 우리가 출발선에서 가진 자산

**튼튼한 것**:
- OmniVoice 마이크로서비스가 이미 동작 (646언어, clone/design/auto, /tts·/tts/stream, concurrency gate)
- 8-감정 프로필 시스템, 4개 템플릿 voice
- 5종 엔진 다중화 (edge/openai/elevenlabs/gpt-sovits/omnivoice) + cache + fallback chain
- 세션별 보이스 할당
- 1450줄 컨트롤러로 프로필/합성 CRUD는 거의 다 있음

**부족한 것** (UX 레이어 + 엔진 메타데이터 + 더빙):
- `tts-voice` 페이지에 합성 미리듣기/녹음/트리밍/instruct/A-B가 없음 → **백엔드는 다 되는데 UI가 못 활용 중**
- 엔진 ABC에 메타데이터 부족 → Compatibility Matrix UI 불가
- 더빙/diarization/dictation/MCP/Gallery 페이지 자체가 없음
- 컨트롤러 분할 필요 (1450줄 단일 파일)

다음 문서 [03-gap-and-applicability.md](./03-gap-and-applicability.md)에서 위 gap을 "흡수 가능 / 부분 가능 / 불가" 3-tier로 정리한다.
