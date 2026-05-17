# PR D3 — feat(pipeline): subagent_registry slot + credential propagation

| 항목 | 값 |
|---|---|
| Repo | `geny-executor` |
| Branch | `feat/llm-backend/d3-pipeline-subagent` (deleted) |
| Base SHA | `85b226d` |
| PR # | [#201](https://github.com/CocoRoF/geny-executor/pull/201) |
| Merge SHA | `2a41f53` |
| Status | **merged** |

## 변경

- `Pipeline._subagent_registry` 슬롯. `from_manifest{,_async}(subagent_registry=)` + `attach_runtime(subagent_registry=)` 둘 다 지원.
- `_wire_subagent_orchestrator(registry)` — agent stage의 orchestrator를 `SubagentTypeOrchestrator(registry)`로 rebuild.
- `PipelineState.subagent_registry` 슬롯, `_init_state`에서 propagate.
- 8 신규 케이스 (slots / propagation / 팩토리가 parent 자격증명 보기 / 실제 sub-pipeline 빌드 검증).

## 검증

3229 passed.
