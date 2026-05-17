# PR F1 — feat(frontend): extend modelCatalog to 6 providers

| 항목 | 값 |
|---|---|
| Repo | `Geny` |
| Branch | `feat/llm-backend/f1-frontend-catalog` (deleted) |
| Base SHA | `6f322ab` |
| PR # | [#779](https://github.com/CocoRoF/Geny/pull/779) |
| Merge SHA | `160d9f9` |
| Status | **merged** |

## 변경

- `ProviderId` union: 4 → 6 (`claude_code_cli`, `copilot_cli` 추가).
- `ProviderKind = 'api' | 'cli'` + `installHelp` 필드.
- `MODEL_CATALOG` CLI 로스터 추가.
- `PROVIDER_DEFAULT_MODEL` 6 provider 모두.
- `PROVIDER_CAPABILITY_HINTS` — capability badge 데이터 (CLI 미지원 기능도 명시).

## 검증

`npx tsc --noEmit` — 신규 에러 0.
