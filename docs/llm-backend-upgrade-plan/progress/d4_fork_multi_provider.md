# PR D4 — refactor(skills/fork): multi-provider via CredentialBundle + CHANGELOG addendum

| 항목 | 값 |
|---|---|
| Repo | `geny-executor` |
| Branch | `feat/llm-backend/d4-fork-multi-provider` (deleted) |
| Base SHA | `2a41f53` |
| PR # | [#202](https://github.com/CocoRoF/geny-executor/pull/202) |
| Merge SHA | `1aa13d8` |
| Status | **merged** |

## 변경

- `SkillMetadata.provider: Optional[str]` 추가.
- `make_credential_bundle_fork_runner(credentials, ...)` (NEW) — 모든 6 provider 지원.
- 항상 runner 반환; 자격증명 누락 시 `ForkResult(is_error=True)` 구조화 에러.
- `_creds_to_client_kwargs` 공유 (pipeline 경로와 동일).
- 6 신규 케이스.
- CHANGELOG v2.0.0 entry에 "Multi-provider sub-agent system" 섹션 + 새 runner / state slots / attach_runtime kwarg 문서화.

## 검증

3235 passed.

## Phase D 완료

| Phase | PR | Merge SHA | 테스트 누적 |
|---|---|---|---|
| D1 | #199 | d592273 | 3214 |
| D2 | #200 | 85b226d | 3221 |
| D3 | #201 | 2a41f53 | 3229 |
| D4 | #202 | 1aa13d8 | 3235 |

Phase A+B+C+D = **12 executor PR + 1 Geny plan PR = 13 PRs** 누적. v2.0.0 코드 완료, PyPI 배포 직전.
