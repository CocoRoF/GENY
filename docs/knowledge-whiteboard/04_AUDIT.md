# 04 — Post-launch audit: agent usage, UX flow, curation mechanism

> *P0~P5 + 9 fix + 1 deep-review (PR #722–#738) 후, 실사용 관점에서 화이트보드가 정말 "동작" 하는지 코드 레벨로 점검한 결과.*

작성일: **2026-05-11**
선행 문서: [02_ARCHITECTURE.md](02_ARCHITECTURE.md), [03_PLAN.md](03_PLAN.md)
검토 방식: 코드 read-through (3 영역 병렬 audit) — 디자인 의도 vs 현재 구현 vs 사용자 가설 시나리오

---

## 0. 요약 — 무엇이 작동하고, 무엇이 비어있는가

| 영역 | 인프라 | 실사용 | 차이 |
|---|---|---|---|
| **데이터 모델 (P0)** | ✅ 완료 | ✅ 동작 | — |
| **Inbox UI (P1)** | ✅ 완료 | ⚠️ 카드 제목이 timestamp 만 — scannable 하지 않음 | UX |
| **Spotlight + ViewLedger (P2)** | ✅ 코어 완료 | ⚠️ 시각화 부재 (현재 활성 spotlight 어디서 보는지) | UX |
| **Capture sources (P3)** | ✅ 완료 | ✅ 동작 | — |
| **분석 도구 (P4)** | ✅ 완료 | ❌ **VTuber 기본 roster 에서 빠짐** | 통합 |
| **Organizer (P5)** | ✅ 코어 완료 | ❌ **Accept 가 제안을 *실행* 안 함** | 스펙/구현 미스매치 |
| **Library 공유 (P2a fix)** | ✅ 동작 | ⚠️ 첨부 미복사, 벡터 갱신 지연, 출처 가시성 ✗ | 통합/UX |
| **VTuber persona 통합** | △ SpotlightContextBlock | ❌ vtuber.md / persona 가 도구를 *언급* 안 함 | 발견성 |

가장 큰 결함은 **인프라가 완성되었는데 에이전트와 사용자 모두 그것을 모른다** 는 점.
일반적인 사용자 흐름이 **자기 발견(self-discovery)** 에 의존하고 있고,
에이전트는 자기가 갖고 있는 도구를 *호출* 할 단서가 부족하다.

---

## 1. Agent 측 — VTuber 가 화이트보드를 얼마나 *사용* 하는가

### 1.1 도구 발견성 — `whiteboard_*` 가 기본 roster 에서 빠짐

[backend/service/environment/templates.py:61-73](../../backend/service/environment/templates.py#L61) 의 `_VTUBER_CUSTOM_TOOL_WHITELIST` 는 `whiteboard_describe` / `whiteboard_extract_links` 를 포함하지 않는다.

영향:
- 사용자가 비전 비가용 모델의 VTuber 에게 이미지를 spotlight → SpotlightContextBlock 이 `[image attachment, ~X KB. Describe by asking the user…]` placeholder 만 보냄
- 에이전트는 `whiteboard_describe` 가 존재하는지조차 모름 → "이미지 설명을 부탁하세요" 라고 사용자에게 되묻기만 함

### 1.2 페르소나가 도구를 안 알려줌

[backend/prompts/vtuber.md](../../backend/prompts/vtuber.md) 에는 `memory_*` 도구 언급은 있으나 `knowledge_*` / `opsidian_*` / `whiteboard_*` 는 **전혀 언급 없음**.

[backend/service/memory/host_memory_tools_block.py](../../backend/service/memory/host_memory_tools_block.py) 가 메모리 도구를 surface 하지만 — 화이트보드 도구는 같은 식 surface 가 없다.

영향:
- 사용자가 명시 spotlight 안 한 상태에서 "내 노트 중 X 좀 찾아봐" 요청 → VTuber 가 도구를 *자발적으로* 못 찾음
- 매 세션마다 사용자가 "knowledge_search 써봐", "opsidian_search 써봐" 를 가르쳐야 함

### 1.3 SpotlightContextBlock 의 페르소나 가이드라인이 **조건부**

[backend/service/whiteboard/spotlight_block.py:55-72](../../backend/service/whiteboard/spotlight_block.py#L55) — `PERSONA_GUIDANCE` 는 활성 spotlight 항목이 *있을 때만* 시스템 프롬프트에 추가됨.

영향: spotlight 가 없는 일반 turn 에서는 페르소나가 spotlight 라는 개념 자체를 모름. 사용자가 처음 share 했을 때 "spotlight 가 뭐죠?" 같은 반응이 나올 수 있음.

### 1.4 `[USER_SHARED]` 트리거에 노트 *내용* 없음

[backend/service/whiteboard/user_shared_trigger.py:34-47](../../backend/service/whiteboard/user_shared_trigger.py#L34) 의 `_compose_trigger_prompt` 가 보내는 JSON:

```json
{
  "title": "...",
  "kind": "user",
  "source_filename": "...",
  "excerpt": "...",   ← 본문 400자만
  "seen_before": false,
  "attachments_count": 1
}
```

내용은 400자 발췌만. 이미지 첨부일 때 (excerpt 가 빈 경우) 트리거가 *왜 봤어야 하는지* 단서 부족. 그래서 1.1 의 `whiteboard_describe` 가 더 절실.

### 1.5 큐레이션 도구도 기본 비활성

[backend/service/config/sub_config/general/ltm_config.py:72](../../backend/service/config/sub_config/general/ltm_config.py#L72) — `curated_knowledge_enabled: bool = False`.

P2a fix 가 user_opsidian 의 default 를 True 로 했지만, `curated_knowledge_enabled` 는 그대로. 즉:
- VTuber 가 user opsidian 은 읽을 수 있음 (default-on)
- Curated 는 못 읽음 (default-off)

이게 묘한 비대칭이고, Library mode 로 share 해도 VTuber 가 거기서 못 찾는 결과 가능.

### 1.6 ViewLedger 의 `⚑` 힌트가 한 번만 보임

`knowledge_search` 결과의 `_view` 메타 는 **그 turn 의 tool result** 에만 들어감. 다음 turn 의 system prompt 에는 다시 안 나타남 (SpotlightContextBlock 이 그 노트를 spotlight 하지 않는 한).

영향: 에이전트가 5턴 전에 `read` 한 노트를 다시 마주칠 때 "처음 보는 자료" 처럼 다룰 수 있음. ViewLedger 의 효과가 spotlight 항목에 한정됨.

---

## 2. UX 측 — 사용자의 6가지 시나리오 점검

### 2.A "캡처 → 공유" — 동작은 함, 카드 식별성 떨어짐

[whiteboard_controller.py:239](../../backend/controller/whiteboard_controller.py#L239) `_default_title_for(...)` — 캡처 노트 제목이 `"Image 2026-05-11 14:32:15"` 같은 timestamp.

영향: Inbox 에 20+ 캡처 쌓이면 어느 게 어느 거인지 모름. 카드 클릭으로 일일이 열어봐야 함.

### 2.B "지난번 공유한 노트 다시 찾기" — **출처 가시성 없음**

User Opsidian 측에서 "이 노트는 Spotlight/Library 로 공유됨" 표시가 어디에도 없음. Curated 측에서도 "이건 사용자가 직접 promote 한 것" 표시가 없음. Backend 의 `source: share:user_library:...` 메타가 있지만 UI 가 그것을 표시하지 않음.

### 2.C "Organizer Accept" — **실제로 아무 일도 일어나지 않음**

[backend/controller/whiteboard_controller.py:906-932](../../backend/controller/whiteboard_controller.py#L906) `organizer_accept`:

```python
record = update_status(mgr.vault_root, suggestion_id, status="accepted", ...)
return {"suggestion": record.to_dict()}
```

`status` 만 `accepted` 로 바꾸고 끝. `proposed_action` (group / merge / promote_to_library / archive / tag) 가 **실제로 실행되는 코드 경로가 없음**.

설계 문서 (`docs/knowledge-whiteboard/02_ARCHITECTURE.md` §11.7) 에는:
> "Organizer 는 **제안만**, CurationEngine 은 **실행**. ... Organizer 가 'Library 로 올리자' 제안 → 사용자 Accept → **그제야 CurationEngine 호출**"

하지만 그 "그제야 호출" 코드가 누락됨. 즉 사양 ↔ 구현 미스매치.

영향: 사용자가 Accept 클릭 → 카드 사라짐 → 노트는 그대로 inbox 에. "안 됐나?" 의심.

### 2.D Curated 뷰의 첨부 — **wikilink 깨질 가능성**

[whiteboard_controller.py:777-850](../../backend/controller/whiteboard_controller.py#L777) `share_to_library` 가 본문 (`body`) 만 복사. `_attachments/` 는 user vault 에만 존재.

[frontend/src/components/curated-knowledge/CuratedKnowledgeView.tsx](../../frontend/src/components/curated-knowledge/CuratedKnowledgeView.tsx) 가 사용하는 `whiteboardApi.attachmentUrl(path)` → `/api/opsidian/attachments/...` 는 user vault 의 첨부를 fetch.

따라서:
- ✅ User 가 origin note + 첨부 모두 유지하는 동안에는 curated 측에서도 image 렌더됨
- ❌ User 가 origin 노트 삭제 → curated 측 image 깨짐 (P5 백로그)

### 2.E "현재 활성 Spotlight" — UI 없음

`GET /api/opsidian/spotlight` 엔드포인트는 있으나 frontend 가 그것을 표시하는 컴포넌트 없음. 사용자는 share 후 toast 만 보고 끝. "30분 후 expire 됨" 도 안 보임.

### 2.F "Un-share / Revoke" — 없음

`DELETE /api/opsidian/spotlight/{id}` 도 endpoint 만 있고 UI 없음. 한번 잘못 공유하면 30분 기다리기.

---

## 3. Curation 측 — 자동 vs 명시 두 경로의 *공존*

### 3.1 두 경로 결과물의 미세한 차이

| 항목 | Path A (`curate_note`) | Path B (`share_to_library`) |
|---|---|---|
| LLM quality scoring | ✅ | ❌ (사용자 의도 신뢰) |
| Category 보존 | ✅ (LLM 이 suggest 가능) | ❌ (`inbox`/`root`/`daily` → `topics` 강제) |
| 첨부 처리 | ❌ ignore | ❌ ignore (wikilink만 복사) |
| Frontmatter `source` | `"auto-curated"` | `"share:user_library:..."` |
| Vector index 갱신 | provider auto-hook | provider auto-hook (동일) |

→ 결과 노트들이 **vault 안에서 섞여서 보이고, 사용자가 구분할 UI 가 없음**.

### 3.2 자동 큐레이션은 **기본 비활성**

[ltm_config.py:78,83](../../backend/service/config/sub_config/general/ltm_config.py#L78) — `auto_curation_enabled=False`, `auto_curation_schedule_enabled=False`.

즉 출시 시 모든 사용자가 Path B (명시 공유) 에만 의존. quality gate 없이 누적.

### 3.3 자동 큐레이션이 돌아도 `inbox/` 는 잘 안 잡힘

[backend/service/memory/curation_engine.py](../../backend/service/memory/curation_engine.py) 의 Triage 가 카테고리 화이트리스트 (`reference`, `insights`, `projects`) 위주. `inbox/` 캡처는 자동 큐레이션 대상에서 제외.

영향: 화이트보드의 핵심 입력 (Inbox 캡처) ↔ 큐레이션의 자동 처리 대상이 **거의 만나지 않음**.

### 3.4 거부 사유가 사용자에게 안 보임

[curated_knowledge_controller.py:303-307](../../backend/controller/curated_knowledge_controller.py#L303) 가 `{"success": False, "reason": ...}` 반환. frontend 의 ShareWithVTuberMenu 가 그 reason 을 toast 에 표시하지만, **어떤 dimension 이 문제였는지** 는 안 알려줌. `factual_accuracy / completeness / actionability` 같은 LLM analysis dimension 이 백엔드에서 계산되지만 사용자에게 안 도달.

### 3.5 Vector 갱신 지연 가능성

[curation_scheduler.py:136](../../backend/service/memory/curation_scheduler.py#L136) — `_run_batch` 후 `vector.reindex()` 안 부름. Path B 도 마찬가지 (provider auto-hook 의 timing 에 의존).

영향: share 직후 VTuber 가 `knowledge_search` 해도 그 노트가 안 나올 수 있음. "방금 공유했는데 못 찾네" 현상.

### 3.6 Curated 의 round-trip 없음

curated 노트 편집 → user vault 의 origin 노트로 sync 안 됨. divergence. 누구도 갱신 안 하면 stale.

---

## 4. 결론 — 어디서 막히는가

세 영역의 결함을 **단일 흐름** 으로 정렬해 보면 답이 더 분명함.

```
사용자가 캡처 → Inbox 에 저장됨           ✅ 동작
       ↓
사용자가 노트 정리                       ⚠️ 제목이 timestamp / Organizer accept noop
       ↓
사용자가 "Library 공유" 클릭             ✅ 동작 (quality gate 우회)
       ↓                                  ⚠️ 첨부 미복사 / 출처 가시성 ✗
Curated 에 노트 도착                    
       ↓                                  ❌ vector 갱신 timing 불확실
VTuber 가 knowledge_search                ❌ vtuber.md 에 도구 가이드 X
       → 능동적으로 검색 안 함            ❌ curated_knowledge_enabled default False
       ↓
사용자가 "내 노트 X 좀 찾아봐"             ❌ VTuber 가 도구 발견 못 함
       ↓
VTuber 가 활성화 안 됐다고 답함           ⚠️ (이건 default flip 으로 부분 해결됨)
```

핵심 깨달음: **인프라는 거의 다 있는데, 발견성과 실행 부재로 사용자/에이전트 모두 "이게 어떻게 쓰는 거지?" 상태에 머무름.**

다음 문서: [05_IMPROVEMENT_PLAN.md](05_IMPROVEMENT_PLAN.md) — 위 결함들을 5 작은 PR 로 묶는 실행 계획.
