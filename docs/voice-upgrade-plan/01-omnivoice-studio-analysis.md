# 01 — OmniVoice-Studio 전체 기능 분석

> 레퍼런스: `/home/geny-workspace/OmniVoice-Studio` (debpalash/OmniVoice-Studio, v0.2.7, FSL-1.1-ALv2 라이선스)
>
> "오픈소스 ElevenLabs 대안" — Tauri 데스크톱 앱 + FastAPI 백엔드 + React/Vite 프론트엔드.
> 646언어 zero-shot voice cloning, 비디오 더빙, real-time dictation, 모두 로컬.

---

## 1. 프로젝트 전체 구조

```
OmniVoice-Studio/
├── backend/           FastAPI 서버
│   ├── main.py        cuDNN 사전로딩, HF 캐시 경로, 로깅 필터
│   ├── api/routers/   23개 라우터 (얇은 HTTP 레이어)
│   ├── core/          config / db / event_bus / job_queue / job_store / personalities
│   ├── engines/       엔진별 서브패키지 (subprocess 분리 대상)
│   │   ├── _echo/             테스트용 sidecar (wire protocol 검증)
│   │   ├── indextts/          IndexTTS-2 (감정 분리, duration 제어)
│   │   ├── omnivoice_gguf/    GGUF 양자화 (CPU/MPS)
│   │   └── supertonic3/       Supertone v3 (ONNX CPU)
│   ├── services/      비즈니스 로직 (tts_backend, dub_pipeline 등 25개)
│   ├── schemas/       Pydantic 모델
│   └── mcp_server.py  MCP 서버 (stdio/SSE)
│
├── frontend/          React 19 + Vite + Tauri
│   ├── src/pages/     11개 페이지 (CloneDesignTab, DubTab, …)
│   ├── src/components/  50+ 재사용 컴포넌트
│   └── src-tauri/     Rust 데스크톱 셸 (글로벌 단축키)
│
├── omnivoice/         k2-fsa/OmniVoice 모델 패키지 (vendored)
├── tests/             백엔드/프론트 통합 테스트
├── scripts/           install.sh / run.sh / smoke-test.sh
├── deploy/            Dockerfile + docker-compose.yml
└── docs/              ROADMAP / STRUCTURE / engines / features
```

핵심 설계 원칙:
- **얇은 라우터 + 두꺼운 서비스**: HTTP는 직렬화/검증만, 로직은 `services/`에 집중.
- **Lazy registry**: 엔진 모듈은 첫 사용 직전에 import → cold start <2s.
- **Subprocess isolation**: deps 충돌(IndexTTS의 `transformers<5` vs 부모 `≥5.3`)을 venv 단위로 분리.
- **GPU slot accounting**: 동시 합성을 직렬화하여 OOM·posix_spawn EAGAIN 회피.

---

## 2. TTSBackend 추상화 — 엔진 플러그인 아키텍처

### 2.1 인터페이스 — `backend/services/tts_backend.py`

```python
class TTSBackend(ABC):
    id: str                         # "omnivoice", "indextts2", ...
    display_name: str               # UI 라벨
    sample_rate: int                # 출력 Hz
    supported_languages: list[str]  # ["multi"] 또는 ISO 코드 리스트
    gpu_compat: tuple[str, ...]     # ("cuda", "mps", "rocm", "cpu")
    supports_voice_design: bool     # 자연어 설명만으로 보이스 생성 가능?
    license: str                    # "Apache-2.0", "OpenRAIL-M", "Custom-Bilibili" ...

    @abstractmethod
    def generate(self, text: str, **kw) -> torch.Tensor:  # (1, n_samples) @ sample_rate
        ...

    def is_available(self) -> tuple[bool, str]:  # (사용 가능?, 사유)
        ...
```

선택은 `OMNIVOICE_TTS_BACKEND` env → `settings_store` 영속값 → default(`omnivoice`) 순으로 cascading. 실패한 엔진은 `_LAST_ERRORS`에 사유 캐시되어 UI Compatibility Matrix가 그것을 그대로 표시한다.

### 2.2 탑재된 엔진 카탈로그

| 엔진 | 실행 형태 | 모델/SR | 언어 | 보이스 디자인 | GPU | 라이선스 |
|---|---|---|---|---|---|---|
| **OmniVoice** (in-process, default) | 부모 프로세스 | k2-fsa/OmniVoice, 24kHz | 646 (zero-shot) | `instruct` 문자열 | CUDA/MPS/CPU | Apache-2.0 (wrapper) + OpenRAIL-M (weights) |
| **OmniVoice-GGUF** | 별도 subprocess (binary `omnivoice-tts-<platform>`) | Serveurperso/OmniVoice-GGUF, 24kHz | 646 | 동일 | CUDA/MPS/CPU 양자화 | 동일 + binary SHA-256 검증 |
| **VoxCPM2** (옵션) | in-process (`pip install voxcpm`) | 48kHz | 30 (ko 포함) | **텍스트 설명만으로** | CUDA/MPS/CPU | 사유 (OpenBMB) |
| **IndexTTS-2** | subprocess (별도 venv: `transformers<5`) | IndexTeam/IndexTTS-2, 24kHz | zh, en | **감정 분리** (timbre vs emotion), **duration 제어** | CUDA preferred | Custom Bilibili (비상업) |
| **Supertonic-3** | subprocess (ONNX CPU EP) | Supertone v3, 44.1kHz | 31 + "na" | 7 preset (no clone) | **CPU only** (정직 표기) | MIT (code) + OpenRAIL-M (weights), 1회 동의 게이트 |
| **CosyVoice** (옵션) | in-process (`git clone --recursive`) | FunAudioLLM/CosyVoice v1~v3, 24kHz | 9 + 방언 | instruct + dialect (四川话, 河南话…) | CUDA/CPU | Apache-2.0 |
| **MOSS-TTS-Nano** / **KittenTTS** / **MLX-Audio** / **GPT-SoVITS** / **Sherpa-ONNX** | scaffolded | — | — | — | — | — |

### 2.3 SubprocessBackend wire protocol — `backend/services/subprocess_backend.py`

```
[4-byte BE uint32 length][N bytes UTF-8 JSON]

Parent → sidecar : ping / synthesize / shutdown
Sidecar → parent : ready / pong / audio / progress / error / gpu_acquire / gpu_release
Frame cap        : 64 MB (DoS 방어, T-02-01)
Inbound allowlist: PARENT_INBOUND_OPS (compromise 방어, T-02-04)
GPU 슬롯         : sidecar 사망 시 finally로 release (leak 방어, T-02-02)
Spawn timeout    : 30s (torch.compile 첫 로드 보정)
Process group    : start_new_session=True / CREATE_NEW_PROCESS_GROUP (Tauri group-kill 격리)
Stderr drain     : 비동기 thread + HFTokenRedactor 필터
```

서브클래스는 `venv_python()`과 `sidecar_script()` 두 메서드만 오버라이드한다 — 그것이 "엔진을 50줄로 추가"의 의미.

### 2.4 Plugin SDK — `backend/services/plugin_sdk.py`

```python
@register_plugin
class MyTTS(TTSBackend):
    id = "my-tts"
    ...
```

`list_plugins()`이 프론트엔드 picker에 노출. ElevenLabs/XTTS/Bark/Fish 같은 외부 엔진을 코어 수정 없이 흡수.

---

## 3. 핵심 서비스 (`backend/services/`)

### 3.1 `dub_pipeline.py` — 더빙 파이프라인 (500+ 줄)

4단계 흐름: **transcribe → translate → re-voice → mux**.

```
1. ffmpeg 추출 → vocals.wav / no_vocals.wav (Demucs)
2. WhisperX + pyannote diarization → {start, end, text, speaker}
3. speaker_clone.extract() → 화자별 5–15초 깨끗한 ref 자동 추출
4. translator → 목표 언어
5. batched_tts → 세그먼트별 재합성 (duration 제어로 립싱크 맞춤)
6. ffmpeg mux → vocals(새) + no_vocals(원본 BGM) → MP4
```

- **Job state**: in-memory `_dub_jobs` + content-hash 캐시 (`find_cached_job`) — 같은 영상 재처리 시 transcript 재사용
- **Process tracking**: `_active_procs` + `kill_job_procs()` — abort 시 ffmpeg/demucs 사이드카 정리
- **SSE helpers**: `sse_event()` — 진행률 push
- **Path safety**: `safe_job_dir()` — traversal 방어
- **Artifact**: `~/omnivoice_data/dub_jobs/{job_id}/`

### 3.2 `speaker_clone.py` — 자동 ref 추출 (200줄)

diarization으로 speaker_id가 붙은 뒤, **5–15초 깨끗한 구간을 화자별로 longest-first**로 골라낸다.
- min: 5s, ideal: 8s, max: 15s (그 이상은 컨텍스트 낭비)
- 무음 20ms 패딩 (phoneme aligner anchor)
- 화자별 audio가 5초 미만이면 default voice fallback
- 결과: `{speaker_id: {ref_audio_path, ref_text, duration, source_count}}`

→ **사용자가 ref를 수동 업로드 안 해도 영상 한 편이면 모든 화자의 보이스 프로필이 자동 생성**된다.

### 3.3 `asr_backend.py` — 다중 ASR 백엔드 (800+ 줄)

`TTSBackend`와 같은 protocol 패턴. 탑재:
- **WhisperXBackend** (default): CTranslate2(faster-whisper) + wav2vec2 forced-alignment → word-level timestamp
- **MLXWhisperBackend** (mac-ARM 옵션)
- **PyTorchWhisperBackend** (fallback)

선택: `OMNIVOICE_ASR_BACKEND` env (default: auto, prefer faster-whisper).

### 3.4 `batched_tts.py` — 병렬 합성 (200줄)

`job_queue`의 GPU 슬롯 쿼터를 존중하면서 세그먼트들을 병렬 합성. 더빙 export 단계의 핵심.

### 3.5 `watermark.py` — AudioSeal (Meta)

합성음 식별을 위한 imperceptible 워터마크. YouTube 재인코딩 후에도 detect 가능.

### 3.6 `rvc.py` — Retrieval-based Voice Conversion

합성 후처리 timbre 조정. 더빙 preview 체인의 옵션.

### 3.7 `model_manager.py` — 원클릭 모델 다운로드 (600+ 줄)

- `get_model()` → OmniVoice 싱글톤 (모든 `generate()` 공유)
- `get_best_device()` → CUDA > MPS > CPU
- HF 캐시 자동 라우팅 (`HF_HOME` / `HF_HUB_CACHE` / `TORCH_HOME`)
- CUDA 시 fp16 자동 변환, ASR 코모델 동시 로드

### 3.8 `settings_store.py` + `token_resolver.py`

- **settings_store**: 암호화 SQLite `~/omnivoice_data/settings.db` — 엔진 선택, 라이선스 동의 플래그, 모델 경로
- **token_resolver**: HF_TOKEN 4-소스 cascade — Settings 입력 > env > `~/.huggingface/token` > git credential

### 3.9 `translation_engines.py` + `translator.py`

Google Translate / LibreTranslate(self-hosted) / DeepL. + 별도 `sonitranslate.py`로 SoniTranslate 통합.

### 3.10 `segmentation.py` + `subtitle_segmenter.py` (900+ 줄)

Whisper raw 결과를 더빙 청크로 분해:
- min 0.5s / max 10s
- silence-aware split (단어 중간 자르지 않음)
- speaker continuity (0.8s 이내 같은 화자면 merge)
- SRT/VTT 타이밍 정렬

---

## 4. API 라우터 (23개) — `backend/api/routers/`

핵심만 발췌:

| 라우터 | 역할 |
|---|---|
| `tts_stream.py` | **WebSocket 스트리밍 TTS** (실시간 청크) |
| `capture_ws.py` | **WebSocket 실시간 dictation** (partial + final transcript) |
| `capture.py` | HTTP fallback dictation |
| `dub_core.py` | 더빙 잡 lifecycle (36 kLOC, `dub_pipeline.py`와 공동 소유) |
| `dub_export.py` | 비디오 mux + bitrate 최적화 → MP4/WebM |
| `dub_generate.py` | 세그먼트별 재합성 (speaker clone + TTS dispatch) |
| `dub_translate.py` | 번역 + glossary override |
| `engines.py` | TTS/ASR/LLM 엔진 picker + health (`POST /engines/select`) + **Compatibility Matrix** |
| `generation.py` | 일회성 합성 (더빙 외) |
| `gallery.py` | Voice Gallery CRUD + 마켓플레이스 |
| `profiles.py` | 보이스 프로필 영속화, 더빙 잡에서 자동 클론 |
| `batch.py` | 배치 큐 (50 영상 등) |
| `events.py` | **SSE** — 사이드바 푸시 (프로젝트/프로필/히스토리) |
| `settings.py` | 백엔드 설정 (엔진, 라이선스, 토큰) |
| `watermark.py` | AudioSeal embed/detect |
| `glossary.py` | 프로젝트별 번역 용어집 |
| `openai_compat.py` | **OpenAI TTS API 호환** (외부 도구 drop-in) |
| `marketplace.py` | 보이스 모델 마켓 |
| `projects.py` | 프로젝트 = 더빙 잡 묶음 + 메타 |
| `tools.py` | phoneme stress, 언어 감지 등 유틸 |

---

## 5. 프론트엔드 페이지 (11개) — `frontend/src/pages/`

| 페이지 | UX |
|---|---|
| **CloneDesignTab** | 텍스트 입력 + ref 업로드/녹음 → 실시간 WebSocket preview → 프로필로 저장. 자연어 설명만으로 보이스 생성도 가능. |
| **DubTab** | 비디오 업로드 또는 YouTube URL → diarization → speaker clones 자동 → 번역 → 세그먼트 테이블(`DubSegmentRow`/`DubSegmentTable`) → preview → export. SSE로 잡 진행률 push. |
| **VoiceGallery** | 사전-클론된 보이스 + 마켓 카탈로그. 언어/성별/스타일 필터. 1-click 사용. |
| **VoiceProfile** | 프로필 에디터: 메타(이름, 성별, 액센트), ref 오디오, `instruct` 문자열. 마켓 publish. |
| **BatchQueue** | CSV 업로드(영상 경로 + 목표 언어) → 잡별 큐 위치/ETA → 개별 cancel. |
| **Transcriptions** | 모든 transcribe/diarize 기록. 언어·화자 수 필터. SRT/VTT 다운로드. |
| **Settings** | 엔진(TTS/ASR/LLM) picker, HF 토큰, 라이선스 동의, 오디오 이펙트 프리셋, **EngineCompatibilityMatrix** 컴포넌트, 모델 캐시 관리, **LogsFooter** (라이브 백엔드/프론트/Tauri 로그). |
| **SetupWizard** | 첫 실행: 시스템 체크 → HF 토큰 → 모델 preload → warmup synth. `ReadinessChecklist` 컴포넌트. |
| **ToolsPage** | phoneme 시각화, 언어 감지, 오디오 분석(RMS/pitch). |
| **Projects** | 더빙 잡을 영화/에피소드 단위로 묶기. 타임라인 view, 버전 비교, export 히스토리. |
| **Launchpad** | 빠른 진입: Solo TTS / Batch / Video upload / Voice cloning + **글로벌 단축키**(⌘+⇧+Space 등). |

### 5.1 주목할 컴포넌트

- `CaptureWidget.jsx` — 글로벌 dictation widget (Tauri 윈도우)
- `WaveformTimeline.jsx` + `AudioTrimmer.jsx` — ref 오디오 트리밍 UI
- `VoicePreview.jsx` — 합성 결과 빠른 비교 (A/B)
- `CompareModal.jsx` — 동일 텍스트를 여러 엔진/프로필로 합성하여 비교
- `EngineCompatibilityMatrix.jsx` — 엔진 × GPU × 언어 매트릭스
- `SupertonicLicenseDialog.jsx` — 1회 동의 게이트
- `MultiLangPicker.jsx`, `SearchableSelect.jsx` — 646언어 picker
- `StoriesEditor.jsx` — long-form narrative (단락별 voice/emotion 지정)
- `FloatingPill.jsx` + `NotificationPanel.jsx` — 잡 진행률 push UI

---

## 6. 핵심 기능 심층

### 6.1 Voice Design

**자연어 설명만으로 보이스 생성** — ref 오디오 없이.

- **VoxCPM2**: `generate_from_description(description="warm young female british accent")` → 진짜 voice design
- **OmniVoice (in-process)**: `instruct="female, low pitch, slow"` 파라미터로 디자인 흉내 (실제로는 학습된 prior를 prompt-driven으로 끌어옴)
- **IndexTTS-2**: emotion vector `[happy, angry, sad, afraid, disgusted, melancholic, surprised, calm]` 각 0.0~1.0으로 조합

### 6.2 Dictation Widget — `capture_ws.py`

글로벌 단축키 ⌘+⇧+Space (Tauri) → 떠다니는 패널 → 마이크 capture → WebSocket `/ws/transcribe`:
- 매 2초마다 partial transcript
- 발화 종료 감지 → final transcript
- "transcribe and paste" 모드: 결과를 OS clipboard로 인젝션 + 활성 앱에 paste 시뮬레이션

→ Slack/Notion/IDE 어디서나 동작.

### 6.3 MCP Server — `backend/mcp_server.py`

stdio 또는 SSE transport로 Claude·Cursor에 노출:

**Tools**:
- `generate_speech(text, language, profile_id, instruct, speed, steps)` → `{audio_id, duration, base64_wav}`
- `list_voices()` → 저장된 프로필
- `list_languages()` → 646언어
- `list_personalities()` → 보이스 프리셋 라이브러리

**Resources**:
- `voice://{profile_id}` — 프로필 메타
- `history://recent` — 최근 합성 결과

실행: `python -m backend.mcp_server` (stdio, Claude Desktop용) 또는 `--sse` 플래그 (원격 에이전트용).

### 6.4 646언어

`k2-fsa/OmniVoice`의 학습 데이터 — 581k 시간, 646 언어. `docs/languages.md`에 ISO 639-3 코드 + 학습 시간이 모두 나열되어 있다.
- 메이저: 중국어 111k h, 영어 206k h
- 마이너/소수: 아브하즈어 57h, 아일랜드어 21h

### 6.5 Diarization — `docs/features/diarization.md`

PyAnnote 3.1 + WhisperX. HF 라이선스 게이트 (https://huggingface.co/pyannote/speaker-diarization-3.1 에서 약관 동의 필요). 미동의 시 silence-gap heuristic으로 fallback (정확도 ↓). 모델 ~600MB.

### 6.6 Watermarking — AudioSeal (Meta)

합성 출력 WAV에 invisible 바이너리 시그널 임베드. YouTube 재인코딩/MP3 compression 후에도 detect 가능 → "이 오디오는 AI 합성됨" 검증.

### 6.7 OpenAI 호환 API — `openai_compat.py`

`POST /v1/audio/speech` 시그너처를 모방 → 외부 도구(OpenWebUI, LangChain 등)가 ElevenLabs/OpenAI 대신 OmniVoice를 drop-in으로 사용.

---

## 7. 아키텍처 패턴 — 흡수할 만한 디자인

### 7.1 GPU 슬롯 큐 — `core/job_queue.py`

단일 GPU 워커 + 비동기 task 게이트. 각 `generate()`이 슬롯 1개 acquire → 합성 → release.
- OOM 방지 (두 번째 더빙이 동시에 시작되면 VRAM 폭발)
- macOS posix_spawn EAGAIN 방지 (프로세스 테이블 한계)
- UI: "당신 앞에 2개 잡 대기 중"을 큐 introspection으로 노출.

### 7.2 Event Bus + SSE — `core/event_bus.py` + `events.py`

Fire-and-forget pub/sub. `emit(kind, payload)` → 모든 연결된 프론트엔드에 broadcast (WebSocket). 45초 polling 제거. payload는 영속화 안 함 — "재페치하라" 신호일 뿐.

### 7.3 Lazy Registry

엔진 dict는 `_LazyRegistry` descriptor — 첫 접근 시 import. cold start <2s 유지, 10+ 엔진 옵션이 있어도.

### 7.4 Content-hash Cache

`find_cached_job(file_hash)` — 동일 영상은 transcript/vocals 재사용. 더빙 재시도 비용 ↓.

### 7.5 정직한 하드웨어 표기 (TTS-04)

Supertonic3의 `is_available()`는 GPU에서도 reason="cpu"를 반환 — upstream SDK가 CUDA path가 없기 때문. UI Compatibility Matrix는 이 메타데이터로 "이 엔진은 실제로 당신의 GPU를 안 씁니다"를 정직히 표시.

### 7.6 라이선스 게이트 (TTS-05)

Supertonic3 첫 사용 시 MIT + OpenRAIL-M 약관 UI 다이얼로그 → settings_store에 동의 플래그 영속. IndexTTS2는 "비상업" Bilibili 라이선스 — 동일 패턴.

### 7.7 HF 토큰 redaction (T-02-12)

서비스 레이어 `_mask_hf_tokens()` 정규식 → 로그 기록 *전에* 마스킹. 로거 필터 `HFTokenRedactor`와 belt-and-suspenders. subprocess stderr가 raw string으로 도착하는 경로까지 커버.

---

## 8. 라이선스 요약 (Hobby/Solo 관점)

| 자산 | 라이선스 | 자가-호스팅 위험 |
|---|---|---|
| OmniVoice Studio 코드 | FSL-1.1-ALv2 (2년 후 ALv2) | 개인 사용 ok |
| k2-fsa/OmniVoice 가중치 | OpenRAIL-M | 개인 사용 ok |
| IndexTTS-2 | Bilibili Custom (비상업) | 개인/연구 ok, 상업 시 contact 필요 |
| Supertonic-3 가중치 | OpenRAIL-M | 동의 게이트 통과 시 ok |
| pyannote-3.1 | MIT + HF gating | 동의 필요 (gated HF model) |
| Demucs | MIT | ok |
| WhisperX / faster-whisper | MIT / BSD | ok |
| AudioSeal | MIT | ok |
| VoxCPM2 | 사유 (OpenBMB) | 약관 확인 필요 |
| CosyVoice | Apache-2.0 | ok |

→ **Geny의 hobby 포지션**상 OmniVoice + IndexTTS2 + GGUF + WhisperX + pyannote + Demucs + AudioSeal 조합이 1급. ElevenLabs/Supertonic은 옵셔널.

---

## 9. 우리가 흡수해야 할 것 — 정리

| 항목 | 흡수 우선순위 | 비고 |
|---|---|---|
| **TTSBackend 메타데이터 보강** (display_name, gpu_compat, supports_voice_design, license, is_available) | 🔥 High | 우리 `TTSEngine` ABC에 필드 추가 |
| **Engine Compatibility Matrix UI** | 🔥 High | Settings에 카드 추가 |
| **합성 미리듣기 (CloneDesign 흐름)** | 🔥 High | 현재 우리는 ref 업로드만 가능, 합성 시연 불가 |
| **WaveformTimeline + AudioTrimmer** | 🔥 High | ref 오디오를 3~15초로 정확히 자르기 |
| **CompareModal (A/B)** | 🟡 Mid | 엔진/프로필 비교 |
| **더빙 파이프라인** | 🟡 Mid | yt-dlp + Demucs + diarization + speaker_clone + ffmpeg mux. 새 페이지(`/voice-studio/dub`) |
| **dictation widget (WS)** | 🟡 Mid | Geny는 브라우저 앱 → in-page 위젯으로 구현 (글로벌 단축키는 Tauri 없으면 어려움) |
| **MCP 서버** | 🟡 Mid | Geny 기존 MCP 패턴 위에 4-tools (`generate_speech`, `list_voices`, `list_languages`, `list_personalities`) |
| **Voice Gallery + 마켓플레이스** | 🟢 Low | 후순위, 우리 4개 템플릿이면 일단 충분 |
| **AudioSeal 워터마크** | 🟢 Low | 합성 식별 needs는 hobby 단계에서 약함 |
| **GPU 슬롯 큐 + Event Bus** | 🟡 Mid | omnivoice 마이크로서비스에 이미 Semaphore 있음, Studio 레이어에 확장 |
| **OpenAI 호환 엔드포인트** | 🟢 Low | 후순위, 외부 도구 통합 필요성 낮음 |
| **Setup Wizard / Readiness Checklist** | 🟢 Low | docker-compose가 already 그 역할 |
| **646언어 picker** | 🟡 Mid | 우리 omnivoice는 이미 600+ 언어 지원, UI만 없음 |
| **emotion vector (IndexTTS2)** | 🟡 Mid | 우리 8-emotion 팔레트를 8-float vector로 확장 가능 |
| **duration 제어** | 🟡 Mid | IndexTTS2 능력 — 립싱크 더빙에 필수 |
| **AudioSeal·번역엔진** | 🟢 Low | 후순위 |

다음 문서 [02-geny-current-state.md](./02-geny-current-state.md)에서 우리 현 상태를 같은 깊이로 분석한다.
