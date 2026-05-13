# 01 — Design: Whisper STT 서비스 + 화이트보드 통합

> *컨테이너 / API 계약 / 후크 통합점을 코드 레벨로 구체화. 기존 화이트보드 인프라 위에 *얹는* 설계만 — 코어 변경 없음.*

작성: **2026-05-13**
선행: [README.md](README.md)

---

## 0. 디자인 원칙

1. **OmniVoice 패턴 미러** — 컨테이너 구조 / 백엔드 client / config 는 이미 검증된 OmniVoice TTS 패턴을 그대로 따른다.
2. **화이트보드 후크 재사용** — `CaptureType="audio"` + `register_post_capture_hook("audio", ...)` 가 이미 P0/P4 에 비어있음. 거기 끼우면 자동 전사가 inbox 흐름에 들어옴.
3. **부분 실패 허용** — Whisper 컨테이너가 다운돼도 audio 캡처 자체는 성공 (전사만 누락). 사용자가 STT 없이도 raw audio 노트 보유.
4. **GPU 1장 가정** — OmniVoice 와 같은 슬롯. 동시 사용 시 우선순위는 OS 가 scheduling. 미래에 vLLM 의 멀티 모델 서빙으로 묶을 수 있지만 일단 분리.

---

## 1. 컨테이너 — `whisper-stt` service

### 1.1 Dockerfile

`whisper-stt/Dockerfile` (신규):

```dockerfile
FROM nvidia/cuda:12.4.1-runtime-ubuntu22.04

RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 python3-pip python3-venv git ffmpeg curl \
    && rm -rf /var/lib/apt/lists/*

ENV PATH=/opt/venv/bin:$PATH
RUN python3 -m venv /opt/venv

# vLLM 0.7.3 (whisper 안정 지원 첫 버전) + audio 의존성.
# vLLM 이 자체적으로 transformers / torch / triton 등을 끌어옴.
RUN pip install --no-cache-dir \
        vllm==0.7.3 \
        librosa==0.10.2.post1 \
        soundfile==0.12.1

# 모델은 첫 부팅 시 HuggingFace 에서 lazy download. 캐시는
# /root/.cache/huggingface 에 떨어지고 docker volume 으로 보존.
ENV HUGGINGFACE_HUB_CACHE=/cache/huggingface
RUN mkdir -p /cache/huggingface

WORKDIR /app
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

EXPOSE 8001

HEALTHCHECK --interval=30s --timeout=10s --retries=5 --start-period=120s \
    CMD curl -fsS http://localhost:8001/health || exit 1

ENTRYPOINT ["/app/entrypoint.sh"]
```

### 1.2 entrypoint.sh

vLLM 의 OpenAI 호환 transcription 서버를 띄움 (`vllm serve` 가 자동으로 `/v1/audio/transcriptions` endpoint 노출 — Whisper 모델에 대해서만 활성).

```bash
#!/usr/bin/env bash
set -euo pipefail

MODEL="${WHISPER_MODEL:-openai/whisper-large-v3}"
PORT="${WHISPER_PORT:-8001}"
GPU_MEM_FRACTION="${WHISPER_GPU_MEM:-0.45}"  # OmniVoice 와 공유 GPU

exec python -m vllm.entrypoints.openai.api_server \
    --model "$MODEL" \
    --port "$PORT" \
    --host 0.0.0.0 \
    --task transcription \
    --gpu-memory-utilization "$GPU_MEM_FRACTION" \
    --max-model-len 448 \
    --dtype auto
```

- `gpu-memory-utilization 0.45` — OmniVoice 와 같은 GPU 위에서 충돌 안 나도록 절반 미만으로 보수적 할당. 환경 변수로 override 가능.
- `--task transcription` 이 vLLM 의 Whisper 전용 path 를 활성화 (멀티모달 path 와 다름).
- `--max-model-len 448` — Whisper 의 30s 청크 token cap.

### 1.3 docker-compose 추가

`docker-compose.prod.yml` (그리고 `dev.yml` 양쪽):

```yaml
services:
  whisper-stt:
    build:
      context: ./whisper-stt
      dockerfile: Dockerfile
    image: geny-whisper-stt:latest
    container_name: geny-whisper-stt-prod
    profiles: ["stt-local"]
    networks:
      - geny-net-prod
    environment:
      - WHISPER_MODEL=openai/whisper-large-v3
      - WHISPER_PORT=8001
      - WHISPER_GPU_MEM=0.45
      - HUGGINGFACE_HUB_TOKEN=${HUGGINGFACE_HUB_TOKEN:-}
    volumes:
      - geny-whisper-cache-prod:/cache/huggingface
    expose:
      - "8001"
    restart: unless-stopped
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://localhost:8001/health"]
      interval: 30s
      timeout: 10s
      retries: 5
      start_period: 120s  # 모델 로드 ~1분

volumes:
  geny-whisper-cache-prod:
```

### 1.4 nginx

**불필요**. backend 만 whisper 와 통신 (Docker DNS `whisper-stt:8001`). 외부 노출 안 함 — 첨부 전사는 backend 가 proxying. 보안 측면에서도 추가 표면이 안 늘어남.

---

## 2. Backend — STT client + config

### 2.1 신규 config 모듈

`backend/service/config/sub_config/stt/whisper_config.py`:

```python
from pydantic import BaseModel, Field
from service.config.sub_config.base import BaseConfig

class WhisperConfig(BaseConfig):
    """Whisper STT (vLLM) configuration. Mirrors OmniVoiceConfig."""

    api_url: str = Field(
        "http://whisper-stt:8001",
        description="Internal Docker DNS for the whisper service.",
    )
    enabled: bool = Field(
        True,
        description="When False, all transcription paths short-circuit "
                    "to a placeholder. Useful in CPU-only dev envs.",
    )
    timeout_seconds: float = Field(120.0, ge=10.0, le=600.0)
    language: str = Field(
        "",
        description="Force a specific language code (e.g. 'ko', 'en'). "
                    "Empty = auto-detect (Whisper's default).",
    )
    response_format: str = Field("json", description="json | text | verbose_json")

    _ENV_MAP = {
        "api_url": "WHISPER_API_URL",
        "enabled": "WHISPER_ENABLED",
        "timeout_seconds": "WHISPER_TIMEOUT_SECONDS",
        "language": "WHISPER_LANGUAGE",
    }
```

### 2.2 클라이언트

`backend/service/stt/whisper_client.py`:

```python
class WhisperClient:
    """vLLM Whisper-large-v3 transcription client.

    Mirrors `OmnivoiceEngine` shape — persistent httpx.AsyncClient
    pool, fail-safe (returns empty string on error so callers don't
    crash audio capture).
    """

    async def transcribe(
        self,
        audio_bytes: bytes,
        *,
        filename: str = "audio.webm",
        language: Optional[str] = None,
    ) -> TranscriptionResult: ...

@dataclass
class TranscriptionResult:
    text: str
    language: Optional[str]
    duration_seconds: Optional[float]
    source: Literal["whisper", "unavailable"]
    error: Optional[str] = None
```

호출은 vLLM 의 OpenAI 호환 endpoint `POST /v1/audio/transcriptions` 에 `multipart/form-data` 로 보냄 (vLLM 0.7.3 의 표준 형태).

성공: `{text: "...", language: "ko"}` 반환.
실패: `{text: "", source: "unavailable", error: "..."}` — 절대 raise 안 함.

---

## 3. 화이트보드 통합 — `audio` PostCaptureHook

### 3.1 후크 등록

`backend/service/whiteboard/post_capture_hook.py` 의 `register_default_hooks()`:

```python
def register_default_hooks() -> None:
    register_post_capture_hook("image", _describe_image_hook)
    register_post_capture_hook("screenshot", _describe_image_hook)
    register_post_capture_hook("audio", _transcribe_audio_hook)  # ← W2
```

### 3.2 hook 본체

```python
async def _transcribe_audio_hook(
    event: CaptureEvent, draft_note_filename: str
) -> Optional[Dict[str, Any]]:
    """Transcribe an audio capture via the Whisper STT service and
    prepend the transcript as a quoted block at the top of the draft
    note body. Best-effort — failure leaves the note as-is.
    """
    if not event.payload.attachment_path:
        return None
    try:
        from service.stt.whisper_client import get_whisper_client
        from service.memory.user_opsidian import get_user_opsidian_manager
    except Exception:
        return None

    mgr = get_user_opsidian_manager(event.user_id)
    data = mgr.read_attachment(event.payload.attachment_path)
    if not data:
        return None

    client = get_whisper_client()
    result = await client.transcribe(
        data,
        filename=event.payload.attachment_path,
    )
    if not result.text:
        return result.__dict__

    # Prepend as a quote block (similar to _describe_image_hook).
    note = mgr.read_note(draft_note_filename) or {}
    body = str(note.get("body") or "")
    transcript_block = (
        f"> **Transcript ({result.language or 'auto'}):** "
        f"{result.text}\n\n"
    )
    if transcript_block.strip() not in body:
        mgr.update_note(draft_note_filename, body=transcript_block + body)
    return result.__dict__
```

### 3.3 신규 agent tool

`backend/tools/custom/whiteboard_tools.py` 에 추가:

```python
class WhiteboardTranscribeTool(BaseTool):
    """Re-transcribe an audio attachment on demand.

    Useful when the auto-hook ran but the language was misdetected,
    or when the user wants a longer / different format response.
    """

    name = "whiteboard_transcribe"
    description = (
        "Transcribe an audio attachment from the user's whiteboard. "
        "Pass capture_id OR attachment_path. Optionally force a "
        "language code (e.g. 'ko', 'en'). Returns the transcript "
        "text — call this when the user shares an audio note and you "
        "need to react to its content."
    )

    def run(self, session_id, capture_id="", attachment_path="", language="") -> str:
        ...
```

`whiteboard_search` skill 의 `allowed_tools` 에 추가 — VTuber 가 음성 노트를 검색 후 read 할 때 transcript 가 이미 body 에 있으므로 자연스럽게 인지.

---

## 4. Frontend — 마이크 녹음 capture source

### 4.1 신규 source 등록

`frontend/src/lib/captureSources.ts` 의 `registerBuiltinCaptureSources()` 에 추가:

```typescript
registerCaptureSource({
  id: 'microphone_record',
  label: 'Voice',
  icon: null,
  order: 80,
  isAvailable: () =>
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function' &&
    typeof window.MediaRecorder !== 'undefined',
  run: async (ctx) => grabVoiceRecording(ctx),
});
```

### 4.2 녹음 흐름

```typescript
async function grabVoiceRecording(ctx: CaptureContext) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);

  // 사용자가 stop 버튼 누를 때까지 녹음. UI 측에서 modal 컨트롤.
  recorder.start();
  await waitForUserStop();  // resolve when user clicks stop
  recorder.stop();
  stream.getTracks().forEach((t) => t.stop());

  const blob = new Blob(chunks, { type: 'audio/webm' });
  const file = new File([blob], 'voice.webm', { type: 'audio/webm' });
  return uploadCaptureFile(file, {
    type: 'audio',
    source: 'microphone_record',
    ctx,
  });
}
```

녹음 진행 중 시각화는 별도 작은 컴포넌트 — Inbox toolbar 의 Voice 버튼 클릭 시 modal 띄우고 Stop 버튼 + waveform.

### 4.3 InboxPanel 변화 없음

`CaptureToolbar` 가 이미 registry 기반 — `microphone_record` source 등록만으로 자동 표시.

---

## 5. 에러 / 폴백 시나리오

| 시나리오 | 동작 |
|---|---|
| `whisper-stt` 컨테이너 다운 (`stt-local` profile 안 씀) | `WhisperConfig.enabled=False` 또는 connect 실패 → transcript 빈 문자열, audio 자체는 inbox 에 저장됨 |
| Whisper 가 5초 내 응답 X | timeout 후 빈 transcript. 사용자가 `/whiteboard-transcribe` skill 또는 도구로 재시도 가능 |
| Audio 파일이 손상됨 | Whisper 가 에러 → `error` 필드만 채워서 반환 → hook 이 노트에 transcript 추가 안 함 |
| 마이크 권한 거부 | frontend 가 toast 로 에러 표시. Inbox 카드 생성 X |
| 5분+ 긴 녹음 | Whisper 는 30s 청크 자동 분할 (vLLM 이 내부 처리). 응답에 통합 텍스트 |

---

## 6. 보안 / 권한

- `whisper-stt` 는 외부 노출 X (`expose` only, `ports` 없음).
- backend 만 internal DNS 로 접근.
- audio 파일은 user vault 의 `_attachments/` 에 저장 — 기존 화이트보드 permission 모델 그대로.
- HuggingFace 모델 다운로드는 첫 부팅 시 한 번. private 모델은 아니지만 HF token 환경 변수 옵션 있음.

---

## 7. 비용 추정

| 항목 | 비용 |
|---|---|
| GPU memory | ~3 GB (whisper-large-v3) + 2GB 마진 |
| 30초 오디오 전사 | ~2-4초 (단일 호출, batch 미적용) |
| HuggingFace 다운로드 | 첫 부팅 ~3 GB 다운로드 (volume 에 캐시) |
| Backend 추가 부하 | 무시 가능 — async client pool, hook 은 fire-and-forget |

---

다음 문서: [02_PLAN.md](02_PLAN.md) — W1 ~ W4 phase 실행 계획.
