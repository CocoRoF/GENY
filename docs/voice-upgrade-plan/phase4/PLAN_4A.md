# Phase 4 — PR 4A: Batch 합성 PLAN

> Voice Studio의 `/voice-studio/batch` placeholder를 본격 페이지로 채운다.
>
> 1. **CSV / JSON / TXT 업로드 또는 paste** — 라인 단위 합성 요청.
> 2. **Background asyncio job** — omnivoice의 내부 Semaphore에 맡기고 순차 호출.
> 3. **진행률 SSE** — 백엔드 in-memory pub/sub → 프론트 EventSource.
> 4. **결과 zip 다운로드** — `{seq}.wav` + `manifest.json`.
>
> Backend 변경: 신규 service 3개 + controller 2개. 기존 `/api/tts/*` 동결.
> Frontend: page + 2 컴포넌트 + voiceStudioApi 확장 + events 클라이언트.
> 사용자 메모리 `feedback_sudo_compose_home_pitfall.md` 준수 — 저장은
> `/data/voice_studio/batch_jobs/`, 기존 named volume에 piggyback.

---

## 0. 스코프 요약

### 포함 (PR 4A)
- **Backend**:
  - `service/voice_studio/event_bus.py` — in-memory pub/sub (asyncio Queue per subscriber).
  - `service/voice_studio/batch_store.py` — SQLite `batch_jobs` 테이블 + `batch_jobs/{id}/` 파일 디렉토리.
  - `service/voice_studio/batch_runner.py` — per-job background asyncio Task, omnivoice 직접 호출, line-by-line progress emit.
  - `controller/voice_studio/batch.py` — `POST /batch`, `GET /batch/{id}`, `POST /batch/{id}/cancel`, `GET /batch/{id}/download`, `GET /batch` (list).
  - `controller/voice_studio/events.py` — `GET /events` SSE.
- **Frontend**:
  - `lib/voiceStudioApi.ts` — `startBatch` / `getBatch` / `listBatches` / `cancelBatch` / `getBatchDownloadUrl`.
  - `lib/voiceStudioEvents.ts` — `subscribeEvents()` thin EventSource wrapper.
  - `components/voice-studio/BatchUploader.tsx` — CSV/JSON/TXT 업로드 + textarea paste + defaults preview + Start.
  - `components/voice-studio/BatchJobRow.tsx` — 진행률 bar + 상태 라벨 + cancel + download.
  - `app/voice-studio/batch/page.tsx` — 본격 페이지.
- **i18n** — `voiceStudio.batch.*` ko/en.

### 제외
- Tools 페이지 — PR 4B로 분리.
- Replay batch / re-run from history — 후순위.
- Per-line override (감정/seed 라인마다 다르게) — Tier 1에서는 단순화: 모든 라인이 같은 defaults(profile/emotion/lang) 사용. CSV column으로 override 들어오면 사용. JSON은 자유 형식 (`{text, emotion?, profile?, seed?}`).

### 호환 보장
- `/api/tts/*` 시그너처 동결.
- omnivoice 마이크로서비스 무변경 — 기존 `synthesize_preview` 그대로 line 단위 호출.
- 기존 `/data/voice_studio` named volume 재활용 (배포 시점에 docker-compose 변경 없음).
- history insert는 batch path 에서는 **하지 않음** — 200 라인 batch가 history(cap 20)를 도배하는 걸 방지.

---

## 1. Backend 변경 명세

### 1.1 `service/voice_studio/event_bus.py` (신규)

```python
class EventBus:
    """Tiny in-memory pub/sub for SSE.

    Single-process only (Geny prod runs a single backend container).
    If we later scale horizontally this needs Redis pub/sub or similar.
    """
    def __init__(self): ...
    def subscribe(self) -> asyncio.Queue: ...
    def unsubscribe(self, q): ...
    async def publish(self, kind: str, payload: dict): ...

def get_event_bus() -> EventBus: ...  # singleton
```

이벤트 shape: `{"kind": "batch.progress", "payload": {...}}`. SSE 라인:
```
event: message
data: {"kind": "batch.progress", "payload": {...}}\n\n
```

### 1.2 `service/voice_studio/batch_store.py` (신규)

SQLite at `<data_dir>/batch.sqlite3`, audio dir `<data_dir>/batch_jobs/`.

Schema:
```sql
CREATE TABLE batch_jobs (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    state TEXT NOT NULL,           -- queued / running / done / cancelled / failed
    total_lines INTEGER NOT NULL,
    completed_lines INTEGER NOT NULL DEFAULT 0,
    error_lines INTEGER NOT NULL DEFAULT 0,
    defaults_json TEXT NOT NULL,   -- shared PreviewParams (profile/emotion/lang/...)
    lines_json TEXT NOT NULL,      -- list of {text, ...overrides}
    zip_path TEXT,                 -- set when done
    log_text TEXT,                 -- accumulated error/info log
    label TEXT                     -- user-supplied (filename or "paste-2026-…")
);
```

API:
```python
class BatchStore:
    def insert(self, *, defaults: dict, lines: list[dict], label: str) -> str: ...
    def get(self, id: str) -> dict | None: ...
    def list_recent(self, limit: int = 20) -> list[dict]: ...
    def mark_running(self, id: str): ...
    def update_progress(self, id: str, completed: int, errors: int): ...
    def append_log(self, id: str, line: str): ...
    def mark_done(self, id: str, zip_path: str): ...
    def mark_cancelled(self, id: str): ...
    def mark_failed(self, id: str, reason: str): ...
    def line_audio_path(self, id: str, seq: int) -> Path: ...
    def job_dir(self, id: str) -> Path: ...
```

### 1.3 `service/voice_studio/batch_runner.py` (신규)

```python
class BatchRunner:
    """Per-job asyncio.Task pool.

    Jobs run sequentially line-by-line via OmniVoiceEngine.synthesize_preview;
    omnivoice's own Semaphore (OMNIVOICE_MAX_CONCURRENCY) handles GPU
    serialization. After all lines, zips the wavs + manifest.
    """
    def __init__(self): ...
    def start_job(self, job_id: str) -> None: ...      # spawns task
    async def cancel(self, job_id: str) -> bool: ...
    def is_running(self, job_id: str) -> bool: ...
```

Per-line flow:
1. Compose `PreviewParams` from defaults + line overrides.
2. Skip line if `text` is empty.
3. `await omnivoice.synthesize_preview(params)` — drop history insert (set a flag on PreviewResult? simpler: just don't write to history_store from this path).
4. Write `<job_dir>/{seq:04d}.wav`.
5. Update `completed_lines` + `event_bus.publish("batch.progress", {...})`.
6. On per-line exception: `error_lines++` + append to log + continue.

After loop:
- Compose `manifest.json` (defaults, lines, per-line state).
- Zip into `<job_dir>/result.zip`.
- `store.mark_done(...)`.
- `event_bus.publish("batch.done", {id})`.

Cancel: set a flag on the job (`_cancel_flags[job_id] = True`); the runner checks between lines and breaks out. Mark `cancelled` + still produce a partial zip with whatever lines are done.

### 1.4 `controller/voice_studio/batch.py` (신규)

```python
class BatchLineRequest(BaseModel):
    text: str
    profile: str | None = None
    emotion: str | None = None
    seed: int | None = None
    # ... 다른 PreviewParams 필드는 옵션 (override)

class BatchStartRequest(BaseModel):
    label: str | None = None
    # shared defaults (PreviewParams subset)
    profile: str | None = None
    emotion: str | None = "neutral"
    mode: Literal["clone","design","auto"] = "clone"
    language: str | None = None
    instruct: str | None = None
    num_step: int | None = None
    guidance_scale: float | None = None
    speed: float | None = None
    audio_format: Literal["wav","mp3","ogg","pcm"] = "wav"
    sample_rate: int | None = None
    lines: list[BatchLineRequest]

@router.post("/batch")
async def start_batch(body: BatchStartRequest) -> dict: ...

@router.get("/batch")
async def list_batches() -> dict: ...

@router.get("/batch/{job_id}")
async def get_batch(job_id: str) -> dict: ...

@router.post("/batch/{job_id}/cancel")
async def cancel_batch(job_id: str) -> dict: ...

@router.get("/batch/{job_id}/download")
async def download_batch(job_id: str) -> FileResponse: ...
```

`POST /batch`:
- Validate `len(lines) >= 1` and `len(lines) <= 500` (디스크 보호).
- `store.insert(...)` → returns job_id.
- `batch_runner.start_job(job_id)`.
- Return `{job_id, state: "queued"}`.

### 1.5 `controller/voice_studio/events.py` (신규)

```python
@router.get("/events")
async def stream_events(request: Request) -> StreamingResponse:
    bus = get_event_bus()
    q = bus.subscribe()
    async def gen():
        try:
            # initial hello
            yield 'event: hello\ndata: {"ok":true}\n\n'
            while True:
                if await request.is_disconnected():
                    break
                try:
                    item = await asyncio.wait_for(q.get(), timeout=15.0)
                    yield f"event: message\ndata: {json.dumps(item)}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            bus.unsubscribe(q)
    return StreamingResponse(gen(), media_type="text/event-stream")
```

### 1.6 `controller/voice_studio/__init__.py` 수정

```python
from .batch import router as _batch_router
from .events import router as _events_router
router.include_router(_batch_router)
router.include_router(_events_router)
```

---

## 2. Frontend 변경 명세

### 2.1 `lib/voiceStudioEvents.ts` (신규)

```typescript
export type StudioEvent = { kind: string; payload: Record<string, unknown> };

export function subscribeEvents(handler: (e: StudioEvent) => void, opts?: { signal?: AbortSignal }): () => void {
  const es = new EventSource('/api/voice-studio/events');
  es.addEventListener('message', (ev) => {
    try {
      const data = JSON.parse(ev.data);
      handler(data);
    } catch {
      // ignore non-JSON keepalives
    }
  });
  opts?.signal?.addEventListener('abort', () => es.close());
  return () => es.close();
}
```

### 2.2 `voiceStudioApi.ts` 확장

```typescript
export interface BatchLine {
  text: string;
  profile?: string;
  emotion?: string;
  seed?: number;
  instruct?: string;
  language?: string;
}

export interface BatchStartParams {
  label?: string;
  // shared defaults
  profile?: string;
  emotion?: string;
  mode?: PreviewMode;
  language?: string;
  instruct?: string;
  num_step?: number;
  guidance_scale?: number;
  speed?: number;
  audio_format?: PreviewAudioFormat;
  sample_rate?: number;
  lines: BatchLine[];
}

export interface BatchJob {
  id: string;
  state: 'queued' | 'running' | 'done' | 'cancelled' | 'failed';
  created_at: string;
  started_at?: string;
  finished_at?: string;
  total_lines: number;
  completed_lines: number;
  error_lines: number;
  label?: string;
  log_text?: string;
  has_zip?: boolean;
}

export const voiceStudioApi = {
  // ...
  async startBatch(body: BatchStartParams): Promise<{ job_id: string; state: string }> { ... },
  async listBatches(): Promise<BatchJob[]> { ... },
  async getBatch(id: string): Promise<BatchJob> { ... },
  async cancelBatch(id: string): Promise<{ ok: true }> { ... },
  getBatchDownloadUrl(id: string): string { return `/api/voice-studio/batch/${encodeURIComponent(id)}/download`; },
};
```

### 2.3 `BatchUploader.tsx` (신규)

```
┌──────────────────────────────────────────────────────────────────┐
│  ⬆ Upload file [CSV / JSON / TXT]    or paste below:             │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │ 안녕하세요.                                                    │    │
│  │ 오늘 날씨가 좋네요.                                              │    │
│  │ ...                                                       │    │
│  └──────────────────────────────────────────────────────────┘    │
│  Detected: 24 lines · TXT mode                                   │
│                                                                  │
│  Shared defaults:                                                │
│  Profile [paimon_ko ▼]  Emotion [neutral ▼]  Lang [auto ▼]       │
│  ▾ Advanced (num_step / guidance / speed / audio_format)         │
│                                                                  │
│  [▶ Start Batch]                                                 │
└──────────────────────────────────────────────────────────────────┘
```

Parse logic:
- File input or textarea drives `raw: string`.
- Mode auto-detect by extension or `[`/`{` first non-whitespace char:
  - JSON: must be array of `{text, ...}` objects.
  - CSV: header row optional; columns `text,emotion,profile,seed,...`.
  - TXT (default): one line = one synthesis (uses defaults).
- Show count + "first 3 lines preview" + error if shape wrong.

### 2.4 `BatchJobRow.tsx` (신규)

```
┌──────────────────────────────────────────────────────────────────┐
│ episode_01.csv  ████████░░ 80% (96/120 · 4 errors)               │
│ started 2m ago · ETA ~25s                                        │
│                                       [▶ Pause] [⬇ zip] [✕]      │
└──────────────────────────────────────────────────────────────────┘
```

State-driven actions:
- `queued` / `running` → Cancel button.
- `done` / `cancelled` → Download zip (if `has_zip`).
- `failed` → log expand.

### 2.5 `app/voice-studio/batch/page.tsx`

```tsx
export default function BatchPage() {
  // load profiles for the Uploader's profile dropdown
  // SSE subscribe → refresh jobs list on batch.* events
  return (
    <div className="max-w-5xl mx-auto px-6 py-6 space-y-5">
      <BatchUploader onStarted={(jobId) => refresh()} />
      <section>
        <h2>Active / recent jobs</h2>
        {jobs.map(j => <BatchJobRow key={j.id} job={j} onChanged={refresh} />)}
      </section>
    </div>
  );
}
```

### 2.6 i18n 신규 키 (ko/en)

`voiceStudio.batch.*`:
- `title`, `uploadCsv`, `pasteHint`, `detectedLines`, `firstLines`
- `sharedDefaults`, `profile`, `emotion`, `language`
- `start`, `starting`, `cancel`, `download`, `confirmCancel`
- `state.{queued,running,done,cancelled,failed}`
- `progress`, `errors`, `eta`, `noJobs`
- `errors.{emptyLines, badJson, badCsv, tooMany}`

---

## 3. 작업 순서

1. branch
2. backend (event_bus → batch_store → batch_runner → batch controller → events controller → __init__ register)
3. py_compile 통과
4. frontend (voiceStudioEvents → voiceStudioApi → BatchUploader → BatchJobRow → page)
5. i18n
6. `npm run build` 통과
7. commit + PR + 머지 + 배포 + 검증

---

## 4. 검증

- `POST /api/voice-studio/batch` `{"lines":[{"text":"안녕"},{"text":"좋네요"}], "profile":"ellen_joe", "emotion":"neutral", "mode":"clone", "num_step":8}` → 201/200, `{"job_id":"..."}`
- `GET /api/voice-studio/batch/{id}` → state queued/running/done, completed_lines 증가
- `GET /api/voice-studio/events` (EventSource) → `batch.progress` / `batch.done` 이벤트 수신
- `GET /api/voice-studio/batch/{id}/download` → zip 파일 (manifest.json + 0001.wav, 0002.wav, ...)
- `POST /api/voice-studio/batch/{id}/cancel` → state=cancelled, 부분 zip 제공
- 회귀: 기존 `/api/tts/*` 그대로

---

## 5. 리스크

| 리스크 | 완화 |
|---|---|
| 500라인 batch가 omnivoice 부하 | hard limit 500 + 사용자 안내 |
| Job이 SQLite 갱신 직전에 backend crash | mark_running 즉시 + atomic commits |
| SSE 클라이언트가 keepalive 안 받으면 reconnect 필요 | timeout 15s + ":keepalive" 라인 |
| EventBus가 다중 backend container 환경에서 동기화 안 됨 | 단일 컨테이너 가정 (현 prod 구성). README에 명시. |
| Cancel 후에도 in-flight omnivoice 호출은 즉시 중단 안 됨 | 다음 line 시작 전 cancel flag 체크. 현재 line 1개는 끝나길 기다림. |
| zip 파일이 디스크 차지 | 30일 자동 정리 (cron 같은 거 — 현재는 안 함; 사용자가 수동 정리) |
| SSE를 통한 보안 정보 누출 | payload는 진행률 + state만; 텍스트 본문은 emit 안 함 |

---

## 6. PR 정보

- 브랜치: `feature/voice-studio-phase4a`
- 제목: `feat(voice-studio): batch synthesis (CSV/JSON/TXT → zip)`
- 본문: 위 요약 + test plan

---

## 7. 다음 단계

PR 4A 머지 → 서버 배포 → Phase 4B (Tools 페이지).
