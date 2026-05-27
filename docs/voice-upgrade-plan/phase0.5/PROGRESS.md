# Phase 0.5 — PR 0: gpt_sovits 완전 제거 PROGRESS

> [PLAN.md](./PLAN.md) 참조.
>
> 진행 상황 추적. 완료 시점: 2026-05-27.

---

## 진행 상황

### 1. 사전 작업

- [x] grep으로 영향 범위 19 파일 매핑
- [x] OmniVoiceConfig.voice_profile 필드 확인 (활성 판정 이식 대상)
- [x] PLAN.md 작성

### 2. 백엔드 — 삭제 (3 파일) ✅

- [x] `backend/service/vtuber/tts/engines/gpt_sovits_engine.py`
- [x] `backend/service/config/sub_config/tts/gpt_sovits_config.py`
- [x] `backend/service/config/variables/tts_gpt_sovits.json`

### 3. 백엔드 — 수정 ✅

- [x] `backend/service/vtuber/tts/tts_service.py` — 엔진 등록 import + register 2줄 제거 (라인 383, 389)
- [x] `backend/service/config/sub_config/tts/tts_general_config.py`
  - [x] default `provider: str = "omnivoice"`
  - [x] options 리스트에서 gpt_sovits 항목 제거
- [x] `backend/service/config/variables/tts_general.json` — `provider: "omnivoice"` 마이그레이션
- [x] `backend/controller/tts_controller.py` 7 영역:
  - [x] content_type gpt_sovits 분기 제거 (라인 113~)
  - [x] `UpdateProfileRequest.gpt_sovits_settings` 필드 제거
  - [x] `list_profiles` active 판정 OmniVoice config로 이식
  - [x] `create_profile` `gpt_sovits_settings` 디폴트 dict 제거
  - [x] `update_profile` `gpt_sovits_settings` 분기 제거
  - [x] `activate_profile` 흐름을 OmniVoice config로 이식 (ref_audio_dir/container_ref_dir 제거)
  - [x] activate docstring 갱신 (GPT-SoVITS → OmniVoice)
- [x] `backend/service/config/sub_config/tts/__init__.py` — 카테고리 docstring 갱신
- [x] `backend/service/vtuber/tts/__init__.py` — 패키지 docstring 갱신
- [x] `backend/service/config/sub_config/tts/omnivoice_config.py` — clone 모드 설명 + scan logic docstring 갱신
- [x] `backend/service/vtuber/tts/engines/omnivoice_engine.py` — 모듈 docstring + 볼륨 레이아웃 주석 갱신

### 4. 프론트엔드 수정 ✅

- [x] `frontend/src/lib/api.ts` — `VoiceProfile.gpt_sovits_settings` 타입 필드 제거
- [x] `frontend/src/components/modals/CreateSessionModal.tsx` — `hasGptSovits` 체크를 `hasTtsEngine`(엔진 수 ≥ 1)로 단순화
- [x] `frontend/src/lib/i18n/en.ts` — `ttsProfileHelp`, `ttsDisabled` 메시지 갱신
- [x] `frontend/src/lib/i18n/ko.ts` — 동일 키 갱신

### 5. Docker compose 3개 파일 ✅

- [x] `docker-compose.yml`:
  - [x] 상단 TTS 설정 주석 (GPT-SoVITS URL 안내) 제거
  - [x] gpt-sovits 서비스 블록 (라인 147-192, 46줄) 제거
  - [x] OmniVoice 주석에서 "GPT-SoVITS 와 동일 profile" 표현 정리
- [x] `docker-compose.dev.yml`:
  - [x] 상단 TTS 설정 주석 제거
  - [x] frontend 서비스의 `NEXT_PUBLIC_GPT_SOVITS_WEBUI_PORT` env 제거
  - [x] gpt-sovits 서비스 블록 제거
- [x] `docker-compose.prod.yml`:
  - [x] 상단 TTS 설정 주석 제거
  - [x] DISABLED 주석 처리되어 있던 gpt-sovits 블록 전체 제거 (50줄)

### 6. 검증 ✅

- [x] grep — 코드 영역 (`*.py / *.ts / *.tsx / *.json / *.yml`) gpt_sovits 잔재 **0 hits**
  - 제외 범위: `node_modules`, `.next`, `.venv`, `__pycache__`, `docs/_archive`, `docs/voice-upgrade-plan`, `omnivoice/README*`, `omnivoice/server/*` (사용자 정책: 마이크로서비스 무변경), `backend/static/voices` (데이터, silent ignore)
- [x] `python3 -m py_compile` 5개 핵심 백엔드 파일 통과:
  - `tts_service.py`, `tts_general_config.py`, `omnivoice_config.py`, `omnivoice_engine.py`, `tts_controller.py`
- [x] `tts_general.json` JSON 유효, `provider=="omnivoice"` 확인
- [x] `docker compose -f <each>.yml config` 3개 모두 정상 파싱
- [x] `docker compose config --services` 출력에 gpt-sovits 미포함 (4 서비스: postgres / backend / frontend / avatar-editor)

### 7. 마무리

- [x] PROGRESS.md 완료 체크리스트 처리
- [ ] PR 본문 작성 → 사용자에게 보여주고 commit/push 여부 확인

---

## 변경 파일 요약

### 삭제 (3)
- `backend/service/vtuber/tts/engines/gpt_sovits_engine.py`
- `backend/service/config/sub_config/tts/gpt_sovits_config.py`
- `backend/service/config/variables/tts_gpt_sovits.json`

### 수정 — 백엔드 (8)
- `backend/service/vtuber/tts/tts_service.py`
- `backend/service/vtuber/tts/__init__.py`
- `backend/service/vtuber/tts/engines/omnivoice_engine.py`
- `backend/service/config/sub_config/tts/__init__.py`
- `backend/service/config/sub_config/tts/tts_general_config.py`
- `backend/service/config/sub_config/tts/omnivoice_config.py`
- `backend/service/config/variables/tts_general.json`
- `backend/controller/tts_controller.py`

### 수정 — 프론트엔드 (4)
- `frontend/src/lib/api.ts`
- `frontend/src/components/modals/CreateSessionModal.tsx`
- `frontend/src/lib/i18n/en.ts`
- `frontend/src/lib/i18n/ko.ts`

### 수정 — Docker (3)
- `docker-compose.yml`
- `docker-compose.dev.yml`
- `docker-compose.prod.yml`

### 신규 — 문서 (2)
- `docs/voice-upgrade-plan/phase0.5/PLAN.md`
- `docs/voice-upgrade-plan/phase0.5/PROGRESS.md`

**합계**: 삭제 3 + 수정 15 + 신규 2 = **20 파일**.

---

## 의도적으로 건드리지 않은 자산

- `omnivoice/server/*.py` — 사용자 정책: 마이크로서비스 코드 무변경. 일부 주석에 GPT-SoVITS 컨텍스트 언급 있으나 동작 무영향.
- `omnivoice/README.md`, `omnivoice/README_KO.md` — 역사적 전환 컨텍스트 (GPT-SoVITS → OmniVoice 마이그레이션 설명) 유지.
- `docs/_archive/*` — 역사적 문서 그대로.
- `backend/static/voices/mao_pro/profile.json` 의 `gpt_sovits_settings` 필드 — 백엔드가 silent ignore. 데이터 파일 손대지 않음.

---

## 런타임 검증 (PR 머지 후 서버에서 수행 권장)

PLAN.md §3.2 의 항목들:
- 백엔드 부팅 로그 — gpt_sovits 키워드 없음.
- `GET /api/tts/engines` — 4 엔진 (edge_tts, openai, elevenlabs, omnivoice).
- 4 템플릿 프로필 정상 로드 + active 플래그 동작.
- `POST /api/tts/profiles/<name>/activate` → OmniVoiceConfig.voice_profile 업데이트 → `list_profiles` active 표시 변경.
- 에이전트 채팅 TTS 정상 (omnivoice 호출).
- `docker compose up` → geny-gpt-sovits 컨테이너 미생성.

---

## 다음 단계

PR 0 commit & push → 회귀 검증 → Phase 1 PLAN.md 작성 → PR 1A (라우팅 + 좌측 네비 + Voices + 진입점 2개) 진입.
