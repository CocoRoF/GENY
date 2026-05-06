# Blog Agent Integration — 운영 가이드

> Geny VTuber ↔ 외부 블로그 (`https://hrletsgo.me`) AI Agent 위임 통합의 운영자 매뉴얼.
> 설계 문서: [BLOG_AGENT_DELEGATION_PLAN.md](../../../BLOG_AGENT_DELEGATION_PLAN.md)

---

## 0. 한 눈에 보는 구조

VTuber 가 `/blog-write` Skill 또는 자유 발화로 작업을 요청하면:

1. `blog_agent_delegate` 가 **즉시 task_id 반환** (turn 종료 비차단)
2. Geny 내부 `BlogTaskRegistry` 의 `pump_task` 가 백그라운드에서 SSE 소비
3. 사용자가 "어디까지 됐어?" 물으면 VTuber 가 `blog_agent_status` 로 진행 조회 → 자연어 paraphrase
4. 블로그 turn 완료 시 `[EXTERNAL_TASK_RESULT]` 봉투가 VTuber inbox 에 자동 도착 → paraphrase turn 트리거 → chat_room broadcast

블로그는 **공개 도메인 외부 호출** — 같은 docker network 가 아님. 모든 호출은 HTTPS + Bearer 토큰.

---

## 1. 셋업 (운영자 1회 작업)

### 1.1 블로그 외부 API 활성 + 키 발급

블로그(`hrletsgo.me`) admin 으로 로그인 → Settings → External API 에서:

  1. `external_api_enabled` 를 **true** 로 설정
  2. **Generate** 버튼으로 새 API 키 발급 (32자 hex)
  3. 발급된 키를 안전 채널로 자기 자신에게 전달

> 키는 admin 비밀번호와 동일 무게로 다룰 것 — 노출 시 즉시 회전.

### 1.2 Geny 측 환경변수 셋업

Geny 백엔드 `.env` 에 다음 6개 키 추가:

```bash
# ─── Blog Agent Integration ───────────────────────────────
# 블로그 외부 API base URL — 도메인까지만 (path 없음)
BLOG_AGENT_BASE_URL=https://hrletsgo.me

# 1.1 에서 발급받은 Bearer 토큰 (admin 비밀번호 무게)
BLOG_AGENT_API_KEY=여기에_발급받은_32자_hex_붙여넣기

# 블로그 측 SDK 가 사용할 모델 ID
BLOG_AGENT_DEFAULT_MODEL=claude-sonnet-4-6

# 한 위임 turn 의 최대 SSE 수신 시간 (초)
BLOG_AGENT_DEFAULT_TIMEOUT_S=600

# SSE frame 이 N초 이상 안 오면 transient 경고
BLOG_AGENT_PUMP_IDLE_GRACE_S=30

# 마스터 스위치 — false 면 모든 blog_agent_* 도구가 명시적 에러 반환
BLOG_AGENT_ENABLED=true

# Sub-Worker 노출 여부 — 기본 false (VTuber 만 사용)
# true 로 바꿔도 Worker env 템플릿이 자동 갱신되지 않으므로
# Geny 재기동 시 새 env 템플릿이 도구를 받게 됨.
BLOG_AGENT_ENABLED_FOR_SUBWORKERS=false

# 한 Geny 세션이 동시에 진행할 수 있는 위임 task 수
BLOG_AGENT_MAX_CONCURRENT_PER_SESSION=2
```

> `.env` 의 값은 부팅 시 한 번 읽혀 ConfigManager 에 seed 된다. 이후 settings UI 에서 변경한 값이 우선.

### 1.3 Geny 재기동

```bash
# dev
docker compose -f docker-compose.dev.yml restart backend

# prod
docker compose -f docker-compose.prod.yml restart backend
```

부팅 로그에서 다음 항목들이 확인되어야 함:

  * `BlogAgentConfig` 가 등록됐다는 줄 (config registry)
  * `blog_agent_tools.py` 가 ToolLoader 에 의해 자동 로드됨
  * `blog-write` Skill 이 bundled skill 로 등록됨

### 1.4 검증

VTuber 세션 채팅창에 다음을 입력:

  * "블로그에 'Hello Geny' 라는 짧은 글 하나 만들어줘"

기대 동작:
  1. VTuber 가 `blog_agent_delegate` 한 번 호출하고 "맡겼어, 잠깐만" 정도로 응답
  2. 30~90 초 후 chat_room 에 자동으로 두 번째 VTuber 메시지 등장 — "다 됐어, 슬러그는 …"
  3. 블로그 (`hrletsgo.me`) 에 새 글이 실제로 생성됨

진행상황 질문 검증:
  * 위 1) 직후 "어디까지 됐어?" 입력 → VTuber 가 `blog_agent_status` 호출 → 자연어 응답 ("이미지 올리는 중이야, 30초 됐어")

취소 검증:
  * 진행 중 "취소해" 입력 → VTuber 가 `blog_agent_cancel` 호출 → 블로그 측 turn 즉시 중단 + "알겠어, 멈췄어"

---

## 2. Sub-Worker 에게도 도구를 노출하고 싶을 때

기본은 VTuber 전용. 변경 절차:

  1. Settings UI 에서 `BlogAgentConfig.enabled_for_subworkers = true` (또는 `.env` 의 동명 키를 true 로)
  2. Geny 재기동 — Worker env 템플릿이 deny 세트가 비어있는 채로 재생성되어 도구를 픽업
  3. 영향: Sub-Worker LLM 의 도구 목록에 5개의 `blog_agent_*` 가 추가됨. **단, `/blog-write` Skill 은 여전히 VTuber 전용** (role gate 가 별개로 동작).

> `/blog-write` Skill 자체를 Sub-Worker 에게도 열고 싶다면 [`Geny/backend/service/skills/install.py`](../../backend/service/skills/install.py) 의 `_SKILL_ROLE_RESTRICTIONS` 항목을 수정.

---

## 3. 키 회전

  1. 블로그 admin 에서 새 키 발급
  2. Geny `.env` 의 `BLOG_AGENT_API_KEY` 갱신 (또는 settings UI 에서 변경)
  3. Geny 재기동 — 진행 중인 turn 은 기존 키로 끝까지 진행, 새 turn 부터 신키 사용
  4. 블로그 admin 에서 구 키 폐기

---

## 4. 진단 / 디버그

### 4.1 telemetry 링

In-process 고정 deque (최대 500건). 코드에서 직접 조회:

```python
from service.telemetry.blog_agent_metrics import history
print(history(limit=20))   # 최근 20건
```

기록 이벤트:
  * `blog_agent.delegate.start`     위임 시작
  * `blog_agent.delegate.complete`  완료 (status=done|cancelled|error)
  * `blog_agent.cancel`             취소
  * `blog_agent.transport_error`    네트워크 / HTTP 실패

API 키는 telemetry 에 절대 들어가지 않음. base_url 만 노출.

### 4.2 task registry 직접 조회

```python
from service.blog_agent.registry import get_blog_task_registry
reg = get_blog_task_registry()

# 특정 세션의 모든 task
for s in reg.list_for_session("vtuber-session-id"):
    print(s.to_status_dict())
```

### 4.3 자주 보는 에러

| 증상 | 원인 | 대처 |
|---|---|---|
| 도구가 `BLOG_AGENT_API_KEY is empty` 반환 | settings/.env 에 키 미입력 | 1.2 절 따라 키 입력 |
| 401 `Invalid API key` | 키 회전이 한쪽에만 적용 | Geny / 블로그 양쪽 키 일치 확인 |
| 403 `External API is disabled` | 블로그 admin 이 `external_api_enabled=false` | 블로그 settings 에서 켜기 |
| `transport timeout` | 외부 도메인 도달 실패 | 호스트 → `https://hrletsgo.me` outbound 방화벽 확인 |
| `이미 N 개의 위임 task 가 진행 중입니다` | 동시 위임 상한 초과 | 진행 task 끝나길 기다리거나 cancel |
| `[EXTERNAL_TASK_RESULT]` 가 chat_room 에 안 보임 | VTuber 의 `_chat_room_id` 미바인딩 | session-room 페어링 상태 확인 |

### 4.4 블로그 측 직접 호출 (curl)

```bash
KEY="..."

# 헬스체크 — 세션 목록
curl -H "Authorization: Bearer $KEY" \
  https://hrletsgo.me/api/v1/agent/external/sessions

# 진행 중 turn 취소
curl -X POST \
  -H "Authorization: Bearer $KEY" \
  https://hrletsgo.me/api/v1/agent/external/sessions/<UID>/cancel
```

---

## 5. 영구 매핑 (한계)

현 v1 의 Geny 세션 ↔ blog_session_uid 매핑은 **in-memory** (AgentSession 인스턴스의 `_blog_session_uid` 속성). Geny 재기동 시 매핑이 손실되며, 재기동 후 첫 위임은 새 블로그 세션을 만든다 (블로그 측 세션 자체는 살아있어 `blog_agent_list_posts` 등으로 확인 가능). 

영구화는 후속 PR 의 영역. 현재 운영에서는 한 번에 같은 위임 컨텍스트를 끝까지 진행하는 것을 권장.

---

## 6. 변경 시 영향 범위 빠른 가이드

| 바꾸려는 것 | 손대는 파일 |
|---|---|
| 도구 4개의 동작 / 추가 | [tools/custom/blog_agent_tools.py](../../backend/tools/custom/blog_agent_tools.py) |
| Skill 가이드 문구 | [skills/bundled/blog_write/SKILL.md](../../backend/skills/bundled/blog_write/SKILL.md) |
| HTTP / SSE 동작 | [service/blog_agent/client.py](../../backend/service/blog_agent/client.py) |
| pump_task 행동 | [service/blog_agent/registry.py](../../backend/service/blog_agent/registry.py) |
| 결과 paraphrase prompt | [service/blog_agent/delivery.py](../../backend/service/blog_agent/delivery.py) |
| VTuber/Worker 노출 정책 | [service/environment/templates.py](../../backend/service/environment/templates.py) |
| Skill role gate | [service/skills/install.py](../../backend/service/skills/install.py) `_SKILL_ROLE_RESTRICTIONS` |
| 새 InteractionEvent 분류 | [service/memory/interaction_event.py](../../backend/service/memory/interaction_event.py) |
| 블로그 측 cancel API | [hr_blog2.0/backend/src/controllers/agent_external.py](../../../hr_blog2.0/backend/src/controllers/agent_external.py) |
