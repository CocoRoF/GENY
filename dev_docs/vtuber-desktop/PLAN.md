# Geny VTuber — 데스크탑 앱(접속기) 전환 마스터 플랜

> 작성일: 2026-06-11 · 작성 근거: 11-agent 심층 검토(7 subsystem map + 4 design track, 코드 전수 file:line 검증)
> 대상 리포: `Geny/` (backend FastAPI + frontend Next.js 16/React 19), `Geny/vendor/geny-avatar`, `geny-executor 2.3.0`
> 한 줄 목표: **브라우저 탭이 아니라, 데스크탑 하단에 떠 있는 살아있는 VTuber 앱.** 서버는 두뇌(에이전트/메모리/TTS·STT 합성)로 그대로 두고, 접속기(connector)는 얇고 아름다운 클라이언트.

---

## 0. 결론 먼저 (TL;DR)

1. **서버는 단일 권위 두뇌로 유지.** geny-executor 파이프라인, 메모리, 세션, TTS/STT *합성*, 아바타 에셋 레지스트리, 환경/MCP, thinking-trigger 프레즌스는 전부 서버에 그대로. 접속기는 **렌더링·오디오 I/O·화면/OS 캡처·핫키·오버레이 UX** 만 가진다.
2. **렌더러는 이미 데스크탑 준비 완료.** `Live2DCanvas.tsx`(31KB)·`SpineCanvas.tsx`·`AvatarCanvas.tsx`·`lib/live2d/*` 전부 **순수 React+Pixi, Next.js 결합 없음**(`'use client'` + `next/dynamic` SSR 가드만). `backgroundAlpha=0` 투명 캔버스가 이미 prop 한 줄. → 통째로 복사 재사용.
3. **런타임은 V1 = Electron.** 헤드라인 리스크는 "항상 떠 있는 아바타가 완벽하게 렌더되는가"인데, 코드가 이미 Chromium 특정 동작(decodeAudioData 워크어라운드, pixi-v7 filter 비호환 회피, getDisplayMedia, wLipSync AudioWorklet)에 의존한다. Electron 은 한 Chromium 타깃으로 OS 3종 모두 커버. Tauri 는 OS webview 3종(WebView2/WKWebView/WebKitGTK) 차이로 WebGL·오디오 회귀 위험 → **Phase 0 의 1주 패리티 스파이크 후 재검토**, 그 전엔 Electron. (단, `connectorBridge` 추상화로 Tauri 전환 문을 싸게 열어둔다.)
4. **와이어 프로토콜은 발명하지 않는다.** `/ws/execute`·`/ws/vtuber/.../state`·`/ws/chat/rooms` 세 WS 가 이미 동일한 `{type, data}` JSON + heartbeat 이고, TTS 는 NDJSON HTTP 스트림이다. 이걸 **"Connector API v1"** 으로 버전 동결 — 브라우저와 데스크탑이 같은 계약을 쓴다(무중단 마이그레이션).
5. **데스크탑 능력은 "역(逆) MCP" 로컬 도구 브리지로.** 새 RPC 계층을 만들지 않는다. 네이티브 능력(화면 글랜스/클릭/타이핑)을 geny-executor `Tool` 서브클래스로 만들고, `execute()` 가 이미 열린 세션 WS 로 `capability_call` 을 보내 접속기가 실행·응답한다 — `MCPToolAdapter` 와 1:1 패턴. **executor 의 권한 매트릭스 + ASK→HITL + posture 를 전부 재사용**(중복 정책 0).
6. **인증은 기존 계정 시스템 재사용.** Geny 는 이미 완성된 로그인(`/api/auth/{status,setup,login}` → JWT, bcrypt, single-admin)을 가짐. 접속기는 **새 device-pairing 을 만들지 않고** 계정으로 로그인 → JWT 를 OS keychain 에 저장 → 헤더로 사용(접속기는 브라우저와 달리 `Authorization` 헤더 직접 설정 가능). "계정을 제대로 활용"한다는 건 **WS 가 그 JWT 를 실제 검증하게 + always-on 용으로 토큰 수명을 늘리게** 만드는 것. (§3.2)
7. **차단 선결과제 2개 (코드로 확인된 보안 구멍):**
   - `/ws/execute`, `/ws/vtuber/.../state`, `/ws/chat/rooms`, `POST /rooms/{id}/broadcast`, `POST /api/tts/.../speak*` 가 **인증 없이 `websocket.accept()`** — 인터넷 노출 시 누구나 에이전트 구동·토큰 소진·스트림 탈취 가능. **기존 계정 JWT 로 WS 업그레이드 검증 retrofit 이 필수 선결**(`require_auth` 가 no-DB 시 anonymous 반환하는 우회도 차단).
   - prod compose 는 **HTTP-only** (nginx 58443). 원격 접속기는 `wss://` 필요 → certbot/Cloudflare TLS 가 선결. 그 전엔 LAN/localhost 전용.

---

## 1. 현재 시스템 지도 (코드 검증)

### 1.1 재사용 크라운 주얼 — "거의 그대로 복사"

| 자산 | 위치 | 데스크탑 재사용 |
|---|---|---|
| Live2D 렌더러 | `frontend/src/components/live2d/Live2DCanvas.tsx` (31KB) | 통째 복사. `backgroundAlpha=0`(:55,:164) 이미 투명. 순수 Pixi, SSR 무관 |
| Spine 렌더러 | `frontend/src/components/avatar/SpineCanvas.tsx` | 통째 복사 (단 lipsync/표정/beat 미지원 — §11 결정사항) |
| 아바타 디스패처 | `frontend/src/components/avatar/AvatarCanvas.tsx` | 런타임 인식 로더, 그대로 |
| 모션 파이프라인 | `lib/live2d/{enhancedLipSync,motionPipeline,expressionController,beatSync}.ts` + `plugins/{autoBlink,eyeSaccade,beatSync}` | 순수 TS 클래스, 0 결합. 복사 |
| 오디오 엔진 | `lib/audioManager.ts`(turn/seq FIFO), `ttsChunkStream.ts`(NDJSON), `ttsSentenceStream.ts`, `useVoiceActivityRecorder.ts`(RMS VAD) | Web Audio 표준 → Electron Chromium 에서 무변경 동작 |
| 상태 스토어 | `store/useVTuberStore.ts`, `useCreatureStateStore.ts`, `useAuthStore` 등 | 순수 JS, 서버 결합 없음. **단 module-scope TTS turn Map 은 단일 렌더러 프로세스에 유지**(이중 창 desync 위험) |
| 트랜스포트 | `lib/api.ts`(`executeStream`/`getWsUrl`), `lib/chatWsManager.ts`(WS 풀 + 지수백오프 재연결) | 서버 URL 만 config/keychain 에서 읽도록 변경 |
| 채팅 패널·컨트롤 | `VTuberChatPanel`, `AudioControls`, `STTControls`, `ScreenObservationControls` | 컴팩트 리스타일로 컨트롤 창에 재사용 |

### 1.2 서버에 그대로 남는 권위 컴포넌트

- **에이전트**: geny-executor 2.3.0 `Pipeline`, `AgentSessionManager`, `AgentSession.execute_command` (커맨드 탭/채팅 broadcast 공통 진입)
- **아바타 상태 두뇌**: `service/vtuber/avatar_state_manager.py` (emotion→expression_index→motion_group 해석, idle-group 안전장치), `emotion_extractor.py`, execute_stream 의 per-msg dedup `_LAST_EMITTED_AVATAR_STATE`
- **프레즌스 두뇌**: `service/vtuber/thinking_trigger.py` (TickEngine 위 idle 반성, 시간대 윈도우, "유저 복귀" 체크인 — **대화 없을 때의 살아있음이 여기 다 있음**)
- **creature_state**: mood/bond/vitals/progression decay (TickEngine), `GET /api/agents/{id}` 노출
- **합성**: OmniVoice(GPU, k2-fsa, voice cloning/emotion) + Edge-TTS fallback + Whisper vLLM STT. `tts_controller.py` `/speak/chunks` NDJSON `audio_b64`, `stt_controller.py` `/transcribe`
- **에셋**: `live2d_model_manager.py` + `model_registry.json`(v2) + `/static/{live2d,spine}-models` + baked-imports 파이프라인 (geny-avatar → bake → `/api/vtuber/library/sync` → install → register)
- **화면 관찰 인입**: `vtuber_screen_observation_controller.py` `POST /api/vtuber/screen-observation/upload` (저장 + vision 캡션 + `[USER_OBSERVATION]` 트리거, 10분 쿨다운)

### 1.3 데이터 흐름 (현 브라우저)

```
유저 발화/타이핑 → POST /api/chat/rooms/{room}/broadcast (단일 진입, DB 영속)
   → execute_command → geny-executor Pipeline → Claude → 로그/토큰 스트림
   → /ws/execute (log/status/result) + /ws/chat/rooms (message/agent_progress)
   → 프론트 문장 추출 → POST /api/tts/.../speak/chunks (NDJSON audio_b64)
   → AudioManager FIFO → Web Audio 재생 → RMS/wLipSync → ParamMouthOpenY (입)
아바타 상태: AvatarStateManager → /ws/vtuber/agents/{id}/state (emotion/expression/motion)
   → useVTuberStore → Live2DCanvas.expression()/.motion() + beatSync
화면 관찰: getDisplayMedia(3분) → canvas PNG → /screen-observation/upload → vision 캡션 → [USER_OBSERVATION]
```

### 1.4 현재 데스크탑을 막는 갭 (검증된 사실)

- **렌더 갭**: pixi-v7 DropShadow 비활성(`Live2DCanvas.tsx:234-239`) → 바닥 그림자 없음(오버레이는 CSS 레이어로 해결). wLipSync ML 로드 비동기 + 조잡한 RMS fallback(실패 시 모든 소리에 입 벌림). Spine 은 lipsync/표정/beat 미지원.
- **오디오 갭**: 브라우저는 mic 디바이스 열거 불가, MediaRecorder ~100ms 버퍼링(데스크탑은 <50ms 필요), AEC OS별 상이, barge-in(말 끊기) 불가.
- **화면 갭**: getDisplayMedia 는 픽셀만 — 실행 앱·OS 상태·창 목록·접근성 트리 모름. 액션(클릭/타이핑) 불가. 멀티모니터·창 단위 캡처 불가. 매 캡처 브라우저 재프롬프트.
- **보안 갭(차단)**: WS·broadcast·TTS 무인증 accept. compose HTTP-only. 세션 잠금 없음(브라우저+접속기 동시 attach 시 이중 실행). CORS `*`.
- **세션 갭**: `session_id` 서버 생성, AvatarStateManager 인메모리(재시작 시 소실), thinking-trigger 서버 TickEngine.

---

## 2. 아키텍처 결정

### 2.1 런타임: Electron (V1) — 근거

| 옵션 | 평결 |
|---|---|
| **Electron** (Chromium+Node) | **채택(V1).** 번들 Chromium 으로 WebGL/Web-Audio/wLipSync/getDisplayMedia 가 이미 검증된 엔진에서 무변경 동작. `setIgnoreMouseEvents(ignore,{forward:true})` 로 픽셀 단위 click-through. `desktopCapturer`/`globalShortcut`/`Tray`/`powerMonitor` 1급. `electron-updater`+`@electron/notarize` 턴키 서명/업데이트. React 19 코드 그대로 드롭인. 비용: ~80–150MB 번들, ~150–250MB idle RAM(FPS cap + occlusion 시 ticker pause 로 완화) |
| Tauri (Rust+OS webview) | **V1 보류.** 번들 3–10MB 는 매력적이나 OS webview 3종 차이로 WebGL2+AudioWorklet 회귀 위험(특히 Linux WebKitGTK). 팀에 Rust 0. **단 actuation end-state 의 Rust 크레이트(cpal/scap/enigo)는 우수 → Phase 0 패리티 스파이크 후 재평가** |
| PWA/브라우저 유지 | **기각.** 투명·always-on-top·click-through·글로벌 핫키·트레이·네이티브 캡처 구조적 불가 — 제품 목표 1·2·4 실패 |
| Electron now, bridge 추상화 | **헤지 채택.** 렌더러가 `electron` 을 직접 import 하지 않도록 `connectorBridge`(windowControl/screenCapture/mic/hotkeys/secureStore/serverConfig) 인터페이스 — Tauri 백엔드 스왑 문을 싸게 유지 |

### 2.2 능력 브리지: 역(逆) MCP

새 RPC 안 만든다. 접속기 = "유저 머신에 사는 MCP 서버", 단 방향이 반대(서버 에이전트가 접속기로 손을 뻗음):

```
서버측 Tool(geny-executor Tool 서브클래스).execute(input, ctx):
   ctx 의 connector-WS 핸들로 {type:'capability_call', call_id, tool, input} 송신
   asyncio.Future 대기 → 접속기가 {type:'capability_result', call_id, content, is_error} 응답
   == MCPToolAdapter.execute 와 1:1 (tools/mcp/adapter.py)
```

- `tools/list` 핸드셰이크로 접속기가 지원 능력 광고 → 구버전 접속기 graceful degrade.
- 도구 `annotations`(readOnlyHint/destructiveHint) → `_annotations_to_capabilities` → `ToolCapabilities` (기존 헬퍼 재사용). `GenyToolProvider.list_names/get` 로 등록 → `manifest.tools.external` 로 선택. **새 등록 배관 0.**
- 와이어 포맷을 MCP 로 모델링 → 미래에 에이전트+접속기 동일 머신 배치 시 진짜 MCP 로 무스키마변경 스왑.

---

## 3. 서버 ↔ 접속기 분리 + Connector API v1

### 3.1 세 계층

**(1) Control/Realtime — 기존 WS 재사용 + 핸드셰이크 버전화**

접속 시:
```jsonc
→ {"type":"hello","protocol_version":"1","client_id":"<uuid>","device_name":"...",
   "capabilities":["screen_capture","input_synthesis","clipboard","window_control","audio_out","audio_in"]}
← {"type":"ready","data":{"server_version":"...","accepted_capabilities":[...],"session_id":"..."}}
```
이후 기존 3 스트림 그대로:
- **Execute** `/ws/execute/{session_id}` — `{type:execute|stop|reconnect, prompt, ...}` → `{type:log|status|result|heartbeat|error|done}`. 토큰레벨 STREAM 이 `log` 로 도착.
- **Avatar cues** `/ws/vtuber/agents/{session_id}/state` — `{type:subscribe|ping}` → `{type:avatar_state|heartbeat}`, `avatar_state = {emotion, expression_index, motion_group, motion_index|null, intensity, transition_ms, trigger, timestamp}`.
- **Conversation** `/ws/chat/rooms/{room_id}` — `{type:subscribe(after)}` → `{type:message|agent_progress|broadcast_done|...}`. `message.source`(thinking_trigger|sub_worker_reply|inbox_drain|user) 로 자동 발화 여부 판단.

**(2) Utterance + Audio — HTTP 재사용**
- 발화(타이핑 또는 STT 결과) → `POST /api/chat/rooms/{room}/broadcast {message, attachments?}` (유일 진입, fire-and-forget, DB 영속).
- TTS: 채팅 WS 의 assistant `message` → 문장 추출 → `POST /api/tts/agents/{id}/speak/chunks {sentences[], emotion, language, turn_id}` → NDJSON `{seq,text,format,sample_rate,audio_b64}` → 포팅된 AudioManager.

**(3) Desktop/Local-tool — 신규 메시지 패밀리 (additive)**
```jsonc
서버→접속기: {"type":"capability_call","data":{request_id, tool, args, reason}}
접속기→서버: {"type":"capability_result","data":{request_id, ok, result|null, error?, denied?}}
화면 푸시(프로액티브): POST /api/vtuber/screen-observation/upload (네이티브 캡처로 소스만 교체)
```
버전: `hello.protocol_version`, 서버가 `min_supported`/`current` 광고, 미지 `type` 은 이미 graceful(`{type:error}`). 능력은 hello 에서 네고 → 구버전 접속기는 해당 capability_call 안 받음.

### 3.2 인증 — **기존 계정 시스템 재사용** (신규 페어링 발명 안 함)

> **방향 정정(2026-06-11):** Geny 는 이미 완성된 계정 인증을 가지고 있다(`auth_service.py`, `auth_controller.py`). 별도 device-pairing 프로토콜을 만들지 말고 **접속기가 기존 계정으로 로그인 → JWT → OS keychain 저장 → 그대로 사용**. "계정 기능을 제대로 활용한다"는 건 새 시스템이 아니라 **그 계정 인증을 (a) 접속기에서 쓸 수 있게, (b) WS 가 실제로 검증하게** 만드는 것.

**현재 계정 시스템 (코드 검증):**
- single-admin 모델(`auth_service.py:5` "only one account can exist"), 첫 `setup()` 호출자가 admin
- bcrypt + JWT(HS256, **24h** 기본 / `GENY_AUTH_TOKEN_HOURS` env), claims `{sub:username, display_name, exp, iat}`, secret = `.auth_secret` 파일
- 라우트 완비: `GET /api/auth/status`(has_users?/authenticated?), `POST /api/auth/setup`(1회), `/login`, `/logout`, `/me`. 로그인 시 `geny_auth_token` 쿠키 + body 토큰 둘 다
- `require_auth` 토큰 소스: `Authorization: Bearer` 헤더 → `geny_auth_token` 쿠키 (**쿼리파람 미지원**)
- `owner_username = auth.get("sub")` 세션에 저장만 됨(필터링 미사용 — single-admin 이라 무의미)

**접속기 인증 흐름 (기존 그대로):**
```
첫 실행 → 서버 URL 입력 → GET /api/auth/status
   has_users=false → 설정 화면(POST /api/auth/setup)
   has_users=true  → 로그인(POST /api/auth/login {username,password}) → JWT(body)
JWT → OS keychain(Keychain/Credential Manager/libsecret) 저장
서버 URL → ~/.geny/config.json
이후 모든 REST: Authorization: Bearer <JWT> (기존 apiCall 패턴 그대로)
```
접속기는 **헤더를 직접 설정 가능**(브라우저 아님) → REST/WS 둘 다 `Authorization: Bearer` 사용. 쿠키 불필요.

**"계정을 제대로 활용" = 닫아야 할 갭 4개:**
1. **WS 토큰 검증 (진짜 구멍, 선결)** — `accept()` 전에 JWT 검증. 토큰 소스 우선순위: ① `Authorization: Bearer`(접속기), ② `geny_auth_token` 쿠키(브라우저), ③ `?token=`(브라우저가 헤더 못 넣는 경우의 fallback — 짧은 TTL/프록시 로그 주의) 또는 `Sec-WebSocket-Protocol` 토큰. `_extract_token` 을 WS 용으로 확장 + 3 WS 엔드포인트에 검증 추가. **브라우저도 이득**(현재 무방비).
2. **always-on 앱용 토큰 수명** — 24h 는 데스크탑 펫에 너무 짧다. 두 옵션: (a) 접속기 로그인에 `GENY_AUTH_TOKEN_HOURS` 를 길게(예 720h=30일) + 만료 임박 시 무음 재로그인(keychain 의 자격증명으로), 또는 (b) `/api/auth/refresh` 엔드포인트 추가(기존 토큰 → 새 토큰). **계정 토큰 그대로, 수명만 연장** — 새 토큰 종류(device JWT) 안 만듦. 선택적으로 `client_id`/`device_name` claim 추가(어느 기기가 붙었는지 관측용, 강제 아님).
3. **no-DB anonymous 우회 차단** — `require_auth` 가 `auth_service is None` 시 `{sub:"anonymous"}` 반환 → 인터넷 노출 서버엔 침묵 개방문. prod 는 항상 DB/auth 보장(또는 env 로 strict 모드 강제).
4. **owner_username 적용 (멀티계정 가는 경우만)** — 현재 저장만 됨. single-admin 유지 시 불필요. 만약 "각자 자기 VTuber" 로 가면 list/get 에 owner 필터 강제. **권장: V1 single-admin 유지**(가장 단순, hobby posture 부합). 멀티계정은 §11 결정사항.

- TLS: 운영자 리버스 프록시(certbot/Cloudflare). 비-LAN 은 `wss://` 강제 + fingerprint pin. LAN 은 명시 동의 시 `ws://`.

### 3.3 프레즌스·복원력

- **프레즌스는 전적으로 클라이언트 ticker** — auto-blink/saccade/idle/beat 가 이미 매 프레임 동작(대화·서버 무관). 서버는 discrete cue 만 push → 짧은 서버 단절에도 아바타가 살아있음.
- 단절 시: STT 발화·화면 프레임 로컬 버퍼링 + 재연결 replay. 아바타 상태 재구독 + 현재 상태 재질의(서버 재시작 시 stale pose 방지). 렌더러 store 에 avatar-state dedup/rate-limit 추가(WS 재연결 flood 대비).

---

## 4. 데스크탑 클라이언트 아키텍처 (창 모델)

### 4.1 두 창, 단일 렌더러 프로세스

**(A) 오버레이 창 (아바타)** — `new BrowserWindow({transparent:true, frame:false, alwaysOnTop:true, skipTaskbar:true, hasShadow:false, resizable:true, backgroundColor:'#00000000', webPreferences:{contextIsolation:true, preload, backgroundThrottling:false}})`
- macOS `alwaysOnTop` level `'screen-saver'` + `setVisibleOnAllWorkspaces` → 풀스크린 앱 위에도 부유
- 하단 앵커: `screen.getDisplayNearestPoint`/`getAllDisplays`, 기본 높이 ≈ 0.45×workArea, y=workArea.bottom(태스크바 가장자리에 발이 닿음). 멀티모니터: 선택 display id+x/y/scale 영속. 스냅존: 좌하/중하/우하 ×모니터
- 렌더러는 `<AvatarCanvas sessionId backgroundAlpha={0} enhancedConfig={{lipSyncMode:'advanced'}}/>` 만 마운트. `html,body{background:transparent}`

**(B) 컨트롤/채팅 창** — 일반 프레임 창, 기본 숨김, 트레이 토글. `VTuberChatPanel` + 모델 셀렉터 + TTS/STT 토글 + 화면관찰 토글 + 세션 목록 + 계정 로그인/설정.

> **단일 렌더러 프로세스 필수**: `useVTuberStore` 의 module-scope TTS turn Map(`_liveTurnIndex` 등)이 창마다 분리되면 `ttsSpeaking`/turn 순서 desync. 오버레이를 primary, 컨트롤을 secondary 로 같은 store 공유(또는 IPC 단일 진실원).

### 4.2 Click-through + 핫스팟 (가장 어려운 UX)

- 기본 `win.setIgnoreMouseEvents(true,{forward:true})` → 클릭이 뒤 앱으로 통과
- 항상 보이는 **dock handle**(작은 발광 pill ~36px, 하단)만 non-ignored
- region hit-test: 아바타 불투명 실루엣 + handle + 말풍선을 interactive rect 로 추적. forwarded mousemove 가 rect 진입 시 `setIgnoreMouseEvents(false)`, 이탈 시 `(true,{forward:true})`. 픽셀 정확도: 커서 위치 캔버스 알파 샘플링(저해상 캐시 마스크) → 불투명 픽셀에서만 interactive. **히스테리시스/디바운스 필수**(실루엣 가장자리 flicker 방지)
- 아바타 본체 클릭: 기존 `HitAreaHead/Body` 히트 로직 → `interactAction(sessionId, hitArea, x, y)` 그대로 → 이모트
- handle 드래그 → 창 이동(`setBounds` delta). 렌더러 자체 pan/zoom 은 modifier 게이트(창 드래그와 충돌 방지). handle 클릭 → peek(창 y 슬라이드아웃, handle 만 남김)/트레이 hide

### 4.3 패키징·업데이트

- `electron-builder`: Win NSIS(EV/OV 서명 or self-sign+SmartScreen caveat), macOS dmg + Developer ID + `@electron/notarize` + hardened runtime/entitlements(mic·screen-recording TCC), Linux AppImage+deb(무서명)
- 오토업데이트 `electron-updater` ↔ GitHub Releases, 오버레이에 'update ready' 칩
- first-run: 서버 URL → `GET /api/auth/status` → setup/login → device JWT keychain → 모델 assign → 오버레이 spawn

---

## 5. 네이티브 능력 (브라우저 불가)

### 5.1 Voice-first 네이티브 루프

- **캡처**: 네이티브 저지연 — Win WASAPI shared(~10–30ms)/mac CoreAudio/Linux PulseAudio·PipeWire. 디바이스 열거 + picker(브라우저 불가). 포팅된 `useVoiceActivityRecorder` RMS 히스테리시스(thresh 0.04/0.018, sustain 120ms, trail 1200ms) — 수학은 순수, 디바이스별 재튜닝
- **모드**: 연속 VAD(기본) / push-to-talk(글로벌 핫키 — 브라우저 불가) / wake-word(opt-in, openWakeWord/Porcupine ONNX 로컬 — Porcupine 상용 라이선스 주의)
- **STT**: 네이티브 WAV → 기존 `/api/vtuber/stt/transcribe`(무변경). 네이티브 VAD 가 발화를 짧게(<10s) 분절 → file-POST 지연 수용. 스트리밍 STT 는 Phase 2 stretch(whisper-vLLM 은 비스트리밍 `/v1/audio/transcriptions` 만 노출 — 검증됨)
- **barge-in(킬러)**: TTS 재생 중에도 mic 유지, 발화 onset 검출 시 (a) `audioManager.clearQueue()/stop()` 즉시 TTS 컷 (b) execute WS `stop` 으로 턴 중단 (c) 새 발화 캡처. 네이티브 AEC(WASAPI loopback / CoreAudio voice-processing / WebRTC APM)로 TTS 누설 제거 — OS별 품질 차이 → 안되면 push-to-talk 기본
- **재생+립싱크**: `AudioManager`+`EnhancedLipSyncController`+wLipSync 그대로(webview Web Audio). 지연 측정 시에만 네이티브 재생(cpal) + 진폭 역피드백

### 5.2 진짜 데스크탑 인식

- **네이티브 캡처**: 모니터·창 단위 — Win DXGI Desktop Duplication / mac ScreenCaptureKit / Linux PipeWire portal·X11. getDisplayMedia 대체(재프롬프트 없음, 멀티모니터, 창 타깃). **기존 `/screen-observation/upload` 엔드포인트 byte-for-byte 유지**, 소스만 교체. `desktop_glance` 능력 도구로 온디맨드 pull 추가
- **OS 컨텍스트 도구**: `window_list`/`active_window` — Win EnumWindows+UIAutomation / mac CGWindowList+AXUIElement / Linux EWMH+AT-SPI. 접근성 트리 = 스크린샷 캡션보다 풍부한 구조적 컨텍스트(포커스 컨트롤·앱명)를 도구 결과로 제공
- **글랜스 루프**: 주기 push(기존 3분, 네이티브+설정가능) + 에이전트 pull(`desktop_glance`). 네이티브 프레임diff(perceptual hash)로 무변화 프레임 스킵
- **프라이버시/동의**: 트레이 인디케이터 + 오버레이 'eye' 배지(캡처 armed 시 항상), 글로벌 pause 핫키, per-app denylist(비밀번호 매니저 등 절대 캡처 금지), 업로드 전 온디바이스 redaction(시크릿 패턴 blur). 능력별 opt-in·취소 가능

### 5.3 가드된 액추에이션 (Phase 3, default OFF)

- 네이티브 입력합성 — Win SendInput / mac CGEventPost / Linux XTest·uinput. `app_open`/`text_type`/`key_press`/`mouse_click`/`clipboard_write` — **전부 `destructive=True`**
- 흐름: 에이전트 `app_open({app:'code'})` → executor 권한 매트릭스(deny-by-default + PLAN 모드 → ASK) → Stage 15 HITL `HITLRequest.token` → 접속기 네이티브 확인 다이얼로그('Geny 가 VS Code 를 열려고 합니다 — 한 번 허용/항상/거부') → `POST /api/agents/{id}/hitl/resume {token}`(이미 배선됨 `agent_controller.py:1178`) → 파이프라인 재개 → 도구 execute() 가 접속기로 forward. '항상 허용' → `/api/permissions/rules` ALLOW 룰 + live `refresh_runtime`(`agent_session.py:1661`)
- 별도 'Enable automation' 마스터 스위치(기본 OFF) + 전용 권한 namespace(전역 posture 가 실수로 데스크탑 제어를 grant 못하도록)

---

## 6. UX / 비주얼 / 살아있음(Presence)

### 6.1 부유 프레즌스

- 하단 앵커, 투명 가장자리, 안티에일리어싱 머리카락이 바탕화면에 합성. 작업 비방해(click-through + dock handle). 드래그 재배치, 스냅존, peek/hide
- **소프트 그림자/글로우**: in-canvas DropShadow 비활성(pixi-v7) → **CSS/창 레이어**로(발 아래 radial soft-shadow div + 선택적 rim-glow CSS filter). WebGL 클리핑 버그 회피 + 'gorgeous' 바 달성

### 6.2 상호작용 어포던스

- **말 시작**: 글로벌 핫키 push-to-talk(주), 아바타 클릭, opt-in wake-word
- **자막 말풍선**: TTS 를 먹이는 동일 sentence stream 에 바인딩 → 타이밍 정확. `audioManager` clip-end 에 페이드
- **확장 채팅**: handle 어포던스 → `VTuberChatPanel` 도킹 패널/컨트롤 창
- **퀵액션**: handle hover → 라디얼(TTS mute/mic mute/hide/settings). 트레이 메뉴: show/hide, mic, TTS, 모델, 설정, quit

### 6.3 턴 사이 살아있음 (대부분 재사용)

- 이미 매 프레임: auto-blink, eye saccade, idle 모션 재시작 → 주차된 아바타가 숨쉬고 깜빡이고 둘러봄
- 추가 3개(값만, 새 아트 0):
  - **화면 전체 시선 추적**: `screen.getCursorScreenPoint`(~30Hz, throttle/smooth) → 창좌표 변환 → `focusController` → 데스크탑 어디든 눈이 유저 따라감
  - **creature_state 휴식 정동**: `useCreatureStateStore.fetch` 의 mood/vitals → 휴식 표정 bias + blink rate + beatSync style(저에너지→졸린 깜빡임, 고기쁨→밝은 휴식표정)
  - **시간대/복귀 반응**: thinking-trigger 가 이미 시간윈도우 반성·복귀 체크인을 채팅에 저장 → 오버레이는 프로액티브 발화로 표면화. 창 포커스/OS 잠금해제/장기 idle 후 부드러운 인사

### 6.4 반응성 / 비주얼 상태

`presenceState ∈ {idle, listening, thinking, speaking, observing}` 을 기존 신호에서 유도:
- listening = VAD phase, thinking = agent_progress 'executing', speaking = `ttsSpeaking[sessionId]`, observing = 캡처 진행중
- 표현: speaking→립싱크+beat head-bob(기존), thinking→미묘한 표정/루프 모션+handle 스피너, listening→handle mic-pulse 링+커서 향한 head-tilt, observing→handle scan/eye 글리프(프라이버시 어포던스)
- **립싱크 품질**: 데스크탑 기본 `lipSyncMode:'advanced'`(wLipSync) — `Live2DCanvas` 가 이미 initAdvanced 시도+RMS fallback(:369-384), 한 줄 오버라이드, **가장 큰 체감 품질 향상**. 단 wLipSync init 실패를 침묵 degrade 말고 경고 표면화

### 6.5 온보딩/설정/알림 (신규 표면, 데이터 재사용)

- first-run 위저드: 서버 연결(JWT→keychain) → 모델 선택(`vtuberApi.listModels` 썸네일) → 보이스 → mic 테스트+동의 → 화면캡처 동의(기본 OFF) → 핫키+스냅
- 설정 창: 모델/보이스/mic 디바이스+VAD 감도/TTS 볼륨/핫키/캡처동의/앵커/click-through 강도/lipsync 모드/aliveness 강도/thinking-trigger on-off(서버 per-session 지원)
- 프로액티브 알림: thinking-trigger/sub-worker/inbox-drain 메시지 도착(`msg.source` 구분) → 아바타 정동 애니 + 말풍선 + (opt-in) 발화. **현재는 턴 위 겹침 방지로 background 메시지 자동 TTS 억제(:289-306) → 데스크탑은 '스스로 말 걸기' 설정으로, 켜면 동일 turn 큐 경유**(다중음성 버그 회귀 방지)

---

## 7. 통합 로드맵 (4트랙 정렬)

> 각 Phase 는 그 자체로 더 나은 제품을 출하한다. 보안 선결(인증·TLS)은 **Phase 1 에 고정** — 어떤 원격 노출보다 먼저.

| Phase | 제목 | 핵심 산출 | 트랙 |
|---|---|---|---|
| **0** | 셸 + 패리티 스파이크 | Electron+Vite+React19+TS, `connectorBridge` 인터페이스, 기존 `src/` 트리 Vite 빌드, **하드코딩 모델로 투명창에 Live2D+립싱크+TTS 가 브라우저와 동일 렌더 증명**(Next 탈각 검증). Tauri 패리티 1주 스파이크 병행 후 런타임 락 | client, native |
| **1a** | 보안 하드닝 (브라우저에도 출하) | **기존 계정 JWT 로** WS 업그레이드 인증(header+cookie+`?token=` fallback) on execute/avatar/chat, broadcast·TTS 게이트, no-DB anonymous 우회 차단, `GENY_AUTH_TOKEN_HOURS` 연장(+선택 `/api/auth/refresh`). **신규 pairing 프로토콜 없음** | server-split |
| **1b** | MVP 오버레이 (헤드라인 데모) | 투명/frameless/alwaysOnTop/skipTaskbar 단일 오버레이 하단, `<AvatarCanvas backgroundAlpha=0>`, config GENY_SERVER_URL, avatar-state WS + TTS 파이프라인 원격 연결, 기본 click-through + grip chip, login→JWT keychain. **실서버가 구동하는 떠 있는 말하는 아바타** | client, ux |
| **2** | 컨트롤 창 + 트레이 + 핫스팟 + 음성-아웃 | 트레이 토글 컨트롤 창(채팅/모델/토글/세션/페어링), 픽셀정확 click-through 핫스팟(알파마스크), 멀티모니터 picker+영속 geometry, 타이핑→broadcast, 채팅 WS→AudioManager→네이티브 재생→립싱크, 말풍선 자막, `presenceState` 유도+표현, `lipSyncMode:'advanced'` | client, ux, server-split |
| **3** | 음성-인 (full talk↔talk) | 네이티브 mic 캡처+디바이스 picker, 포팅 VAD, push-to-talk 글로벌 핫키, barge-in(네이티브 AEC), STT→broadcast | native, ux |
| **4** | 데스크탑 인식 (read-only) | getDisplayMedia→네이티브 멀티모니터/창 캡처(기존 upload 무변경), 트레이/오버레이 캡처 배지+pause 핫키+denylist+redaction, 설정가능 인터벌+perceptual-hash diff, occlusion/배터리 시 ticker throttle(powerMonitor) | native, screen |
| **4.5** | 능력 브리지 + pull-awareness | `service/executor/connector_bridge.py`(capability Tool=MCPToolAdapter 모델) + 양방향 capability WS(call_id futures, timeout, tools/list, annotations→ToolCapabilities), `GenyToolProvider` 등록. **read-only 도구 먼저**: `desktop_glance`/`window_list`/`active_window` → 에이전트가 "지금 볼게" 가능 | native, server-split |
| **5** | 살아있음 폴리시 | 화면전체 시선추적, creature_state 휴식정동, CSS soft-shadow+rim-glow, 시간대/복귀 인사, 프로액티브 발화(opt-in, turn 큐 경유) | ux |
| **6** | 가드된 액추에이션 | `destructive=True` 도구(app_open/type/key/click/clipboard_write), 'Enable automation' 마스터 스위치(OFF), ASK→HITL 네이티브 다이얼로그 ↔ `/hitl/resume`, '항상' → 룰+`refresh_runtime`, 전용 deny-by-default namespace | native, server-split |
| **7** | 배포 하드닝 + 복원력 | electron-builder per-OS 설치파일+서명/notarize, electron-updater, 단절 시 로컬 버퍼링+replay, avatar-state dedup/rate-limit, 재연결 시 상태 재질의, 접근성-트리 컨텍스트 도구, (필요시) 스트리밍 STT, Wayland degrade 경로 | all |

---

## 8. 리스크 레지스터 (우선순위)

| # | 리스크 | 심각도 | 완화 |
|---|---|---|---|
| R1 | **WS 무인증 accept** (execute/avatar/chat/broadcast/TTS) + no-DB anonymous 우회 — 인터넷 노출 시 누구나 에이전트 구동·토큰소진·탈취 | **차단** | Phase 1a: **기존 계정 JWT** 로 WS 검증 retrofit. 그 전엔 LAN/localhost 전용 |
| R2 | **TLS 부재** (compose HTTP-only) — 원격 device 토큰 평문 | **차단** | certbot/Cloudflare. 비-LAN `wss://` 강제+fingerprint pin |
| R3 | 액추에이션 = 실제 위험(타이핑/클릭/앱실행) | 높음 | `destructive=True` 자동 ASK, default OFF 마스터 스위치, 전용 namespace, blanket ALLOW UI 금지 |
| R4 | click-through 픽셀정확도 flicker/lag | 높음(UX 핵심) | 히스테리시스 히트테스트 + 저해상 알파마스크 캐시. head/body 히트렉트 근사 + handle/bubble 렉트 |
| R5 | Tauri webview 렌더 패리티 미검증(Live2D/wLipSync) | 높음 | Phase 0 1주 스파이크. Electron fallback |
| R6 | barge-in echo(mic 유지 시 자기간섭) | 높음 | 네이티브 AEC(speaker 참조). OS별 튜닝. 안되면 push-to-talk 기본 |
| R7 | 이중창 store desync(TTS turn Map) | 중 | 단일 렌더러 프로세스/공유 store |
| R8 | wLipSync 침묵 fallback(모든 소리에 입) | 중(쇼케이스) | startup init 검증 + 경고 표면화 |
| R9 | 멀티클라이언트 세션 이중실행(브라우저+접속기) | 중 | session affinity / 'this device owns session' claim |
| R10 | macOS TCC 권한(screen/mic/accessibility) 침묵 실패 | 중 | 권한상태 UI + 가이드 |
| R11 | Wayland actuation/capture 제약 | 중 | X11 = Linux 지원 경로, Wayland 는 portal-capture+no-global-input degrade |
| R12 | always-on 펫 RAM/배터리 | 중 | FPS cap(이미 :183), occlusion ticker pause, powerMonitor throttle |
| R13 | AvatarStateManager 인메모리(재시작 소실) | 낮 | 재연결 시 현재 상태 재질의 |
| R14 | TTS 문장 분리기 한국어 튜닝 | 낮 | 언어인식 토크나이저 포팅 |
| R15 | 코드서명 비용(solo hobby) | 낮(정보성) | macOS notarize=유료 Apple Dev, Win SmartScreen 경고 수용 가능 |

---

## 9. 핵심 통합 지점 (재사용 매핑)

| 능력 | 재사용 (서버) | 재사용 (클라) | 신규 |
|---|---|---|---|
| 렌더 | avatar_state_manager, emotion_extractor | Live2DCanvas/SpineCanvas/AvatarCanvas + lib/live2d/* 전체 | 오버레이 라우트, DockHandle, SpeechBubble |
| 오디오 | tts_controller `/speak/chunks`, stt_controller `/transcribe`, OmniVoice, Whisper | audioManager, ttsChunkStream, useVoiceActivityRecorder, enhancedLipSync, wLipSync | 네이티브 mic/재생, barge-in AEC, 디바이스 picker |
| 트랜스포트 | execute/avatar/chat WS 엔드포인트 | api.ts executeStream, chatWsManager | hello/ready 핸드셰이크, capability WS, keychain store |
| 권한/HITL | permission/types, stages/s15_hitl, `/hitl/resume`, refresh_runtime, install_permission_rules | — | 네이티브 확인 다이얼로그 |
| 도구 브리지 | MCPToolAdapter(템플릿), GenyToolProvider, tool_bridge | — | connector_bridge.py, capability Tool 카탈로그 |
| 화면 | screen_observation.py + upload + `_try_vision_describe` | (현 useScreenObservation 대체) | 네이티브 캡처, denylist, redaction, perceptual-hash |
| 프레즌스 | thinking_trigger, creature_state(TickEngine) | motion 파이프라인 idle/blink/saccade | 화면전체 gaze, 휴식정동 bias |
| 인증 | auth_service, auth_controller, `/api/auth/{status,setup,login}`(완비) | authApi(localStorage→keychain) | WS 토큰 검증, `_extract_token` WS 확장, (선택) `/api/auth/refresh`+토큰수명 연장 |

---

## 10. 첫 30일 실행안 (구체)

1. **Day 1–5 (Phase 0)**: Electron+Vite 스캐폴드, `connectorBridge` 정의, `src/` 트리 Vite 빌드(@/ alias), `next/dynamic` 제거(`VTuberTab.tsx:18`), Cubism Core SDK 패키징(`public/lib/live2d/live2dcubismcore.min.js`), 하드코딩 로컬 Live2D 일반창 렌더 → 렌더러 탈각 증명. **병행: Tauri WKWebView/WebKitGTK 패리티 스파이크** → 런타임 최종 락.
2. **Day 6–12 (Phase 1a)**: **기존 계정 JWT** 로 WS 업그레이드 인증 retrofit(header+cookie+`?token=` fallback) + no-DB anonymous 우회 차단 + `GENY_AUTH_TOKEN_HOURS` 연장(+선택 `/api/auth/refresh`). 신규 pairing 없음. 브라우저 회귀 0 확인(기존 쿠키 토큰 동작).
3. **Day 13–22 (Phase 1b)**: 투명 오버레이 + `<AvatarCanvas>` + config 서버URL + avatar-state WS + TTS 파이프라인 원격 + 기본 click-through + grip chip + login→keychain. **데모: 실서버 구동 떠 있는 말하는 아바타** (LAN 비서명 dev 빌드).
4. **Day 23–30 (Phase 2 착수)**: 트레이+컨트롤 창, 픽셀정확 핫스팟, 멀티모니터 geometry, 타이핑→broadcast→음성아웃 풀루프, 말풍선, presenceState, `lipSyncMode:'advanced'`.

---

## 11. 소유자 결정 필요 (Open Questions)

1. **런타임 최종**: Phase 0 패리티 스파이크 결과로 Electron 확정 vs Tauri(actuation Rust 크레이트 우수). 번들/RAM 허용 한계?
2. **계정 모델**: V1 single-admin 유지(권장, 가장 단순) vs 라이트 멀티계정(각자 자기 VTuber → `owner_username` 필터 강제 + 세션 격리). 멀티 디바이스가 한 계정에 붙을 때 세션 잠금/affinity 필요 여부
3. **Spine 오버레이 V1 포함?** (현재 lipsync/표정/beat 없음) — 파이프라인 확장 투자 vs Live2D-only V1
4. **프로액티브 발화 기본값**: thinking-trigger/복귀인사 자동 TTS ON vs 클릭-투-히어(현행)
5. **액추에이션 동의 모델**: per-action 프롬프트(안전·성가심) vs per-session grant vs allowlist+kill-switch 핫키
6. **TLS 종단**: Cloudflare tunnel vs certbot vs LAN-only — 분배 범위 결정
7. **오프라인 동작**: 단절 시 로컬 idle+입력 큐잉 vs 'disconnected' 상태 표시 — 캐싱 범위
8. **wake-word 엔진**: openWakeWord(오픈) vs Porcupine(상용) — solo-hobby 라이선스
9. **코드서명**: Apple Dev 계정/Win 인증서 구매 의향 → Phase 7 서명/비서명
10. **Wayland 범위**: Linux V1 = X11-only(풀 캡처+actuation) 수용 vs Wayland degrade 필수

---

## 부록 A. 검증된 보안 구멍 (즉시 조치 권고)

- `backend/ws/avatar_stream.py:70`, `execute_stream.py:317`, `chat_stream.py:112` — `websocket.accept()` 무토큰
- `POST /api/chat/rooms/{id}/broadcast`, `POST /api/tts/.../speak[/chunks]` — `require_auth` 부재
- CORS `allow_origins=['*']`
- compose HTTP-only (nginx 80 / NGINX_PORT 58443), TLS 미구성
- 세션 잠금/멀티클라이언트 인지 부재
- `require_auth` 가 `auth_service is None`(no-DB) 시 `{sub:"anonymous"}` 반환 — 인터넷 노출 시 침묵 인증 우회

> 이들은 데스크탑 전환과 무관하게 **인터넷 노출 시 이미 위험**. Phase 1a 로 분리 출하 권장(브라우저 클라이언트에도 즉시 이득).

## 부록 B. 산출 근거

본 계획은 11개 병렬 에이전트(7 subsystem map + 4 design track)의 코드 전수 검토 결과를 종합. 각 주장은 `file:line` 으로 검증됨. 원본 구조화 데이터: workflow run `wf_4ae91875-fb7`.
