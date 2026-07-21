# Synapse — 학습형 경량 그래프 메모리 엔진 계획서

> 2026-07-19 · 검토용 초안 v1
> 목표: 기존 메모리(composite/file+API임베딩)를 **그대로 둔 채**, config에서 선택 가능한
> **추가 엔진** `synapse`를 만든다. 시맨틱(임베딩) + 키워드 검색을 모두 달성하면서
> API 0콜·CPU 수 ms로 동작하고, **사용 이력으로부터 온라인 학습**한다.

---

## 0. 현재 상태 진단 (조사 근거)

| 무거움/비용 지점 | 현재 | 근거 |
|---|---|---|
| 임베딩 API | 노트 **쓰기마다 1콜** + 질의마다 1콜(LRU는 동일 질의만) | `file/notes_store.py:176`, `vector_store.py:162` |
| 벡터 인덱스 | 쓰기마다 `index.bin` 전체 재작성, 검색은 O(N) 파이썬 코사인 | `file/vector_store.py:370-400` |
| LLM 증류 | rollup+fact+evergreen이 세션 종료·주기마다 LLM 콜, 리플렉션·자동 큐레이션 별도 | `manager.py:380-471,2635` |
| 학습 | **전무** — 레이어 예산·부스트·PPR α 전부 하드코딩 상수 | `provider.py:1195-1205` |
| 키워드 검색 | 태그 겹침 + 단순 문자열 매치 (BM25 없음, 한국어 토큰화 없음) | `retriever.py:611-670` |
| 장애 결합 | 임베딩 키 죽으면 세션 내내 벡터층 무음 차단(auth breaker) | `file/vector_store.py:297` |

이미 있는 자산 (재사용):
- **타입드 그래프 에지** (wikilink 1.0 / IDF-가중 태그 / 렉시컬 TF-IDF kNN) — 토큰 비용 0: `file/graph_edges.py:121-206`
- **Personalized PageRank** (의존성 0, HippoRAG α=0.5): `memory/graph_rank.py:29`
- **provider 플러그인 seam**: `factory.register(name, builder)` (`factory.py:142`) + manifest `memory.provider`
- **Geny 설정 seam**: `LTMConfig` SELECT 필드 자동 렌더 + `provider_bridge.py:194,231`의 하드코딩된 `"file"/"composite"` 분기점
- **공짜 학습 데이터**: vault에 저장된 기존 노트의 **API 임베딩 벡터**(이미 지불) → 로컬 임베딩 증류의 teacher 라벨

---

## 1. 설계 원칙

1. **검색 엔진 교체, 저장 포맷 유지.** STM/LTM/Notes는 기존 file 스토어(markdown+frontmatter)를 그대로 사용한다. synapse는 그 위의 **색인·검색·학습 레이어**만 교체한다. → 같은 vault를 두 엔진이 읽으므로 **전환·롤백이 무손실**이고, 기존 도구(memory_write 등)·아카이버·팩트 원장이 전부 그대로 동작한다.
2. **API 0콜 기본.** 임베딩은 로컬 정적 모델(아래 §4), 키워드는 BM25, 그래프는 기존 에지 + 학습 에지. 외부 서비스(qdrant 등) 불요 — vault 안 **SQLite 단일 파일**.
3. **학습은 가볍고 항상 안전.** 파라미터 총량 < 1k(랭커) + 32MB(임베딩 테이블, fp16). 온라인 갱신은 이벤트당 마이크로초. 콜드스타트 가중치는 현 휴리스틱과 동등하게 초기화 → **학습 전에도 성능 하한 보장**.
4. **유휴 비용 0.** 학습·유지보수는 이벤트 구동(쓰기/검색/피드백 시) + 세션 종료 시 1회 배치. 상시 루프 없음.

---

## 2. 아키텍처 개요

```
                    ┌────────────────────── synapse (신규) ──────────────────────┐
쓰기(memory_write)  │  ① 색인기: BM25 postings + 로컬 임베딩 + 에지 파생(기존)     │
  └─ file notes ────┤     → SQLite (nodes/postings/vectors/edges/params/feedback)│
                    │                                                            │
질의(retrieve/search)                                                            │
  └─ ② 시드: BM25 top-k ∪ cosine top-k  (RRF 융합)                              │
     ③ 확장: 에지타입별 PPR (wikilink/tag/lexical/coaccess) — 4개 그래프 특징    │
     ④ 랭킹: 특징 14차원 → 2층 MLP → top-M (+ 예산 클리핑)                       │
                    │                                                            │
피드백(온라인 학습)  │  ⑤ 회수 로그 → 사용/무시 라벨 → 랭커 SGD + Hebbian 에지     │
                    │  ⑥ (유휴 배치) 임베딩 테이블 증류: teacher=저장된 API 벡터   │
                    └────────────────────────────────────────────────────────────┘
```

---

## 3. 데이터 모델 (vault 내 `synapse.db`, SQLite/WAL)

```sql
nodes(id TEXT PK, kind TEXT, path TEXT, title TEXT, updated_at REAL,
      access_count INT, last_access REAL, pinned INT, importance REAL)
postings(term TEXT, node_id TEXT, tf REAL, PRIMARY KEY(term, node_id))  -- BM25
doclen(node_id TEXT PK, len INT)                                        -- BM25 정규화
vectors(node_id TEXT PK, dim INT, vec BLOB)          -- fp16, 로컬 256d
teacher_vecs(node_id TEXT PK, model TEXT, vec BLOB)  -- 기존 API 임베딩(증류 라벨, 있을 때만)
edges(src TEXT, dst TEXT, etype INT, w REAL, updated REAL, PRIMARY KEY(src,dst,etype))
      -- etype: 0=wikilink 1=tag 2=lexical 3=coaccess(학습)
params(key TEXT PK, blob BLOB)                       -- 랭커 가중치·정규화 통계·버전
feedback(ts REAL, query_hash TEXT, node_id TEXT, features BLOB,
         shown INT, used INT, label_src TEXT)        -- 리플레이 버퍼(상한 4096행, FIFO)
```

- 토크나이저(한국어 대응, 의존성 0): 유니코드 단어 토큰 + **문자 2·3-gram** 병행 색인. 형태소 분석기 없이 한국어 부분일치를 커버한다(BM25는 n-gram 텀에도 잘 동작).
- 규모 가정: 노드 ≤ 50k. 코사인은 numpy 행렬곱 브루트포스(50k×256 fp16 ≈ 25MB, < 5ms) — ANN 인덱스 불요.

---

## 4. 모델 레이어 명세

### 4.1 임베딩 레이어 E — 해시버킷 정적 임베딩 (Model2Vec 계열)
- 구조: `emb(text) = L2norm( mean_i W[h(tok_i)] )`
  - `W ∈ R^{V×d}`, **V=65,536(해시 버킷), d=256, fp16 → 32MB**
  - `h`: 토큰(단어+2·3-gram)의 FNV-1a 해시 → 버킷. OOV 없음, 다국어 무관.
- 추론: 룩업+평균 — **행렬곱 1회도 없는 O(토큰수)**, 마이크로초급.
- 초기화(콜드스타트): 결정적 해시 랜덤 투영(현 `local.py` 해시 임베딩의 상위호환) — 증류 전에도 "약한 시맨틱 + BM25 + 그래프"로 동작.
- **학습(증류)**: vault의 `(노트 텍스트, 저장된 teacher API 임베딩)` 쌍으로
  `min_W Σ ‖ P·mean(W[h(tok)]) − t ‖²  (P ∈ R^{d_t×d}는 teacher 차원 사영, 고정 랜덤 or 동시학습)`
  — 미니배치 SGD(Adam, lr 1e-3), 세션 종료·유휴 시 1회 배치(수 초, CPU). **teacher 콜 추가 발생 없음**(이미 저장된 벡터 재사용; 새 노트는 라벨 없이도 색인되고, teacher가 있으면 증류에 참여).

### 4.2 그래프 레이어 G — 에지타입별 PPR
- 에지: 기존 `derive_graph_edges`의 3종(wikilink/tag/lexical) + 신규 **coaccess**(§5.2 Hebbian).
- 질의 시 시드 집합에서 **에지타입별로 제한한 인접행렬로 PPR 4회**(α=0.5, ≤20 iter, 기존 `graph_rank.py` 재사용) → 노드별 특징 `ppr_link, ppr_tag, ppr_lex, ppr_co`.
  - 타입 가중치를 별도 파라미터 θ로 학습하지 않고 **랭커의 특징 가중치로 일원화** — PPR 미분 불요, 해석 가능, 안정적.
  - 비용: 노드 수천에서 수 ms; 기존 코드가 2,000에지 초과 시 스레드 오프로드하는 패턴 유지.

### 4.3 랭킹 레이어 R — 14→16→1 MLP (numpy, ~273 파라미터)
- 입력 특징(z-정규화, 통계는 params에 지속):
  `[bm25, cosine, rrf_seed, ppr_link, ppr_tag, ppr_lex, ppr_co, recency(log-decay), access_freq(log), importance_boost, pinned, title_hit, category_prior, len_norm]`
- 구조: `Linear(14→16) → GELU → Linear(16→1) → σ` (fp32, numpy forward/backward 손구현 — torch 불요).
- 초기화: 1층을 항등 근사 + 2층 가중치를 **현 휴리스틱(코사인·부스트 중심)과 동일 서열이 되도록** 해석적 설정 → 학습 0회 시점 성능 = 현 엔진 근사.

## 5. 학습 방법

### 5.1 신호 수집 (기존 파이프라인에 후킹, LLM 콜 0)
| 신호 | 라벨 | 수집 지점 |
|---|---|---|
| 회수된 메모리가 응답에 인용됨(제목/본문 스팬 n-gram 겹침 ≥ τ) | **+1** | Stage 18 `record_turn` 직후 응답 텍스트 대조(문자열 연산) |
| 회수 후 `memory_read`로 후속 열람 | **+1 (강)** | memory_read 툴 호출 로그 |
| 다음 k턴 내 재회수·재사용 | +0.5 | 회수 로그 |
| 노출됐으나 k턴 내 미사용 | **−1** | 회수 로그 (지연 라벨링) |
| distill/링크 생성 시 참조됨 | +0.5 | fact/rollup 결과 대조 |

### 5.2 에지 학습 — Hebbian coaccess (파라미터-프리, 즉시)
- 같은 질의에서 **함께 회수되고 둘 다 사용된** 노드쌍: `w ← w + η(1−w)` (η=0.3)
- 유휴 시 감쇠: 접근 시점 기준 lazy decay `w ← w·λ^Δweeks` (λ=0.9, 조회 시 계산 — 상시 잡 없음)
- `w < 0.05` 프루닝. → "자주 같이 쓰이는 기억"이 그래프 구조 자체로 학습됨.

### 5.3 랭커 학습 — pairwise 온라인 로지스틱
- 같은 질의의 (used, ignored) 쌍으로 `L = log(1+exp(−(s⁺−s⁻))) + 1e-4‖W‖²`
- 이벤트 시 SGD(lr 0.05) 1스텝 + feedback 리플레이 버퍼에서 미니배치 8쌍 재학습(마이크로초~ms).
- 안전장치: ① 가중치 EMA 섀도(급변 방지) ② 최근 200 이벤트 온라인 AUC가 초기 휴리스틱 대비 −5%p 이탈 시 자동 롤백 ③ ε=0.05 탐험(회수 후보 말미 1슬롯만).

### 5.4 증류 학습 — §4.1 (세션 종료/유휴 1회 배치, bounded)

---

## 6. 비용·성능 예산 (목표)

| 항목 | 현재(composite+API) | synapse 목표 |
|---|---|---|
| 질의 비용 | 임베딩 1콜(~수십 ms, $) + O(N) 코사인 | **API 0콜, < 10ms CPU** |
| 쓰기 비용 | 임베딩 1콜 + index.bin 전체 재작성 | **API 0콜**, SQLite 증분 upsert < 5ms |
| 상시 비용 | (auth breaker 리스크) | **0** (이벤트 구동만) |
| 디스크 | index.bin + meta | synapse.db + 32MB 임베딩 테이블(전역 1개 공유) |
| 학습 | 불가 | 이벤트당 μs + 종료 시 수 초 배치 |
| 검색 품질 | 벡터 or 태그 단독 | BM25+시맨틱+그래프 융합, 사용 이력에 적응 |

## 7. 통합 계획 (정확한 seam)

1. **executor**: `memory/providers/synapse/` 신설 —
   `SynapseMemoryProvider`는 `FileMemoryProvider`를 **합성**(STM/LTM/Notes/Index 위임)하고
   `vector()`(로컬 임베딩 VectorHandle)·`retrieve()`(§2 파이프라인)·검색 훅만 교체.
   `factory.register("synapse", ...)` + `MEMORY_PROVIDER_CONFIG_KEYS` 등재. 노트 쓰기 후킹은 기존 `after_note_write` 훅/`attach_vector_indexer` seam 재사용.
2. **Geny**: `LTMConfig`에 `memory_engine: SELECT ["composite"(기본, 현행), "synapse"]` +
   `provider_bridge.build_memory_provider_config()`의 `"provider"` 하드코딩 지점(194, 231)에서 분기.
   ko/en i18n·설정 가이드 포함(자동 렌더).
3. **호환**: 같은 vault 공유. synapse 최초 활성화 시 백그라운드 1회 색인(기존 노트 → BM25/로컬벡터/에지) — 세션 생성은 논블로킹(waitless, 색인 완료 전엔 BM25+그래프만으로 응답).
4. **관측**: `memory.retrieve_breakdown` 이벤트에 엔진·특징·학습 상태 포함, 설정 카드에 학습 통계(이벤트 수·온라인 AUC·에지 수) 노출.

## 8. 단계별 구현 (각 단계 독립 배포 가능)

- **P0 색인 코어** — SQLite 스키마, 토크나이저, BM25, 해시 임베딩(초기화판), 증분 색인기 + 단위테스트/벤치.
- **P1 검색 파이프라인** — 시드 RRF + 타입별 PPR + 초기 랭커(휴리스틱 등가) → provider `retrieve()`/`search` 구현, 리플레이 평가 하네스(현 vault로 recall@5/MRR/레이턴시 vs composite).
- **P2 Geny 배선** — LTMConfig SELECT + provider_bridge 분기 + 최초 색인 + 설정 UI. 프로드에 **옵트인** 배포.
- **P3 온라인 학습** — 회수 로그/라벨러/랭커 SGD/Hebbian/안전장치. 섀도 모드(학습만 하고 랭킹 미반영) 1주 → 지표 확인 후 활성.
- **P4 증류** — teacher_vecs 수집·배치 증류·품질 게이트(증류 후 코사인 상관 ↑ 확인시에만 스왑).

## 9. 리스크와 완화
- **로컬 임베딩 품질 < API**: BM25+그래프와의 융합이 기본 방어, 증류로 격차 축소, 랭커가 신뢰도 낮은 특징의 가중치를 스스로 낮춤. 평가 하네스로 정량 확인 후 기본값 승격 여부 결정.
- **잘못된 학습(피드백 노이즈)**: 라벨 보수화(강한 신호 위주), EMA+자동 롤백, ε 최소화.
- **SQLite 잠금**: WAL + 단일 writer 큐(기존 offload_blocking 패턴 재사용).
- **vault 이중 색인 불일치**: synapse.db는 파생 데이터로 취급 — 언제든 삭제→재색인 가능(원본은 markdown).
