# Stage 10 = 도구의 단일 진입점, Stage 0 = 전역 defaults 만

> **Cycle**: 20260525_1
> **Status**: 계획 (사용자 검토 대기)
> **Date**: 2026-06-01
> **Background**: [B1 — 환경 매니페스트 ↔ 도구 노출 구조 정밀 감사](../analysis/B1_env_tool_layout_audit.md) 에서 식별된 W11 + W12 의 정리. 사용자 결정: Stage 0 은 진짜 글로벌 (모델 + 파이프라인) 만 남기고, 도구 관련 일체는 Stage 10 으로 통합.

---

## 1. 한 문장 요약

Stage 0 의 도구 관련 서브탭(Executor Built-in / Geny Built-in / MCP) 을 모두 제거하고 Stage 10 안에서 **"카테고리별 카탈로그 + 픽커"** 형태로 일원화. Stage 10 이 도구의 단일 편집기가 된다.

---

## 2. 목표 구조 (after)

### Stage 0 — 전역 설정 (lean)

좌측 사이드바 (단 2개 항목):

| 항목 | manifest 필드 |
|---|---|
| **기본 모델 설정** | `manifest.model.*` (provider / model / sampling / thinking) |
| **스테이지 기본 설정** | `manifest.pipeline.*` (단계 토글 등 cross-stage default) |

도구 관련 항목 (Executor Built-in / Geny Built-in / MCP / 훅 / 권한 / 스킬) 은 Stage 0 에서 **완전히 제거**.

> 단, Hooks / 권한 / Skills 은 도구는 아니지만 (Hooks=pre/post 명령, Skills=프롬프트+도구 묶음, 권한=runtime 미적용) — 이 PR cycle 의 범위에서는 **건드리지 않음**. 별도 사이드바 탭(환경관리 → HOOK / 권한 / SKILLS) 이 이미 호스트 단위 편집 제공. Stage 0 에서 host_selections 선택은 다음 사이클에서 별도 검토.

### Stage 10 — 도구 (single source)

좌측 카테고리 사이드바 + 메인 픽커:

```
┌─ Stage 10 — 도구 ────────────────────────────────────────┐
│                                                          │
│  ┌─ 카테고리 ───────────┐ ┌─ 픽커 ─────────────────────┐ │
│  │ Executor Built-in    │ │ (선택된 카테고리의 도구    │ │
│  │   (38 중 8개)        │ │  목록 + 체크박스)           │ │
│  │                      │ │                             │ │
│  │ Geny Built-in        │ │                             │ │
│  │   (17 중 15개)       │ │                             │ │
│  │                      │ │                             │ │
│  │ Custom Tools         │ │                             │ │
│  │   (DB · 5개)         │ │                             │ │
│  │                      │ │                             │ │
│  │ MCP Servers          │ │                             │ │
│  │   (0개)              │ │                             │ │
│  └──────────────────────┘ └─────────────────────────────┘ │
│                                                          │
│  단계 토글 ── "이 단계 실행" (스테이지 active flag)        │
│  단계별 제한 (선택) ── tool_binding.allowed/blocked         │
└──────────────────────────────────────────────────────────┘
```

각 카테고리 → 동일한 `manifest.tools.*` 필드 편집:

| 카테고리 | manifest 필드 | 카탈로그 endpoint |
|---|---|---|
| **Executor Built-in** | `tools.built_in[]` | `GET /api/tools/catalog/framework` |
| **Geny Built-in** | `tools.external[]` (file-system `tools/built_in/*_tools.py` source 만) | `GET /api/tools/catalog/external?source=builtin` |
| **Custom Tools** | `tools.external[]` (file-system `tools/custom/*_tools.py` + DB python_inline) | `GET /api/tools/catalog/external?source=custom` |
| **MCP Servers** | `tools.mcp_servers[]` | `GET /api/mcp/custom` |

> **Geny Built-in vs Custom Tools 갈래**: ToolLoader 가 `_tool_source` dict 로 각 도구의 출처 stem 을 이미 기록. `tool_source` 가 `_PLATFORM_TOOL_SOURCES` (geny_tools, memory_tools, knowledge_tools, memory_inspect_tools) 인 도구 = Geny Built-in. 그 외 (blog_agent_tools, browser_tools, web_search_tools, web_fetch_tools) 와 DB python_inline = Custom Tools. **manifest 필드는 같지만 UI 카테고리만 다름**.

### Sidebar 사이드바 탭 (환경관리 dropdown) — 호스트 등록소

이건 그대로 유지 — 도구 *정의* 와 *환경별 선택* 의 분리.

| Sidebar 탭 | 역할 | manifest 와의 관계 |
|---|---|---|
| 환경관리 | env CRUD + 21단계 편집기 진입 | manifest 자체 |
| MCP | 호스트에 MCP 서버 등록 | `/api/mcp/custom` 의 CRUD. manifest 의 `tools.mcp_servers` 에 이름으로 참조됨 |
| SKILLS | 호스트에 skill 등록 | `/api/skills/*`. 환경별 선택은 (현재) host_selections.skills |
| **커스텀 도구** | 호스트에 custom tool 등록 (DB python_inline) | `/api/custom-tools`. 환경별 선택은 Stage 10 의 "Custom Tools" 카테고리 |
| HOOK | 호스트에 hook 등록 | 별도 |
| 권한 | 호스트에 permission rule 등록 | 별도 (preview) |
| 트리거 관리 | VTuber idle trigger preset | 별도 |

사용자 멘탈 모델: **호스트 등록소 (sidebar) 에서 정의 → Stage 10 에서 선택**.

---

## 3. 변경 범위 (3 PR 분할)

### PR-Q1 — Stage 0 에서 도구 서브탭 제거 + Stage 10 에 카테고리 사이드바 도입

**Frontend 변경**:
- `GlobalSettingsView.tsx` 의 `Panel` 타입에서 다음 항목 제거:
  - `executor_builtin` / `geny_builtin` / `mcp` (3개 제거)
  - 좌측 사이드바 항목 줄어서 2개만 (모델 / 파이프라인)
- `Stage10ToolsEditor.tsx` 재작성:
  - 좌측: `executor` / `geny` / `custom` / `mcp` 4-카테고리 토글
  - 우측: 선택된 카테고리에 맞는 picker
    - `executor` → 기존 `ToolCheckboxGrid` (`/api/tools/catalog/framework`)
    - `geny` → 신규 grouped picker (메모리/지식 그룹화)
    - `custom` → 신규 picker (DB + file system custom)
    - `mcp` → 기존 MCP picker
- 단계 토글 + tool_binding 은 별도 섹션 으로 분리 (heading)

**Backend 변경**:
- 신규 endpoint:
  - `GET /api/tools/catalog/external?source=builtin` → 파일시스템 `tools/built_in/*_tools.py` 도구만
  - `GET /api/tools/catalog/external?source=custom` → 파일시스템 `tools/custom/*_tools.py` + DB python_inline 도구
- 또는 기존 `GET /api/tools/catalog/external` 응답에 `source: "builtin"|"custom"|"db"` 필드 추가 (frontend filter)
- `tool_controller.py` 의 catalog builder 가 `tool_loader.get_tool_source(name)` 기반으로 분류

**Test plan**:
- 기존 환경 (test, vtuber-dev 등) manifest 불변 검증 — 필드명 안 바꿈
- Stage 0 → 사이드바에 2개만 보임
- Stage 10 → 4 카테고리 모두 정상 노출, 체크 상태 = 기존 manifest 와 일치
- 체크박스 토글 → manifest 의 적절한 필드 (`tools.built_in` / `tools.external` / `tools.mcp_servers`) 가 갱신

**산출물**: PR. 라인 추정 ~700 (frontend reorganize 위주, backend는 catalog endpoint 갈래만 추가).

---

### PR-Q2 — Geny Built-in / Custom Tools 카테고리 분류 + UX 정리

PR-Q1 에서 4-카테고리 구조가 들어가면, PR-Q2 는 그 안의 분류 quality 를 손봄.

**Frontend 변경**:
- `Custom Tools` 카테고리 picker:
  - DB python_inline (`source_kind="db_python_inline"`) 와 파일시스템 custom (`tool_source ∈ {blog_agent_tools, browser_tools, web_search_tools, web_fetch_tools, ...}`) 를 모두 표시
  - 각 row 에 출처 배지 (`DB` / `FILE`) 추가
  - DB 행이면 "📝 편집하기" 링크 → 사이드바 커스텀 도구 탭의 form modal 로 jump
  - 파일 행이면 read-only (배지 + 도움말 "이 도구는 backend/tools/custom/*.py 에 정의됨")
- `Geny Built-in` 카테고리 picker:
  - 기존 GenyToolsExplorer 의 카테고리 grouping (메모리/지식/팀+메시징/웹+브라우저/게임·크리처) 유지
  - "기타" 카테고리는 사라짐 — 이건 PR-Q1 에서 분류 명확해진 결과
  - 빠른 프리셋 버튼 (메모리+지식 / 팀+메시징 / ... ) 도 유지

**Backend 변경**:
- `tool_controller.py` 응답 schema 에 `source_kind: "executor_builtin" | "geny_builtin" | "custom_file" | "custom_db"` 추가
- 분류 로직 `_classify_tool_source(tool_name)`:
  ```python
  if tool_name in BUILT_IN_TOOL_CLASSES:
      return "executor_builtin"
  source = tool_loader.get_tool_source(tool_name)
  if source in _PLATFORM_TOOL_SOURCES:  # geny_tools, memory_*, knowledge_*
      return "geny_builtin"
  if name in tool_loader._db_custom_names:
      return "custom_db"
  return "custom_file"
  ```

**산출물**: PR. ~400 lines.

---

### PR-Q3 — Stage 0 ↔ Stage 10 cross-link 정리 + 명명 일관성

- Stage 0 사이드바 항목이 줄어서 헛헛해진 만큼, 명확한 cross-link 추가:
  - Stage 0 의 안내 영역에 "도구 설정은 Stage 10 으로 이동했습니다 → [Stage 10 으로 이동]" 링크 (보조 카드)
- 21단계 progress bar 의 stage 10 가 "도구 8/47" 같은 카운트 배지 표시 (지금은 활성 여부만)
- i18n 키 정리:
  - `envManagement.topTabs.tools` 가 호스트 등록소(커스텀 도구) 와 Stage 10 (도구 단계) 사이에서 헷갈리지 않도록 라벨 분리
- 문서: `docs/architecture.md` 에 "도구 정의 (sidebar 탭) vs 도구 선택 (Stage 10)" 절 추가

**산출물**: PR. ~200 lines, 주로 i18n + docs.

---

## 4. 데이터 모델은 **변경 없음**

`manifest.tools.*` 필드 (`built_in` / `external` / `adhoc` / `mcp_servers`) 는 그대로. UI 만 재배치.

→ 기존 environment json (template-vtuber-env, template-worker-env, 사용자의 vtuber-dev / test 등) 마이그레이션 불필요. backward-compat 보장.

다음 사이클에서 manifest 의 필드명 변경 (`built_in` → `framework`, `external` → `host`) 을 고민할 수는 있지만 이번 사이클의 범위 밖.

---

## 5. 비-목표 (Out of scope)

- 단계별 tool_binding (allowed/blocked) UI 강화 — 별도 사이클
- `host_selections.permissions` runtime 적용 — 별도 사이클
- Skills 의 Stage 3 (system prompt) 와 Stage 10 (도구) 양쪽 영향 모델링 — 별도 사이클
- manifest 필드 rename (`built_in` → `framework`) — 별도 사이클
- 환경별 hook/permission/skill 선택을 사이드바에서 inline 편집할 수 있게 만들기 — 별도 사이클

---

## 6. 리스크

| 리스크 | 가능성 | 영향 | 완화 |
|---|---|---|---|
| Stage 0 사이드바 항목이 줄어들면 사용자가 "권한/Hook/Skills 어디 갔지?" 혼동 | 中 | 中 | Stage 0 에 "도구 / Hooks / 권한 / Skills 은 별도 위치로 이동" 안내 카드. 환경관리 dropdown 의 호스트 등록소 탭으로 가는 링크 |
| 기존 환경 manifest 의 `tools.built_in = ["*"]` (전체 와일드카드) 가 Stage 10 의 새 UI 에서 "38/38 선택됨" 처럼 표시되어 사용자가 "왜 다 선택?" 오해 | 中 | 低 | 와일드카드 명시적 표시 (`✓ 전체 선택 (와일드카드)`) + 명시적 선택으로 전환 시 자동으로 `["*"]` → 실제 38개 이름 배열로 확장 |
| 카테고리 분류 로직 (`_classify_tool_source`) 의 stem 기반 매칭이 새 도구 추가 시 빠뜨림 | 低 | 低 | `unknown` 카테고리 fallback 둠. 신규 도구는 일단 unknown 으로 표시되고 화면에서 즉시 인지 가능. PR description 에 "신규 도구 추가 시 `_classify_tool_source` 확인" 체크리스트 |
| PR-Q1 머지 직후 frontend 캐시 / nginx upstream issue | 中 | 中 | memory 의 `nginx reload after backend recreate` 룰 적용. 배포 후 즉시 reload + 검증 |

---

## 7. 결정 필요 사항 (진행 전 확인)

1. **카테고리 4개 (executor / geny / custom / mcp)** 이 맞나? 아니면 더 세분화 (예: custom 안에서 file vs db 를 다시 갈래)?
2. **Stage 10 의 단계 토글 + tool_binding** 은 카테고리 영역과 별도 섹션으로 둬도 되나? 아니면 stage 자체 설정으로 보고 카테고리 위에 두는 게 자연스럽나?
3. **PR 머지 순서** 는 Q1 → Q2 → Q3 순차 OK?
4. **마이그레이션 가드** — 기존 환경의 `tools.built_in = ["*"]` 와일드카드 표시 방식, 사용자 의도?
   - (A) 와일드카드 그대로 표시 + 빠른 토글
   - (B) 머지 첫 진입 시 "전체 38개로 펼치시겠습니까?" prompt
   - (C) 자동 펼침 (manifest 가 변하니까 신중)

답주면 PR-Q1 부터 시작.
