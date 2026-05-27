# 05 — 구현 로드맵 (Rev 3)

> Rev 3 스코프 변경 사항:
> - **PR 0 (Phase 0.5)** 추가: gpt_sovits 완전 제거 (별 PR로 깔끔히).
> - **`/tts-voice` 페이지 유지** — redirect 없음. Voice Studio 메뉴와 배너로 진입.
> - **Phase 5 (신규 엔진)** 후순위 — Phase 1~4 머지 → 서버 배포 → 사용자 검증 후 진행.
>
> 각 Phase는 **독립 PR 묶음**으로 머지 가능.
> 사용자 메모리 `feedback_durable_instructions.md` 준수 — continuous PR cadence + 단계마다 plan/progress 항상 참조.

---

## Phase 0 — 분석 (✅ 완료)

산출물:
- [README.md](./README.md), [01](./01-omnivoice-studio-analysis.md), [02](./02-geny-current-state.md), [03](./03-gap-and-applicability.md), [04](./04-target-ux-and-architecture.md), [05](./05-implementation-roadmap.md)

---

## Phase 0.5 — gpt_sovits 완전 제거 (PR 0, 0.5일)

> Phase 1 진입 전 정리. 별 PR로 분리하여 위험 격리.

### 산출물

- `Geny/docs/voice-upgrade-plan/phase0.5/PLAN.md` — 삭제/수정 파일 목록 + 검증 절차
- `Geny/docs/voice-upgrade-plan/phase0.5/PROGRESS.md`

### 변경 파일

**Backend (삭제)**:
- `backend/service/vtuber/tts/engines/gpt_sovits_engine.py`
- `backend/service/config/sub_config/tts/gpt_sovits_config.py`
- `backend/service/config/variables/tts_gpt_sovits.json`

**Backend (수정)**:
- `backend/service/vtuber/tts/tts_service.py` — `_engines` dict에서 gpt_sovits 등록 라인 제거.
- `backend/service/config/sub_config/tts/tts_general_config.py` — provider enum / Literal에서 `"gpt_sovits"` 제거.
- `backend/service/config/variables/tts_general.json` — `provider` 값이 `"gpt_sovits"`로 저장돼 있으면 `"omnivoice"`로 마이그레이션.
- `backend/controller/tts_controller.py` — `activate` 엔드포인트가 gpt_sovits config (`voice_profile`, `ref_audio_dir`, `container_ref_dir`)를 업데이트하던 블록 제거. omnivoice config 업데이트만 남김.

**Docker (수정)**:
- `docker-compose.yml` — `gpt-sovits` 서비스 블록 + 주석 제거.
- `docker-compose.dev.yml` — 동일.
- `docker-compose.prod.yml` — 주석 블록 정리.

**Frontend (확인 후 수정)**:
- `frontend/src/lib/api.ts` — `voices()`, `engines()`, `status()` 결과 분기에 `gpt_sovits` 분기가 있는지 grep. 있으면 제거.
- `frontend/src/app/tts-voice/page.tsx` — gpt_sovits 관련 UI 분기는 보이지 않으나 grep 재확인.

**Data (그대로 둠)**:
- `backend/static/voices/*/profile.json` — `gpt_sovits_settings` 필드는 손대지 않음. 백엔드가 read 시 silent ignore.

### 테스트

- 백엔드 재시작 → 로그에 gpt_sovits 키워드 없음.
- `GET /api/tts/engines` → gpt_sovits 미포함, 응답 정상.
- `GET /api/tts/voices` → 4 엔진 voices 정상.
- 에이전트 채팅 TTS → omnivoice로 정상 합성.
- 4 템플릿 프로필 `tts-voice` 페이지에서 정상 표시.
- `docker compose up` → geny-gpt-sovits 컨테이너 생성 안 됨.

### Gate

PR 0 머지 → Phase 1 진입.

---

## Phase 1 — UX 골격 + Clone & Design 1차 (1주, 2 PR)

> 핵심: "백엔드 신기능 거의 없이 UI만으로 사용자 가치 격변".
> 산출물 기준: 합성 미리듣기 + instruct + 풀 advanced 패널 + Voices 카탈로그 + 646언어 picker.

### PR 1A — 라우팅 + 좌측 네비 + Voices 카탈로그 + 진입점 2개

#### 변경 파일

**Frontend (신규)**:
- `frontend/src/app/voice-studio/layout.tsx` — 좌측 네비 5메뉴 + 공통 헤더.
- `frontend/src/app/voice-studio/page.tsx` — entry, `redirect('/voice-studio/clone-design')`.
- `frontend/src/app/voice-studio/voices/page.tsx` — 카드 그리드.
- `frontend/src/app/voice-studio/clone-design/page.tsx` — PR 1A 기준 placeholder (PR 1B에서 본격 구현).
- `frontend/src/app/voice-studio/batch/page.tsx`, `tools/page.tsx`, `settings/page.tsx` — placeholder ("Coming in Phase N").
- `frontend/src/components/voice-studio/SideNav.tsx` — 5메뉴 좌측 네비.
- `frontend/src/components/voice-studio/VoiceCard.tsx` — Voices 카드.
- `frontend/src/components/voice-studio/StudioPromoBanner.tsx` — `tts-voice` 페이지 상단 안내 배너 (dismissable, localStorage 영속).
- `frontend/src/lib/voiceStudioApi.ts` — 신규 API 객체 (PR 1A 기준 거의 비어있음, PR 1B부터 채움).

**Frontend (수정)**:
- `frontend/src/components/Sidebar.tsx` — Geny 메인 사이드바에 "Voice Studio" 메뉴 항목 추가. 기존 `TTS Voice` 메뉴는 **그대로 두고 추가**.
- `frontend/src/app/tts-voice/page.tsx` — 상단(top bar 아래)에 `<StudioPromoBanner />` 한 줄 삽입. 기존 565줄 로직 무변경.
- `frontend/src/lib/i18n.ts` (또는 i18n 정의 위치) — `nav.voiceStudio`, `ttsVoice.studioPromoBanner` 등 신규 키 추가 (ko/en/ja/zh).

**Backend (변경 없음)** — `ttsApi.listProfiles()` 그대로 사용.

#### 테스트

- Geny 메인 사이드바에 "Voice Studio" 메뉴 표시 → 클릭 → `/voice-studio/clone-design` 이동.
- `/tts-voice` 접속 → 기존 페이지 그대로 + 상단 배너 표시 → "열기 →" 클릭 → `/voice-studio/clone-design` 이동.
- 배너 X 클릭 → 닫힘 → 새로고침 후에도 안 보임 (localStorage 영속).
- 배너 닫은 상태에서 다른 브라우저/시크릿 모드 → 다시 표시.
- `/voice-studio/voices` 접속 → 4 템플릿 카드 정상 표시 + 검색/필터 동작.
- 좌측 네비 5메뉴 클릭 → 각 페이지로 이동 (4개는 placeholder).
- **회귀**: `/tts-voice` 페이지 모든 기능 (프로필 CRUD, ref 업로드 등) 정상.
- **회귀**: 에이전트 채팅 TTS — 영향 없음.

#### 산출물

- `Geny/docs/voice-upgrade-plan/phase1/PLAN.md`
- `Geny/docs/voice-upgrade-plan/phase1/PROGRESS.md`

---

### PR 1B — Clone & Design 페이지 + 합성 미리듣기 + 풀 파라미터 + 646언어 picker

#### 변경 파일

**Frontend (신규)**:
- `frontend/src/app/voice-studio/clone-design/page.tsx` — 메인 페이지.
- `frontend/src/components/voice-studio/SynthesizeCard.tsx` — 텍스트 + mode + emotion + advanced 패널 + ▶ Generate + waveform.
- `frontend/src/components/voice-studio/AdvancedParamsPanel.tsx` — num_step / guidance / speed / duration / denoise / auto_asr / seed / format / sample_rate 슬라이더.
- `frontend/src/components/voice-studio/InstructPanel.tsx` — instruct 입력 + presets.
- `frontend/src/components/voice-studio/LanguagePicker.tsx` — 646언어 검색 가능 select.
- `frontend/src/components/voice-studio/WaveformPreview.tsx` — wavesurfer.js wrap.
- `frontend/src/components/voice-studio/EmotionRefSection.tsx` — 기존 EmotionRefCard 재사용 (옮겨오기).
- `frontend/src/lib/voiceStudioApi.ts` — `synthesizePreview()`, `getLanguages()`.

**Backend (신규 모듈)**:
- `backend/controller/voice_studio/__init__.py` — 라우터 묶음 등록.
- `backend/controller/voice_studio/languages.py` — `GET /api/voice-studio/languages`. omnivoice `/languages` 프록시 + in-memory 1h 캐시.
- `backend/controller/voice_studio/synthesis_preview.py` — `POST /api/voice-studio/synth/preview`. 풀 파라미터 받아 `omnivoice_engine.synthesize_preview()` 호출.
- `backend/service/voice_studio/__init__.py`.
- `backend/service/voice_studio/synthesis_preview.py` — Pydantic 모델 + omnivoice 호출 래퍼.

**Backend (수정)**:
- `backend/service/vtuber/tts/engines/omnivoice_engine.py` — 신규 메서드 `synthesize_preview(params)` 추가 ([§3.5 04 문서](./04-target-ux-and-architecture.md#35-omnivoice_enginepy--풀-파라미터-표면-노출)).
- `backend/main.py` (또는 라우터 등록 지점) — voice_studio 라우터 include.

**의존성**:
- `frontend/package.json`: `wavesurfer.js` (또는 `@wavesurfer/react`) 추가.

#### 동작 시나리오

1. 사용자가 `/voice-studio/clone-design` 진입.
2. Profile picker에서 `paimon_ko` 선택 → emotion refs 8 카드 표시 (기존 동작).
3. Synthesize 카드에 "안녕하세요. 오늘은 날씨가 좋네요." 입력.
4. Mode=Clone, Emotion=neutral, Language=ko (auto). Advanced 패널 펼쳐 num_step=16, seed=12345.
5. ▶ Generate → POST `/api/voice-studio/synth/preview` (body: text + profile + mode + emotion + advanced 전체).
6. 백엔드 → 프로필에서 ref_neutral.wav 경로 해결 → omnivoice `POST /tts` (모든 파라미터 forward).
7. 응답 wav 바이트 + 헤더 (sample_rate, RTF, seed) → 프론트엔드 waveform 렌더 + auto-play.
8. 사용자가 Mode=Design으로 변경, instruct="warm young female"을 입력하고 다시 ▶.
9. 이번에는 ref 없이 instruct로 합성 결과 → 다른 톤의 보이스 확인.

#### 테스트

- 4개 템플릿 프로필 모두에 대해 ▶ Generate 정상.
- Mode=Design 전환 시 ref 없이 instruct만으로 합성.
- 같은 seed로 2회 호출 → 동일 결과 (byte-level 비교).
- num_step=8 (speed) vs 32 (quality) 시간 차이 측정.
- 646언어 picker 검색 (`type "fre" → French + Frisian + ...`).
- Advanced 패널 모든 슬라이더 → 백엔드 페이로드 키 매핑 정확.
- **회귀**: 에이전트 채팅 `/speak/stream` 정상.
- **회귀**: 기존 `/tts-voice` redirect.
- **회귀**: `ttsApi.preview()`, `ttsApi.uploadRef()` 등 기존 API 변경 없음.

#### 리스크

| 리스크 | 완화 |
|---|---|
| wavesurfer.js 번들 크기 (~70KB gz) | dynamic import (Next.js lazy load) |
| omnivoice `/tts` 응답이 헤더 없을 때 (구버전) | fallback: response 크기로 duration 추정, RTF=0 표기 |
| 646언어 픽커 SSR 성능 | client-only 컴포넌트 (`'use client'`) + virtualized list (react-virtuoso) |
| Advanced 파라미터 잘못된 값 (num_step=0 등) | Zod 또는 Pydantic 양쪽에서 검증, omnivoice가 받지 않는 값은 omit |

---

## Phase 2 — ref 워크플로우 강화 (1주, 2 PR)

### PR 2A — 마이크 인-페이지 녹음 + Waveform 트리밍

#### 변경 파일

**Frontend (신규)**:
- `frontend/src/components/voice-studio/RecorderModal.tsx` — `MediaRecorder` API. opus/webm → wav 변환 (`audiobuffer-to-wav` npm 패키지 또는 자체 PCM 인코딩).
- `frontend/src/components/voice-studio/TrimmerModal.tsx` — wavesurfer.js regions 플러그인. 5-15초 권장 영역 시각화 + 잘라 저장.
- `frontend/src/lib/audioUtils.ts` — webm/opus → wav, PCM resample to 16k.

**Frontend (수정)**:
- `frontend/src/components/voice-studio/EmotionRefSection.tsx` — 각 카드에 🎙 (녹음) + ✂ (트리밍) 액션 버튼. Recorder/Trimmer 모달 트리거.

**Backend (변경 없음)** — 기존 `uploadRef`로 PUT.

#### 테스트

- 마이크 권한 거부 시 정중한 에러 + 가이드.
- 녹음 → 트리밍 → upload → 해당 emotion ref로 클론 합성 (▶ Generate) → 톤 차이 청각 확인.
- HTTPS/localhost 외 환경에서 MediaRecorder 미지원 안내.
- 트리밍 결과 wav가 24kHz mono로 정규화되어 upload.

### PR 2B — auto_asr 토글 + 합성 히스토리 + 합성 결과를 ref로 저장

#### 변경 파일

**Frontend (신규)**:
- `frontend/src/components/voice-studio/HistoryPanel.tsx` — Synthesize 카드 아래 펼침. 최근 20개.
- `frontend/src/components/voice-studio/SaveAsRefModal.tsx` — 합성 결과 → 어느 프로필 / 어느 감정에 ref로 저장.
- `frontend/src/lib/voiceStudioApi.ts` — `getHistory()`, `replayHistory()`, `saveAsRef()`.

**Backend (신규)**:
- `backend/controller/voice_studio/history.py` — 4 엔드포인트.
- `backend/service/voice_studio/history_store.py` — SQLite `synthesis_history` 테이블 + audio blob을 `/app/data/voice_studio_audio/{id}.wav`로 저장.
- DB 초기화 (또는 alembic migration if Geny가 alembic 사용 중인지 확인).

**Backend (수정)**:
- `synthesis_preview.py` — 합성 후 history_store에 INSERT.

#### auto_asr 동작

- Advanced 패널의 `Auto ASR` 토글이 on 이고 `Mode=Clone` 이고 `prompt_text` 미입력일 때:
  - `omnivoice` POST `/tts` body에 `auto_asr=true` 전송.
  - omnivoice 컨테이너가 Whisper로 ref_text 자동 추출 (HF token 필요 — 시작 시점에 omnivoice 컨테이너에 인젝션).
- UI 안내: "ref_text 미입력 + auto_asr ON ⇒ Whisper가 자동으로 ref 음성을 받아 적습니다."

#### 테스트

- 합성 후 History 패널에 항목 추가.
- ↻ Replay → 동일 seed로 재합성 → bytewise 동일 결과.
- 합성 결과를 `paimon_ko / joy`로 save → ref_joy.wav 업데이트 → 파일 시스템 확인.
- auto_asr ON + prompt_text 비워두기 → omnivoice가 ref_text 자동 채움 (응답에 포함되는지 확인).

---

## Phase 3 — 엔진 메타 + Settings (1주, 2 PR)

### PR 3A — `TTSEngine` ABC 메타 + `engines.py` 라우터

#### 변경 파일

**Backend (수정)**:
- `backend/service/vtuber/tts/base.py` — class-level 메타 6개 + `is_available()` 추가 ([§3.4 04 문서](./04-target-ux-and-architecture.md#34-ttsengine-abc-확장-최소-침습)).
- `backend/service/vtuber/tts/engines/omnivoice_engine.py` — 메타 채움 + `is_available()` 오버라이드 (phase=ok 확인).
- `backend/service/vtuber/tts/engines/gpt_sovits_engine.py` — 동일.
- `backend/service/vtuber/tts/engines/edge_tts_engine.py` — 동일.
- `backend/service/vtuber/tts/engines/openai_tts_engine.py` — 동일.
- `backend/service/vtuber/tts/engines/elevenlabs_engine.py` — 동일.

**Backend (신규)**:
- `backend/controller/voice_studio/engines.py` — `GET /engines`, `POST /engines/default`.
- `backend/service/voice_studio/engine_registry.py` — 메타 통합 조회 (병렬 `is_available()` 호출).
- `backend/service/voice_studio/settings_store.py` — SQLite `voice_studio_settings` 테이블 (key-value).

#### 테스트

- `GET /api/voice-studio/engines` → 5 엔진 메타 + available 상태.
- OpenAI / ElevenLabs API 키 없을 때 → `available=false, reason="missing API key"`.
- omnivoice 컨테이너 다운 시 → `available=false, reason="unreachable: ..."`.
- `POST /engines/default` → 영속 → 백엔드 재시작 후에도 유지.
- 기존 `tts_service.get_engine()` fallback chain 동작 그대로.

### PR 3B — Settings 페이지

#### 변경 파일

**Frontend (신규)**:
- `frontend/src/app/voice-studio/settings/page.tsx` — 5 섹션 (engines / omnivoice defaults / HF token / cache / profile storage).
- `frontend/src/components/voice-studio/EngineMatrixCard.tsx` — 엔진 행 (Status / GPU / Lang / Design / Clone / Lic).
- `frontend/src/components/voice-studio/OmniVoiceDefaultsCard.tsx`.
- `frontend/src/components/voice-studio/CacheCard.tsx`.
- `frontend/src/components/voice-studio/HfTokenCard.tsx`.

**Backend (신규)**:
- `backend/controller/voice_studio/settings.py` — 8 엔드포인트 (cache stats/clear, omnivoice defaults get/put, HF token test, ...).

#### omnivoice defaults 처리

- 백엔드는 settings DB에 저장된 override를 우선 사용. omnivoice `POST /tts` 호출 시 클라이언트 파라미터 ← settings DB ← OMNIVOICE_* env 순으로 default cascading.
- "Container restart needed for env propagation" 안내는 표시하되, **실제로는 백엔드 레이어에서 forward하면 되므로 무재시작**.

#### 테스트

- Settings에서 default 엔진 변경 → 페이지 새로고침 후에도 유지.
- `num_step` 디폴트를 32로 변경 → Synthesize 카드 advanced 패널의 default 값에 반영.
- 캐시 Clear → `/app/cache/tts/` 비워짐.
- HF token Test → omnivoice 컨테이너에 단발 verify call (`/health`에 token 헤더 같이 보내거나, 별 endpoint).
- 회귀: 에이전트 채팅 TTS 응답.

---

## Phase 4 — Batch + Tools (1~2주, 3 PR)

### PR 4A — Batch 합성

#### 변경 파일

**Frontend (신규)**:
- `frontend/src/app/voice-studio/batch/page.tsx`.
- `frontend/src/components/voice-studio/BatchUploader.tsx` — CSV/JSON/TXT 업로드 + paste.
- `frontend/src/components/voice-studio/BatchJobRow.tsx` — 진행률 + 액션.
- `frontend/src/lib/voiceStudioEvents.ts` — EventSource SSE 클라이언트.

**Backend (신규)**:
- `backend/controller/voice_studio/batch.py` — 4 엔드포인트 (start / status / cancel / download).
- `backend/controller/voice_studio/events.py` — SSE 라우터.
- `backend/service/voice_studio/batch_runner.py` — asyncio 워커. omnivoice Semaphore에 의존하며 라인별 합성 → manifest.json + zip.
- `backend/service/voice_studio/event_bus.py` — in-memory pub/sub.

**Backend (수정)**:
- `backend/service/voice_studio/synthesis_preview.py` — batch_runner에서 재사용.

#### 테스트

- 120라인 CSV 업로드 → 시작 → SSE 진행률 update → 완료 시 zip 다운로드.
- 잡 cancel → 진행 중인 라인 완료 후 종료, 결과까지 zip 제공.
- 에러 라인 4개 발생 → manifest.json의 `errors[]` 채워짐 → 재시도 가능.
- 동시 잡 2개 → omnivoice semaphore가 직렬화 (max_concurrency=4 share).

### PR 4B — Tools 1차 (Language Detect / Phoneme / A/B Compare)

#### 변경 파일

**Frontend (신규)**:
- `frontend/src/app/voice-studio/tools/page.tsx` — 6 도구 카드.
- `frontend/src/components/voice-studio/tools/LanguageDetectTool.tsx`.
- `frontend/src/components/voice-studio/tools/PhonemeTool.tsx`.
- `frontend/src/components/voice-studio/tools/CompareTool.tsx` — 2~5 variant 합성 + side-by-side waveform.

**Backend (신규)**:
- `backend/controller/voice_studio/tools.py` — `POST /tools/detect-language`, `POST /tools/phoneme` (옵션).
- `backend/service/voice_studio/tools/language_detect.py` — `langdetect` (텍스트) + omnivoice auto_asr (오디오).
- (Phoneme은 단순 IPA library `eng-to-ipa` 또는 espeak-ng wrap. ko/ja는 별 라이브러리.)

#### 테스트

- 일본어 텍스트 → ja 감지.
- 한국어 wav → ko 감지 (whisper 사용 시 약간 느림 — 결과 캐시).
- A/B Compare: 같은 텍스트 + 4 다른 seed → waveform 4개 가로 + 청각 차이 확인.

### PR 4C — Tools 2차 (Seed Search / Ref Analyzer / Audio Convert)

#### 변경 파일

**Frontend (신규)**:
- `frontend/src/components/voice-studio/tools/SeedSearchTool.tsx`.
- `frontend/src/components/voice-studio/tools/RefAnalyzerTool.tsx`.
- `frontend/src/components/voice-studio/tools/AudioConvertTool.tsx`.

**Backend (신규)**:
- `backend/service/voice_studio/tools/seed_search.py` — N 샘플 합성 + 메타 (duration, RTF) 반환. 사용자가 manual 청취 후 선택.
- `backend/service/voice_studio/tools/ref_analyzer.py` — librosa로 RMS / SNR / pitch contour / 추천 5-15s 윈도우 (silence-bracketed).
- Audio convert는 ffmpeg subprocess.

#### 부수 산출물 — 프로필 zip import/export

- `backend/controller/voice_studio/settings.py`에 `POST /profiles/import`, `GET /profiles/{name}/export` 추가.
- 프론트엔드 Voices 탭에 ⬆ Import / ⬇ Export 버튼.

---

## Phase 5 — 신규 엔진 흡수 (후순위, Phase 1~4 머지·배포·검증 후)

> 사용자 결정: **Phase 1~4를 머지하고 서버에서 배포한 뒤 사용해보고 안정성이 확보되면** 이 단계 진입.
> "가능한 것 전부 추가" 정책. **단 OmniVoice clone 흐름은 절대 흔들리지 않음**.

### PR 5A — IndexTTS-2 (서브프로세스 컨테이너)

**가치**: 8-float emotion vector + 자연어 emotion + duration 제어. 우리 8 감정 시스템과 자연스러운 매핑.

**구현**:
- 신규 컨테이너 `indextts2/` (port 9883, GPU). transformers<5 venv 격리.
- HTTP API: `POST /synthesize` (text, ref_audio, emo_vector|emo_audio|emo_text, target_duration_s).
- `backend/service/vtuber/tts/engines/indextts2_engine.py` — TTSEngine wrap + 메타 (비상업 라이선스).
- Settings에 라이선스 1회 동의 게이트 (settings DB 영속 — `indextts2_acknowledged=1`).
- Advanced 패널: emotion vector 8 슬라이더 (해당 엔진 선택 시만).
- `profile.json`에 `emotion_vector: number[8]` 옵셔널 필드.

### PR 5B — VoxCPM2

**가치**: 텍스트 설명만으로 보이스 (ref 없이). 30언어 (한국어 OK).

**구현**:
- 컨테이너 또는 in-process (PyTorch ≥2.5 호환 확인). 라이선스 사유 — 동의 게이트.
- TTSEngine wrap.

### PR 5C — OmniVoice GGUF (CPU/MPS fallback)

**가치**: GPU 없는 환경 백업. 양자화 모델.

**구현**:
- omnivoice 컨테이너에 GGUF 바이너리 + 새 endpoint `/tts-gguf` 또는 별 컨테이너.
- Settings에 "Use GGUF on CPU" 토글.

### PR 5D — CosyVoice (옵션)

**가치**: 중국어 방언 (四川话 등) + instruct. Apache-2.0.

---

## 산출물 / 폴더 구조

```
Geny/docs/voice-upgrade-plan/
├── README.md
├── 01-omnivoice-studio-analysis.md
├── 02-geny-current-state.md
├── 03-gap-and-applicability.md
├── 04-target-ux-and-architecture.md
├── 05-implementation-roadmap.md
├── phase1/
│   ├── PLAN.md
│   └── PROGRESS.md
├── phase2/
│   ├── PLAN.md
│   └── PROGRESS.md
├── phase3/
│   ├── PLAN.md
│   └── PROGRESS.md
├── phase4/
│   ├── PLAN.md
│   └── PROGRESS.md
└── phase5/  (옵션)
    └── ...
```

각 Phase 진입 시 PLAN.md (구체 파일/줄/테스트 목록) + PROGRESS.md (PR 단위 체크리스트) 작성.

---

## 리스크 & 완화 — 전 단계 공통

| 리스크 | 영향 | 완화 |
|---|---|---|
| 기존 `/api/tts/*` 회귀 | 에이전트 채팅 TTS 깨짐 | e2e 회귀 테스트 (Phase 1부터 통합). 신규 엔드포인트는 별 prefix. |
| `tts_controller.py` 1450줄 분할 욕구 | 큰 PR + 회귀 위험 | **이번 사이클 분할 안 함** (사용자 결정). 신규 라우터만 별 디렉토리. |
| omnivoice 마이크로서비스 코드 수정 욕구 | hot path 회귀 | **무변경**. 모든 신기능은 백엔드 forwarding으로 |
| 합성 미리듣기 latency | UX 답답함 | omnivoice fp16 fast path (num_step=8 옵션) + 캐시 (Phase 1부터 캐시 active) |
| Compatibility Matrix 응답 느림 | Settings 페이지 지연 | `is_available()` 5 엔진 병렬 + 5s 메모리 캐시 |
| Batch 잡 도중 omnivoice 컨테이너 재시작 | 잡 손실 | 잡 상태 SQLite 영속 + 재개 (Phase 4 PR 4A 포함) |
| Phase 5 새 엔진 도입 시 OmniVoice 흐름 영향 | 채팅 TTS 회귀 | default engine 영속 = omnivoice 유지. 새 엔진은 opt-in. |
| 4 내장 템플릿 `gpt_sovits_settings` 호환 | 기존 프로필 미동작 | dual-read 정책 — 파일은 그대로, in-memory만 `engine_settings`로 매핑 |
| Tauri/desktop 단축키 미지원 | (스코프 외) | dictation 자체 제외 |

---

## 측정 지표

### Phase 0.5 끝낸 시점 (PR 0 머지 후)

- ✅ 백엔드 로그에 gpt_sovits 키워드 없음.
- ✅ `GET /api/tts/engines` → 4 엔진(edge_tts / openai / elevenlabs / omnivoice).
- ✅ docker compose up → geny-gpt-sovits 컨테이너 미생성.
- ✅ 에이전트 채팅 TTS 정상, 4 템플릿 프로필 정상 로드.

### Phase 1 끝낸 시점

- ✅ Geny 메인 사이드바 "Voice Studio" 메뉴 클릭 → `/voice-studio/clone-design` 이동.
- ✅ `/tts-voice` 페이지 그대로 동작 + 상단 배너 표시 (dismissable).
- ✅ `/voice-studio/clone-design`에서 텍스트 입력 → 첫 audio <2s.
- ✅ `instruct="warm young female"` → design mode 호출 → 청각상 다른 톤.
- ✅ Advanced 패널의 모든 슬라이더가 omnivoice 응답에 영향 (num_step=8 vs 32 시간 차이).
- ✅ 646언어 picker 검색 → French/Frisian/Frwh 등 fuzzy match.
- ✅ 에이전트 채팅 TTS 변경 없음 (회귀 0건).

### Phase 2 끝낸 시점

- ✅ 마이크 녹음 → 트리밍 → ref upload → 클론 합성 차이 청각.
- ✅ 합성 결과를 ref로 save → 같은 프로필 같은 emotion에 즉시 반영.
- ✅ History에서 동일 seed 재합성 → bytewise 동일.

### Phase 3 끝낸 시점

- ✅ Settings에 5 엔진 상태 정확히 표시.
- ✅ Default 엔진 변경 영속 → 백엔드 재시작 후도 유지.
- ✅ OmniVoice 디폴트 (num_step 등) 변경 → Synthesize 카드 advanced 패널 초기값에 반영.
- ✅ 캐시 stats / clear 동작.

### Phase 4 끝낸 시점

- ✅ 120라인 CSV 배치 → 정상 zip 다운로드.
- ✅ Batch 잡 cancel → 안전 종료.
- ✅ Language detect / A/B / Seed search / Ref analyzer 모두 동작.
- ✅ 프로필 zip export → 다른 환경에 import → 동일 동작.

---

## 다음 액션 (Rev 3 확정)

진행 순서:

1. **Phase 0.5 PLAN/PROGRESS 작성** — `Geny/docs/voice-upgrade-plan/phase0.5/PLAN.md`, `PROGRESS.md`. gpt_sovits 제거의 구체 file/line/test 목록.
2. **PR 0 — gpt_sovits 제거** (feature/voice-studio-cleanup-gpt-sovits).
3. **PR 0 머지** → 회귀 검증 (에이전트 채팅 TTS, 4 템플릿 로드, compose up).
4. **Phase 1 PLAN.md 작성** — PR 1A (라우팅 + 좌측 네비 + Voices + 진입점 2개) 구체화.
5. **PR 1A → 1B** (continuous PR cadence — 사용자 메모리 `feedback_durable_instructions.md` 준수).
6. **Phase 2 → 3 → 4** 순차 진행. 각 단계 시작/종료 시 PLAN/PROGRESS 갱신.
7. **Phase 4 머지 후** — 서버 배포 → 사용자 검증.
8. **검증 OK 시**:
   - (별 PR) `/tts-voice` 페이지 제거 + Geny 사이드바에서 옛 메뉴 제거 — 사용자 명시적 GO 사인 후.
   - **Phase 5 진입 여부 결정** — IndexTTS2 / VoxCPM2 / GGUF 중 도입할 것 선택.

각 Phase 시작 시 `Geny/docs/voice-upgrade-plan/phaseN/PLAN.md` + `PROGRESS.md` 생성.

---

## Geny 메인 사이드바 메뉴 추가 — 구체 위치

확인된 파일: [frontend/src/components/Sidebar.tsx](../../frontend/src/components/Sidebar.tsx)

PR 1A 작업 시 Sidebar.tsx 의 기존 메뉴 정의를 보고 적절한 위치(예: TTS Voice 메뉴 바로 아래, 또는 별 섹션)에 `Voice Studio` 항목을 추가. 사용자 메모리 `feedback_no_decorative_chrome.md` 준수 — lucide-react 아이콘 1개 + 라벨, 이모지/장식 X.

i18n 키 추가:
- ko: "보이스 스튜디오"
- en: "Voice Studio"
- ja: "ボイススタジオ"
- zh: "语音工作室"

---

## 참고

- 외부 레퍼런스: `/home/geny-workspace/OmniVoice-Studio` (FSL-1.1-ALv2, debpalash/OmniVoice-Studio v0.2.7).
- **코드 직접 복사 없음** — 패턴 차용 + 자체 구현 원칙. README/PROGRESS에 참조 명시.
- Geny `omnivoice` 마이크로서비스 ([Geny/omnivoice/](../../omnivoice/)) — 본 사이클 동안 코드 무변경.
- 기존 `tts_controller.py` (1450줄) — 본 사이클 동안 분할 안 함, 시그너처 동결.
