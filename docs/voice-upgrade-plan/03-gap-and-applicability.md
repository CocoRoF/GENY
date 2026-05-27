# 03 — Gap 분석 + 적용 가능 범위 (Rev 3)

> Rev 3 스코프: **OmniVoice 컨트롤 스튜디오** + **gpt_sovits 정리**.
> 더빙 / Dictation / MCP / 마켓플레이스 / 워터마크 모두 제외.
>
> "OmniVoice가 이미 가진 능력을 UI가 못 끌어내는 것" 이 우리의 1순위 gap.
>
> 활성 엔진 4종: edge_tts / openai / elevenlabs / **omnivoice** (1급 시민).
> gpt_sovits는 PR 0 (Phase 0.5)에서 완전 제거.

---

## 1. 핵심 깨달음

**Geny 백엔드는 OmniVoice의 풀-파라미터를 이미 받을 수 있다** — `omnivoice_engine.py` 26KB, `omnivoice_config.py`, `omnivoice/server/schemas.py`에 모든 필드가 정의되어 있다. 그런데 **`tts-voice/page.tsx` UI는 8 감정 ref 업로드와 activate 토글만 노출**. 합성 미리듣기, instruct, num_step, seed 등은 전부 UI 부재로 사용 불가.

→ **신규 백엔드를 거의 짓지 않아도 UI만 추가하면 사용자 가치가 즉시 발생**.

---

## 2. 분류 매트릭스 (Rev 2)

### 2.1 UX 격상 — 모두 **즉시 흡수 가능** ✅

| 항목 | 기존 백엔드 지원 | Geny 적용 |
|---|---|---|
| **합성 미리듣기** (텍스트 → 합성 → 재생) | ✅ `ttsApi.preview()` + `omnivoice_engine.synthesize()` | ✅ |
| **`instruct` 입력 UI** (자연어 보이스 디자인) | ✅ `omnivoice_config.instruct` + mode=design | ✅ |
| **`mode` 토글** (clone / design / auto) | ✅ `omnivoice_config.mode` | ✅ |
| **`num_step` 슬라이더** (8/16/32) | ✅ `OMNIVOICE_DEFAULT_NUM_STEP` + per-request override | ✅ |
| **`guidance_scale` 슬라이더** | ✅ | ✅ |
| **`speed` 슬라이더** | ✅ (이미 emotion 매핑으로 사용 중) | ✅ (수동 오버라이드) |
| **`duration_seconds` 입력** | ✅ | ✅ |
| **`denoise` 토글** | ✅ | ✅ |
| **`auto_asr` 토글** | ✅ (OmniVoice 서비스에 Whisper 로드 옵션) | ✅ (HF token 필요 안내) |
| **`seed` 입력 + 🎲 랜덤** | ✅ | ✅ |
| **`audio_format` / `sample_rate` 선택** | ✅ | ✅ |
| **646언어 picker** | ✅ omnivoice `/languages` 엔드포인트 존재 | ✅ |
| **마이크 in-page 녹음** | ✅ (`uploadRef` 그대로 사용) | ✅ MediaRecorder API |
| **Waveform 트리밍** | ✅ | ✅ wavesurfer.js |
| **A/B 비교** (같은 텍스트 여러 설정) | ✅ (여러 호출) | ✅ |
| **합성 결과 다운로드** | ✅ (응답 bytes) | ✅ |
| **합성 결과를 ref로 저장** | ✅ (`uploadRef`로 PUT) | ✅ |
| **프로필 카탈로그 (Voices 탭)** | ✅ `listProfiles` | ✅ |
| **프로필 zip import/export** | △ (백엔드 추가 작업) | ✅ |
| **per-emotion 고급 메타** (override prompt_text/lang/instruct) | ✅ `updateEmotionRef` 있음 | ✅ |
| **streaming 모드 시각화** (off/auto/always + sentence chunks live) | ✅ `speakStream` NDJSON | ✅ |
| **합성 히스토리** (최근 N개) | △ (백엔드에 신규 테이블) | ✅ |

### 2.2 백엔드 — 작은 작업으로 적용 가능 ✅

| 항목 | 작업 |
|---|---|
| `TTSEngine` ABC에 메타데이터 추가 (display_name, sample_rate, supported_languages, gpu_compat, supports_voice_design, supports_clone, license, is_available→(bool, reason)) | 작음 (5 엔진 + ABC 수정) |
| `GET /api/voice-studio/engines` 라우터 (Compatibility Matrix용) | 작음 (신규 모듈 ~100줄) |
| `POST /api/voice-studio/engines/default` (settings 영속) | 작음 |
| `GET /api/voice-studio/languages` (omnivoice `/languages` 프록시) | 작음 |
| `voice_studio_settings` SQLite 테이블 | 작음 |
| 캐시 통계 응답 보강 (hit rate / TTL 남은 시간) | 작음 |
| **합성 히스토리** (최근 N개 합성, 다운로드 / 다시 합성) | 중간 (신규 테이블 + 4 엔드포인트) |
| **배치 합성 잡** (CSV → 라인별 → zip) | 중간 (잡 큐 + SSE 진행률) |
| **신규 라우터 모듈 분리** (voice_studio/*) | 작음 — 단, 기존 `tts_controller.py`는 그대로 유지하고 **새 라우터만 별 디렉토리에 추가** |

### 2.3 OmniVoice 마이크로서비스 — 손대지 않음 ✅

기존 `omnivoice/server/` 의 모든 코드, 환경변수, 엔드포인트, 컨테이너 정의는 **그대로 유지**. Studio 백엔드는 그 앞 레이어. 새 파라미터 추가 시 백엔드 → omnivoice 호출 시 그대로 forward.

**예외**: omnivoice가 응답 헤더로 보내는 X-OmniVoice-* 정보(sample_rate, RTF 등)를 백엔드가 받아 UI로 노출 — 백엔드 수정만, 마이크로서비스는 무변경.

### 2.4 옵션 / Phase 5 — "가능한 것 전부" 정책

| 엔진 | 도입 시 가치 | Geny 환경 적합도 |
|---|---|---|
| **IndexTTS-2** (subprocess, 별 컨테이너) | 8-float emotion vector, 자연어 emotion, duration 제어 (립싱크 정렬 가능) | 🟢 비상업 라이선스 OK, GPU 필요, transformers<5 venv 격리. **OmniVoice와 병행 사용 — clone 흐름은 omnivoice가 그대로**. |
| **VoxCPM2** | 텍스트 설명만으로 보이스 생성 (ref 없이) | 🟡 사유 라이선스, 30언어. 한국어 OK. OmniVoice의 design 모드가 비슷한 일을 함 — 중복도 있음. |
| **GGUF (OmniVoice 양자화)** | CPU/MPS fallback | 🟡 GPU 없는 환경 백업. 현재 RTX 5070 가정 환경에서는 우선순위 낮음. |
| **CosyVoice** | 중국어 방언 + instruct | 🟢 Apache-2.0, 한국어 지원. 옵션. |

→ 이 엔진들은 **모두 도입 시 기존 OmniVoice를 대체하지 않는다**. 5번째 엔진(omnivoice)에 추가되는 6, 7번째 엔진으로 들어가며, 사용자는 Settings에서 default 엔진을 선택. **기존 omnivoice clone 흐름은 흔들리지 않음**.

### 2.5 명시적 제외 ❌

| 항목 | 이유 |
|---|---|
| 더빙 파이프라인 (Demucs / WhisperX / pyannote / ffmpeg mux) | 사용자 결정: 스코프 외 |
| YouTube/yt-dlp 다운로드 | 더빙 없으면 의미 약함 |
| Dictation widget (글로벌/in-page) | 사용자 결정: Geny에 불필요 |
| MCP 서버 | 사용자 결정: Geny가 자체 호출하므로 불필요 |
| OpenAI 호환 `/v1/audio/speech` 엔드포인트 | 외부 통합 없으면 불필요 |
| AudioSeal 워터마크 | 더빙·외부 publish 없으면 의미 약함 |
| 마켓플레이스 / 보이스 publish | hobby 단계 불필요 |
| Setup Wizard | docker-compose가 onboarding 역할 |
| Tauri 데스크톱화 | 별 프로젝트 |

---

## 3. 기존 흐름 보존 — "건드리지 않는 것" 명시 (gpt_sovits 제외)

### 3.0 PR 0 — gpt_sovits 완전 제거 (Phase 0.5)

사용자 결정: gpt_sovits는 어차피 별로라 안 씀. **engine + config + 컨테이너 + activate 흐름**을 깔끔히 제거.

**삭제 대상**:
- `backend/service/vtuber/tts/engines/gpt_sovits_engine.py` — 파일 삭제
- `backend/service/config/sub_config/tts/gpt_sovits_config.py` — 파일 삭제
- `backend/service/config/variables/tts_gpt_sovits.json` — 파일 삭제
- `docker-compose.yml`, `docker-compose.dev.yml`, `docker-compose.prod.yml` — `gpt-sovits` 서비스 블록 + 주석 + env 안내 모두 제거

**수정 대상**:
- `backend/service/vtuber/tts/tts_service.py` — `_engines` dict에서 gpt_sovits 등록 제거
- `backend/service/config/sub_config/tts/tts_general_config.py` — provider enum에서 `gpt_sovits` 제거
- `backend/service/config/variables/tts_general.json` — provider 값이 gpt_sovits면 omnivoice로 마이그레이션 (또는 edge_tts fallback)
- `backend/controller/tts_controller.py` — `activate` 엔드포인트가 gpt_sovits config(`voice_profile`, `ref_audio_dir`, `container_ref_dir`)를 업데이트하던 부분 제거; omnivoice 한 곳으로 단순화
- `frontend/src/lib/api.ts` — `voices()`, `engines()`, `status()` 응답에 gpt_sovits 항목이 사라지므로 UI 분기 (있다면) 정리

**그대로 두는 것**:
- 4 내장 템플릿 (`paimon_ko/profile.json` 등)에 있는 `gpt_sovits_settings` 필드 — 백엔드가 단순히 무시. 파일은 손대지 않음 (기존 데이터 보호). 신규 프로필 생성 시 이 필드 안 만들면 됨.

**검증**:
- 백엔드 부팅 시 gpt_sovits 관련 로그 없음.
- `GET /api/tts/engines` 응답에 gpt_sovits 미포함.
- 에이전트 채팅 TTS 정상 (omnivoice 또는 edge_tts fallback).
- 4 템플릿 프로필 정상 로드 + `tts-voice` 페이지에서 표시 정상.
- docker-compose `up` 시 `geny-gpt-sovits` 컨테이너 생성 안 됨.

### 3.1 백엔드 — 변경하지 않는 자산

- `omnivoice/` 마이크로서비스 — 모든 파일, env, port 9881 그대로.
- `backend/service/vtuber/tts/engines/omnivoice_engine.py` — clone 모드 호출 로직, 26KB 그대로. **메타데이터 class-level 필드만 추가**.
- `backend/service/vtuber/tts/engines/*.py` (edge_tts / openai / elevenlabs) — 메타 추가만, 호출 로직 무변경.
- `backend/service/vtuber/tts/base.py` — 기존 ABC 메서드 시그너처 그대로. **신규 메타 필드 + `is_available`만 추가** (기존 `health_check()` 보존, deprecated 안내).
- `backend/service/vtuber/tts/tts_service.py` — `_engines` dict, fallback chain, cache 모두 그대로.
- `backend/service/vtuber/tts/cache.py` — 키 스키마, LRU 그대로.
- `backend/service/config/sub_config/tts/*.py` — 모든 config 그대로. **신규 필드 추가만** (옵셔널).
- `backend/controller/tts_controller.py` (1450줄) — **분할 안 함**. 기존 30+ 엔드포인트 URL · 요청 · 응답 모두 동결. 신규 엔드포인트는 별 모듈 `backend/controller/voice_studio/`에 추가.

### 3.2 데이터

- `backend/static/voices/` 디렉토리 레이아웃.
- `profile.json` 스키마 — 기존 필드 모두 그대로. 신규 필드는 **모두 옵셔널** + missing 시 기존 동작.
- `gpt_sovits_settings` 필드 — read 호환 유지. 신규 프로필은 `engine_settings.gpt_sovits`로 일반화하나 **기존 4 템플릿 파일은 그대로 두고 백엔드가 dual-read**.
- 4 내장 템플릿 (paimon_ko, ruan_mei, ellen_joe, …) — 변경 없음.
- 캐시 디렉토리 `/app/cache/tts/` 구조.

### 3.3 프론트엔드

- `frontend/src/lib/api.ts`의 `ttsApi` — **30+ 메서드 시그너처 모두 그대로**. 신규 메서드는 `voiceStudioApi`로 별 객체 추가.
- 기존 `VoiceProfile` 타입 — 그대로. 신규 필드는 옵셔널 추가.
- 에이전트 채팅에서의 자동 재생 흐름 — 변경 없음 (`/speak/stream` 호출 그대로).
- 세션별 voice_profile 할당 흐름 — 변경 없음.

### 3.4 라우트

- `/app/tts-voice` — 페이지 자체는 **`/app/voice-studio/clone-design`으로 redirect** (페이지 내용은 새 위치로 이전). 옛 링크 / 북마크가 깨지지 않음. tts-voice/page.tsx 는 redirect 1줄만 남거나 삭제.
- 그 외 모든 라우트 그대로.

---

## 4. 우선순위 매트릭스 — "어느 gap부터 메울까"

각 gap을 **사용자 가치 ↑** vs **구현 비용 ↓** 으로 정렬.

| Gap | 가치 | 비용 | Phase |
|---|---|---|---|
| 합성 미리듣기 (text → audio) | 🔥🔥🔥 | 🟢 | 1 |
| `instruct` 입력 (보이스 디자인 노출) | 🔥🔥🔥 | 🟢 | 1 |
| 풀 파라미터 패널 (num_step / cfg / duration / seed / denoise) | 🔥🔥 | 🟢 | 1 |
| 646언어 picker | 🔥🔥 | 🟢 | 1 |
| Voices 카탈로그 (카드 그리드) | 🔥🔥 | 🟢 | 1 |
| 마이크 인-페이지 녹음 | 🔥🔥 | 🟡 | 2 |
| Waveform 트리밍 | 🔥🔥 | 🟡 | 2 |
| auto_asr (Whisper로 ref_text 자동) UI | 🔥 | 🟢 | 2 |
| per-emotion 고급 메타 (override instruct / engine 등) | 🔥 | 🟢 | 2 |
| 합성 히스토리 | 🔥 | 🟡 | 2 |
| 엔진 메타데이터 (display_name / gpu_compat / license) | 🔥🔥 | 🟢 | 3 |
| Compatibility Matrix UI | 🔥🔥 | 🟢 | 3 |
| Settings: default 엔진 / OmniVoice 디폴트 / 캐시 / HF token | 🔥 | 🟢 | 3 |
| A/B 비교 모달 | 🔥🔥 | 🟡 | 4 |
| Batch 합성 (CSV → zip) | 🔥🔥 | 🟡 | 4 |
| Seed search (best seed 자동 찾기) | 🔥 | 🟡 | 4 |
| Language detect / Phoneme 시각화 | 🔥 | 🟡 | 4 |
| Ref analyzer (SNR / duration / suggested cuts) | 🔥 | 🟡 | 4 |
| 프로필 zip import/export | 🔥 | 🟡 | 4 |
| **신규 엔진 (IndexTTS2 등)** | 🔥 | 🔴 | 5 (옵션) |

---

## 5. 결론

- Phase 1~2 만으로도 사용자 체감은 격변. 백엔드 신기능 거의 없음 — **이미 있는 백엔드를 UI가 제대로 활용**하는 것.
- Phase 3 으로 멀티-엔진 가시화 완성. OmniVoice가 1급 시민임이 UI로 명확해짐.
- Phase 4 가 powerful studio의 핵심 (Batch + Tools).
- Phase 5 는 옵션. "가능한 것 전부 추가" 정책 하에 IndexTTS2/VoxCPM2/CosyVoice를 추가 옵션으로 — 단 OmniVoice clone 흐름은 절대 흔들리지 않음.
- 더빙 / Dictation / MCP / 워터마크 / 마켓플레이스 / Tauri 전부 **이번 사이클 제외**.

다음 문서 [04-target-ux-and-architecture.md](./04-target-ux-and-architecture.md)에서 5탭의 풀 디자인 + 아키텍처를 구체화한다.
