# 05 — geny-executor v0.22.0 릴리즈 (PR5, Phase A–C host 묶음)

- **Repo**: `geny-executor`
- **Plan 참조**: `plan/05_rollout_and_regression.md` §"host 릴리즈"
- **Branch**: `release/v0.22.0`
- **PR**: [CocoRoF/geny-executor#26](https://github.com/CocoRoF/geny-executor/pull/26)
- **Tag / Release**: [v0.22.0](https://github.com/CocoRoF/geny-executor/releases/tag/v0.22.0)
- **의존**: PR1 (`#22`), PR2 (`#23`), PR3 (`#24`), PR4 (`#25`)

## 변경 요지

Phase A / B / host-side Phase C 를 **하나의 breaking 릴리즈** 로 묶음.
downstream (Geny) 가 `geny-executor>=0.22.0,<0.23.0` 으로 pin 한 번만
이동하면 4개의 계약 변경을 한 번에 받아들이는 구조. PR6 (이번
safe-refactor), PR7 (logging), PR8 (switch-over) 이 이 릴리즈 위에 서 있음.

## 추가 / 변경된 파일 (이 PR 기준)

1. `pyproject.toml` — `version = "0.22.0"` (was `0.20.1`; 0.21.x 는 건너뜀).
2. `src/geny_executor/__init__.py` — `__version__ = "0.22.0"`.
3. **신규** `CHANGELOG.md` — [Keep a Changelog] 포맷의 0.22.0 엔트리:
   - Added: `ToolError` / `ToolFailure` / `ToolErrorCode`,
     `validate_input`, `MCPConnectionError`, `Pipeline.from_manifest_async`,
     `MCPManager.add_server / remove_server`, `AdhocToolProvider`
     Protocol, `ToolsSnapshot.external`, `Pipeline.from_manifest[_async]
     (adhoc_providers=, tool_registry=)`.
   - Changed (breaking): mandatory `mcp__{server}__{tool}` namespace,
     fail-fast MCP lifecycle, `call_tool` 반환 타입 확장, registry
     collision 경고, default router structured error payload.
   - Dependencies: `jsonschema>=4.0` 추가.
   - 네 PR (#22–#25) 링크, migration note 4개 블록.

## 검증

- `pytest tests/unit tests/contract tests/integration` → **1003 passed,
  5 skipped** (PR4 와 동일).
- `python -c "import geny_executor; print(geny_executor.__version__)"` →
  `0.22.0` 확인.
- `git tag -a v0.22.0` + `git push origin v0.22.0` + `gh release create v0.22.0`
  로 GitHub Release 게시.

## 호환성 경고 (CHANGELOG.md 요약)

- MCP tool 이름: `read_file` 등의 bare 참조를 모두
  `mcp__{server}__{tool}` 로 교체 필요.
- MCP manifest: 깨진 MCP server 정의는 이제 session start 단계에서
  `MCPConnectionError` 로 실패. deploy 전에 stale entry 정리.
- Tool error parsing: 구 `result.content.startswith("Error:")` 경로 →
  `result.is_error` + `content["error"]["code"]` 로 이행.
- (Opt-in) `AdhocToolProvider` 훅을 쓰는 호스트는 env_id / non-env_id
  세션을 `Pipeline.from_manifest_async(...)` 단일 경로로 수렴 가능.

## 후속 TODO

- **PR6** (이미 별도 엔트리 — 06): Geny safe-refactor dead code.
- **PR7**: Geny logging swallower 제거 (Phase D).
- **PR8**: Geny cutover — pin 변경 + legacy 경로 삭제 + 실제 활성화.
