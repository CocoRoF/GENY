# PR C2 — test(llm_client): copilot_cli conformance + bump v2.0.0

| 항목 | 값 |
|---|---|
| Repo | `geny-executor` |
| Branch | `feat/llm-backend/c2-copilot-conformance` (deleted) |
| Base SHA | `f99d0d7` |
| PR # | [#198](https://github.com/CocoRoF/geny-executor/pull/198) |
| Merge SHA | `20ca976` |
| Status | **merged** |

## 변경

- `tests/llm_client/conformance/test_copilot_cli.py` (NEW, 8 케이스)
- `pyproject.toml` version `1.21.0` → **`2.0.0`**
- `src/geny_executor/__init__.py` `__version__` 동일
- `CHANGELOG.md` 2.0.0 entry (Added / Changed / Removed / Migration notes)

## Phase A/B/C 완료 시점 통계

- 누적 9 PR (executor) + 1 PR (Geny plan)
- `ClientRegistry.available()`: 4 → **6** providers
- 새 모듈: `_cli_runtime.py`, `credentials.py`, `claude_code.py`, `copilot.py`, `translators/_cli.py`
- 삭제: `bridge.py` (ProviderBackedClient)
- 테스트: 3091 → **3205** (+114)
- 회귀: 0

## Phase 끝 → PyPI 직전 상태

이제 Phase D (sub-agent multi-provider)가 남았다. D 완료 후 v2.0.0을 PyPI에 publish하고 Geny가 그것을 pin하면서 Phase E 진입.

## Rollback

```bash
git revert 20ca976 --no-edit && git push origin main
```
