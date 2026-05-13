# Voice Notes — vLLM Whisper-large-v3 음성 노트

Geny 의 user opsidian / 화이트보드 위에 **음성 녹음 → 자동 전사 → 노트 기록** 흐름을 얹는 기능 묶음.

작성: **2026-05-13**
상태: **계획 (구현 미시작)**
관련 문서: [knowledge-whiteboard/](../knowledge-whiteboard/) (P0~P5 화이트보드 인프라)

---

## 핵심 아이디어 한 페이지

1. **신규 컨테이너 `geny-whisper-stt`** — vLLM 으로 `openai/whisper-large-v3` 서빙. OmniVoice 와 **같은 `--profile audio-local`** 로 묶임 (TTS + STT 동시 활성화). GPU 분할: omnivoice 0.50 + whisper 0.35 = **합 0.85** (RTX 5070 12 GB 의 약 10 GB 사용, 15% 여유).
2. **백엔드 STT client** — 기존 OmniVoice TTS engine 의 패턴을 미러 (`httpx.AsyncClient` 풀, 자체 설정 모듈, fail-safe).
3. **화이트보드 후크 재사용** — P0 의 `CaptureType="audio"` enum + P4 의 `register_post_capture_hook("audio", ...)` 가 이미 비어있는 슬롯 → 거기에 **whisper transcribe hook** 을 끼움.
4. **프론트엔드 캡처 소스 신규** — `microphone_record` (P3 의 `screen_capture` / `clipboard_paste` 와 동일 등록 패턴) — `MediaRecorder` 로 녹음 → `POST /api/opsidian/captures/upload` 그대로 사용.
5. **노트 저장 위치** — 캡처는 `inbox/` 카테고리에 떨어지고 (P0 흐름 그대로), 전사 결과가 노트 본문에 **`> **Transcript:**`** quote 블록으로 prepend. 첨부 `.webm` 도 `_attachments/` 에 그대로 보존되어 audio player 로 재생 가능.
6. **확장 후크 약속** — 이미 docs §11 에서 `audio` 슬롯을 약속한 그대로 — 코어 변경 0, 기존 인프라 위에 한 hook + 한 service 만 추가.

---

## 변경 영향 (요약)

| 영역 | 변경 |
|---|---|
| `docker-compose.{prod,dev,}.yml` | 신규 `whisper-stt` service (profile: `audio-local` — omnivoice 와 동일 profile, GPU reservation) |
| `backend/service/config/sub_config/stt/` | 신규 dir — `whisper_config.py` (api_url default `http://whisper-stt:8001`) |
| `backend/service/stt/whisper_client.py` | 신규 — httpx 비동기 클라이언트 (transcribe → text) |
| `backend/service/whiteboard/post_capture_hook.py` | `register_post_capture_hook("audio", _transcribe_audio_hook)` 한 줄 |
| `backend/tools/custom/whiteboard_tools.py` | `whiteboard_transcribe(capture_id)` 도구 추가 (선택적; agent 가 명시 호출 가능) |
| `frontend/src/lib/captureSources.ts` | `microphone_record` source 등록 (P3 패턴) |
| `nginx/nginx.conf` | (불필요) — backend 만 whisper 와 통신, 외부 노출 X |
| 신규 모듈 합계 | 2 dirs / ~4 신규 파일 / ~250 lines |

핵심 발명품 **0개**. 모두 기존 후크 위에 얹힘.

---

## 문서 인덱스

| 순서 | 문서 | 내용 |
|---|---|---|
| 1 | [01_DESIGN.md](01_DESIGN.md) | 컨테이너 / API 계약 / 후크 통합점 설계 |
| 2 | [02_PLAN.md](02_PLAN.md) | 4 phase 실행 계획 — 각 phase 별 DoD / 위험 / PR 단위 |

---

## Phase 표 (요약)

| Phase | 한 줄 | 사용자 가치 |
|---|---|---|
| **W1** | Whisper STT 컨테이너 + backend client | (인프라) — backend 가 `whisper_client.transcribe(audio_bytes)` 호출 가능 |
| **W2** | `audio` PostCaptureHook 등록 — 캡처 시 자동 전사 → 노트 body 에 prepend | 사용자가 audio 파일 drop → 노트에 transcript 자동 |
| **W3** | 마이크 녹음 capture source (`microphone_record`) | 인박스 toolbar 에서 클릭 → 녹음 → 자동 전사 노트 |
| **W4** | 도구 `whiteboard_transcribe` + skill `whiteboard-voice-notes` | VTuber 가 audio 노트를 인지하고 자연스럽게 화제 꺼냄 |

각 phase = 1 PR. W1 → W2 → W3 → W4 순.

---

## 비목표

- 실시간 streaming 전사 (현재는 batch — 녹음 끝나면 전사)
- TTS 양방향 합치기 (음성 답변은 기존 OmniVoice 가 담당)
- 화자 분리 (single-speaker assumption)
- 다국어 detection 자동화 (whisper-large-v3 가 자동으로 80+ 언어 detect — wrapper 는 그냥 통과시킴)

위 기능들은 후속 사이클에서 동일 후크 위에 추가 가능.

---

## 배포 흐름 (사용자가 명시한 대로)

```
로컬 (현재 working dir):
  로컬에서 모든 코드 작성
  pytest + npm run build 로 검증
  PR 생성 + merge
       ↓
서버 (2222, /home/hrjang/docker_web/Geny):
  git pull origin main
  sudo docker compose -f docker-compose.prod.yml \
       --profile audio-local \
       up -d --build
       ↓
검증:
  curl http://whisper-stt:8001/health  (서버 내부)
  마이크 녹음 → frontend → backend → whisper → opsidian 노트
```

서버 내부 파일 직접 수정 금지 — 반드시 PR 경유.
