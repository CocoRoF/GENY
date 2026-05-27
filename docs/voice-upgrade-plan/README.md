# Geny Voice Upgrade Plan — 분석 리포트 (Rev 3)

> **목적**: Geny의 `tts-voice` 페이지(`/app/tts-voice`)와 별도로
> **"Geny를 위한 OmniVoice 컨트롤 스튜디오"** (`/app/voice-studio`) 를 새로 구축한다.
> OmniVoice 마이크로서비스의 풀-스펙 파라미터 표면을 모두 UI에 노출하고,
> 8-감정 프로필 시스템을 더 강력한 워크플로우로 확장한다.
>
> 본 문서는 **분석 단계 (Rev 3)** 산출물이다.
> 작성일: 2026-05-27 · Rev 1 (초안) → Rev 2 (스코프 축소) → Rev 3 (entry / gpt_sovits / Phase 5 확정)

---

## 0. 한눈에 보기 (Executive Summary)

### 0.1 사용자 확정 (Rev 3)

| 결정 | 내용 |
|---|---|
| **경로** | `/app/voice-studio` 확정 |
| **기존 `/tts-voice`** | **유지** — redirect 안 함. Voice Studio가 충분히 검증되면 그때 제거. |
| **진입점** | 신규 — (1) **Geny 메인 사이드바**(`Sidebar.tsx`)에 "Voice Studio" 메뉴 추가, (2) `tts-voice` 페이지 상단에 "신규 Voice Studio 사용해보기 →" 배너. |
| **gpt_sovits 엔진** | **완전 제거** — engine 코드 / config / 컨테이너 / activate 흐름 / docker-compose 모두 정리. 활성 엔진은 4종(edge / openai / elevenlabs / **omnivoice**). |
| **신규 엔진 (IndexTTS2/VoxCPM2/GGUF)** | **Phase 5 후순위**. Phase 1~4를 머지 → 서버 배포 → 사용자 검증 후 진행. |

### 0.2 스코프 (불변)

| | 포함 | 제외 |
|---|---|---|
| **목표** | OmniVoice 풀-파라미터 컨트롤 + 프로필 워크플로우 고도화 | 더빙, dictation, MCP, 워터마크, 마켓플레이스 |
| **신규 페이지** | Clone&Design / Voices / Batch / Tools / Settings (5탭) | Dub / Dictate / Transcriptions / MCP 페이지 |
| **백엔드** | 엔진 메타데이터 보강 + 신규 `voice_studio/` 라우터 모듈 + Batch + 합성 히스토리 | 더빙 파이프라인, Demucs, pyannote, WhisperX 통합 |
| **호환성** | 기존 `/api/tts/*` 30+ 엔드포인트 **모두 그대로 유지** | 기존 엔드포인트 변경 / 시그너처 변경 |
| **데이터** | `profile.json`에 **옵셔널 필드만** 추가 | 기존 필드 변경 / 강제 마이그레이션 |
| **정리** | gpt_sovits 완전 제거 | 다른 엔진 (edge/openai/elevenlabs/omnivoice) 변경 |

### 0.3 OmniVoice가 실제로 가진 파라미터 (이미 백엔드에 있는데 UI가 못 활용 중)

| 파라미터 | 백엔드 | UI 노출 | 의미 |
|---|---|---|---|
| `mode` (clone/design/auto) | ✅ | ❌ | clone=ref 사용, design=instruct만, auto=랜덤 |
| `instruct` | ✅ | ❌ | "warm young female british" 같은 자연어 디자인 |
| `language` (auto + 646언어) | ✅ | △ (4개만) | 다국어 합성 |
| `num_step` (8/16/32) | ✅ | ❌ | 16=balanced, 32=quality, 8–12=speed |
| `guidance_scale` (default 2.0) | ✅ | ❌ | CFG 스케일 |
| `speed` (0.5~2.0) | ✅ | △ (emotion 자동) | 합성 속도 |
| `duration_seconds` | ✅ | ❌ | 목표 길이 강제 |
| `denoise` | ✅ | ❌ | ref 노이즈 제거 |
| `auto_asr` | ✅ | ❌ | Whisper로 ref_text 자동 |
| `seed` | ✅ | ❌ | 재현성 (같은 seed = 같은 출력) |
| `audio_format` (wav/mp3/ogg/pcm) | ✅ | ❌ | 출력 포맷 |
| `sample_rate` (24k/44.1k/48k) | ✅ | ❌ | 샘플레이트 |
| per-emotion `prompt_text`/`prompt_lang` | ✅ | ✅ | 감정별 ref 메타 |
| 8 감정 (neutral/joy/anger/sadness/fear/surprise/disgust/smirk) | ✅ | ✅ | 감정 ref 카드 |

→ **이번 업그레이드의 핵심 가치**: 위 ❌/△ 들을 UI로 끌어내는 것.

### 0.4 사이트맵

```
/app/  (Geny 메인)
├── Sidebar 메뉴 신규 추가: "Voice Studio" ──┐
│                                              ▼
├── /tts-voice                          (그대로 유지) ─ 상단 배너로 Voice Studio 안내
└── /voice-studio                       (entry, redirect → clone-design)
    ├── /clone-design   [Phase 1·2]    합성 + 디자인 + ref 워크플로우
    ├── /voices         [Phase 1]      프로필 카탈로그 (templates + 사용자)
    ├── /batch          [Phase 4]      배치 합성 (CSV/JSON/텍스트)
    ├── /tools          [Phase 4]      OmniVoice 유틸 (seed search, lang detect, ref analyzer, A/B)
    └── /settings       [Phase 3]      엔진 Matrix + OmniVoice 디폴트 + 캐시 + HF token
```

총 5탭. 기존 `/tts-voice`는 병행 유지. 검증 후 별 PR로 제거.

### 0.5 페이즈 요약

| Phase | 기간 | 핵심 가치 |
|---|---|---|
| **0 분석** | ✅ 완료 | 의사결정 기반 |
| **0.5 gpt_sovits 정리** | 0.5일 | PR 0 (별 PR) — 엔진/config/컨테이너/activate 흐름 제거 |
| **1 UX 골격** | 1주 | `/voice-studio` 라우팅 + Clone&Design 1차 (합성 미리듣기 + instruct + 풀 파라미터 패널) + Voices 카탈로그 + 메인 네비/배너 진입점 |
| **2 ref 워크플로우 강화** | 1주 | 마이크 인-페이지 녹음 + Waveform 트리밍 + auto_asr 토글 + 합성 히스토리 + 합성 결과를 ref로 저장 |
| **3 엔진 메타 + Settings** | 1주 | `TTSEngine` ABC 메타 보강 + Compatibility Matrix UI + 캐시/HF/디폴트 설정 |
| **4 Batch + Tools** | 1~2주 | 배치 합성 + seed search + language detect + A/B compare + ref analyzer + 프로필 import/export |
| **── Merge · 배포 · 사용자 검증 ──** | | 서버 배포 후 사용해보고 안정성 확인 |
| **5 (후순위) 신규 엔진** | 각 1~2주 | IndexTTS2 / VoxCPM2 / GGUF — 검증 후 사용자 결정 |

---

## 1. 문서 구성

| 파일 | 내용 |
|---|---|
| [01-omnivoice-studio-analysis.md](./01-omnivoice-studio-analysis.md) | OmniVoice-Studio 전체 기능 분석 (참조용 — 일부는 우리 스코프 외) |
| [02-geny-current-state.md](./02-geny-current-state.md) | Geny 현재 TTS 스택 정밀 분석 |
| [03-gap-and-applicability.md](./03-gap-and-applicability.md) | **Rev 3** — gpt_sovits 제거 반영 |
| [04-target-ux-and-architecture.md](./04-target-ux-and-architecture.md) | **Rev 3** — 5탭 + 진입점 디자인 + 4 엔진 |
| [05-implementation-roadmap.md](./05-implementation-roadmap.md) | **Rev 3** — PR 0(gpt_sovits 정리) 추가, Phase 5 후순위 |

---

## 2. 즉시 진입 (Phase 0.5 → Phase 1A)

다음 순서로 진행:

1. **PR 0** — gpt_sovits 완전 제거 (0.5일, 별 PR로 깔끔히)
   - 영향 범위: 6 backend 파일 + 3 docker-compose + 1 frontend api 메서드(있다면)
   - 사용자 메모리 `feedback_durable_instructions.md` 준수 — `Geny/docs/voice-upgrade-plan/phase0.5/PLAN.md` + `PROGRESS.md` 작성 후 진입
2. **PR 1A** — `/voice-studio` 라우팅 + 좌측 네비 + Voices 카탈로그 + **Geny Sidebar 메뉴 추가** + tts-voice 페이지 상단 배너
3. **PR 1B** — Clone & Design 페이지 + 합성 미리듣기 + 풀 파라미터 + 646언어 picker
4. (이후 Phase 2~4 순서대로)

---

## 3. Rev 변경 이력

| 항목 | Rev 1 | Rev 2 | Rev 3 |
|---|---|---|---|
| 탭 수 | 7~9 | 5 | **5** (확정) |
| 더빙 / Dictation / MCP / 워터마크 | 포함 | 제외 | **제외** (확정) |
| `/tts-voice` 처리 | (미정) | redirect | **유지** (병행) — 검증 후 제거 |
| 진입점 | (미정) | redirect 한 곳 | **메인 사이드바 메뉴 + tts-voice 배너** |
| gpt_sovits 엔진 | 5엔진 유지 | 5엔진 유지 | **완전 제거** → 4엔진(edge/openai/elevenlabs/omnivoice) |
| 신규 엔진 (IndexTTS2 등) | Phase 5 권장 | Phase 5 옵션 | **Phase 5 후순위** — Phase 1~4 검증 후 |
| OmniVoice 풀 파라미터 UI | 간략 | 메인 가치 | **메인 가치** (확정) |
| `tts_controller.py` 분할 | Phase 2 | 안 함 | **안 함** (확정) |
| 기존 `/api/tts/*` | 유지 | 계약 동결 | **계약 동결** (확정) |
