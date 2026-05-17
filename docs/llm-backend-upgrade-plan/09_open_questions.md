# 09 · Remaining Open Questions

> 대부분의 결정은 lock됨 (사용자 확인 받음). 본 문서는 *구현 중 마주칠 risk*와 *작은 잔여 결정*만 기록한다.

## A. Locked decisions (참고용 — 더 이상 묻지 않음)

| 항목 | 결정 |
|---|---|
| 모든 provider prod/dev 동작 | **YES, 전부 prod-grade** |
| 자격증명 fail-fast 시점 | **hybrid (session 생성 시 warning + 첫 호출에 fail)** |
| Per-stage `provider_override` + `model_override` UI | **모든 stage에 노출, default collapsed** |
| Claude Code CLI bare mode | **default true, settings에 toggle** |
| Stage 12 sub-agent 안에서 sub-agent (nested) | **차단 (Geny factory가 강제)** |
| Event prefix | `llm_client.cli.*` |
| Provider 저장 위치 | **`config["provider"]` 단일, `strategies["provider"]` 완전 제거** |
| Frontend ProviderId enum 확장 영향 | grep으로 사전 audit (Phase F 작업의 일부) |
| 라이선스/TOS UI 안내 | **하지 않음** (사용자 책임) |
| Sub-agent concurrency | **`descriptor.parallel=True` 시 asyncio.gather + Semaphore** |
| Fork-mode multi-provider | **본 사이클에 포함** |
| CLI daemon-mode | **본 사이클 제외 (후속)** |
| Back-compat / 마이그레이션 | **없음. clean break** |

## B. Implementation risks (구현 중 주의)

### R1. CLI subprocess stdin/stdout deadlock

잘못 짜면 부모/자식 모두 파이프 버퍼 가득 → hang.

**대응:**
- `_cli_runtime`에서 stdout/stderr drain을 별도 task. stdin write도 별도 task. 모두 bounded queue.
- `asyncio.create_subprocess_exec` + `process.stdin.drain()` 패턴.

### R2. stream-json multi-line JSON 가능성

claude는 single-line emit이지만 SDK 업데이트로 깨질 수 있음.

**대응:**
- `parse_stream_json_line`에 multi-line guard: 라인이 `{` 시작이고 `}` 안 끝나면 buffer accumulate.
- 일정 길이 (e.g. 4KB) 초과면 `CLIProtocolError`.

### R3. Fake binary cross-platform

Windows에서 shebang 안 됨.

**대응:**
- 본 사이클은 Linux/macOS 가정.
- pytest marker `@pytest.mark.skipif(platform != "posix")`.
- Windows 지원은 별도 사이클 (있다면).

### R4. Claude Code CLI stream-json schema 변경 (vendor)

Anthropic이 schema 바꾸면 파싱 깨짐.

**대응:**
- `_unknown_line_type` graceful 처리.
- CHANGELOG에 stream-json 가정 명시.
- Phase B의 fixture를 vendor 업데이트마다 재생성하는 절차 문서화.

### R5. Subprocess가 process group 안 만들면 kill-tree 실패

**대응:**
- `start_new_session=True` 명시.
- `os.killpg(os.getpgid(proc.pid), sig)`.

### R6. Geny executor pin 충돌

다른 사이클이 v2.x를 못 받을 수 있음.

**대응:**
- Phase E1에서 `geny-executor>=2.0.0,<2.1.0` 으로 범위 허용.
- 동시 진행 사이클이 있다면 conflict resolve는 별도 PR.

### R7. CLI-managed tools double-execution

Stage 10 capability 분기가 잘못 매칭되면 host + CLI 양쪽 실행.

**대응:**
- Stage 10에 audit log 강제 (skipped reason 명시).
- Conformance `test_cli_managed_tools_not_double_executed`.

### R8. Credentials 누출

`api_key`가 dataclass __repr__, event, log로 누출.

**대응:**
- `ProviderCredentials.__repr__` override → `api_key=<redacted>`.
- event_sink emit 시 credential 필드 strip 헬퍼.
- `tests/llm_client/unit/test_credentials_redaction.py`.

### R9. CLI timeout × retry budget

CLI 60s timeout × retry 3회 = 최악 3분 hang.

**대응:**
- Stage 6 retry total budget을 manifest로 노출 (이미 있는 메커니즘 확인).
- CLI client timeout default를 retry-aware하게 설정 (e.g. 60s × 3 retry = 180s 사용자 노출).

### R10. CLI binary 버전 drift

사용자가 claude/gh 자동 업데이트 시 stream-json schema 호환성.

**대응:**
- `claude --version` health check.
- 알려진 호환 버전 범위 문서화.
- major drift 감지 시 UI banner.

### R11. Parallel sub-agent 머신 부하

`max_concurrent=4`인 CLI sub-agent 4개 동시 → CPU/메모리/네트워크 과다.

**대응:**
- CLI 백엔드 sub-agent의 `max_concurrent` default = 1.
- UI에서 사용자가 명시적으로 올릴 때 경고 표시.

### R12. Sub-agent 안의 CLI 백엔드 process tree

부모 Geny → executor → sub-pipeline → claude subprocess → 그 안에서 또 bash 도구 실행. process tree가 깊어짐.

**대응:**
- `start_new_session=True`로 isolation.
- Geny shutdown 시 모든 자식 process tree kill 검증 (e2e test).

### R13. Capability mismatch가 침묵으로 이어짐

Stage 8 (think) 활성 + stage 6 client `supports_thinking=False` → 사용자 의도와 다른 동작.

**대응:**
- `Pipeline._validate_manifest`에 cross-stage capability check 추가:
  - stage 8 active + stage 6 client.supports_thinking=False → warning emit (fail 아님)
  - stage 11/14/18/19 active + 자기 provider.supports_X=False → warning
- UI에서 capability badge로 시각화.

## C. 잔여 minor 결정 (구현 시 결정해도 됨)

### C1. Sub-agent 결과를 parent에 어떻게 표시할지

현재 [`05 §6`](./05_sub_agent_system.md)에 텍스트 형식 명세:
```
Sub-agent results:
- researcher (anthropic/claude-opus-4-7) ✓: <text>
- ...
```

대안: JSON-structured block. 본 plan은 text. 구현 시 LLM이 더 잘 읽는 형식이 발견되면 변경.

### C2. CLI 백엔드 binary 버전 minimum

`claude --version` 또는 `gh --version` 결과 중 어느 버전부터 호환 보장할지.

**대응:** Phase B/C 끝나면 작성자 머신 버전 + 1~2 마이너 아래까지만 보장. README에 명시.

### C3. Sub-agent metric retention

session.metadata.subagent_runs는 세션 동안 누적 — 길어지면 메모리 부담.

**대응:** 본 사이클은 cap 없음. 사용자가 많이 쓰면 후속에서 결정.

### C4. Default subagent seed (worker/researcher/summarizer/critic) 의 정확한 description

[`04 §6.2`](./04_geny_changes.md#62-agent_typesseedpy-new)에 placeholder 작성. 구현 시 다듬어도 됨.

### C5. CLI 백엔드 mcp_config inline vs path 우선순위

[`04 §2.1`](./04_geny_changes.md#21-sectionspy-최종) `mcp_config_inline`과 `mcp_config_path` 둘 다 settings에 두기로 함. 둘 다 있으면 inline 우선.

## D. Acceptance gate (사이클 종료 시 확인)

[07 §"Done" 조건](./07_rollout_phases.md#done-조건) 10개 충족 + 본 문서의 모든 mitigations이 코드 또는 docs에 반영됨.
