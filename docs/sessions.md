# Sessions, VTuber ↔ Sub-Worker pairing

How Geny models conversations. Why there are two agent loops instead of one. The exact wire format VTuber and Sub-Worker use to talk to each other.

## A session is one agent loop

Every conversation is a `SessionInfo` ([backend/service/sessions/models.py](../backend/service/sessions/models.py)) that owns:

- An `AgentSession` ([backend/service/executor/agent_session.py](../backend/service/executor/agent_session.py)) — a stateful wrapper around `geny_executor.Pipeline`
- A resolved `EnvironmentManifest` — stages, tools, MCP servers, hooks
- A `CredentialBundle` — provider keys
- A `SessionLogger` — SSE event stream
- A persona, model, and tool binding

Sessions are persisted; reloading the app picks them back up.

There are several session kinds, but only two participate in the audience-visible loop:

| Kind         | Purpose                                                | Default model        |
| ------------ | ------------------------------------------------------ | -------------------- |
| `vtuber`     | Audience-facing personality, avatar, live chat         | claude-sonnet-4-6    |
| `sub_worker` | Spawned by VTuber for a self-contained, tool-heavy task | claude-opus-4-7     |
| `messenger`  | Direct user ↔ assistant chat (no avatar)               | configurable         |
| `command`    | One-shot slash command execution                       | configurable         |

The split exists because the two roles want incompatible things:

- **VTuber** wants: light tool budget, fast turn cadence, persona-consistent voice, low latency for the avatar reactions
- **Sub-Worker** wants: heavy tool budget, long horizons, no persona overhead, freedom to enter long reasoning loops

Running them as one session would force one set of trade-offs. Running them as two paired sessions lets each loop optimize for its own role and exchange results through a structured protocol.

## VTuber session

Lives in [backend/service/vtuber/](../backend/service/vtuber/). Notable modules:

- [avatar_state_manager.py](../backend/service/vtuber/avatar_state_manager.py) — current expression, gaze target, mouth state
- [emotion_extractor.py](../backend/service/vtuber/emotion_extractor.py) — derives affect from the agent's output
- [library_watcher.py](../backend/service/vtuber/library_watcher.py) — watches the avatar library for file changes
- [live2d_model_manager.py](../backend/service/vtuber/live2d_model_manager.py) — Live2D model lifecycle
- [screen_observation.py](../backend/service/vtuber/screen_observation.py) — optional screen-share for the VTuber to react to
- [thinking_trigger.py](../backend/service/vtuber/thinking_trigger.py) — autonomous wake-up when idle
- [tts/](../backend/service/vtuber/tts/) — speech synthesis routing (OmniVoice + alternates)

VTuber tools are deliberately limited: persona-shaping helpers, search, and the `send_direct_message_internal` tool that initiates delegation.

### Thinking trigger

When a VTuber session goes idle for `THINKING_IDLE_SECONDS`, [thinking_trigger.py](../backend/service/vtuber/thinking_trigger.py) emits a `[THINKING_TRIGGER]` self-message. The VTuber wakes up, reflects, and may speak or stay quiet. Useful for keeping the avatar alive between user messages.

## Sub-Worker session

Spawned on demand. Lives in the same `service/executor/` machinery but with a different manifest:

- Larger tool budget (full MCP registry + built-ins)
- Longer guard limits (iterations, token budget)
- No persona prompt; instead a focused goal injected by the VTuber
- Default model: Opus 4.7 (slower per token, much better at multi-step tools)

Sub-Worker results are routed back to the VTuber via the delegation protocol below; they are not delivered directly to the user.

## Delegation protocol

Implemented in [backend/service/vtuber/delegation.py](../backend/service/vtuber/delegation.py).

Both sides exchange messages with four standard tags:

| Tag                        | Direction              | Meaning                                    |
| -------------------------- | ---------------------- | ------------------------------------------ |
| `[DELEGATION_REQUEST]`     | VTuber → Sub-Worker    | Task assignment with a goal                |
| `[DELEGATION_RESULT]`      | Sub-Worker → VTuber    | Task completion report                     |
| `[THINKING_TRIGGER]`       | System → VTuber        | Idle wake-up                               |
| `[SUB_WORKER_RESULT]`      | System → VTuber        | Auto-report when Sub-Worker finishes       |

Legacy `[CLI_RESULT]` tag is still accepted on read for messages persisted before the rename. Emitters always use `[SUB_WORKER_RESULT]`.

### Message shape

```
[DELEGATION_REQUEST]
From: <vtuber_session_id>
Task: <task_id>

<free-form goal text>
```

`DelegationMessage` ([delegation.py:49](../backend/service/vtuber/delegation.py#L49)) is the canonical struct. Helpers:

- `DelegationMessage.is_delegation_message(text)` — any tag
- `DelegationMessage.is_result_message(text)` — `[DELEGATION_RESULT]` or `[SUB_WORKER_RESULT]`
- `format_delegation_request(...)`, `format_delegation_result(...)` — builders
- `parse_delegation_headers(text)` — extract `from`, `task_id`, etc.

### Loop prevention

`[DELEGATION_RESULT]` and `[SUB_WORKER_RESULT]` are classified as "thinking" by `VTuberClassifyNode` and never re-delegated. This breaks ping-pong between the two sessions: a Sub-Worker result triggers reflection, not another delegation.

### Spawning a Sub-Worker (high-level flow)

1. VTuber calls the `send_direct_message_internal` tool with `target_session_id` of an existing Sub-Worker (or a sentinel that spawns a fresh one)
2. The tool wraps the payload in a `[DELEGATION_REQUEST]` with a generated `task_id`
3. The Sub-Worker session ingests the message and runs `Pipeline.run()` against its own manifest
4. When the Sub-Worker emits its final response, the response is wrapped as `[SUB_WORKER_RESULT]` and routed to the originating VTuber session
5. VTuber's next turn classifies the result as thinking (not a user message), summarizes it, and reports back to the audience

The full mechanics — `task_id` correlation, error propagation, and how delegation interacts with [hitl/](../backend/service/hitl/) approval gates — live in the code; this page just defines the contract.

## Session lifecycle

```
created → idle → active → idle → … → closed
              ↑      ↓
              └─turn─┘
```

- **created** — manifest resolved, credentials installed, no turn yet
- **idle** — waiting for input (user, thinking trigger, or delegation message)
- **active** — `Pipeline.run()` executing; SSE streaming
- **closed** — explicitly ended; logs preserved

For the VTuber, the idle → active → idle cycle is what drives the visible avatar reactions. For a Sub-Worker, the cycle ends with a `[SUB_WORKER_RESULT]` emit before going idle again.

## Error code propagation across sessions

A Sub-Worker failure does not directly fail its VTuber. Instead:

1. Sub-Worker's `Pipeline.run()` raises a `GenyExecutorError`
2. Its `SessionLogger` logs the error with `error_code` set
3. A `[SUB_WORKER_RESULT]` message is generated noting the failure
4. VTuber receives the result, classifies it, and decides how to surface it to the audience (retry, apologize, escalate)

The error code travels through the result text so the VTuber's classifier can pattern-match common failures (e.g. quota exhausted → user-friendly apology).

See [error_codes.md](error_codes.md) for the full code list.

## Where to look for what

| You want to…                                  | Start here                                                                |
| --------------------------------------------- | ------------------------------------------------------------------------- |
| Change how a VTuber reacts to a result        | [vtuber/delegation.py](../backend/service/vtuber/delegation.py) + persona |
| Add a new agent kind (e.g. `analyst`)         | [service/agent_types/](../backend/service/agent_types/) + session model   |
| Tune Sub-Worker tool budget                   | [executor/default_manifest.py](../backend/service/executor/default_manifest.py) |
| Add a new delegation tag                      | `DelegationTag` enum + classifier in vtuber agent                         |
| Inspect a past delegation                     | Session logs — filter by `task_id`                                        |
