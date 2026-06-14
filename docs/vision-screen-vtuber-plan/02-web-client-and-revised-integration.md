# OLV 웹 클라이언트 정밀 분석 & 정정·보강된 Geny 통합 설계 (2차)

> 작성일: 2026-06-14
> 1차 문서: [01-screen-to-conversation-analysis.md](01-screen-to-conversation-analysis.md) (OLV 백엔드 + Geny 현재상태)
> 신규 소스: `reference_data/Open-LLM-VTuber-Web-src` (`Open-LLM-VTuber-Web` **main** 브랜치 클론, 실제 TS/React 소스)
> 상태: **분석 전용 (코드 미수정).**

---

## 0. 무엇이 새로 밝혀졌나 (1차 대비 정정)

받은 submodule(`frontend/`)은 `branch=build` = **컴파일된 minified 번들**(`main-nu7uwxNJ.js` 1.9MB)
하나뿐이라 읽을 수 없었다. 그래서 실제 소스(main 브랜치)를 별도 클론했고, 결정적 사실을 확인했다:

| 항목 | 1차 추정 | **실제 (소스 확인)** |
|---|---|---|
| 캡처 타이밍 | "주기/온디맨드(프론트)" 추정 | **대화 턴 발생 순간 1프레임 캡처** (주기 X) |
| 캡처 대상 | 화면 | **화면 + 카메라 동시 가능**(둘 다 toggle on이면 한 턴에 2장) |
| 캡처 방식 | 미상 | `ImageCapture.grabFrame()` → canvas → **JPEG(품질·최대폭 설정)** |
| 어느 턴에 붙나 | 미상 | **모든 턴**: text-input / mic-audio-end / ai-speak-signal |
| 프로액티브 | 백엔드 신호 | **프론트 idle 타이머**(AI가 IDLE이면 N초 후 자발 발화 + 캡처) |
| 데스크톱 형태 | 미상 | **Electron 펫 모드 = 우리 Geny 커넥터와 동일 아키텍처** |

> **가장 중요한 교훈:** OLV의 모델은 *"네가 말을 걸 때(또는 AI가 자발 발화할 때) 그 순간의
> 화면/카메라를 함께 본다"* — 즉 **대화에 시각 맥락을 묶는다.** Geny 현재의 *"3분마다 몰래
> 보고 vision-caption 만들어 코멘트"* 와는 철학이 다르고, **둘은 경쟁이 아니라 상호보완**이다.

---

## 1. OLV 웹 캡처 모델 (실제 소스, verbatim)

### 1.1 캡처 훅 — `hooks/utils/use-media-capture.tsx`

```ts
interface ImageData { source: 'camera' | 'screen'; data: string; mime_type: string; }  // :22-26

const captureFrame = async (stream, source) => {                       // :55-99
  const videoTrack = stream.getVideoTracks()[0];
  const imageCapture = new ImageCapture(videoTrack);
  const bitmap = await imageCapture.grabFrame();                       // 단일 프레임 grab
  const canvas = document.createElement('canvas');
  let { width, height } = bitmap;
  const maxWidth = getImageMaxWidth();                                 // 설정값
  if (maxWidth > 0 && width > maxWidth) { height = (maxWidth/width)*height; width = maxWidth; }
  canvas.width = width; canvas.height = height;
  ctx.drawImage(bitmap, 0, 0, width, height);
  return canvas.toDataURL('image/jpeg', getCompressionQuality());     // JPEG data URL
};

const captureAllMedia = async () => {                                  // :101-131
  const images: ImageData[] = [];
  if (cameraStream) { const f = await captureFrame(cameraStream,'camera'); if(f) images.push({source:'camera',data:f,mime_type:'image/jpeg'}); }
  if (screenStream) { const f = await captureFrame(screenStream,'screen'); if(f) images.push({source:'screen',data:f,mime_type:'image/jpeg'}); }
  return images;                                                       // 한 턴에 [camera?, screen?]
};
```

이미지 설정 (`hooks/sidebar/setting/use-general-settings.ts:12-15`):
```ts
DEFAULT_IMAGE_COMPRESSION_QUALITY = 0.8   // JPEG 품질 (0.1~1.0), localStorage 'appImageCompressionQuality'
DEFAULT_IMAGE_MAX_WIDTH          = 0      // 0=다운스케일 없음, >0이면 그 폭으로 축소, 'appImageMaxWidth'
```
> 즉 OLV는 다운스케일+JPEG압축 훅을 내장(비용 제어). 단 기본값은 무축소·품질0.8. (Electron 화면
> 스트림 자체는 1280×720 고정으로 잡음 — §3 참조 — 그래서 maxWidth 0이어도 과대하진 않다.)

### 1.2 송신 지점 3곳 — 모든 턴이 캡처를 첨부

```ts
// 텍스트  hooks/footer/use-text-input.tsx:29-35
const images = await captureAllMedia();
wsContext.sendMessage({ type: 'text-input', text: inputText.trim(), images });

// 음성    hooks/utils/use-send-audio.tsx:25-26  (오디오는 mic-audio-data 청크 후)
const images = await captureAllMedia();
sendMessage({ type: 'mic-audio-end', images });

// 프로액티브 hooks/utils/use-trigger-speak.ts:11-16
const images = await captureAllMedia();
sendMessage({ type: 'ai-speak-signal', idle_time: actualIdleTime, images });
```

`images` 원소 형태(= 1차 §1.2의 백엔드 `ImageData`와 정확히 일치):
```json
{ "source": "screen", "data": "data:image/jpeg;base64,/9j/4AAQ…", "mime_type": "image/jpeg" }
```

### 1.3 스트림 수명주기 — 토글로 1회 open, 유지

- **화면** `context/screen-capture-context.tsx`: `startCapture()`로 스트림 획득 후 React state에 보관,
  `stopCapture()`가 `track.stop()` 할 때까지 **계속 살아있음**. 매 턴엔 그 스트림에서 `grabFrame`만.
- **카메라** `context/camera-context.tsx`: `useRef`에 스트림 보관, 기본 320×240, `stopCamera()`까지 유지.
- 핵심: **스트림은 한 번만 열고(권한 1회), 프레임은 턴마다 즉석 추출**. (Geny 경로 A와 동일한 발상.)

---

## 2. OLV 프로액티브(자발 발화) — 프론트 idle 타이머

`context/proactive-speak-context.tsx`:
```ts
defaultSettings = { allowProactiveSpeak:false, idleSecondsToSpeak:5, allowButtonTrigger:false }; // :19-23

useEffect(() => {                                       // :59-65
  if (aiState === AiStateEnum.IDLE) startIdleTimer();   // AI가 쉬면 타이머 시작
  else clearIdleTimer();                                // 말하거나 들으면 취소
}, [aiState]);

startIdleTimer = () => {                                // :47-57
  if (!settings.allowProactiveSpeak) return;
  idleTimer = setTimeout(() => {
    sendTriggerSignal((Date.now()-start)/1000);         // → captureAllMedia + ai-speak-signal
  }, settings.idleSecondsToSpeak * 1000);
};
```
설정 UI (`components/sidebar/setting/agent.tsx:25-44`): allowProactiveSpeak 스위치, idleSecondsToSpeak
숫자(min0, step0.1, allowProactiveSpeak일 때만 노출), allowButtonTrigger 스위치.

> OLV 프로액티브 = **순전히 프론트 주도**: "AI가 N초간 할 일 없으면, 지금 화면/카메라 보고 먼저
> 말 걸어." 백엔드는 `ai-speak-signal` 받으면 `proactive_speak_prompt`로 1턴 생성(1차 §1.5).
> 게이트·쿨다운·민감정보 가드 **없음**(기본 5초라 매우 수다스러움).

---

## 3. OLV Electron 데스크톱 펫 모드 — 우리 커넥터와 직접 비교

OLV-Web은 Electron(main/preload/renderer) + React. **펫 모드 = 투명·항상위·클릭스루 아바타 오버레이**로
우리 Geny 커넥터 overlay와 같은 목적/구조다. 차용할 디테일이 많다.

### 3.1 화면 소스 선택 — desktopCapturer 자동선택(피커 없음)

```ts
// main/index.ts:70-73
ipcMain.handle('get-screen-capture', async () => {
  const sources = await desktopCapturer.getSources({ types: ['screen'] });
  return sources[0].id;                 // ★ 주 화면 자동선택, 피커 UI 없음
});

// context/screen-capture-context.tsx:25-44  (Electron 분기)
const sourceId = await window.electron.ipcRenderer.invoke('get-screen-capture');
mediaStream = await navigator.mediaDevices.getUserMedia({
  video: { mandatory: { chromeMediaSource:'desktop', chromeMediaSourceId: sourceId,
                        minWidth:1280, maxWidth:1280, minHeight:720, maxHeight:720 } },
  audio: false,
});
// 브라우저 분기: getDisplayMedia({video:true})  (권한/피커 프롬프트)
```
- **권한도 main에서 자동 허용**: `session.setPermissionRequestHandler('media' → callback(true))` (main/index.ts:125-133).
- 즉 **Electron에선 화면 공유 프롬프트가 0번** — 켜는 순간 주 화면을 바로 잡는다.

> ✅ Geny 대응: 우리 `ConnectorBridgeClient.grabFrame`은 이미 `chromeMediaSource:'desktop'`을 쓴다
> (커넥터 capability). 하지만 경로 A(프로액티브 화면관찰)는 브라우저 `getDisplayMedia`(프롬프트)를
> 쓴다. **OLV처럼 커넥터 환경에선 desktopCapturer 자동선택으로 일원화하면 프롬프트가 사라진다.**

### 3.2 펫 모드 윈도우 구성 (`main/window-manager.ts`)

```ts
new BrowserWindow({ transparent:true, frame:false, hasShadow:false, ... })   // :56-78
setWindowModePet():                                                          // :187-241
  setBackgroundColor('#00000000');
  setAlwaysOnTop(true, 'screen-saver');
  // 모든 디스플레이를 덮는 가상 화면 bounds 계산 → 멀티모니터 드래그 지원
  setBounds({x:minX,y:minY,width:combinedW,height:combinedH});
  setResizable(false); setSkipTaskbar(true); setFocusable(false);
  setIgnoreMouseEvents(true, { forward:true });   // (mac은 forward 없이)
```

### 3.3 클릭스루를 컴포넌트 단위로 — `updateComponentHover`

OLV는 "바 hover" 한 곳이 아니라 **모든 인터랙티브 컴포넌트가 자기 hover를 main에 보고**한다:
```ts
// renderer use-draggable.ts: onMouseEnter→ window.api.updateComponentHover(id,true)
// main/window-manager.ts:284-307
updateComponentHover(id, hovering) {
  if (currentMode==='window' || forceIgnoreMouse) return;
  hovering ? hoveringComponents.add(id) : hoveringComponents.delete(id);
  const shouldIgnore = hoveringComponents.size === 0;
  setIgnoreMouseEvents(shouldIgnore, {forward:true});   // 아무것도 hover 안 하면 클릭스루
  if (!shouldIgnore) setFocusable(true);
}
```
추가로 **"마우스 통과 강제 토글"**(`toggleForceIgnoreMouse`, 트레이/컨텍스트 메뉴)로 사용자가
완전 클릭스루를 잠글 수 있다.

> ✅ Geny 대응: 우리 overlay는 `onBarEnter/Leave`로 바 영역만 입력을 켠다(단순). OLV식 컴포넌트
> hover 집합 방식은 **여러 인터랙티브 요소(여러 버튼/입력)**가 생길 때 더 견고. 현재는 과해서
> 굳이 당장 도입할 필요는 없으나, 컨트롤이 늘면 차용 가치.

### 3.4 preload 브리지 표면 (요약, `preload/index.ts`)

`window.api`: setIgnoreMouseEvents, toggleForceIgnoreMouse, onForceIgnoreMouseChanged,
showContextMenu, onModeChanged/setMode, onMicToggle/onInterrupt/onToggleInputSubtitle,
updateComponentHover, onSwitchCharacter, getConfigFiles/updateConfigFiles.
`window.electron`: desktopCapturer.getSources, ipcRenderer.{invoke,on,send,…}, process.platform.

> 우리 커넥터 preload(`window.connector`)와 1:1로 매핑됨(windowControl/capture/actuate/hotkeys/updater).
> OLV엔 **자동업데이트가 없다** — 우리(electron-updater)가 우위.

---

## 4. 두 캡처 철학 — 비교와 통합 관점

| 축 | **OLV: 턴-첨부(conversational)** | **Geny 현재: 주변-게이트(ambient)** |
|---|---|---|
| 언제 | 사용자/AI가 말하는 그 순간 | 백그라운드 3분 주기 |
| 무엇을 LLM에 | **실제 이미지**(+텍스트) | **vision 캡션 텍스트만** |
| 트리거 게이트 | 없음(보내면 매번) | vision-caption 성공 + 쿨다운 |
| 침묵/민감가드 | 없음 | `[SILENT]` + 민감정보 프롬프트 |
| 비용 | 턴마다 이미지 토큰 | 캡션 1회(저렴), 트리거만 LLM |
| 좋은 상황 | "이거 봐봐", 실시간 협업 | 곁에서 지켜보다 먼저 말 걸기 |
| 약점 | 수다·비용·프라이버시 노출↑ | 페르소나가 픽셀을 못 봄(정보손실) |

**결론: 둘 다 필요하다.** 대화 맥락엔 OLV식 턴-첨부, 주변 인지엔 Geny식 게이트 — 그리고 **양쪽 모두
페르소나가 실제 픽셀을 보게**(1차 핵심) 한다. 비용/프라이버시는 Geny식 게이트·다운스케일·옵션으로 억제.

---

## 5. 정정·보강된 통합 설계

### 5.1 변하지 않는 핵심 (1차에서 재확인)

페르소나가 픽셀을 보려면 **executor의 기존 멀티모달 `attachments` 채널**을 쓴다. 이미 검증됨:
`execute_command(..., attachments=[{"kind":"image","mime_type":..,"data":<b64>|"url":"file://"}])`
→ s01 `MultimodalNormalizer` 자동 변환 → Anthropic image 블록 → s18 dehydrate. **신규 인프라 0.**
(상세: 1차 §2.3, §5, §9)

### 5.2 트랙 A — 대화 턴에 화면/카메라 첨부 (OLV 모델 이식)

OLV의 `captureAllMedia()→sendMessage({…images})` 를 Geny 구조에 매핑:

```
[overlay/제어판] 사용자 텍스트 or PTT 음성
   → (캡처) 데스크톱이면 connector.capture screen_capture (chromeMediaSource, 무프롬프트)
            브라우저면 getDisplayMedia/카메라 getUserMedia (OLV 브라우저 분기와 동일)
   → JPEG 다운스케일(품질·최대폭, OLV use-general-settings 그대로 차용)
   → chatApi.broadcastToRoom(roomId, { message, attachments:[{kind:'image',mime_type,data}] })
        ↓  (백엔드는 이미 attachments 처리: chat_controller → execute_command → executor 멀티모달)
   → 페르소나가 화면+텍스트 동시 인식 → TTS
```
- **백엔드 변경 거의 없음** — broadcast의 attachments 경로가 이미 존재(1차 §2.3).
- 프론트에 "이 화면 보며 말하기" 토글 + (선택)카메라 토글. OLV처럼 source enum(screen/camera) 표기.

### 5.3 트랙 B — 주변 인지(프로액티브)에 실제 이미지 (Geny 게이트 유지)

1차 Phase 1 그대로: `screen_observation._run_trigger`의 `execute_command`에 `attachments` 추가.
**caption은 게이트(쿨다운·민감 1차스캔)로 유지 + 실제 이미지 동봉** → 페르소나가 픽셀까지 봄.
OLV식 무게이트 난사 대신 Geny식 절제 유지.

### 5.4 트랙 C — (선택) OLV식 프론트 idle 프로액티브

Geny엔 현재 "주기 캡처"는 있어도 "AI가 idle이면 먼저 말 걸기"는 없다. OLV
`proactive-speak-context`(idle 타이머 → ai-speak-signal)를 차용:
- 프론트 타이머(아바타 idle N초) → 화면 캡처 첨부 → broadcast(또는 trigger 프롬프트).
- config: `allowProactiveSpeak`(기본 off), `idleSecondsToSpeak`(기본 30~60 권장, OLV 5초는 과함).
- Geny엔 이미 backend trigger(execute_command is_trigger)가 있으니, 프론트는 신호만 주는 얇은 층.

### 5.5 트랙 D — 커넥터 캡처 일원화 + 프롬프트 제거

- 커넥터 환경: 경로 A(getDisplayMedia 프롬프트) → **OLV식 desktopCapturer 자동선택**으로 교체
  (우리 ConnectorBridgeClient가 이미 chromeMediaSource 사용 → main에 `get-screen-capture` 등가 추가).
- media 권한 auto-grant은 우리 main에 이미 `setPermissionRequestHandler('media')` 존재(중복 점검).

---

## 6. 갱신된 로드맵 (1차 Phase 재배열)

| 순서 | 트랙 | 내용 | 변경 규모 |
|---|---|---|---|
| **P0** | B | 화면관찰 트리거에 실제 이미지 첨부 (1차 Phase1) | 백엔드 1함수 |
| **P1** | A | 대화 턴(텍스트/음성)에 화면 첨부 (broadcast attachments) | 프론트 위주 |
| **P1** | A | 캡처 다운스케일/품질 설정 차용(OLV use-general-settings) | 프론트 유틸 |
| **P2** | D | 커넥터 캡처를 desktopCapturer 자동선택으로 일원화(무프롬프트) | main+preload+overlay |
| **P2** | A | 카메라 입력 지원(선택) + source enum 표준화 | 프론트+attachment meta |
| **P2** | — | 모델 vision 능력 게이팅 + caption 폴백 | 백엔드 |
| **P3** | C | OLV식 idle 프로액티브(프론트 타이머) | 프론트 얇은 층 |
| **P3** | D | 컴포넌트 단위 클릭스루(updateComponentHover) — 컨트롤 증가 시 | main+renderer |

> 권장 착수: **P0(픽셀 인지 즉시 확보) → P1(대화 턴 화면첨부, 체감 큰 기능)** 순.

---

## 7. 결정 필요 사항 (02 추가분)

| # | 이슈 | 선택지 | 권고 |
|---|---|---|---|
| R1 | 대화 턴 기본 캡처 | (a)항상 자동첨부(OLV식) (b)토글 on일 때만 | **(b)** 프라이버시·비용. OLV는 (a)지만 스트림 toggle이 곧 동의 |
| R2 | 카메라 입력 | 지원 / 화면만 | 1차는 **화면만**, 카메라는 P2 옵션 |
| R3 | idle 프로액티브 | 도입 / 보류 | **P3 보류**(Geny 주변-게이트가 이미 준-프로액티브) |
| R4 | 이미지 기본 품질/폭 | OLV식 노출(품질0.8/폭0) | 폭 **~1280 캡**(토큰 절감), 품질 0.7~0.8, config 노출 |
| R5 | 트랙 A 전송 경로 | broadcast attachments(기존) vs 신규 | **기존 broadcast** 재사용(무신설) |
| R6 | desktop_glance | caption→이미지(1차 Phase3) | executor tool-result 멀티모달 지원 확인 후 |

---

## 8. 파일 인덱스 (OLV-Web ↔ Geny 대응)

| 기능 | OLV-Web (`reference_data/Open-LLM-VTuber-Web-src`) | Geny 대응 |
|---|---|---|
| 프레임 캡처 | `src/renderer/src/hooks/utils/use-media-capture.tsx` | `frontend/.../ConnectorBridgeClient.tsx` grabFrame, `lib/useScreenObservation.ts` |
| 턴 송신 | `hooks/footer/use-text-input.tsx`, `hooks/utils/use-send-audio.tsx`, `use-trigger-speak.ts` | `lib/api.ts` broadcastToRoom, `PushToTalkDriver.tsx`, `VTuberChatPanel` |
| 화면 스트림 | `context/screen-capture-context.tsx` | `lib/useScreenObservation.ts` (브라우저), 커넥터 capability(데스크톱) |
| 카메라 | `context/camera-context.tsx` | (없음 — 신규) |
| 프로액티브 | `context/proactive-speak-context.tsx`, `setting/agent.tsx` | `screen_observation.py`(백엔드 주기) |
| 이미지 설정 | `hooks/sidebar/setting/use-general-settings.ts` | (없음 — 신규, 차용) |
| WS 송수신 | `services/websocket-service.tsx`, `websocket-handler.tsx` | `lib/api.ts` makeAuthedWs, vtuber WS |
| Electron main | `src/main/index.ts`, `window-manager.ts`, `menu-manager.ts` | `desktop/src/main/index.ts` |
| 화면소스 IPC | `main/index.ts` `get-screen-capture` + preload desktopCapturer | `desktop/src/main` capture:list-sources, ConnectorBridgeClient |
| preload 브리지 | `src/preload/index.ts` (`window.api`/`window.electron`) | `desktop/src/preload/index.ts` (`window.connector`) |
| 펫/오버레이 모드 | `window-manager.ts` setWindowModePet | `desktop/src/main` applyOverlayContent + overlay |
| WS 인바운드(립싱크) | `websocket-handler.tsx` `audio`(base64+volumes) | 우리 TTS 턴(useVTuberStore) |

---

## 9. 결론

실제 웹 소스 확인으로 OLV의 본질이 분명해졌다: **"대화 맥락에 그 순간의 화면을 묶어 페르소나가
픽셀을 본다"**, 그리고 그것을 **턴-시점 캡처 + 모든 턴 첨부**로 구현한다. Geny는 이미 (1) 멀티모달
executor 채널, (2) 커넥터 화면 캡처(chromeMediaSource), (3) broadcast attachments 경로, (4) 주변-인지
트리거를 갖고 있으므로 — **OLV의 턴-첨부 모델(트랙 A)을 broadcast attachments로 이식**하고,
**Geny의 게이트형 주변 인지(트랙 B)에 실제 이미지를 더하면**, OLV보다 비용·프라이버시는 절제되면서
픽셀 인지는 동등 이상인 화면 인지 VTuber가 된다. 착수는 P0(트리거 픽셀) → P1(대화 턴 화면첨부).
```
