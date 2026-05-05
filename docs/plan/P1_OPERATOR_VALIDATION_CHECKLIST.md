# P1 — P0 머지 후 운영 검증 체크리스트

> 작성: 2026-05-05 · 우선순위: P0 의존.
> 본 문서는 plan 이 아니라 **운영자 가이드** — P0 PR 머지 + docker rebuild 후 사용자가 한 줄씩 실행해서 회귀 fix 가 진짜 작동하는지 확인.

---

## 0. 목표 한 줄

P0 (composite/ephemeral set_hooks + MEMORY_PROVIDER_ATTACH=true) 가 머지된 docker image 에서 **새 VTuber 세션을 한 번 돌려보고** STM jsonl + memory/conversations + memory/dms + memory/critical + memory/topics 모두 사용자 의도대로 채워지는지 확인.

---

## 1. 책임 분담 (executor vs Geny)

이번 plan 은 책임 분담 자체가 작업이 아니고 **검증** 이다. 단 검증 항목이 어느 layer 의 동작을 확인하는지는 명시:

| 검증 항목 | 어느 layer 가 권위 |
|---|---|
| `transcripts/session.jsonl` 라인 수/내용 | executor `STMHandle` (FileMemoryProvider) |
| `memory/conversations/*.md` 자동 생성 | Geny `ConversationArchiver` (executor `after_record_turn` hook 으로 트리거) |
| `memory/dms/<cp>/<date>.md` 자동 생성 | Geny `DmArchiver` (동일 hook) |
| `memory/MEMORY.md` / `memory/<date>.md` / `memory/topics/<slug>.md` | executor `LTMHandle` |
| `memory/executions/<date>.md` | executor `NotesHandle` (Geny LongTermMemory.write_execution 이 호출) |
| `memory/critical/<slug>.md` 자동 promote | Geny `pin_policy.make_promote_callback` (executor `MemoryHooks.should_auto_promote` 게이트) |
| `memory/_index.json` 포맷 | executor `IndexHandle.snapshot` (단일 파일, P2 에서 hierarchical 부활 예정) |
| `# Pinned Facts` system prompt 주입 | executor retriever (Geny critical 노트를 executor `NotesHandle.load_pinned` 로 read) |
| `# Vault Map` system prompt 주입 | executor `IndexHandle.render_vault_map` (Geny `_CATEGORY_DESCRIPTIONS` 주입) |

---

## 2. 사전 준비

```bash
# 1) Geny 레포 main 최신
cd /path/to/Geny && git pull

# 2) 현재 의존 버전 확인 (>=1.17.2 여야)
grep geny-executor backend/requirements.txt

# 3) 환경변수 명시 확인 (.env 또는 compose override)
# MEMORY_PROVIDER, MEMORY_PROVIDER_ATTACH 가 명시 false 로 override 되어있지 않은지 확인.
grep -E "MEMORY_PROVIDER" .env 2>/dev/null || echo "no overrides"

# 4) docker rebuild
docker compose down
docker compose build --no-cache backend
docker compose up -d
```

---

## 3. 시나리오 A — 일반 채팅 (회귀 S1/S2 검증)

### 3.1 실행 절차

1. 새 VTuber 세션 생성 (Geny 웹 UI).
2. 세션의 storage_path 확인 (예: `/data/geny_agent_sessions/<sid>/`).
3. 사용자 입력 1회: `"안녕"`
4. assistant 응답 받을 때까지 기다림.
5. 사용자 입력 2회: `"오늘 날씨 어때"`
6. assistant 응답 기다림.

### 3.2 검증 명령어

```bash
SID=<session_id>
STORAGE=/data/geny_agent_sessions/$SID

# A.1 — STM jsonl 정확히 4줄 (user × 2 + assistant × 2)
wc -l $STORAGE/transcripts/session.jsonl
# 기대: 4

# A.2 — 각 라인의 metadata 필드에 InteractionEvent 키 보존
cat $STORAGE/transcripts/session.jsonl | python3 -c "
import json, sys
for i, line in enumerate(sys.stdin, 1):
    rec = json.loads(line)
    md = rec.get('metadata', {})
    print(f'line {i}: type={rec.get(\"type\")} role={rec.get(\"role\")} kind={md.get(\"kind\")} cp={md.get(\"counterpart_id\")}')
"
# 기대:
# line 1: type=message role=user kind=user_chat cp=owner:<user>
# line 2: type=message role=assistant kind=user_chat cp=owner:<user>
# line 3: type=message role=user kind=user_chat cp=owner:<user>
# line 4: type=message role=assistant kind=user_chat cp=owner:<user>

# A.3 — conversations rollup 자동 생성 (단 1개, 같은 user bucket)
ls $STORAGE/memory/conversations/
# 기대: <sid_slug>__user__<title-slug>.md  (1개)

# A.4 — rollup 안에 turn 4개 (user×2 + assistant×2) frontmatter turn_count: 4
head -20 $STORAGE/memory/conversations/<sid_slug>__user__*.md
# 기대 frontmatter: turn_count: 4, event_ids: [4개], importance_max: 적절
```

### 3.3 실패 시 빠른 진단

| 실패 | 원인 후보 | 액션 |
|---|---|---|
| jsonl 0줄 | EXEC-A or GENY-B 머지 안 됨 / docker rebuild 캐시 | `docker compose build --no-cache backend` 재실행 |
| jsonl 4줄인데 metadata 비어있음 | GenyDedupeStrategy stamp 안 됨 / `Turn.from_state_message` metadata pickup 안 됨 | executor 1.17.0 이상인지 확인. 설치 버전: `docker compose exec backend python -c "import geny_executor; print(geny_executor.__version__)"` |
| conversations 폴더 없음 | composite set_hooks 실패 (회귀 A 미해결) | `_install_memory_hooks` 가 silent skip 했는지 백엔드 로그 확인 |
| jsonl 메시지마다 2줄씩 = 8줄 (이중 쓰기) | `MEMORY_PROVIDER_ATTACH` 활성 + `dedupe_strategy._record_transcript` 가 또 record_message 호출 | 코드 회귀 점검, P0 §6 위험 섹션 참조 |

---

## 4. 시나리오 B — agent DM (회귀 S3 검증)

### 4.1 실행 절차

1. VTuber 세션 (위 같은) + 페어드 sub-worker 세션 생성 + 두 세션을 link.
2. VTuber 가 agent-DM 도구로 sub-worker 에게 메시지 보냄 (예: 사용자가 "테스트_worker 에게 인사해줘" 입력).
3. assistant 가 DM 도구 호출 → sub-worker 가 받음.

### 4.2 검증

```bash
# B.1 — STM jsonl 에 assistant_dm 라인 추가
grep -c "assistant_dm" $STORAGE/transcripts/session.jsonl
# 기대: >= 1

# B.2 — memory/dms/<cp>/<date>.md 자동 생성
ls $STORAGE/memory/dms/
# 기대: <counterpart_safe>/  (1개 이상)

ls $STORAGE/memory/dms/*/
# 기대: 2026-05-05.md  (날짜별)

# B.3 — DM bundle 안 frontmatter
head -20 $STORAGE/memory/dms/*/2026-*.md
# 기대 frontmatter: turn_count: N, event_count: N, counterpart_id: <id>
```

---

## 5. 시나리오 C — 메모리 도구 (회귀 S4/S6 검증)

### 5.1 실행 절차

VTuber 가 도구를 호출하도록 사용자 입력:
1. `"이 사실을 영구히 기억해줘: 사장님 호칭은 '주인님'"` → memory_pin 도구 사용 유도.
2. `"파이썬 async 에 대해 노트 정리해줘"` → memory_write category=topics 도구 유도.

### 5.2 검증

```bash
# C.1 — critical 노트
ls $STORAGE/memory/critical/
# 기대: <slug>.md (사장님-호칭 같은 슬러그)

cat $STORAGE/memory/critical/*.md | head -10
# frontmatter 에 importance: critical, source: agent_pin

# C.2 — topics 노트
ls $STORAGE/memory/topics/
# 기대: python-async.md 같은 슬러그

# C.3 — Opsidian sidebar 에 critical, topics 카테고리 노출
# 운영자 UI 직접 확인.

# C.4 — system prompt 에 # Pinned Facts 주입 (S6 검증)
# Geny 백엔드 로그에서 stage 3 (system) 또는 stage 8 (think) 의 input 검색.
docker compose logs backend 2>&1 | grep -A 2 "Pinned Facts" | head -20
# 기대: pinned facts 본문 일부 라인 ("사장님 호칭은 '주인님'") 포함
```

---

## 6. 시나리오 D — `_index.json` 단일 권위 + executor 포맷 (P2 전제 확인)

```bash
# D.1 — 파일 존재 + executor 포맷
cat $STORAGE/memory/_index.json | python3 -c "
import json, sys
d = json.load(sys.stdin)
print('keys:', list(d.keys()))
print('total_files:', d.get('total_files'))
print('categories with files:', sorted({f.get('category') for f in d.get('files', {}).values()}))
"
# 기대 keys: files, tag_map, link_graph, last_rebuilt, total_files, total_chars
# 기대 categories: ['conversations', 'critical', 'daily', 'executions', 'insights', 'topics']
```

D.1 결과가 P2 (hierarchical 부활) 의 전제 — `files` dict 가 모든 카테고리를 포괄하는지가 sub-index 분할 가능성 검증.

---

## 7. 시나리오 E — VTuber LOGS panel + Logs 탭 격차 확인 (P3 전제)

운영자가 직접 화면에서:
1. VTuber LOGS panel: chat / command / tool 항목 모두 보이는지 (현재는 안 보임 — P3 에서 보강).
2. Logs 탭: "전체" 모드에서 RESPONSE / COMMAND / STAGE / TOOL / TOOL_RES / STREAM / MEMORY 모두 시간순으로 누락 없이 흐르는지.

이번 P1 검증의 결과가 P3 plan 의 우선순위를 결정.

---

## 8. 검증 결과 보고

위 시나리오 A~E 의 모든 검증 명령어 출력을 1개 마크다운 파일로 묶어 `docs/analysis/P1_VALIDATION_RESULTS_<date>.md` 로 저장. 어떤 항목이 통과/실패했는지 표로. 실패 항목은 즉시 P0 의 어느 fix 가 누락됐는지 추적.

---

## 9. 다음 액션

1. P0 머지 + docker rebuild.
2. 본 P1 체크리스트 사용자가 한 줄씩 실행.
3. 결과 마크다운 작성 → 사용자가 결과 보고.
4. P2 / P3 진행 여부 결정.
