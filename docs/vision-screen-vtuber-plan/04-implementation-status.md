# 화면 인지 VTuber — 구현 완료 상태 & 검토 리포트 (4차)

> 작성일: 2026-06-14
> 선행: [03-implementation-plan.md](03-implementation-plan.md)
> 상태: **구현 완료 (P0–P4), 적대적 리뷰 1회 + 핵심 버그 수정 반영.** 빌드/타입체크/테스트 통과.

---

## 1. 구현된 것 (커밋 diff 기준)

| Phase | 내용 | 파일 | 테스트 |
|---|---|---|---|
| **P0** | 캡처 규격 **1600×900 16:9 JPEG q0.85** (비율 보존, native→cap) | `frontend/src/lib/useScreenObservation.ts` | FE tsc |
| **P1** | 관찰 트리거가 **실제 픽셀(file://)을 페르소나에 첨부** + `is_vision_capable` 게이팅(미지원=캡션폴백) | `backend/.../screen_observation.py` `_run_trigger`/`_maybe_image_attachment` | 4 신규 |
| **P2-pre** | `VALID_CATEGORIES`에 `observations` 등록 (회상 가능 카테고리) | `backend/service/memory/note_utils.py` | — |
| **P2** | 관찰을 **회상 가능 볼트 `memory/observations/`에 `awrite_note`로 기록** + caption dedup + 이미지 retention prune + manager 없으면 raw 폴백 | `backend/.../screen_observation.py` `_record_observation_note`/`_prune_old_observations` | 6 신규 |
| **P3** | 음성(PTT)·키보드 턴에 **현재 화면 프레임 첨부**(toggle ON 시) — `screenFrameAccess` 싱글톤 | `screenFrameAccess.ts`(신규), `PushToTalkDriver.tsx`, `VTuberChatPanel.tsx` | FE tsc |
| **P4** | 커넥터에서 **desktopCapturer(chromeMediaSource) 무프롬프트 캡처**, 브라우저는 getDisplayMedia 폴백 | `useScreenObservation.ts` `_acquireScreenStream` | FE tsc |

테스트: `test_screen_observation.py` **22 passed** (기존 11 보존 + 신규 11). 백엔드 import OK, 프론트 tsc clean.

## 2. 동작 흐름 (After)

```
화면관찰 토글 ON  (커넥터=무프롬프트 / 브라우저=공유 프롬프트, 스트림 1회 획득·유지)
 ├─ 3분 주기 ambient: frame(1600×900,q0.85) → upload
 │     ├─ _caption_image(haiku) → caption  [게이트: 쿨다운/민감 1차스캔]
 │     ├─ memory/observations/ 에 awrite_note (caption+![[img]]) → 인덱싱·검색 가능
 │     │     · 동일 caption 연속 → dedup(쓰기 성공 후에만 마킹) · 오래된 이미지 prune(1h 스로틀)
 │     └─ 게이트 통과 시 [USER_OBSERVATION] trigger
 │           execute_command(prompt=caption규칙, is_trigger, attachments=[file://png])  ← 픽셀
 │                · vision 미지원 모델 → attachments 생략(캡션 only) 자동 폴백
 └─ 대화 턴(음성 PTT / 키보드, overlay 창): 현재 프레임 grab → broadcast attachments(raw b64) → 페르소나 픽셀
```

## 3. 적대적 리뷰 → 수정한 것

4개 차원(정확성/통합/회귀/프라이버시·비용) 리뷰 후 검증된 실재 이슈를 수정:

| 심각도 | 이슈 | 수정 |
|---|---|---|
| **CRITICAL** | P3가 `data` 필드에 **full data URL** 전송 → executor는 raw base64로 취급 → Anthropic 거부/손상 | `screenFrameAccess`에서 `data:…;base64,` 접두 제거 → **raw base64** 전송 |
| MEDIUM | dedup이 **쓰기 성공 전** caption을 'seen' 마킹 → 실패 시 이후 동일 캡처 영구 유실 | **쓰기 성공 후에만** `_last_caption` 마킹 (+테스트) |
| MEDIUM | `awrite_note`가 None 반환 시 raw 폴백까지 → **이중 쓰기** | manager 있으면 신뢰(이중 쓰기 제거), manager None일 때만 raw 폴백 |
| LOW-MED | retention prune이 **매 업로드(3분)마다 full rglob** | storage-root별 **1시간 스로틀** |
| LOW | 새 스트림 첫 프레임 **black 가능**(메타데이터 대기 없음) | `loadedmetadata` 대기(최대 600ms) 후 캡처 |

리뷰가 "Verified OK"로 확인한 것: P1 file:// attachment dict 형태, `awrite_note` 시그니처, `observations` 카테고리 회상 가능성, 프론트/백 필드명(`kind`/`mime_type`/`data`) 일치.

## 4. 알려진 한계 / 의사결정 (검토 요망)

1. **P3 타이핑 경로는 overlay 창에서만 화면 첨부.** `/connector` 채팅 창은 화면 스트림이 없는 별도 프로세스라, 거기서 타이핑한 턴엔 화면이 안 붙음(스트림 있는 overlay의 음성/타이핑은 붙음). `/connector` 타이핑의 화면 인지는 **ambient 관찰(P1) + 메모리 회상(P2)**로 커버. *완전 커버하려면* 백엔드가 broadcast 시점에 커넥터로 fresh capture 요청하는 P3b가 필요(코어 broadcast 경로에 지연·결합 추가 → 별도 승인 권장).
2. **P3 vision 게이팅은 실질 디폴트에 의존.** P1(트리거)은 모델 vision 능력으로 게이팅하지만, P3 턴 첨부는 게이팅 없이 broadcast로 감 → **VTuber 기본 모델이 vision(claude-sonnet 등)이라 실무상 OK**. 비-vision 모델로 바꾸면 P3 이미지가 실패할 수 있음(문서화).
3. **프라이버시: caption은 화면 텍스트를 verbatim 기록**하고 검색 가능 노트로 **영구 보존**(이미지만 retention prune). 비번/키가 화면에 있으면 caption에 남을 수 있음. 페르소나 발화엔 민감정보 가드가 있으나 *저장된 caption 자체*엔 미적용. → 필요 시 caption 작성 프롬프트에 redaction 지시 또는 노트 retention 추가 검토.
4. **dedup/cooldown/prune 딕셔너리는 세션 종료 시 미정리** (세션 수만큼 누적). hobby 규모에선 무시 가능, 장기적으로 teardown 훅에서 정리 권장.
5. **P5(idle 프로액티브)는 미구현** — ambient 관찰이 준-프로액티브 역할을 이미 하므로 보류(03 플랜대로). 원하면 추가.

## 5. 설정 (env)

| 키 | 기본 | 의미 |
|---|---|---|
| `GENY_SCREEN_OBS_SEND_IMAGE` | true | 트리거(P1)에 실제 픽셀 전송(off=캡션만) |
| `GENY_SCREEN_OBSERVATION_COOLDOWN_S` | 600 | ambient 트리거 쿨다운 |
| `GENY_SCREEN_OBS_RETENTION_DAYS` | 7 | 관찰 이미지 보존(노트는 유지). 0=비활성 |
| `GENY_WHITEBOARD_DISABLE_VISION` / `_FORCE_VISION` / `_VISION_CAPABLE_MODELS` | — | vision 게이팅 오버라이드(기존) |

## 6. 사용자 검증 절차 (배포 후)

1. VTuber 세션에서 **화면 관찰 토글 ON** → (커넥터면 프롬프트 없이) 캡처 시작.
2. 코드/에러 화면을 띄우고 잠시 대기(또는 "Show Now") → 페르소나가 **캡션엔 없는 화면 속 구체 텍스트/요소**를 언급하면 P1(픽셀 인지) 성공.
3. 음성(PTT)으로 "이 화면 뭐가 문제야?" → 현재 화면 반영된 답 → P3 성공.
4. 잠시 후 "아까 화면에서 뭐 봤어?" → 페르소나가 `memory_search`로 회상 → P2 성공. (또는 메모리 탭 `observations` 카테고리에 노트 확인)
5. 토글 OFF → 캡처/첨부 중단 확인.

## 7. 변경 파일 인덱스

- `backend/service/memory/note_utils.py` — observations 카테고리
- `backend/service/vtuber/screen_observation.py` — P1 attachments, P2 vault 기록+dedup+prune
- `backend/tests/service/vtuber/test_screen_observation.py` — +11 테스트
- `frontend/src/lib/useScreenObservation.ts` — P0 규격, P3 grabber 등록, P4 무프롬프트 acquire
- `frontend/src/lib/screenFrameAccess.ts` (신규) — 턴-첨부 싱글톤(raw base64)
- `frontend/src/components/live2d/PushToTalkDriver.tsx` — 음성 턴 화면 첨부
- `frontend/src/components/live2d/VTuberChatPanel.tsx` — 키보드 턴 화면 첨부
- `docs/vision-screen-vtuber-plan/` — 01~04 분석·플랜·상태 문서
