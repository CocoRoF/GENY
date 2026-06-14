# 화면 인지 VTuber — 완벽한 구현 플랜 (3차, 실행 계획)

> 작성일: 2026-06-14
> 선행: [01-screen-to-conversation-analysis.md](01-screen-to-conversation-analysis.md)(OLV 백엔드+Geny 현황) ·
> [02-web-client-and-revised-integration.md](02-web-client-and-revised-integration.md)(OLV 실제 웹소스+정정)
> 상태: **구현 계획 (코드 미수정).** 승인 후 Phase 순서대로 착수.
> 원칙: OLV의 능력을 **전부 흡수**하되, Geny 구조에 맞춰 **진화·발전**시킨다. 기존 Obsidian
> 기록 시스템과 **공존하며, 깨져 있던 기록을 제대로 고친다.**

---

## 1. 확정된 결정 (사용자 지정)

| # | 결정 | 값 |
|---|---|---|
| D1 | 캡처 트리거 | **기존 "화면 관찰" 토글이 ON이면 = vision ON.** 별도 턴별 옵트인 없이 자연스럽게 캡처 |
| D2 | 카메라 | **제외.** 화면만 |
| D3 | 이미지 규격 | **16:9, ~1600×900**, JPEG **품질 0.8~0.9** (기본 0.85) |
| D4 | OLV 능력 | **전부 흡수 + Geny에 맞춰 진화·발전** |
| D5 | 기록 | Obsidian 문서 시스템에 **제대로 기록** + 페르소나가 **실제 화면도** 보게. 공존·발전 |

---

## 2. 현재 아키텍처 정밀 지도 — 3 레이어 & 3 갭

Geny엔 이미 화면 인지에 필요한 정교한 뼈대가 **거의 다** 있다. 문제는 세 곳이 끊겨 있다는 것.

### 레이어 A — 캡처(프론트)
- 토글: `ScreenObservationControls.tsx` → `useScreenObservation.ts`. ON이면 `getDisplayMedia` 스트림
  1회 획득 후 유지, **3분 주기**로 프레임 업로드(`/api/vtuber/screen-observation/upload`).
- 데스크톱 커넥터엔 별도 `ConnectorBridgeClient.grabFrame`(chromeMediaSource, 무프롬프트)도 존재.

### 레이어 B — 인지(페르소나가 보는 것)
- 업로드 프레임 → `_caption_image`(별도 캡션 모델 `claude-haiku`, `_try_vision_describe`) → 텍스트 캡션.
- `_run_trigger` → `[USER_OBSERVATION]` 합성 프롬프트(캡션 텍스트) → `execute_command(is_trigger=True)`.
- 추가로 **whiteboard/spotlight 시스템**: `SpotlightContextBlock`이 매 턴 시스템프롬프트에 활성
  spotlight를 주입하고, **vision 가능 시 image_ref까지 수집**하지만 `PromptBlock.render()→str`
  한계로 **버린다**. `is_vision_capable(model)` 판정기도 이미 존재.

### 레이어 C — 기록(Obsidian 메모리 볼트)
- 볼트: `<storage>/memory/<category>/*.md` (Obsidian 스타일 frontmatter + `[[wikilink]]`/`![[embed]]`).
- 회상: 페르소나가 **memory tools**(`memory_search`/`memory_list`/`memory_read`)로 능동 조회
  (자동주입은 pinned `critical` + vault map만).
- executor file provider는 `NOTE_CATEGORIES` 외에도 **`memory/`의 host-defined 하위 디렉터리를
  자동 발견**(layout.py:147-152). 즉 `memory/<새카테고리>/`도 인덱싱됨. `inbox`는 등록 카테고리.

### 🔴 3대 갭

| 갭 | 증상 | 근본 원인 |
|---|---|---|
| **G1 — 페르소나가 픽셀을 못 봄** | 화면을 "캡션 요약"으로만 인지(작은 텍스트/레이아웃/색/에러 손실) | `_run_trigger`가 `image_path`를 **받지만 안 씀**, 캡션만 전송. SpotlightBlock도 image_ref 폐기 |
| **G2 — 기록이 깨져 있음** | docstring은 "memory tools로 회상 가능"이라 주장하나 **실제 회상 불가** | 노트가 `memory/`가 아닌 **sibling `observations/`** 에 `category:"observations"`(미등록)로 **raw `write_text`** → 인덱싱·검색·회상 전부 안 됨 |
| **G3 — 캡처가 주변-한정** | "이거 봐봐"라고 말해도 그 순간 화면이 대화에 안 붙음 | 캡처가 3분 주기 ambient 업로드뿐. 대화 턴(텍스트/음성)에 현재 프레임 첨부 경로 없음 |

> 핵심: **인프라는 다 있다.** executor 멀티모달 `attachments` 채널(검증됨), 캡션 모델, vision 판정,
> Obsidian 볼트, spotlight 주입, 커넥터 캡처. 세 가닥만 이으면 된다.

---

## 3. 목표 아키텍처 (진화형)

OLV "라이브 시각 대화" + Geny "영속 시각 기억(Obsidian)" + Geny "게이트/프라이버시 절제" 의 합집합.
**한 번 캡처한 프레임이 세 곳을 동시에 흐른다: 페르소나 인지(픽셀) · 캡션 게이트 · Obsidian 기록.**

```
[화면 관찰 토글 ON] (= vision ON, D1)  — 스트림 1회 획득 후 유지 (커넥터면 무프롬프트)
        │
        ├─(1) AMBIENT 주기 (기존, 기본 3분)
        │       프레임(1600×900,q0.85) → upload
        │          ├─ _caption_image (haiku) → caption  ── 게이트(쿨다운/민감 1차스캔)
        │          ├─ [기록 C] memory/observations/ 에 provider.write (caption+![[img]]) → 인덱싱
        │          └─ 게이트 통과 시 [USER_OBSERVATION] trigger
        │                 execute_command(prompt=caption規則, is_trigger=True,
        │                                 attachments=[{kind:image, url:file://…png}])  ← [인지 B] 실제 픽셀
        │
        └─(2) 대화 턴 (신규, OLV 모델) — 사용자 텍스트/음성 전송 시 스트림이 살아있으면
                현재 프레임 grab(1600×900,q0.85)
                   → broadcastToRoom(msg, attachments=[{kind:image,data|url}])  ← [인지 B] 실제 픽셀
                   → (백엔드 기존 attachments 경로) execute_command(..., attachments) → 페르소나 픽셀 인지
                   → [기록 C] 같은 프레임을 memory/observations/ 에 기록 (dedup)
```

세 레이어 모두 **executor 멀티모달 `attachments` 채널**로 실제 이미지를 전달(신규 인프라 0).
캡션은 폐기하지 않고 **게이트 + 기록 본문 + 회상 텍스트**로 격하 재활용.

---

## 4. OLV 능력 → Geny 진화 매핑 (전부 흡수)

| OLV 능력 | Geny 진화·발전 적용 |
|---|---|
| 턴마다 화면 캡처·첨부 | **기존 토글 ON이면** 대화 턴에 현재 프레임 자동 첨부(D1). 별도 스트림 안 염 — ambient용 스트림 재사용 |
| 실제 픽셀을 LLM에 | executor 멀티모달 attachments로 동일 달성 + **s18 dehydrate로 히스토리 비대화 방지**(OLV엔 없음) |
| `ImageCapture.grabFrame`→JPEG(품질/폭) | 동일 기법 + **1600×900 16:9 고정, q0.85**(D3). OLV 기본 무축소보다 토큰 절제 |
| 화면+카메라 | **화면만**(D2) — 단순·프라이버시 |
| idle 프로액티브(프론트 타이머) | Geny ambient 트리거가 이미 준-프로액티브. **선택적**으로 idle 타이머 추가(P3, 기본 off, 30~60s) |
| Electron desktopCapturer 자동선택(무프롬프트) | 커넥터 캡처를 desktopCapturer 자동선택으로 일원화 → **getDisplayMedia 프롬프트 제거**(P2) |
| 컴포넌트 단위 클릭스루 | 컨트롤 증가 시 차용(P3, 현재 과함) |
| (OLV 없음) 영속 기억 | **Geny 고유 진화**: 모든 관찰을 Obsidian에 기록 → "아까 화면에서 봤던 그거" 회상 가능 |
| (OLV 없음) 게이트/침묵/민감가드 | Geny `[SILENT]` + 캡션게이트 + 민감정보 프롬프트 유지 — 픽셀 인지에도 그대로 적용 |
| (OLV 없음) 자동 업데이트 | 우리 electron-updater 유지 |

---

## 5. 단계별 구현 플랜

### Phase 0 — 규격 정렬 (캡처 1600×900 @ 0.85) · 작음
**목표:** 캡처 해상도/품질을 D3로 통일.
- `frontend/src/lib/useScreenObservation.ts` `_captureFrameAsBlob`: canvas를 **1600×900(16:9)로 다운스케일**,
  `toBlob('image/jpeg', 0.85)`. (현재 PNG/원본 → JPEG 1600×900)
- 백엔드 허용 mime에 jpeg 확인(이미 `_MIME_TO_EXT`에 있음). 업로드 6MB 한도 충분.
- config 노출: `GENY_SCREEN_OBS_MAX_W=1600`, `_QUALITY=0.85` (env, 기본값).
**수용 기준:** 업로드 프레임이 ≤~300KB JPEG 1600×900.

### Phase 1 — 인지 B: 관찰 트리거에 실제 픽셀 (G1, ambient 경로) · 작음·최대효과
**목표:** `[USER_OBSERVATION]` 발화 시 페르소나가 **캡션+실제 이미지** 동시 인지.
- `backend/service/vtuber/screen_observation.py`:
  - `_run_trigger`: 이미 받는 `image_path`를 사용 →
    `execute_command(session_id, prompt, is_trigger=True, timeout=180, attachments=[{"kind":"image","mime_type":mime,"url":image_path.as_uri()}])`.
  - `vision_capable` 판정(`service.whiteboard.vision_capability.is_vision_capable(session model)`):
    미지원이면 attachments 생략(캡션만) + 1회 경고. → **자동 폴백.**
- caption/`_compose_prompt`/`[SILENT]`/민감가드 **그대로 유지**.
**수용 기준:** 코드/에러 화면 관찰 시, 페르소나가 캡션엔 없는 화면 속 **구체 텍스트/요소**를 언급.

### Phase 2 — 기록 C: Obsidian 기록 제대로 고치기 (G2) · 중간
**목표:** 모든 관찰이 **회상 가능한 볼트**에 인덱싱되어 페르소나가 "아까 화면" 회상 가능.
- 관찰 노트 기록을 **raw `write_text`(sibling `observations/`) → 메모리 매니저/provider 경유**로 전환:
  - 저장 위치: `<storage>/memory/observations/<YYYY-MM-DD>/{id}.md` (볼트 **안**의 host-defined 카테고리;
    executor `category_dirs()`가 자동 발견 → 인덱싱·검색됨). 이미지 바이트는 `memory/observations/.../{id}.jpg`.
    *(대안: 등록 카테고리 `inbox/` 재사용. observations 전용 폴더가 추후 정리·삭제정책에 유리하므로 권장.)*
  - 쓰기 경로: `SessionMemoryManager`의 노트 쓰기(`self._memory_provider.notes().write(NoteDraft)`,
    manager.py:971 패턴)로 작성 → 인덱스 자동 갱신. **`.venv` 미수정**(executor가 host 카테고리 자동 발견).
  - frontmatter: `category: "observations"`(host-defined), `captured_at`, `vision_source`, `image`,
    `tags:[screen, observation]`. 본문: `![[{id}.jpg]]` + `> caption`.
- **회상 보강(진화):** 관찰이 많아지면 노이즈 → 다음 중 택1(권장 둘 다):
  - (a) **최근 관찰 다이제스트**: 최근 N개 관찰 캡션을 vault map/얇은 블록으로 노출(페르소나가 굳이
    검색 안 해도 "방금 흐름" 인지). 기존 spotlight 주입 메커니즘 재사용.
  - (b) `memory_search`가 observations를 긁도록 카테고리 화이트리스트 점검(host VALID_CATEGORIES에
    `observations` 추가 — `note_utils.py`, Geny측이라 수정 가능).
- **dedup/정리:** 직전 프레임과 캡션 동일/유사하면 노트 스킵 또는 합치기(디스크·인덱스 비대화 방지).
  오래된 관찰 정리 정책(예: 7일 후 이미지만 삭제, 캡션 노트 유지).
**수용 기준:** 새 세션에서 화면 관찰 몇 회 후, 페르소나에게 "아까 화면에서 뭐 봤어?" → memory_search/
다이제스트로 **실제 회상**. `memory_list(category=observations)`에 노트 노출.

### Phase 3 — 인지 B + 캡처 G3: 대화 턴에 현재 화면 첨부 (OLV 모델 이식) · 중간·체감 큼
**목표:** 토글 ON 상태에서 사용자가 텍스트/음성 보낼 때, **그 순간 화면**이 대화에 붙는다.
- 프론트: 화면 관찰 스트림이 살아있으면(토글 ON, D1) 전송 직전 현재 프레임 grab(1600×900,q0.85):
  - 텍스트: `VTuberChatPanel` 전송부 → `chatApi.broadcastToRoom(roomId, {message, attachments:[{kind:'image',mime_type,data}]})`.
  - 음성: `PushToTalkDriver` STT 후 broadcast에 동일 첨부.
  - 데스크톱이면 커넥터 `screen_capture` capability(무프롬프트) 우선, 브라우저면 기존 스트림 frame.
- 백엔드: **변경 없음** — broadcast attachments 경로가 이미 `execute_command(..., attachments)`로 흐름(01 §2.3).
- **같은 프레임을 Phase 2 기록 경로로도** 저장(대화 맥락 관찰도 기억에 남김, dedup 적용).
- 빈도/비용 제어: 토글 ON이어도 매 턴 첨부가 과하면 "직전 첨부 후 변화 없으면 생략" 옵션.
**수용 기준:** 토글 ON + "이 화면 뭐가 문제야?" → 페르소나가 현재 화면을 보고 답. 토글 OFF면 텍스트만.

### Phase 4 — 커넥터 캡처 일원화 + 무프롬프트 (G3/D, OLV 차용) · 중간
**목표:** 커넥터 환경에서 화면 공유 프롬프트 제거(OLV 방식).
- `desktop/src/main/index.ts`: `get-screen-capture` 등가 IPC(`desktopCapturer.getSources({types:['screen']})[0].id`).
- overlay의 screen-observation 캡처를 커넥터일 때 chromeMediaSource 경로로(이미 ConnectorBridgeClient에 존재) 통일.
- media 권한 auto-grant 점검(우리 main에 이미 setPermissionRequestHandler 존재).
**수용 기준:** 커넥터에서 토글 ON 시 공유 선택 팝업 없이 주 화면 즉시 캡처.

### Phase 5 — (선택) idle 프로액티브 + vision 게이팅 정리 · 작음
- OLV식 프론트 idle 타이머(아바타 idle N초 → 현재 화면 첨부 발화). config `allow_proactive`(off), `idle_seconds`(30~60).
- 모델 vision 미지원 시 전 경로 캡션 폴백 일원화(Phase1 판정 재사용).

> **권장 착수 순서:** P0 → **P1(픽셀 인지 즉시)** → **P2(기록 복구)** → **P3(대화 턴 첨부)** → P4 → P5.
> P1+P2가 사용자가 말한 "잘 보면서 + 제대로 기록"의 핵심. P3가 체감 큰 UX.

---

## 6. 설정 / 튜너블 (정책은 config, 하드코딩 금지)

| 키 | 기본 | 의미 |
|---|---|---|
| `GENY_SCREEN_OBS_MAX_W` / `_MAX_H` | 1600 / 900 | 캡처 해상도(16:9) |
| `GENY_SCREEN_OBS_QUALITY` | 0.85 | JPEG 품질(0.8~0.9) |
| `GENY_SCREEN_OBSERVATION_COOLDOWN_S` | 600 | ambient 트리거 쿨다운(기존) |
| `GENY_SCREEN_OBS_INTERVAL_S` | 180 | ambient 캡처 주기(기존 3분) |
| `GENY_SCREEN_OBS_SEND_IMAGE` | true | 페르소나에 실제 픽셀 전송(off=캡션만) |
| `GENY_SCREEN_OBS_ATTACH_ON_TURN` | true | 대화 턴 현재 화면 첨부(P3) |
| `GENY_SCREEN_OBS_RETENTION_DAYS` | 7 | 관찰 이미지 보존(캡션 노트는 유지) |
| (세션) privacy 모드 | `image` | `image`=픽셀+캡션 / `caption_only`=캡션만 |

---

## 7. 엣지케이스 · 리스크

- **프라이버시:** 픽셀은 캡션보다 더 노출. → 토글 ON 자체가 동의(D1)지만, `caption_only` 모드 +
  민감정보 프롬프트 가드 유지 + 보존정책. 비번/키 화면은 캡션 단계에서 1차 필터.
- **비용/토큰:** 이미지=토큰↑. → 1600×900 캡(D3), ambient 쿨다운/게이트, P3 "변화 없으면 생략",
  s18 dehydrate로 히스토리 누적 방지. 캡션은 싼 haiku 유지.
- **회상 노이즈:** 관찰 수백 개 → 검색 잡음. → dedup, 보존정책, 최근 다이제스트(N개)만 상시 노출.
- **vision 미지원 모델:** is_vision_capable 폴백 → 캡션만(현행 동작 보존).
- **executor 카테고리:** `.venv` 수정 금지 — `memory/observations/` host-discovered 경로 사용(검증됨).
- **커넥터/브라우저 이원화:** P4 전까지 브라우저는 getDisplayMedia 유지(정상 동작), 커넥터만 무프롬프트.

---

## 8. 테스트 / 검증

1. **Phase0:** 업로드 프레임 1600×900 JPEG, 크기 측정.
2. **Phase1(단위):** `_run_trigger`가 attachments 포함해 execute_command 호출(mock). vision 폴백 분기.
3. **Phase1(E2E):** 에러 화면 관찰 → 페르소나가 캡션 외 화면 텍스트 인용(픽셀 인지 증거).
4. **Phase2:** 관찰 후 `memory_list(category=observations)`/`memory_search`에 노출. 페르소나 회상 E2E.
   dedup 동작(동일 프레임 연속 → 노트 1개).
5. **Phase3:** 토글 ON + 질문 → 현재 화면 반영. 토글 OFF → 첨부 없음. 같은 프레임 기록 확인.
6. **회귀:** 채팅 업로드 멀티모달, s18 히스토리 비대화, 브라우저 폴백, [SILENT]/민감가드.

---

## 9. 파일 인덱스 (변경 지점)

**프론트**
- `frontend/src/lib/useScreenObservation.ts` — 캡처 규격 1600×900/0.85 (P0), 스트림 frame grab 재사용 (P3)
- `frontend/src/components/live2d/ScreenObservationControls.tsx` — 토글=vision ON 의미 명확화 (D1)
- `frontend/src/components/live2d/VTuberChatPanel`(전송부), `PushToTalkDriver.tsx` — 턴 첨부 (P3)
- `frontend/src/components/live2d/ConnectorBridgeClient.tsx` — 커넥터 무프롬프트 캡처 우선 (P3/P4)
- `frontend/src/lib/api.ts` — broadcastToRoom attachments (P3)

**백엔드**
- `backend/service/vtuber/screen_observation.py` — `_run_trigger` attachments (P1), 기록을 provider 경유
  `memory/observations/` 로 (P2), dedup/retention (P2)
- `backend/service/memory/manager.py` / `note_utils.py` — observations 카테고리 인지 + 회상(P2)
- `backend/service/whiteboard/vision_capability.py` — is_vision_capable 재사용(P1, 변경 없음)
- `backend/controller/vtuber_screen_observation_controller.py` — 업로드(기존, 변경 최소)
- `backend/controller/chat_controller.py` — broadcast attachments(기존 경로, 변경 없음)

**커넥터(Electron)**
- `desktop/src/main/index.ts` — get-screen-capture IPC (P4)

**executor (변경 없음 — 재사용)**
- s01 MultimodalNormalizer(attachments→이미지블록), s18 dehydrate, file provider host-category 자동발견

---

## 10. 결론

Geny는 화면 인지에 필요한 부품을 **이미 거의 다** 갖췄다 — 멀티모달 executor 채널, 캡션 모델, vision
판정, Obsidian 볼트, spotlight 주입, 커넥터 캡처. 끊긴 세 가닥(픽셀 인지·기록 복구·턴 첨부)만 이으면
된다. OLV의 "라이브 시각 대화"를 **기존 토글·broadcast attachments로 이식**(P3)하고, OLV엔 없는
**영속 시각 기억을 Obsidian에 제대로 기록**(P2)하며, 절제(게이트·픽셀 폴백·보존정책)는 Geny식으로
유지한다. 결과: *네가 말 걸면 지금 화면을 보고, 아까 본 것도 기억하는* — OLV보다 한 단계 진화한
화면 인지 VTuber. 착수: **P0 → P1 → P2 → P3**.
```
