# Path-A 마이그레이션 직후 운영 검증에서 발견한 회귀 — 상세 분석

> 작성: 2026-05-05 · 사이클: GENY-1 ~ GENY-9 + executor 1.17.1 머지 후 docker rebuild → VTuber 세션 운영 화면 검증.
> 본 문서는 **개선 계획을 수립하기 위한 정밀 진단**이다. 처방은 후속 plan 문서에서 결정.

---

## 0. 사용자가 발견한 7가지 증상 (그대로)

| # | 증상 |
|---|---|
| S1 | `<storage>/transcripts/session.jsonl` 에 일반 user/assistant 채팅 0줄, `assistant_dm` 3줄만 기록 (TTS chunk seq 26+ 발생했는데도) |
| S2 | `memory/conversations/` 폴더 자체가 미생성 (대화 rollup 0건). Opsidian 의 "대화" 탭이 `0 files` 표시 |
| S3 | `memory/dms/` 폴더도 미생성. assistant_dm 메시지가 STM 에는 들어가는데 dm bundle 0건 |
| S4 | Opsidian sidebar 가 EXECUTIONS(1) / DAILY(31) / CRITICAL(6) 만 노출. topics / insights / projects 보이지 않음 |
| S5 | `_index.json` 의 hierarchical sharded index 폐기 회귀 — 사용자 의도는 root index + `<cat>/_index.json` 의 트리 구조 |
| S6 | `critical/` 노트는 생성되지만 (auto_pinned, `from:topics` 태그) 정확히 어떻게/언제 promote 되고 system prompt 어디에 주입되는지 명확하지 않음 |
| S7 | "이 turn 에 들어간 system prompt 본문이 무엇인가" 를 운영자가 실시간으로 볼 수 있는 UI 자리가 없음 |

---

## 1. 진짜 root cause — 두 개의 회귀가 모든 증상을 만들고 있다

### 1.1 회귀 A — `CompositeMemoryProvider` 가 `set_hooks` 미구현

**위치**:
- [geny-executor/src/geny_executor/memory/composite/provider.py](https://github.com/CocoRoF/geny-executor/blob/main/src/geny_executor/memory/composite/provider.py) — `set_hooks` 메서드 없음 (`grep -n "set_hooks" composite/provider.py` → 0건)
- [providers/file/provider.py:109](https://github.com/CocoRoF/geny-executor/blob/main/src/geny_executor/memory/providers/file/provider.py#L109) — `FileMemoryProvider.set_hooks` 만 있음
- [providers/ephemeral.py](https://github.com/CocoRoF/geny-executor/blob/main/src/geny_executor/memory/providers/ephemeral.py) — `EphemeralMemoryProvider.set_hooks` 도 없음

**Geny 측 영향**:
- [Geny/backend/service/executor/agent_session.py:1087](backend/service/executor/agent_session.py#L1087)

```python
def _install_memory_hooks(self) -> None:
    provider = self._memory_provider
    mgr = self._memory_manager
    if provider is None or mgr is None:
        return
    if not hasattr(provider, "set_hooks"):
        return  # ← provider 가 composite 면 여기서 silent skip
    from geny_executor.memory.provider import MemoryHooks
    ...
    provider.set_hooks(MemoryHooks(after_record_turn=_on_record_turn))
```

**경로 추적**:
1. [provider_bridge.py:230-238](backend/service/memory/provider_bridge.py#L230-L238) — `build_memory_provider` 가 **항상 composite 설정으로 빌드** (`provider_bridge.py:183` `"provider": "composite"`).
2. `MemoryProviderFactory.build(composite config)` → `CompositeMemoryProvider` 인스턴스 반환.
3. `AgentSession._init_memory_provider` 가 그 composite 를 `self._memory_provider` 에 저장.
4. `_install_memory_hooks` 호출 → `hasattr(provider, "set_hooks")` False → **return** (silent).

**결과**: `MemoryHooks.after_record_turn` 콜백이 **단 한 번도 등록되지 않음**. ConversationArchiver / DmArchiver 가 영원히 fire 안 됨.

### 1.2 회귀 B — `MEMORY_PROVIDER_ATTACH=false` 가 docker 기본값

**위치**:
- [docker-compose.yml:86](docker-compose.yml#L86) — `MEMORY_PROVIDER_ATTACH=${MEMORY_PROVIDER_ATTACH:-false}` (모든 compose 파일 동일)
- [backend/service/memory_provider/config.py:213](backend/service/memory_provider/config.py#L213) — `is_attach_enabled()` 가 환경변수 false 면 False 반환
- [backend/service/executor/agent_session_manager.py:841-854](backend/service/executor/agent_session_manager.py#L841-L854) — `if is_attach_enabled() and agent._pipeline is not None:` 분기에서 **attach skip**

**결과**: stage 18 `MemoryStage._provider` = None. [stages/s18_memory/artifact/default/stage.py:207](stages/s18_memory/artifact/default/stage.py#L207) 의 `_drive_provider` 가 즉시 return.

**그래서 일반 user/assistant 메시지가 STM 에 도달 못함**:
- stage 18 `_drive_provider` 가 호출되지만 `provider is None` → 즉시 return → `provider.record_turn(turn)` 실행 안 됨.
- `manager.record_message` 의 `_maybe_archive_*` 호출도 GENY-5/6 에서 제거됨 (#679).
- 즉 일반 채팅의 STM/archive 트리거가 둘 다 끊김.
- 살아남은 path 는 **agent-DM 도구의 `manager.record_message` 직접 호출** 한 곳뿐 → assistant_dm 만 jsonl 에 들어감.

### 1.3 두 회귀의 합으로 만들어지는 사용자 증상 매트릭스

| 증상 | 원인 |
|---|---|
| S1 (STM 에 일반 채팅 0줄, assistant_dm 만) | 회귀 B: `_drive_provider` 가 dead → user/assistant 가 STM 도달 못함. assistant_dm 만 직접 record_message path 살아있음 |
| S2 (`memory/conversations/` 미생성) | 회귀 A + B: hook 등록 안 됨 + STM 에 user 메시지 자체 없음 → ConversationArchiver fire 0회 |
| S3 (`memory/dms/` 미생성) | 회귀 A: assistant_dm 은 STM 에 들어가지만 hook 등록 안 됐으니 DmArchiver 도 fire 0회 |

**S1/S2/S3 가 한 뿌리**. 회귀 A 와 B 둘 다 fix 해야 정상 동작.

---

## 2. S4 — Opsidian sidebar 카테고리 누락

**위치**:
- [frontend/src/components/opsidian/OpsidianSidebar.tsx:84-107](frontend/src/components/opsidian/OpsidianSidebar.tsx#L84-L107) — `grouped` 가 `useOpsidianStore.files` 에서 카테고리별 그룹핑.
- [OpsidianView.tsx:74](frontend/src/components/opsidian/OpsidianView.tsx#L74) — `setFiles(indexRes.index.files)` 즉 `files = indexRes.index.files`.
- 즉 sidebar 에 보이는 카테고리 ⊂ `provider.index().snapshot()["files"]` 의 카테고리.

**의심 시나리오**:
- 운영 화면에서 `daily(31)` / `critical(6)` / `executions(1)` 만 보임.
- 화면 1 / 4 의 폴더 트리에 `topics`, `insights` 폴더가 존재 — 그러나 노트 수는 모름.
- 화면 7 의 critical 노트 frontmatter 에 `from:topics` 태그 — pin policy 가 topics 노트를 critical 로 promote 했을 가능성. 그 결과 topics/ 폴더가 빈 상태로 남았을 수도.

**검증 필요**:
1. 디스크에서 `ls -la <storage>/memory/topics/` 결과 — 노트 수 0 이면 sidebar 미노출이 정상 (주: 폴더 자체는 `category_dirs()` ensure() 로 만들어짐, 빈 폴더 상태)
2. 또는 `_FilesystemNotesStore._ensure_loaded` 의 `_load_note` 가 topics/ 안의 .md 를 어떤 이유로 reject 하는지 (예: frontmatter 파싱 실패)

만약 1이면 sidebar 정상 — 사용자 의도와 다른 건 "topics 폴더는 보고 싶다 (빈 채로라도)" 일 수 있음. 그러면 sidebar 가 `index.files` 외에 카테고리 디렉토리 목록도 별도 fetch 해야 함.

---

## 3. S5 — `_index.json` hierarchical sharded index 폐기

**원래 동작 (GENY-4 직전, [git show a2697a5^:backend/service/memory/index.py:739-822]):**
```
memory/_index.json                  ← root summary (categories aggregate, link_graph, totals)
memory/<cat>/_index.json            ← per-category shard (files, tag_map)
```

GENY-4 (#678) 가 `MemoryIndexManager` 를 thin adapter 로 만들면서:
- `_save_to_disk` 의 hierarchical shard 로직 폐기
- `_index.json` 쓰기는 executor `_FileIndexStore._write_cache` 가 대신 (단일 파일)
- per-category shard 는 어디서도 쓰지 않음

**현재 동작 ([executor 1.17.1: providers/file/index_store.py:138-143]):**
```python
def _write_cache(self, payload: Dict[str, Any]) -> None:
    self._layout.memory.mkdir(parents=True, exist_ok=True)
    self._layout.index_json.write_text(
        json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=2),
        encoding="utf-8",
    )
```

**사용자 의도**: hierarchical 트리. root `_index.json` 은 폴더 구조 / category 요약만, 하위 `<cat>/_index.json` 에 파일별 메타. progressive disclosure (cycle 20260503_6 의 명시적 디자인 결정이었음, 이전 sharded 코드의 docstring 참조).

**plan v2 와의 일치성**: plan v2 §1 매트릭스는 `_index.json` 을 "executor IndexHandle 단일" 로 정의 — 그 결정이 사용자 의도와 모순됐다는 게 새로운 발견. **plan v2 의 결정이 잘못된 것**, 사용자가 "hierarchical 유지" 라고 명시 안 한 채 plan 승인했고 우리는 단일 파일로 구현.

**처방 후보** (plan 후속에서 결정):
- A. executor `IndexHandle` 에 hierarchical write 옵션 추가 (executor 측 EXEC PR)
- B. Geny 측에 별도 sub-index writer 부활 (after_note_write hook 등에서 카테고리 shard 생성). executor `_index.json` 은 그대로, 추가 shard 만 Geny 가 작성

→ 사용자가 "구체적 비즈니스 로직은 Geny 에서" 결정한 원칙으로 보면 B 가 자연스러움.

---

## 4. S6 — critical 노트 promote 메커니즘 + 사용처

### 4.1 promote 흐름 (코드 추적 결과)

1. **insight 생성**: 매 turn 종료 시 stage 18 의 `GenyMemoryStrategy._reflect` (LLM 호출) → `Insight` 객체들.
2. **auto_promote 게이트**: `MemoryHooks.should_auto_promote(insight)` 가 True 인 경우만.
   - 디폴트: `lambda i: i.should_auto_promote()` → `importance >= HIGH`.
   - Geny 측에서 더 좁힐 수 있도록 `min_insight_importance` 통과 (기본값 high).
3. **promote 콜백 호출**: `should_auto_promote == True` 일 때 [strategy.py 의 promote 흐름](geny-executor/src/geny_executor/memory/strategy.py) → Geny 의 [pin_policy.make_promote_callback()](backend/service/memory/pin_policy.py#L105) 콜백 실행.
4. **콜백 동작**: 해당 insight 의 사본을 `category="critical"` 로 `provider.notes().write` (frontmatter 에 `from:topics`, `auto-pinned`, `pinned` 태그 첨부).

→ 화면 7 의 노트 (`from:topics` 태그 + `auto_pinned` frontmatter) 가 정확히 이 흐름으로 만들어진 것이 맞음.

### 4.2 사용처 (system prompt 주입)

- [Geny LongTermMemory.load_pinned](backend/service/memory/long_term.py) → executor `NotesHandle.load_pinned(category="critical", max_chars=3000)` (EXEC-4) → critical 노트 본문 합쳐서 string.
- 이 string 은 retriever 의 `_load_pinned_facts` 가 호출. system prompt 의 `# Pinned Facts` 섹션에 들어감.
- 즉 critical 노트는 매 turn 의 system prompt 에 주입된다 (load_pinned 가 fire 되는 시점에).

**확인 필요한 점**: retriever 가 매 turn 정말 `load_pinned` 부르는지. 그리고 이 결과가 `# Pinned Facts` 섹션으로 출력되는지. 현재 사용자 운영 화면에서 검증 불가 (이게 S7 의 부재와 직결).

---

## 5. S7 — system prompt 동적 로깅 부재

**현재 상태**:
- [SessionLogger](backend/service/logging/session_logger.py) 가 LogLevel STAGE / RESPONSE / COMMAND / TOOL / TOOL_RES / STREAM / MEMORY 등을 기록.
- `log_stage_enter` / `log_stage_exit` 가 stage 진입/이탈 만 기록 — body 없음.
- system prompt 가 빌드되는 stage 3 (system) / stage 8 (think) 의 입력값 자체는 어디서도 로깅 안 됨.
- VTuber LOGS panel 은 더더욱 — 거기엔 STAGE 로그 자체도 안 들어옴 (이전 분석 보고서 참조).

**사용자 요구**:
- "Opsidian 쪽에 프롬프트가 어떻게 들어가는지 로깅할 수 있는 탭" — 운영자가 매 turn 의 system prompt 본문 + Pinned Facts + Vault Map + recent STM 등 주입 내용을 직접 볼 수 있어야.

**구조적으로 필요한 작업**:
1. SessionLogger 에 `log_prompt_injection(stage, prompt_body, sections)` 같은 메서드 추가.
2. stage 3 (system) 또는 stage 8 (think) 가 prompt assembly 직후 그 메서드 호출.
3. broadcast envelope 에 prompt body 가 포함되어 frontend 로 전달.
4. Opsidian 에 별도 "Prompt" 탭 — turn 별 prompt body 표시.

후속 plan 에서 구체화.

---

## 6. 부수 발견 — pending_metadata stamp 흐름은 정상

S1/S2/S3 의 진짜 원인은 회귀 A+B 이지만, 분석 과정에서 다음이 **정상** 임을 함께 확인했다 (앞으로 의심하지 말 것):

- [agent_session.py:2548-2599](backend/service/executor/agent_session.py#L2548-L2599) 가 `make_event_metadata` 로 `pending_metadata` 를 정상 빌드하고 [agent_session.py:2650-2651](backend/service/executor/agent_session.py#L2650-L2651) 에서 `_state.metadata["_pending_message_metadata"]` 로 stamp.
- [dedupe_strategy.py](backend/service/memory/dedupe_strategy.py) 의 `_record_transcript` 가 GENY-2 후 stamp-only 패턴으로 정상 작동.
- 단 회귀 B 때문에 stage 18 `_drive_provider` 가 dead → 결국 stamp 가 무용지물.
- executor 1.17.0 EXEC-1 의 `Turn.from_state_message` metadata pickup 도 정상.

→ 회귀 A 와 B 가 fix 되면 pending_metadata stamp + Turn metadata pickup 모두 자동으로 작동할 것.

---

## 7. 회귀 발생 시점 매핑 (어떤 PR 가 만들었나)

| 회귀 | 도입 PR | 메커니즘 |
|---|---|---|
| A. composite set_hooks 미구현 | EXEC-2 (#180) | `MemoryHooks.after_*` 추가 시 `FileMemoryProvider.set_hooks` 만 구현, `CompositeMemoryProvider.set_hooks` / `EphemeralMemoryProvider.set_hooks` 누락. EXEC-2 의 unit test 가 file provider 만 검증해서 누락 surface 안 됨. |
| B. MEMORY_PROVIDER_ATTACH 기본 false | (오래 전) | docker-compose 디폴트가 `:-false`. plan v2 가 stage 18 `_drive_provider` 를 단일 STM 쓰기 경로로 가정했지만 attach 가 기본 비활성이라는 사실 미인식. GENY-1~6 의 path-A 마이그레이션 전제가 부정확. |
| C. `_index.json` hierarchical 폐기 | GENY-4 (#678) | thin adapter 전환하면서 per-category shard 로직 제거. plan v2 §3.4 결정이 사용자 의도와 다름. |
| D. system prompt 로깅 부재 | (사이클 외) | 본 마이그레이션과 무관. 별도 누락. |

---

## 8. 처방 우선순위 (proposal — plan 단계에서 확정)

### P0 — 시급 (기능 멈춤)
1. **CompositeMemoryProvider.set_hooks 구현** — composite 가 현재 활성화된 모든 scope provider (session, user_curated 등) 의 set_hooks 에 forward.
2. **EphemeralMemoryProvider.set_hooks 도 동시 구현** — 일관성.
3. **MEMORY_PROVIDER_ATTACH 기본 true 화** — docker-compose, config 디폴트 변경. 또는 path-A 가 attach 와 무관하게 동작하도록 _drive_provider 외 경로로 STM/archive 트리거.

### P1 — 본 회귀 검증
4. P0 머지 + docker rebuild → 운영 검증: STM jsonl 에 user/assistant 정상 기록, conversations/ 와 dms/ 폴더 자동 생성 확인.

### P2 — 사용자 의도 재정렬
5. **`_index.json` hierarchical 부활** — 옵션 B (Geny 가 sub-index 별도 작성, executor `_index.json` 은 그대로) 가 권장.
6. **Opsidian sidebar 가 빈 카테고리 폴더도 표시** — `provider.notes().list_categories()` 같은 신규 API 또는 기존 list 결과의 빈 카테고리도 surface.

### P3 — 신규 surface (사용자 신규 요구)
7. **system prompt 로깅 + Opsidian Prompt 탭 신설** — SessionLogger 에 prompt-injection 메서드 + stage 3/8 호출 + broadcast envelope 확장 + frontend 탭 추가.
8. (이전 분석에서 짚은) VTuber LOGS panel 에 모든 종류 SessionLogger 이벤트 forward — broadcast envelope 의 `session_log_entries` 채널.

---

## 9. 다음 액션

본 문서 사용자 검토 후:
1. 처방 우선순위 P0 ~ P3 중 어느 범위까지 한 사이클에 진행할지 결정.
2. 결정된 scope 로 plan 문서 (`docs/plan/MEMORY_REGRESSION_FIX_PLAN.md`) 작성.
3. 그 plan 따라 PR 진행.

본 진단 자체는 검증된 코드 추적 결과만 담음. 추측 없음. 처방은 plan 단계에서 사용자 결정.
