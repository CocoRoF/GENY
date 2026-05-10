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

### B.6 — README 통합 가이드

Phase B 마무리. 두 군데 변경:

**변경**:

- `README.md` Installation 섹션의 clone 단계
  - `git clone ...` → `git clone --recurse-submodules ...`
  - 이미 clone 한 경우 fallback 으로 `git submodule update --init --recursive` 한 줄.
- `README.md` Tech Stack 와 Installation 사이에 신규 "Avatar Editor (geny-avatar)" 섹션
  - 한 단락 요약 (역할, 핵심 가치, `(Editor)` 접미사 비충돌).
  - **Pinned version** 노트 — 본 레포가 명시적 commit 만 받음 + 갱신 절차.
  - **Topology** 표 — 5 compose 파일의 접근 경로 정리 (host port 3001 vs nginx /avatar-editor/).
  - **Data path** 한 줄 — 공유 volume 사양.
  - **AVATAR_EDITOR_PORT** override 예제.
  - plan + progress 문서로 외부 링크.

**검증**:

- 마크다운 syntax (표 / 링크 / 코드 블록) 시각 확인.

**의도적 한계**:

- **README 의 "Architecture" 섹션 ASCII diagram 안 갱신**: avatar-editor 가 그림에 안 들어감. plan 문서에 이미 ASCII diagram 있어 중복 회피.
- **Manual Setup 섹션 무손상**: avatar-editor 는 docker compose 전용 — manual setup 가이드에는 nothing. `cd vendor/geny-avatar && pnpm dev` 는 사용자가 직접.

## Phase B 종합 (6 sprint)

| Sprint | 산출 |
|---|---|
| B.1 | `vendor/geny-avatar` submodule pin (v0.2.1 hotfix 후 갱신) |
| B.2 | `docker-compose.yml` (standalone full, host port) |
| B.3 | `docker-compose.dev.yml` (dev) |
| B.4 | `docker-compose.dev-core.yml` + 두 prod 변형 (nginx 뒤 internal) |
| B.5 | `nginx/nginx.conf` 의 `/avatar-editor/` location |
| B.6 | README 의 "Avatar Editor (geny-avatar)" 섹션 + clone --recurse-submodules |

Phase B 완료 — infra 측면의 모든 wiring 끝. 이제 backend 가 공유 volume 의 zip 을 읽어서 install 하는 endpoint (Phase C) 와 frontend 의 모델 선택 / 렌더 (Phase D) 가 남음.

---

## 사용자 보고 — `docker compose build` 실패 (Pixi v8 SSR navigator)

Phase B 완료 후 사용자가 `docker compose -f docker-compose.dev.yml up --build` 실행 시 `avatar-editor` 의 builder stage 가 `/poc/spine` 정적 prerender 단계에서 `ReferenceError: navigator is not defined` 로 죽음.

**원인**: A.1 의 Dockerfile 이 `node:20-alpine` 사용. Pixi v8 가 module init 에 `globalThis.navigator.userAgent` 를 read 하는데, 이 글로벌은 Node 21+ 부터 추가됨. 내 로컬 host (Node 24) 에서 `pnpm build` 통과해서 발견 못 했음.

**조치**:

- geny-avatar 측에서 [v0.2.2 hotfix](https://github.com/CocoRoF/geny-avatar/releases/tag/v0.2.2) → 3 stage 모두 `node:22-alpine` (LTS) 으로 bump + 향후 누군가 다시 20 으로 내리지 않도록 코멘트.
- Geny 측 submodule pin: `vendor/geny-avatar` v0.2.1 → v0.2.2.
- `README.md` 의 pinned version 표기도 `v0.2.2` 로 갱신.

**검증 (사용자 측 권장)**:

```bash
git submodule update --init --recursive
docker compose -f docker-compose.dev.yml build avatar-editor
# → /poc/spine prerender 통과해야 정상
```

---

## Phase C — backend import 흐름

### C.1 — model_registry 마이그레이션 (`runtime` 필드)

베이크된 puppet 이 Live2D 일 수도 Spine 일 수도 있어, 모든 엔트리가 어느 런타임용인지 self-describe 해야 함. 기존 9개 모델 (전부 Live2D) 무손상 전환 + 신규 코드 패스가 새 필드 의식.

**변경**:

- `backend/static/live2d-models/model_registry.json`
  - top-level `"schema_version": 2` 추가 (이전 = implicit v1).
  - 9 엔트리 각각에 `"runtime": "live2d"` 추가.
  - 다른 필드 / 순서 / 한국어 인코딩 무손상.
- `backend/service/vtuber/live2d_model_manager.py`
  - `Live2dModelInfo` 에 `runtime: str = "live2d"` + `atlas_url: Optional[str] = None` 두 필드 추가 (둘 다 디폴트 → 기존 호출 무손상).
  - `to_dict()` 가 두 신규 필드 포함.
  - `_load_registry()` 가 `model_data.get("runtime", "live2d")` 로 pre-v2 fallback. log 가 `[live2d]` chip 표기.
  - 클래스 docstring — 이름은 historical 이고 이제 Spine 도 같이 관리한다는 점 명시. rename 보류 사유도 (~10 호출처 ripple, 본 PR 의 blocker 아님).
- `Live2dModelInfo` docstring — schema_version 의미 + pre-v2 동작 명시.

**검증**:

- 격리 smoke test: `python3 -c "from service.vtuber.live2d_model_manager import Live2dModelManager; ..."` → 9 entries load, runtime/atlas 필드 정확, to_dict 키 17개 (이전 13 + runtime + atlas_url + ...).
- 기존 호출 사이트 (`request.app.state.live2d_model_manager`) 인터페이스 무변경 → 회귀 가능성 낮음.

**의도적 한계**:

- **클래스 / 매니저 변수명 rename X**: `live2d_model_manager` 가 9개 호출 사이트. 본 sprint 는 데이터 모델 변경만, 명명은 후속 (필요 시 D phase 에서 한 번에).
- **frontend 미반영**: API 가 새 필드 보내지만 frontend 가 아직 안 읽음. Phase D 에서 dispatcher (`AvatarCanvas`) 가 이 필드 기준으로 SpineCanvas vs Live2DCanvas 선택.
- **migration script X**: 영구 `model_registry.json` 한 번 수정 + 코드의 fallback 으로 충분. 9개 엔트리 한 번 손볼 일.
- **runtime enum 검증 X**: `"live2d"` / `"spine"` 외의 값을 받으면 그냥 reject 안 하고 entry 유지. Phase C 후속에서 install endpoint 가 accepted set 검증.

**다음**: C.2 — baked-imports controller (list / delete pending zip).
