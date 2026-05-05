# 메모리 시스템 방향성 감사 — 2026-05-05

> 작성: 2026-05-05 PR #687 (registry layer 삭제) 머지 직후, 운영자가
> Opsidian 사이드바 + storage 디스크 검증 → 여전히 빈 인덱스 / session.jsonl
> 미생성 발견.
>
> 본 문서는 **plan vs 현실** 의 격차와 **사용자 철학 vs 현재 구조** 의 격차를
> 객관적으로 정리한다. 처방은 본 문서 사용자 검토 후 후속 plan 으로 분리.

---

## 0. 사용자가 본 디스크 상태 (스크린샷 기준)

```
<storage>/
├── memory/
│   ├── _index.json            226 B   ← 거의 빈 상태
│   ├── _summary.json          2.9 KB  ← 내용 있음
│   ├── _vault_map.json         32 B   ← 거의 빈 상태
│   ├── daily/                          ← 카테고리 폴더 + _index.json (2 KB)
│   │   ├── execution-1.md
│   │   ├── execution-2-하….md
│   │   └── _index.json        2 KB    ← 일부 채워짐?
│   ├── critical/
│   │   ├── 사용자-호칭.md      417 B
│   │   ├── user-prefers-to-…  541 B
│   │   └── _index.json        2.5 KB
│   ├── insights/
│   │   ├── user-prefers-to-…  509 B   ← 노트 EXISTS
│   │   └── _index.json        227 B   ← BUT shard 는 file_count: 0, files: {}
│   ├── conversations/_index.json  276 B   ← shard 만, 노트 0건
│   ├── compactions/_index.json    236 B
│   ├── topics/_index.json         238 B
│   ├── projects/_index.json       222 B
│   ├── dms/_index.json            211 B
│   ├── executions/
│   │   ├── 2026-05-05.md      898 B
│   │   ├── 2026-05-05.md.…     67 B
│   │   └── _index.json        1.1 KB
│   └── checkpoints/
├── transcripts/
│   ├── summary.md             290 B   ← Geny `auto_flush` 가 씀
│   └── (session.jsonl 없음!)          ← executor STM 미작동
└── vectordb/
    ├── index.bin              36 KB
    └── metadata.json          2.8 KB
```

`insights/_index.json` 본문:
```json
{
  "version": "2",
  "category": "insights",
  "description": "LLM-distilled facts curated from past conversations.",
  "file_count": 0,
  "files": {},
  "tag_counts": {},
  "last_rebuilt": "2026-05-05T14:16:01.829980+09:00"
}
```

→ `insights/user-prefers-to-…md` 가 존재하는데 shard 는 `file_count: 0` 으로 기록.

---

## 1. plan 들 머지 결과 vs 운영 현실

| Plan / PR | 의도 | 머지 상태 | 운영 검증 결과 |
|---|---|---|---|
| `MEMORY_THIN_ADAPTER_PLAN.md` GENY-1~9 | STM/LTM/Notes/Index 를 executor 단일 권위로, Geny 는 thin adapter | ✅ #674~683 머지 | ⚠️ executor stage 18 `_drive_provider` 가 dead → STM 미작동 |
| `P0_FIX_HOOK_AND_ATTACH_REGRESSION.md` | composite `set_hooks` 누락 + `MEMORY_PROVIDER_ATTACH=false` 회귀 | ✅ executor 1.17.2 + #684 #685 | ⚠️ attach 는 됐지만 cross-loop bug 로 실효 없음 |
| `P2_INDEX_HIERARCHY_AND_SIDEBAR.md` | hierarchical sub-index + Opsidian 빈 카테고리 노출 | ✅ executor 1.18.0 + #686 | ⚠️ shard 는 생성되나 모두 file_count: 0 |
| PR #687 (registry layer 삭제) | `service/memory_provider/` + 관련 dead code 일괄 제거 | ✅ 머지 | OK — 이건 정상. 진짜 회귀가 위에 있음 |

**현실 한 줄**: plan 마다 명시한 산출물(파일/엔드포인트/사이드카) 은 모두 만들어졌지만, **그 안의 데이터가 비어있다**. 코드 흐름이 "쓴다고 주장하는데 실제로는 안 쓰여진" 상태.

---

## 2. 진짜 root cause — `run_coro_sync` 와 `asyncio.Lock` 의 cross-loop 충돌

### 2.1 증상 → 원인 1:1 매칭

| 증상 | 1차 원인 | 정확한 트리거 |
|---|---|---|
| `transcripts/session.jsonl` 미생성 | stage 18 `_drive_provider` 가 `provider.record_turn` 호출 전에 / 도중에 실패 | `_FilesystemNotesStore._lock` / `_JSONLSTMStore._lock` 이 첫 호출 loop 에 binding → 이후 다른 loop 에서 acquire 시 RuntimeError ("Future attached to a different loop") |
| per-category `_index.json` shard 의 `file_count: 0` | `MemoryIndexManager.write_subindexes` 가 `self.index` 읽을 때 `_build_snapshot` 실패 → 빈 `MemoryIndex()` fallback → `for info in snap.files.values()` 0회 iterate → shard 에 빈 dict | 동일 cross-loop bug (`_FileIndexStore._lock` cross-loop) — 예외는 `logger.debug` 만 찍고 swallow |
| root `_index.json` 226 B (거의 빈 상태) | executor 가 `_FileIndexStore.snapshot()` 실행 시 `_compute()` → `notes.all()` → notes lock cross-loop fail → 빈 payload | 동일 |
| `_vault_map.json` 32 B | `render_vault_map()` 이 provider 에 위임하지만 cross-loop 실패 → `"## Vault Map"` 한 줄로 fallback → `{"rendered": "## Vault Map"}` 단일 키로 캐시 | `index.py:415-435` 의 try/except 가 "## Vault Map" 으로 떨어짐 |
| `_summary.json` 만 2.9 KB 정상 | `IndexHandle.list_categories()` 가 `_cached_or_compute()` 사용 → **디스크 캐시 (`_index.json`) 가 있으면 lock 없이 바로 리턴** → cross-loop 안 탐 | `_FileIndexStore._read_cache()` 는 lock 없는 disk read |

### 2.2 코드 추적 — cross-loop 메커니즘

[`backend/service/memory/sync_async_bridge.py:39-69`](backend/service/memory/sync_async_bridge.py#L39-L69):

```python
def run_coro_sync(coro):
    try:
        asyncio.get_running_loop()
        in_loop = True
    except RuntimeError:
        in_loop = False
    if not in_loop:
        return asyncio.run(coro)         # 새 loop, 일회성

    def _runner():
        new_loop = asyncio.new_event_loop()  # ← 매번 새 loop!
        try:
            return new_loop.run_until_complete(coro)
        finally:
            new_loop.close()

    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(_runner).result()
```

매 호출마다 **새 thread + 새 event loop**. executor 의 `_FilesystemNotesStore.__init__`:

```python
self._lock = asyncio.Lock()   # loop 미지정 — 첫 acquire 시 binding
```

⚠️ Python 3.10+ `asyncio.Lock()`: lazily binds on first `acquire()` to the running loop. Once bound, acquire from a different loop raises:
```
RuntimeError: Task <Task pending ...> got Future <Future pending> attached to a different loop
```

→ **타임라인**:
1. `provider.initialize()` (또는 첫 `provider.record_turn`) 시 main pipeline loop A 에서 lock binding.
2. 운영 중 Geny 의 [`structured_writer.write_note`](backend/service/memory/structured_writer.py) 등이 `run_coro_sync(provider.notes().write(...))` 호출 → 새 thread 의 loop B 에서 lock acquire 시도 → fail.
3. 노트 자체는 sync 코드가 disk 에 직접 쓴 부분(있다면)만 살아남음. 인덱스/사이드카는 모두 빈 채.

### 2.3 왜 `_summary.json` 만 살아있나

[`geny-executor/src/geny_executor/memory/providers/file/index_store.py:79-110`](https://github.com/CocoRoF/geny-executor/blob/main/src/geny_executor/memory/providers/file/index_store.py#L79-L110):

```python
async def list_categories(self) -> List[Dict[str, Any]]:
    snap = await self._cached_or_compute()   # ← 디스크 캐시 있으면 lock 패스
    ...

async def _cached_or_compute(self):
    cached = self._read_cache()              # 디스크 read, lock 없음
    if cached is not None:
        return cached
    async with self._lock:                   # cache miss 일 때만 lock
        ...
```

→ `_summary.json` 빌더가 호출하는 `list_categories` 는 **디스크에 `_index.json` 이 한 번이라도 있으면** lock 안 걸어도 동작. 그래서 file_count 만큼은 (구식 캐시 기준이지만) 채워서 리턴 가능.
반면 `snapshot()` 은 무조건 lock acquire 부터 시작 → cross-loop 실패 → Geny 의 `_build_snapshot` 이 빈 `MemoryIndex()` fallback.

---

## 3. 사용자 철학 vs 현재 구조 — 근본 격차

| 사용자 명시한 철학 | 현재 구현 (`MEMORY_THIN_ADAPTER_PLAN.md` v2) | 격차 |
|---|---|---|
| **executor: "파일들을 받아준다는 그러한 개념만"** (단순 접수자) | executor 가 STM/LTM/Notes/Index/Vector CRUD + 캐시 + asyncio Lock + auto-strategy 를 **모두** 보유 | executor 책임이 너무 큼. Geny 가 sync ↔ async bridge 라는 brittle 한 다리 위에서 호출하게 됨 |
| **Geny: "구체적 로직은 Geny 에 제대로 구현"** (비즈니스 + 디스크 권위) | Geny 는 thin adapter (`short_term`, `long_term`, `index`, `structured_writer`) 들이 모두 `provider.X()` 만 forward — 실제 disk write 는 executor 안에서 발생 | 사용자 의도 = Geny 가 "기록의 장소", 현재 = executor 가 기록의 장소 |
| **transcripts: "모든 transcripts 기록 장소, 메모리 로직 토대 분리"** | `transcripts/session.jsonl` 한 파일에 user/assistant/tool/event 모두 라인-append (executor `_JSONLSTMStore`) | "메모리 로직 토대 분리" 안 됨. 한 jsonl 안에 모든 종류가 섞임. bucket router 는 `memory/conversations/` 에만 적용 |
| **memory: "지식의 원천, index 를 통해 구분 관리"** | hierarchical shard 는 만들었지만 모두 빈 채. 사용자가 노트를 봐도 어떤 카테고리/태그/링크 구조인지 추적 안 됨 | sub-index sidecar 가 의도대로 동작했어도 root `_index.json` 의 의도 정의가 모호. 현재 root 는 "executor 의 flat dump" 이고 사용자 의도는 "폴더 구조 요약". P2 plan §3.3 의 "옵션 A vs B" 가 미해결 결정사항으로 남아있음 |

→ 핵심 한 줄: **plan v2 §0.2 ("executor = 메모리 코어 인프라 + 자동화 전략의 권위") 자체가 사용자 의도와 모순**. 머지된 PR 들은 이 plan 을 충실히 따랐기에, 사용자 의도 기준으로 보면 잘못된 방향.

---

## 4. "지금 무슨 행동들을 계속하고 있는건지" — 작업 목록 솔직 정리

지난 7-8 PR (#680~#687) 의 실제 효과:

1. **GENY-1~9 (thin adapter)**: executor 위임층을 차곡차곡 깔았다. **disk 권위가 Geny→executor 로 이동**.
2. **P0 (composite set_hooks + attach)**: hook 등록 + provider 연결 자체는 살아남. 다만 hook 콜백 안의 `run_coro_sync` 가 cross-loop fail.
3. **P2 (hierarchical sub-index)**: Geny 가 다시 sub-index writer 추가. **하지만 그 writer 가 빈 snapshot 을 받아 빈 shard 만 작성하는 wrapper 가 됨**.
4. **#687 (registry layer 삭제)**: `service/memory_provider/` + `MEMORY_PROVIDER_*` env 모두 제거. 옳은 청소였지만 **회귀 자체와는 무관** — registry 는 dormant 였고 이미 dead code.

→ 즉 **표면에서는 진척이 있는 듯 보이지만, 실제 디스크에 데이터가 안 들어가는 근본 결함은 plan 시작점에 이미 박혀있었음**. cross-loop bug 는 plan v2 §0.2 의 "thin adapter 가 sync 캐스트로 호출" 결정에 내재됨.

---

## 5. 가능한 방향성 (선택은 사용자)

### Option A — **사용자 철학에 맞춰 권위 재배치** (Geny 가 disk owner)

- executor 의 STM/Notes/Index/LTM 클래스들이 더 이상 disk write 하지 않음. **순수 in-memory 모델 + 임의 read API** 만 노출.
- Geny 가 `transcripts/session.jsonl`, `memory/<cat>/*.md`, `_index.json`, sub-index, vault_map 모두 직접 disk 에 쓴다 (sync I/O, lock 없음).
- executor 는 받은 파일들에 대해 **검색 / embedding / pinned facts 합치기 / vault map 렌더만** 한다 (= "파일들을 받아준다는 개념").
- composite / file provider / SQL provider 같은 분기는 executor 에 남되, **storage-side 가 아닌 retrieval-side 의 분기** 로 한정.
- **장점**: 사용자 철학과 1:1 일치. cross-loop bug 자동 해결 (asyncio Lock 자체가 사라짐). Geny 가 Opsidian / VTuber LOGS 등 호스트 비즈니스를 자유롭게 추가.
- **단점**: executor 1.18 의 `FileMemoryProvider` 등 storage 측 코드가 사실상 폐기. 1.0 단위 메이저 변경. 단 사용자가 이미 "마이그레이션 무시" (plan v2 §0.4) 라고 명시.

### Option B — **현재 구조 유지하되 cross-loop 격리 해소**

- executor 의 stores 가 `asyncio.Lock` 대신 `threading.Lock` (loop-agnostic) 사용.
- 또는 Geny 가 `run_coro_sync` 폐기 — 모든 호출자가 async 로 변환 (FastAPI handler / 모든 manager 메서드).
- **장점**: 작은 변경. 이미 머지된 thin adapter 그대로 유지.
- **단점**: 사용자 철학 ("파일들을 받아주는 개념만") 과 여전히 불일치. executor 가 disk owner 역할을 계속함. 다음 회귀 시 또 같은 종류의 문제.

### Option C — **하이브리드** (executor = 기본 storage, Geny = override 가능)

- executor 의 storage 레이어는 **default** 일 뿐. Geny 가 자기만의 disk format 을 원하면 `MemoryProvider` Protocol 을 직접 구현해서 provider_bridge 에 등록.
- 즉 Geny 가 자기만의 `GenyStorageProvider` 작성 — STM 은 자기 jsonl, notes 는 자기 markdown, index 는 자기 hierarchical sub-index.
- executor 는 이 Geny provider 를 받아 retrieval / embedding / pinned facts 합치기만.
- **장점**: 양쪽 자유도. 다른 호스트 (geny-executor-web) 는 default file provider 그대로.
- **단점**: 가장 복잡. provider Protocol 표면이 또 한 번 확장됨.

---

## 6. 즉시 처리 가능한 응급 처방 (방향성 결정 전)

방향성 옵션 A/B/C 결정 전에라도, 운영을 굴리려면 cross-loop bug 만이라도 막아야 한다:

### Hotfix-1 — `run_coro_sync` 가 동일 loop 재사용

- main pipeline loop A 의 reference 를 `AgentSession.__init__` 시 보관.
- `run_coro_sync` 가 그 loop 에 `asyncio.run_coroutine_threadsafe` 로 dispatch.
- **장점**: 모든 락이 main loop 에 binding 된 채 유지. cross-loop 사라짐.
- **단점**: main loop 가 안 돌면 (테스트 / CLI) 동작 안 함 → fallback 필요.

### Hotfix-2 — executor stores 의 lock 을 `threading.Lock` 으로 교체

- executor 측 패치. `_JSONLSTMStore._lock`, `_FilesystemNotesStore._lock`, `_FileIndexStore._lock` 을 `threading.Lock` 으로 swap.
- async 호출자는 `with self._lock:` (sync acquire) 사용.
- **단점**: async 호출자가 sync lock 잡는 동안 event loop 블락. 짧은 disk write 라 무시 가능 수준.

### Hotfix-3 — Geny 가 `run_coro_sync` 호출 자체를 제거 (가능한 곳부터)

- 일단 `write_subindexes` / `write_root_summary` 등 사이드카 writer 만이라도 **provider 호출 안 거치고** Geny 가 디스크 직접 scan 해서 작성.
- `<cat>/*.md` glob → `_index.json` shard 생성. provider snapshot 의존 없음.
- **장점**: cross-loop fail 도 안 타고, 사용자 철학에도 부분 부합 (Geny 가 사이드카의 disk owner).

→ Hotfix 셋 중 **Hotfix-2 + Hotfix-3 결합**이 가장 작은 변경으로 운영 정상화. 단 그건 응급처방. 사용자 의도 옵션 A 와 일치하는 방향이라 그대로 굳혀도 됨.

---

## 7. 결정해야 할 것 (사용자에게)

1. **방향성**: 옵션 A / B / C 중 하나 선택. (사용자 철학 직접 인용 보면 A 가 자연스러움)
2. **응급처방 여부**: 방향성 결정 전에 Hotfix-2/3 만 머지해서 운영 정상화할지, 아니면 방향성 결정 후 일괄 처리할지.
3. **`_index.json` 의도 재확인**: root `_index.json` 이 "전체 dump" 인지 "폴더 구조 요약 (현 `_summary.json` 형태)" 인지. 현재 두 파일이 따로 있는 건 P2 plan 의 미해결 결정사항.
4. **`transcripts` 의 분리 의도**: jsonl 한 파일에 모든 종류의 라인을 섞어 쓰는 게 의도인지, kind 별 (chat / dm / event / tool) 분리 디렉토리가 의도인지.
5. **plan 들의 위상**: 위에 정리한 plan 들 (`MEMORY_THIN_ADAPTER_PLAN`, P0~P3) 이 사용자 의도와 어긋난 부분이 명확해진 만큼, **새 사이클의 base plan 으로 본 문서를 채택할지** 결정.

---

## 8. 본 문서 작성자의 솔직한 자평

위 1~7 의 내용을 사용자가 직접 짚어주기 전에 발견하지 못한 것은 명백한 실패. plan v2 §0.2 의 "executor = 메모리 코어 인프라 + 자동화 전략의 권위" 결정을 사용자 철학 ("파일들을 받아주는 개념만") 과 대조해서 검증하지 않은 채 **9개 PR 을 머지**해서 thin adapter 구조를 굳혔음. 그리고 운영 검증이 빈 인덱스 + 빈 jsonl 을 드러내자 P0~P2 plan 으로 또 같은 구조 위에 사이드카만 추가. 결국 사용자가 "씨발 같은 짓 반복하지 말라" 고 짚어주실 때까지 같은 패턴 반복.

→ 다음 사이클은 **plan 작성 전에 사용자 철학과 명시적으로 충돌 검사** 하는 단계 한 줄 추가 필요.
