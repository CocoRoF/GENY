# Chat Streaming 아키텍처 재설계

> Date: 2026-04-15
> 목표: 토큰 단위 실시간 스트리밍 + WebSocket 연결 안정성

---

## 1. 현행 분석

### 1.1 현재 두 스트리밍 경로 비교

| | Command Tab | Chat Tab |
|---|---|---|
| 실행 방식 | `start_command_background()` → holder 반환 → 비동기 | `execute_command()` → 완료까지 blocking |
| 스트리밍 | WS가 session_logger를 100ms 폴링 | 백그라운드 _poll_logs가 200ms 폴링 |
| 데이터 | 구조화 이벤트 (TOOL, GRAPH, RESPONSE) | thinking_preview + recent_logs |
| 토큰 스트리밍 | ❌ 없음 | ❌ 없음 |
| 텍스트 전달 | RESPONSE 로그 1회 (전체) | 완성 메시지 1회 (전체) |

### 1.2 핵심 문제

**session_logger에 text.delta가 기록되지 않음.**

`_invoke_pipeline()`은 `pipeline.run_stream()`을 사용하여 토큰별 이벤트를 받지만,
session_logger에는 TOOL/GRAPH/RESPONSE만 기록. text.delta는 버림.

→ 어떤 경로(Command Tab이든 Chat이든)에서도 토큰 스트리밍 불가.

---

## 2. 재설계 아키텍처

### 2.1 핵심 변경: text.delta를 session_logger STREAM 레벨로 기록

```
pipeline.run_stream()
  │
  ├── text.delta → session_logger.log(level=STREAM, message=token_text)
  ├── tool.execute_start → session_logger.log_tool_use()
  ├── stage.enter → session_logger.log_graph_event()
  └── pipeline.complete → session_logger.log_response()
```

이렇게 하면 **session_logger 캐시에 토큰이 실시간으로 들어감**.
기존의 모든 폴링 인프라(WS execute_stream, _poll_logs)가 **자동으로** 토큰을 수신.

### 2.2 Chat broadcast 경로 — 구조적 변경

**현재 (blocking)**:
```
_invoke_one() → execute_command() [blocking] → 완료 → store.add_message()
```

**변경 후 (non-blocking + 스트리밍)**:
```
_invoke_one():
  1. start_command_background() → holder 즉시 반환
  2. 스트리밍 폴링 루프 (session_logger.get_cache_entries_since):
     - STREAM 엔트리 → agent_state.streaming_text에 누적
     - TOOL/GRAPH 엔트리 → agent_state.thinking_preview 업데이트
     - _notify_room() → WebSocket이 agent_progress에 streaming_text 포함하여 전달
  3. holder["done"] == True → 최종 메시지 저장 + _notify_room()
```

### 2.3 프론트엔드 — agent_progress로 실시간 텍스트 표시

```
agent_progress 이벤트:
{
  "broadcast_id": "...",
  "agents": [{
    "session_id": "...",
    "status": "executing",
    "thinking_preview": "→ s06_api",
    "streaming_text": "안녕하세요! 저는 AI 에이전트입니다. 제 이름은...",  ← NEW
    "elapsed_ms": 3200,
    ...
  }]
}
```

프론트엔드:
- `streaming_text`가 있으면 → 임시 메시지 버블로 실시간 표시
- `broadcast_done` 또는 최종 `message` 이벤트 → 임시 버블을 완성 메시지로 교체

---

## 3. 구현 계획

### Step 1: session_logger에 STREAM 레벨 추가 (Geny 백엔드)

`service/logging/session_logger.py`:
```python
class LogLevel(str, Enum):
    ...
    STREAM = "STREAM"  # 이미 존재하는지 확인 필요
```

`_invoke_pipeline()`에서:
```python
elif event_type == "text.delta":
    text = event_data.get("text", "")
    if text:
        accumulated_output += text
        if session_logger:
            session_logger.log(
                level="STREAM",
                message=text,
                metadata={"type": "text_delta"},
            )
```

### Step 2: chat_controller — blocking → non-blocking 전환

`_invoke_one()` 변경:
```python
async def _invoke_one(session_id: str):
    # 기존: result = await execute_command(...)
    # 변경: holder 방식

    holder = await start_command_background(
        session_id=session_id,
        prompt=message,
    )

    session_logger = get_session_logger(session_id, create_if_missing=False)
    cache_cursor = holder.get("cache_cursor", 0)

    # 스트리밍 폴링 루프
    while not holder.get("done"):
        await asyncio.sleep(0.1)  # 100ms

        if session_logger:
            new_entries, cache_cursor = session_logger.get_cache_entries_since(cache_cursor)
            for entry in new_entries:
                level = entry.level.value if hasattr(entry.level, "value") else str(entry.level)

                # 토큰 스트리밍
                if level == "STREAM":
                    if agent_state:
                        agent_state.streaming_text = (
                            getattr(agent_state, "streaming_text", "") + entry.message
                        )

                # thinking preview (기존 로직)
                preview = _extract_thinking_preview(entry)
                if preview:
                    if agent_state:
                        agent_state.thinking_preview = preview
                        agent_state.last_activity_at = time.monotonic()

            if new_entries:
                _notify_room(room_id)

    # 완료 후 결과 처리
    result_dict = holder.get("result", {})
    output = result_dict.get("output", "")
    cost = result_dict.get("cost_usd")
    duration_ms = result_dict.get("duration_ms", 0)
    success = result_dict.get("success", False)

    if success and output and output.strip():
        store.add_message(room_id, {...})
        state.responded += 1
        if agent_state:
            agent_state.status = "completed"
            agent_state.streaming_text = None  # 스트리밍 종료
        _notify_room(room_id)
    ...
```

### Step 3: AgentExecutionState에 streaming_text 추가

```python
@dataclass
class AgentExecutionState:
    session_id: str
    session_name: str
    role: str
    status: str = "pending"
    thinking_preview: Optional[str] = None
    streaming_text: Optional[str] = None    # ← NEW: 누적 스트리밍 텍스트
    started_at: Optional[float] = None
    last_activity_at: Optional[float] = None
    last_tool_name: Optional[str] = None
    recent_logs: List[Dict[str, Any]] = field(default_factory=list)
    log_cursor: int = 0
```

### Step 4: _build_agent_progress_data에 streaming_text 포함

```python
def _build_agent_progress_data(astate: AgentExecutionState) -> dict:
    data = {
        "session_id": astate.session_id,
        "session_name": astate.session_name,
        "role": astate.role,
        "status": astate.status,
        "thinking_preview": astate.thinking_preview,
        "streaming_text": astate.streaming_text,    # ← NEW
    }
    ...
```

### Step 5: 프론트엔드 — 실시간 스트리밍 텍스트 표시

VTuberChatPanel.tsx / ChatTab.tsx:
```typescript
} else if (eventType === 'agent_progress') {
  const progress = eventData as { agents: AgentProgressState[] };
  setAgentProgress(progress.agents);

  // 실시간 스트리밍 텍스트 표시
  for (const agent of progress.agents) {
    if (agent.streaming_text && agent.status === 'executing') {
      setStreamingMessages(prev => ({
        ...prev,
        [agent.session_id]: {
          content: agent.streaming_text,
          session_name: agent.session_name,
          role: agent.role,
        }
      }));
    }
  }
} else if (eventType === 'message') {
  // 최종 메시지 도착 → 스트리밍 버블 제거
  setStreamingMessages(prev => {
    const next = {...prev};
    delete next[msg.session_id];
    return next;
  });
  setMessages(prev => [...prev, displayMsg]);
}
```

### Step 6: WebSocket 연결 안정성

VTuberChatPanel.tsx:
```typescript
// useEffect 의존성에서 toDisplayMessage 제거
useEffect(() => {
  if (!roomId) return;
  // ...
}, [roomId]);  // toDisplayMessage 제거 → 불필요한 재구독 방지
```

api.ts subscribeToRoom:
```typescript
ws.onerror = (err) => {
  ws = null;
  if (!closed && attempts === 0) {
    // 즉시 SSE 폴백 (3초 대기 없이)
    closed = true;
    fallbackSub = sseSubscribe({...});
  }
};
```

---

## 4. 데이터 흐름 (수정 후)

```
사용자 메시지 전송:
  POST /broadcast → user_message 즉시 반환
    │
    ├── 프론트엔드: user_message UI에 표시
    │
    └── 백엔드 _invoke_one():
          start_command_background() → holder
          │
          ├── 폴링 루프 (100ms):
          │   session_logger.get_cache_entries_since()
          │     │
          │     ├── STREAM 엔트리 → agent_state.streaming_text += token
          │     ├── TOOL 엔트리 → agent_state.thinking_preview 업데이트
          │     └── _notify_room()
          │           │
          │           └── WebSocket → agent_progress {streaming_text: "안녕하세..."} 
          │                 │
          │                 └── 프론트엔드: 임시 스트리밍 버블 실시간 업데이트
          │
          └── holder["done"] == True:
                store.add_message(content=full_text)
                _notify_room()
                  │
                  └── WebSocket → message {content: "안녕하세요! 전체 텍스트..."}
                        │
                        └── 프론트엔드: 스트리밍 버블 → 완성 메시지로 교체
```

---

## 5. 확장성

이 아키텍처의 장점:

1. **session_logger가 유일한 스트리밍 소스** — Command Tab과 Chat Tab 모두 동일한 인프라 사용
2. **기존 폴링 인프라 재사용** — WS execute_stream과 _poll_logs가 자동으로 STREAM 엔트리 수신
3. **캐시 기반** — 재연결 시 cursor로 누락 이벤트 복구 가능
4. **레벨 기반 필터링** — 프론트엔드에서 필요한 이벤트만 선택 가능
5. **비동기 non-blocking** — broadcast가 start_command_background 사용으로 확장 가능

### Command Tab도 동일하게 수혜

`ws/execute_stream.py`가 이미 session_logger를 100ms 폴링하므로,
`_invoke_pipeline()`에 STREAM 로깅만 추가하면 **Command Tab도 자동으로 토큰 스트리밍 지원**.
