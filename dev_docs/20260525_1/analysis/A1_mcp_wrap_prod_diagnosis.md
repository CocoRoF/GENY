# A1 — claude_code_cli MCP-Wrap Prod 진단 결과

> **Date**: 2026-05-25
> **Method**: 116.47.69.209:2222 prod backend container에서 진단 스크립트 직접 실행
> **Conclusion**: master_plan v2에 적힌 약점 **W1, W2, W3, W4, W5, W8, W9, W10** 모두 prod 발현 확정

---

## 1. 환경 상태 확인 (basics)

| 항목 | 값 |
|---|---|
| BlogAgentConfig.enabled | `true` |
| BlogAgentConfig.api_key | present |
| BlogAgentConfig.base_url | `https://hrletsgo.me` |
| BlogAgentConfig.default_model | `claude-sonnet-4-6` |
| CLIBackendClaudeCodeConfig.enabled | `true` |
| CLIBackendClaudeCodeConfig.api_key | present |
| `claude` binary | `/usr/bin/claude` v2.1.145 |
| ToolLoader 로드 | 47 tools (built-in 31 + custom 16, blog 5개 모두 포함) |
| env `034fba082724` (사용자 "test") | s6=`claude_code_cli`, blog 5개 manifest.tools.external 에 포함 |

→ **Config 자체는 정상**. 문제는 wrap 메커니즘에 있음.

---

## 2. 약점별 prod 실측 결과

### W1: schema가 auto-injected `session_id`를 LLM에 노출

```
blog_agent_delegate: required=['session_id', 'task']  ⚠SID leak=True
blog_agent_status:   required=['session_id']           ⚠SID leak=True
blog_agent_cancel:   required=['session_id', 'task_id'] ⚠SID leak=True
blog_agent_list_posts: required=[]
blog_agent_get_post:   required=['slug']
```

**평가**: 3/5 blog tool이 `session_id`를 required로 LLM에 노출. LLM은 description의 "adapter가 자동 주입" 안내를 무시하고 hallucinated 값(빈 문자열, 추측한 UUID 등)을 넣을 수 있음. tool_bridge.py:159와 mcp_bridge_controller.py:211의 `setdefault` 가드는 LLM이 *어떤 값이라도* 넣으면 bypass됨.

---

### W2: `agent._allowed_tools` 는 죽은 코드

```
$ grep -rn "_allowed_tools = " /app/{service,controller}
(no matches)

list_session_tools advertises full registry (no filter)
  total advertised: 47 (registry size: 47)
  matches? True
```

**평가**: 어디에도 set되지 않음. MCP bridge는 ToolLoader의 **모든 47개 tool** 노출. 환경 매니페스트의 `tools.external` whitelist가 MCP 단계에서 **무시**됨. 보안/UX 측면에서 의도와 다른 동작.

---

### W3: deprecated tool_preset 살아있음

```
ROLE_DEFAULT_PRESET['vtuber'] = 'template-vtuber-tools'
preset 'template-vtuber-tools' EXISTS
  custom_tools = ['web_search', 'news_search', 'web_fetch']
  blog tools in there? False
```

**평가**: 사용자가 환경관리에서 매니페스트로 vtuber 환경을 만들어도 tool_preset 경로가 별도로 살아있음. 두 출처가 다른 답을 줘서 디버그 시 혼란.

---

### W4: 🎯 **silent failure** — `_err()` 가 `isError: false` 로 LLM에 전달

```
[blog_agent_delegate, BlogAgentConfig.enabled=False, real prod]
isError = False
text    = '{"error": "Blog Agent integration is disabled. Admin must enable it in Settings → Blog Agent."}'
parsed  = {'error': 'Blog Agent integration is disabled. ...'}
↑ body has 'error' key=True but MCP reports isError=False
```

**평가**: **이게 사용자가 보고한 "blog tool 제대로 작동 안 함"의 결정적 원인**. tool이 `_err(...)`로 JSON string을 정상 return → mcp_bridge_controller.py:248-249가 이를 `isError: false` 로 LLM에 전달 → LLM은 "tool 성공, 결과는 `{"error": "..."}` 텍스트" 로 인식 → "맡겼어, 잠깐만" paraphrase → 사용자 대기.

발생하는 모든 silent failure 경로 (in `blog_agent_tools.py`):
- `_check_enabled` 실패: disabled, key 빈 값, base_url 빈 값
- `task` 빈 문자열
- 동시 위임 상한 초과 (`active >= max_concurrent_per_session`)
- blog session uid 획득 실패 (`failed to obtain blog session`)

→ 사실상 **모든 외부 의존성 실패가 silent**.

---

### W5: TypeError가 LLM에 traceback 노출

```
[blog_agent_status with {"fake_arg": "X"}]
WARNING mcp_bridge: tool 'blog_agent_status' raised: BlogAgentStatusTool.run() got an unexpected keyword argument 'fake_arg'
text="Tool error: BlogAgentStatusTool.run() got an unexpected keyword argument 'fake_arg'"
isError=True
```

**평가**: class 이름(`BlogAgentStatusTool`) + Python 내부 메서드 이름(`run`)이 LLM에 노출. 정보 leak. 또한 W10 (additionalProperties 없음) 때문에 hallucinated arg가 항상 통과 → 이 traceback이 자주 트리거됨.

---

### W6, W7: token lifecycle / bridge orphan

이번 진단에서는 실제 subprocess spawn까지 안 가서 직접 검증 불가. 코드 단계에서 (master_plan §2 W6/W7 참고) 확인된 약점 — 수정 대상에 포함.

---

### W8: 신규 CLI가 보내는 MCP probe들이 모두 method-not-found

```
resources/list:         error code=-32601 msg='method not found: resources/list'
prompts/list:           error code=-32601 msg='method not found: prompts/list'
logging/setLevel:       error code=-32601 msg='method not found: logging/setLevel'
completion/complete:    error code=-32601 msg='method not found: completion/complete'
```

**평가**: Claude Code CLI 2.1.x 는 위 4가지를 capability probe로 보냄. 모두 error로 답하면 CLI logs가 시끄러워지고 일부 케이스에서 retry로 latency 추가. 빈 응답으로 우호적 처리 필요.

---

### W9: `initialize` 가 임의 protocolVersion echo back

```
[client sends protocolVersion="2099-99-99-LIES"]
protocolVersion echoed back: '2099-99-99-LIES'
```

**평가**: 서버가 "지원함"이라고 거짓말. 추후 호환 안 되는 method 호출 시 깨짐. 서버는 자신이 지원하는 버전 advertise해야 함.

---

### W10: schema에 `additionalProperties` 없음

```
모든 5개 blog tool: additionalProperties=<UNSET>
```

**평가**: LLM이 hallucinated arg 추가해도 JSON Schema validation 통과. 그 결과 W5의 TypeError가 빈번하게 트리거됨.

---

## 3. 사용자가 보고한 증상과의 연결

> "claude code를 backend로 한 경우 geny가 가지고 있는 blog-tool 같은 것이 제대로 작동하지 않음"

이 증상은 **W4 + W1의 조합**으로 설명됨:

1. **W4** (silent failure envelope): config가 살짝이라도 어긋나면 (예: 첫 호출 직전 reload 중, 또는 `_check_enabled` 의 다른 fail case) `{"error":"..."}` JSON이 isError=false로 가서 LLM은 "성공"으로 처리. paraphrase → 사용자는 "맡겼다"고 듣고 기다리지만 실제로는 task가 시작 안 됨.

2. **W1** (session_id leak): LLM이 hallucinated session_id를 보내고 adapter의 `setdefault` 가 이걸 그대로 사용 → blog_agent_registry가 그 잘못된 session_id에 task를 기록 → 호출자(real VTuber session)의 inbox에 결과가 안 도착.

3. **W5 + W10** (extra arg → traceback): LLM이 description을 잘못 읽고 추가 arg를 보내면 `TypeError`가 raw text로 LLM에 노출 → LLM이 "tool 사용법이 이상해" 라고 user에게 fallback 응답.

세 경로가 결합해서 "안 됨" 의 다양한 패턴을 만듦. **anthropic API에서는 잘 동작**한다는 사용자 진술과도 일치 — anthropic LLM(Claude)이 description을 더 잘 따라서 session_id를 hallucinate하지 않거나, 빈 task 같은 케이스를 시도하지 않아서 W4 fail path가 덜 트리거됨. claude_code_cli의 sub-process LLM (특히 Sub-Worker로 위임된 경우)은 description을 덜 정확히 따름.

---

## 4. PR #1 (Phase A2)의 최소 수정 범위 (확정)

진단으로 확정된 **8개 약점 (W1-W5, W8-W10)** + 코드 검토 단계의 W6, W7 도 같이.

| # | 약점 | 위치 | 수정 |
|---|---|---|---|
| W1 | session_id schema leak | tools/base.py + tool_bridge.py + mcp_bridge_controller.py | `INJECTED_PARAMS` 도입, schema generator가 제외, adapter는 무조건 overwrite |
| W2 | _allowed_tools 죽은 코드 | mcp_bridge_controller.py:135-149 | 제거 (또는 manifest 기반으로 재배선 — 다음 사이클) |
| W3 | deprecated tool_preset | service/tool_preset/templates.py | `create_vtuber_tools_preset` 제거 + ROLE_DEFAULT_PRESET vtuber 제거 |
| W4 | silent error envelope | mcp_bridge_controller.py + tool_bridge.py + tools/base.py | tool이 `{"error":...}` JSON 반환 시 자동으로 isError=true 변환. BaseTool에 `ToolError` 도입, blog tool 일부 _err를 raise 로 점진 변경 |
| W5 | traceback leak | mcp_bridge_controller.py:234-241 | exception 메시지 sanitize (class 이름 제거), 상세는 logger.error 만 |
| W6 | token lifecycle | agent_session_manager.py | `_session_tokens: dict[sid, token]` 도입, `delete_session` 정리 |
| W7 | bridge orphan | scripts/geny_mcp_bridge.py | parent pid monitor 또는 PR_SET_PDEATHSIG (Linux) |
| W8 | unknown methods | mcp_bridge_controller.py:421-423 | resources/list, prompts/list, logging/setLevel, completion/complete 각각 빈 응답 |
| W9 | protocolVersion echo | mcp_bridge_controller.py:285-301 | 우리가 지원하는 버전(`2024-11-05`) advertise, client값 무시 |
| W10 | additionalProperties | tools/base.py:72-76 | schema에 `"additionalProperties": False` 강제 |

회귀 테스트:
- `tests/integration/test_mcp_wrap_robustness.py` — 위 W1, W4, W5, W10 각 시나리오 + 정상 호출
- `tests/integration/test_mcp_protocol.py` — W8, W9 + initialize/tools/list

---

## 5. 다음 단계

PR #1 구현 — [01_phase_a_implementation.md](../plan/01_phase_a_implementation.md) 에서 파일별 수정 사양 작성 후 즉시 코드 변경 시작.
