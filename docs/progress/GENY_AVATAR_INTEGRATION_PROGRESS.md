# geny-avatar Integration — Progress Log

상응하는 plan: [`docs/plan/GENY_AVATAR_INTEGRATION.md`](../plan/GENY_AVATAR_INTEGRATION.md).

각 atomic PR 단위로 한 섹션. 위에서 아래로 시간순. 단 sprint 가 atomic 이라 PR 별 검증이 다음 진입의 필요조건.

---

## Phase A — geny-avatar 레포 (외부)

[geny-avatar v0.2.0](https://github.com/CocoRoF/geny-avatar/releases/tag/v0.2.0) 로 종결. Phase A 의 5 sprint 는 본 레포 밖 (geny-avatar 의 docs/progress) 에 기록되어 있음.

| Sprint | 산출 |
|---|---|
| A.1 | Dockerfile (3-stage standalone) + `output:"standalone"` |
| A.2 | `NEXT_PUBLIC_BASE_PATH` env-driven basePath/assetPrefix + `apiUrl()` |
| A.3 | ExportButton "send to Geny" + `/api/send-to-geny` route |
| A.4 | README "Geny 통합" 섹션 |
| A.5 | v0.2.0 bump + git tag |

---

## Phase B — Geny infra

### B.1 — submodule add + v0.2.0 pin

`vendor/geny-avatar` 에 geny-avatar 레포 submodule 등록, `v0.2.0` 태그에 pin.

**변경**:

- `.gitmodules` — 새 entry (`vendor/geny-avatar` → `https://github.com/CocoRoF/geny-avatar`). 기존 `frontend/public/assets/pixymoon` entry 무손상.
- `vendor/geny-avatar` — submodule 디렉터리 (HEAD = `aa1de59`, tag `v0.2.0`).

**검증**:

- `git submodule status` 가 `vendor/geny-avatar (v0.2.0)` 정상 표시.
- 본 commit 이후 fresh clone 시: `git clone --recurse-submodules <Geny-url>` 또는 기존 clone 에서 `git submodule update --init --recursive` 한 번이면 동기화.

**의도적 한계**:

- **submodule branch tracking 안 함**: `branch = main` 명시 안 함 — commit pinning 만. 향후 geny-avatar 가 v0.3.0 등 새 tag 부여하면 명시적으로 `cd vendor/geny-avatar && git fetch --tags && git checkout v0.3.0 && cd ../.. && git commit ...` 시퀀스로 갱신.
- **shallow clone X**: 현재 geny-avatar 가 작아서 (~5MB) full history 그대로. 향후 size 부담 시 shallow 로 전환.

**다음**: B.2 — `docker-compose.yml` 에 `avatar-editor` service block 추가.
