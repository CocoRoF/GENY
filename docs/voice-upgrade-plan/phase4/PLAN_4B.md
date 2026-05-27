# Phase 4 — PR 4B: Tools 페이지 PLAN

> `/voice-studio/tools` placeholder를 본격 페이지로 채운다.
> 4 도구:
>
> 1. **Language Detect** — 텍스트의 언어 추정 (한국어/일본어/중국어/영문 + Unicode 통계).
> 2. **A/B Compare** — 같은 텍스트를 2~5 variant로 동시 합성 (다른 seed / mode / num_step).
> 3. **Seed Search** — text + profile, N개 seed 샘플 후 사용자가 청취 비교.
> 4. **Ref Analyzer** — wav 업로드 → duration / RMS / 권장 cut window.
>
> 새 backend dependency **추가 없음** (numpy 기존 활용, langdetect/librosa 사용 안 함).
> 사용자 메모리 `feedback_policy_config_not_hardcode.md` 준수 — 정책은 config(min_ref/max_ref s)로 + 코드 hard-code 안 함.

---

## 0. 스코프 요약

### 포함 (PR 4B)
- **Backend**:
  - `service/voice_studio/tools/__init__.py`
  - `service/voice_studio/tools/language_detect.py` — Unicode block ratio 기반 (한/일/중/영 + Latin/Cyrillic 기본).
  - `service/voice_studio/tools/ref_analyzer.py` — wave + numpy: duration, sample_rate, RMS, silence ratio, 권장 cut windows (5–15s, RMS threshold).
  - `controller/voice_studio/tools.py` — 3 endpoint (detect-language, analyze-ref, seed-search).
  - `controller/voice_studio/__init__.py` — 라우터 등록.
- **Frontend**:
  - `lib/voiceStudioApi.ts` — detectLanguage / analyzeRef / seedSearch + 타입.
  - `components/voice-studio/tools/LanguageDetectTool.tsx`
  - `components/voice-studio/tools/CompareTool.tsx` — backend 추가 호출 없음, 기존 synthesizePreview N번.
  - `components/voice-studio/tools/SeedSearchTool.tsx`
  - `components/voice-studio/tools/RefAnalyzerTool.tsx`
  - `app/voice-studio/tools/page.tsx` — 4 도구 카드 그리드 + 각 도구 ▸ 열면 확장 패널.
- **i18n** — `voiceStudio.tools.*` ko/en.

### 제외 (PR 4B 아님)
- Phoneme tool (별 음소 변환 라이브러리 필요)
- Audio convert (ffmpeg subprocess — Phase 5 이후)
- Profile zip import/export — 별 PR
- Seed Search의 자동 ranking — 현재는 사용자가 청취로 비교

### 호환
- backend deps 변경 없음 → 빌드/배포 캐시 효과적.
- omnivoice 마이크로서비스 무변경.

---

## 1. Backend 변경 명세

### 1.1 `service/voice_studio/tools/language_detect.py` (신규)

```python
def detect_language(text: str) -> dict:
    """Returns {'language': 'ko'|'ja'|'zh'|'en'|...,
                'confidence': 0.0~1.0,
                'detail': {'ko_ratio': ..., 'ja_ratio': ..., ...}}
    """
```

Strategy (deps-free):
- Unicode block ratio: 한글 (`가–힯`), 히라가나/가타카나 (`぀–ゟ`, `゠–ヿ`), 한자 (`一–鿿`), Latin (`A–Z`, `a–z`), Cyrillic, Arabic, Devanagari.
- 비율 ranking + 가장 큰 ratio가 임계치 (>0.3) 초과면 그 언어, 아니면 "unknown".
- 한자 + 히라가나/가타카나 둘 다 있으면 → ja (일본어가 한자도 씀); 한자만 → zh.
- 정확도 한계 안내는 UI에 명시.

### 1.2 `service/voice_studio/tools/ref_analyzer.py` (신규)

```python
import wave
import numpy as np

@dataclass
class RefAnalysis:
    duration_seconds: float
    sample_rate: int
    channels: int
    rms_db: float                   # overall RMS, dBFS
    silence_ratio: float            # 0~1, sample-level VAD
    suggested_windows: list[dict]   # [{start, end, rms_db}] candidates 5-15s, sorted by quality

def analyze_ref(wav_bytes: bytes) -> RefAnalysis: ...
```

Algorithm:
- `wave.open(BytesIO(bytes))` → frames, sample_rate, n_channels, sample_width.
- Convert frames to float32 numpy (downmix if stereo).
- RMS = sqrt(mean(x**2)); dBFS = 20 * log10(max(rms, 1e-10)).
- Silence detection: 100ms windows, RMS < -45 dBFS = silent. silence_ratio = silent_window_count / total_windows.
- Suggested windows: scan with 5–15s sliding window, score by (mean RMS — silence_count × penalty). Top 3 non-overlapping.
- Returns dataclass.

Hard cap: input bytes ≤ 5 MB (UI rejects larger).

### 1.3 `controller/voice_studio/tools.py` (신규)

```python
class DetectLanguageRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=5000)

@router.post("/tools/detect-language")
async def detect_language_route(body: DetectLanguageRequest) -> dict: ...

@router.post("/tools/analyze-ref")
async def analyze_ref_route(file: UploadFile = File(...)) -> dict: ...

class SeedSearchRequest(BaseModel):
    text: str
    profile: str
    emotion: str = "neutral"
    mode: Literal["clone", "design", "auto"] = "clone"
    language: str | None = None
    num_step: int | None = None
    n: int = Field(default=5, ge=1, le=10)
    seeds: list[int] | None = None  # if provided, use exactly these; else generate random

@router.post("/tools/seed-search")
async def seed_search_route(body: SeedSearchRequest) -> dict:
    # Run N synthesize_preview calls, each with a different seed.
    # Store wavs in voice_studio data dir under tools/seed-search/<batch_id>/
    # Return {batch_id, results: [{seed, audio_url, duration, rtf}]}
```

Seed Search 저장:
- `<data_dir>/tools/seed_search/<batch_id>/<seed>.wav`
- `GET /api/voice-studio/tools/seed-search/{batch_id}/{seed}/audio` for streaming
- batch는 즉시 사용용이라 휘발성 — 24h 후 cleanup (cron 없으니 일단 안 함, 디스크 모니터링 안내)

### 1.4 `__init__.py` 라우터 등록

```python
from .tools import router as _tools_router
router.include_router(_tools_router)
```

---

## 2. Frontend 변경 명세

### 2.1 `voiceStudioApi.ts` 확장

```typescript
export interface LangDetectResult {
  language: string;
  confidence: number;
  detail: Record<string, number>;
}

export interface RefAnalysisResult {
  duration_seconds: number;
  sample_rate: number;
  channels: number;
  rms_db: number;
  silence_ratio: number;
  suggested_windows: { start: number; end: number; rms_db: number }[];
}

export interface SeedSearchResult {
  batch_id: string;
  results: { seed: number; audio_url: string; duration: number; rtf: number }[];
}

// 추가 메서드: detectLanguage / analyzeRef (multipart) / seedSearch
```

### 2.2 4 Tool 컴포넌트

각각 `<Card>` 형태로 toggleable. 카드 헤더 클릭 → 펼침.

**`LanguageDetectTool`**:
- textarea + Detect 버튼 → 응답 표시: `language: ko (0.85), 한글 비율 90%, ...`

**`CompareTool`**:
- 텍스트 + 2~5 variant 행 (각 행: seed, num_step, mode override 같은 minimal field)
- ▶ Generate All → 병렬로 voiceStudioApi.synthesizePreview N번
- 결과: waveform N개 가로 나란히 + 각각 ▶/⬇

**`SeedSearchTool`**:
- 텍스트 + profile + emotion + N(2~10) → ▶ Search → backend /tools/seed-search 호출
- 결과: N개 행 (seed / ▶ / ⬇ / rtf), 사용자가 청취 후 "이게 좋다" 마크 (state만, 영속 X)

**`RefAnalyzerTool`**:
- wav 업로드 → /tools/analyze-ref multipart POST
- 결과: duration, sample_rate, RMS, silence_ratio + 권장 cut window 3개 (Trim 페이지 deep-link 가능 — 옵션)

### 2.3 `tools/page.tsx`

placeholder 제거 + 4 카드 (collapsible)를 세로 배치.

### 2.4 i18n 신규 키 (ko/en)

`voiceStudio.tools.*`:
- `pageTitle`
- `langDetect.{title, hint, placeholder, detect, language, confidence, detail}`
- `compare.{title, hint, variantsLabel, seed, addVariant, removeVariant, generateAll, generating}`
- `seedSearch.{title, hint, profile, emotion, n, run, running, seed, results}`
- `refAnalyzer.{title, hint, upload, analyzing, duration, sampleRate, channels, rmsDb, silenceRatio, suggestedWindows, useThisWindow}`

---

## 3. 작업 순서

1. branch `feature/voice-studio-phase4b`
2. backend (3 service files + 1 controller + register)
3. py_compile 통과
4. frontend (voiceStudioApi + 4 tools + page)
5. i18n
6. `npm run build` 0 errors
7. commit + PR + 머지 + 배포 + 운영 검증

---

## 4. 검증

- `POST /api/voice-studio/tools/detect-language {"text":"안녕하세요"}` → `language=ko, confidence>0.5`
- `POST /api/voice-studio/tools/detect-language {"text":"Hello there"}` → `language=en`
- `POST /api/voice-studio/tools/analyze-ref` with paimon's `ref_neutral.wav` → duration / sample_rate / RMS 정상
- `POST /api/voice-studio/tools/seed-search` with n=3, profile=ellen_joe → 3 wav 결과
- 회귀: 기존 routes 모두 정상

---

## 5. 리스크

| 리스크 | 완화 |
|---|---|
| 자체 character-set 휴리스틱이 일/중 혼동 | hiragana/katakana 있으면 ja 우선 (정확) |
| ref_analyzer가 wav 외 포맷에서 실패 | 명시적 wav-only 안내; mp3/ogg는 reject |
| seed_search가 N=10이면 omnivoice 부하 | 최대 N=10 cap |
| seed_search 디스크 누적 | 안내만; 추후 cleanup cron |
| compare가 5 variant 동시 호출 → 클라이언트 부하 | 최대 5; 결과는 blob URL revoke 처리 |

---

## 6. PR 정보

- 브랜치: `feature/voice-studio-phase4b`
- 제목: `feat(voice-studio): tools page (language detect / A/B compare / seed search / ref analyzer)`

---

## 7. 다음 단계

PR 4B 머지 → 서버 배포 → Phase 5 (옵션 — 신규 엔진) 또는 사용 검증 단계.
