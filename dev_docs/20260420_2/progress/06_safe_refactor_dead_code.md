# 06 — Geny safe-refactor dead code (PR6, Phase C 준비)

- **Repo**: `Geny` (backend)
- **Plan 참조**: `plan/01_unified_tool_surface.md` §"단일 전환 계획" 2단계
- **Branch**: `feat/geny-tool-provider-dead-code`
- **PR**: [CocoRoF/Geny#135](https://github.com/CocoRoF/Geny/pull/135)
- **의존**: geny-executor v0.22.0 (Release 태그 참고).

## 변경 요지

Phase C 의 **safe-refactor** PR. 스위치오버 (PR8) 가 필요로 하는 두
모듈을 **dead code 로** 먼저 도입. 현재 FastAPI 부트 그래프 어디에서도
import 되지 않으므로, 머지해도 런타임 동작에 영향이 없다. 리뷰 범위를
"추가만" 으로 고정해, PR8 이 "교체만" 하도록 분리한 설계.

## 추가 / 변경된 파일

1. **신규** `backend/service/langgraph/geny_tool_provider.py`
   - `GenyToolProvider(tool_loader)` 클래스. 구조적으로
     `geny_executor.tools.providers.AdhocToolProvider` Protocol
     (`@runtime_checkable`) 을 만족 (`list_names() / get(name)`).
   - **상속 없음 / 덕 타이핑**: executor Protocol 에 대한 import 실패가
     발생하는 예전 버전 (pre-0.22.0) 환경에서도 모듈이 로드 가능.
     adapter 본체는 기존 `tool_bridge.py::_GenyToolAdapter` 를 그대로
     재사용 (PR7/PR8 이 이 adapter 를 ToolFailure 기반으로 마이그할
     때 단일 지점만 손보면 됨).
   - adapter caching: 세션마다 동일 tool 을 다시 어댑트하지 않도록
     내부 dict 로 메모이즈.

2. **신규** `backend/service/langgraph/default_manifest.py`
   - `build_default_manifest(preset, *, model=None, external_tool_names=None)`
     순수 함수. 지원 preset: `vtuber / worker_adaptive / worker_easy /
     default(alias → worker_adaptive)`. 알 수 없는 preset 은
     `ValueError` 로 loud fail.
   - 반환 `EnvironmentManifest` 는:
     - `tools.built_in = [Read, Write, Edit, Bash, Glob, Grep]`
       — 현재 `AgentSession._build_pipeline` 이 수동 register 하는 6개.
     - `tools.external = external_tool_names` — Geny provider 백엔드용
       화이트리스트.
     - `stages=[]` (이번 PR 에서는 비어 있음). PR8 이 `GenyPresets.*` 를
       삭제하면서 stage 구성을 여기에 옮기고, runtime-scoped 의존
       (memory_manager, callbacks) 은 pipeline 조립 후에 attach.
   - executor import 는 함수 호출 시점에 지연 수행 → 모듈 자체 import 는
     0.20.1 환경에서도 안전.

## 검증

- `python -m py_compile` — 두 모듈 모두 성공.
- `grep -R "GenyToolProvider\|build_default_manifest\|geny_tool_provider\|
  default_manifest" backend/` → self-reference 외 0건 (진짜 dead code
  확인).
- v0.22.0 설치된 venv 에서 smoke:
  - `isinstance(GenyToolProvider(fake_loader), AdhocToolProvider)` →
    `True`.
  - `build_default_manifest("default").metadata.base_preset ==
    "worker_adaptive"`.
  - `build_default_manifest("nope")` → `ValueError` (알려진 preset 나열).
  - `external_tool_names=["news_search"]` → `ToolsSnapshot.external` 로
    정확히 round-trip.

## 호환성

- **No runtime impact.** 기존 AgentSession / EnvironmentService 경로는
  변화 없음. 사용자 트래픽은 이전과 동일.
- `geny-executor` 의존성 pin 은 그대로 (`>=0.20.1`). PR8 이
  `>=0.22.0,<0.23.0` 로 바꾸면서 dead code 를 활성화.

## 후속 TODO

- **PR7**: `tool_bridge.py` 의 "(parse error)" swallower 제거 + Phase D
  관측성 개선.
- **PR8** (Phase C switch-over):
  - `backend/pyproject.toml`: `geny-executor>=0.22.0,<0.23.0`.
  - `AgentSession._build_pipeline`: `GenyPresets.*` 블록 전면 제거,
    `prebuilt_pipeline` 분기 유지, 그 외는 `Pipeline.from_manifest_async
    (build_default_manifest(preset), api_key=..., adhoc_providers=
    [GenyToolProvider(tool_loader)])` 단일 경로로 통합.
  - `service/environment/service.py::instantiate_pipeline`:
    `Pipeline.from_manifest_async(..., adhoc_providers=[geny_provider])`
    로 전환 (env_id 경로).
  - `GenyPresets.*` 에 있던 stage 구성 / memory reflector 설정을
    `build_default_manifest` 에 이관 + post-construction attach 헬퍼
    추가.
  - 기존 `tool_bridge.build_geny_tool_registry` 호출부 제거
    (SessionManager 가 registry 를 pre-build 하던 경로가 없어짐).
