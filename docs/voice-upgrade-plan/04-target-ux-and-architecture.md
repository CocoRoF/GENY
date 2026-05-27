# 04 — 목표 UX + 백엔드 아키텍처 (Rev 3)

> Phase 1~4를 마쳤을 때의 End State.
> Rev 3 스코프: **OmniVoice 컨트롤 스튜디오** + **gpt_sovits 정리**.
>
> 핵심 원칙:
> 1. 기존 `/api/tts/*` 엔드포인트 / 데이터 스키마 / 호출 흐름 **그대로 보존**.
> 2. `omnivoice` 마이크로서비스 코드 무변경.
> 3. **기존 `/tts-voice` 페이지 병행 유지** — redirect 안 함. 검증 후 별 PR로 제거.
> 4. **gpt_sovits 완전 제거** (PR 0). 활성 엔진 4종: edge_tts / openai / elevenlabs / **omnivoice**.
> 5. 5탭으로 깔끔. OmniVoice가 1급 시민.

---

## 1. 사이트맵 + 진입점

```
/app/  (Geny 메인 앱)
│
├── Sidebar (frontend/src/components/Sidebar.tsx)  ← 신규 메뉴 1개 추가
│     ┌───────────────────────┐
│     │ ...                   │
│     │ ▸ Voice Studio  🆕   │  ← /app/voice-studio 로 이동
│     │ ...                   │
│     └───────────────────────┘
│
├── /tts-voice                          (기존 페이지 — 그대로 유지)
│     ┌─────────────────────────────────────────────────┐
│     │ [배너] 신규 Voice Studio 사용해보기 →            │  ← 상단 배너 신규 추가
│     │   ── 기존 사이드바 + 8 감정 카드 UI ──            │
│     └─────────────────────────────────────────────────┘
│
└── /voice-studio                       (entry, redirect → clone-design)
    ├── /clone-design   [Phase 1·2]    합성 + 디자인 + ref 워크플로우
    ├── /voices         [Phase 1]      프로필 카탈로그 (templates + 사용자)
    ├── /batch          [Phase 4]      배치 합성 (CSV/JSON/텍스트)
    ├── /tools          [Phase 4]      OmniVoice 유틸
    └── /settings       [Phase 3]      엔진 Matrix + OmniVoice 디폴트 + 캐시 + HF token
```

### 1.0 진입점 구현 디테일

**(A) 메인 사이드바 메뉴** (`frontend/src/components/Sidebar.tsx`):
- 기존 메뉴 목록에 `Voice Studio` 항목 추가.
- 아이콘 후보: `Sparkles` 또는 `AudioLines` (lucide-react). 사용자 메모리 `feedback_no_decorative_chrome.md` 준수 — 이모지/장식 X, 단일 아이콘만.
- 라벨: i18n 키 `nav.voiceStudio` ("Voice Studio" / "보이스 스튜디오") 신규 추가.
- 클릭 시 `/voice-studio` 이동 (Next.js Link).
- 기존 `tts-voice` 메뉴는 그대로 유지 — 두 메뉴가 병행.

**(B) `tts-voice` 페이지 상단 배너**:
- `frontend/src/app/tts-voice/page.tsx` 상단(top bar 아래)에 한 줄 배너 추가:
  ```
  ✦ 신규 Voice Studio가 도착했습니다 — OmniVoice 풀 컨트롤 + 합성 미리듣기 + 배치  [열기 →]
  ```
- "열기 →" 클릭 시 `/voice-studio/clone-design` 이동.
- 사용자가 X로 닫을 수 있게 — localStorage 키 `dismissed.voice-studio-banner=1` 영속.
- 배너 styling은 Geny 기존 theme 변수 (`var(--primary-color)` 등) 활용. 단순 한 줄, 장식 X.

### 1.1 공통 레이아웃

```
┌──────────────────────────────────────────────────────────────────┐
│  ◀ Geny   Voice Studio                                            │
├──────────┬───────────────────────────────────────────────────────┤
│  Clone & │                                                       │
│  Design  │                                                       │
│  Voices  │                Content area (per tab)                 │
│  Batch   │                                                       │
│  Tools   │                                                       │
│  Setting │                                                       │
│          │                                                       │
└──────────┴───────────────────────────────────────────────────────┘
```

- 좌측 네비 5메뉴, 활성 탭 highlight. lucide-react 아이콘 + 라벨 (사용자 메모리 `feedback_no_decorative_chrome.md` 준수 — 이모지/장식 X).
- 우상단 영역은 단순화 (잡 표시는 Batch 탭 내부에서만; Phase 4까지 전역 jobs pill은 안 만듦).
- 5탭 모두 다크/라이트 테마 — Geny 기존 변수 (`var(--bg-primary)` 등) 그대로 사용.

---

## 2. 탭별 풀 디자인

### 2.1 `/clone-design` — 합성 + 디자인 + ref 워크플로우 (메인)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Profile: [paimon_ko ▼]  [+ New]   Engine: [omnivoice ▼]                     │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─ Synthesize ──────────────────────────────────────────────────────────┐  │
│  │  Text:                                                                │  │
│  │  ┌─────────────────────────────────────────────────────────────────┐  │  │
│  │  │ 안녕하세요. 오늘은 날씨가 좋네요.                                     │  │  │
│  │  └─────────────────────────────────────────────────────────────────┘  │  │
│  │  47 chars · ~3.2s estimated                                           │  │
│  │                                                                       │  │
│  │  Mode: ⦿ Clone  ◯ Design  ◯ Auto                                      │  │
│  │  Emotion: ● neutral  ○ joy  ○ anger  ○ sadness  ○ fear  ○ surprise   │  │
│  │           ○ disgust  ○ smirk                                          │  │
│  │  Language: [ko (Korean) ▼]   (646 langs · type to search)             │  │
│  │                                                                       │  │
│  │  ▾ Voice Design (instruct)        only when Mode=Design or Auto       │  │
│  │  ┌─────────────────────────────────────────────────────────────────┐  │  │
│  │  │ warm, young female, slightly hesitant, korean accent             │  │  │
│  │  └─────────────────────────────────────────────────────────────────┘  │  │
│  │  Presets: [Warm] [Cold] [Young] [Old] [Energetic] [Calm] ...          │  │
│  │                                                                       │  │
│  │  ▾ Advanced parameters                                                │  │
│  │  Speed         [────●────] 1.00x  (emotion override: joy → 1.10)      │  │
│  │  Pitch shift   [────●────] 0 Hz                                       │  │
│  │  Num steps     [───●─────] 16  (8=fast · 16=balanced · 32=quality)    │  │
│  │  Guidance      [───●─────] 2.0                                        │  │
│  │  Target duration  [    ] sec   (0 = auto, use speed)                  │  │
│  │  Denoise ref      ▢                                                   │  │
│  │  Auto ASR (Whisper ref-text)  ▢   ⓘ HF token required                 │  │
│  │  Seed             [12345] [🎲]   Sample rate [24000 ▼]                │  │
│  │  Output format    [wav ▼]                                             │  │
│  │                                                                       │  │
│  │  [▶ Generate]   [⏵⏵ Generate × 4 (A/B/C/D)]   [💾 Save WAV]            │  │
│  │  ────────── waveform after generation ─────────                      │  │
│  │  ▶ 0:03.21 / RTF 0.42 · 47 chars · seed 12345                          │  │
│  │  [▶/⏸] [⬇ Download] [🎙 Save as ref...] [↻ Regenerate same seed]      │  │
│  │  History: 12 recent  [Show]                                           │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌─ Emotion References (8) ──────────────────────────────────────────────┐  │
│  │  ● neutral  ref_neutral.wav  [▶][⬆][🎙][✂][🗑]                          │  │
│  │      prompt: "안녕하세요..."   lang: ko                                  │  │
│  │      ▾ Per-emotion overrides (instruct override, engine override)     │  │
│  │  ● joy      ref_joy.wav      [▶][⬆][🎙][✂][🗑]                          │  │
│  │  ● anger    (no ref)         [⬆][🎙]                                   │  │
│  │  ...                                                                  │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────────┘
```

#### 2.1.1 인터랙션 상세

**Synthesize 카드**:
- `[▶ Generate]` → POST `/api/tts/voices/omnivoice/synthesize/preview` (신규 엔드포인트, [§3.3](#33-신규-엔드포인트)).
  - 또는 기존 `ttsApi.preview(engine, voice_id, text)` 사용 (signature 확장).
- 응답: audio bytes + 헤더 (sample_rate, RTF, seed_used, duration_seconds).
- 결과 → waveform 렌더 (wavesurfer.js) + auto-play.
- `Mode=Clone`: ref_audio_path = 현재 프로필의 active emotion ref. 기존 동작 그대로.
- `Mode=Design`: ref_audio_path 빼고 instruct만 전송. **OmniVoice의 mode=design 호출**.
- `Mode=Auto`: omnivoice가 자동 선택.

**Voice Design 패널**:
- `Mode=Clone`일 때는 숨김 (또는 비활성화).
- Preset 버튼 클릭 시 textarea에 prepend ("warm, " 등).
- instruct는 영문이 가장 잘 동작 (k2-fsa 학습 데이터 기준) — placeholder/hint로 안내.

**Advanced 패널**:
- 모두 OmniVoice의 실존 파라미터 — `omnivoice_config.py` + `omnivoice/server/schemas.py:TTSRequest`에 1:1 매핑.
- Default 값은 Settings 탭의 "OmniVoice defaults"에서 영속 (Phase 3).
- Per-request override는 UI에서만 반영, 영속 X (의도된 일회성).

**History**:
- 최근 N(=20) 합성 결과를 in-memory + IndexedDB 캐시 (frontend) 또는 백엔드 `synthesis_history` 테이블 (Phase 2 PR 2C 결정).
- 각 항목: text snippet, profile, mode, seed → 클릭 시 [Regenerate same seed] 동작 = 동일 결과 재현.

**Compare 모드 (⏵⏵ Generate × 4)**:
- 같은 텍스트를 4 변형으로 동시 합성:
  - 변형 축 선택: emotion / engine / seed / num_step / mode.
  - 결과 4개의 waveform 가로 배열 → 각각 ▶ 재생.
- Phase 4에 본격 구현.

**Emotion Refs 카드 (기존 + 강화)**:
- 기존 ▶/⬆/🗑 + 신규 🎙 (마이크 녹음, Phase 2) + ✂ (트리밍, Phase 2).
- 각 카드 ▾ 토글로 "Per-emotion overrides" 펼침:
  - prompt_text + prompt_lang (기존)
  - **신규 옵셔널**: instruct override (이 감정에 한해 design 적용 시 사용), preferred_engine (이 감정만 다른 엔진), num_step / guidance override.

#### 2.1.2 기존 동작 보존

- 프로필 선택 / [+ New] / activate / ref 업로드 / 삭제 / per-emotion prompt 수정 — **모두 기존 `ttsApi` 메서드를 그대로 호출**. 추가된 것은 합성 카드뿐.
- 에이전트 채팅에서 OmniVoice가 호출되는 흐름은 영향 없음.

### 2.2 `/voices` — 프로필 카탈로그

```
┌──────────────────────────────────────────────────────────────────┐
│  Voices                              [+ New]  [⬆ Import .zip]   │
│  Search: [______]                                                │
│  Filter: ⦿ All  ◯ Templates  ◯ Mine                              │
│  Filter: Language [Any ▼]  Engine [Any ▼]                        │
├──────────────────────────────────────────────────────────────────┤
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐               │
│  │ paimon_ko ★ │ │ ruan_mei     │ │ ellen_joe    │               │
│  │ ko · template │ │ ko · template │ │ ko · template │               │
│  │ 8 emotions  │ │ 3 emotions  │ │ 0 emotions  │               │
│  │ [Edit]   [▶]│ │ [Edit]   [▶]│ │ [Edit]   [▶]│               │
│  ├──────────────┼──────────────┼──────────────┤               │
│  │ my_voice  ★ │ │ + Create     │ │              │               │
│  │ ko · mine    │ │              │ │              │               │
│  │ 5 emotions  │ │              │ │              │               │
│  └──────────────┘ └──────────────┘ └──────────────┘               │
└──────────────────────────────────────────────────────────────────┘
```

- 카드 클릭 → 패널 슬라이드 (메타 + 8 emotion 미니 wave) 또는 `Edit` → `/clone-design?profile=…`.
- ▶ Try → 1-sec 미리듣기 합성 (현재 active emotion ref + 기본 텍스트 "안녕하세요").
- `[+ New]` → 신규 프로필 모달 (기존 `createProfile` 호출).
- `[⬆ Import .zip]` → profile.json + ref_*.wav 묶음 (Phase 4).
- 별(★) = active 프로필. 카드 1개만 별 표시.
- 사용자 메모리 `feedback_no_decorative_chrome.md` 준수 — 이모지 / 장식 cross-stage breadcrumbs 금지. 카드는 dense, 정보 중심.

### 2.3 `/batch` — 배치 합성

```
┌──────────────────────────────────────────────────────────────────┐
│  Batch Synthesis                                                 │
│                                                                  │
│  ⬆ Upload  [CSV / JSON / TXT ▼]                                  │
│  ⓘ Format:                                                       │
│    CSV  : text,emotion,profile,language                          │
│    JSON : [{"text":"...","emotion":"joy",...}]                   │
│    TXT  : one line = one synthesis (uses current defaults)       │
│                                                                  │
│  Or paste:                                                       │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │ 안녕하세요.                                                    │ │
│  │ 오늘은 날씨가 좋네요.                                            │ │
│  │ ...                                                          │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  Defaults: Profile [paimon_ko ▼] Emotion [neutral] Engine [omni] │
│            Lang [ko] Num steps [16] CFG [2.0] Speed [1.00]       │
│                                                                  │
│  [▶ Start Batch]                                                 │
├──────────────────────────────────────────────────────────────────┤
│  Active jobs:                                                    │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │ episode_01.csv  120 lines  ████████░░ 80%  4 errors         │ │
│  │ 이미 합성된 96/120. ETA 35s   [▶ Pause] [⬇ Download zip] [✕]  │ │
│  └─────────────────────────────────────────────────────────────┘ │
│  Recent (3):                                                     │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │ ad_voiceover  20 lines  ✓ Done 2h ago  [⬇ Download zip]      │ │
│  │ test_batch    50 lines  ✓ Done yesterday  [⬇] [↻ Rerun]      │ │
│  └─────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

- CSV/JSON/TXT 업로드 또는 텍스트 인-페이지 paste.
- 각 라인이 합성 요청. 결과는 `outputs/0001.wav`, `0002.wav`, ..., `manifest.json` 으로 zip.
- 백엔드: 라인을 omnivoice 마이크로서비스의 semaphore에 던짐 (concurrency 4 가정). SSE로 진행률 push.
- Resume: 잡 cancel 후 재시작 시 완료된 라인 skip.
- 에러 라인은 `manifest.json`의 `errors[]`에 기록 + 사용자가 재합성 가능.

### 2.4 `/tools` — OmniVoice 유틸

```
┌──────────────────────────────────────────────────────────────────┐
│  Tools                                                           │
│                                                                  │
│  ▸ Ref Audio Analyzer                                            │
│    Upload wav → SNR, duration, suggested 5-15s windows,          │
│    estimated language (Whisper), pitch contour.                  │
│                                                                  │
│  ▸ A/B/C/D Compare                                               │
│    Same text → 2~5 variants (different profile / mode / seed /   │
│    num_step / engine) → side-by-side waveforms.                  │
│                                                                  │
│  ▸ Seed Search                                                   │
│    Same text + profile, sample N seeds, pick the best            │
│    (manual A/B ranking or RTF/duration filters).                 │
│                                                                  │
│  ▸ Language Detect                                               │
│    Paste text or upload audio → ISO 639 code + confidence.       │
│                                                                  │
│  ▸ Phoneme / Pronunciation Preview                               │
│    Text → IPA + syllable boundaries (best-effort, language-aware)│
│                                                                  │
│  ▸ Audio Format Convert                                          │
│    wav ↔ mp3 ↔ ogg ↔ pcm, resample 24k/44.1k/48k                 │
└──────────────────────────────────────────────────────────────────┘
```

각 도구는 별 카드 + "Open" → 모달/슬라이드. Phase 4 단위 구현.

### 2.5 `/settings` — 엔진 + OmniVoice 디폴트 + 캐시

```
┌──────────────────────────────────────────────────────────────────┐
│  Voice Studio Settings                                           │
│                                                                  │
│  ▸ Active engines & compatibility                                │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │ Engine        Status  GPU         Lang  Design  Clone  Lic  │ │
│  │ omnivoice  ⦿  ✓ ok    cuda/mps/cpu 646   yes     yes    OR  │ │
│  │ edge_tts   ◯  ✓ ok    cloud        80+   no      no     —   │ │
│  │ openai     ◯  ⚠ key   cloud        50+   no      no     —   │ │
│  │ elevenlabs ◯  ⚠ key   cloud        30+   no      no     —   │ │
│  │ (Phase 5) indextts2  ◌ install required                     │ │
│  │ (Phase 5) voxcpm2    ◌ install required                     │ │
│  └─────────────────────────────────────────────────────────────┘ │
│  Default: ⦿ omnivoice  (used when no profile-level override)     │
│                                                                  │
│  ▸ OmniVoice defaults                                            │
│  Num steps    [16]   CFG [2.0]   Speed [1.0]                     │
│  Sample rate  [24000 ▼]   Output [wav ▼]                         │
│  Concurrency  [4]    GPU memory fraction [0.85]                  │
│  These are forwarded to the omnivoice microservice on startup.   │
│  (Currently read from OMNIVOICE_* env vars; UI persists overrides│
│  to settings DB and the backend re-issues env on container       │
│  restart only.)                                                  │
│                                                                  │
│  ▸ HuggingFace token                                             │
│  Token: ●●●●●●●●●● [Test]                                        │
│  Used by: omnivoice auto_asr (Whisper)                           │
│                                                                  │
│  ▸ Cache                                                         │
│  Size: 142 MB / 500 MB · Hits 1234 / Miss 89 · TTL 24h            │
│  [Clear]                                                         │
│                                                                  │
│  ▸ Profile storage                                               │
│  Path: /app/static/voices/                                       │
│  Templates: 4 · User profiles: 1                                 │
│  [Rescan]  [Reseed templates]                                    │
└──────────────────────────────────────────────────────────────────┘
```

- Compatibility Matrix: 엔진 ABC의 메타데이터를 그대로 표시. Default 라디오는 settings DB에 영속.
- OmniVoice defaults: 백엔드 `omnivoice_config.py` 값을 표시 / 편집. **변경 시 mariadb-style "container restart needed" 안내** (env var 기반이라 hot-reload 안 됨).
  - 또는 Phase 3 에서 `OMNIVOICE_DEFAULT_NUM_STEP` 같은 변수를 runtime override 가능하도록 omnivoice `/settings` 엔드포인트 추가 (선택).
- HF token: omnivoice 컨테이너로 forwarding. auto_asr=true 일 때만 의미.
- 캐시: 기존 cache.py 통계 노출. Clear → 디렉토리 비움.

---

## 3. 백엔드 아키텍처 (기존 보존 + 최소 추가)

### 3.1 디렉토리 전략

```
backend/
├── controller/
│   ├── tts_controller.py             ← 변경 없음. 1450줄 유지. 기존 30+ 엔드포인트 동결.
│   └── voice_studio/                 ← 신규 모듈
│       ├── __init__.py
│       ├── engines.py                Compatibility Matrix + default 선택
│       ├── synthesis_preview.py      합성 미리듣기 (advanced 파라미터 표면 노출)
│       ├── history.py                합성 히스토리 (Phase 2 옵션)
│       ├── batch.py                  배치 합성 잡 큐
│       ├── tools.py                  유틸 (lang detect, seed search 등)
│       ├── settings.py               엔진 default, OmniVoice defaults, HF token
│       ├── languages.py              omnivoice /languages 프록시 + 캐시
│       └── events.py                 SSE (batch 진행률용)
│
├── service/
│   ├── vtuber/tts/
│   │   ├── base.py                   ← 메타데이터 + is_available() 추가 (기존 메서드 보존)
│   │   ├── tts_service.py            ← 변경 없음
│   │   ├── cache.py                  ← 변경 없음
│   │   └── engines/                  ← 각 엔진에 class-level 메타 추가만
│   │       ├── omnivoice_engine.py   ← 변경 없음 (메타 class 필드 추가만)
│   │       └── ...
│   └── voice_studio/                 ← 신규
│       ├── __init__.py
│       ├── engine_registry.py        엔진 메타 통합 조회
│       ├── synthesis_preview.py      OmniVoice 풀 파라미터 호출 래퍼
│       ├── history_store.py          SQLite 합성 히스토리
│       ├── batch_runner.py           배치 잡 워커 (asyncio)
│       ├── event_bus.py              in-memory pub/sub for SSE
│       ├── settings_store.py         SQLite key-value (voice_studio_settings)
│       └── tools/
│           ├── language_detect.py    (Phase 4) langdetect or whisper
│           ├── seed_search.py        (Phase 4) N-sample helper
│           └── ref_analyzer.py       (Phase 4) SNR/duration/pitch contour
│
└── service/config/sub_config/tts/
    └── ...                           ← 변경 없음
```

→ **기존 파일은 손대지 않음**. 신규 모듈만 추가. tts_controller.py가 너무 크다는 이유로 분할하는 일은 이번 사이클 안 함 (사용자 결정: "기존 구조 박살내지 말 것").

### 3.2 라우터 prefix

- 기존: `/api/tts/*` (그대로 유지, **계약 동결**).
- 신규: `/api/voice-studio/*`.

신규 엔드포인트는 모두 `/api/voice-studio/*` 하위. 기존 `ttsApi` 메서드는 그대로, 신규 `voiceStudioApi` 객체 추가.

### 3.3 신규 엔드포인트

| Method | Path | 용도 | Phase |
|---|---|---|---|
| GET | `/api/voice-studio/engines` | 엔진 메타 + Compatibility Matrix | 3 |
| POST | `/api/voice-studio/engines/default` | default 엔진 영속 | 3 |
| GET | `/api/voice-studio/languages` | omnivoice `/languages` 프록시 (캐시) | 1 |
| POST | `/api/voice-studio/synth/preview` | **합성 미리듣기 (풀 파라미터 표면)** | 1 |
| GET | `/api/voice-studio/synth/history` | 최근 N 합성 | 2 |
| POST | `/api/voice-studio/synth/history/{id}/replay` | 동일 seed 재합성 | 2 |
| POST | `/api/voice-studio/synth/save-as-ref` | 합성 결과를 프로필 ref로 저장 | 2 |
| POST | `/api/voice-studio/batch` | 배치 잡 시작 | 4 |
| GET | `/api/voice-studio/batch/{job_id}` | 잡 상태 | 4 |
| POST | `/api/voice-studio/batch/{job_id}/cancel` | 취소 | 4 |
| GET | `/api/voice-studio/batch/{job_id}/download` | 결과 zip | 4 |
| GET | `/api/voice-studio/events` | SSE (배치 진행률) | 4 |
| POST | `/api/voice-studio/tools/detect-language` | 텍스트/오디오 → ISO 639 | 4 |
| POST | `/api/voice-studio/tools/analyze-ref` | wav → SNR / 추천 컷 | 4 |
| POST | `/api/voice-studio/tools/seed-search` | text + profile → N 샘플 (메타) | 4 |
| GET | `/api/voice-studio/settings/cache` | 캐시 통계 | 3 |
| DELETE | `/api/voice-studio/settings/cache` | 캐시 비우기 | 3 |
| GET | `/api/voice-studio/settings/omnivoice-defaults` | 현재 디폴트 | 3 |
| PUT | `/api/voice-studio/settings/omnivoice-defaults` | 디폴트 업데이트 | 3 |
| POST | `/api/voice-studio/settings/hf-token/test` | HF token 검증 | 3 |
| POST | `/api/voice-studio/profiles/import` | zip 업로드 → 프로필 추가 | 4 |
| GET | `/api/voice-studio/profiles/{name}/export` | 프로필 zip 다운로드 | 4 |

**기존 `/api/tts/*` 엔드포인트는 위 목록과 겹치는 것이 없음 — 새 prefix로 깔끔히 분리**.

### 3.4 `TTSEngine` ABC 확장 (최소 침습)

```python
# backend/service/vtuber/tts/base.py
# 기존 코드 모두 보존. 아래만 추가.

class TTSEngine(ABC):
    # ── 신규 class-level 메타 (모두 default 값 있어서 기존 5 엔진 즉시 동작) ──
    id: ClassVar[str] = "unknown"
    display_name: ClassVar[str] = "Unknown engine"
    sample_rate: ClassVar[int] = 24000
    supported_languages: ClassVar[list[str]] = ["multi"]
    gpu_compat: ClassVar[tuple[str, ...]] = ("cpu",)
    supports_voice_design: ClassVar[bool] = False
    supports_clone: ClassVar[bool] = False
    supports_emotion_vector: ClassVar[bool] = False
    license: ClassVar[str] = ""

    # ── 기존 메서드 시그너처 그대로 ──
    @abstractmethod
    async def synthesize_stream(self, request: TTSRequest) -> AsyncIterator[TTSChunk]: ...
    async def synthesize(self, request: TTSRequest) -> bytes: ...
    async def get_voices(self, language=None) -> list[VoiceInfo]: ...
    async def health_check(self) -> bool: ...  # ← 보존 (deprecated, 신규 코드는 is_available 사용)
    def apply_emotion(self, request): ...

    # ── 신규: 사유 포함 가용성 체크 ──
    async def is_available(self) -> tuple[bool, str]:
        """Default: health_check 결과 위에 reason 부착."""
        ok = await self.health_check()
        return (ok, "ok") if ok else (False, "health check failed")
```

각 엔진은 class 시작 부분에 메타 6~8줄 추가:

```python
class OmniVoiceEngine(TTSEngine):
    id = "omnivoice"
    display_name = "OmniVoice (k2-fsa)"
    sample_rate = 24000
    supported_languages = ["multi"]   # 646
    gpu_compat = ("cuda", "mps", "cpu")
    supports_voice_design = True
    supports_clone = True
    license = "OpenRAIL-M"

    async def is_available(self) -> tuple[bool, str]:
        try:
            res = await self._http.get(f"{self.api_url}/health")
            data = res.json()
            phase = data.get("phase")
            if phase == "ok":
                return True, "ready"
            return False, f"phase={phase}"
        except Exception as e:
            return False, f"unreachable: {e}"

    # 기존 메서드 그대로
    async def synthesize_stream(self, request): ...
```

### 3.5 `omnivoice_engine.py` — 풀 파라미터 표면 노출

기존 `synthesize()` / `synthesize_stream()` 메서드는 그대로. **신규 메서드 1개 추가**:

```python
async def synthesize_preview(self, params: PreviewParams) -> PreviewResult:
    """Studio Synthesize 카드 전용. 풀 파라미터 표면을 omnivoice로 forward.

    기존 synthesize()는 TTSRequest를 받아 emotion 매핑까지 자동 적용.
    이 메서드는 사용자가 advanced 패널에서 명시한 값을 그대로 forward
    (auto-override 없이). UI에서 dial in 한 그대로 합성한다.
    """
    payload = {
        "text": params.text,
        "mode": params.mode,                  # clone/design/auto
        "ref_audio_path": params.ref_audio_path,
        "ref_text": params.ref_text,
        "instruct": params.instruct,
        "language": params.language,
        "speed": params.speed,
        "duration": params.duration_seconds,
        "num_step": params.num_step,
        "guidance_scale": params.guidance_scale,
        "denoise": params.denoise,
        "auto_asr": params.auto_asr,
        "seed": params.seed,
        "audio_format": params.audio_format,
        "sample_rate": params.sample_rate,
    }
    # omitted None 키 제거 → omnivoice가 자체 default 사용
    payload = {k: v for k, v in payload.items() if v is not None}
    res = await self._http.post(f"{self.api_url}/tts", json=payload)
    return PreviewResult(
        audio=res.content,
        sample_rate=int(res.headers["X-OmniVoice-Sample-Rate"]),
        rtf=float(res.headers.get("X-OmniVoice-RTF", "0")),
        seed_used=int(res.headers.get("X-OmniVoice-Seed", "0")),
        duration=float(res.headers.get("X-OmniVoice-Duration", "0")),
    )
```

→ 기존 `synthesize()`는 채팅용으로 그대로. 신규 `synthesize_preview()`는 Studio 전용.

### 3.6 신규 SQLite (선택)

```sql
-- /app/data/voice_studio.db (volume mount)

CREATE TABLE voice_studio_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
-- e.g. ("default_engine", "omnivoice"), ("omnivoice_num_step", "16"), ...

CREATE TABLE synthesis_history (
    id TEXT PRIMARY KEY,
    timestamp TEXT NOT NULL,
    text TEXT NOT NULL,
    profile_name TEXT,
    engine TEXT,
    mode TEXT,
    seed INTEGER,
    params_json TEXT,
    audio_path TEXT,           -- /app/data/voice_studio_audio/{id}.wav
    duration_seconds REAL,
    rtf REAL
);

CREATE TABLE batch_jobs (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    state TEXT NOT NULL,       -- queued/running/done/cancelled/failed
    total_lines INTEGER,
    completed_lines INTEGER,
    error_lines INTEGER,
    profile_name TEXT,
    defaults_json TEXT,
    zip_path TEXT,
    notes TEXT
);
```

→ Phase 2 (history) + Phase 4 (batch)에서 도입. Phase 3 (settings)에서 `voice_studio_settings`만 먼저.

### 3.7 데이터 모델 — `profile.json` 진화 (모두 옵셔널)

```jsonc
{
  // ── 기존 필드 (변경 없음, 모두 보존) ──
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
  "gpt_sovits_settings": {"top_k": 5, "top_p": 1.0},   // read 호환만, 신규 저장 X

  // ── 신규 필드 (모두 nullable, 백엔드 read 시 None default) ──
  "instruct": null,                        // 프로필 단위 default instruct
  "preferred_engine": null,                // null = global default 사용
  "engine_settings": {                     // gpt_sovits_settings의 일반화 (옵션)
    "omnivoice": {"num_step": 16, "guidance_scale": 2.0},
    "gpt_sovits": {"top_k": 5, "top_p": 1.0}
  },
  "emotion_overrides": {                   // per-emotion 고급
    "joy": {"instruct": "exuberant joy", "num_step": 20}
  },
  "tags": [],
  "created_at": "2026-05-27T12:00:00Z",    // 신규 프로필부터
  "updated_at": "2026-05-27T12:00:00Z"
}
```

**기존 4 템플릿 파일은 그대로** — 신규 필드는 모두 missing이고 백엔드는 None으로 처리. 사용자가 Studio UI에서 새 필드를 채우면 그때부터 직렬화에 포함.

`gpt_sovits_settings` 는 **dual-read**: 백엔드는 신규 저장 시 `engine_settings.gpt_sovits`로 가지만, 기존 파일을 읽을 때 `gpt_sovits_settings` 필드가 있으면 자동으로 `engine_settings.gpt_sovits`에 매핑 (in-memory만, 디스크 파일은 안 건드림).

---

## 4. 컨테이너 구성 (변경: gpt-sovits 제거)

```
geny-network
├── geny-frontend   (Next.js)
├── geny-backend    (FastAPI) — voice_studio/ 모듈 추가, 외부 의존 추가 없음
├── omnivoice       (port 9881, GPU) — 무변경
└── whisper-stt     placeholder 그대로  (auto_asr UI 토글이 켜질 때 omnivoice 컨테이너 내부 Whisper 사용)

(삭제) gpt-sovits  ← PR 0 (Phase 0.5)에서 docker-compose 3개 파일에서 모두 제거
```

새 컨테이너 추가 없음 (Phase 1~4). Phase 5 에서 indextts2 / voxcpm2 추가 시에만 새 컨테이너 (후순위 — Phase 1~4 검증 후).

---

## 5. 비기능 요구

| 요구 | 목표 |
|---|---|
| **기존 `/api/tts/*` 회귀** | 0건 (e2e 테스트로 확인) |
| **에이전트 채팅 TTS 응답성** | 변경 없음 (백엔드 동일 경로) |
| Cold-start (백엔드) | <3s (omnivoice lazy-load, 변경 없음) |
| Synthesize 미리듣기 first audio | <2s (omnivoice fp16 12GB GPU 기준) |
| Voice list 페이지 로드 | <500ms (캐시) |
| Batch 잡 동시성 | omnivoice 컨테이너 Semaphore 그대로 사용 (max_concurrency=4) |
| 캐시 hit rate | >40% (기존 cache 그대로) |
| Compatibility Matrix 응답 | <300ms (engines.is_available() 5개 병렬) |

---

## 6. 호환성 / 마이그레이션 체크리스트

**PR 0 (gpt_sovits 정리)**:
- [ ] `backend/service/vtuber/tts/engines/gpt_sovits_engine.py` 삭제.
- [ ] `backend/service/config/sub_config/tts/gpt_sovits_config.py` 삭제.
- [ ] `backend/service/config/variables/tts_gpt_sovits.json` 삭제.
- [ ] `tts_service.py` `_engines` dict에서 gpt_sovits 제거.
- [ ] `tts_general_config.py` provider enum에서 gpt_sovits 제거.
- [ ] `tts_general.json`의 `provider="gpt_sovits"` 값 검수 → omnivoice 또는 edge_tts로 마이그레이션.
- [ ] `tts_controller.py`의 activate 엔드포인트에서 gpt_sovits config 업데이트 코드 제거.
- [ ] `docker-compose.yml`, `docker-compose.dev.yml`, `docker-compose.prod.yml` 의 `gpt-sovits` 서비스 + 주석 + env 안내 제거.
- [ ] `frontend/src/lib/api.ts`의 엔진 분기에 gpt_sovits가 있으면 정리 (있을 가능성 낮음).
- [ ] 검증: 백엔드 부팅, 채팅 TTS, 4 템플릿 로드, docker compose up 모두 정상.

**Phase 1~4**:
- [ ] 기존 `/api/tts/*` 30+ 엔드포인트 시그너처 동결 — e2e 회귀 테스트 작성.
- [ ] 에이전트 채팅 `/speak/stream` 호출 흐름 변경 없음 — 통합 테스트.
- [ ] 4 내장 템플릿 (`paimon_ko`, `ruan_mei`, `ellen_joe`, …) 정상 로드 + Studio UI에서 동일하게 표시.
- [ ] `gpt_sovits_settings` 필드가 있는 기존 프로필 파일 → 백엔드가 무시(read silent ignore), 파일은 손대지 않음.
- [ ] **`/app/tts-voice` 페이지 그대로 유지** — redirect 안 함. 상단에 Voice Studio 안내 배너만 추가.
- [ ] **Geny `Sidebar.tsx`에 "Voice Studio" 메뉴 신규 추가** — 기존 메뉴 그대로 두고 추가만.
- [ ] 기존 `ttsApi` 모든 메서드 그대로 — `voiceStudioApi`는 별 객체로 추가.
- [ ] Settings 변경 (default 엔진, num_step) 후에도 에이전트 채팅 정상 동작.
- [ ] omnivoice 마이크로서비스 코드 한 줄도 변경 없음.

**검증 후 (별 PR, Phase 4 머지 후 사용자 결정)**:
- [ ] `/tts-voice` 페이지 제거 + 메인 네비에서 옛 메뉴 제거 (사용자가 "이제 Voice Studio가 충분히 됐다" 판정 시).

---

다음 문서 [05-implementation-roadmap.md](./05-implementation-roadmap.md)에서 Phase 1~4의 PR 단위와 산출물을 구체화한다.
