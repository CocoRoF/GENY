# Phase 0.5 — PR 0: gpt_sovits 완전 제거 PLAN

> Voice Studio 격상을 위한 사전 정리 작업.
> gpt_sovits 엔진은 사용자 결정으로 폐기. engine 코드 / config / docker 컨테이너 /
> activate 흐름 모두 깔끔히 제거하고 OmniVoice 한 곳으로 통일.
>
> 작성일: 2026-05-27 · 사용자 메모리 `feedback_verify_code_over_docs.md` 준수
> (코드를 1차 출처로 정밀 grep 후 작성).

---

## 0. 폐기 정책

| 자산 | 처리 |
|---|---|
| `gpt_sovits_engine.py` (백엔드 엔진) | **삭제** |
| `gpt_sovits_config.py` + `tts_gpt_sovits.json` (config) | **삭제** |
| `tts_service.py` 엔진 등록 | **수정** — 등록 해제 |
| `tts_general_config.py` provider enum / default | **수정** — gpt_sovits 옵션 제거 + default → omnivoice |
| `tts_general.json` (variables) | **수정** — provider 값 마이그레이션 |
| `tts_controller.py` activate / Pydantic 모델 / create_profile / list_profiles / content_type | **수정** — OmniVoice 한 곳으로 |
| `api.ts` `VoiceProfile.gpt_sovits_settings` | **수정** — 타입 필드 제거 |
| `CreateSessionModal.tsx` `hasGptSovits` 체크 | **수정** — omnivoice 또는 활성 엔진 기반 |
| `docker-compose*.yml` 3개 | **수정** — gpt-sovits 서비스 + 주석 제거 |
| `backend/static/voices/*/profile.json` 의 `gpt_sovits_settings` 필드 | **그대로** — 파일 손대지 않음, 백엔드가 silent ignore |
| `docs/_archive/*` 의 gpt_sovits 언급 | **그대로** — 역사적 문서 |
| `omnivoice/README*.md` 의 gpt_sovits 전환 컨텍스트 언급 | **그대로** — 역사적 컨텍스트 |

---

## 1. 영향 범위 정밀 매핑 (grep 결과)

```
backend/controller/tts_controller.py                                       — 6 hits
backend/service/config/sub_config/tts/gpt_sovits_config.py                 — 파일
backend/service/config/sub_config/tts/tts_general_config.py                — 2 hits
backend/service/vtuber/tts/engines/gpt_sovits_engine.py                    — 파일
backend/service/vtuber/tts/tts_service.py                                  — 2 hits
backend/service/config/variables/tts_gpt_sovits.json                       — 파일
backend/service/config/variables/tts_general.json                          — 1 hit ("provider": "gpt_sovits")
backend/static/voices/mao_pro/profile.json                                 — 데이터 (건드리지 않음)
docker-compose.yml                                                         — service 블록 + 주석
docker-compose.dev.yml                                                     — service 블록 + 주석
docker-compose.prod.yml                                                    — 주석 블록 only
frontend/src/components/modals/CreateSessionModal.tsx                      — 2 hits
frontend/src/lib/api.ts                                                    — 1 hit (VoiceProfile 타입 필드)
docs/_archive/*.md                                                          — 역사적 문서 (건드리지 않음)
omnivoice/README*.md                                                        — 역사적 컨텍스트 (건드리지 않음)
```

---

## 2. 구체 변경 명세

### 2.1 삭제 (3 파일)

- `backend/service/vtuber/tts/engines/gpt_sovits_engine.py`
- `backend/service/config/sub_config/tts/gpt_sovits_config.py`
- `backend/service/config/variables/tts_gpt_sovits.json`

### 2.2 `backend/service/vtuber/tts/tts_service.py`

**라인 383, 389 제거**:

```python
# 제거
from service.vtuber.tts.engines.gpt_sovits_engine import GPTSoVITSEngine
# ...
_tts_service.register_engine(GPTSoVITSEngine())
```

라인 380~390 블록이 import 4개 + register 4개로 정리되어야 한다.

### 2.3 `backend/service/config/sub_config/tts/tts_general_config.py`

- **라인 23**: `provider: str = "gpt_sovits"` → `provider: str = "omnivoice"`
- **라인 108-117 options 리스트**: `{"value": "gpt_sovits", "label": "GPT-SoVITS (Open Source)"},` 한 줄 제거. 다른 옵션(azure/google/clova)은 그대로 (별도 안 활성화된 외부 엔진).

### 2.4 `backend/service/config/variables/tts_general.json`

- **라인 3**: `"provider": "gpt_sovits",` → `"provider": "omnivoice",`

(기존 운영 환경의 영속 설정 마이그레이션 — 이미 omnivoice면 영향 없음. dev 환경에서 신규 부팅 시 default 적용 새 흐름.)

### 2.5 `backend/controller/tts_controller.py` — 6 영역

#### (a) 라인 113-119 — content_type 분기 정리

```python
# 변경 전
content_type = {
    "mp3": "audio/mpeg",
    "wav": "audio/wav",
    "ogg": "audio/ogg",
}.get(general.audio_format, "audio/mpeg")
default_language = general.default_language
current_provider = general.provider

# GPT-SoVITS v1 api.py always returns wav regardless of config
if current_provider == "gpt_sovits":
    content_type = "audio/wav"
```

→ gpt_sovits 분기 3줄 제거. `current_provider` 변수는 다른 곳에서 사용 안 하면 함께 정리 (확인 필요).

#### (b) 라인 1119 — `UpdateProfileRequest` 필드 제거

```python
gpt_sovits_settings: Optional[dict] = None  # ← 제거
```

#### (c) 라인 1154-1166 — `list_profiles` active 판정

GPT-SoVITS config의 ref_audio_dir로 active를 판정하던 부분을 OmniVoice config의 voice_profile로 변경:

```python
# 변경 전
from service.config.sub_config.tts.gpt_sovits_config import GPTSoVITSConfig
cfg = get_config_manager().load_config(GPTSoVITSConfig)
active_dir = os.path.basename(cfg.ref_audio_dir.rstrip("/"))

# 변경 후
from service.config.sub_config.tts.omnivoice_config import OmniVoiceConfig
cfg = get_config_manager().load_config(OmniVoiceConfig)
active_dir = cfg.voice_profile or ""
```

`OmniVoiceConfig.voice_profile`은 이미 `str = "paimon_ko"` 디폴트로 존재 (omnivoice_config.py:34 확인).

#### (d) 라인 1216-1221 — `create_profile` 디폴트 dict 제거

```python
# 변경 전
profile_data = {
    "name": body.name,
    ...
    "emotion_refs": {},
    "gpt_sovits_settings": {
        "top_k": 5,
        "top_p": 1.0,
        "temperature": 1.0,
        "speed_factor": 1.0,
    },
}

# 변경 후 (gpt_sovits_settings 6줄 제거)
profile_data = {
    "name": body.name,
    ...
    "emotion_refs": {},
}
```

신규 프로필은 `gpt_sovits_settings` 필드를 만들지 않음. 기존 프로필 (mao_pro 등)에 있는 필드는 그대로 두고 백엔드 무시.

#### (e) 라인 1246-1247 — `update_profile` 분기 제거

```python
# 제거
if body.gpt_sovits_settings is not None:
    data["gpt_sovits_settings"] = body.gpt_sovits_settings
```

#### (f) 라인 1388-1417 — `activate_profile` 흐름 OmniVoice로 이식

```python
# 변경 전 (activate가 GPT-SoVITS config를 업데이트)
from service.config.sub_config.tts.gpt_sovits_config import GPTSoVITSConfig
mgr = get_config_manager()
cfg = mgr.load_config(GPTSoVITSConfig)
cfg.voice_profile = name
cfg.ref_audio_dir = f"/app/static/voices/{name}"
cfg.container_ref_dir = f"/workspace/GPT-SoVITS/references/{name}"
# ... prompt copy ...
mgr.save_config(cfg)
return {
    "success": True,
    "profile": name,
    "ref_audio_dir": cfg.ref_audio_dir,
    "container_ref_dir": cfg.container_ref_dir,
}

# 변경 후 (OmniVoice config 업데이트)
from service.config.sub_config.tts.omnivoice_config import OmniVoiceConfig
mgr = get_config_manager()
cfg = mgr.load_config(OmniVoiceConfig)
cfg.voice_profile = name
# ... prompt copy: OmniVoice는 프로필의 prompt_text/prompt_lang을
#                  request 시 ref_audio_path와 함께 넘기는 구조이므로
#                  여기서 별도 복사 필요 없음. (omnivoice_engine.py가 자체 처리)
mgr.save_config(cfg)
return {
    "success": True,
    "profile": name,
}
```

응답 스키마에서 `ref_audio_dir`, `container_ref_dir` 키는 제거 (GPT-SoVITS 전용). 프론트엔드가 이 필드를 사용하는지 확인 필요 — `frontend/src/lib/api.ts` 의 `activateProfile` 반환 타입 grep.

### 2.6 `frontend/src/lib/api.ts`

- **라인 2739**: `VoiceProfile` 타입의 `gpt_sovits_settings?: Record<string, unknown>;` 필드 제거.

### 2.7 `frontend/src/components/modals/CreateSessionModal.tsx`

- **라인 106-107**: `const hasGptSovits = enginesRes.engines.includes('gpt_sovits'); setTtsEnabled(hasGptSovits);` → omnivoice 기반 또는 활성 엔진 중 하나라도 있으면 enabled.

권장 변경:
```typescript
const hasTtsEngine = enginesRes.engines.length > 0;
setTtsEnabled(hasTtsEngine);
```

(가장 단순하고 직관적. 4 엔진 중 하나라도 등록되어 있으면 TTS 활성화 가능.)

### 2.8 Docker compose 3개 파일

**`docker-compose.yml`**:
- `gpt-sovits` 서비스 블록 (라인 148-200 근처) + 주석 제거.
- 상단 21번 라인의 env 설정 안내 주석도 정리.

**`docker-compose.dev.yml`**:
- 라인 20 주석.
- 라인 153~ `gpt-sovits` 서비스 블록 제거.

**`docker-compose.prod.yml`**:
- 라인 30, 204-208 주석 정리 (이미 코멘트 처리된 상태).

각 파일에서 `gpt-sovits` 키워드 grep으로 0 hits 확인.

---

## 3. 검증 절차 (PR 0 완료 기준)

### 3.1 정적 검증

```bash
# 1) 코드 영역에 gpt_sovits 잔재 없음 (docs/_archive, omnivoice/README 제외)
grep -rn "gpt[_-]sovits" \
  --include="*.py" --include="*.ts" --include="*.tsx" \
  --include="*.json" --include="*.yml" --include="*.yaml" \
  /home/geny-workspace/Geny \
  | grep -v node_modules | grep -v ".next" | grep -v "__pycache__" \
  | grep -v "docs/_archive" | grep -v "omnivoice/README" \
  | grep -v "backend/static/voices"   # 기존 프로필 json은 그대로 둠
# → 결과 0 hits 기대

# 2) Python import 그래프 — gpt_sovits_engine, gpt_sovits_config import 없음
grep -rn "from.*gpt_sovits\|import.*gpt_sovits" /home/geny-workspace/Geny/backend
# → 결과 0 hits 기대

# 3) 백엔드 syntax 체크 (python -m py_compile)
python -m py_compile backend/service/vtuber/tts/tts_service.py
python -m py_compile backend/service/config/sub_config/tts/tts_general_config.py
python -m py_compile backend/controller/tts_controller.py
```

### 3.2 런타임 검증

```bash
# 1) 백엔드 부팅 — gpt_sovits 키워드 로그 없음
docker compose up -d backend
docker compose logs backend | grep -i "gpt[_-]sovits"
# → 결과 0 hits 기대

# 2) TTS engines API — 4 엔진만 노출
curl -s http://localhost:8000/api/tts/engines | jq
# → engines: [edge_tts, openai, elevenlabs, omnivoice]
# → default: omnivoice (또는 영속된 값)

# 3) 4 템플릿 프로필 로드 + active 플래그 동작
curl -s http://localhost:8000/api/tts/profiles | jq '.profiles[] | {name, active}'
# → 한 프로필에 active=true (OmniVoiceConfig.voice_profile 매칭)

# 4) activate 변경 → list_profiles의 active 변경
curl -X POST http://localhost:8000/api/tts/profiles/ruan_mei/activate
curl -s http://localhost:8000/api/tts/profiles | jq '.profiles[] | select(.active)'
# → ruan_mei

# 5) 에이전트 채팅 TTS 정상 동작 (회귀 테스트)
# UI에서 새 채팅 → vtuber role → TTS 출력 정상 + omnivoice로 호출되는지 로그 확인
```

### 3.3 docker-compose 검증

```bash
# 1) compose config 정상 파싱
docker compose -f docker-compose.dev.yml config | grep -i "gpt[_-]sovits"
# → 0 hits

# 2) up 시 gpt-sovits 컨테이너 미생성
docker compose -f docker-compose.dev.yml up -d
docker ps | grep -i "gpt[_-]sovits"
# → 0 hits
```

### 3.4 프론트엔드 검증

```bash
# 1) TypeScript 컴파일 (가능하면)
cd /home/geny-workspace/Geny/frontend && bun run build
# → gpt_sovits 관련 오류 없음

# 2) UI: CreateSessionModal 에서 vtuber role 선택 → TTS 토글 정상 (활성 엔진 있을 때 enabled)
```

---

## 4. 롤백 전략

PR 0 변경은 모두 git tracked 파일 — 머지 후 회귀가 발견되면:

```bash
git revert <pr-0-merge-commit>
```

로 안전하게 되돌릴 수 있다. 데이터 (voices/*/profile.json)는 안 건드리므로 데이터 손실 위험 없음.

---

## 5. PR 정보

- **브랜치**: `feature/voice-studio-cleanup-gpt-sovits` (또는 Geny 컨벤션 따름)
- **PR 제목**: `chore(tts): remove gpt_sovits engine (deprecated)`
- **PR 본문 요지**:
  - 사용자 결정: gpt_sovits 폐기, OmniVoice를 1급 시민으로.
  - Voice Studio 격상 ([phase0.5/PLAN.md](.)) 의 사전 정리.
  - 영향: 백엔드 6 파일 + 프론트엔드 2 파일 + docker-compose 3 파일.
  - 검증: 위 §3 절차 완료.

---

## 6. 다음 단계

PR 0 머지 → 회귀 검증 → Phase 1 PLAN.md 작성 → PR 1A 진입.
