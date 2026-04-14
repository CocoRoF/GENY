# VTuber 채팅 스트림 문제 심층 분석 리포트

> Date: 2026-04-14
> 증상: VTuber 채팅에서 메시지 전송 후 실시간으로 안 보이고, 새로고침해야 나타남

---

## 1. 증상 분석

- 사용자가 메시지를 보내면 POST /broadcast는 성공 (user_message 즉시 반환)
- 에이전트가 응답을 생성하고 DB에 저장됨 (새로고침 시 보임)
- **실시간으로 프론트엔드에 전달되지 않음**
- 새로고침하면 이전 메시지들이 모두 정상 표시

---

## 2. 전체 알림 체인 추적

```
1. 프론트엔드: POST /api/chat/rooms/{roomId}/broadcast
   → 백엔드: user_message 저장 + _notify_room() ✅
   → 백엔드: asyncio.create_task(_run_broadcast()) 실행 ✅

2. _run_broadcast() → execute_command() → agent.invoke()
   → pipeline.run_stream() → 결과 반환 ✅

3. 결과 저장: store.add_message(room_id, msg_data) ✅
   → _notify_room(room_id) 호출 ✅

4. _notify_room():
   ev = _room_new_msg_events.get(room_id)
   if ev: ev.set()  ← asyncio.Event 시그널 ✅

5. WebSocket _stream_room_events():
   room_event = get_room_event(room_id)
   room_event.wait() → 깨어남 → new_msgs 조회 → ws.send_json() ???

6. 프론트엔드:
   ws.onmessage → onEvent('message', data) → setMessages([...prev, msg]) ???
```

---

## 3. 가능한 원인 분석

### 3.1 WebSocket 연결 실패 → SSE 폴백 (가장 유력)

**api.ts의 subscribeToRoom 로직:**
```javascript
ws.onerror = (err) => {
  ws = null;
  if (!closed && attempts === 0) {
    // First connection failed — fall back to SSE
    closed = true;
    fallbackSub = sseSubscribe({...});
  }
};
```

**WebSocket 연결이 실패하면 SSE로 폴백**합니다.

Docker 환경에서의 URL:
- WebSocket: `ws://localhost:8000/ws/chat/rooms/{roomId}` (직접 백엔드)
- SSE 폴백: `http://localhost:8000/api/chat/rooms/{roomId}/events` (직접 백엔드)

**문제**: 
- WebSocket이 성공하면 실시간 동작해야 함
- WebSocket이 실패하면 SSE로 폴백하지만, SSE도 실시간이어야 함
- **둘 다 실패하는 상황은 아닐 것**

### 3.2 SSE가 Next.js proxy를 통과하면서 버퍼링 (유력)

`next.config.ts`의 rewrite 규칙:
```javascript
fallback: [
  { source: "/api/:path*", destination: `${apiTarget}/api/:path*` },
]
```

`apiTarget = process.env.API_URL || "http://localhost:8000"`

Docker에서 `API_URL=http://backend:8000` (docker-compose.dev-core.yml:96).

**SSE 폴백 URL이 `http://localhost:8000`이면** 직접 백엔드에 연결 → 정상.
**하지만** `getBackendUrl()`에서 `NEXT_PUBLIC_API_URL`이 설정되지 않으면
`NEXT_PUBLIC_BACKEND_PORT=8000` → `http://localhost:8000`.

Docker dev-core에서 프론트엔드 포트 3000, 백엔드 포트 8000.
**브라우저에서 `http://localhost:8000`은 호스트를 통해 백엔드에 도달** → 정상이어야 함.

### 3.3 WebSocket 연결은 성공하지만 이벤트가 안 오는 경우

**레이스 컨디션**: `room_event.clear()` → `room_event.wait()` 사이에 이벤트 발생 시
→ 이 경우 `wait()`이 즉시 반환하므로 **문제없음**

**_notify_room()이 호출되지 않는 경우**:
→ 로그에 `[Broadcast:xxx] room event notified` 또는 `room event notify skipped` 확인 필요

### 3.4 프론트엔드에서 이벤트는 수신하지만 UI가 업데이트 안 되는 경우

VTuberChatPanel.tsx line 184:
```javascript
setMessages((prev) => {
  if (prev.some((m) => m.id === msg.id)) return prev;
  return [...prev, displayMsg];
});
```

중복 체크(`msg.id`) 후 추가. 이 로직은 정상.
**하지만** `msg.id`가 없으면 line 181에서 `return` → 메시지 무시됨.

---

## 4. 핵심 의심 포인트

### 4.1 Docker dev-core 환경에서 BACKEND_PORT 노출 문제

`docker-compose.dev-core.yml`:
```yaml
backend:
  ports:
    - "${BACKEND_PORT:-8000}:8000"
```

`0.0.0.0:8000`으로 바인딩. 브라우저에서 `localhost:8000` 접근 가능.

**하지만** WebSocket 업그레이드가 제대로 되는지는 리버스 프록시 설정에 따라 다름.
Docker dev-core에는 nginx가 없으므로, **브라우저 → 직접 백엔드 WebSocket**이어야 함.

### 4.2 ChatConfig.sse_heartbeat_interval_s 값

`heartbeat_interval = float(_chat_cfg.sse_heartbeat_interval_s)`

이 값이 **매우 길면** (예: 300초), heartbeat 타임아웃까지 새 메시지를 체크하지 않음.
→ 기본값 확인 필요.

### 4.3 broadcast가 매우 오래 걸리는 경우

VTuber 에이전트가 복잡한 작업을 수행하면 `execute_command()`가 오래 걸림.
그 동안 WebSocket은 heartbeat를 보내며 대기 → 완료 후 메시지 저장 → 알림.
**이건 정상 동작** — 완료될 때까지 기다린 후 메시지가 나타나야 함.

---

## 5. 조사 필요 항목 (백엔드 로그 확인)

서버 로그에서 다음을 확인해야 합니다:

```
1. [ChatWS:xxxx] WebSocket accepted              ← WS 연결 성공?
2. [ChatWS:xxxx] subscribe request, after=xxx     ← 구독 시작?
3. [Broadcast:xxxx] calling execute_command       ← 실행 시작?
4. [Broadcast:xxxx] execute_command returned      ← 실행 완료?
5. [Broadcast:xxxx] agent message saved           ← 메시지 저장?
6. [Broadcast:xxxx] room event notified           ← 이벤트 시그널?
7. [ChatWS:xxxx] loop=N: M new messages to send   ← 새 메시지 감지?
8. [ChatWS:xxxx] sent event=message               ← WS로 전송?
```

**3-6이 있는데 7-8이 없으면**: WebSocket이 이벤트를 받지 못하는 것
**7-8이 있으면**: 프론트엔드 문제
**1-2가 없으면**: WebSocket 연결 자체가 실패

---

## 6. 개선 방향

### 즉시 확인 (로그 기반)

1. 백엔드 로그에서 `[ChatWS]` 와 `[Broadcast]` 로그 확인
2. 브라우저 콘솔에서 `[ChatWS]` 로그 확인 (WebSocket 연결 성공/실패)

### 가능한 수정

| 원인 | 수정 |
|------|------|
| WebSocket 연결 실패 → SSE 폴백 | SSE 자체는 동작해야 하므로 SSE 폴백 로직 검증 |
| heartbeat_interval 과도하게 김 | ChatConfig 기본값 확인, 필요시 5초로 설정 |
| 프론트엔드 이벤트 수신하지만 UI 미갱신 | console.debug 로그로 이벤트 수신 여부 확인 |
| Next.js가 SSE 스트리밍을 버퍼링 | getBackendUrl()이 직접 백엔드를 가리키는지 확인 |
