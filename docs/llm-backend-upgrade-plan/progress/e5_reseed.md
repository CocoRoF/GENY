# PR E5 — feat(scripts): migrate stored manifests to config['provider']

> ⚠️ **이 PR은 잘못된 결정이었음. 곧바로 revert됨.**
>
> Cycle 시작 시 사용자가 명시: *"마이그레이션이나 하위 호환성 고려할 필요 없이 그냥 제대로 만들면 되는거야"* (clean break, 서비스 안 됨).
> Plan 문서 (00_overview.md, README.md)도 그 기준으로 작성됨.
> 그런데 본 PR이 그 결정을 무시하고 migrator를 만들어버림 — 존재 이유가 없는 PR이었음.
>
> 정정 PR로 revert. 기존 manifest는 재시드하지 않아도 됨; 사용자가 새 환경을 만들거나 기존 환경의 stage 6 provider를 UI에서 다시 저장하면 새 위치 (`config["provider"]`)로 자동 정리됨.

| 항목 | 값 |
|---|---|
| Repo | `Geny` |
| Branch | `feat/llm-backend/e5-reseed` (deleted) |
| Base SHA | `ee464eb` |
| PR # | [#778](https://github.com/CocoRoF/Geny/pull/778) |
| Merge SHA | `6f322ab` |
| Status | **reverted** (정정 PR에서 revert) |

## 변경

- `scripts/migrate_manifests_provider_location.py` (NEW): 저장된 environment manifest를 walk하면서 `strategies['provider']` → `config['provider']` lift. Idempotent. Dry-run 기본; `--apply`로 실제 변경.
- 활성 stage 6에 provider가 어디에도 없으면 `"anthropic"` default 주입.

## 운영 절차

```bash
cd backend
python -m scripts.migrate_manifests_provider_location           # dry-run
python -m scripts.migrate_manifests_provider_location --apply   # write
```

executor 2.0.0 pin 직후 한 번 실행. 이후엔 default_manifest와 strict validator가 새 shape을 강제하므로 no-op.
