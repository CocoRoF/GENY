# 00. Methodology — 어떻게 갭을 식별했는가

본 분석의 모든 발견은 *코드 근거* (file_path:line) 가 있다. 추측이나 사용자 인터뷰가 아니라 코드와 코드의 부재를 비교한 결과.

---

## 1. 3-축 매핑

각 capability 는 세 축에서 검증한다:

```
┌─────────────────────────────────────────────────────────────┐
│  Axis A: Backend API surface                                │
│    "REST endpoint 가 존재하는가?"                            │
│    출처: backend/controller/*.py + main.py:include_router   │
├─────────────────────────────────────────────────────────────┤
│  Axis B: Frontend UI surface                                │
│    "사용자가 볼 / 편집할 화면이 있는가?"                      │
│    출처: frontend/src/components/tabs/*.tsx + components/   │
├─────────────────────────────────────────────────────────────┤
│  Axis C: Data shape / schema                                │
│    "사용자가 의미 있게 입력할 수 있는 schema 인가?"            │
│    출처: pydantic Models + register_config schemas          │
└─────────────────────────────────────────────────────────────┘
```

## 2. 갭의 4 등급

매트릭스의 각 셀은 다음 중 하나:

| 기호 | 의미 |
|---|---|
| ✅ | full visibility + editability |
| 🟡 | partial — view만 / 일부 필드만 / 또는 schema 없는 raw JSON |
| ❌ | API endpoint 없음 또는 UI 없음 (gap) |
| 🚫 | intentional — 의도적으로 노출하지 않음 (보안 / 도메인 외) |

**예 (built-in tool):**
- Axis A: `/api/tools/catalog/built-in` ✅ 존재
- Axis B: SessionToolsTab 에서 chip 으로 *수* 만 보여줌 🟡 (개별 도구 정보 없음)
- Axis C: BUILT_IN_TOOL_CLASSES 의 33개 schema 그대로 노출 가능 ✅

→ 종합: 🟡 (API 있지만 UI 가 surface 못함)

## 3. 데이터 수집 방법

### 3.1 Backend endpoint 인벤토리

```bash
grep -rn "@router\|@app\." backend/controller/ | wc -l
```

92 endpoint 발견. 각 endpoint 마다:
- HTTP method + path
- pydantic 응답 모델
- require_auth 적용 여부
- CRUD 분류 (Create / Read / Update / Delete)

### 3.2 Frontend 컴포넌트 인벤토리

```bash
ls frontend/src/components/tabs/*.tsx
```

19 tab 발견. 각 컴포넌트마다:
- 호출하는 backend API
- 사용자가 할 수 있는 액션 (조회 / 생성 / 수정 / 삭제)
- 어떤 데이터를 다루는지

### 3.3 Cross-reference

각 backend endpoint 가 어떤 frontend 컴포넌트에 의해 호출되는지 grep:

```bash
grep -l "agentTasksApi\|backgroundTaskApi" frontend/src/
```

호출되지 않는 endpoint = "API 만 있고 UI 없음" 의 후보.
호출되지만 일부 필드만 surface 되는 컴포넌트 = "🟡 partial".

## 4. 핵심 가정

### 가정 1: "사용자" 는 operator 또는 developer

End-user (LLM 의 대화 상대) 는 분석 대상 아님. 본 분석의 "사용자" 는:
- Geny 인스턴스를 운영하는 operator
- preset / tool / setting 을 조정하는 developer
- session 을 만들어 task 를 돌리는 power user

### 가정 2: "visibility" 는 "editability" 보다 우선

view 가 안 되는 데이터는 편집할 의향이 안 생김. UI 갭의 우선순위는:
1. "현재 무엇이 활성인지" 보여주기 (viewer)
2. "그것을 어떻게 바꾸는지" 알려주기 (editor)
3. "바꾼 게 적용됐는지" 검증하기 (feedback)

세 단계 다 있어야 완성. 본 분석은 1+2+3 세 layer 모두 짚는다.

### 가정 3: 모든 capability 가 UI 가 필요한 건 아니다

내부 strategy slot (예: `cache_strategy`) 같은 것은 framework concern 이라 사용자 UI 가 필요 없을 수 있음. 본 분석은 *operator 가 의도적으로 조정하고 싶을 capability* 에만 집중.

판단 기준:
- 그 항목을 바꾸면 session 동작이 *눈에 띄게* 달라지는가? → UI 필요
- framework 가 알아서 처리하는 inner detail 인가? → UI 불필요

## 5. 한계

### 5.1 본 분석은 *기능* 갭이 아닌 *visibility* 갭

기능 자체가 부족한 것은 `new-executor-uplift/` 가 다뤘다. 본 분석은 "기능은 있는데 사용자가 못 봄" 만.

### 5.2 본 분석은 *aesthetic* 디자인 아님

색상 / 폰트 / 마진 같은 visual design 은 다루지 않음. "정보가 노출되는가" 만.

### 5.3 본 분석은 *manual smoke test 데이터* 없음

CI 환경에서 작성. 실제 운영자가 어떤 화면에서 헷갈리는지의 *행동 데이터* 는 없음. 운영 후 검증 권장.

---

## 다음 문서

- [`01_capability_visibility_matrix.md`](01_capability_visibility_matrix.md) — 전체 매트릭스
