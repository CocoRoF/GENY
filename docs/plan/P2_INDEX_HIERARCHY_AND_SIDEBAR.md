# P2 — `_index.json` Hierarchical 부활 + Opsidian Sidebar 카테고리 노출

> 작성: 2026-05-05 · 우선순위: 사용자 의도 재정렬 (기능 작동에는 무관, UX/탐색성 회복).
> 진단 근거: `docs/analysis/MEMORY_REGRESSION_AFTER_PATH_A.md` §3 (S5), §2 (S4).

---

## 0. 목표 한 줄

**1) `memory/_index.json` 은 root summary, `memory/<category>/_index.json` 은 per-category shard** 로 hierarchical 트리 부활. 2) Opsidian sidebar 가 **노트가 0건인 카테고리 폴더도 표시** 해서 운영자가 빈 카테고리 존재 여부를 한눈에.

---

## 1. 책임 분담 (executor vs Geny) — 사용자 철학 적용

| 책임 | 권위 | 이유 |
|---|---|---|
| **단일 root `_index.json`** (executor 포맷: files / tag_map / link_graph) | executor `IndexHandle.snapshot` | 이미 executor 가 보유 (`_FileIndexStore._write_cache`). 모든 host 가 공유하는 일반 인덱스. |
| **카테고리별 `<cat>/_index.json` shard** | **Geny** | 카테고리 분할은 host 의 사용 패턴/탐색 모델에 따른 비즈니스 결정. executor 는 카테고리 의미를 모름 (1.17.1 의 dynamic discovery 도 단지 폴더 존재만 인지). |
| **카테고리 디렉토리 enumeration** (빈 폴더 포함) | executor `IndexHandle` 또는 새 `NotesHandle.list_categories` | 디스크 폴더 inventory 는 일반 인프라. 호스트가 비즈니스 라벨/설명/icon 첨부. |
| **빈 카테고리 sidebar 노출 결정 + 라벨/icon** | Geny frontend (`OpsidianSidebar.tsx` + `memoryCategories.ts`) | UX 결정. |

**철학 적용 한 줄**: executor 가 "디렉토리 트리 + 파일 inventory" 의 일반 read API 를 강력하게 제공하고, Geny 가 그 위에 "카테고리별 집계 + 의미 레이블" 비즈니스를 얹는다.

---

## 2. EXEC-A — `IndexHandle.list_categories` 신규 surface

### 2.1 현재

- `IndexHandle.snapshot` 이 `files` dict 를 반환하지만 빈 카테고리 폴더 (노트 0건) 는 dict 에 안 나타남.
- 1.17.1 patch 가 `DirectoryLayout.category_dirs` 를 dynamic 으로 만들었지만 그 결과는 `_FilesystemNotesStore._ensure_loaded` 의 scan 에만 사용됨, 외부 노출 없음.

### 2.2 EXEC-A1 — Protocol 확장

대상: `geny-executor/src/geny_executor/memory/provider.py`

```python
@runtime_checkable
class IndexHandle(Protocol):
    ...
    async def list_categories(self) -> List[Dict[str, Any]]: ...
    """
    Returns: [
        {"name": "topics", "file_count": 3, "path": "memory/topics"},
        {"name": "critical", "file_count": 6, "path": "memory/critical"},
        {"name": "conversations", "file_count": 0, "path": "memory/conversations"},  # 빈 폴더도 포함
        ...
    ]
    """
```

### 2.3 EXEC-A2 — 구현

**File provider** (`providers/file/index_store.py`):
```python
async def list_categories(self) -> List[Dict[str, Any]]:
    """List every direct subdirectory of `memory/` plus the `root`
    pseudo-category, with file count from the snapshot. Empty
    folders are included with file_count=0.
    """
    snap = await self._cached_or_compute()
    files_by_cat: Dict[str, int] = {}
    for entry in snap.get("files", {}).values():
        cat = entry.get("category") or "root"
        files_by_cat[cat] = files_by_cat.get(cat, 0) + 1

    result: List[Dict[str, Any]] = []
    for cat_dir in self._layout.category_dirs():
        # category_dirs() in 1.17.1 yields canonical entries first,
        # then host-defined subdirs (skipping dot/_curated_knowledge).
        cat_name = "root" if cat_dir == self._layout.memory else cat_dir.name
        result.append({
            "name": cat_name,
            "file_count": files_by_cat.get(cat_name, 0),
            "path": str(cat_dir.relative_to(self._layout.root)),
        })
    return result
```

Ephemeral / SQL provider 도 동일 인터페이스 (single-source-of-truth: NotesHandle.all() 의 category 분포).

### 2.4 EXEC-A3 — 단위 테스트

- 빈 카테고리 폴더 (예: `memory/topics/` 가 빈 채로 존재) → list_categories 결과에 `file_count: 0` 으로 포함 확인.
- 1개 노트 있는 카테고리 → `file_count: 1`.
- root 카테고리 (memory/ 직접 하위) → name="root".

### 2.5 release

- `geny-executor 1.18.0` (minor bump — 새 protocol method 추가).

---

## 3. GENY-A — Geny 측 hierarchical sub-index writer

### 3.1 위치

대상: `backend/service/memory/index.py`

### 3.2 GENY-A1 — `MemoryIndexManager.write_subindexes` 추가

```python
def write_subindexes(self) -> None:
    """Per-category `<cat>/_index.json` shard.

    Geny-side business — executor's IndexHandle owns the root
    `_index.json` (single file, executor format). This writer
    drops a sidecar shard inside each category dir so an operator
    drilling into `memory/topics/` sees a local index without
    parsing the whole vault.

    Triggered by `after_note_write` / `after_note_update` hook so
    every disk change refreshes the affected shard.
    """
    snap = self._build_snapshot()
    by_cat: Dict[str, List[Dict[str, Any]]] = {}
    for fname, info in snap.files.items():
        cat = info.category or "root"
        by_cat.setdefault(cat, []).append(info.to_dict())
    for cat, files in by_cat.items():
        cat_dir = (
            self._memory_dir / cat if cat != "root" else self._memory_dir
        )
        if not cat_dir.exists():
            continue
        shard = {
            "version": "2",
            "category": cat,
            "files": {f["filename"]: f for f in files},
            "tag_counts": _tag_counts_for(files),
            "last_rebuilt": snap.last_rebuilt,
            "description": _CATEGORY_DESCRIPTIONS.get(cat, ""),
        }
        try:
            _atomic_write_json(cat_dir / "_index.json", shard)
        except OSError:
            logger.debug(
                "MemoryIndex.write_subindexes: shard write failed for %s",
                cat, exc_info=True,
            )
```

### 3.3 GENY-A2 — root `_index.json` 의 사용자 의도 형식

executor 가 쓰는 root `_index.json` 은 detailed (모든 file 메타). 사용자 의도는 root 가 "폴더 구조 요약" 이고 detail 은 shard 에. 

옵션:
- **A**: executor root 는 그대로 두고 **별도 `memory/_summary.json`** 을 Geny 가 추가 (root summary).
- **B**: executor root 를 더 lean 하게 (file content 빼고 카테고리 aggregate 만) — executor 측 변경.

→ 옵션 A 권장 (executor 단순 유지, Geny 측 추가 인공물). 

```python
def write_root_summary(self) -> None:
    """`memory/_summary.json` — folder-tree overview (host business)."""
    cats = run_coro_sync(self._provider.index().list_categories())
    payload = {
        "version": "2",
        "categories": cats,
        "category_descriptions": _CATEGORY_DESCRIPTIONS,
        "generated_at": datetime.now(_get_tz()).isoformat(),
    }
    try:
        _atomic_write_json(self._memory_dir / "_summary.json", payload)
    except OSError:
        logger.debug("write_root_summary failed", exc_info=True)
```

### 3.4 GENY-A3 — `after_note_write` / `after_note_update` hook 으로 트리거

대상: `backend/service/executor/agent_session.py:_install_memory_hooks`

```python
async def _on_note_write(meta) -> None:
    if mgr._index_manager is not None:
        try:
            mgr._index_manager.write_subindexes()
            mgr._index_manager.write_root_summary()
        except Exception:
            logger.debug("subindex refresh failed", exc_info=True)

provider.set_hooks(MemoryHooks(
    after_record_turn=_on_record_turn,
    after_note_write=_on_note_write,
    after_note_update=_on_note_write,  # 같은 callback
))
```

### 3.5 GENY-A4 — 호출자 업데이트

기존에 `memory/_index.json` 만 보던 코드가 있으면 `_summary.json` 도 같이 보도록.
- `backend/controller/memory_controller.py` 의 index endpoint 가 `_summary.json` 도 응답에 포함.
- `frontend/src/lib/api.ts` 의 `getIndex` response shape 확장.

---

## 4. GENY-B — Opsidian Sidebar 빈 카테고리 노출

### 4.1 현재

[`frontend/src/components/opsidian/OpsidianSidebar.tsx:84-107`](frontend/src/components/opsidian/OpsidianSidebar.tsx#L84-L107) `grouped` 가 `useOpsidianStore.files` 의 카테고리만 표시. 0건 카테고리 미노출.

### 4.2 GENY-B1 — Sidebar fetch 가 `_summary.json` (또는 list_categories API) 도 가져옴

대상: `OpsidianView.tsx` 의 fetch 로직

```ts
const [indexRes, graphRes, categoriesRes] = await Promise.all([
  memoryApi.getIndex(selectedSessionId),
  memoryApi.getGraph(selectedSessionId),
  memoryApi.listCategories(selectedSessionId),  // 신규
]);
setMemoryIndex(indexRes.index);
setFiles(indexRes.index.files);
setCategories(categoriesRes.categories);  // 신규 store field
```

### 4.3 GENY-B2 — Sidebar 가 categories 기준으로 group 키 보강

```tsx
const grouped = useMemo(() => {
  const groups: Record<string, FileInfo[]> = {};
  // 신규: 빈 카테고리도 키로 등록
  for (const cat of (categories ?? [])) {
    groups[cat.name] = [];
  }
  Object.values(files).forEach((f) => {
    const cat = f.category || 'root';
    if (!groups[cat]) groups[cat] = [];
    if (filterText) { /* ... */ }
    else { groups[cat].push(f); }
  });
  return groups;
}, [files, filterText, categories]);
```

빈 카테고리는 `(0)` 표시 + 회색 dim 스타일.

### 4.4 GENY-B3 — `memoryApi.listCategories` + 신규 controller endpoint

대상: `backend/controller/memory_controller.py` + `frontend/src/lib/api.ts`

```python
@router.get("/{session_id}/memory/categories")
async def list_memory_categories(session_id: str = Path(...)):
    mm = _get_memory_manager(session_id)
    if mm is None or mm.memory_provider is None:
        return {"categories": []}
    cats = await mm.memory_provider.index().list_categories()
    return {"categories": cats}
```

```ts
// api.ts
listCategories: (sessionId: string) =>
  apiCall<{categories: Array<{name: string; file_count: number; path: string}>}>(
    `/api/agents/${sessionId}/memory/categories`
  ),
```

### 4.5 단위 테스트

- 빈 폴더 시나리오: 새 세션 + 노트 0건 → sidebar 에 모든 canonical 카테고리 (`daily`, `topics`, `projects`, `insights`, `dms`, `conversations`, `compactions`, `critical`, `executions`) 가 file_count 0 으로 표시.

---

## 5. PR 시퀀스

```
EXEC-A1 + A2 + A3 (list_categories 신규) ─→ geny-executor 1.18.0 release
                                            │
                                            ↓
GENY-A1 + A2 + A3 + A4 (sub-index writer) ──┐
GENY-B1 + B2 + B3 (sidebar 신규 fetch)  ────┴── Geny PR #N (단일 큰 PR)
                                                + requirements bump >=1.18.0
```

총 PR: executor 1개 + Geny 1개.

---

## 6. 위험 / 롤백

- `_summary.json` + `<cat>/_index.json` shard 가 매 노트 write 후 갱신 → I/O 부담. 측정 필요. 1초 안 걸리면 OK.
- 디스크 락 — shard write 가 동시 트리거 시 race. `_atomic_write_json` 가 tempfile + rename 이라 안전.
- 롤백: `_install_memory_hooks` 에서 `after_note_write` 콜백만 disable 하면 자동 갱신 멈춤. 기존 file 들은 그대로 유지.

---

## 7. 미해결 결정사항

1. **root `_index.json` 을 lean 하게 만들지** (옵션 B) **vs `_summary.json` 별도 추가** (옵션 A) — 본 plan 은 A 채택. 사용자 의도 ("root 는 폴더 구조 요약, 하위는 detail") 가 정확히 어느 쪽인지 재확인 필요.
2. shard 갱신 cadence — 매 write/update 후 즉시 vs debounce (예: 1초). 즉시가 정확하지만 I/O 비용. 일단 즉시.
3. Opsidian sidebar 의 빈 카테고리 표시 스타일 — `(0)` count 만 + 회색 dim, vs 별도 "Empty categories" 섹션. 일단 dim 스타일.

---

## 8. 다음 액션

1. 본 P2 plan 사용자 승인 + 미해결 결정사항 답.
2. EXEC-A 통합 PR + 1.18.0 release.
3. Geny PR (sub-index writer + sidebar) + requirements bump.
4. 운영 검증: 새 세션 → memory/ 안 모든 카테고리에 `_index.json` 존재 + memory/`_summary.json` 존재 + Opsidian sidebar 모든 카테고리 표시.
