# 메모리 그래프 기능 전면 개선 계획서

> 작성일: 2026-06-30 · 대상: geny-executor 메모리 서브시스템 + Geny Opsidian/그래프
> 근거: 코드 심층 분석 5종 + 외부 연구 조사 5종 + 아키텍처 3안 설계·채점 + 완전성 비평 (멀티에이전트 검토, 17 agents / ~1.4M tokens)

---

## 0. 한 줄 요약 (TL;DR)

**추천 아키텍처 = "Links-first, executor-owned, PPR-gated"**

1. **지금 그래프가 비어 있는 건 알고리즘 부재가 아니라 배선(plumbing) 버그**다. 위키링크는 executor에서 정상 추출·저장되는데, Geny 변환 계층 4곳이 링크 배열을 버리고(`links_to=[]` 하드코딩), 컨트롤러가 카운트를 노출하지 않고, 프론트 StatusBar가 user/curator 모드에서 `0`을 하드코딩한다. → **Phase 1에서 비용 $0, LLM 없이 즉시 복구 가능. 최고 ROI·최저 리스크.**
2. 그래프가 **검색에 영향**을 주려면, 시각화용 그래프가 아니라 **검색 재순위(re-rank) 신호**로 써야 한다. 정직한 결론: **벡터 검색을 대체하지 말고, 벡터/키워드 후보 위에 그래프 신호를 RRF로 융합**한다. 핵심 수학은 **Personalized PageRank(개인화 페이지랭크) / Random-Walk-with-Restart**.
3. 연구 증거는 명확하다. **그래프 검색은 멀티홉(여러 노트를 연결해야 답이 나오는) 질의에서만 +13~20pt 이득**이고, 개인 볼트를 지배하는 **단일홉/조회성 질의에서는 오히려 -13~-16% 손해**다. 그래서 **PPR 재순위는 반드시 측정 게이트(A/B·오프라인 eval) 뒤에서만** 켠다.
4. **LLM 엔티티 추출 + Leiden 커뮤니티(풀 GraphRAG)는 기본 OFF로 보류**한다. 개인 조회 위주 볼트에서 비용($15~120) 대비 효과가 증명되지 않았다 — 텔레메트리가 멀티홉 수요를 입증한 뒤에만 만든다(YAGNI, 솔로 취미 운영 원칙 준수).
5. 재사용 가능한 능력(그래프 저장소, `GraphHandle`, PPR 재순위, RWR 수학)은 **geny-executor에 일반화**해서 넣는다. Geny는 API/시각화/스케줄러 배선만 담당한다(extend-executor-not-adapter 원칙).

---

## 1. 현황 진단 — 왜 그래프가 "전혀 작동하지 않나"

### 1.1 증상
- Opsidian → Graph 탭: 노드(파일)는 보이지만 **엣지(링크)가 0**. 하단 상태바 `0 tags · 0 links`.
- 즉, 그래프 자체가 빈 화면. 검색에는 그래프가 **전혀** 관여하지 않음.

### 1.2 정확한 근본 원인 (코드 기준)

#### (A) 빈 그래프 — 배선 버그 5곳
| # | 위치 | 버그 |
|---|------|------|
| 1 | `geny-executor` `memory/provider.py` `NoteMeta` / `as_meta()` | `NoteMeta`가 `backlinks: int` **카운트만** 보유. `as_meta()`가 링크 리스트를 카운트로 접어버려 `list()`가 `links_out/links_in` **배열을 라운드트립 못 함**. → 상위로 링크 배열이 애초에 안 올라옴 |
| 2 | `Geny/backend/service/memory/global_memory.py:91-92`, `user_opsidian.py:136-137`, `curated_knowledge.py:146-147` | `_meta_to_dict()`가 `meta.links_out/links_in`을 쓰지 않고 `links_to=[]`, `linked_from=[]` **하드코딩** |
| 3 | `Geny/backend/service/memory/manager.py:1237-1238` (`SessionMemoryManager._notes_list`) | `NoteMeta → MemoryFileInfo` 변환 시 `links_to=[]`, `linked_from=[]` 하드코딩 |
| 4 | `Geny/backend/controller/user_opsidian_controller.py` `get_memory_index()` (≈146-149) | 통계 dict에 `total_links`, `total_tags` **필드 누락** (`total_files`, `total_chars`만 반환) |
| 5 | `Geny/frontend/.../StatusBar.tsx:65` | `const totalLinks = (isUserMode || isCuratorMode) ? 0 : (...)` — user/curator 모드에서 **명시적으로 0 하드코딩** |

> 핵심: **위키링크 추출·역링크 전파는 executor에서 정상 동작**(`providers/file/notes_store.py`의 `_extract_links()`, `_refresh_backlinks()`). 문제는 그 결과가 API·UI로 **전달되지 않고 버려진다**는 것.

#### (B) 시각화 그래프 자체의 빈약함 (`user_opsidian.py` `_build_graph()` ≈297-353)
- 엣지 종류가 **위키링크 + 태그쌍 2종뿐**.
- 미해결 링크 타깃(`target not in files_map`)은 조용히 드롭.
- 태그 엣지: 같은 태그를 가진 노트끼리 **모든 쌍**을 연결 → `#dms`, `#user_chat` 같은 메타태그가 **이차(quadratic) 폭발**(태그 1개 공유 노트 16개 → 120 엣지). force 레이아웃이 이를 최대 응집으로 해석 → 노드가 공처럼 뭉침. **IDF 가중·denylist·fanout 상한 없음**.
- 역링크(backlink) 엣지는 계산되지만 그래프에 노출 안 됨. 엣지 weight(1.0/0.5)는 레이아웃에서 무시됨. 노드 `summary`는 항상 빈 문자열.

#### (C) 검색에 그래프가 전혀 관여하지 않음 (가장 중요)
- `retriever.py`의 6계층 검색(L0~L6) 중 **그래프는 L5 backlink 확장에서만, 그것도 1-hop 고정·`relevance_score=0.5` 고정**으로만 쓰임. L3(벡터)·L4(키워드) 초기 검색에는 그래프가 **전혀** 안 들어감.
- in-degree 높은 허브 노트도 검색 부스트 0. 중심성/커뮤니티/근접도 점수 없음.
- `NoteGraph`에 `k_hop()`, `connected_component()`, `linked_chain()`이 **존재하지만 retriever가 한 번도 호출하지 않음**.

#### (D) **결정적 함정: 라이브 검색 경로는 composite provider** ⚠️
- 모든 설계가 그래프 로직을 `MemoryAwareRetriever._load_backlinks`에 꽂으려 하지만, **실제 라이브 경로는 `composite/provider.py:252` 의 `composite.retrieve()`** 이고 여기엔 **backlink/그래프 계층이 아예 없다**(STM/LTM/NOTES/VECTOR만 단순 char-budget 절단으로 순회).
- 즉 `MemoryAwareRetriever`에만 그래프를 배선하면 **그 코드는 영원히 실행되지 않는다(inert)**.
- → **반드시 먼저** "각 scope에서 실제로 어떤 provider 클래스가 인스턴스화되며 Stage-2가 `composite.retrieve()`를 부르는가 `MemoryAwareRetriever.retrieve()`를 부르는가"를 검증해야 한다. **이것이 단일 최대 미지수.**

### 1.3 기존 설계 vs 현실 (prior-art)
- `docs/_archive/analysis/KNOWLEDGE_GRAPH_EXTRACTION_DEEP_DIVE.md`가 7개 개선안(P0~P3: 시맨틱 엣지, 태그 IDF+denylist, 자동 트리거, LLM 중요도, 시간축, 엔티티 노드 등)을 제안했으나 **0개 구현**. 큐레이션 파이프라인(5-stage)은 완성됐지만 그래프 품질 개선은 전무. → 본 계획은 그 P0(태그 IDF·denylist)/P1(시맨틱 엣지)을 **검색까지 잇는 형태로** 되살린다.

---

## 2. 핵심 통찰 — "시각화 그래프"와 "검색용 그래프"는 다르다

사용자 요구의 본질: *"그래프 형태의 중요 정보 연결이 정보 탐색·검색에 강력하게 영향을 줘야 한다."*

→ 그래프를 **예쁜 노드맵**으로 끝내면 안 되고, **검색 점수 함수에 그래프 신호를 주입**해야 한다. 두 가지를 동시에 만족시키는 단일 그래프(엣지 저장소)를 두고:
- **시각화**: 노드/엣지 렌더 (Phase 1에서 복구)
- **검색**: 같은 그래프 위에서 **개인화 페이지랭크 재순위** (Phase 4, 게이트)

이렇게 하면 "그래프가 비어 보이는 문제"와 "그래프가 검색에 영향 못 주는 문제"를 **같은 엣지 저장소로 한 번에** 해결한다.

---

## 3. 연구 근거 (수학적·비용적·효과적 검토)

### 3.1 효과 — 정직한 평가 (가장 중요)
| 질의 유형 | 그래프 검색 효과 | 출처 |
|-----------|------------------|------|
| **멀티홉**(연결해야 답 나옴) | **+13~20pt** (HippoRAG +13.9pt Recall@5 @2Wiki; HippoRAG2 F1 MuSiQue 48.6 vs 밀집 SOTA NV-Embed 45.7) | HippoRAG 1/2 (NeurIPS'24) |
| **단일홉/조회/최신성** | **-13.4%**(NaturalQuestions), **-16.6%**(time-sensitive) — **오히려 손해** | GraphRAG-Bench |
| **전역 테마 요약**("전체에서 무슨 주제들이?") | 포괄성 72~83% 승률 (vs 벡터 RAG) | MS GraphRAG |

**결론**: 멀티홉 이득은 (a) **LLM이 추출한 엔티티 KG**와 (b) **멀티홉 질의 비중**이 있을 때만 나온다. 개인 볼트는 통계적으로 단일홉/조회가 지배적 → **무조건 켜면 손해**. 그래서 PPR은 **벡터 위에 얹고(RRF), 절대 대체하지 않으며, 실제 질의 믹스에 대한 측정 게이트** 뒤에서만 켠다.

### 3.2 비용 (개인 볼트 ≈ 1,000 노트 × ~700 tok ≈ 700K tok 기준)
| 항목 | 비용 |
|------|------|
| Phase 1 (링크/태그 IDF 엣지) | **$0**, 단일 파싱, 수 초 |
| E3 시맨틱 kNN 엣지 | **~$0** (VectorHandle 임베딩 **재사용**, kNN 브루트포스 O(N·d) 무시 가능) |
| E4 엔티티 엣지 (중요 노트 ~10%만, Haiku+Batches) | **~$0.22** (전체 볼트 추출은 $15~35 — **비권장**) |
| 풀 GraphRAG (엔티티+커뮤니티 요약) | **$20~120+** — 회피 대상 |
| 질의 시 PPR (power-iteration, <10k 노드) | **10~30ms, $0 한계비용** (LLM 미사용, IRCoT 대비 10~30배 저렴·6~13배 빠름) |
| 증분 갱신 (노트 1개 수정) | 엣지 delete-by-source 후 재유도 = ms, ~$0 (E4 켜도 ~$0.002/노트) |

비교: MS GraphRAG 색인 $20~500 vs 벡터 RAG $2~5. LazyGraphRAG는 색인 0.1%·질의 4% 비용. LightRAG는 색인 ~60%↓ + O(delta) 증분.

### 3.3 수학 — 검색 재순위의 핵심 공식

**(1) 엣지 가중치**
```
위키링크:      w = 1.0  (방향성; 역방향 = backlink)
태그:          w = 0.5 · idf(t),   idf(t) = log((1+N)/(1+df_t))
               단, t ∈ denylist 또는 df_t > 0.3·N 이면 엣지 제거 (이차 폭발 차단)
시맨틱 kNN:    w = cos(a,b),  단 cos ≥ τ (τ≈0.72), 노드당 top-k=6
엔티티(옵션):  w = 0.8
```

**(2) 전이행렬** — 행 정규화: `P(u→v) = w(u,v) / Σ_v' w(u,v')`. 무방향 엣지는 양방향 기여.

**(3) 시드(개인화 벡터)** — 후보집합 `C = 벡터(L3) ∪ 키워드(L4)` 히트.
레이어 내 min-max 정규화한 기저 점수 `b(c)`로 `s(c) = b(c) / Σ_{c∈C} b(c)`, 비후보는 0.

**(4) 검색 코어 = Personalized PageRank / Random-Walk-with-Restart**
```
r_{t+1} = α·s + (1-α)·Pᵀ·r_t,   r_0 = s
α = 재시작 확률 = 0.5   (HippoRAG 관례; PageRank의 0.15보다 무겁게 → 질의-국소성 유지, ~10~20회 수렴)
종료: max_iters=20 또는 L1 delta < 1e-4
graph_score g(c) = r_∞(c)
```
> 재시작 항(α·s)이 **수학적으로 필수**: 재시작이 없으면 질의-무관 고유벡터 중심성으로 붕괴해 **모든 질의에 같은 허브**만 반환한다.

**(5) 융합 = Reciprocal Rank Fusion (스케일 무관, 권장)**
```
score(c) = Σ_{R ∈ {vector, keyword, graph}} 1 / (K + rank_R(c)),   K = 60
```
- 새로 활성화된 비후보 노드는 `vector_rank = keyword_rank = ∞` → 그래프 순위만으로 등장 가능하되, 강한 직접 히트를 압도하지 못함.
- (선형 가중합 대신 RRF인 이유: 밀집 코사인 [-1,1] vs 무계 그래프 질량의 **스케일 불일치**가 선형 혼합을 망친다.)
- 선택적 중심성 prior는 동점 처리용으로만: `+ λ·log(1+indegree)`, 기본 λ=0, 단독 랭커 금지.

### 3.4 저장소·라이브러리
- **PPR는 numpy 거듭제곱 반복으로 자체 구현** (현재 executor는 `numpy>=1.24`만 의존; scipy/networkx/igraph 미포함). <10k 노드에서 충분. **~100k 노드 초과 시에만** igraph 검토.
- 엣지 저장: **scope별 SQLite 사이드카** 1개 (`edges`, `tag_index`, `node_meta`, `graph_meta`), provenance = `source_note_id` 키. 신규 의존성 0(파이썬 표준 sqlite3).
- 벡터: 기존 VectorHandle 재사용. 별도 벡터DB 도입 불필요.

---

## 4. 추천 아키텍처 — "Links-first, executor-owned, PPR-gated"

3개 후보안(아래 §8)을 채점한 결과, **lightweight-links-first(3.85점)**를 척추로 삼고 **HippoRAG의 PPR 수학을 게이트 형태로 접목**, **풀 typed-KG/커뮤니티는 보류**하는 합성이 최적.

### 4.1 그래프 모델
- **노드**: 노트(메모리 노트 단위). (엔티티 노드는 Phase 5 옵션.)
- **엣지 타입**: `wikilink`(1.0) · `backlink`(역방향) · `tag`(0.5·idf) · `semantic-knn`(cos) · `entity`(0.8, 옵션).
- **저장**: scope(`session/user/curated/global`)·category·backend로 **네임스페이스 분리된** SQLite 사이드카. (cross-scope 누수 방지 — `NoteRef`와 동일 축.)

### 4.2 검색 통합 (그래프가 검색에 영향 주는 방식)
1. 기존대로 벡터(L3)+키워드(L4)로 후보 `C` 생성.
2. `C`를 시드로 그래프 위에서 **PPR/RWR** 1패스 → 각 노트의 `graph_score`.
3. **RRF**로 vector/keyword/graph 순위 융합 → 최종 랭킹.
4. **새로 활성화된(직접 히트 아닌) 이웃 노트**가 그래프 점수만으로 상위에 등장 → "연결된 중요 정보"가 검색에 반영됨 (= 사용자 요구의 핵심).
5. 결과를 Stage-2 컨텍스트 주입 + Geny 검색 UI 양쪽에 동일 적용.

### 4.3 executor vs Geny 배치
| 계층 | 소속 | 내용 |
|------|------|------|
| 그래프 저장소(SQLite) + `GraphHandle` Protocol | **geny-executor** | `NotesHandle`/`VectorHandle`의 형제 핸들. `NoteGraph`를 이 위의 projection으로 재구성 |
| 엣지 유도(E1~E3) + 증분 갱신 | **geny-executor** | 노트 write/delete 시 `GraphHandle.rebuild/delete(note_id)` |
| PPR/RWR + RRF 재순위 | **geny-executor** | `MemoryHooks` 정책으로 on/off·파라미터, `RetrievalQuery.use_graph` |
| API·시각화·스케줄러·텔레메트리 | **Geny** | 컨트롤러 카운트 노출, Opsidian 그래프 렌더, 큐레이션 cadence |

### 4.4 증분 갱신
노트 add/edit/delete 시: `DELETE FROM edges WHERE source_note_id = ?` (인덱스) 후 해당 노트의 E1/E2/E3만 재유도. **전역 재빌드 없음**, O(delta), 정상상태 비용 cents/day.

---

## 5. 단계별 로드맵 (executor-first, 각 단계 독립 배포·검증)

### Phase 1 — 빈 그래프 복구 + 저렴한 엣지 (LLM 0, $0, 최고 ROI)
- **executor (스키마 1개 변경)**: `NoteMeta`에 `links_out/links_in` 추가, `as_meta()`가 카운트로 접지 않고 배열을 라운드트립하도록. (※ 순수 Geny 배선이 아님 — executor 변경 필수. 모든 `NoteMeta`/`as_meta`/`backlinks` 소비처 grep로 영향 평가 후.)
- **Geny**: `get_memory_index`가 `total_links`+`total_tags` 반환; `global_memory`/`user_opsidian`/`curated`의 `_meta_to_dict` 및 `SessionMemoryManager._notes_list`의 하드코딩 `[]`를 `meta.links_out/links_in`으로 교체; `StatusBar.tsx:65` 하드코딩 0 제거.
- **시각화**: `_build_graph`에 **태그 IDF 가중 + 메타태그 denylist + tag fanout 상한 + backlink 엣지** 추가 → 태그 클럼핑 해소.
- **결과**: 그래프 비어있지 않음, 카운트 정확. **검증**: 위키링크가 있는 볼트에서 Playwright로 엣지·카운트 확인.

### Phase 2 — executor SQLite 엣지 저장소 + `GraphHandle` + 증분 갱신 (검색 변경 없음)
- `providers/file/graph_store.py` 신설(`edges/tag_index/node_meta/graph_meta`, provenance by `source_note_id`) + `GraphHandle` Protocol.
- `NoteGraph`를 `GraphHandle` 위 projection으로 재구성 → 기존 `k_hop/connected_component`가 비로소 사용됨.
- 노트 write/delete → `GraphHandle.rebuild/delete` (delete-by-source-before-re-derive). E1+E2(IDF)만 유도.
- Opsidian 시각화는 `GraphHandle`에서 읽음. **검증**: add/edit/delete 테스트로 O(delta) 신선도.

### Phase 3 — E3 시맨틱 kNN 엣지 (기존 임베딩 재사용, ~$0)
- 노트 write 시 VectorHandle 벡터로 kNN → `semantic-knn` 엣지(τ,k는 `MemoryHooks`로 튜닝). 벡터 비활성 scope는 E1+E2로 graceful degrade.
- 연구상 **ROI/달러 최고** 단계 — 사용자가 직접 안 적은 "잠재 링크" 복구. 아직 검색 랭킹 변경 없음.

### Phase 4 — PPR/RWR 재순위 + RRF 융합 (측정 가능한 본 이득, **게이트**)
- **결정적**: `composite/provider.py:252`(검증된 라이브 경로, 그래프 계층 없음)에 그래프 계층을 추가하거나 `composite.retrieve()`가 `MemoryAwareRetriever`로 위임하게. (retriever에만 배선하면 inert.)
- `MemoryHooks`에 정책(`graph_aware`, `restart_alpha=0.5`, `max_hops`, `knn_tau`, `tag_denylist`, `rrf_k`) + `RetrievalQuery.use_graph`.
- Geny 검색 엔드포인트도 `provider.retrieve` 경유 → UI·에이전트 동시 수혜.
- **`graph_aware` 플래그 뒤 + 오프라인 eval**(볼트 대상 수기 멀티홉 질의 held-out, Recall@k on vs off)로 배포. **멀티홉에서 벡터-단독을 이기고 조회성에서 퇴행 없을 때만** 기본 ON.

### Phase 5 — (옵션, 증명 시에만) 저렴 LLM 엔티티 엣지 + (선택) Leiden 커뮤니티
- `importance ≥ high` 노트에만 Haiku-급 OpenIE(curation_scheduler cadence), 임베딩 엔티티 해소(cos≥0.85, 별칭 저장·파괴적 병합 금지), run당 상한.
- **기본 OFF, Phase 4 텔레메트리가 "링크/태그/kNN 엣지로 못 메우는 멀티홉 갭"을 보이기 전엔 빌드조차 안 함** (솔로 취미 YAGNI).

---

## 6. 검증 전략
- **오프라인 eval 하니스**: 대표 볼트에 수기 멀티홉 질의 ~20~50개 → Recall@5/F1, graph-on vs vector-only. **Phase 1에서 baseline 캡처** → Phase 4가 falsifiable 게이트를 갖게.
- **쿼리 인텐트 텔레메트리**: 기존 검색 경로에 질의 의도(lookup vs multi-hop vs compare vs themes) 로깅 → Phase 4/5 정당화 데이터. **Phase 4/5 빌드 전 선행 필수.**
- **A/B**: `graph_aware` on/off 실사용 비교. 단일홉 퇴행 감시.
- **단계별 Playwright/유닛**: Phase 1 시각화, Phase 2 증분 신선도, Phase 4 랭킹.

---

## 7. 리스크 & 반드시 먼저 검증할 것 (decisive unknowns)

**먼저 검증 (빌드 전):**
1. **각 scope 런타임 provider 클래스 + Stage-2가 `composite.retrieve()`냐 `MemoryAwareRetriever.retrieve()`냐** — Phase 4 삽입 지점 결정. **단일 최대 미지수.**
2. Phase 1 버그 4곳(+StatusBar:65) 재확인 + `NoteMeta` 확장 시 직렬화/frontmatter 라운드트립 안전성(모든 소비처 grep).
3. **numpy-only PPR vs 신규 의존성**: <10k 노드 합성 희소행렬에 numpy power-iteration 프로토타입 → 수렴 반복수·ms 측정. numpy 부족할 때만 scipy/igraph.
4. **실제 질의 믹스** 계측 — Phase 4/5의 전체 근거. 개인 볼트는 멀티홉 비중이 낮을 수 있음.
5. **VectorHandle가 user/curated/session/global scope에 채워져 있나** — E3가 조용히 degrade하는지.
6. **GraphHandle scope 네임스페이스**(NoteRef 축과 동일) — cross-tenant 엣지 누수 방지.

**리스크:**
- 라이브 경로 함정(§1.2-D). · 시각화 그래프 ↔ 검색 그래프 **이중 빌더 드리프트**(Phase 2에서 projection 통일 전까지). · **E3 kNN이 벡터 신호 이중 계상** → eval에서 kNN 기여를 raw 벡터와 분리. · 프로젝트 코드네임(Geny/GAPT/Opsidian) **엔티티 해소 실패**(cos≥0.85 오병합/미병합) — Phase 5 전 엔티티 커버리지 eval. · 라벨된 eval 셋 부재로 "측정 가능 개선"이 검증 불가 → 하니스 선행.

**미검증 가정(추정치):** PPR ~10~30ms·증분 cents/day·E3 ~$0·E4 $0.22 등은 연구 벤치 외삽치 — 실볼트 측정 필요. **휴리스틱 엣지(엔티티 KG 아님) 위 PPR이 이득을 낼지 자체가 Phase 4의 핵심 베팅.**

---

## 8. 대안 비교 (채점) & 선택 이유

| 안 | 종합 | cost | effect | simple | fit | incr | 요지 |
|----|------|------|--------|--------|-----|------|------|
| **lightweight-links-first** ✅ | **3.85** | 5 | 3 | 3 | 4 | 5 | 가장 저렴·실 seam 적합. 검색 이득 상한은 낮음 |
| hipporag-ppr | 3.45 | 5 | 3 | 2 | 4 | 4 | PPR이 가장 증거 강한 아이디어지만 엔티티 KG 전제 시 복잡 |
| graphrag-typed-communities | (최저) | 1~2 | — | — | — | — | 가장 풍부하나 개인 조회 볼트엔 비용 과다 |

**선택**: links-first를 척추로(최저 비용·최저 후회, Phase 1이 빈 그래프까지 고침) + HippoRAG **PPR 수학을 게이트로 접목**(family에서 가장 증거 강한 검색 아이디어) + typed-communities의 **정직한 tiering·provenance 규율만 차용**하고 본체는 보류.

---

## 9. 다음 액션 (이 계획 승인 후)
1. §7의 decisive unknowns 1~3 선검증(특히 라이브 provider 경로 + numpy PPR 프로토타입).
2. **Phase 1 구현** (빈 그래프 복구) → 2222 배포 → Playwright 검증. ← 즉시 착수 가능한 최고 ROI.
3. eval 하니스 + 쿼리 인텐트 텔레메트리 스캐폴딩(Phase 4 게이트 준비).
4. Phase 2~3 substrate, Phase 4는 측정 게이트 통과 시에만 ON.

> 부속 자료: 멀티에이전트 검토 원본(현황 분석 5 / 연구 5 / 설계·채점 / 비평)은 워크플로 결과에 보존. 필요 시 `02_RESEARCH_NOTES.md`로 정리 가능.
