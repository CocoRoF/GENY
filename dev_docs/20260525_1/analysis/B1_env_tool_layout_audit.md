# B1 — 환경 매니페스트 ↔ 도구 노출 구조 정밀 감사

> **Date**: 2026-06-01
> **Method**: 4-agent 병렬 코드 정독 (Stage 0 UI, Stage 10 UI, manifest schema, runtime path)
> **Goal**: Stage 0 ↔ Stage 10 ↔ 호스트 레지스트리(MCP / SKILLS / 커스텀 도구) 사이의 데이터 흐름을 라인 단위로 확정

---

## 1. 현재 manifest 의 도구 관련 필드 (확정)

```
EnvironmentManifest
├── model              (전체 환경의 LLM 모델 기본값)
├── pipeline           (파이프라인 단계 토글 등)
├── tools              ← ToolsSnapshot
│   ├── built_in:    List[str]          # Executor framework 도구 이름 ("Read","Write"... 또는 ["*"])
│   ├── external:    List[str]          # 호스트 GenyToolProvider 도구 이름 ("web_search","blog_agent_delegate"...)
│   ├── adhoc:       List[Dict[str,Any]]# 직렬화된 ad-hoc 도구 정의 (예약, 현재 거의 비어있음)
│   ├── mcp_servers: List[Dict[str,Any]]# MCP 서버 정의 dict 배열
│   └── scope:       Dict[str,Any]      # 도구 컨텍스트 메타
├── stages[...]        ← StageManifestEntry 21개
│   └── [order=10].tool_binding?: { allowed?, blocked?, extra_context? }
└── host_selections    ← HostSelections (호스트 레지스트리 부분참조)
    ├── hooks:       List[str]          # 기본 ["*"]
    ├── skills:      List[str]          # 기본 ["*"]
    └── permissions: List[str]          # 기본 ["*"] (런타임 미적용 — preview)
```

위치:
- pydantic: [geny_executor/core/environment.py:69-187](../../backend/.venv/lib/python3.12/site-packages/geny_executor/core/environment.py)
- TS: [frontend/src/types/environment.ts:64-94](../../frontend/src/types/environment.ts#L64-L94)

---

## 2. UI 영역별 → manifest 필드 매핑 (확정)

### 2.1 Stage 0 "전역 설정" (GlobalSettingsView)

| 좌측 사이드바 | 컴포넌트 | manifest 필드 | 카탈로그 API |
|---|---|---|---|
| 기본 모델 설정 | ModelConfigEditor | `manifest.model.*` | — |
| 스테이지 기본 설정 | PipelineConfigEditor | `manifest.pipeline.*` | — |
| **Executor Built-in (8)** | BuiltinToolsExplorer | `manifest.tools.built_in[]` | `GET /api/tools/catalog/framework` |
| **Geny Built-in (31)** | GenyToolsExplorer | `manifest.tools.external[]` | `GET /api/tools/catalog/external?lang=ko` |
| **MCP (0)** | McpEnvPicker | `manifest.tools.mcp_servers[]` | `GET /api/mcp/custom` |
| 훅 | HookEnvPicker | `manifest.host_selections.hooks[]` | `GET /api/hooks/entries` |
| 권한 | PermissionEnvPicker | `manifest.host_selections.permissions[]` | `GET /api/permissions/*` |
| 스킬 | SkillEnvPicker | `manifest.host_selections.skills[]` | `GET /api/skills/list` |

**구조적 사실**: Stage 0 의 모든 서브탭은 manifest 의 *글로벌 영역* 에 1:1 매핑. **Stage entry 자체가 아님** (실제 stage 0 은 가짜 — 실제로는 manifest 의 top-level 편집).

### 2.2 Stage 10 "도구" (StageDetailView for order=10)

| 섹션 | 컴포넌트 | manifest 필드 |
|---|---|---|
| "이 단계 실행" 토글 | StageDetailView | `stages[order=10].active` |
| **사용 가능한 프레임워크 도구 (38개)** | ToolCheckboxGrid (`Stage10ToolsEditor`) | `manifest.tools.built_in[]` ⚠ **stage-local 아님** |
| MCP 서버 (read-only) | Stage10ToolsEditor 라인 151-181 | `manifest.tools.mcp_servers[]` (Stage 0 와 동일 필드 표시) |
| (단계별 제한 — 미사용) | StageToolBindingEditor | `stages[order=10].tool_binding` |

**핵심 발견**: Stage 10 의 "사용 가능한 프레임워크 도구 (38)" 가 저장하는 곳은 **Stage 0 의 "Executor Built-in (8)" 과 동일한 필드 `manifest.tools.built_in[]`**. 두 화면은 **같은 데이터를 다른 UI로 보여주는 중복 편집기**.

UI 만 다름:
- Stage 0: 프리셋 6개 + 풍부한 필터 (BuiltinToolsExplorer)
- Stage 10: 단순 그리드 + 검색 (ToolCheckboxGrid)

---

## 3. Runtime 데이터 흐름 (단일 게이트 = `manifest.tools.external` + `manifest.tools.built_in`)

```
   manifest.tools.external = ["web_search", "blog_agent_delegate", ...]
   manifest.tools.built_in = ["Read", "Glob", "Grep", ...] 또는 ["*"]
                  │
                  ▼
   Pipeline.from_manifest_async(manifest, adhoc_providers=[GenyToolProvider(tool_loader)])
                  │
                  ▼
   _register_external_tools(manifest, registry, adhoc_providers)
     for name in manifest.tools.external:
         tool = first non-None of [p.get(name) for p in adhoc_providers]
         if tool: registry.register(tool)
         else: warn + skip            ← 모르는 이름은 silent skip
                  │
                  ▼
   _register_built_in_tools(manifest, registry)
     names = manifest.tools.built_in
     if names == ["*"]: every BUILT_IN_TOOL_CLASSES
     else: instantiate each class
                  │
                  ▼
   ToolRegistry (선택된 도구만)
                  │
                  ▼
   SystemStage (Stage 3): state.tools = registry.to_api_format()
                  │
                  ▼
   APIStage (Stage 6): kwargs["tools"] = state.tools
                  │
                  ▼
   Anthropic / claude_code_cli → LLM 이 본 도구 = 정확히 manifest 에 나열된 것
```

**유일한 필터링 지점 = manifest 의 `tools.external` + `tools.built_in`**. 다른 어떤 화이트리스트/deny 도 cycle 20260525_1 정리 후 없음.

위치:
- [pipeline.py:242-279 `_register_external_tools`](../../backend/.venv/lib/python3.12/site-packages/geny_executor/core/pipeline.py)
- [pipeline.py:197-239 `_register_built_in_tools`](../../backend/.venv/lib/python3.12/site-packages/geny_executor/core/pipeline.py)
- [s03_system stage.py:122-123](../../backend/.venv/lib/python3.12/site-packages/geny_executor/stages/s03_system/artifact/default/stage.py)
- [s06_api stage.py:408-409 `_call_kwargs`](../../backend/.venv/lib/python3.12/site-packages/geny_executor/stages/s06_api/artifact/default/stage.py)

---

## 4. 사용자가 지적한 "난잡함" 의 근거 (확정된 문제 4개)

### W11 — Stage 0 의 "Geny Built-in" 명명이 거짓말

해당 카탈로그는 `tool_loader.get_all_names()` (built_in + custom + DB python_inline) 전체:
- 메모리, 지식, 팀+메시징, 웹+브라우저, 게임/크리처 — `tools/built_in/*_tools.py`
- blog_agent_* 5개 — `tools/custom/blog_agent_tools.py` + DB python_inline samples

UI 가 모두 "Geny Built-in" 으로 묶고 카테고리만 "기타 / CUSTOM" 배지로 구분. 사용자 멘탈 모델("custom tools 는 별도 탭에서 미리 정의") 과 맞지 않음.

### W12 — Stage 0 의 "Executor Built-in (8)" 과 Stage 10 의 "사용 가능한 프레임워크 도구 (38)" 가 **같은 필드의 중복 편집기**

- Stage 0 "Executor Built-in" 의 표시는 "8 / 38" — 8개 체크된 상태
- Stage 10 도 "허용 8 / 38" — 같은 8개 체크된 상태
- 둘 다 `manifest.tools.built_in[]` 을 편집/표시. **편집 한 곳이 자동으로 다른 곳 반영**.

문제:
1. 사용자가 "왜 같은 게 두 군데 있지?" 혼란
2. Stage 10 의 메타포 ("이 단계는 도구를 사용한다") 와 다름 — 사실은 stage-local 이 아니라 글로벌 manifest 필드
3. 21단계 파이프라인의 stage 10 가 진짜 stage-local 한 게 없으면 stage 10 의 editor 가 redundant

### W13 — MCP / Custom Tools / Skills 사이의 의미 분기 부재

호스트 레지스트리:
- `customMcpApi`     → `manifest.tools.mcp_servers[]`
- `customToolsApi`   → `manifest.tools.external[]` (이름으로 참조, ToolLoader 가 풀어줌)
- `skillsApi`        → `manifest.host_selections.skills[]`

**다른 채널인데 UI 에선 다 "도구" 처럼 보임**. 사용자가 "blog_agent_delegate 도 custom 인데 왜 SKILLS 가 아니라 Geny Built-in 칸에 있지?" 라고 묻게 됨.

근본 원인: ToolLoader 가 file-system 도구와 DB python_inline 도구를 같은 `custom_tools` dict 에 머지함. 노출 채널이 단일 (`manifest.tools.external`). 사용자 멘탈 모델에서는 "환경관리 → 커스텀 도구 탭" 의 DB 도구는 **별도 카탈로그** 여야 하지만 실제로는 합쳐져 있음.

### W14 — `host_selections.permissions` 는 preview, runtime 미적용

- pydantic 기본값 `["*"]` 로 채워지지만 실제로는 Pipeline 빌드 시 무시됨
- TS 타입에는 reserved 표시되어 있고 backend 도 적용 코드 없음
- 사용자에게는 "권한 룰 선택" 으로 보임 → 잘못된 기대

---

## 5. 정리 방향 (제안, 4 PR 분할)

### PR-Q1 — Stage 0 의 "Geny Built-in" 을 "Custom Tools" + "Built-in tools" 두 갈래로 분리

- **현재**: GenyToolsExplorer 한 탭이 `tools/built_in` + `tools/custom` + DB python_inline 전부 노출
- **변경**:
  - 사이드바 항목 변경:
    - "Geny 내장 도구" → `tools/built_in` 만 (memory_*, knowledge_*, geny_tools, etc.)
    - "커스텀 도구" → `tools/custom` + DB python_inline (blog_agent_*, web_search/news_search/web_fetch, browser_*)
  - 각각 별도 카탈로그 endpoint:
    - `GET /api/tools/catalog/geny-builtin` — file-system built_in only
    - `GET /api/tools/catalog/custom` — file-system custom + DB python_inline
  - 두 탭 모두 `manifest.tools.external[]` 에 저장 (manifest schema 는 그대로)
- **효과**: 사용자가 "blog_agent_* 는 환경관리 → 커스텀 도구 탭에서 정의된 것" 이라는 멘탈 모델 일치

### PR-Q2 — Stage 10 의 "사용 가능한 프레임워크 도구" 를 Stage 0 와 동기화 + 명시적 cross-link

- **현재**: Stage 10 와 Stage 0 가 같은 `manifest.tools.built_in[]` 을 양쪽에서 편집 가능 → 중복
- **변경**:
  - Stage 10 의 편집 UI 제거 (read-only 미리보기로 강등)
  - Stage 10 에는 "이 환경의 framework 도구는 Stage 0 → Executor Built-in 에서 편집됩니다" 안내문 + "전역으로 이동" 버튼
  - 실제 stage-local 한 설정만 Stage 10 에 둠 → `stages[10].tool_binding` (allowed/blocked) 만
- **효과**: 한 필드 = 한 편집기. 사용자가 "stage 10 가 진짜로 stage-specific 한 게 뭐냐" 명확해짐

### PR-Q3 — `host_selections.permissions` UI 제거 또는 명시적 "Preview" 라벨

- **현재**: PermissionEnvPicker 가 일반 UI 처럼 보이지만 runtime 무영향
- **변경**:
  - 권한 패널 헤더에 "Preview — 현재 런타임 미적용" 명시 (이미 i18n에 "preview" 단어 있음)
  - 또는: 사이드바에서 권한 항목 자체 숨김 (`GENY_PERMISSIONS_PREVIEW=1` 환경변수로 opt-in)
- **효과**: 사용자가 잘못된 기대 안 가지게

### PR-Q4 — manifest 의 `tools` 필드 명명 정리 (선택, 큰 변경)

- **현재**: `tools.built_in` vs `tools.external` — "built_in" 이 framework 도구를 가리키고 "external" 이 호스트 도구를 가리킴. 이름이 직관 반대.
- **변경 후보**:
  - `tools.framework[]` (executor's BUILT_IN_TOOL_CLASSES)
  - `tools.host[]`      (Geny's ToolLoader — file-system + DB python_inline)
  - `tools.mcp[]`       (그대로)
- **트레이드오프**: schema 변경 → migration 필요. 기존 환경 json 호환성 처리 필요. 이번 사이클에서 안 해도 됨.

---

## 6. 다음 단계 (사용자 결정 대기)

1. PR-Q1 (Geny Built-in → Built-in + Custom Tools 분리) 부터 진행? 우선순위 가장 높아 보임.
2. PR-Q2 (Stage 10 read-only) 와 PR-Q1 동시 또는 순차?
3. PR-Q3 (권한 Preview) 와 PR-Q4 (필드명 정리) 는 이번 사이클 포함? 아니면 다음 사이클로?

답주면 PR-Q1 부터 시작.
