# PR A2 — feat(llm_client): add _cli_runtime + credentials primitives

## 메타데이터

| 항목 | 값 |
|---|---|
| Repo | `geny-executor` |
| Branch | `feat/llm-backend/a2-cli-runtime-credentials` (deleted after merge) |
| Base SHA | `70e98c3` |
| Commit SHA | `2895945` |
| PR # | [#192](https://github.com/CocoRoF/geny-executor/pull/192) |
| Merge SHA | `8261ed3` |
| Status | **merged** |
| Date | 2026-05-17 |

## 변경 파일

```
 A src/geny_executor/llm_client/_cli_runtime.py
 A src/geny_executor/llm_client/credentials.py
 A tests/_fixtures/__init__.py
 A tests/_fixtures/fake_echo_cli.py
 A tests/llm_client/__init__.py
 A tests/llm_client/unit/__init__.py
 A tests/llm_client/unit/test_credentials.py
 A tests/llm_client/unit/test_cli_runtime.py
```

## 변경 요약

### `_cli_runtime.py` (NEW)

- `CLIProcessRunner` (async dataclass) — `asyncio.create_subprocess_exec(shell=False, start_new_session=True)`. `run_oneshot(argv, stdin=)` / `stream(argv, stdin_iter=)`. timeout enforce + kill-tree (SIGTERM → grace → SIGKILL via `killpg`).
- `scrub_env(parent, whitelist, extras)` — host env → child env 화이트리스트 (HOME/PATH/USER/LOGNAME/LANG/LC_ALL/LC_CTYPE/TERM/TMPDIR/TZ). 외부 env 누출 차단.
- `parse_stream_json_line(line)` — JSON 객체 1줄 디코딩. malformed → `{"__malformed__": "..."}`.
- `detect_binary(name, override)` — override 우선 → `shutil.which`.
- `aiter_bytes(data)` — 단일 bytes를 async iterator로 래핑 (stdin_iter용).
- 예외 5종: `CLIBinaryNotFound`, `CLIAuthFailed`, `CLITimeout`, `CLIProtocolError`. ErrorCategory.CLI_* 와 1:1 매핑.

### `credentials.py` (NEW)

- `ProviderCredentials` (frozen dataclass) — `api_key` / `base_url` / `default_headers` / `binary_path` / `extras`. `__repr__`에서 `api_key=<redacted>` 강제 redact.
- `CredentialBundle` (frozen) — `by_provider: Mapping[str, ProviderCredentials]`. `get()` (soft) / `require()` (raises `ConfigError`) / `has()` / `providers()`.
- `ConfigError` 예외 (`GenyExecutorError` 상속).
- back-compat 헬퍼 (`from_legacy_api_key`, `from_env`) **없음**. 호출자가 명시적으로 구성.

### Test fixtures

- `tests/_fixtures/fake_echo_cli.py` — 단일 Python 스크립트 fake CLI. 서브커맨드: `echo`, `echo-stdin`, `fail`, `hang`, `lines`, `json-stream`. shebang + chmod +x.

### 테스트 (신규)

- `tests/llm_client/unit/test_credentials.py` — 24개 케이스 (defaults, empty, redact, frozen, bundle CRUD, require raise).
- `tests/llm_client/unit/test_cli_runtime.py` — 20개 케이스 (detect_binary / scrub_env / parse_stream_json_line / runner spawn / oneshot / streaming / stdin round-trip / timeout / kill-tree / non-zero exit).

## 검증

| 항목 | 결과 |
|---|---|
| `pytest tests/llm_client/unit/` | ✅ 44 신규 모두 pass |
| `pytest tests/unit/ tests/llm_client/` | ✅ 2471 passed, 1 skipped, 0 failed |
| 기존 4 provider 동작 변경 없음 | ✅ — production 코드 추가만, 수정 없음 |

## Rollback

```bash
cd /home/geny-workspace/geny-executor
git revert 8261ed3 --no-edit
git push origin main
```

## 계획 조정 메모

본래 plan의 A2에 포함되었던 `bridge.py` 삭제 + `__init__.py` re-export 정리 + s06_api/pipeline fallback 제거는 **A3로 이동**. 이유:

- `bridge.py` (ProviderBackedClient)를 삭제하려면 `skills/fork.py`, `stages/s06_api/.../stage.py`, `core/pipeline.py`, `__init__.py` (2곳), `tests/unit/test_llm_client_state.py`를 동시에 정리해야 함.
- 그 정리는 모두 `Pipeline.from_manifest_async(credentials=...)` 시그니처 변경과 한 묶음.
- → A3 단일 PR에서 모두 처리하는 게 깨끗하다.

## 다음 PR (A3)

- `Pipeline.from_manifest_async(credentials=)` 시그니처 변경 (api_key 인자 제거)
- `_resolve_llm_client` 단순화 — `config["provider"]` 단일 위치
- `strategies["provider"]` 모든 곳에서 제거 (mutation.py, environment.py 검증)
- `bridge.py` 삭제 + 모든 `ProviderBackedClient` 사용처 정리
- `skills/fork.py` 임시 직접 client 사용으로 변경 (D4에서 CredentialBundle 기반 재배선)
- `stages/s06_api/artifact/default/stage.py` 생성자 단순화
- `core/stage.py` `resolve_local_client(state)` helper
- 21-stage 변경 (2/6/10/11/14/18/19에서 `resolve_local_client` 사용)
- Conformance harness skeleton + 4 기존 provider 테스트
