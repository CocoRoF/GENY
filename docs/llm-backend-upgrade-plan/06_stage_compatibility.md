# 06 · 21-Stage Compatibility Matrix

> 21개 stage 각각이 어떤 capability에 의존하는지 + 6 backend에서 그것이 어떻게 노출/대체되는지. **degradation policy의 단일 출처.**

## 1. 통합 매트릭스

범례: ✅ native · ⚪ LLM 미호출 stage · ⚠ 부분 (degradation policy) · ❌ 비현실적

| # | Stage | LLM call? | Provider 결정 | anthropic | openai | google | vllm | claude_code_cli | copilot_cli |
|---|---|---|---|---|---|---|---|---|---|
| 1 | input | ❌ | — | ⚪ | ⚪ | ⚪ | ⚪ | ⚪ | ⚪ |
| 2 | context | ✅ (summarize) | Stage 6 or override | ✅ | ✅ | ✅ | ⚠ | ✅ | ⚠ |
| 3 | system | ❌ | — | ⚪ | ⚪ | ⚪ | ⚪ | ⚪ | ⚪ |
| 4 | guard | ❌ | — | ⚪ | ⚪ | ⚪ | ⚪ | ⚪ | ⚪ |
| 5 | cache | ❌ | — | ⚪ | ⚪ | ⚪ | ⚪ | ⚪ | ⚪ |
| **6** | **api** | **✅** | **own (primary)** | ✅ | ✅ | ✅ | ⚠ tools off-default | ✅ | ⚠ no tools/stream |
| 7 | token | post-hoc | — | ✅ | ✅ | ✅ | ⚠ | ✅ | ⚠ no usage |
| 8 | think | reads thinking blocks | — | ✅ | ⚠ reasoning_effort | ⚠ thinking_config | ❌ | ✅ `--effort` | ❌ |
| 9 | parse | ❌ | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 10 | tool | host exec / CLI exec | capability-gated | ✅ host | ✅ host | ✅ host | ✅ host | ✅ CLI-managed | ⚠ via --allow-tool |
| 11 | tool_review | ✅ | own (inactive default) | ✅ | ✅ | ✅ | ⚠ | ✅ | ⚠ |
| **12** | **agent** | **✅ (sub-agent)** | **per-descriptor** | ✅ | ✅ | ✅ | ⚠ | ✅ | ⚠ |
| 13 | task_registry | ❌ | — | ⚪ | ⚪ | ⚪ | ⚪ | ⚪ | ⚪ |
| 14 | evaluate | ✅ (signal) | own or override | ✅ | ✅ | ✅ | ⚠ | ✅ | ⚠ |
| 15 | hitl | ❌ (inactive default) | — | ⚪ | ⚪ | ⚪ | ⚪ | ⚪ | ⚪ |
| 16 | loop | ❌ | — | ⚪ | ⚪ | ⚪ | ⚪ | ⚪ | ⚪ |
| 17 | emit | ❌ | — | ⚪ | ⚪ | ⚪ | ⚪ | ⚪ | ⚪ |
| 18 | memory | ✅ (reflection) | own or override | ✅ | ✅ | ✅ | ⚠ | ✅ | ⚠ |
| 19 | summarize | ✅ (inactive default) | own or override | ✅ | ✅ | ✅ | ⚠ | ✅ | ⚠ |
| 20 | persist | ❌ (inactive default) | — | ⚪ | ⚪ | ⚪ | ⚪ | ⚪ | ⚪ |
| 21 | yield | ❌ | — | ⚪ | ⚪ | ⚪ | ⚪ | ⚪ | ⚪ |

## 2. Stage별 디테일

### Stage 2 (context) — `LLMSummaryCompactor`

- `client.create_message(..., purpose="s02.summarize")` 단일 turn.
- Capability dep: `supports_streaming` 안 씀. `supports_thinking` 불필요.
- 권장 override: `provider_override="openai"` + `model="gpt-4o-mini"` (저렴).
- Degradation: 미지원 필드 silent drop, 호출 자체는 성공.

### Stage 6 (api) — primary LLM

- 모든 capability 사용.
- CLI에서:
  - `claude_code_cli`: tools/thinking/streaming 모두 native. `tool_choice`/`stop_sequences`/`top_k`/`temperature`/`top_p`/`max_tokens` drop.
  - `copilot_cli`: tools/thinking/streaming 불가 — 단일 텍스트 응답.
- Retry-with-drop: `s06_api`의 retry strategy가 `feature_unsupported` 이벤트 보면 다음 retry에서 해당 필드 제거 후 재호출. 신규 9개 capability도 동일 메커니즘.

### Stage 8 (think) — thinking blocks 처리

- Stage 6의 응답에서 thinking ContentBlock을 후처리.
- `supports_thinking=False` backend면 thinking 블록 없음 → stage 8 no-op.
- `claude_code_cli`: `--effort` 사용 시 stream-json에 `thinking_delta`로 emit → canonical ContentBlock으로 매핑.

### Stage 10 (tool) — host vs CLI-managed execution

핵심 capability 분기:
```python
caps = state.llm_client.capabilities
cli_managed = (
    caps.is_subprocess and
    caps.supports_tools and
    caps.requires_workspace and
    not state.session.config.get("force_host_tools", False)
)
if cli_managed:
    # claude_code_cli: CLI가 이미 tool_use → tool_result를 자체 처리
    self.emit_event({"type":"s10.skip_host_tools","reason":"cli_managed"})
    return state
# else: host-side execution
```

규칙:
- `provider == "claude_code_cli"`인 경우 (capability로 감지) → host-side tool execution skip.
- 사용자가 `force_host_tools=True` 설정 시 CLI 자체 tool 끄고 host가 다룸 (manifest 옵션).

### Stage 11 (tool_review) — inactive default

- 활성 시 LLM-as-judge.
- Capability dep: 단일 turn, no tools.
- 권장 override: `provider_override="anthropic"`+Sonnet (reasoning).

### Stage 12 (agent) — sub-agent (★ multi-provider)

자세한 건 [05_sub_agent_system.md](./05_sub_agent_system.md).

요약:
- Sub-pipeline마다 자기 stage 6 provider → 메커니즘적으로 모든 6 backend 가능.
- `claude_code_cli` sub-agent는 새 subprocess (cold start 200-600ms).
- `copilot_cli` sub-agent는 가능하나 streaming 없음.
- Nested sub-agent는 차단 (Geny factory가 강제).

### Stage 14 (evaluate)

- 짧은 분류 LLM call.
- 권장 override: cheap (openai-mini, google-flash).

### Stage 18 (memory) — reflection

- `ReflectionResolver`가 `state.llm_client` 또는 override 사용.
- 큰 context 필요 → 권장 override: Anthropic Opus / `claude_code_cli`.

### Stage 19 (summarize) — inactive default

- 활성 시 turn summary 작성.
- 권장 override: cheap.

## 3. Degradation policy

### 3.1 Silent drop (existing + extended)

`BaseClient._build_request`이 미지원 필드 silent drop + `llm_client.feature_unsupported` 이벤트 emit. 신규 9개 capability도 동일 메커니즘으로 처리.

### 3.2 Stage 6 retry-with-drop

`s06_api` retry strategy가 `feature_unsupported` 이벤트를 retry context에 저장. 다음 retry 시 해당 필드 제거 후 재호출.

### 3.3 Stage 10 CLI-managed-tools skip

Capability-based 조건분기 ([§2 Stage 10](#stage-10-tool--host-vs-cli-managed-execution) 참조). Provider 이름으로 분기하지 않음 (P2).

### 3.4 Streaming fallback

`supports_streaming=False` (copilot)이면 `create_message_stream`이 base default → `message_complete` 한 번 yield. UI는 capability badge로 명시.

### 3.5 Token/cost 누락 backend

`supports_token_usage=False`인 경우 `state.cost_tracker`에 unknown sentinel (0이 아님). 메트릭에서 명시적으로 누락 표시.

## 4. Per-stage `provider_override` 권장 가이드

| Stage | 권장 override 후보 | 이유 |
|---|---|---|
| 2 (context) | openai/mini, google/flash | summarize는 cheap |
| 11 (tool_review) | anthropic Sonnet, google Pro | reasoning |
| 14 (evaluate) | openai/mini, google/flash | 짧은 분류 |
| 18 (memory reflection) | anthropic Opus, claude_code_cli | deep reasoning |
| 19 (summarize) | openai/mini | cheap |
| 12 sub-agent | per-descriptor 자유 | researcher=Opus, summarizer=openai/mini |

UI는 "Recommended" 뱃지로 노출. 강제 아님.

## 5. Stage 코드 변경 영향

| Stage | 코드 변경 | 변경 내용 |
|---|---|---|
| 2 (context) | ✅ | `state.llm_client` → `self.stage.resolve_local_client(state)` |
| 6 (api) | ✅ | 생성자 단순화, provider는 config["provider"]에서만 |
| 10 (tool) | ✅ | CLI-managed-tools 분기 추가 |
| 11 (tool_review) | ✅ | resolve_local_client 사용 |
| 12 (agent) | ✅ | orchestrator 결정 단순화, runtime hookup |
| 14 (evaluate) | ✅ | resolve_local_client 사용 |
| 18 (memory) | ✅ | reflection도 resolve_local_client |
| 19 (summarize) | ✅ | resolve_local_client |
| 기타 | ❌ | 변경 없음 |

총 stage 코드 변경: 8개 stage, 각 1~10줄, 합 ~50줄 미만.

## 6. UX implication

- Global Settings: 6 provider 중 선택, model 카탈로그.
- Stage editor: 모든 stage에 model_override + provider_override (default collapsed).
- Sub-agent catalog: 4 default seed + 자유 편집.
- CLI 백엔드 health: settings 카드에 inline 표시.
- Capability badges: 선택된 backend의 "no streaming" / "no tools" 등 시각화.

## 7. FAQ

**Q. Copilot CLI에서 도구 실행이 호스트와 충돌?**
A. `--allow-tool` allowlist로만 받음. 기본은 빈 list → 도구 비활성. 사용자가 `shell(git)` 허용 시 cwd는 sandboxed session workspace로 강제.

**Q. Stage 12 sub-agent 안에서 다시 sub-agent?**
A. Geny factory가 sub-pipeline의 stage 12 orchestrator를 `single_agent`로 강제 + `subagent_registry=None` 전달 → 차단. ([05 §7.4](./05_sub_agent_system.md#74-sub-agent-안에서-sub-agent-nested))

**Q. CLI backend stream-json malformed line?**
A. `parse_stream_json_line`이 marker 반환 → `CLIProtocolError` → `ErrorCategory.CLI_PROTOCOL_ERROR` → retry backoff.

**Q. CLI backend model alias (`sonnet`, `opus`)?**
A. canonical `APIRequest.model`에 alias 그대로 전달. CLI가 resolve. 응답의 `result` 라인에 실제 모델 ID 포함 → `APIResponse.model`에 기록.

**Q. Sub-agent가 사용자 머신을 너무 쓰면?**
A. `descriptor.max_concurrent`로 상한. CLI 백엔드 sub-agent는 default `max_concurrent=1` (사실상 serial). 사용자가 명시적으로 올림.
