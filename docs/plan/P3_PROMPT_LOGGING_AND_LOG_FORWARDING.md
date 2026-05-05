# P3 — System Prompt 동적 로깅 + VTuber LOGS Panel 전체 로그 포워딩

> 작성: 2026-05-05 · 우선순위: 신규 surface (운영자 가시성 회복).
> 진단 근거: `docs/analysis/MEMORY_REGRESSION_AFTER_PATH_A.md` §5 (S7), 이전 보고서의 LOGS 격차 분석.

---

## 0. 목표 두 줄

1. 매 turn 의 **system prompt 본문 (Pinned Facts / Vault Map / Recent STM / 정적 헤더 등 섹션 분해)** 이 SessionLogger 에 기록되고 → broadcast envelope 로 frontend 에 흘러 → **Opsidian 의 신규 "Prompt" 탭** 에서 turn 별로 볼 수 있다.
2. **VTuber LOGS panel** 이 단순 TTS / model / WS / memory_event 만이 아니라 SessionLogger 의 **모든 종류 (RESPONSE / COMMAND / STAGE / TOOL / TOOL_RES / STREAM / MEMORY / INFO / WARN / ERROR)** 를 turn-단위 묶음으로 받아 표시.

---

## 1. 책임 분담 (executor vs Geny)

| 책임 | 권위 | 이유 |
|---|---|---|
| **stage 별 입력/출력 객체 (PipelineState 일부) 직렬화** | executor | stage 의 input/output shape 는 executor 가 정의. Stage 가 자기 input 을 logger 에 hand-off 하는 hook 이 있어야. |
| **system prompt assembly stage** (s03 system) | executor (stage 자체) | Geny 가 어떤 섹션을 inject 할지 결정 (Pinned Facts, Vault Map) 하지만 실제 string concat 은 stage 의 책임. |
| **stage 단위 prompt body emit hook** | **새 EXEC** | `MemoryHooks` 와 같은 패턴의 콜백 또는 `Stage.on_assembled` 이벤트. 모든 stage 가 동일 surface 로 prompt 를 emit. |
| **prompt body 를 SessionLogger 에 기록** | Geny | hook 에서 받아 `log_prompt_injection` 메서드로 자기 logger 에 기록. log 포맷/저장은 Geny 비즈니스. |
| **broadcast envelope 의 신규 채널** (`session_log_entries`, `prompt_injection`) | Geny | broadcast 가 Geny 비즈니스 (chat broadcast). frontend 도 Geny. |
| **Opsidian Prompt 탭 UI** | Geny frontend | 운영자 UI 비즈니스. |

**철학 한 줄**: executor 는 "stage assembly 결과를 host 에 hand-off 할 수 있는 generic emit 인터페이스" 를 제공하고, Geny 는 "그 결과를 어떻게 logger / broadcast / UI 에 표면화할지" 결정.

---

## 2. EXEC-A — Stage assembly emit hook

### 2.1 현재

- `Stage.execute(input, state)` 의 input/output 은 stage 외부에서 관찰 불가.
- `MemoryHooks` 는 stage 18 (memory) 전용 콜백 surface.
- 모든 stage 가 자기 결과를 host 에 forward 할 일반 메커니즘 없음.

### 2.2 EXEC-A1 — `PipelineHooks` (또는 `StageObserver`) 신규

대상: `geny-executor/src/geny_executor/core/pipeline.py`

```python
@dataclass
class PipelineHooks:
    """Generic per-stage observability callbacks.

    - `after_stage`: called after any stage completes successfully.
      payload includes stage name/order, input snapshot, output
      snapshot, duration, and a `state_diff` (set of state.metadata
      / state.messages keys touched).
    - `on_prompt_assembled`: called when a stage emits a finalized
      prompt body (currently s03 system, s08 think). Body string +
      section labels (host can drop them into a UI tab).
    - `on_tool_call` / `on_tool_result`: stage 10 / 11 hooks (parallel
      to MemoryHooks.after_record_turn).

    All callbacks fire outside the stage's main lock; failures are
    debug-logged and swallowed.
    """
    after_stage: Optional[Callable[["StageEvent"], Awaitable[None]]] = None
    on_prompt_assembled: Optional[Callable[["PromptAssembled"], Awaitable[None]]] = None
    on_tool_call: Optional[Callable[["ToolCall"], Awaitable[None]]] = None
    on_tool_result: Optional[Callable[["ToolResult"], Awaitable[None]]] = None


@dataclass
class PromptAssembled:
    stage: str             # "system" | "think"
    stage_order: int
    body: str              # full assembled prompt
    sections: Dict[str, str]  # {"pinned_facts": ..., "vault_map": ..., "recent_stm": ..., ...}
    metadata: Dict[str, Any] = field(default_factory=dict)
```

`Pipeline.attach_runtime` 에 `pipeline_hooks: Optional[PipelineHooks] = None` 추가. 매 stage 의 wrapper 가 hook fire.

### 2.3 EXEC-A2 — s03 system / s08 think 가 `on_prompt_assembled` fire

stage 3 (system) 의 prompt 빌드 직후:
```python
if self._pipeline_hooks and self._pipeline_hooks.on_prompt_assembled:
    await self._pipeline_hooks.on_prompt_assembled(PromptAssembled(
        stage="system",
        stage_order=3,
        body=assembled_system_prompt,
        sections={
            "static_header": static_header,
            "pinned_facts": pinned_facts_block,
            "vault_map": vault_map_block,
            "recent_stm": recent_stm_block,
            ...
        },
        metadata={"model": model_name, "turn": state.iteration},
    ))
```

stage 8 (think) — LLM 호출 직전 의 message list 가 또 다른 "assembled prompt".

### 2.4 EXEC-A3 — 기타 stage 콜백 (옵션)

`after_stage` 가 모든 stage 의 enter/exit 마다 fire. host 는 어떤 stage 의 input/output 을 logger 에 기록할지 자기 결정.

→ 본 사이클은 `on_prompt_assembled` 만 우선 구현. `after_stage` / `on_tool_*` 는 필요 시점에 후속 추가.

### 2.5 release

- `geny-executor 1.19.0` (minor — 신규 hook surface).

---

## 3. GENY-A — Geny SessionLogger 의 prompt 로깅 메서드 + broadcast 채널

### 3.1 GENY-A1 — `SessionLogger.log_prompt_injection`

대상: `backend/service/logging/session_logger.py`

```python
class LogLevel(str, Enum):
    ...
    PROMPT = "PROMPT"   # 신규 — assembled prompt body

def log_prompt_injection(
    self,
    stage: str,
    body: str,
    sections: Optional[Dict[str, str]] = None,
    metadata: Optional[Dict[str, Any]] = None,
) -> None:
    """Record the finalized prompt body for one stage.

    Body is recorded in full for operator playback (no truncation —
    PROMPT level is never sent over the lightweight chat broadcast,
    only via the dedicated `prompt_injection` envelope channel).
    """
    payload = {
        "stage": stage,
        "body_length": len(body or ""),
        "sections": sections or {},
        "body": body,  # full
        **(metadata or {}),
    }
    self.log(LogLevel.PROMPT, f"prompt assembled at {stage} ({len(body)} chars)", payload)
```

### 3.2 GENY-A2 — Geny 가 PipelineHooks 등록

대상: `backend/service/executor/agent_session.py` (GENY-7c 의 `_install_memory_hooks` 와 같은 위치)

```python
def _install_pipeline_hooks(self) -> None:
    """Wire executor PipelineHooks for prompt assembly + tool events."""
    pipeline = getattr(self, "_pipeline", None)
    if pipeline is None or self._memory_manager is None:
        return
    from geny_executor.core.pipeline import PipelineHooks

    async def _on_prompt_assembled(ev) -> None:
        slog = get_session_logger(self._session_id, create_if_missing=False)
        if slog is None:
            return
        try:
            slog.log_prompt_injection(
                stage=ev.stage,
                body=ev.body,
                sections=ev.sections,
                metadata=ev.metadata,
            )
        except Exception:
            logger.debug("prompt log failed", exc_info=True)

    pipeline.set_hooks(PipelineHooks(on_prompt_assembled=_on_prompt_assembled))
```

### 3.3 GENY-A3 — broadcast envelope 신규 채널 `prompt_injection` + `session_log_entries`

대상: `backend/controller/chat_controller.py` (broadcast envelope 빌드 위치)

```python
# 기존
msg_data = {
    "session_id": ..., "role": ..., "duration_ms": ...,
    "file_changes": ...,
    "memory_events": ...,
}
# 추가
if session_logger:
    prompts = session_logger.extract_prompts_since(pre_exec_cursor)
    if prompts:
        msg_data["prompt_injections"] = prompts

    # 모든 종류 LogEntry forward (VTuber LOGS panel 용)
    log_entries = session_logger.extract_log_entries_since(pre_exec_cursor)
    if log_entries:
        msg_data["session_log_entries"] = log_entries
```

`SessionLogger` 에 `extract_prompts_since(cursor)` + `extract_log_entries_since(cursor)` 신규 메서드. cursor 는 file_changes / memory_events 와 같은 패턴.

---

## 4. GENY-B — Frontend: Opsidian Prompt 탭 + VTuber LOGS panel 확장

### 4.1 GENY-B1 — Opsidian 신규 "Prompt" 탭

대상: `frontend/src/components/opsidian/`

새 컴포넌트 `OpsidianPromptTab.tsx`:
- turn 단위 prompt history 리스트 (좌측)
- 선택한 turn 의 prompt body (우측, syntax-highlighted)
- 각 section (pinned_facts / vault_map / recent_stm / static_header) 토글로 보기/숨기기
- "복사" 버튼

데이터 source:
- `useSessionStore` 에 `promptInjections: Record<sessionId, PromptEntry[]>` 추가.
- WebSocket broadcast 의 `prompt_injections` 필드 도착 시 store 에 append.
- 또는 별도 `/api/agents/<sid>/prompts` REST endpoint (이전 turn 들 fetch).

### 4.2 GENY-B2 — VTuber LOGS panel 확장

대상: `frontend/src/components/live2d/VTuberChatPanel.tsx:250-280`

```tsx
// 기존 memory_events forward
if (msg.memory_events?.length) {
  for (const ev of msg.memory_events) {
    store.addLog(msg.session_id, 'info', ev.source, ev.message, ev);
  }
}
// 신규 — 모든 종류 SessionLogger entry forward
if (msg.session_log_entries?.length) {
  for (const ent of msg.session_log_entries) {
    store.addLog(
      msg.session_id,
      _level_for_entry(ent),  // INFO/WARNING/ERROR/STATE/DEBUG 매핑
      ent.level,              // RESPONSE/COMMAND/STAGE/TOOL/...
      ent.message,
      ent.metadata as Record<string, unknown>,
    );
  }
}
```

`VTuberLogEntry.level` 의 enum 도 `'info'|'state'|'error'|'warn'|'debug'` 외에 추가 (또는 source 로 RESPONSE/COMMAND 표시). 디자인 결정 필요.

### 4.3 GENY-B3 — `useVTuberStore` 확장

`addLog` 의 source 자유도 + level 매핑 정리. `entry.level === 'PROMPT'` 인 항목은 panel 에서 "🧾 Prompt assembled" 같은 별도 styling.

### 4.4 GENY-B4 — `extract_log_entries_since` 의 효율

cursor 기반으로 turn 이 끝날 때마다 delta 만 emit. 매 turn 에 LogEntry 가 100~500개 발생할 수 있음 → broadcast envelope 부담. options:
- 모든 entry 보내기 (단순, 부담 큼)
- DEBUG level 제외 (운영자가 envelope 로 받지 않고 Logs 탭에서 별도 조회)
- envelope 사이즈 제한 (예: 50개) 초과 시 "…and N more" placeholder

→ DEBUG 제외 + 50개 cap 채택.

---

## 5. PR 시퀀스

```
EXEC-A1 + A2 + A3 (PipelineHooks + on_prompt_assembled) ─→ geny-executor 1.19.0 release
                                                          │
                                                          ↓
GENY-A1 (SessionLogger.log_prompt_injection) ─┐
GENY-A2 (PipelineHooks 등록) ───────────────────┤── Geny PR (backend)
GENY-A3 (broadcast envelope) ──────────────────┘   + requirements bump >=1.19.0
                                                          │
                                                          ↓
GENY-B1 (Opsidian Prompt tab) ─┐
GENY-B2 (VTuberChatPanel forward) ─┤── Geny PR (frontend) — backend PR 머지 후
GENY-B3 (useVTuberStore) ──────────┤
GENY-B4 (entry cap) ───────────────┘
```

총 PR: executor 1개 + Geny backend 1개 + Geny frontend 1개.

---

## 6. 위험 / 롤백

- `extract_log_entries_since` 가 매 turn 100+ entry → envelope payload 비대 (수백 KB). 검증 필요. 부담 크면 DEBUG level 외에도 STREAM 도 제외.
- prompt body 가 매우 길면 (예: 100KB system prompt) PROMPT 로그 자체가 SessionLogger DB 부담. body 별도 저장 고려.
- 롤백: `_install_pipeline_hooks` 호출 자체를 try/except 로 감싸 silent skip. backend / frontend 둘 다 backward-compat (envelope 의 신규 필드 없으면 기존처럼 동작).

---

## 7. 미해결 결정사항

1. **`PROMPT` level 의 SessionLogger DB 저장 여부** — body 가 크면 DB 비대. log 파일 + envelope 만 보내고 DB 는 sumamry/length 만 저장.
2. **section 분해 방식** — stage 가 build 시점에 dict 로 emit vs frontend 가 정규식 split. 전자가 정확. 단 stage 코드 수정 필요. → 전자 채택 (사용자 의도 정확 반영).
3. **Opsidian Prompt 탭 의 turn navigation** — 모든 turn vs 최근 N turns. 운영자가 과거 turn 도 보고 싶으면 REST endpoint 로 lazy fetch.
4. **VTuber LOGS panel 의 entry level 시각화** — 색상/icon. 디자인 결정.

---

## 8. 다음 액션

1. 본 P3 plan 사용자 승인 + 미해결 결정사항 답.
2. EXEC-A 통합 PR + 1.19.0 release.
3. Geny backend PR (SessionLogger + envelope 채널).
4. Geny frontend PR (Opsidian Prompt tab + VTuberChatPanel 확장).
5. 운영 검증: 새 세션 → 매 turn 마다 Opsidian Prompt 탭에 system prompt body 가 sections 별로 노출 + VTuber LOGS panel 에 RESPONSE/COMMAND/STAGE/TOOL 라인 시간순으로 흐름.
