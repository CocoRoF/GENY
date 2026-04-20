# 02 — MCP 도구 네임스페이스 prefix (PR2, Phase A)

- **Repo**: `geny-executor`
- **Plan 참조**: `plan/02_host_contract_hardening.md` §C
- **Branch**: `feat/mcp-namespace-prefix`
- **PR**: [CocoRoF/geny-executor#23](https://github.com/CocoRoF/geny-executor/pull/23)
- **의존**: PR1 (`CocoRoF/geny-executor#22`) 의 `ToolError / ToolFailure`

## 변경 요지

모든 MCP 도구는 registry 에 등록될 때 **반드시** `mcp__{server}__{tool}` 로
표시된다. 이는 per-server 옵션이 아니라 **invariant** 다. 두 서버가 같은
이름을 공개해도 이름 공간이 분리되어 충돌 자체가 성립하지 않는다. 동시에
`ToolRegistry.register` 가 "다른 인스턴스" 로 같은 이름을 재등록하는 경우
warning 을 남겨, built-in / adhoc 측 중복 등록은 즉시 탐지된다.

## 추가 / 변경된 파일

1. **수정** `src/geny_executor/tools/mcp/adapter.py`
   - 생성자에서 `_display_name = f"mcp__{server.config.name}__{raw}"` 를 계산.
     `.name` 은 prefixed, `.raw_name` / `.server_name` 에 원본 보존.
   - `execute()` 는 `self._raw_name` 으로 MCP 서버를 호출. 서버가 예외를
     던지면 `ToolFailure(code=TRANSPORT, details={server, tool, ...})` 로
     변환 → 라우터 (PR1) 가 구조화된 `ToolError` 로 마감.
   - 이전의 `ToolResult(is_error=True, content=str(exc))` 경로는 제거.

2. **수정** `src/geny_executor/tools/registry.py`
   - `register()` 가 기존 이름을 "다른 Tool 인스턴스" 로 덮어쓸 때
     `logger.warning("tool name collision: '%s' re-registered ...")` 를 emit.
     동일 인스턴스 재등록은 경고하지 않음 (idempotent 등록 허용).

3. **신규** `tests/unit/test_mcp_namespace.py` (9 tests, 전부 PASS)
   - Adapter: prefixed `.name`, `.raw_name`, `.server_name`, `to_api_format`
     의 `name` 필드, 서버 A/B 가 같은 이름을 공개해도 prefix 로 분리됨.
   - Execute: 내부적으로 `raw_name` 으로 MCP 서버를 호출함 (prefix 가 네트워크
     로 새지 않음).
   - TRANSPORT bridging: 세션 예외 → `ToolFailure` with code / details 검증.
   - Registry collision: 서로 다른 인스턴스 → warning emit, 같은 인스턴스
     → no warning, 이름이 다르면 warning 없음, MCP prefixed vs built-in 은
     서로 다른 슬롯.

4. **수정** `tests/unit/test_phase5_emit_presets_mcp.py::test_mcp_tool_adapter`
   - 원래 `adapter.name == "read_file"` 기대 → `"mcp__test__read_file"` 로
     업데이트. `raw_name`, `server_name` 어설션 추가.

## 검증

- `pytest tests/unit tests/contract tests/integration` → **965 passed,
  5 skipped**.
- 신규 파일 9 tests + 수정 테스트 1 개가 모두 새 prefix 규칙을 명세화.

## 호환성 경고

- **Breaking**: 기존 manifest 에 MCP tool 이름을 unprefixed 로 명시한 경우
  Stage 10 에서 `unknown_tool` 에러. 이는 plan/01 의 migration 스크립트
  (PR6, Geny 측) 가 `tools.mcp_servers[*].name` 을 읽어 prompt / allowlist
  참조를 일괄 변환하여 해결한다.

## 후속 TODO (다음 PR)

- PR3 (Phase B): `Pipeline.from_manifest` 가 `MCPManager.connect_all +
  discover_all` 을 **세션 시작 시** 수행하며, 서버 연결/discovery 실패는
  즉시 raise. `MCPManager.add_server / remove_server` 가 등록/해제까지 일괄
  책임.
