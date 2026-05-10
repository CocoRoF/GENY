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

### B.2 — `docker-compose.yml` (standalone full)

본 파일은 `nginx` 가 없는 stack — avatar-editor 가 host port 직접 노출 (`AVATAR_EDITOR_PORT` 디폴트 3001).

**변경**:

- `avatar-editor` service block 신규 (line 213 부근)
  - build context `./vendor/geny-avatar` (B.1 의 submodule path)
  - port `127.0.0.1:${AVATAR_EDITOR_PORT:-3001}:3000`
  - env: `NEXT_PUBLIC_BASE_PATH=` (빈 문자열, root mount), `NEXT_PUBLIC_GENY_HOST=true`, `GENY_BAKED_EXPORTS_DIR=/exports`, `PORT=3000`, `HOSTNAME=0.0.0.0`, `NODE_ENV=production`
  - volume: `geny-baked-exports:/exports` (write side)
  - healthcheck: `wget --spider http://localhost:3000/` (alpine 이미지의 wget 사용 — geny-avatar 의 standalone 베이스에 curl 없음)
  - networks: `geny-net`
  - depends_on 없음 — backend 와 직접 HTTP 통신 안 하고 volume 만 공유.
- `backend` 서비스의 volumes 에 `geny-baked-exports:/data/baked-imports:ro` 추가 (read side)
- top-level volumes 에 `geny-baked-exports` 정의

**검증**:

- `docker compose -f docker-compose.yml config --quiet` 정상 (YAML/schema 검증 통과)
- 파싱된 service 가 의도대로 — port mapping `127.0.0.1:3001:3000`, env 들 정확히 inline, volume mount 양방향 (avatar-editor rw / backend ro).
- `docker compose up` 자체는 sandbox 환경 제약으로 미실행 — 사용자가 로컬에서 검증 필요.

**의도적 한계**:

- **healthcheck 가 wget**: alpine + Next.js standalone 이미지에 curl 없음. wget --spider 로 root 페이지 GET 요청. /api/health 같은 전용 endpoint geny-avatar 측에 없어 root 사용.
- **start_period 30s**: standalone server.js 첫 부팅이 5~10s. 30s 면 충분한 마진. 첫 build 가 너무 느리면 늘려야 함.
- **submodule 미초기화 시 build 실패**: 사용자가 `git submodule update --init --recursive` 누락하면 `./vendor/geny-avatar` 가 빈 dir → docker build 가 Dockerfile 못 찾음 → 명시적 에러. 이건 의도 — silent fallback 보다 명확한 실패가 좋음. README (B.6) 에 대처 가이드.

**다음**: B.3 — `docker-compose.dev.yml` 에 동일 패턴 적용 (단, dev 는 hot-reload 가 의미 있는지 별도 결정).

### B.3 — `docker-compose.dev.yml`

dev compose 도 동일한 standalone 빌드를 그대로 사용. **hot-reload 안 함** — `vendor/geny-avatar` 는 pinned submodule 이라 사용자가 dev 모드에서 그 안을 직접 편집할 일이 없음 (편집한다면 geny-avatar 레포 자체에서 해야 함). 컨테이너 / 볼륨 이름은 `-dev` 접미사로 standalone 과 병행 실행 가능.

**변경**:

- `avatar-editor` service block 신규 (B.2 와 거의 동일, container_name `geny-avatar-editor-dev` + volume `geny-baked-exports-dev` + network `geny-net-dev`).
- `backend` 의 volumes 에 `geny-baked-exports-dev:/data/baked-imports:ro` 추가.
- top-level volumes 에 `geny-baked-exports-dev`.

**검증**: `docker compose -f docker-compose.dev.yml config --quiet` 통과.

**의도적 한계**:

- **hot-reload X**: 위 설명. 사용자가 geny-avatar 측을 디벨롭하려면 별도로 `cd vendor/geny-avatar && pnpm dev` 로 띄우고 (host 의 다른 port), Geny 의 dev compose 의 avatar-editor 는 끄거나 ignore. 굳이 docker 안에서 hot-reload 시뮬레이션 필요시 후속.
- **dev 와 standalone 의 host port 같음**: 둘 다 `${AVATAR_EDITOR_PORT:-3001}:3000`. 동시에 띄우면 포트 충돌. dev/prod 동시 실행은 일반적이지 않으니 OK — 필요 시 user 가 env 로 override.

**다음**: B.4 — `docker-compose.dev-core.yml` + `docker-compose.prod.yml` + `docker-compose.prod-core.yml` 3 파일 동시 적용.

### B.4 — dev-core / prod / prod-core 3 compose 파일 + submodule v0.2.1 hotfix

prod 변형들이 nginx 뒤에서 `/avatar-editor` prefix 로 mount 되도록 작성. 작업 중 발견된 A.1 누락 (build args ARG 선언 X) 을 geny-avatar 측 hotfix [v0.2.1](https://github.com/CocoRoF/geny-avatar/releases/tag/v0.2.1) 으로 즉시 해결 + Geny submodule pin 갱신.

**변경**:

- `vendor/geny-avatar` submodule pin: `aa1de59` (v0.2.0) → `8154709` (v0.2.1).
- `docker-compose.dev-core.yml` — dev 와 동일한 service block (host port 3001, basePath 빈 문자열, `geny-baked-exports-dev` 공유). backend 의 RO mount 추가. 볼륨 정의 추가.
- `docker-compose.prod.yml` — prod 변형:
  - `expose: 3000` (host 포트 X — nginx 만 접근).
  - `build.args.NEXT_PUBLIC_BASE_PATH=/avatar-editor` (build time inline 보장 — v0.2.1 hotfix 의 ARG 가 받아줌).
  - 환경 변수에도 `NEXT_PUBLIC_BASE_PATH=/avatar-editor` (정합성 — runtime 에 같은 값 보임).
  - 컨테이너 / 볼륨 이름 `-prod` 접미사.
  - healthcheck 가 `/avatar-editor/` 로 wget — basePath 가 root 를 404 로 만드므로 prefix 경로로 확인.
  - nginx 의 `depends_on` 에 `avatar-editor: service_started` 추가.
- `docker-compose.prod-core.yml` — prod 와 동일.

**검증**:

- `docker compose -f docker-compose.dev-core.yml config --quiet` 통과
- `docker compose -f docker-compose.prod.yml config --quiet` 통과
- `docker compose -f docker-compose.prod-core.yml config --quiet` 통과
- 5 compose 파일 모두 `avatar-editor` service + `geny-baked-exports-{dev,prod}` 볼륨 양면 mount + 적절한 network 정합성.

**의도적 한계**:

- **prod 의 build args 와 environment 중복**: `NEXT_PUBLIC_BASE_PATH` 가 build time 과 runtime 양쪽에 같은 값으로 들어감. build time 만으로 충분하지만 runtime ENV 로도 두는 게 디버깅 시 컨테이너 안에서 echo 확인 가능 — 일치 invariant 만 지키면 됨.
- **dev / prod healthcheck path 차이**: dev/standalone 은 `/`, prod 는 `/avatar-editor/`. basePath 차이 때문 — 같은 명령으로 통일 못 함. compose 별로 명시.
- **B.5 까지 nginx 라우팅 X**: prod 변형은 service 가 떠도 외부에서 접근 안 됨 (nginx 의 location 블록이 없으니). B.5 (다음) 가 그걸 추가하면 비로소 end-to-end 동작.

**다음**: B.5 — `nginx/nginx.conf` 에 `/avatar-editor/` location 블록 추가.

### B.5 — nginx `/avatar-editor/` 리버스 프록시

prod 변형의 마지막 퍼즐. avatar-editor 가 docker 내부 (geny-net-prod) 에서 떠 있어도, nginx 의 location 블록 없이는 외부에서 접근 불가. 이걸 추가하면 사용자가 동일 origin (`http://geny/avatar-editor/`) 으로 진입.

**변경**:

- `nginx/nginx.conf`
  - 새 upstream: `upstream avatar_editor { server avatar-editor:3000; }`
  - 새 location 블록 (catch-all `location /` 직전):
    ```
    location /avatar-editor/ {
        proxy_pass http://avatar_editor;   # NO trailing slash → preserves URI
        ...
        client_max_body_size 100m;          # baked zip POST 여유
        proxy_set_header Upgrade ...;
        proxy_read_timeout 60s;
    }
    ```

**핵심 디테일**:

- `proxy_pass http://avatar_editor;` — trailing slash **없음**. 이게 핵심. avatar-editor 는 `NEXT_PUBLIC_BASE_PATH=/avatar-editor` 로 빌드되어 upstream 자체가 `/avatar-editor/...` URI 를 기대. trailing slash 가 있으면 nginx 가 prefix 를 자동으로 strip → upstream 이 `/...` (root) 으로 받음 → 404.
- `client_max_body_size 100m`: 글로벌 50m 보다 큼. baked atlas zip 이 30~50MB 일 수 있어 `/api/send-to-geny` POST 에 여유.
- `proxy_read_timeout 60s`: standalone 첫 부팅이 5~10s. 디폴트 60s 내라서 명시 안 해도 되지만 명시적으로 둠.
- WebSocket upgrade headers: Next.js prod 가 일반적으로 안 쓰지만 future-proofing.

**검증**:

- `docker compose -f docker-compose.prod{,-core}.yml config --quiet` 통과 (nginx volume mount 정상 인식).
- `nginx -t` 직접 검증은 docker socket 제약으로 불가. 사용자가 로컬에서 `docker compose -f docker-compose.prod.yml up nginx avatar-editor backend frontend postgres` 로 띄워서 `curl http://localhost:58443/avatar-editor/` 200 응답 확인 권장.

**의도적 한계**:

- **`/avatar-editor` (no trailing slash) → 308 redirect**: nginx 디폴트 동작. `/avatar-editor/` 로 redirect 해주면 충분 (Next.js 와도 정합).
- **dev / dev-core nginx 미배포**: dev 변형은 nginx service 자체가 없어서 (B.2/B.3) avatar-editor 가 host port 3001 직접. 본 nginx.conf 변경은 prod 만 영향.
- **HTTPS 미적용**: nginx 가 80 만 listen. TLS 는 Geny 의 별도 책임 (외부 LB / cloudflare 등). 본 통합 sprint 범위 X.

**다음**: B.6 — README 업데이트 (avatar-editor service 셋업 + submodule init 가이드).
