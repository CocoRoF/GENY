# 화면 캡처 → VTuber 대화 생성 메커니즘: 분석 & Geny 통합 리포트

> 작성일: 2026-06-14
> 레퍼런스: `/home/geny-workspace/reference_data/Open-LLM-VTuber` (이하 **OLV**, 백엔드)
> 대상: Geny (`/home/geny-workspace/Geny`) backend + frontend + desktop connector + geny-executor 2.2.0
> 상태: **분석 전용 (코드 미수정).** 본 문서는 구현 합의를 위한 설계 리포트다.
>
> ⚠️ **갱신 안내(필독):** 본 1차 문서는 OLV **백엔드만** 분석했다. 당시 웹 프론트는 submodule이
> `build`(minified) 브랜치라 캡처 *타이밍*을 백엔드 계약에서 역산해 "주기/온디맨드"라고 **추정**했다.
> 이후 실제 웹 소스(`Open-LLM-VTuber-Web` main)를 클론해 확인한 결과, OLV는 **주기 캡처가 아니라
> "대화 턴(텍스트/음성/프로액티브) 발생 시점에 1프레임 캡처→그 턴에 첨부"** 모델이었다.
> 정정·보강은 **[02-web-client-and-revised-integration.md](02-web-client-and-revised-integration.md)** 참조.
> 단, **핵심 결론(executor 멀티모달 `attachments` 채널 재사용)은 그대로 유효**하다.

---

## 0. TL;DR — 한 문장 결론

**우리는 이미 필요한 조각을 전부 갖고 있다.** 화면 캡처(2경로), vision 캡션, 프로액티브 트리거,
그리고 무엇보다 **geny-executor 2.2.0 안에 완전한 멀티모달 파이프라인**(s01 입력 정규화 → Anthropic
image 블록 → s18 메모리 dehydrate)이 살아있다. 그런데 화면관찰 트리거만은 페르소나 LLM에게
**실제 이미지를 주지 않고, 별도 vision 모델이 만든 "캡션 텍스트"만** 넘긴다.

OLV가 가르쳐 주는 핵심은 단 하나 — **페르소나가 픽셀을 직접 본다**(multimodal `image_url` 블록).
따라서 이 작업의 본질은 *새 인프라 구축*이 아니라, **이미 존재하는 멀티모달 `attachments`
채널(채팅 업로드가 이미 쓰는 그 길)로 캡처 프레임을 흘려보내는 "배선"** 이다. 그 위에
OLV의 깔끔한 패턴(턴마다 이미지 첨부, `ImageSource` 출처, proactive-speak)을 흡수하고,
Geny가 이미 가진 강점(쿨다운, `[SILENT]`, 민감정보 가드, 캡션 기반 트리거 게이트, 데스크톱
커넥터 캡처, 세션별 마크다운 메모리)은 그대로 살린다.

---

## 1. 레퍼런스 분석 — Open-LLM-VTuber

OLV는 "AI가 너와 너의 화면을 본다"를 핵심 기능으로 광고한다
(`README.md:72` — *"👁️ Visual perception, supporting camera, screen recording and screenshots"*).
중요한 구조적 사실: **캡처는 100% 프론트엔드(웹) 책임이고, 백엔드는 stateless 수신기**다.
프론트엔드는 git submodule(`Open-LLM-VTuber-Web`, `.gitmodules`)이라 본 분석에서는
백엔드 프로토콜 + 데이터 흐름 + 프롬프트만 확인 가능(프론트 캡처 타이밍은 백엔드 계약에서 역산).

### 1.1 데이터 흐름 (프론트 → WS → LLM)

```
[Frontend captures screen/camera frame]
   → base64 data URL ("data:image/png;base64,…")
   → WS message { type, text?, images:[{source,data,mime_type}] }
        ↓  websocket_handler._handle_conversation_trigger
   → images = data.get("images")
        ↓  conversation_utils.create_batch_input(text, images, …)
   → BatchInput{ texts:[TextData], images:[ImageData{source,data,mime_type}], metadata }
        ↓  agent_engine.chat(batch_input)   (single/group_conversation)
   → BasicMemoryAgent._to_messages()  → OpenAI-style content blocks
        [ {"type":"text","text":…}, {"type":"image_url","image_url":{"url":"data:…","detail":"auto"}} ]
        ↓  stateless_llm (Claude/OpenAI/Ollama)
   → Claude: image_url → {"type":"image","source":{"type":"base64","media_type":…,"data":…}}
   → OpenAI/Ollama: 그대로 전달 (네이티브 data URL 지원)
```

### 1.2 핵심 데이터 구조 (`src/open_llm_vtuber/agent/input_types.py`)

```python
# input_types.py:6-13
class ImageSource(Enum):
    CAMERA = "camera"
    SCREEN = "screen"
    CLIPBOARD = "clipboard"
    UPLOAD = "upload"

# input_types.py:22-36
@dataclass
class ImageData:
    source: ImageSource
    data: str        # Base64 encoded ("data:image/…;base64,…") or URL
    mime_type: str

# input_types.py:76-95
@dataclass
class BatchInput(BaseInput):
    texts: List[TextData]
    images: Optional[List[ImageData]] = None
    files: Optional[List[FileData]] = None
    metadata: Optional[Dict[str, Any]] = None
    #   metadata flags: proactive_speak / skip_memory / skip_history
```

### 1.3 텍스트+이미지 조립 (`conversations/conversation_utils.py:20-42`)

```python
def create_batch_input(input_text, images, from_name, metadata=None) -> BatchInput:
    return BatchInput(
        texts=[TextData(source=TextSource.INPUT, content=input_text, from_name=from_name)],
        images=[ImageData(source=ImageSource(img["source"]), data=img["data"],
                          mime_type=img["mime_type"]) for img in (images or [])] if images else None,
        metadata=metadata,
    )
```
호출: `single_conversation.py:63-68`, `group_conversation.py:249-254`. 그룹은 **모든 멤버가 동일 이미지** 수신.

### 1.4 LLM 멀티모달 메시지 (`agent/agents/basic_memory_agent.py:242-288`)

```python
def _to_messages(self, input_data: BatchInput):
    messages = self._memory.copy()
    user_content = []
    text_prompt = self._to_text_prompt(input_data)        # 225-240
    if text_prompt:
        user_content.append({"type": "text", "text": text_prompt})
    if input_data.images:
        for img in input_data.images:
            if isinstance(img.data, str) and img.data.startswith("data:image"):
                user_content.append({"type": "image_url",
                                     "image_url": {"url": img.data, "detail": "auto"}})
    if user_content:
        messages.append({"role": "user", "content": user_content})
        if not (metadata and metadata.get("skip_memory")):
            self._add_message(text_prompt or "[User provided image(s)]", "user")  # 텍스트만 메모리에
    return messages
```

Claude 변환 (`agent/stateless_llm/claude_llm.py:43-82`):
```python
# data:image/jpeg;base64,/9j/… → 분해
header, base64_data = data_url.split(",", 1)
media_type = header.split(":")[1].split(";")[0]    # "image/jpeg"
{"type": "image", "source": {"type": "base64", "media_type": media_type, "data": base64_data}}
```
OpenAI/Ollama 경로는 `image_url` data URL을 그대로 전달(변환 없음).

### 1.5 프로액티브(능동 발화) — `ai-speak-signal`

OLV 전체 WS 메시지 타입 (`websocket_handler.py:32-46`):
```
CONVERSATION = ["mic-audio-end", "text-input", "ai-speak-signal"]   ← 턴 트리거 3종
GROUP / HISTORY / CONFIG / CONTROL(interrupt-signal,audio-play-start) / DATA(mic-audio-data) / heartbeat
```

`ai-speak-signal` 처리 (`conversations/conversation_handler.py:35-64`):
```python
if msg_type == "ai-speak-signal":
    user_input = prompt_loader.load_util(tool_prompts["proactive_speak_prompt"])
    metadata = {"proactive_speak": True, "skip_memory": True, "skip_history": True}
    images = data.get("images")     # ← 프로액티브에도 이미지 첨부 가능
```
프롬프트 (`prompts/utils/proactive_speak_prompt.txt`):
> `Please say something that would be engaging and appropriate for the current context.`

**중요:** 능동 발화의 *타이밍(언제 쏠지)* 은 프론트엔드 타이머/유휴감지 책임이다. 백엔드엔
내장 타이머가 없다(`hume_ai_agent.idle_timeout:15` 는 커넥션 종료용이지 발화 트리거 아님).

### 1.6 OLV가 **하지 않는** 것 (= Geny가 이미 더 나은 부분)

| 항목 | OLV |
|---|---|
| 서버측 캡처 | ❌ 없음 (프론트가 다 함) |
| 트리거 게이트/쿨다운 | ❌ 없음 (보내면 매번 LLM 호출) |
| 민감정보(비밀번호/키) 가드 | ❌ 없음 |
| 침묵 옵션 | ❌ 없음 (항상 발화) |
| vision 캡션 사전요약 | ❌ 없음 (풀 이미지 직행) |
| 이미지 히스토리 보존 | ❌ 텍스트 placeholder만 (`basic_memory_agent.py:128-174`) |
| 모델 vision 능력 게이팅 | ❌ 없음 (지원 가정하고 전송) |

---

## 2. Geny 현재 상태 분석

Geny에는 화면 캡처 경로가 **두 개**, 그리고 멀티모달 LLM 경로가 **하나(채팅 업로드)** 있는데,
화면 캡처 두 경로 모두 페르소나 LLM에는 **캡션 텍스트만** 닿는다.

### 2.1 캡처 경로 A — 프로액티브 화면관찰 (3분 주기)

```
ScreenObservationControls.tsx (오버레이 토글, 초록불)
   → useScreenObservation.ts
        getDisplayMedia() 1회 권한 → 스트림 유지            (234-240)
        첫 캡처 즉시 + setInterval(180_000ms) 반복           (275-279)
        _captureFrameAsBlob: video→canvas→PNG Blob          (78-108)
        vtuberApi.uploadScreenObservation(sessionId, blob)  (162-167)
   → POST /api/vtuber/screen-observation/upload
        ↓  backend/service/vtuber/screen_observation.py
   save_and_maybe_trigger():                                 (239-337)
        image_path.write_bytes()                # 디스크 저장 (per-session storage)
        caption, vision_source = _caption_image(bytes)       (281-283 → 210-233)
        _write_observation_note()               # 마크다운 사이드카(메모리 자산)
        if vision_source!="vision": skip("no_real_caption")  # 캡션 게이트 (305)
        쿨다운 슬롯 claim (force_trigger=Show Now 시 우회)     (311-318)
        _run_trigger(caption, image_path)                    (320-337)
```

`_run_trigger` (`screen_observation.py:372-419`) — **여기가 문제의 핵심**:
```python
prompt = _compose_prompt(caption=caption, observation_id=…, captured_at=…)   # 캡션을 텍스트로 삽입
result = await execute_command(session_id, prompt, is_trigger=True, timeout=180)
#                                                  └── attachments 없음! 이미지 미전달
_save_trigger_response_to_chat(...)   # [SILENT]/빈 출력 가드 후 채팅방에 미러링
```

`_compose_prompt` (`343-369`)는 caption(600자 컷)을 JSON payload + 한국어 행동규칙으로 감싼다.
규칙에 이미 **`[SILENT]` 침묵 토큰**, **민감정보 회피("비밀번호/API키/결제정보는 입에 올리지 마라")**,
**"공유받은 게 아니라 옆에서 본 것"** 페르소나 톤이 들어있다 — 이건 OLV에 없는 Geny의 강점.

> **확정:** 페르소나 LLM은 화면 픽셀을 절대 못 본다. 별도 vision 모델
> (`tools/custom/whiteboard_tools._try_vision_describe`)이 만든 **캡션 텍스트**만 읽는다.

### 2.2 캡처 경로 B — 온디맨드 `desktop_glance` (에이전트 툴, 데스크톱 커넥터)

```
ConnectorBridgeClient.tsx (오버레이, 데스크톱 전용)
   grabFrame(): getUserMedia chromeMediaSource=desktop → canvas → {image_b64,mime,source_name}  (23-52)
   /ws/connector/{sid} 로 capability 광고: [...,'screen_capture',...]                            (124)
        ↑ capability_call
   backend/service/executor/connector_bridge.py
   DesktopGlanceTool.execute():                                                                   (90-126)
        conn.capability_call("screen_capture") → image_b64
        raw = b64decode(...)
        caption, _ = _caption_image(raw, mime)           # ← 또 캡션화
        return "[desktop glance — {label}] {caption}"     # ← 에이전트는 캡션 텍스트만 받음
```
역시 **캡션 only.** 에이전트가 "저 버튼이 시각적으로 왜 깨졌어?" 같은 픽셀 추론을 할 수 없다.

### 2.3 이미 작동하는 멀티모달 경로 — 채팅 업로드 (★ 재사용 대상)

```
사용자 파일 첨부 → POST /api/chat/rooms/{room}/broadcast (attachments)        chat_controller.py:458-614
   _rewrite_local_attachment_url: /static/uploads/… → file:///abs/path        (50-96)
   _run_broadcast → execute_command(session_id, message, is_chat_message=True,
                                    attachments=attachments)                    (788-793)
        ↓
   agent_session.py: attachments = kwargs.pop("attachments")                    (2979)
        if attachments: pipeline_input = {"text":…, "attachments":[…]}          (2777-2783)
        await self._pipeline.run_stream(pipeline_input, state)                  (2784)
        ↓  geny-executor 2.2.0
   s01 DefaultNormalizer: dict에 images/files/attachments 있으면
        → MultimodalNormalizer 자동 위임                                          (normalizers.py:79-82)
   MultimodalNormalizer: 관대한 입력 형태 허용                                     (93-211)
        {"kind":"image","mime_type":"image/png","data":"<b64>"}         # base64 인라인
        {"kind":"image","mime_type":"image/png","url":"file:///abs.png"}# file:// → 자동 b64 인라인
        → Anthropic image content block {"type":"image","source":{"type":"base64",…}}
   s18 memory dehydrate: 히스토리에는 base64 raw payload 제거(수MB 절약)          (_dehydrate.py)
```

`execute_command` 시그니처 (`agent_executor.py:1314`)는 `is_trigger`, `timeout`, `**invoke_kwargs`를
받고 invoke_kwargs가 `attachments`까지 그대로 흐른다. **즉 멀티모달 인프라는 전부 준비됐고,
화면 트리거가 이 채널을 안 쓰고 있을 뿐이다.**

### 2.4 턴 생성 라이프사이클 (참고 — 음성 패턴이 화면의 본보기)

```
음성:  PushToTalkDriver → sttApi.transcribe(blob) → chatApi.broadcastToRoom(roomId,{message})
텍스트: VTuberChatPanel → 동일 broadcast
       → 백엔드 _run_broadcast → execute_command → 에이전트 스트림
프론트 TTS 턴: beginTTSTurn → pushStreamingText(문장단위 /speak/chunks) → finalizeTTSTurn
       (useVTuberStore.ts: 555-574, 588-647, 657-719)
```
화면 캡처는 음성과 **같은 모양**(외부 신호 → broadcast/trigger → 에이전트 → TTS)을 따르면 된다.

---

## 3. 비교표 (OLV ↔ Geny)

| 차원 | Open-LLM-VTuber | Geny (현재) | 시사점 |
|---|---|---|---|
| 캡처 위치 | 프론트(웹)만 | 프론트(getDisplayMedia) + 데스크톱 커넥터(chromeMediaSource) | Geny 우위(커넥터=무프롬프트) |
| 페르소나가 보는 것 | **실제 이미지(픽셀)** | **캡션 텍스트만** | ★ 핵심 격차 |
| 멀티모달 파이프라인 | agent가 직접 content block 조립 | **executor s01/s18에 내장** | Geny가 더 견고(자동 dehydrate) |
| 트리거 게이트 | 없음 | vision-caption 성공 시에만 + 쿨다운 | Geny 우위(비용/소음 제어) |
| 침묵 | 없음 | `[SILENT]` 토큰 | Geny 우위 |
| 민감정보 가드 | 없음 | 프롬프트 규칙 내장 | Geny 우위 |
| 능동 발화 | `ai-speak-signal`(프론트 타이머) | 화면 트리거가 사실상 능동발화 / 별도 idle 타이머 없음 | OLV 패턴 흡수 여지 |
| 이미지 출처 메타 | `ImageSource`(camera/screen/clipboard/upload) | attachment `_meta`(name/sha…) 있으나 source enum 부재 | OLV 패턴 흡수 |
| 이미지 히스토리 | 텍스트 placeholder | s18 dehydrate(블록 유지+payload 제거) | Geny 우위 |
| 모델 vision 게이팅 | 없음 | 없음 | 둘 다 보완 필요 |
| 턴당 이미지 | 모든 턴(텍스트/음성/능동) | 화면관찰 트리거에서만(그나마 캡션) | 사용자/음성 턴에도 첨부 가능케 |

---

## 4. 갭 분석 — 무엇이 빠졌나

1. **[P0] 페르소나가 픽셀을 못 본다.** 화면관찰 트리거(`_run_trigger`)와 `desktop_glance`가
   `execute_command`/툴 리턴에 **실제 이미지를 안 싣는다.** caption은 정보 손실(작은 UI 텍스트,
   레이아웃, 색/에러 표식, 코드 디테일을 vision 요약이 날림)이 크다.
2. **[P1] 사용자/음성 턴에 화면을 못 붙인다.** "이거 봐봐"라고 말할 때 현재 화면을 그 턴에
   첨부하는 경로가 없다(OLV는 모든 턴에 `images` 첨부 가능).
3. **[P1] `desktop_glance` 툴이 캡션만 반환.** 에이전트의 시각 추론 능력을 거세한다.
4. **[P2] 능동 발화(idle) 신호 부재.** 화면이 안 바뀌어도 적막을 깨는 OLV식 `ai-speak-signal`이 없다.
   (단, Geny는 화면관찰 자체가 준-능동발화라 우선순위 낮음.)
5. **[P2] 이미지 출처/프로비넌스 일관성.** `ImageSource`(screen/camera/clipboard/window) 표준 부재.
6. **[P2] 모델 vision 능력 게이팅 부재.** vision 미지원 모델에 이미지 전송 시 실패/낭비.
7. **[P3] 캡처 소스 이원화.** 경로 A(getDisplayMedia, 권한 프롬프트)와 B(커넥터, 무프롬프트)가
   따로 논다. 커넥터 환경에선 B로 일원화하면 UX가 매끄럽다.

---

## 5. 통합 설계 — "Geny에 녹여내기"

### 5.1 설계 원칙

- **P1. 기존 멀티모달 채널 재사용, 병렬 경로 신설 금지.** 캡처 프레임을 채팅 업로드가 쓰는
  바로 그 `execute_command(..., attachments=[…])` 채널로 흘린다. executor가 정규화/인라인/
  dehydrate를 전담(이미 검증됨). → **신규 인프라 0.**
- **P2. caption은 버리지 말고 "게이트 + 듀얼 신호"로 강등.** OLV는 게이트가 없어 매 프레임이
  LLM을 때린다. Geny는 (a) 싸고 빠른 vision-caption으로 *발화할 가치/쿨다운/민감정보 1차 스캔* 을
  먼저 하고, (b) 트리거가 실제로 발화하기로 하면 그때 **풀 이미지 + caption을 함께** 페르소나에
  전달. → 비용·소음은 Geny식으로 억제하면서 픽셀 추론은 OLV식으로 획득. **양쪽의 장점만.**
- **P3. executor 일반화로 흡수, 상위 앱에 LLM 어댑터 다층화 금지** (기존 사용자 원칙 준수).
  이미지→블록 변환은 executor s01에 있으니 backend는 "attachment dict"만 만들어 넘긴다.
- **P4. 정책은 config로, 하드코딩 금지** (기존 원칙). 쿨다운/주기/이미지전송 on-off/해상도 상한/
  민감정보 모드는 세션 Environment(매니페스트) 또는 vtuber config로 노출.

### 5.2 OLV에서 흡수할 패턴

- `ImageSource` 출처 enum(screen/camera/clipboard/window/upload) → attachment `_meta.source`로 표준화.
- **모든 턴에 이미지 첨부**: 사용자 텍스트/음성 턴도 "현재 화면 첨부" 옵션.
- proactive-speak 신호(선택): idle 시 화면 없이도 발화.
- `detail:"auto"` 류 품질 힌트 + data URL 단일 표현.

### 5.3 Geny에서 지킬 강점 (그대로 유지)

쿨다운/슬롯, `[SILENT]`, 민감정보 프롬프트 가드, 세션별 디스크 저장 + 마크다운 메모리 사이드카,
데스크톱 커넥터 무프롬프트 캡처, executor s18 dehydrate(히스토리 비대화 방지),
2계층 액추에이션 게이트(이번 작업과 무관하나 동일 커넥터 위에 공존).

### 5.4 목표 데이터 흐름 (After)

```
캡처 프레임(PNG bytes, source=screen|window|camera)
   ├─(싸게) _caption_image → caption + vision_source       # 게이트 & 듀얼신호 & 민감정보 1차스캔
   │     · vision_source!="vision" → skip (현행 유지)
   │     · 쿨다운/force (현행 유지)
   └─(발화 결정 시) execute_command(
            session_id, prompt=_compose_prompt(caption=…),  # 캡션은 페르소나 톤/규칙 유지
            is_trigger=True, timeout=…,
            attachments=[{"kind":"image","mime_type":mime,
                          "data": b64,                       # 또는 "url": image_path.as_uri()
                          "name":observation_id,
                          "_meta":{"source":"screen"}}],     # ← 신규: 픽셀 전달
        )
        ↓ executor s01 MultimodalNormalizer → Anthropic image block (자동)
        ↓ 페르소나 LLM: 텍스트(규칙+caption) + 실제 이미지 동시 입력
        ↓ s18 dehydrate: 히스토리엔 payload 제거
   → _save_trigger_response_to_chat ([SILENT] 가드 현행 유지)
```

`desktop_glance` 툴도 동일 원리로 caption 대신(또는 caption과 함께) 이미지를 에이전트 턴에
주입하도록 일반화 — 단 ToolResult는 텍스트 계약이므로, "툴이 이미지를 다음 LLM 입력에 첨부"
하는 메커니즘은 executor의 멀티모달 tool-result 지원 여부 확인 필요(→ §7 오픈이슈).

---

## 6. 단계별 로드맵 (코드 미작성, 배선 지점만 명시)

### Phase 1 — 화면관찰 트리거에 실제 이미지 (P0, 최소 변경, 최대 효과)
- `screen_observation.py:_run_trigger` (372-419): `execute_command(...)` 호출에
  `attachments=[{"kind":"image","mime_type":mime,"data":b64}]` 추가.
  이미 `image_path`/bytes 보유 → `image_path.as_uri()`(file://)로 넘겨도 executor가 인라인.
- caption은 `_compose_prompt`에 그대로 유지(페르소나 톤·규칙·민감정보 가드 보존).
- config 노출: `vtuber.screen_observation.send_image: true`(기본 on), `max_long_edge_px`(다운스케일 상한).
- **리스크 최소** — 단일 함수 1~2줄 + 다운스케일 유틸. 멀티모달 파이프라인은 검증 완료.

### Phase 2 — 사용자/음성 턴에 "현재 화면 첨부" (P1)
- 프론트: 오버레이/제어판에 "이 화면 보면서 말하기" 토글 또는 PTT 변형.
- 캡처 소스: 데스크톱이면 커넥터 `screen_capture`(무프롬프트), 브라우저면 getDisplayMedia 재사용.
- `chatApi.broadcastToRoom`에 `attachments`(이미 백엔드가 처리하는 형태)로 동봉 → 별도 백엔드 변경 없음.

### Phase 3 — `desktop_glance` 멀티모달화 (P1)
- `connector_bridge.py:DesktopGlanceTool` (90-126): caption-only → 캡션 + (가능하면) 실제 이미지.
- executor의 tool-result 멀티모달 주입 가능 여부 확인 후, 불가하면 "툴은 caption 반환 +
  동일 턴 attachments로 이미지 주입" 우회.

### Phase 4 — 출처 표준화 + 모델 vision 게이팅 (P2)
- attachment `_meta.source` 에 `ImageSource` 표준값(screen/window/camera/clipboard/upload).
- 발화 전 세션 모델의 vision 지원 확인 → 미지원이면 caption-only 폴백(현행 동작) + 1회 경고 로그.

### Phase 5 — 능동 발화(idle) 신호 (P2, 선택)
- OLV `ai-speak-signal` 등가: 유휴 N분 + 화면 변화 없음 → caption 없이도 가벼운 발화.
- config: `proactive_speak.enabled/idle_seconds/prompt`.

### Phase 6 — 캡처 소스 일원화 + 적응형 주기 (P3)
- 커넥터 환경에서 경로 A를 커넥터 캡처로 대체(권한 프롬프트 제거).
- 사용자가 활발히 작업(입력/창전환 빈번) 시 주기 단축, 유휴 시 연장(현재 고정 180s).

---

## 7. 결정 필요 사항 · 트레이드오프 · 오픈 이슈

| # | 이슈 | 선택지 | 권고 |
|---|---|---|---|
| Q1 | 페르소나에 **무엇을** 보낼까 | (a) 이미지만 (b) caption만(현행) (c) **caption+이미지 하이브리드** | **(c)** — caption=게이트/톤/민감가드, 이미지=픽셀추론 |
| Q2 | 전송 형태 | `data:`(b64 인라인) vs `file://`(executor가 인라인) | `file://`(이미 디스크 저장됨, 코드 최소) — 단 cross-host 시 b64 |
| Q3 | 이미지 비용 | 매 트리거 풀이미지 = 토큰↑ | 게이트(caption 성공)+쿨다운으로 빈도 억제, 다운스케일(long-edge ~1024) |
| Q4 | 민감정보 | 픽셀은 caption보다 더 많이 노출 | 전송 전 옵션: blur/skip 모드, config `privacy: caption_only\|image` |
| Q5 | tool-result 멀티모달 | executor가 ToolResult에서 이미지 LLM 주입 지원? | **확인 필요** (§6 Phase3 분기점) |
| Q6 | 캡처 소스 | getDisplayMedia(프롬프트) vs 커넥터(무프롬프트) | 커넥터 우선, 브라우저 폴백 |
| Q7 | 모델 | 세션 모델이 vision 지원? (Claude=O) | 게이팅 + 폴백(Phase4) |

---

## 8. 검증 계획 (구현 후)

1. **단위:** `_run_trigger`가 attachments를 포함해 `execute_command`를 부르는지(mock).
2. **executor 정규화:** `{"kind":"image","url":"file://…"}` → Anthropic base64 블록 변환 스냅샷.
3. **E2E(스테이징):** 코드/에러 화면 캡처 → 페르소나가 caption엔 없는 **화면 속 구체 텍스트/요소**를
   집어내는지(픽셀을 실제로 봤다는 증거).
4. **비용:** 트리거당 토큰/요금 측정, 다운스케일 전후 비교.
5. **민감정보:** 비밀번호 보이는 화면 → 페르소나가 언급 회피 또는 `[SILENT]` 하는지.
6. **회귀:** 채팅 업로드 멀티모달, 히스토리 dehydrate(메모리 비대화 없음), 브라우저(no-connector) 폴백.

---

## 9. 핵심 파일 인덱스 (배선 지점)

**Geny backend**
- `backend/service/vtuber/screen_observation.py` — `save_and_maybe_trigger`(239-337), `_caption_image`(210-233), `_compose_prompt`(343-369), **`_run_trigger`(372-419) ← Phase1 변경점**
- `backend/service/executor/connector_bridge.py` — `DesktopGlanceTool`(90-126) ← Phase3
- `backend/service/execution/agent_executor.py` — `execute_command`(1314, `**invoke_kwargs`로 attachments 전달)
- `backend/service/executor/agent_session.py` — attachments→pipeline_input(2777-2783, 2979)
- `backend/controller/chat_controller.py` — 멀티모달 레퍼런스 경로(50-96, 458-614, 788-793)

**geny-executor 2.2.0 (backend/.venv, 변경 없음 — 재사용)**
- `stages/s01_input/artifact/default/normalizers.py` — `DefaultNormalizer`(자동위임 79-82), `MultimodalNormalizer`(93-211), `_resolve_local_image_source`(18-44, file:// 인라인)
- `stages/s01_input/types.py` — Anthropic image block 스키마
- `stages/s18_memory/_dehydrate.py` — 히스토리 base64 제거

**Geny frontend**
- `frontend/src/lib/useScreenObservation.ts` — 캡처/주기/업로드(78-108, 162-167, 234-240, 275-279)
- `frontend/src/components/live2d/ScreenObservationControls.tsx` — 토글 UI
- `frontend/src/components/live2d/ConnectorBridgeClient.tsx` — 커넥터 캡처(23-52), capability(124) ← Phase2/6
- `frontend/src/store/useVTuberStore.ts` — TTS 턴 라이프사이클(555-574, 588-647, 657-719)
- `frontend/src/components/live2d/PushToTalkDriver.tsx` — 음성→broadcast 패턴(Phase2 본보기)

**레퍼런스 (OLV)**
- `src/open_llm_vtuber/agent/input_types.py`(6-95), `conversations/conversation_utils.py`(20-42),
  `conversations/single_conversation.py`(63-90), `conversations/conversation_handler.py`(35-71),
  `agent/agents/basic_memory_agent.py`(225-288), `agent/stateless_llm/claude_llm.py`(43-82),
  `websocket_handler.py`(32-58), `prompts/utils/proactive_speak_prompt.txt`, `config_templates/conf.default.yaml`(9-26)

---

## 10. 결론

화면→대화의 "완벽한" 구현은 Geny에선 **재작성이 아니라 한 채널을 잇는 일**이다. executor의
멀티모달 파이프라인과 화면관찰 트리거가 이미 존재하므로, **Phase 1(트리거에 실제 이미지 첨부)**
하나로 OLV가 가진 "페르소나가 픽셀을 본다"의 본질을 즉시 확보하면서, Geny 고유의 게이트·침묵·
민감정보 가드·메모리 위생은 그대로 유지된다. 그 위에 Phase 2~6으로 OLV의 깔끔한 패턴(턴마다
첨부, 출처 표준화, 능동 발화)을 점진 흡수하면, **양쪽의 장점만 합친** 화면 인지 VTuber가 된다.
```
