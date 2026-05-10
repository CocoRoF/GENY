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

### C.2 — baked-imports controller (list + delete)

avatar-editor 가 공유 volume 에 떨어뜨린 zip 들의 inbox view. install (다음 sprint) 의 직전 단계 — 사용자가 무엇이 들어왔는지 보고 잘못 보낸 건 미리 버릴 수 있게.

**변경**:

- `backend/controller/vtuber_baked_imports_controller.py` (신규)
  - `GET /api/vtuber/baked-imports/list` — `GENY_BAKED_IMPORTS_DIR` (default `/data/baked-imports`) 의 `.zip` 들 enumerate.
    - 각 entry: `filename`, `size_bytes`, `modified_iso` (UTC), `runtime`, `suggested_name`, `schema_version`.
    - 후자 3개는 zip 안의 `avatar-editor.json` 을 read-only peek 해서 채움 (없으면 None — 견고).
    - mtime 내림차순 정렬 (최근 것 위).
  - `DELETE /api/vtuber/baked-imports/{filename}` — 단일 zip 삭제.
    - `_is_safe_filename()` — `..`, `/`, `\`, `\0`, leading dot, 공백 전부 reject (path traversal 방지).
    - `.zip` 확장자 강제.
    - read-only mount (compose 의 `:ro`) 일 때 친절한 에러 메시지.
- `backend/main.py`
  - `from controller.vtuber_baked_imports_controller import router as vtuber_baked_imports_router` (신규 import).
  - `app.include_router(vtuber_baked_imports_router)` 추가 (vtuber_router 직후).

**검증**:

- 격리 smoke test (venv python):
  - 임시 inbox + 합성 zip (`avatar-editor.json` 포함 metadata)
  - list → entry 의 runtime/suggested_name/schema_version 정확.
  - 5개 unsafe filename (`../etc/passwd`, `/abs/path`, `..`, `.hidden.zip`, ``) 모두 400 reject.
  - delete → 파일 사라지고 list 비어있음.
- 라우터 inspect: `[({'GET'}, '/api/vtuber/baked-imports/list'), ({'DELETE'}, '/api/vtuber/baked-imports/{filename}')]` 정확.
- `main.py` 의 `app.routes` 에 라우터 통합되는 것은 docker 컨테이너 내 검증이 자연스러움 (venv 의 jinja2 미설치로 로컬 import 부분 실패 — 무관).

**의도적 한계**:

- **install endpoint 분리**: list/delete 만. 실제 install (unzip + register) 은 C.3.
- **inbox watch 안 함**: poll 모델 — 사용자가 새로고침. inotify / sse 같은 push 는 후속.
- **zip peek 깊이 얕음**: `avatar-editor.json` 만 읽음. atlas 미리보기 / 썸네일 추출은 install 단계 또는 후속.
- **여러 inbox 디렉터리 X**: 하나의 env (`GENY_BAKED_IMPORTS_DIR`) 만. 다중 source 시나리오 없음.
- **delete bulk X**: 한 번에 하나씩만. UI 에서 loop 으로 충분.

**다음**: C.3 — `POST /api/vtuber/baked-imports/install` — unzip → static/{live2d,spine}-models/ → model_registry append (자동 `(Editor)` suffix).

### C.3 — install endpoint (+ spine static dir + 5 compose mount flip = C.4 흡수)

baked zip 을 한 번의 클릭으로 `model_registry.json` 에 등록 + 정적 dir 에 펼쳐서 즉시 선택 가능하게. 그 과정에서 두 인접 sprint (C.4 spine 정적 dir / 마운트 모드 변경) 함께 처리.

**변경**:

- `backend/service/vtuber/live2d_model_manager.py`
  - `reload()` — 디스크에서 다시 읽기, agent_assignments 보존.
  - `add_model(info, persist=True)` — in-memory 등록 + JSON append (rmw 한 번). 중복 name 시 ValueError.
  - `_persist_append()` — 부재한 registry 도 v2 minimal doc 으로 부트스트랩.
- `backend/controller/vtuber_baked_imports_controller.py`
  - 새 `POST /install` endpoint — `{filename, display_name_override?}`.
  - **흐름**: filename 안전성 → zip metadata peek → runtime 결정 → target dir 계산 (`<slug>__editor_<ts>`, microsecond ts) → `_safe_extract` (zip slip 방지) → entry 파일 찾기 (live2d=.model3.json, spine=.skel→.json fallback + .atlas 필수) → `_next_unique_display_name` 으로 충돌 회피 → `manager.add_model(info)` → src zip 을 `installed/` 로 move.
  - 실패 시 partial 상태 rollback (`shutil.rmtree(target_dir)`).
  - zip move 실패만 non-fatal (warning 응답).
  - zip 의 metadata 파일 (`avatar-editor.json` / `avatar.json` / `LICENSE.md`) 은 entry 후보에서 제외 (Spine 의 .json fallback 이 metadata 잡지 않도록).
- 5개 compose 파일 backend mount `:ro` → rw (default). install 후 zip 이동에 write 필요.
  - `docker-compose.yml`, `docker-compose.dev.yml`, `docker-compose.dev-core.yml`, `docker-compose.prod.yml`, `docker-compose.prod-core.yml`.
  - 코멘트도 stale `RO` 제거 + "rw — backend reads + moves to installed/" 로 갱신.
- `backend/static/spine-models/.gitkeep` (신규) — Spine import 의 install target. main.py 의 기존 `/static` mount 가 자동 커버해서 추가 mount 코드 불필요.

**검증**:

격리 smoke test (venv python, /tmp/smoke_install.py):

- Live2D zip (hiyori_pro) install → 등록 entry 의 `url` 이 정확한 `.model3.json` path. registry 항목 수 +1.
- Spine zip (spineboy) install → `runtime="spine"`, `url` 이 `.skel`, `atlas_url` 정확히 채워짐.
- 같은 puppet 두 번째 install → display_name 자동으로 `(Editor 2)`.
- 악성 zip (`../../../etc/passwd` 멤버) → HTTPException 400 reject + target dir 정리됨.
- 모든 케이스 후 `installed/` 디렉터리에 원본 zip 존재.

**의도적 한계**:

- **kScale 등 default 값 0.7**: install 한 entry 의 viewport 파라미터는 전부 default. 사용자가 model_registry 직접 편집하거나 별도 UI 로 조정. baked zip 은 이 메타를 안 갖고 있음.
- **emotionMap default {neutral:0}**: avatar-editor 에서 motion 그룹 표준화 안 한 puppet 은 기본 emotion mapping 만. 사용자가 필요 시 직접 편집.
- **install 후 자동 assign X**: 새 entry 가 아무 agent session 에도 자동 연결 안 됨. 사용자가 명시적으로 select 해야 함 (UX 디자인 그대로).
- **Runtime/path validation 보수적**: live2d=.model3.json, spine=.skel 부재 시 immediate 400 + cleanup. 모호한 경우 reject 가 silently misregister 보다 안전.
- **인증/권한 X**: Geny 의 다른 vtuber endpoint 들과 동일 (단일 운영자 환경). 본 sprint 에서 새 인증 추가 X.

### C.4 / C.5 — 흡수 / 자동 충족

- **C.4 (spine 정적 dir + main mount)**: C.3 에서 같이 처리. 디렉터리만 만들면 main 의 `/static` mount 가 자동 커버.
- **C.5 (vtuber list endpoint runtime 노출)**: C.1 의 `to_dict()` 에 이미 `runtime` + `atlas_url` 포함됨 — `/api/vtuber/models` 는 변경 없이 새 필드 노출. 별도 sprint 불필요.

**다음**: Phase D — frontend renderer (spine-pixi 추가, AvatarCanvas dispatcher, BakedImportsModal). C.3 의 결과물을 사용자가 UI 에서 보고 install 할 수 있게.

## 사용자 보고 — `https://geny-x.hrletsgo.me/avatar-editor` 404

Phase B/C 가 코드 차원에서 끝난 직후 외부 검증 시 404. SSH 진단 (read-only) 으로 두 가지 사실 확정:

1. **nginx 컨테이너가 13일째 reload 안 됨** — `/home/hrjang/docker_web/Geny/nginx/nginx.conf` 의 호스트 파일에는 `/avatar-editor` location 정상 들어있지만 nginx in-memory config 에는 없음. bind mount 가 파일 자체는 동기화하지만 nginx 가 자동 reload 하지 않음. 사용자의 외부 요청이 catch-all `location /` 로 새서 frontend → 404.
2. **avatar-editor healthcheck `unhealthy` (FailingStreak: 54)** — `wget -q --spider http://localhost:3000/avatar-editor/` 가 alpine musl 의 `localhost` → `::1` (IPv6) resolve 때문에 connection refused. 컨테이너 자체는 0.0.0.0:3000 으로 잘 listen. 본 nginx proxy 와는 무관 (docker DNS 가 IPv4 로 resolve) 이라 외부 접근에 직접 영향 X — 다만 `docker ps` 출력 노이즈 + 향후 upstream healthcheck 도입 시 함정.

추가 발견: 사용자가 `/avatar-editor` (slash 없음) 로 접근. nginx 의 `location /avatar-editor/` 는 trailing slash 가 있는 path 만 매치 → catch-all fallback. 이것도 같이 해결해야 친화적.

### 조치 (commit)

- `nginx/nginx.conf`
  - `location = /avatar-editor` → `301 /avatar-editor/` redirect (slash 누락 케이스).
  - 기존 `location /avatar-editor/` 블록 무손상.
- 5개 compose 파일의 avatar-editor healthcheck `localhost` → `127.0.0.1`. alpine musl 환경에서 IPv6 resolve 함정 회피.
- 본 progress 섹션.

### 사용자 측 1회 실행 명령

```bash
cd /home/hrjang/docker_web/Geny
git pull
# 1) nginx config syntax 확인
sudo docker exec geny-nginx-prod nginx -t
# 2) graceful reload (downtime 없음) — /avatar-editor location 즉시 활성
sudo docker exec geny-nginx-prod nginx -s reload
# 3) avatar-editor 의 healthcheck 변경은 compose 변경이라 컨테이너 재생성 필요
sudo docker compose -f docker-compose.prod.yml --profile tts-local up -d avatar-editor
# (--build 불필요 — Dockerfile 안 바뀜, healthcheck 만 compose 측 변경)
```

3) 후 약 30s 내 `docker ps` 가 `(healthy)` 로 전환 + `https://geny-x.hrletsgo.me/avatar-editor` (slash 없어도) → 301 → 정상 home.

### 후속 — redirect loop (1차 fix 직후)

위 fix 적용 후 사용자가 다시 접속 → 이번엔 redirect loop:

```
GET /avatar-editor       → 301 Location: /avatar-editor/   (우리 nginx)
GET /avatar-editor/      → 308 Location: /avatar-editor    (Next.js)
GET /avatar-editor       → 301 ...   (반복)
```

원인: Next.js 의 default `trailingSlash: false` 가 `/avatar-editor/` 를 정규형 `/avatar-editor` 로 308 redirect. 내가 추가한 nginx 의 반대 방향 301 redirect 와 정확히 충돌해서 무한 루프.

조치:
- `nginx/nginx.conf` 의 `location = /avatar-editor` 301 redirect 블록 **삭제**.
- `location /avatar-editor/` (trailing slash 강제) → `location ^~ /avatar-editor` (slash 무관 prefix). 두 form 모두 upstream 으로 forward → Next.js 가 canonical URL 결정 권한 보유.

```diff
-    location = /avatar-editor {
-        return 301 /avatar-editor/;
-    }
-    location /avatar-editor/ {
+    location ^~ /avatar-editor {
         proxy_pass http://avatar_editor;
         ...
     }
```

사용자 측 1회 명령:

```bash
git pull
sudo docker exec geny-nginx-prod nginx -t
sudo docker exec geny-nginx-prod nginx -s reload
```

### Phase C 결산

Plan 의 5 sprint (C.1~C.5) → 실제 3 sprint (C.1, C.2, C.3) 로 정리됨. C.4 (spine 정적 dir) 와 C.5 (vtuber list runtime 노출) 는 C.3 / C.1 에 자연스럽게 흡수.

---

## Phase D — frontend renderer

### D.1 — `@esotericsoftware/spine-pixi-v7` 추가

Geny frontend 가 Pixi 7.4.3 stuck — geny-avatar 레포의 spine-pixi-v8 와 분리. 같은 호스트에서 두 앱이 origin context 분리라 충돌 없음 (plan 6.1).

**변경**:

- `frontend/package.json` — `"@esotericsoftware/spine-pixi-v7": "^4.2.114"` 추가.
- `frontend/package-lock.json` — npm 자동 갱신.

**디테일**:

- 처음 `@esotericsoftware/spine-pixi` (suffix 없음, `^4.2.62`) 로 install → npm 가 deprecation warning 띄움 ("Switch to @esotericsoftware/spine-pixi-v7"). 즉시 uninstall + 재설치.
- v7 패키지의 peer deps: `@pixi/{core,mesh,text,assets,display,graphics,events}: ^7.2.4` — 우리 `pixi.js@7.4.3` 이 모두 만족.
- 기존 `pixi-live2d-display@0.5.0-beta` 와 peer dep 충돌 없음 (둘 다 v7).

**검증**:

- `npx tsc --noEmit` — 기존 vitest 누락 에러 1개 외 신규 에러 없음.
- `node_modules/@esotericsoftware/spine-pixi-v7/dist/` 정상 install.

**의도적 한계**:

- **runtime 시점 통합 X**: 이번 sprint 는 dependency 추가만. SpineCanvas 컴포넌트는 D.2.
- **devDeps 추가 X**: spine 자체는 production deps 에 들어감 (런타임 필요).

**다음**: D.2 — `components/avatar/SpineCanvas.tsx` 신규 (Live2DCanvas API 미러링).

### D.2 — `SpineCanvas.tsx` + `Live2dModelInfo` runtime/atlas_url 필드

기존 `Live2DCanvas` 와 같은 자리에 들어가는 read-only Spine 뷰어. plan 6.4 의 의도적 한계 그대로 — viewport pan/zoom + idle 자동재생까지만, lipsync/expression/beat sync 같은 고급 통합은 후속.

**변경**:

- `frontend/src/types/index.ts` — `Live2dModelInfo` 에 `runtime?: 'live2d' | 'spine'` + `atlas_url?: string | null` 추가. C.1 의 백엔드 변경과 매치. `undefined` 면 live2d 로 fallback.
- `frontend/src/components/avatar/SpineCanvas.tsx` (신규)
  - props `{ url, atlas, kScale?, animation?, className?, interactive?, background?, backgroundAlpha? }`. plan 의 명세 대로 — sessionId 기반 X (D.3 dispatcher 가 model 조회 책임).
  - mount: `Assets.add({alias, src})` × 2 → `Assets.load([...])` → `Spine.from({skeleton: alias, atlas: alias})` → `app.stage.addChild(spine)`.
    - alias 는 mount-scoped sequence (`spine-canvas:<n>:skel|atlas`) — 재마운트 시 stale cache 충돌 회피.
  - fit-to-canvas: `min(scaleX, scaleY) * kScale` (`skeletonData.width|height` 기준).
  - animation 선택: prop > `/idle/i` regex match > animation[0] > 경고 로그.
  - **viewport**: `Live2DCanvas` 의 wheel zoom + drag pan 패턴 그대로 포팅. model offset (initialXshift/Yshift) 만 제거 — Spine 은 skeleton 자체가 origin 정의.
  - resize observer: 컨테이너 dim 변경 시 `app.renderer.resize()` + base scale 재계산.
  - generation counter (`genRef`) + cancellation guard — Live2DCanvas 의 strict-mode race 방지 패턴 동일.
  - cleanup: `spine.destroy()` + `app.destroy(true, {children: true})`.

**검증**:

- `npx tsc --noEmit` — vitest pre-existing 외 신규 에러 없음.
- API 검증: `Spine.from()` 의 `SpineFromOptions` 타입에 `skeleton: string` (asset 별칭, URL 직접 X) 명시. geny-avatar 의 SpineAdapter 패턴 (`Assets.add`+`load`+`Spine.from(alias)`) 그대로 따름.
- 실제 렌더 검증은 D.3 (dispatcher) + D.7 (호출처 교체) 후 사용자 시각 검증.

**의도적 한계**:

- **lipsync / motion pipeline X**: Live2D 의 parameters 와 Spine 의 bone 시스템이 비대칭. Spine 의 lipsync 는 별도 추적 (입 vertices 를 가진 slot 직접 조작) 필요 — V1 범위 밖.
- **emotion blend X**: Spine 은 animation 트랙 mixing 으로 표현 — Live2D 의 expression Add/Multiply 와 다른 모델. 후속 sprint 에서 별도 통합.
- **interactive tap motion X**: 일단 viewport drag/zoom 만. tap motion 은 hit-area 정의가 puppet 별로 달라 별도 메타데이터 필요.
- **Spine asset alias 누수**: mount 마다 alias 가 늘어 `Assets` 캐시에 쌓일 수 있음. 일반 사용에서 문제 X (puppet 전환 빈도 낮음). 필요 시 `Assets.unload(alias)` 추가.

**다음**: D.3 — `AvatarCanvas.tsx` dispatcher (sessionId → store → runtime 분기).
