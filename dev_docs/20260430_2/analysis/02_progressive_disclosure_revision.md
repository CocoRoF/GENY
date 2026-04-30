# 정정 — Progressive Disclosure 로의 재설계

> **Cycle**: 20260430_2 · **Date**: 2026-04-30
>
> 이 문서는 같은 디렉터리의
> [`01_subworker_observability.md`](01_subworker_observability.md) 의
> *결론 (8장 고도화 후보) 을 정정* 한다. 1~7장 (현황 진단) 은 그대로
> 유효하다.

## 1. 무엇이 잘못되었나

01 문서의 P0-A (`<sub-worker-last-run>` 자동 prompt inject) 와 P0-B
(STM 자동 영구 기록) 는 **둘 다 안티패턴** 이다.

* **P0-A** 는 *우리가 정보를 미리 정해서 매 turn 의 시스템 프롬프트에
  강제 주입* 한다. VTuber 는 그것을 호출하거나 거부할 권한이 없고,
  필요하지 않은 turn 에도 토큰을 먹는다. persona drift 위험도 있다.
* **P0-B** 는 같은 정보를 *STM 에 강제 기록* 해서 결국 다음 turn 의
  retrieval 에 자동으로 떠오르도록 만든다. 이름만 다를 뿐 prompt
  inject 와 똑같이 *수동적 인지* 패턴이다.

핵심 원칙 위반:

> **에이전트가 *살 수 있는 환경* 을 만들어 주고, 에이전트가 *능동적으로
> 도구를 사용해 탐색* 하도록 한다. 직접 prompt 를 주입하면 안 된다.**

또한 Anthropic 의 *progressive disclosure* 원칙 — 도구 시스템은 얕은
overview 부터 깊은 detail 까지 *호출자가 필요한 만큼만 펼쳐 보는*
사다리로 설계되어야 한다 — 와도 정면 충돌한다.

## 2. 재설계 원칙

### 2.1 환경(Environment) 을 강화

Geny 의 *environment manifest* 는 이미 핵심 metaphor 다. VTuber 가
sub-worker 작업을 *살필 수 있는 능력* 도 환경의 일부로서 들어가야
한다 — 다음 두 층 모두에서:

* **데이터 층** — sub-worker 가 한 일이 *환경 안에 영속적으로 존재*
  해야 한다. invoke 가 끝나면 휘발되는 `ExecutionResult` 는 환경이
  아니라 일시적 변수다.
* **도구 층** — VTuber 의 environment manifest 가 *그 영속 데이터를
  들여다 볼 read-only 도구들을 platform tool 로 노출* 해야 한다.

### 2.2 능동적 탐색

VTuber 는 *질문을 받았을 때* 도구를 호출해 정보를 가져온다. 매 turn
prompt 에 박혀 있어서 그냥 보는 것과는 다르다. 비-호출 turn 은
토큰 비용 0. 도구 호출이 일어나는 turn 만 비용을 낸다.

### 2.3 Progressive disclosure — 사다리형 도구 API

| 깊이 | 도구 | 페이로드 크기 | 호출자가 결정해야 할 것 |
|---|---|---|---|
| L0 (overview) | `worker_status` | 한 줄 | 더 알아볼 가치가 있는가? |
| L1 (list) | `worker_recent_runs(limit)` | run 메타 N개 (≤ ~1KB/개) | 어떤 run 을 자세히 볼까? |
| L2 (detail) | `worker_run_detail(run_id)` | 한 run 의 모든 도구 호출 + 결과 요약 | 특정 artifact 본문이 필요한가? |
| L3 (artifact) | `worker_read_artifact(path)` | 파일 본문 (size cap) | — |
| 보조 | `worker_workspace_changes(since_run_id?)` | 파일시스템 변경 list | — |
| 보조 | `worker_run_search(query)` | 의미/키워드 검색 결과 | — |

핵심: **도구 description 만으로 LLM 이 위 사다리를 자연스럽게 따라
가도록** 설계한다. 각 도구의 결과 schema 는 다음 도구 호출의 인자
(`run_id`, `path`) 를 포함한다 — chained navigation 의 affordance.

각 도구는:
* paired-only (caller 의 `_linked_session_id == target` 한정)
* read-only (mutation 0)
* 결과는 LLM-friendly 짧은 JSON
* description 은 *언제 호출할지* 를 명시 (e.g. "사용자가 sub-worker 의
  최근 활동을 물어보면 가장 먼저 호출하라")

### 2.4 시스템 프롬프트는 *catalog 사용 가이드만*, 데이터 inject 금지

`vtuber.md` 에 추가되는 텍스트는 *"이런 도구가 있으니 이 순서로
호출하라"* 한 단락뿐. 사용자/세션별 동적 데이터는 단 한 byte 도
주입하지 않는다. 그건 도구가 호출되었을 때 *결과로* 전달되어야
한다.

## 3. 데이터 흐름 — 재설계 후

```
Sub-Worker invoke 종료
   │
   │  service/execution/agent_executor.py:_execute_core
   ▼
ExecutionResult { tool_calls, duration_ms, cost_usd, ... }
   │
   │  새 모듈: service/execution/subworker_run.py
   ▼
SubWorkerRun DTO (정규화: files_written / bash_calls / web_calls / ...)
   │
   ▼
영속 저장: <pair_storage>/subworker_runs.jsonl (append-only)
   ※ pair_storage = paired (vtuber, sub) 가 공유하는 namespace.
     owner_storage 산하의 별도 디렉터리.

────── (여기까지 환경 구축) ──────

[VTuber turn — 사용자가 "워커가 뭐 했어?" 물음]
   │
   ▼
LLM 추론 → tool_use: worker_status()
   │
   ▼  worker_status (L0)
   │   - paired sub-worker 의 _is_executing
   │   - 가장 최근 SubWorkerRun 의 한 줄 (status / summary)
   │   - run_id 동봉
   │
   ▼  LLM 이 "더 자세히 보고 싶다" 결정
   ▼
tool_use: worker_recent_runs(limit=3) (L1)
   │   - 최근 3개 run meta (run_id, started_at, status, duration, tools_used 카운트)
   │
   ▼  LLM 이 "이 run 자세히" 결정
   ▼
tool_use: worker_run_detail(run_id="...") (L2)
   │   - 그 run 의 모든 도구 호출 + 인자 preview + 결과 요약
   │   - 파일 변경 list (path 포함)
   │
   ▼  LLM 이 "파일 본문이 필요" 결정
   ▼
tool_use: worker_read_artifact(path="notes.md") (L3)
   │   - 파일 본문 (size cap)
   │
   ▼
LLM 이 사용자에게 paraphrase 답변
```

이 흐름의 모든 turn 에서 *VTuber 가 호출하지 않으면 정보는 들어오지
않는다*. 시스템 프롬프트는 변동 없음. 토큰 비용은 호출이 일어난
turn 에만 부담. 그리고 같은 정보를 *원하지 않는* turn 은 영향
받지 않는다.

## 4. 보안 / 스코프 정책

| 항목 | 정책 |
|---|---|
| 도구 caller | VTuber persona (paired) 한정 |
| 도구 target | caller 의 `_linked_session_id` 와 동일한 sub-worker 만 |
| 페어 외 세션 | 모든 도구가 `permission denied` 류 에러 반환 |
| 파일 읽기 범위 | sub-worker 의 `working_dir` ∪ shared folder 안만. path traversal (`..`) 차단. 절대경로 거부. |
| 사이즈 cap | artifact 도구 64KB / search 결과 5건 / detail 도구 도구 호출 100개 등 명시적 상한 |
| Mutation | 모든 도구 read-only. 도구 매니페스트의 `CAPABILITIES` 에 `read_only=True, idempotent=True, concurrency_safe=True` 마크 |
| Race | sub-worker 가 invoke 중일 때도 read 안전. jsonl 은 append-only 이므로 in-flight run 은 *이전 완료 run 만* 보임 |

## 5. 우선순위 재배치

01 문서의 우선순위를 폐기하고 다음으로 대체한다.

### F1 — `SubWorkerRun` DTO + 영구 저장 ★ 첫 단계

* `service/execution/subworker_run.py` 신설
* `ExecutionResult.tool_calls` 를 카테고리화 (`files_written`,
  `files_read`, `bash_commands`, `web_fetches`, `errors`, ...)
* paired pair 의 공유 jsonl 에 append. 단일 파일이라 schema 변경
  비용도 작다.
* 호출 hook: `_notify_linked_vtuber` 진입 직전 (sub-worker 종료
  시점). suppression 분기와 무관하게 *기록은 항상 일어남*.

### T1 — `worker_status` ★ L0 진입점

* paired sub-worker 의 현재 실행 상태 + 가장 최근 SubWorkerRun 의
  한 줄. 도구 호출 비용 가장 작음. 거의 모든 "워커 뭐 해?" 질문의
  첫 contact 도구.

### T2 — `worker_recent_runs(limit)`

* 최근 N개 (default 5, max 20) run meta. `run_id` 포함. T3 의 입력
  affordance.

### T3 — `worker_run_detail(run_id)`

* 한 run 의 도구 호출 list (이름 + 인자 preview + 결과 요약 +
  duration + is_error). artifact path 포함.

### T4 — `worker_read_artifact(path)`

* sub-worker 가 만든 파일 read-only. size cap 64KB. path traversal 차단.

### T5 — `worker_workspace_changes(since_run_id?)`

* 파일시스템 walk. mtime 정렬. T3 의 artifact 외 파일 (Bash 가 만든
  파일 등) 까지 잡힘.

### T6 — `worker_run_search(query)` (P3)

* SubWorkerRun jsonl 에서 의미/키워드 검색. 시간이 지난 run 의
  retrospective lookup.

### C1 — `vtuber.md` 의 짧은 사다리 가이드

```
## Inspecting Your Sub-Worker

When the user asks about what your Sub-Worker did:
1. Start with `worker_status` — one-line current state.
2. If they want more, fall through `worker_recent_runs` →
   `worker_run_detail` → `worker_read_artifact`.
3. Never speculate; if you don't know, just call the tool.
```

이게 진정한 *catalog 안내* 다. 데이터 1byte 도 미주입.

## 6. 폐기되는 것

| 01 문서의 후보 | 폐기 사유 |
|---|---|
| **P0-A** (`<sub-worker-last-run>` 자동 inject) | prompt inject — 능동적 탐색 X |
| **P0-B** (STM 자동 기록) | 우회된 prompt inject — passive accumulation |
| **P3-B** (vector index 공유) | 이전 문서에서도 비추천. 그대로 폐기. |

01 문서의 나머지 후보 (P1-A worker_recent_activity / P1-B
workspace_diff / P1-C worker.md narrative / P2-A DTO / P2-B EventBus
progress / P3-A KB auto-promote) 는 *재구성된 사다리에 흡수*
된다 — 위 F1 / T1~T6 / C1 가 그것이다.

## 7. 예상 효과

* 사용자가 *물었을 때만* 비용 발생. 기본 turn 은 토큰 부담 0.
* VTuber 의 "내가 모르면 도구를 호출하면 된다" 라는 *능동성* 이
  prompt 측 강요 없이 자연스럽게 형성된다. 도구 description 의
  affordance 만으로.
* 깊이 있는 질문 (특정 run 의 Bash 결과, 특정 파일 본문) 까지 같은
  사다리로 답할 수 있다. 01 문서의 자동 inject 안은 *최신 한 번* 만
  보여 줄 수 있었다.
* paired-only 도구 ecosystem 이라 페르소나 / 권한 / 세션 격리가
  명확. 새 도구가 추가될 때마다 같은 패턴을 따른다.

## 8. 다음 단계

[`plan/cycle_plan.md`](../plan/cycle_plan.md) 에 PR ladder 와 각
PR 의 변경 범위 / 테스트 / 위험을 구체화했다.
