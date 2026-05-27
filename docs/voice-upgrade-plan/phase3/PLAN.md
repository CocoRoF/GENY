# Phase 3 — PR 3: Engine metadata + Settings 페이지 PLAN

> Voice Studio의 `/voice-studio/settings` placeholder를 본격 페이지로 채운다.
>
> 1. **Engine Compatibility Matrix** — 4 엔진(edge_tts/openai/elevenlabs/omnivoice)의
>    기술 메타 + 가용성 status 를 한눈에. 사용자가 default 엔진을 선택 + 영속.
> 2. **OmniVoice defaults** — config 데이터클래스 필드 (num_step / guidance / speed /
>    duration / denoise / audio_format / sample_rate) 편집. 저장하면 Synthesize 카드의
>    Advanced 패널 초기값으로 사용.
> 3. **Cache stats + 비우기** — 기존 `/api/tts/cache/{stats,}` 그대로 호출.
>
> Backend는 신규 라우터 1~2개 + ABC 확장. 기존 `/api/tts/*` 동결 유지.
>
> 사용자 메모리 `feedback_verify_code_over_docs.md` 준수 — TTSEngine 본체 + config_manager
> 시그너처 코드로 확인 완료. 사용자 메모리 `feedback_policy_config_not_hardcode.md` 준수 —
> 엔진 메타는 ClassVar로 선언하되 default 엔진 선택은 settings_store에서 영속.

---

## 0. 스코프 요약

### 포함 (PR 3)
- **`TTSEngine` ABC 확장** — ClassVar 메타 8개 추가 + `is_available()` 기본 구현.
- **4 엔진 메타 채움** — omnivoice / edge_tts / openai / elevenlabs.
- **신규 `service/voice_studio/settings_store.py`** — SQLite key-value (default engine 등 영속).
- **신규 `service/voice_studio/engine_registry.py`** — 메타 + parallel `is_available()` probe.
- **신규 라우터**:
  - `GET    /api/voice-studio/engines` — Compatibility Matrix payload
  - `POST   /api/voice-studio/engines/default` — default 엔진 영속
  - `GET    /api/voice-studio/settings/omnivoice-defaults` — current defaults
  - `PUT    /api/voice-studio/settings/omnivoice-defaults` — 업데이트
- **`/voice-studio/settings` 페이지 본격 구현** + 3 카드 + voiceStudioApi 확장 + i18n.

### 제외 (Phase 3 아님)
- HF token 관리 — 현재 omnivoice 컨테이너 env로 set. UI 카드는 Phase 5 (auto_asr 활용 시점).
- `/api/tts/cache/*` 신규 prefix — 기존 endpoint 그대로 호출.
- `tts_general_config` 의 streaming/emotion-mapping 편집 — 본 PR은 OmniVoice defaults 만.
- 신규 엔진 (IndexTTS2 등) — Phase 5.

### 호환 보장
- 기존 `/api/tts/*` 30+ 엔드포인트 시그너처 동결.
- 기존 `TTSEngine.engine_name` / `supports_sentence_stream` / `health_check` 메서드 그대로.
- 새로운 메타 필드는 모두 **ClassVar with safe default** — 4 엔진이 override 안 해도 컴파일/런타임 정상.

---

## 1. Backend 변경 명세

### 1.1 `service/vtuber/tts/base.py` — ABC 확장

기존 코드 보존. 다음 ClassVar + 메서드 추가:

```python
class TTSEngine(ABC):
    engine_name: str = "base"
    supports_sentence_stream: bool = False

    # ── NEW: studio metadata (all ClassVar with safe defaults) ──────
    display_name: ClassVar[str] = "Unknown engine"
    sample_rate: ClassVar[int] = 24000
    supported_languages: ClassVar[list[str]] = ["multi"]
    gpu_compat: ClassVar[tuple[str, ...]] = ("cpu",)
    supports_voice_design: ClassVar[bool] = False
    supports_clone: ClassVar[bool] = False
    supports_emotion_vector: ClassVar[bool] = False
    license: ClassVar[str] = ""

    # ... existing methods ...

    async def is_available(self) -> tuple[bool, str]:
        """Studio-aware availability check.

        Default: surface ``health_check()`` with a generic reason.
        Engines should override to surface specific failure causes
        (missing API key, omnivoice phase=loading, etc.) so the
        Settings Compatibility Matrix can show them.
        """
        try:
            ok = await self.health_check()
        except Exception as e:
            return (False, f"{type(e).__name__}: {e}")
        return (ok, "ok") if ok else (False, "health check failed")
```

### 1.2 4 엔진 메타 채움

각 엔진 class body에 8 ClassVar 추가 + (필요시) `is_available` override.

**`omnivoice_engine.py`**:
```python
display_name = "OmniVoice (k2-fsa)"
sample_rate = 24000
supported_languages = ["multi"]   # 646
gpu_compat = ("cuda", "mps", "cpu")
supports_voice_design = True
supports_clone = True
supports_emotion_vector = False
license = "OpenRAIL-M"
```
`is_available` override — omnivoice phase=ok 확인 (기존 `health_check`이 이미 그렇게 함; 그대로 surfac).

**`edge_tts_engine.py`**:
```python
display_name = "Edge TTS (Microsoft)"
sample_rate = 24000
supported_languages = ["multi"]   # 80+
gpu_compat = ("cloud",)
supports_voice_design = False
supports_clone = False
license = "Microsoft Cloud TOS"
```

**`openai_tts_engine.py`**:
```python
display_name = "OpenAI TTS"
sample_rate = 24000
supported_languages = ["multi"]
gpu_compat = ("cloud",)
supports_voice_design = False
supports_clone = False
license = "OpenAI ToS"
```
`is_available` override — API key 없으면 (False, "missing OPENAI_API_KEY")

**`elevenlabs_engine.py`**:
```python
display_name = "ElevenLabs"
sample_rate = 24000
supported_languages = ["multi"]
gpu_compat = ("cloud",)
supports_voice_design = False
supports_clone = True
license = "ElevenLabs ToS"
```
`is_available` override — 같은 식.

### 1.3 `service/voice_studio/settings_store.py` (신규)

```python
class SettingsStore:
    """Tiny key-value SQLite store for the Voice Studio settings page."""
    def __init__(self, data_dir: Path | None = None): ...
    def get(self, key: str, default: Any = None) -> Any: ...
    def set(self, key: str, value: Any) -> None: ...
    def delete(self, key: str) -> None: ...

def get_settings_store() -> SettingsStore: ...
```

저장 위치: `<GENY_VOICE_STUDIO_DATA_DIR>/settings.sqlite3` — history와 같은 디렉토리 + 같은 named volume 재활용.

값은 JSON으로 저장 (str/int/bool/dict 모두 OK).

### 1.4 `service/voice_studio/engine_registry.py` (신규)

```python
@dataclass
class EngineCard:
    id: str
    display_name: str
    sample_rate: int
    supported_languages: list[str]
    gpu_compat: list[str]
    supports_voice_design: bool
    supports_clone: bool
    supports_emotion_vector: bool
    license: str
    available: bool
    reason: str
    engine_default_emoji: str = ""   # optional UI hint (we keep this empty for now)

async def list_engine_cards() -> list[EngineCard]:
    """Snapshot each registered engine's metadata + parallel is_available."""
    svc = get_tts_service()
    engines = list(svc._engines.items())  # name → instance
    async def probe(name: str, eng):
        try:
            ok, reason = await eng.is_available()
        except Exception as e:
            ok, reason = False, f"{type(e).__name__}: {e}"
        return EngineCard(
            id=name,
            display_name=eng.display_name,
            sample_rate=int(eng.sample_rate),
            supported_languages=list(eng.supported_languages),
            gpu_compat=list(eng.gpu_compat),
            supports_voice_design=bool(eng.supports_voice_design),
            supports_clone=bool(eng.supports_clone),
            supports_emotion_vector=bool(eng.supports_emotion_vector),
            license=eng.license,
            available=bool(ok),
            reason=str(reason),
        )
    return await asyncio.gather(*[probe(n, e) for n, e in engines])

def get_default_engine_name() -> str: ...
def set_default_engine_name(name: str) -> None: ...
```

### 1.5 `controller/voice_studio/engines.py` (신규)

```python
@router.get("/engines")
async def list_engines() -> dict:
    cards = await list_engine_cards()
    return {
        "engines": [asdict(c) for c in cards],
        "default": get_default_engine_name(),
    }

class SetDefaultRequest(BaseModel):
    name: str

@router.post("/engines/default")
async def set_default(body: SetDefaultRequest) -> dict:
    # Validate name exists in registry.
    cards = await list_engine_cards()
    valid = {c.id for c in cards}
    if body.name not in valid:
        raise HTTPException(status_code=400, detail=f"unknown engine: {body.name}")
    set_default_engine_name(body.name)
    return {"ok": True, "default": body.name}
```

**get_default_engine_name 의 fallback 순서**:
1. settings_store key="default_engine" (영속값)
2. `tts_general_config.provider` (Phase 0.5 이후 → "omnivoice")
3. "edge_tts" (마지막 fallback)

`set_default_engine_name(name)` → settings_store + `tts_general_config.provider` 둘 다 업데이트.
이렇게 하면 채팅 path (기존 `get_engine(name=None)` → general.provider 사용)와 voice-studio default가 자동 동기화.

### 1.6 `controller/voice_studio/defaults.py` (신규)

OmniVoice defaults 편집.

```python
class OmniVoiceDefaults(BaseModel):
    num_step: int = Field(..., ge=1, le=128)
    guidance_scale: float = Field(..., ge=0.0, le=10.0)
    speed: float = Field(..., gt=0.0, le=4.0)
    duration_seconds: float = Field(..., ge=0.0, le=120.0)
    denoise: bool
    audio_format: Literal["wav", "mp3", "ogg", "pcm"]

@router.get("/settings/omnivoice-defaults")
async def get_omnivoice_defaults() -> OmniVoiceDefaults:
    cfg = get_config_manager().load_config(OmniVoiceConfig)
    return OmniVoiceDefaults(
        num_step=cfg.num_step,
        guidance_scale=cfg.guidance_scale,
        speed=cfg.speed,
        duration_seconds=cfg.duration_seconds,
        denoise=cfg.denoise,
        audio_format=cfg.audio_format,
    )

@router.put("/settings/omnivoice-defaults")
async def put_omnivoice_defaults(body: OmniVoiceDefaults) -> OmniVoiceDefaults:
    mgr = get_config_manager()
    cfg = mgr.load_config(OmniVoiceConfig)
    cfg.num_step = body.num_step
    cfg.guidance_scale = body.guidance_scale
    cfg.speed = body.speed
    cfg.duration_seconds = body.duration_seconds
    cfg.denoise = body.denoise
    cfg.audio_format = body.audio_format
    mgr.save_config(cfg)
    return body
```

### 1.7 `controller/voice_studio/__init__.py` — 신규 라우터 등록

```python
from .engines import router as _engines_router
from .defaults import router as _defaults_router
router.include_router(_engines_router)
router.include_router(_defaults_router)
```

---

## 2. Frontend 변경 명세

### 2.1 `voiceStudioApi.ts` 확장

```typescript
export interface EngineCard {
  id: string;
  display_name: string;
  sample_rate: number;
  supported_languages: string[];
  gpu_compat: string[];
  supports_voice_design: boolean;
  supports_clone: boolean;
  supports_emotion_vector: boolean;
  license: string;
  available: boolean;
  reason: string;
}

export interface OmniVoiceDefaults {
  num_step: number;
  guidance_scale: number;
  speed: number;
  duration_seconds: number;
  denoise: boolean;
  audio_format: 'wav' | 'mp3' | 'ogg' | 'pcm';
}

export interface CacheStats {
  hit_count?: number;
  miss_count?: number;
  size_mb?: number;
  // tts_controller 응답 shape에 맞춰 옵셔널로
}

export const voiceStudioApi = {
  // ... existing ...
  async getEngines(signal?): Promise<{engines: EngineCard[]; default: string}> { ... },
  async setDefaultEngine(name: string): Promise<{ok: true; default: string}> { ... },
  async getOmniVoiceDefaults(): Promise<OmniVoiceDefaults> { ... },
  async putOmniVoiceDefaults(body: OmniVoiceDefaults): Promise<OmniVoiceDefaults> { ... },
  async getCacheStats(): Promise<CacheStats> {
    // calls /api/tts/cache/stats (legacy endpoint, unchanged)
  },
  async clearCache(): Promise<void> {
    // calls DELETE /api/tts/cache
  },
};
```

### 2.2 신규 컴포넌트

**`EngineMatrixCard.tsx`**:
- 1 카드, 안에 4 엔진 행 + 표 형태:
  ```
  ⦿ omnivoice  ✓ ok       cuda/mps/cpu  multi  design✓ clone✓ OpenRAIL-M
  ◯ edge_tts   ✓ ok       cloud         multi  —       —      Microsoft ToS
  ◯ openai     ⚠ no key   cloud         multi  —       —      OpenAI ToS
  ◯ elevenlabs ⚠ no key   cloud         multi  —       clone✓ ElevenLabs ToS
  ```
- Default 라디오는 `setDefaultEngine` 호출 후 toast.
- 초기 로드 + ↻ refresh 버튼.

**`OmniVoiceDefaultsCard.tsx`**:
- num_step (slider), guidance (slider), speed (slider), duration_seconds (number), denoise (checkbox), audio_format (select).
- Save 버튼 → `putOmniVoiceDefaults`.
- 안내 텍스트: "변경된 default는 새 합성 시점부터 적용됩니다 (Synthesize 카드 advanced 패널 초기값)."

**`CacheCard.tsx`**:
- `getCacheStats` 결과 표시.
- "Clear" 버튼 → `clearCache` + 확인 다이얼로그.

### 2.3 `settings/page.tsx` 본격 구현

```tsx
'use client';

export default function SettingsPage() {
  return (
    <div className="max-w-4xl mx-auto px-6 py-6 space-y-5">
      <EngineMatrixCard />
      <OmniVoiceDefaultsCard />
      <CacheCard />
    </div>
  );
}
```

placeholder text 제거.

### 2.4 i18n 신규 키 (ko/en)

`voiceStudio.settings.*`:
- `engines.title`, `engines.statusOk`, `engines.statusBad`, `engines.default`, `engines.refresh`, `engines.lic`, `engines.cloud`, `engines.designOk`, `engines.cloneOk`
- `omnivoiceDefaults.title`, `omnivoiceDefaults.hint`, `omnivoiceDefaults.save`, `omnivoiceDefaults.saved`
- `cache.title`, `cache.stats`, `cache.clear`, `cache.confirmClear`, `cache.cleared`

기존 `voiceStudio.cloneDesign.advanced.*` 의 num_step / guidance / speed / duration 라벨은 재사용.

---

## 3. 작업 순서

1. branch `feature/voice-studio-phase3`
2. **Backend**:
   - `base.py` ABC 메타 + `is_available`
   - 4 engine 파일 메타 채우기 (소소한 추가만)
   - `service/voice_studio/settings_store.py`
   - `service/voice_studio/engine_registry.py`
   - `controller/voice_studio/engines.py`
   - `controller/voice_studio/defaults.py`
   - `controller/voice_studio/__init__.py` 등록
   - py_compile 통과
3. **Frontend**:
   - `voiceStudioApi.ts` extensions
   - `EngineMatrixCard.tsx` / `OmniVoiceDefaultsCard.tsx` / `CacheCard.tsx`
   - `settings/page.tsx` 실 구현
   - i18n ko/en
4. `npm run build` 통과
5. commit + PR + 머지 + 배포 + 검증

---

## 4. 검증

### 4.1 정적
- py_compile 6 파일 통과
- `npm run build` 0 errors, 17 routes (변동 없음)

### 4.2 런타임 (서버 배포 후)
- `GET /api/voice-studio/engines` → 4 엔진 카드, available 상태 반영, default=omnivoice
- `POST /api/voice-studio/engines/default` `{"name":"edge_tts"}` → ok + `tts_general_config.provider` 도 edge_tts 로 변경
- `GET /api/voice-studio/settings/omnivoice-defaults` → 현 cfg 반환
- `PUT /api/voice-studio/settings/omnivoice-defaults` (num_step 12) → 응답에 12, 그 직후 GET 도 12
- 회귀: 에이전트 채팅 TTS 정상, `/api/tts/engines` 그대로

---

## 5. 리스크

| 리스크 | 완화 |
|---|---|
| settings_store가 history와 같은 DB? | 별 파일 `settings.sqlite3` 로 분리, 충돌 없음 |
| set_default가 tts_general_config.provider도 바꾸므로 채팅 path 영향 | 사용자가 default 변경한 것 자체가 의도. but 카드에 경고 표시 |
| 엔진 메타 추가 시 기존 타입 체크 깨짐 | ClassVar + default value 이므로 안전 |
| `is_available` 가 cloud 엔진에서 매번 외부 호출? | 본 PR 에서는 health_check 캐시 안 함. 사용자가 ↻ 누를 때만 새 fetch (frontend 캐시). 백엔드는 매번 fresh. |
| OmniVoice defaults 변경 후 Synthesize 카드는 reload 필요 | Advanced 패널 초기값은 페이지 mount 시점 fetch — 사용자가 settings 저장 후 페이지 새로고침 시 반영. Synthesize 페이지에 reload 안내 (Phase 4에 자동 반영 가능). |

---

## 6. PR 정보

- 브랜치: `feature/voice-studio-phase3`
- 제목: `feat(voice-studio): engine compatibility matrix + OmniVoice defaults + cache stats settings`
- 본문: 위 §0~§5 요약

---

## 7. 다음 단계

PR 3 머지 → Phase 4 (Batch 합성 + Tools).
