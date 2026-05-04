# Knowledge Graph 추출 로직 — 현 상태 심층 분석 + 고도화 계획

> 작성: 2026-05-04 · 범위: Geny Opsidian (User Opsidian + Curated Knowledge + Conversation/DM/Compaction archives) — **노드/엣지가 어떻게 만들어지는가** 관점
> 자매 문서: [docs/analysis/obsidian_network_report.md](./obsidian_network_report.md) — **그래프 시각화** 관점 (이미 후속 작업으로 `UnifiedGraphView` + d3-force 통합 완료)
>
> 이 문서는 시각화가 아닌 **추출 (extraction) 파이프라인** 자체를 다룬다. 노드 metadata · importance · tag · 링크 · semantic edge — 어떤 정보가 어디서 결정되어 그래프에 들어가는가.

---

## 0. 한 줄 진단

Geny의 knowledge graph는 **rule-based 추출 + LLM 큐레이션 (옵셔널) + 키워드/벡터 이중 검색**의 3 layer 구조다. 시각화 layer는 이미 통합·고품질이지만, **노드 사이를 잇는 엣지가 wikilink + tag 동시 출현 두 종류뿐**이라 그래프가 가진 "지식 사이 관계 구조" 정보가 빈약하다. 큐레이션 엔진은 잘 짜여 있으나 **어떤 노트를 큐레이션할지 트리거하는 로직이 외부에 의존**하고, 큐레이션 산출물의 link suggestion이 **wikilink로 자동 주입되지 않는다** — 즉 LLM이 "이 노트는 X와 연결된다"라 판단해도 그래프 엣지로 영구화되지 않는다.

---

## 1. 시스템 지형 (3-layer)

| Layer | 역할 | 코드 진입점 | 노드 생성 주체 |
|---|---|---|---|
| **Archive** | 세션 대화/DM/컴팩션을 자동으로 markdown으로 변환 | [conversation_archiver.py](../../backend/service/memory/conversation_archiver.py), [dm_archiver.py](../../backend/service/memory/dm_archiver.py), [compaction_archiver.py](../../backend/service/memory/compaction_archiver.py) | 시스템 자동 — 매 turn / 매 DM / 매 compaction |
| **User Opsidian** | 사용자 개인 vault — 사용자가 직접 작성하거나 archive로 떨어진 노트 | [user_opsidian.py](../../backend/service/memory/user_opsidian.py), [structured_writer.py](../../backend/service/memory/structured_writer.py) | 사용자 + agent (knowledge_tools 통해) |
| **Curated Knowledge** | 품질 통과한 지식만 모인 vault — agent가 retrieval 시 우선 참조 | [curated_knowledge.py](../../backend/service/memory/curated_knowledge.py), [curation_engine.py](../../backend/service/memory/curation_engine.py) | LLM 큐레이션 산출물 |

세 layer 모두 **같은 파일 포맷** (markdown + YAML frontmatter)을 공유하고 같은 `StructuredMemoryWriter` + `MemoryIndexManager`를 reuse한다. 즉 "User Opsidian → Curated Knowledge"는 노트의 location + 품질 보증 layer만 다르고 데이터 모델은 동일. 그래프 시각화도 두 vault에 대해 같은 `get_graph()` 모양을 노출.

---

## 2. 노드는 어떻게 만들어지는가

### 2.1 frontmatter 스키마 (실제 디스크 형태)

[frontmatter.py:143-177 `build_default_metadata()`](../../backend/service/memory/frontmatter.py#L143-L177)가 모든 노트의 출발점:

```yaml
title: ...
category: conversations | dms | daily | topics | projects | insights | reference | root | ...
tags: [...]
importance: low | medium | high | critical
source: user | system | auto-curated | session:<sid> | ...
created: 2026-05-04T03:46:02+09:00
modified: 2026-05-04T03:46:02+09:00
links_to: [...]      # 본문 [[wikilink]] 추출 + explicit links 인자
linked_from: [...]   # 다른 노트가 self를 링크하면 자동 채워짐
```

archive 계열은 위에 더해 **interaction-event 차원**의 키들을 얹는다 — `session_id`, `event_ids`, `kinds`, `counterparts`, `date_first/date_last`, `turn_count`, `importance_max` ([conversation_archiver.py:18-39](../../backend/service/memory/conversation_archiver.py#L18-L39)).

### 2.2 importance 결정 — 100% 규칙

[conversation_archiver.py:227-267 `compute_importance()`](../../backend/service/memory/conversation_archiver.py#L227-L267):

```python
if kind == SYSTEM_NOTE and has_errors: return "critical"
if kind == TASK_RESULT and len(files_written) >= 1: return "high"
if content_chars > 5000: return "high"
if has_errors: return "high"
if kind in (REFLECTION, internal_trigger): return "low"
if content_chars < 50: return "low"
return "medium"
```

- LLM 호출 0건. payload metadata 5개 ((files_written, errors, kind, content_chars, …)만 본다.
- 의미론적 평가 없음. "사용자가 5개월 후 다시 찾아볼 노트인가?" 같은 판단은 못 함.
- `medium`이 default라 대부분의 평범한 turn이 `medium` — 그래프 노드 크기가 평탄해지고 시각적 정보량 감소.

### 2.3 tag 결정 — kind/role/category에서 derive

[conversation_archiver.py `build_tags()`](../../backend/service/memory/conversation_archiver.py)가 `kind`, `counterpart_role`로부터 정형 태그(`#user_chat`, `#dms`, `#paired_subworker` 등)를 만든다. 사용자 작성 노트는 `tags` 인자로 직접 전달.

→ **자동 태그 생성은 메타데이터 derived만 가능**. 본문 내용에서 "이 노트는 *Python async* / *FastAPI* / *prompt engineering* 토픽이다"라는 의미 태그는 추출하지 않음. 큐레이션 엔진의 `_ENRICH_PROMPT`만 LLM으로 `auto_tags` 제안하지만 (Curated에만 적용).

### 2.4 노드 metadata가 graph로 갈 때

[user_opsidian.py:194-204](../../backend/service/memory/user_opsidian.py#L194-L204):

```python
nodes.append({
    "id": fn,
    "label": info.get("title", fn),
    "category": info.get("category", "root"),
    "importance": info.get("importance", "medium"),
    "tags": tags,
    "connectionCount": len(links_to) + len(linked_from),
    "summary": info.get("summary", ""),
    "charCount": info.get("char_count", 0),
})
```

frontend는 `category` → 색상 ([graphConstants.ts:11-18](../../frontend/src/components/knowledge-graph/graphConstants.ts#L11-L18)), `importance` + `connectionCount` → 크기 ([graphConstants.ts:42-45](../../frontend/src/components/knowledge-graph/graphConstants.ts#L42-L45))로 매핑. 노드 metadata가 풍부해질수록 시각화는 자동 향상되지만 — 현재는 위 8개 필드만 사용.

---

## 3. 엣지는 어떻게 만들어지는가

[user_opsidian.py:179-240 `get_graph()`](../../backend/service/memory/user_opsidian.py#L179-L240) — 핵심 로직:

```python
# 1. wikilink 엣지 (weight=1.0)
for target in links_to:
    if target in files_map:
        edges.append({"source": fn, "target": target, "type": "wikilink", "weight": 1.0})

# 2. tag co-occurrence 엣지 (weight=0.5, label=tag)
for tag, fns in tag_to_files.items():
    if len(fns) < 2: continue
    for i, j in pairwise:
        edges.append({"source": fns[i], "target": fns[j], "type": "tag", "weight": 0.5, "label": tag})
```

**오직 두 종류의 엣지만 존재**:

| 타입 | 출처 | weight | 가시성 (frontend) |
|---|---|---|---|
| `wikilink` | 본문 `[[target]]` regex 추출 + `linked_from` 역전파 | 1.0 | 파란 실선 2px |
| `tag` | 두 노트가 같은 태그를 들고 있으면 자동 페어 | 0.5 | 주황 점선 1px |
| ~~`backlink`~~ | frontend `EDGE_STYLES`엔 정의돼 있지만 **백엔드가 emit하지 않음** | — | 회색 1.5px (사용 안 됨) |

### 3.1 wikilink 추출 + 백링크 전파

[frontmatter.py:22-24 `_WIKILINK_RE`](../../backend/service/memory/frontmatter.py#L22-L24): `\[\[([^\]\|]+)(?:\|([^\]]+))?\]\]`. 본문에서 추출한 wikilink 리스트는 [structured_writer.py:179-182](../../backend/service/memory/structured_writer.py#L179-L182)에서 explicit `links` 인자와 union되어 frontmatter `links_to`에 저장.

[structured_writer.py:211-222 `_propagate_linked_from`](../../backend/service/memory/structured_writer.py#L211-L222) — 새 노트가 A/B/C를 링크하면 A/B/C의 `linked_from`을 best-effort로 업데이트. 실패해도 write는 막지 않는 graceful 처리.

### 3.2 tag co-occurrence 엣지의 함정

같은 태그를 가진 모든 노트 쌍을 엣지로 emit한다. 노트 N개가 같은 `#dms` 태그를 들면 `N*(N-1)/2`개 엣지가 생성됨. 첨부 스크린샷의 `#dms`, `#paired_subworker` 같은 메타 태그는 거의 모든 dm 노트가 공유하므로 **DM이 늘수록 quadratic 폭발**. frontend의 force layout은 이걸 "강한 응집력"으로 해석해서 노드들이 한 덩어리로 뭉치게 만든다.

→ tag 엣지는 "주제 응집"이 아니라 "구조 응집"을 그리고 있는 셈. 의미 있는 클러스터링이 안 된다.

---

## 4. 추출 파이프라인 — 어디서 무엇이 노트가 되는가

```
세션 대화 (turn)
   │
   ├─→ ConversationArchiver.archive_turn()       # one file per (session × counterpart-bucket)
   │     └─ compute_importance() (rule)
   │     └─ build_tags() (rule)
   │     └─ links_to: 본문 wikilink + dm_archiver target  ← 실제 link 추가는 거의 없음
   │
   ├─→ DmArchiver.archive_dm()                    # per (counterpart × day)
   │     └─ wikilink: conversations/<sid>__dm__<cp>#turn-<eid8>  ← 자동 wikilink emit ✓
   │
   └─→ CompactionArchiver.archive()               # 세션 종료/임계 도달 시
         └─ memory + history dual write

User Opsidian (사용자 직접 작성)
   └─→ UserOpsidianManager.write_note()
         └─ structured_writer.write_note()
              └─ extract_wikilinks() (regex)
              └─ propagate linked_from (best-effort)

Curated Knowledge (LLM 5-stage curation)
   └─→ CurationEngine.curate_note()
         ├─ Stage 1 Triage (rule): exclude / auto_curate / candidate
         ├─ Stage 2 Analyze (LLM): quality_score + curation_strategy + suggested_tags + merge_candidates
         ├─ Stage 3 Transform (LLM): direct | summary | extract | merge | restructure
         ├─ Stage 4 Enrich (LLM): auto_tags + suggested_links + importance_assessment
         └─ Stage 5 Store: CuratedKnowledgeManager.write_note(links_to=enrichment.suggested_links)
```

### 4.1 Curation Engine은 잘 짜였지만 …

[curation_engine.py:260-420](../../backend/service/memory/curation_engine.py#L260-L420)는 **5-stage LLM 파이프라인이 완비**된 상태:

- Stage 1 Triage — `IMPORTANCE_THRESHOLD={high, critical}`, `AUTO_CURATE_TAGS={...}`, `EXCLUDE_TAGS={draft, temp, ...}`, `MIN_BODY_LENGTH=200` 등 [L52-65](../../backend/service/memory/curation_engine.py#L52-L65). 사람 손 안 거치고도 cheap path가 80%+ 처리.
- Stage 2 Analyze — `_CURATION_ANALYSIS_PROMPT`가 `quality_dimensions` (factual_accuracy / completeness / actionability / uniqueness / clarity)를 0~1 점수로 받아옴. `curation_strategy`도 LLM이 결정 (`direct/summary/extract/merge/restructure`).
- Stage 3 Transform — 각 strategy별 prompt 템플릿. `merge`는 `merge_candidates`를 따라 다른 큐레이션된 노트를 묶어 합침.
- Stage 4 Enrich — `auto_tags`, `suggested_links`, `importance_assessment` LLM 제안.
- Stage 5 Store — `links_to=enrichment["suggested_links"]`로 그대로 write.

**하지만 이 엔진의 효과가 그래프에 반영되지 않는 이유**:

1. **트리거가 외부 의존** — `CurationScheduler`/`CurateNoteRequest` 호출자가 명시적으로 호출해야 함. 자동 트리거 (e.g. 세션 종료 후 high importance 모든 노트 자동 큐레이션)이 default가 아닐 가능성.
2. **`suggested_links` 검증 부재** — LLM이 상상으로 `["topics/python-async.md"]` 같은 파일명을 만들어도 `write_note(links_to=...)`가 그대로 받음. wikilink가 본문에 들어가지 않으므로 `extract_wikilinks()`도 못 잡고, 결과적으로 `links_to`엔 들어가지만 **참조 파일이 실제 존재하는지 검증되지 않은** entry. [structured_writer.py:179-182](../../backend/service/memory/structured_writer.py#L179-L182)는 `auto_links + (links or [])`를 union하지만 `links`가 디스크 파일과 매칭되는지 verify 안 함.
3. **Curated 결과의 `linked_from` 역전파만 작동** — 큐레이션이 만든 노트가 X를 링크하면 X의 `linked_from`은 갱신됨. 하지만 X 자체에 자동 wikilink가 본문에 삽입되지 않으므로, 사용자가 X를 열어도 "이 노트는 Y에 의해 참조됨"이 본문에 안 보임 (frontmatter에만 있음).

### 4.2 importance 미스매치

세 layer가 importance를 결정하는 로직이 다르다:

- **Archive**: rule-based (`compute_importance` — files_written / errors / chars).
- **User Opsidian write_note()**: caller가 명시 (default `"medium"`).
- **Curation Stage 4**: LLM이 `importance_assessment` 추천.

→ 같은 정보 조각이 archive에서 `medium`으로 시작했다가 curation을 거치면 `high`로 승격될 수 있음 OK. 하지만 **archive 단계의 `medium` 평탄화**가 너무 심해서, 큐레이션이 들어가기 전 단계의 그래프는 사실상 importance 신호가 거의 없는 상태로 시각화됨.

---

## 5. 검색 — 현재 그래프에 어떻게 영향?

| Vault | 검색 방식 | 코드 |
|---|---|---|
| **User Opsidian** | 키워드만 (title +2, body +1, tag +0.5) | [user_opsidian.py:109-139](../../backend/service/memory/user_opsidian.py#L109-L139) |
| **Curated Knowledge** | 키워드 + 옵셔널 FAISS 벡터 | [curated_knowledge.py:103-128 `initialize_vector()`](../../backend/service/memory/curated_knowledge.py#L103-L128), [vector_memory.py:282 `search()`](../../backend/service/memory/vector_memory.py#L282) |
| **Session Memory** | 두 vault 모두 | [vector_memory.py](../../backend/service/memory/vector_memory.py) |

→ **벡터 검색은 retrieval (질의) 시점에만 활용되고, 그래프 엣지 생성에는 전혀 사용되지 않는다.** "noteA와 noteB의 cosine similarity > 0.85" 같은 정보가 있어도 graph edge로 emit하지 않음. FAISS 인덱스가 이미 만들어진 vault에서도 그래프는 wikilink + tag 두 종류 엣지만 그린다.

---

## 6. 정리 — 강점과 한계

### 강점 (이미 잘 돼있는 것)

| 영역 | 상태 |
|---|---|
| 시각화 (UnifiedGraphView, d3-force, N-hop highlight) | ✅ 이미 통합 — `obsidian_network_report.md` 후속 작업 |
| LLM 큐레이션 5-stage 파이프라인 | ✅ 코드 완비 |
| FAISS 벡터 검색 (curated만) | ✅ optional, 트리거 시 enable |
| frontmatter + wikilink + linked_from 역전파 | ✅ 작동 |
| 카테고리/중요도 노드 차별화 (frontend) | ✅ 색·크기 매핑 |

### 한계 (그래프 추출 관점)

1. **엣지가 두 종류뿐** — wikilink (1.0) + tag co-occurrence (0.5). semantic edge 없음.
2. **importance가 metadata-only rule** — 의미론적 중요도 평가 안 함. medium 평탄화로 노드 크기 정보량 감소.
3. **자동 태그 추출 미흡** — kind/role 같은 메타데이터 태그만 자동. 본문 토픽 태그는 큐레이션 거쳐야만 LLM이 제안.
4. **Curation의 `suggested_links` validate 안 됨** — LLM hallucination이 `links_to`에 그대로 들어갈 수 있음.
5. **Curation 트리거가 명시적** — 자동 promotion 정책 없거나 약함. 결과적으로 user vault에 archive 노트가 쌓이는데 큐레이션은 거의 안 일어남 → 그래프가 archive raw로만 채워짐.
6. **벡터 인덱스가 그래프와 단절** — semantic similarity가 검색에만 쓰이고 엣지로 영구화되지 않음.
7. **tag 엣지의 quadratic 폭발** — `#dms` 같은 메타 태그 한두 개가 거의 모든 노트를 잇는 noise edge로 작용.
8. **백링크 본문 표시 부재** — `linked_from`이 frontmatter에만 있고 노트 본문 하단에 자동 렌더되지 않음 (사용자가 자기 노트를 열었을 때 "이 노트를 참조하는 노트들"이 안 보임).
9. **temporal 정보 미반영** — `created/modified` timestamp가 노드 metadata에 있지만 그래프 시각화에 사용 안 됨 (시간 감쇠 / 최근 활동 강조 / 시계열 클러스터링 모두 부재).
10. **entity-level 노드 부재** — 노트는 "한 turn / 한 dm bundle / 한 큐레이션 결과" 단위. "사람 X" / "프로젝트 Y" / "기술 Z" 같은 엔티티가 별도 노드로 존재하지 않음. 모든 의미가 본문 텍스트 안에만 잠겨 있다.

---

## 7. 고도화 방향 — 7개 핵심 제안

각 제안은 (a) 현재 한계 어디를 푸는지, (b) 구현 난도, (c) 그래프에 미치는 시각적 효과, (d) 위험을 함께 적었다.

### 제안 1 — Semantic edge: 벡터 임베딩 기반 자동 연결

**해결**: 한계 §6.6, 부분적 §6.1.

현재 vault에 들어있는 모든 노트의 임베딩이 FAISS에 인덱싱된 상태에서, **노드 쌍의 cosine similarity > 임계값**을 graph edge로 emit. 새 엣지 타입 `semantic` 추가, weight = similarity score (0.5~1.0 범위로 normalize).

```python
# user_opsidian.py / curated_knowledge.py: get_graph() 확장
if self._vector and self._vector.enabled:
    pairs = self._vector.top_k_similar_pairs(threshold=0.75, max_per_node=3)
    for a, b, score in pairs:
        if (a, b) not in edge_set and (b, a) not in edge_set:
            edges.append({"source": a, "target": b, "type": "semantic", "weight": score})
```

- **난도**: 중. `vector_memory`에 pair-mining helper 추가 필요. FAISS는 이미 있으니 인덱스 자체는 재활용.
- **효과**: 같은 토픽을 다루는 노트가 wikilink 없이도 연결됨. force layout이 의미 클러스터를 형성.
- **위험**: 임계값 너무 낮으면 edge 폭발. `max_per_node=3` 같은 cap이 필수. graph의 안정성을 위해 `score >= 0.75` 권장.

### 제안 2 — LLM 기반 importance 재평가 (Archive 후처리)

**해결**: 한계 §6.2.

세션 종료 시 archive 노트들에 대해 LLM이 "이 turn은 5개월 후에도 가치 있는가?"를 0~1로 평가. `importance` 재계산 → frontmatter 업데이트.

```python
# 새 service: service/memory/importance_revaluator.py
async def revaluate_session_importance(sid: str, llm: MemoryLLM) -> int:
    files = list_archive_for_session(sid)
    for f in files:
        score = await llm.complete(_IMPORTANCE_PROMPT.format(body=...), purpose="memory.importance.eval")
        update_note(f, importance=quantize(score))
```

- **난도**: 낮~중. curation_engine의 `_CURATION_ANALYSIS_PROMPT`를 mini 버전으로 재사용 가능.
- **효과**: 노드 크기 분포가 의미를 가짐. 그래프에서 중요한 노트가 시각적으로 드러남.
- **위험**: LLM cost. 세션당 N turn × prompt 호출. Stage 1처럼 rule-based pre-filter (e.g. char count + has_files_written 같은 cheap signal로 candidate만 추리고 LLM은 candidate에만)로 cost 통제 필수.

### 제안 3 — `suggested_links` validate + 본문 wikilink 자동 삽입

**해결**: 한계 §6.4 + §6.8.

Curation Stage 5 직전에 `enrichment.suggested_links`를 vault index와 매칭해 valid 파일만 통과. 그리고 valid link들을 **본문 끝에 `## 관련 노트` 섹션으로 자동 삽입** → `extract_wikilinks()`가 잡고, frontmatter `links_to`도 자연 채워짐.

```python
# curation_engine.py Stage 5 직전
valid_links = [
    fn for fn in (enrichment or {}).get("suggested_links", [])
    if fn in self._curated.get_index()["files"]
]
if valid_links:
    transformed_content += "\n\n## 관련 노트\n" + "\n".join(
        f"- [[{fn}]]" for fn in valid_links
    )
```

- **난도**: 매우 낮.
- **효과**: 큐레이션이 만든 의미적 연결이 디스크에 영구화 → 그래프 wikilink edge로 자동 표시.
- **위험**: 본문 형식 변경. 큐레이션 결과 길이 살짝 증가. 큐레이션을 사람이 미리 검토하는 워크플로우라면 거의 영향 없음.

### 제안 4 — Curation auto-trigger policy

**해결**: 한계 §6.5.

자동 큐레이션 트리거를 추가. 후보 정책:
- 세션 종료 시 archive에서 `importance ∈ {high, critical}` 노트 자동 큐레이션.
- 사용자 vault에 새 노트 작성 후 N분 idle (디바운스) → background 큐레이션.
- 일일 cron — 어제 작성된 user 노트 중 `body_chars > 200 && importance != low` 자동 큐레이션.

`CurationScheduler` ([curation_scheduler.py](../../backend/service/memory/curation_scheduler.py))에 정책 enum 추가.

- **난도**: 중. 정책 기반 트리거 + 중복 큐레이션 방지 (idempotency key)가 핵심.
- **효과**: User vault에 쌓이는 raw 노트가 자동으로 Curated으로 promote되며, graph가 풍부해짐.
- **위험**: LLM cost 폭발 가능성. rate limit + daily budget cap 필수.

### 제안 5 — Tag 엣지의 IDF 가중 + 메타 태그 deny-list

**해결**: 한계 §6.7.

Tag co-occurrence 엣지의 weight를 **inverse-document-frequency**로 조정. `#dms`처럼 거의 모든 노트가 공유하는 메타 태그는 weight를 거의 0으로 떨어뜨려 시각적 noise를 제거.

```python
# get_graph() 안
N = len(files_map)
for tag, fns in tag_to_files.items():
    if len(fns) < 2: continue
    if len(fns) > N * 0.5: continue   # 절반 넘게 공유하면 메타 태그로 간주, skip
    idf_weight = math.log(N / len(fns)) / math.log(N)   # 0..1
    for i, j in pairwise:
        edges.append({..., "weight": 0.5 * idf_weight, "label": tag})
```

또는 `META_TAG_DENYLIST = {"dms", "user_chat", "assistant_chat", "conversation", ...}`를 [user_opsidian.py:179](../../backend/service/memory/user_opsidian.py#L179)에 두고 명시 제외.

- **난도**: 매우 낮.
- **효과**: 의미 있는 토픽 태그 (`#fastapi`, `#prompt-eng`)가 살아남고 메타 태그가 사라져 graph 응집이 토픽 단위가 됨.
- **위험**: 임계값/denylist tuning. `0.5*N` 임계는 vault 크기에 따라 조정 필요.

### 제안 6 — Entity 노드 (저단계)

**해결**: 한계 §6.10.

LLM 큐레이션 Stage 4에서 노트로부터 **named entity** (사람/프로젝트/기술)를 추출해 별도 entity node로 vault에 만든다. 새 카테고리 `entities/<entity-name>.md`. 노트는 entity 노드와 wikilink로 연결.

큐레이션 Stage 4 prompt 확장:
```yaml
{
  "auto_tags": [...],
  "suggested_links": [...],
  "extracted_entities": [
    {"name": "FastAPI", "kind": "tech"},
    {"name": "프로젝트 알파", "kind": "project"}
  ],
  ...
}
```

- **난도**: 중상. entity 정규화 (alias 처리: "fastapi" vs "FastAPI" vs "FAST API") 필요. entity vault 폴더 추가.
- **효과**: graph에 새 차원이 생김. 같은 기술/프로젝트를 다루는 노트가 entity 노드를 hub로 모임. obsidian의 진짜 그래프 view에 가까운 모양.
- **위험**: entity 폭발 + 이름 정규화 실패 시 중복. 처음엔 conservative threshold로 시작 (LLM이 "high confidence"라 한 것만).

### 제안 7 — Temporal edge / 시간 차원 시각화

**해결**: 한계 §6.9.

이미 모든 노트가 들고 있는 `created/modified`를 활용:
- **시간 감쇠 노드 opacity**: 30일 이상 modified 안 된 노트는 frontend opacity 0.4. UI에 timeline slider 추가.
- **temporal edge** (옵션): 같은 날 작성된 archive 노트끼리 약한 엣지 (weight=0.2, type="temporal"). 단 graph 응집을 너무 많이 흐리니 default off, 사용자 토글로.

- **난도**: 낮.
- **효과**: "지금 활발한 영역"이 시각적으로 드러남. 오래된 지식은 배경으로 물러남.
- **위험**: 사용자에게 "노트가 사라진 것처럼" 보일 수 있음 → opacity 최소값 0.3 보장.

---

## 8. 우선순위 — 어떻게 진행할 것인가

| Priority | 제안 | 이유 |
|---|---|---|
| **P0** | §3 `suggested_links` validate + 본문 wikilink 자동 삽입 | 매우 낮은 난도, 즉시 graph 풍부화. curation_engine 4줄 변경. |
| **P0** | §5 Tag IDF 가중 + 메타 태그 denylist | 낮은 난도, 현재 graph noise 제거. `#dms` 같은 의미 없는 응집 사라짐. |
| **P1** | §1 Semantic edge (vector similarity) | 인프라(FAISS) 이미 있음. graph에 새 차원 추가. |
| **P1** | §4 Curation auto-trigger policy | 큐레이션 엔진은 잘 짜였는데 안 굴러가는 게 본질 문제. |
| **P2** | §2 LLM importance 재평가 | cost 통제가 핵심. P1들이 효과 충분하면 후순위. |
| **P2** | §7 Temporal 시각화 | 시각적 효과 있지만 의미 정보는 적음. |
| **P3** | §6 Entity 노드 | 큰 변경. entity 정규화 인프라 필요. P0~P2 후 vault가 충분히 차서 수요가 명확해진 뒤 검토. |

### 권장 첫 사이클 (단일 PR)

**P0 두 개 묶어 PR-1**:
1. `curation_engine.py` Stage 5 직전에 `suggested_links` validate + 본문 끝에 `## 관련 노트` 자동 섹션.
2. `user_opsidian.py` / `curated_knowledge.py` `get_graph()`에 IDF weight + meta tag denylist.

총 코드 변경 ~80줄, 테스트 추가 ~50줄. 즉시 graph 품질이 개선되고 후속 단계의 근거 데이터(연결 밀도, 응집 패턴)를 확보.

### 권장 두 번째 사이클

**P1 PR-2**: vector pair-mining + semantic edge type. 새 edge type을 frontend `EDGE_STYLES`에도 추가 (`backlink`처럼 정의는 있는데 미사용 상태인 슬롯 활용 가능 — 단 의미가 다르니 `semantic` 타입 신설이 깔끔).

**P1 PR-3**: curation auto-trigger. 세션 종료 hook + daily cron + idempotency key.

---

## 9. 검증 / 측정 지표

각 제안 머지 후 이 수치로 효과를 본다:

- **edge density**: `len(edges) / len(nodes)` — semantic edge 도입 후 1.5~2배 증가 예상
- **edge type 분포**: wikilink / tag / semantic 비율. tag IDF 적용 후 tag 엣지 수 ~50% 감소 예상
- **node connection variance**: 가장 많이 연결된 노드 vs 평균. semantic edge 도입 후 hub 노드 명확.
- **importance 분포**: medium 비율. LLM 재평가 후 medium → high/low 재분류로 medium 비율 70% → 40% 정도 떨어지는 게 건강한 신호.
- **curation throughput**: 일/주당 자동 큐레이션 건수. auto-trigger 도입 후 0 → N건/일.
- **suggested_links validation rate**: LLM 제안 중 실제 vault 파일과 매칭된 비율. 70% 미만이면 prompt 개선 신호.

---

## 10. 결론

**현 상태**는 시각화는 통합·고품질이지만 추출 자체는 단순 — wikilink + tag 두 신호로만 graph가 만들어진다. **큐레이션 엔진은 이미 LLM 5-stage로 잘 짜였으나** 그 산출물이 그래프에 충분히 도달하지 않고 (suggested_links validate 부재), 트리거가 명시적이라 사용 빈도가 낮다.

**가장 빠른 가치**는 P0 두 개 (suggested_links 본문 삽입 + tag IDF weight) — 코드 변경 적고 graph 품질이 즉시 개선된다. **가장 큰 의미적 변화**는 P1의 semantic edge — FAISS 인프라가 이미 있어서 추가 비용 없이 새로운 엣지 차원이 그래프에 들어온다.

세 단계 (P0 → P1 → P2/3)로 점진 진행하면, 각 단계마다 기존 vault data로 효과를 측정·검증하면서 다음 단계 prompt/threshold를 tune할 수 있다.
