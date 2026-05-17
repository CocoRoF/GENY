# PR E5 — feat(scripts): migrate stored manifests to config['provider']

| 항목 | 값 |
|---|---|
| Repo | `Geny` |
| Branch | `feat/llm-backend/e5-reseed` (deleted) |
| Base SHA | `ee464eb` |
| PR # | [#778](https://github.com/CocoRoF/Geny/pull/778) |
| Merge SHA | `6f322ab` |
| Status | **merged** |

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
