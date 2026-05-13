# 02 — Phased plan: 4 PRs

> *01 의 design 을 4 개 작은 PR (W1 ~ W4) 로. 각 PR 독립 배포 가능 — 이전 phase 에 의존하지 않는다 (서비스 다운돼도 audio 캡처는 됨).*

작성: **2026-05-13**
선행: [01_DESIGN.md](01_DESIGN.md)

---

## Phase 표

| Phase | 한 줄 | 사용자 가치 | 규모 |
|---|---|---|---|
| **W1** | Whisper STT 컨테이너 + backend client + config | (인프라) — `whisper_client.transcribe()` 호출 가능 | 1일 |
| **W2** | `audio` PostCaptureHook → 자동 전사 → 노트 body prepend | 사용자가 audio 파일 drop → 노트에 transcript 자동 | 0.5일 |
| **W3** | `microphone_record` capture source + 녹음 modal UI | 인박스 toolbar 클릭 → 녹음 → 자동 전사 노트 | 1일 |
| **W4** | `whiteboard_transcribe` 도구 + `whiteboard-voice-notes` skill | VTuber 가 음성 노트를 인지하고 자연스럽게 화제로 | 0.5일 |

각 phase = 1 PR. 총 4 PR.

---

## W1 — Whisper STT 컨테이너 + backend client

### 목표
backend 코드가 `await client.transcribe(audio_bytes)` 호출하면 vLLM Whisper 가 텍스트 반환. 화이트보드 연동은 다음 phase.

### 작업

**W1.1 — Docker service**
- `whisper-stt/Dockerfile` (신규)
- `whisper-stt/entrypoint.sh` (신규)
- `docker-compose.prod.yml` + `docker-compose.dev.yml` 양쪽에 `whisper-stt` service 추가
- `--profile audio-local` 게이트
- `geny-whisper-cache-prod` / `-dev` volume

**W1.2 — Backend config**
- `backend/service/config/sub_config/stt/__init__.py`
- `backend/service/config/sub_config/stt/whisper_config.py`
- `WhisperConfig.api_url` default `http://whisper-stt:8001`
- env override: `WHISPER_API_URL`, `WHISPER_ENABLED`, `WHISPER_LANGUAGE`
- 기존 config manager (`get_config_manager().load_config(WhisperConfig)`) 통해 로드

**W1.3 — Backend client**
- `backend/service/stt/__init__.py`
- `backend/service/stt/whisper_client.py`
  - `WhisperClient` class — persistent `httpx.AsyncClient`
  - `transcribe(audio_bytes, *, filename, language=None) -> TranscriptionResult`
  - `TranscriptionResult` dataclass
  - module-level `get_whisper_client()` singleton (config 변경시 무효화 지원)
  - **best-effort**: timeout / connect-failure / 5xx 모두 `TranscriptionResult(text="", source="unavailable", error=...)` 반환 (never raise)

**W1.4 — 진단용 controller endpoint**
- `POST /api/stt/transcribe` (auth required) — UploadFile + optional language → TranscriptionResult JSON
- 용도: 디버깅, OpsAdmin 페이지의 STT 상태 확인. *프론트 사용자는 직접 안 부름* (audio 캡처 경로가 더 자연스러움).

**W1.5 — 테스트**
- `tests/service/stt/test_whisper_client.py`:
  - `httpx.AsyncClient` mock (`pytest-httpx` 또는 `respx`)
  - 정상 응답 → text 추출
  - timeout → `text=""`, `source="unavailable"`
  - 5xx → 동일
  - language 강제 → multipart form 에 들어가는지
- AST validate + lint

### Definition of Done
- [ ] 서버에서 `--profile audio-local` 로 띄우면 `whisper-stt` 컨테이너 healthy
- [ ] backend 의 `curl POST /api/stt/transcribe` with sample audio → 정상 텍스트 받음
- [ ] STT 컨테이너 끄고 같은 endpoint 호출 → 200 + `{"text":"", "source":"unavailable", "error":"..."}` (5xx 안 됨)
- [ ] 단위 테스트 통과

### 위험
- vLLM 0.7.3 의 transcription API spec 이 OpenAI 호환이라고 했지만 multipart field 명에 미세 차이 가능 — client 가 사용하는 form key (`file`, `model`, `language`, `response_format`) 가 vLLM 0.7.3 docs 와 정확히 매치되는지 첫 부팅 후 검증
- 모델 다운로드 ~3GB — 첫 부팅이 길어짐. healthcheck `start_period: 120s` 로 보호
- GPU memory util 0.45 가 OmniVoice 와 충돌 가능 — env 로 조정 가능하지만 환경 별 튜닝 필요

---

## W2 — `audio` PostCaptureHook 자동 전사

### 목표
사용자가 audio 파일을 inbox 에 drop 하거나 (W1 의) `POST /captures/upload` 로 `type=audio` 보내면 → backend 가 자동으로 Whisper 호출 → 결과 transcript 가 inbox draft note 의 body 맨 위에 quote block 으로 prepend.

### 작업

**W2.1 — Hook 등록**
- `backend/service/whiteboard/post_capture_hook.py` 의 `register_default_hooks()` 에 `register_post_capture_hook("audio", _transcribe_audio_hook)` 추가
- `_transcribe_audio_hook(event, draft_note_filename)` 함수 본체

**W2.2 — body prepend 로직**
- 노트 read → existing body → quote block prepend → update
- Idempotent: 같은 transcript 가 이미 body 에 있으면 다시 안 붙임
- Quote format: `> **Transcript (ko):** {text}`

**W2.3 — 캡처 audit log 에 transcript meta 저장**
- `_captures.jsonl` 의 entry 에 `transcript_status: "ok" | "unavailable" | "skipped"` 필드 추가
- frontend Inbox 카드 가 그것을 보고 "🎙️ Transcribed" 배지 (선택적, polish)

**W2.4 — 테스트**
- mock whisper client → 다양한 응답에서 hook 의 body 변형 검증
- 빈 transcript 일 때 노트 body 안 건드림
- attachment 누락 시 noop

### Definition of Done
- [ ] `curl POST /api/opsidian/captures/upload -F file=@voice.webm -F type=audio` → 인박스 노트 생성 + 5초 안에 body 에 transcript prepend
- [ ] Whisper 다운 상태 → 캡처 자체는 성공, body 는 transcript 없이 attachment 만
- [ ] 같은 파일 두 번 upload → 두 노트 각각 transcript (idempotent 는 *같은 노트* 에 대한 두 번 hook 호출에서만 의미)

### 위험
- Hook 이 fire-and-forget — sync upload response 후 비동기 실행. 사용자가 카드 클릭하기 전에 transcript 가 안 도착할 수 있음 → inbox 자동 reload 가 필요 (이미 InboxPanel 이 `refreshTick` 으로 지원)
- 긴 오디오 (30분+) 시 hook 이 오래 걸림 — `_task_tracker` 가 보호하지만 사용자 인지 X. 진행률 표시는 후속

---

## W3 — `microphone_record` capture source + 녹음 modal

### 목표
사용자가 인박스의 **Voice** 버튼 클릭 → 녹음 modal → Stop → 자동 업로드 → W2 의 자동 전사 → 노트.

### 작업

**W3.1 — frontend capture source**
- `frontend/src/lib/captureSources.ts` 의 `registerBuiltinCaptureSources()` 에 `microphone_record` 추가
- `isAvailable`: `navigator.mediaDevices.getUserMedia` + `window.MediaRecorder` 존재 체크
- `run()` 가 modal 띄우고 → MediaRecorder 로 녹음 → blob → `uploadCaptureFile(type="audio", source="microphone_record")`

**W3.2 — 녹음 modal 컴포넌트**
- `frontend/src/components/user-opsidian/VoiceRecorderModal.tsx` (신규)
- Mic 권한 요청 → 거부 시 친절한 에러
- 녹음 중 elapsed 타이머 (00:05 같은 카운터)
- Stop / Cancel 버튼
- 녹음 끝 → blob 반환 → 모달 닫힘
- waveform 시각화는 옵션 (Phase 후속 — 일단 카운터만)

**W3.3 — CaptureToolbar 통합**
- `inline` mode toolbar (인박스 헤더) 에 자동 표시 — registry 기반이라 따로 작업 없음
- 단, `microphone_record` 의 `run()` 이 modal 띄우므로 toolbar 의 `running` 상태가 modal lifetime 동안 잠금

**W3.4 — 테스트**
- Storybook 류는 없으므로 build smoke test 만
- 수동 검증: 권한 거부 → 에러 toast / 녹음 후 카드 / 5초 안에 transcript

### Definition of Done
- [ ] Inbox toolbar 에 **Voice** 버튼 표시 (지원 브라우저에서)
- [ ] 클릭 → mic 권한 → 녹음 modal → Stop → 카드 즉시 등장
- [ ] 카드 클릭 → 노트 viewer → audio player + transcript quote
- [ ] HTTPS / localhost 가 아닌 경우 `isAvailable=false` 로 버튼 hide

### 위험
- iOS Safari 의 `MediaRecorder` 는 `audio/webm` 안 지원, `audio/mp4` 필요 — `MediaRecorder.isTypeSupported('audio/webm')` 체크 후 mime type 선택
- 권한 거부 후 재시도 시 브라우저 UX 가 변경 — 안내 메시지

---

## W4 — Agent 도구 + skill

### 목표
VTuber 가 인박스에 새 audio 노트가 떨어지면 (e.g. SpotlightContextBlock 또는 사용자가 직접 share) 자연스럽게 transcript 를 인지하고 화제로 꺼냄. 필요 시 다른 언어로 재전사.

### 작업

**W4.1 — `whiteboard_transcribe` 도구**
- `backend/tools/custom/whiteboard_tools.py` 의 `TOOLS` 에 추가
- input: `capture_id` 또는 `attachment_path`, optional `language`
- output: `{text, language, source}`
- 사용 시점: 자동 hook 의 transcript 가 불만족 (오언어 detection / 짧은 audio 등) — agent 가 명시 재호출

**W4.2 — `whiteboard-voice-notes` skill**
- `backend/skills/bundled/whiteboard_voice_notes/SKILL.md`
- name: `whiteboard-voice-notes`
- allowed_tools: `whiteboard_transcribe`, `opsidian_read`
- VTuber 전용 (`_SKILL_ROLE_RESTRICTIONS`)
- body: "사용자가 음성 노트를 공유했을 때 → 본문의 `> **Transcript:** ...` quote 부터 읽고 자연스럽게 반응. 언어 잘못 잡혔으면 `whiteboard_transcribe(capture_id=..., language="ko")` 로 재전사."

**W4.3 — `whiteboard-search` skill 미세 업데이트** (옵션)
- voice 노트는 inbox 카테고리 + transcript 가 body 의 quote block — `opsidian_search` 가 자연스럽게 매치
- 추가 작업 없을 수도 — 검증만

### Definition of Done
- [ ] VTuber agent 에 `skill__whiteboard-voice-notes` 도구 보임
- [ ] 사용자가 voice spotlight → VTuber 가 transcript 기반으로 응답
- [ ] 사용자가 "이거 한국어로 다시 들어줘" → agent 가 `whiteboard_transcribe(language="ko")` 호출

### 위험
- skill body 가 W1 ~ W3 가 머지된 후에만 의미 있음 — 마지막 phase
- VTuber 가 transcript 가 부정확할 때 over-correct 가능 — skill 의 "절제" guideline 으로 보호

---

## 통합 검증 (모든 phase 완료 후)

서버에서:

```bash
cd /home/hrjang/docker_web/Geny
git pull origin main
sudo docker compose -f docker-compose.prod.yml \
    --profile audio-local \
    up -d --build

# 컨테이너 healthy 확인
docker compose ps | grep whisper-stt
# → status: healthy

# backend 가 whisper 접근 가능
docker compose exec backend curl -fsS http://whisper-stt:8001/health
# → 200 OK

# end-to-end: 샘플 wav 전사
docker compose exec backend python -c "
import asyncio
from service.stt.whisper_client import get_whisper_client
async def main():
    with open('/tmp/sample.wav', 'rb') as f:
        result = await get_whisper_client().transcribe(f.read())
    print(result)
asyncio.run(main())
"
```

프론트에서:
- HTTPS / localhost 환경에서 Inbox toolbar → **Voice** 버튼 → 5초 녹음 → 카드 등장
- 카드 클릭 → 노트에 audio player + `> **Transcript (ko):** ...` quote
- VTuber 에게 노트 spotlight → agent 가 transcript 기반으로 반응

---

## 작업 순서 (사용자가 명시한 흐름)

각 phase 마다:

1. **로컬** (현재 working dir):
   - branch 생성
   - 코드 작성
   - `pytest tests/service/stt -q` + `npm run build` 로 검증
   - PR 생성 + merge
2. **서버** (2222, /home/hrjang/docker_web/Geny):
   - `git pull origin main`
   - W1 이 머지된 후 처음으로 `--profile audio-local` 추가하여 컨테이너 띄움
   - 그 다음부터는 일반 `--build` 만 (whisper image 캐시됨)

총 4 PR. 한 phase 마다 사용자가 서버에서 동작 확인 후 다음 phase 머지 가능 (안전).

---

## 비목표 / 후속

- 실시간 streaming 전사 (websocket)
- 화자 분리 (multi-speaker)
- 노이즈 제거 / 음성 향상
- 자동 sentence boundary 기반 chunking (Whisper 가 내부 처리하지만 30초 cap)
- Voice 카테고리 별도 분리 (현재는 inbox/ 통합)

위 기능들은 후속 사이클에서 동일 후크 위에 추가 가능 — 본 plan 의 코드 변경 없이.
