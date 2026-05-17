# PR E3 — refactor(manifest): Stage 6 provider at config['provider'] + real sub-agent factory

| 항목 | 값 |
|---|---|
| Repo | `Geny` |
| Branch | `feat/llm-backend/e3-default-manifest` (deleted) |
| Base SHA | `27dc25b` |
| PR # | [#776](https://github.com/CocoRoF/Geny/pull/776) |
| Merge SHA | `f87e8c2` |
| Status | **merged** |

## 변경

- default_manifest.py: worker + vtuber preset의 stage 6 provider를 `config={"provider": "anthropic"}` 로 이동. `strategies`에서 provider 키 제거.
- 두 preset 모두 stage 12 orchestrator를 `subagent_type`으로 활성화.
- `service/agent_types/factories.py` (NEW): `_default_subagent_factory(ctx)`. ctx.descriptor.provider + ctx.credentials → 11-stage sub-pipeline. Nested sub-agent 차단.
- `service/agent_types/registry.py`: 신규 factory를 5개 seed descriptor에 주입. 모두 v2.0.0 `provider=` 필드 채움.

## End-to-end 흐름 확립

descriptor.provider → factory(ctx) → from_manifest(credentials=ctx.credentials, sub_manifest with patched stage 6) → 실제 sub-pipeline 호출 → 다른 provider 사용 가능.
