# PR A3 — refactor(pipeline): unify provider location + CredentialBundle + conformance harness

## 메타데이터

| 항목 | 값 |
|---|---|
| Repo | `geny-executor` |
| Branch | `feat/llm-backend/a3-provider-unification` (deleted after merge) |
| Base SHA | `8261ed3` |
| Commit SHA | `6e379cf` |
| PR # | [#193](https://github.com/CocoRoF/geny-executor/pull/193) |
| Merge SHA | `6fd3f02` |
| Status | **merged** |
| Date | 2026-05-17 |

## 변경 파일

```
 M src/geny_executor/__init__.py
 M src/geny_executor/core/pipeline.py
 M src/geny_executor/core/stage.py
 M src/geny_executor/core/state.py
 M src/geny_executor/llm_client/__init__.py
 D src/geny_executor/llm_client/bridge.py
 M src/geny_executor/skills/fork.py
 M src/geny_executor/stages/s06_api/artifact/default/stage.py
 M tests/unit/test_llm_client_state.py
 M tests/unit/test_manifest_v2.py
 M tests/unit/test_pipeline_from_manifest.py
 A tests/unit/test_manifest_provider_validation.py
 A tests/llm_client/conformance/__init__.py
 A tests/llm_client/conformance/harness.py
 A tests/llm_client/conformance/test_anthropic.py
 A tests/llm_client/conformance/test_openai.py
 A tests/llm_client/conformance/test_google.py
 A tests/llm_client/conformance/test_vllm.py
```

## 변경 요약

### Pipeline (`core/pipeline.py`)

- `from_manifest{,_async}`에 `credentials: CredentialBundle` 인자 추가. `api_key` 인자는 *legacy/test convenience*로 유지 — auto-wraps to `{"anthropic": ProviderCredentials(api_key=...)}`.
- `_validate_manifest_provider_locations`: strict mode에서 `strategies['provider']` 거부 + active stage 6의 `config['provider']` 필수 검증.
- `_resolve_llm_client` 단일-소스: attached → stage 6 provider + bundle → None. ProviderBackedClient fallback **제거**.
- `_build_client_for(provider) / _creds_to_client_kwargs(provider, creds)` 헬퍼.
- `pipeline._credentials` 슬롯, `_init_state`에서 `state.credentials`로 전파.

### PipelineState (`core/state.py`)

- `credentials: Optional[Any]` 슬롯 — pipeline credentials 미러링.

### Stage (`core/stage.py`)

- `resolve_local_client(state)` 헬퍼 — `config["provider_override"]` 존재 시 stage-local client 빌드 (`state.credentials` + `ClientRegistry`). override 없으면 `state.llm_client`.

### APIStage (`stages/s06_api/artifact/default/stage.py`)

- "provider" strategy slot **제거**. retry/router만 남음.
- 생성자는 string (manifest 경로) 또는 legacy `APIProvider` (test fixture 경로) 둘 다 인정. legacy는 inline `_LegacyProviderAdapter`로 래핑.
- `api_key/base_url/default_headers`는 test convenience로 유지. manifest 경로는 빈 채로 둠.
- `_resolve_client`: state.llm_client 필수. 없으면 legacy adapter → local-build → `APIError`.
- `get_config / update_config`에서 provider strategy 변경 코드 제거. schema는 ClientRegistry + "mock"을 옵션으로 노출.

### bridge.py — **DELETED**

`ProviderBackedClient` 사라짐. 유일한 책임은 `APIStage` 안의 inline `_LegacyProviderAdapter`로 흡수.

### `llm_client/__init__.py`

- 추가 export: `AnthropicClient`, `CredentialBundle`, `ProviderCredentials`, `ConfigError`.
- 제거 export: `ProviderBackedClient`.

### `geny_executor/__init__.py`

- 동일한 export 조정.

### `skills/fork.py`

- 기본 fork runner가 `ProviderBackedClient` 대신 `AnthropicClient` 직접 호출.
- TODO 주석: Phase D4에서 CredentialBundle 기반 multi-provider로 재배선.

### 테스트

- `tests/unit/test_llm_client_state.py` 새 contract로 재작성 (attach_runtime + FakeClient).
- `tests/unit/test_manifest_v2.py`: blank-manifest 검증을 `config['provider']` 기준으로 변경. api_key rebuild test가 CredentialBundle + AnthropicClient 검증으로 전환.
- `tests/unit/test_pipeline_from_manifest.py`: strict-without-key 통과 (build-time 자격증명 요구 안 함); non-strict가 stage 6를 drop하지 않음.
- `tests/unit/test_manifest_provider_validation.py` (NEW): 7개 케이스 — strategies/config 거부 규칙, api_key auto-wrap, bundle 우선순위.
- `tests/llm_client/conformance/` (NEW): harness + 4 provider 모듈, 25 케이스 — capability-aware contract checks.

## 검증

| 항목 | 결과 |
|---|---|
| `pytest tests/unit/ tests/llm_client/` | ✅ 2472 passed, 1 skipped |
| `pytest tests/contract/ tests/integration/ tests/completeness/` | ✅ 587 passed, 7 skipped |
| `pytest tests/` 전체 | ✅ **3091 passed, 8 skipped, 0 failed** |
| 기존 4 provider conformance | ✅ 25 케이스 모두 통과 |
| 기존 4 provider 동작 변경 | ✅ default값으로 인해 변동 없음 |

## Rollback

```bash
cd /home/geny-workspace/geny-executor
git revert 6fd3f02 --no-edit
git push origin main
```

## Phase A 완료

A1 + A2 + A3로 Phase A (Foundation) 종료. executor v2.0.0의 데이터 모델 + 단일 자격증명 채널 + manifest 검증 + conformance harness가 모두 자리잡음. 다음은 Phase B (Claude Code CLI).

## 다음 PR (B1)

- `translators/_cli.py` — claude_code argv 빌더 + stream-json 어셈블러
