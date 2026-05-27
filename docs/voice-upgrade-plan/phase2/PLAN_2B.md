# Phase 2 — PR 2B: 합성 히스토리 + Save-as-ref PLAN

> Voice Studio Synthesize 카드의 두 마지막 빈자리를 채운다.
>
> 1. **히스토리** — 최근 20개 합성 결과를 영속 저장. 사용자가 같은 seed로
>    재합성하거나 wav 그대로 다운로드, 또는 직접 ref로 저장 가능.
> 2. **Save as ref** — 방금 합성한 결과를 프로필/감정 ref 슬롯으로 한 번에 저장.
>
> 사용자 메모리 `feedback_sudo_compose_home_pitfall.md` 준수 — prod compose는
> sudo 실행 (HOME=/root). named volume + 명시적 절대 경로 + 환경변수 fallback.
>
> 기존 `/api/tts/*` 시그너처 동결, omnivoice 마이크로서비스 무변경.
> 새 엔드포인트는 모두 `/api/voice-studio/*` prefix.

---

## 0. 스코프 요약

### 포함 (PR 2B)
- **Backend**:
  - `service/voice_studio/history_store.py` — SQLite + audio blob 저장 (cap 20개, oldest-out).
  - `controller/voice_studio/history.py` — 4 엔드포인트 (list / audio stream / replay / delete).
  - `controller/voice_studio/save_as_ref.py` — `POST /synth/save-as-ref` (history_id + profile + emotion → ref wav 복사 + profile.json 갱신).
  - `controller/voice_studio/synthesis_preview.py` 수정 — 합성 성공 시 history에 INSERT (fire-and-forget, history 실패가 합성 응답을 막지 않음).
  - `controller/voice_studio/__init__.py` 수정 — 신규 라우터 include.
  - 환경변수: `GENY_VOICE_STUDIO_DATA_DIR` (default `/data/voice_studio` in prod, `./data/voice_studio` 로컬 fallback).
- **Docker compose** (3 파일):
  - `docker-compose.prod.yml` — `geny-voice-studio-prod` named volume + env var + bind 정의.
  - `docker-compose.dev.yml` — `geny-voice-studio-dev`.
  - `docker-compose.yml` (default) — `geny-voice-studio`.
- **Frontend**:
  - `lib/voiceStudioApi.ts` — `getHistory()`, `getHistoryAudioUrl()`, `deleteHistory()`, `replayHistory()`, `saveAsRef()`.
  - `components/voice-studio/HistoryPanel.tsx` — 합성 카드 아래 펼침. 최근 20개. 항목당 ▶/↻/⬇/💾/🗑.
  - `components/voice-studio/SaveAsRefModal.tsx` — 합성 결과(또는 history 항목) → 프로필/감정 선택 → 업로드.
  - `components/voice-studio/SynthesizeCard.tsx` 수정 — 합성 성공 시 history 자동 갱신, "💾 Save as ref" 액션 버튼, HistoryPanel mount.
- **i18n** — `voiceStudio.history.*` + `voiceStudio.saveAsRef.*` (ko + en).

### 제외 (PR 2B 아님)
- omnivoice 마이크로서비스 변경 — 무.
- 기존 `/api/tts/*` 시그너처 변경 — 무.
- `/tts-voice` 페이지 — 무변경.
- 엔진 메타데이터 / Settings — Phase 3.
- Batch / Tools — Phase 4.

### 호환 보장
- 새 named volume이 없는 환경(첫 deploy 시)에서도 백엔드는 데이터 디렉토리를 lazy-create + 동작 (volume이 추가되어도 기존 데이터 손실 없음).
- 기존 컨테이너의 다른 named volume 정의는 무변경.

---

## 1. Backend 변경 명세

### 1.1 `service/voice_studio/history_store.py` (신규)

```python
"""SQLite + filesystem store for Voice Studio synthesis history.

Cap = 20 entries. When INSERT pushes the count over the cap, the oldest
row's audio file is unlinked and the row deleted.
"""

DEFAULT_DATA_DIR = "/data/voice_studio"  # named-volume mount target
DEFAULT_DATA_DIR_FALLBACK = "/app/data/voice_studio"  # if /data not writable

class HistoryStore:
    def __init__(self, data_dir: str | None = None): ...
    # Schema: id, created_at, text, profile, engine, mode, seed,
    #         params_json, audio_path, duration_seconds, rtf, sample_rate
    def insert(self, **fields) -> str: ...
    def list_recent(self, limit: int = 20) -> list[dict]: ...
    def get(self, id: str) -> dict | None: ...
    def audio_path(self, id: str) -> str | None: ...
    def delete(self, id: str) -> bool: ...
    def _enforce_cap(self): ...

_singleton: HistoryStore | None = None
def get_history_store() -> HistoryStore: ...  # lazy singleton
```

Data dir resolution:
- ENV `GENY_VOICE_STUDIO_DATA_DIR` if set.
- Else `/data/voice_studio` (prod named volume).
- Else `/app/data/voice_studio` (legacy fallback, container writable layer).
- Creates SQLite at `<dir>/history.sqlite3`, audio at `<dir>/audio/<id>.wav`.

ID generation: `secrets.token_hex(8)`.

### 1.2 `controller/voice_studio/history.py` (신규)

```python
@router.get("/synth/history")
async def list_history() -> dict:
    # → {"items": [{id, created_at, text, profile, mode, seed, duration_seconds, rtf}, ...]}

@router.get("/synth/history/{id}/audio")
async def stream_history_audio(id: str) -> Response:
    # Stream the stored wav. 404 if id unknown.

@router.delete("/synth/history/{id}")
async def delete_history(id: str) -> dict:
    # → {"ok": true} / 404

@router.post("/synth/history/{id}/replay")
async def replay_history(id: str) -> Response:
    # Load the stored params_json, dispatch back through
    # OmniVoiceEngine.synthesize_preview, return audio + headers
    # exactly like /synth/preview. Optionally insert a fresh history row.
```

### 1.3 `controller/voice_studio/save_as_ref.py` (신규)

```python
class SaveAsRefRequest(BaseModel):
    history_id: str
    profile: str
    emotion: Literal["neutral","joy","anger","sadness","fear","surprise","disgust","smirk"]
    prompt_text: Optional[str] = None
    prompt_lang: Optional[str] = None

@router.post("/synth/save-as-ref")
async def save_as_ref(body: SaveAsRefRequest) -> dict:
    """Copy a stored synthesis wav into the profile's ref slot.

    Equivalent to downloading the history audio + uploading via
    /api/tts/profiles/{name}/ref but does it server-side to avoid the
    blob round-trip. Reuses the existing tts_controller helpers
    (_atomic_write_json + _migrate_emotion_refs) by importing them; if
    that proves circular, replicate the small file IO inline.

    Templates are protected (HTTPException 403).
    """
```

Implementation note: the existing `tts_controller.upload_reference_audio` does:
1. Path-traversal guards.
2. Block templates.
3. Atomic write wav to `static/voices/{profile}/ref_{emotion}.wav`.
4. Update `profile.json` emotion_refs entry.

Save-as-ref does the same steps but the source is the history wav rather than an uploaded file. **Approach: copy the audio bytes directly + reuse the JSON update helper** (inline duplication if importing the helper is awkward — the file IO is ~15 lines).

### 1.4 `controller/voice_studio/synthesis_preview.py` 수정

성공 응답을 만들기 직전에 history INSERT (best-effort):

```python
try:
    history_id = get_history_store().insert(
        text=params.text,
        profile=params.profile,
        engine="omnivoice",
        mode=payload.get("mode"),
        seed=result.seed_used,
        params_json=json.dumps(params.model_dump(exclude_none=True)),
        audio_bytes=result.audio_bytes,
        duration_seconds=result.duration,
        rtf=result.rtf,
        sample_rate=result.sample_rate,
    )
    response_headers["X-VoiceStudio-History-Id"] = history_id
except Exception:
    logger.warning("voice-studio history insert failed", exc_info=True)
    # do not block the response
```

새 응답 헤더: `X-VoiceStudio-History-Id`. 프론트엔드는 이 id를 받아 즉시 save-as-ref / replay 가능.

### 1.5 `controller/voice_studio/__init__.py` 수정

```python
from .history import router as _history_router
from .save_as_ref import router as _save_router

router.include_router(_history_router)
router.include_router(_save_router)
```

### 1.6 Docker compose 3 파일

각 파일에 backend 서비스의 `environment:`에:
```yaml
- GENY_VOICE_STUDIO_DATA_DIR=/data/voice_studio
```

`volumes:` 에:
```yaml
- geny-voice-studio-prod:/data/voice_studio   # 또는 -dev / 기본 -
```

`volumes:` (top-level, 파일 끝)에:
```yaml
geny-voice-studio-prod:
```

---

## 2. Frontend 변경 명세

### 2.1 `voiceStudioApi.ts` 확장

```typescript
export interface HistoryItem {
  id: string;
  created_at: string;
  text: string;
  profile?: string;
  engine: string;
  mode: string;
  seed?: number;
  duration_seconds: number;
  rtf: number;
  sample_rate: number;
}

export const voiceStudioApi = {
  // 기존 synthesizePreview, getLanguages …
  async getHistory(signal?: AbortSignal): Promise<HistoryItem[]> { ... },
  getHistoryAudioUrl(id: string): string {
    return `/api/voice-studio/synth/history/${encodeURIComponent(id)}/audio`;
  },
  async deleteHistory(id: string): Promise<void> { ... },
  async replayHistory(id: string, signal?: AbortSignal): Promise<PreviewResult> {
    // mirrors synthesizePreview's response handling
  },
  async saveAsRef(body: {
    history_id: string;
    profile: string;
    emotion: string;
    prompt_text?: string;
    prompt_lang?: string;
  }): Promise<{ ok: true }> { ... },
};
```

`synthesizePreview` 결과에서 `history_id` 헤더도 surface (`X-VoiceStudio-History-Id` → `result.historyId`).

### 2.2 `HistoryPanel.tsx` (신규)

Synthesize 카드 하단에 collapsible. 펼치면 최근 20개 카드.

```
▾ History (12)                                  [↻ Refresh]  [×]
┌──────────────────────────────────────────────────────────────┐
│ "안녕하세요. 오늘은 날씨가 좋네요."                                │
│ paimon_ko · clone · neutral · seed 12345 · 0.42s · RTF 0.21    │
│ 5분 전                                       [▶] [↻] [⬇] [💾] [🗑] │
├──────────────────────────────────────────────────────────────┤
│ ...                                                          │
└──────────────────────────────────────────────────────────────┘
```

Props:
- `refreshKey: number` — Synthesize가 성공할 때마다 증가시키면 자동 refetch.
- `onSaveAsRef: (item: HistoryItem) => void` — SaveAsRefModal 트리거.
- `onPickIntoCard?: (item: HistoryItem) => void` — 옵션 (Future: replay into card form). PR 2B에서는 생략 가능.

### 2.3 `SaveAsRefModal.tsx` (신규)

```
┌────────────────────────────────────────────────┐
│ Save as ref                                   │
├────────────────────────────────────────────────┤
│ Profile: [paimon_ko ▼] (templates excluded)    │
│ Emotion: ⦿ neutral ◯ joy ◯ anger ◯ sadness ...  │
│ Prompt text (opt): [텍스트가 합성 결과와 같다면 비워두기] │
│ Prompt lang (opt): [ko ▼]                      │
│                                                │
│                          [Cancel] [Save → Ref] │
└────────────────────────────────────────────────┘
```

- 프로필 리스트는 `ttsApi.listProfiles()` 사용. `is_template === true`인 항목 제외.
- 기본 emotion = SynthesizeCard에서 사용한 emotion 그대로 (props).
- 텍스트는 SynthesizeCard에서 쓴 text 그대로 pass (placeholder 안내).
- Save → `voiceStudioApi.saveAsRef({history_id, profile, emotion, prompt_text, prompt_lang})` + toast.

### 2.4 `SynthesizeCard.tsx` 수정

- `result.historyId` 헤더 surface해서 state로 보관.
- 결과 영역(현재 WaveformPreview 옆)에 "💾 Save as ref" 버튼 추가 (resultId 있을 때만).
- 합성 성공 시 `historyRefreshKey++` 트리거.
- HistoryPanel mount + SaveAsRefModal mount.
- 모달 confirm 시 toast + 자동 refetch.

### 2.5 i18n 신규 키 (ko/en)

`voiceStudio.history.*`:
- `title`, `count`, `loading`, `empty`, `refresh`, `relativeTime.{justNow, minutes, hours, days}`, `replay`, `download`, `saveAsRef`, `delete`, `confirmDelete`

`voiceStudio.saveAsRef.*`:
- `openLabel` (Synthesize 결과 버튼), `title`, `profile`, `emotion`, `promptText`, `promptLang`, `cancel`, `confirm`, `noNonTemplateProfile`, `success`

---

## 3. 작업 순서

1. `feature/voice-studio-phase2b` branch.
2. **Backend**:
   - `service/voice_studio/history_store.py`.
   - `controller/voice_studio/history.py`.
   - `controller/voice_studio/save_as_ref.py`.
   - `controller/voice_studio/synthesis_preview.py` patch (history insert + history-id header).
   - `controller/voice_studio/__init__.py` include new routers.
   - `py_compile` 통과.
3. **Docker compose** 3 파일 — env var + volume mount + top-level volume.
4. **Frontend** lib + components + i18n.
5. `npm run build` 0 errors.
6. commit + PR + merge + deploy + 운영 검증.

---

## 4. 검증 절차

### 4.1 정적

```bash
# Backend
python3 -m py_compile \
  backend/service/voice_studio/history_store.py \
  backend/controller/voice_studio/history.py \
  backend/controller/voice_studio/save_as_ref.py \
  backend/controller/voice_studio/synthesis_preview.py \
  backend/controller/voice_studio/__init__.py
# Frontend
npm run build
# Compose
docker compose -f docker-compose.prod.yml config | grep voice-studio
```

### 4.2 런타임 검증 (서버 배포 후)

1. **`POST /api/voice-studio/synth/preview`** — 응답 헤더에 `X-VoiceStudio-History-Id` 포함.
2. **`GET /api/voice-studio/synth/history`** — 방금 합성 항목 1개 이상 반환.
3. **`GET /api/voice-studio/synth/history/{id}/audio`** — wav bytes stream.
4. **`POST /api/voice-studio/synth/save-as-ref`** with non-template profile + emotion → 200 OK. 그 직후 `GET /api/tts/profiles` 응답의 해당 프로필 `has_refs`에 emotion=true.
5. **`POST /api/voice-studio/synth/history/{id}/replay`** — 같은 seed로 동일 byte-length WAV 응답.
6. **`DELETE /api/voice-studio/synth/history/{id}`** — 204/200, audio 파일 unlink.
7. **회귀**: 기존 `/api/tts/*` + `/tts-voice` 페이지 정상.
8. **컨테이너 재기동 (`docker compose restart backend`)** — history 영속 (named volume 효과 확인). 사용자가 직접 한 번 확인.

---

## 5. 리스크

| 리스크 | 완화 |
|---|---|
| `/data/voice_studio` 디렉토리가 첫 배포에 없음 | `HistoryStore.__init__`에서 `os.makedirs(..., exist_ok=True)` |
| named volume이 추가되지 않은 채 backend 만 재기동 시 데이터 손실 | docker-compose 3 파일 모두 같은 PR로 변경 + 사용자 안내 |
| history insert 실패가 합성 응답을 막음 | try/except + logger.warning, 응답은 그대로 |
| 같은 history id로 동시 save-as-ref 두 번 | `_atomic_write_json` 사용 (기존 패턴) |
| 큰 wav (60s @ 24k mono int16 ≈ 2.9MB) × 20개 = 60MB | 충분히 작음. cap 20개 영구 정책. |
| save-as-ref가 template profile → 403 | tts_controller `_guard_template` 패턴 재사용 |
| replay에서 OmniVoice 다운 → 502 | synthesis_preview 와 같은 처리 |
| frontend SSR + Date 포맷 | client-only 컴포넌트, `'use client'` 보장 |
| HistoryPanel 너무 큼 | 한 번에 최대 20개 + 카드 그리드 정렬 |

---

## 6. PR 정보

- 브랜치: `feature/voice-studio-phase2b`
- 제목: `feat(voice-studio): synthesis history + save-as-ref`
- 본문 요지:
  - 합성 결과 영속 히스토리 + replay + save-as-ref.
  - `/data/voice_studio` named volume + env var.
  - 기존 `/api/tts/*` + omnivoice 무변경.

---

## 7. 다음 단계

PR 2B 머지 + 배포 → Phase 3 (엔진 메타데이터 + Settings + Compatibility Matrix).
