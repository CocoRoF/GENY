# geny-avatar Integration Plan

> Geny 의 VTuber 라인업에 외부 hobby 프로젝트인 [geny-avatar](https://github.com/CocoRoF/geny-avatar) 의 puppet 편집 능력을 결합한다. 두 레포는 영구 분리 — geny-avatar 는 자체 속도로 발전하고, Geny 는 명시적인 commit pin 으로 통합한다.
>
> **상태**: V1 완료 (Phase A~D + Phase G + Phase E sign-off, 2026-05-10).
> **저자**: 2026-05-10
> **결정 결과 (사용자 확인됨)**: git submodule · nginx /avatar-editor · shared docker volume · Pixi-v8 vs v7 분리 (아래 위험 섹션 참조)
> **진행 기록**: [`docs/progress/GENY_AVATAR_INTEGRATION_PROGRESS.md`](../progress/GENY_AVATAR_INTEGRATION_PROGRESS.md) — sprint 별 산출과 사용자 보고 hotfix 까지 시간순.

---

## 1. 목표 / 비목표

### 목표

1. **Geny 사용자가 Geny UI 안에서 puppet 을 편집** — geny-avatar 의 Decompose Studio + AI texture generation + variants 를 그대로 활용.
2. **편집 결과를 Geny 의 VTuber 라이브러리로 한 번에 import** — mask / AI gen / part disable 이 모두 baked 된 단일 puppet 자산이 Geny 에 등록.
3. **기존 VTuber 자산 (Hiyori Pro, Mao Pro, Shizuku 등) 은 무손상 유지** — 새로 import 된 자산은 `(Editor)` 접미사로 구분.
4. **Spine 도 Live2D 와 동급으로 지원** — Geny 의 기존 Live2D-only renderer 가 Spine baked 출력도 렌더 가능.
5. **두 레포의 독립성** — geny-avatar 는 자체 hobby 속도로 main 진행, Geny 는 commit pin 으로 안정적인 버전을 통합. 한쪽 변경이 다른 쪽 deploy 를 깨뜨리지 않음.

### 비목표 (이 plan 의 범위 밖)

- geny-avatar 자체의 기능 추가 (Phase 7 끝났음 — 별도 hobby 진행).
- Geny 내장 Live2D 모델들의 fork / 편집 (그대로 둠).
- Cubism Editor 같은 데스크톱 도구의 대체 (geny-avatar 는 web AI 보조 도구지 SDK 대체 X).
- 모바일 / 터치 UX (현 Geny 와 동일 데스크톱 우선).
- 다중 사용자 동시 편집 (Geny 는 single-tenant hobby).

---

## 2. 아키텍처 (한 화면)

```
┌─────────────────────────────────────────────────────────────────────┐
│                          User browser                                │
└─────────────────────────────────────────────────────────────────────┘
                ↓                                ↓
       http://geny/                     http://geny/avatar-editor/
                ↓                                ↓
┌─────────────────────────────────────────────────────────────────────┐
│                        nginx (geny-nginx)                            │
│   /api/    → backend:8000                                            │
│   /ws/     → backend:8000                                            │
│   /static/ → backend:8000  (live2d-models, voices, etc.)             │
│   /avatar-editor/  → avatar-editor:3000  (NEW)                       │
│   /        → frontend:3000                                           │
└─────────────────────────────────────────────────────────────────────┘
   ↓               ↓               ↓                       ↓
┌──────┐    ┌──────────┐    ┌─────────────────────┐    ┌──────────┐
│front-│    │ backend  │    │  avatar-editor       │    │ postgres │
│ end  │←──→│ (FastAPI)│    │  (Next.js, geny-     │    │          │
│      │    │          │    │   avatar submodule)  │    │          │
│ Pixi │    │ /api/    │    │                      │    │          │
│  v7  │    │  vtuber/ │    │  basePath=/avatar-   │    │          │
│ +    │    │  baked-  │    │      editor          │    │          │
│ Live2│    │  imports │    │                      │    │          │
│  D + │    │  /list   │    │  GENY_HOST=true      │    │          │
│ Spine│    │  /install│    │  (enables "Send to   │    │          │
│      │    │          │    │   Geny" button)      │    │          │
└──────┘    └──────────┘    └─────────────────────┘    └──────────┘
                  ↑                       │
                  │                       │
                  │   write baked.zip     │
                  │   ┌───────────────────┘
                  │   ↓
              ┌─────────────────────────────┐
              │ shared docker volume:       │
              │ geny-baked-exports          │
              │   /exports                  │ ← avatar-editor 가 mount (rw)
              │   /data/baked-imports       │ ← backend 가 mount    (ro)
              └─────────────────────────────┘
```

**핵심 invariant**:
- geny-avatar source 는 Geny 레포 안에서 `vendor/geny-avatar/` 에만 존재 (submodule).
- 서비스 간 직접 HTTP 통신 없음. 데이터는 shared volume 한 곳을 통과.
- nginx 가 동일 origin 으로 모든 라우트 통합 → 사용자 입장에서 두 페이지가 한 도메인.

---

## 3. 데이터 흐름

### 3.1 Edit → Bake → Import (사용자 흐름)

```
1. /             [Geny landing] — 기존 그대로
2. VTuber 설정 → "Avatar Editor 열기 (Editor)"
3. /avatar-editor/        → geny-avatar landing
                              · 기존 puppet upload (drop zone)
                              · Hiyori / spineboy 내장 샘플
                              · 라이브러리 (이전에 작업한 puppet들 — IDB)
4. /avatar-editor/edit/<id>  → 편집 (decompose / generate / variants)
5. ExportButton "Send to Geny"  ← GENY_HOST=true 이면 활성
   → buildModelZip(baked) → POST /file?  NO. → write to /exports/<name>.<ts>.zip
6. 사용자가 Geny VTuber 설정으로 복귀
7. "새 import 확인" 버튼 → GET /api/vtuber/baked-imports/list
   → 응답: pending zip 목록 [{filename, size, runtime, displayName, sentAt}]
8. 사용자가 한 zip 선택 → POST /api/vtuber/baked-imports/install {filename}
   → backend 가 unzip → static/{live2d-models|spine-models}/<name>(Editor)/
   → model_registry.json 갱신 (display_name 끝에 " (Editor)" 자동 부착)
9. 라이브러리 list refresh → "<original> (Editor)" 등장
10. 선택 → 기존 VTuber 흐름 (assign / interact / lipsync) 그대로 작동
```

### 3.2 baked zip 포맷 (geny-avatar 의 buildModelZip 출력)

```
my-puppet.zip
├─ avatar-editor.json   (metadata: runtime, version, source, edits applied, baked at)
├─ runtime/
│  ├─ <name>.model3.json   (Live2D — 또는 Spine 의 .skel/.atlas)
│  ├─ <name>.moc3
│  ├─ textures/<name>.4096.png  (mask + AI gen 합성된 atlas)
│  ├─ pose3.json (필요 시 hidden parts 반영)
│  └─ ...
└─ LICENSE.md   (origin + AI provenance)
```

기존 geny-avatar 가 이미 `lib/export/buildModelZip.ts` 로 이 형식 출력 중. Geny 가 이걸 그대로 받음.

### 3.3 Geny 의 model_registry 확장

기존:
```json
{
  "models": [
    { "name": "mao_pro", "display_name": "Mao Pro", "url": "/static/live2d-models/mao_pro/runtime/mao_pro.model3.json", ... }
  ]
}
```

확장:
```json
{
  "models": [
    { "name": "mao_pro", "display_name": "Mao Pro", "runtime": "live2d", ... },
    {
      "name": "hiyori_pro__editor_20260510_213045",
      "display_name": "Hiyori Pro (Editor)",
      "runtime": "live2d",
      "url": "/static/live2d-models/hiyori_pro__editor_20260510_213045/runtime/hiyori_pro_t11.model3.json",
      "imported_from": "geny-avatar:0.1.2",
      "imported_at": "2026-05-10T21:30:45Z",
      "kScale": 0.7,
      ...
    },
    {
      "name": "spineboy__editor_20260510_220000",
      "display_name": "spineboy (Editor)",
      "runtime": "spine",
      "url": "/static/spine-models/spineboy__editor_20260510_220000/runtime/spineboy-pro.skel",
      "atlas": "/static/spine-models/spineboy__editor_20260510_220000/runtime/spineboy-pma.atlas",
      ...
    }
  ]
}
```

`runtime` 필드는 모든 entry 에 추가 (기존 entry 들은 migration 시 `"live2d"` 디폴트 부여).

---

## 4. 변경 surface (저장소별)

### 4.1 `geny-avatar` 레포 변경 (Phase A 에 해당)

이 통합을 위해 geny-avatar 에 추가해야 하는 부분 (geny-avatar 자체의 단독 사용성도 함께 향상):

- `Dockerfile` (신규) — Next.js 15 standalone production build. 80~100 line.
- `next.config.ts` 갱신 — `basePath` / `assetPrefix` env 기반 동적화 (`GENY_AVATAR_BASE_PATH`).
- `components/ExportButton.tsx` 갱신 — `process.env.NEXT_PUBLIC_GENY_HOST === "true"` 일 때 "Send to Geny" 모드 추가.
  - 클릭 시 `buildModelZip()` 결과를 `/api/avatar-editor/send-to-geny` (geny-avatar 자체의 새 API route) 로 POST.
- `app/api/send-to-geny/route.ts` (신규) — 받은 blob 을 `process.env.GENY_BAKED_EXPORTS_DIR` (기본 `/exports`) 에 timestamped 파일명으로 fs.writeFile. 서버 사이드라 직접 디스크 access 가능.
- `README.md` "Geny 통합" 섹션 추가 (env 설명).

### 4.2 Geny — infra (Phase B)

- `.gitmodules` (신규/갱신) — `vendor/geny-avatar` submodule entry, 특정 commit 에 pin.
- `vendor/geny-avatar` — submodule path (fresh checkout 시 `git submodule update --init` 필요).
- `docker-compose.yml`, `docker-compose.dev.yml`, `docker-compose.prod.yml`, `docker-compose.dev-core.yml`, `docker-compose.prod-core.yml` 5 파일 모두에 `avatar-editor` 서비스 + `geny-baked-exports` volume 추가. (-core 변형은 TTS 만 빼는 거라 avatar-editor 는 -core 에도 포함.)
- `nginx/nginx.conf` — `location /avatar-editor/` 블록 추가 (HMR 위해 dev compose 에서는 WebSocket upgrade 도).
- `.env.example` — `GENY_AVATAR_PORT` (호스트 port 매핑용, dev only) 추가.

### 4.3 Geny — backend (Phase C)

- `backend/controller/vtuber_baked_imports_controller.py` (신규)
  - `GET /api/vtuber/baked-imports/list` — `/data/baked-imports/` 안의 zip 메타데이터 반환.
  - `POST /api/vtuber/baked-imports/install` — body: `{filename, displayName?}`. unzip 후 적절한 디렉터리로 복사 + model_registry 갱신 + 원본 zip 은 `installed/` 로 이동.
  - `DELETE /api/vtuber/baked-imports/{filename}` — pending zip 삭제 (사용자가 잘못 보낸 경우).
- `backend/service/vtuber/baked_import_service.py` (신규)
  - `unpack_baked_zip(zip_path, target_dir)` — fflate-equivalent (Python `zipfile`).
  - `register_in_model_registry(meta)` — JSON 파일 IO + display_name 충돌 시 `(Editor 2)`, `(Editor 3)` ... 자동 suffix.
- `backend/main.py` — `/data/baked-imports/` 디렉터리 자동 생성 (마운트되지 않으면 빈 dir).
- `backend/static/spine-models/` (신규 빈 디렉터리) — Spine baked 출력의 install target. main.py 에서 staticfiles mount 확장.
- 기존 `model_registry.json` 의 entry 들에 `"runtime": "live2d"` 일괄 추가 (one-time migration).

### 4.4 Geny — frontend (Phase D)

- `package.json` — `@esotericsoftware/spine-pixi` (Pixi v7 호환 버전 — `-v8` 아님!) 추가.
- `components/avatar/AvatarCanvas.tsx` (신규) — runtime 별 dispatcher. 기존 `Live2DCanvas` 와 새 `SpineCanvas` 중 적절한 걸 mount.
- `components/avatar/SpineCanvas.tsx` (신규) — Live2DCanvas 의 API surface 미러링 (sessionId, interactive, background...). spine-pixi 로 skeleton 로드 → 첫 animation 자동 재생 → drag/zoom 같은 viewport 컨트롤 기존과 통일.
- `components/live2d/Live2DCanvas.tsx` 그대로 — 기존 path 무손상.
- `components/live2d/VTuberPanel.tsx` 갱신 — model 선택 list 에 runtime chip + `(Editor)` 표시. select 시 AvatarCanvas 에 dispatch.
- `components/avatar/BakedImportsModal.tsx` (신규) — VTuber 설정 안에 "Avatar Editor 에서 가져오기" 버튼 → 모달 열림 → pending list + install / delete 액션 + "/avatar-editor/ 열기" 링크.
- `lib/spine/` (신규 폴더) — adapter 헬퍼 (모션 list, slot 토글 등 — geny-avatar 의 SpineAdapter 참고하되 read-only viewer 용으로 단순화).
- `store/useVTuberStore.ts` 갱신 — `runtime` 필드 추가, model 변경 시 dispatch.

### 4.5 Geny — docs

- 본 plan 문서 (이미 작성).
- `docs/analysis/AVATAR_BAKED_FORMAT.md` (신규) — geny-avatar 의 baked zip 포맷 명세 + 호환성 약속.
- `docs/progress/<date>_<n>_avatar_<sprint>.md` — sprint 별 progress.
- `README.md` — "VTuber Editor (Avatar Editor)" 섹션 추가.

---

## 5. Sub-sprint 분할 (atomic PRs)

각 PR 은 독립적으로 merge 가능. 순서는 의존 관계 강제.

### Phase A — geny-avatar 자체 변경 (별도 레포)

> 이 sprint 들은 geny-avatar 레포에서 진행 → tag 또는 commit hash 가 Geny submodule pin 의 target.

- **A.1** geny-avatar 에 `Dockerfile` 추가 (Next.js standalone) + `.dockerignore` + `pnpm-store` 캐싱.
- **A.2** `next.config.ts` 의 `basePath` / `assetPrefix` 를 `GENY_AVATAR_BASE_PATH` env 기반으로 동적화. 환경 변수 없으면 root 그대로.
- **A.3** "Send to Geny" 모드 추가
  - `ExportButton` 에 세 번째 버튼 (`NEXT_PUBLIC_GENY_HOST==="true"` 일 때만).
  - `app/api/send-to-geny/route.ts` (Next.js API) — multipart 받아서 fs 에 timestamped 파일명으로 저장. 디렉터리는 env (`GENY_BAKED_EXPORTS_DIR=/exports`).
- **A.4** geny-avatar README 의 "Geny 통합" 섹션 + 새 env 들 docs.
- **A.5** geny-avatar 에 git tag (`v0.2.0` 등) — Geny submodule 이 이걸 가리킴.

### Phase B — Geny infra (이 레포)

- **B.1** submodule 등록
  - `git submodule add https://github.com/CocoRoF/geny-avatar vendor/geny-avatar`
  - `git submodule update --init`
  - `vendor/geny-avatar` 가 A.5 의 tag 에 위치.
- **B.2** `docker-compose.yml` 에 `avatar-editor` 서비스 추가
  - `build: { context: ./vendor/geny-avatar, dockerfile: Dockerfile }`
  - `environment: { GENY_AVATAR_BASE_PATH: /avatar-editor, NEXT_PUBLIC_GENY_HOST: "true", GENY_BAKED_EXPORTS_DIR: /exports }`
  - `volumes: [geny-baked-exports:/exports]`
  - `networks: [geny-net]`
  - `ports: 호스트 expose 안 함` — nginx 만 접근.
- **B.3** 다른 compose 파일 4개에도 동일 service block 추가 (dev/prod, core/full).
- **B.4** `volumes:` 섹션에 `geny-baked-exports` 추가 + backend 의 volumes 에 `geny-baked-exports:/data/baked-imports:ro` 마운트 추가.
- **B.5** `nginx/nginx.conf` 에 `location /avatar-editor/` 추가
  - proxy_pass http://avatar-editor:3000/ (basePath 가 /avatar-editor 라 trailing slash 주의)
  - WebSocket upgrade 헤더 (Next.js dev HMR 용)
  - read_timeout 길게 (build 직후 첫 요청이 느림)
- **B.6** README 의 "도커 컴포즈 사용법" 에 submodule update 단계 추가
  - `git clone --recurse-submodules ...`
  - 또는 기존 clone 에서 `git submodule update --init`

### Phase C — Geny backend import 흐름

- **C.1** model_registry 마이그레이션
  - 기존 entries 에 `"runtime": "live2d"` 일괄 추가 (1회).
  - schema_version 필드 추가 (`1` → `2`) 로 future migration 표시.
- **C.2** `vtuber_baked_imports_controller` 신규
  - `GET /list` — `/data/baked-imports/*.zip` 스캔 + 각 zip 의 `avatar-editor.json` 읽어서 메타 반환.
  - `DELETE /<filename>` — pending 삭제.
- **C.3** install endpoint
  - `POST /install {filename, displayNameOverride?}` — unzip → 대상 디렉터리 결정 (live2d-models / spine-models) → 복사 → model_registry append.
  - 디렉터리 명: `<source_name>__editor_<timestamp>` (충돌 방지).
  - display_name 자동 suffix: `<original> (Editor)`. 이미 있으면 `(Editor 2)`, `(Editor 3)` ...
  - 성공 시 원본 zip 을 `/data/baked-imports/installed/` 로 이동.
- **C.4** `static/spine-models/` 디렉터리 + `main.py` 에서 staticfiles mount 확장.
- **C.5** `vtuber_controller.py` 의 list endpoint 가 새 entry 들도 반환 (이미 동작하면 작업 X).

### Phase D — Geny frontend renderer

- **D.1** Pixi v7 호환 spine 런타임 패키지 추가
  - `npm install @esotericsoftware/spine-pixi` (v7 패키지 — 의존성 충돌 시 정확한 sub-version 명시).
- **D.2** `SpineCanvas.tsx` 신규 (read-only viewer)
  - props: `{ url, atlas, kScale, animation? }`
  - mount: pixi-app + Spine.from(skeletonUrl, atlasUrl) → addChild → 첫 animation 자동 재생
  - viewport: pan / zoom 기존 Live2DCanvas 와 동일 패턴 (drag, wheel)
  - lipsync / motion 같은 고급 통합은 Phase E 까지 보류 (V1 은 idle 재생만)
- **D.3** `AvatarCanvas.tsx` dispatcher
  - props: 기존 Live2DCanvas 와 동일 (sessionId 기반)
  - 내부에서 store 읽어 runtime === 'live2d' ? <Live2DCanvas /> : <SpineCanvas />
- **D.4** `useVTuberStore` 에 `currentModel.runtime` 노출 + model_registry list fetch 시 runtime 필드 hydrate.
- **D.5** `VTuberPanel` 갱신
  - 모델 list 에 `[live2d]` / `[spine]` chip + `(Editor)` 접미사 시각 강조 (작은 accent border).
  - 선택 시 `setCurrentModel({ name, runtime, ... })`.
- **D.6** `BakedImportsModal` 신규
  - VTuberPanel 안에 "Avatar Editor" 영역 (header chip + 링크 + 버튼)
  - "Avatar Editor 열기" → window.open('/avatar-editor/', '_blank') (또는 same tab — UX 결정)
  - "import 대기 보기" → 모달
    - GET /api/vtuber/baked-imports/list 후 카드 grid
    - 각 카드: filename, size, sentAt, runtime, "install" / "delete"
    - install 후 list refresh + VTuberPanel 의 모델 list 도 refresh
- **D.7** 모든 기존 Live2DCanvas 호출처를 AvatarCanvas 로 점진 교체 (한 PR 안에).

### Phase E — 검증 + 폴리시

- **E.1** end-to-end 테스트 (수동)
  - clean clone → submodule update → docker compose up
  - geny-avatar 진입 → spineboy 편집 → Send to Geny
  - Geny 로 복귀 → import → 라이브러리에 spineboy (Editor) → 선택 → AvatarCanvas 가 SpineCanvas mount → 렌더 확인
  - Hiyori 도 동일 path
- **E.2** 회귀 테스트
  - 기존 mao_pro / shizuku / hiyori_pro 가 그대로 동작 (model_registry 마이그레이션 후)
  - VTuberPanel 선택 → 기존 lipsync / motion / interaction 모두 동일
- **E.3** docs/progress 정리 + 본 plan 문서의 "상태" 갱신.
- **E.4** README 갱신 (avatar-editor 섹션 + submodule 동기화 가이드).

---

## 6. 위험 / 의도적 한계

### 6.1 Pixi 버전 분리 — 가장 큰 리스크

- **현실**: Geny frontend `pixi.js@7.4.3`, geny-avatar `pixi.js@^8.18.1`. 두 버전이 한 페이지에 동시 로드되면 충돌 가능 (전역 ticker, 텍스처 캐시 등).
- **현 plan 의 해법**: 두 앱이 **서로 다른 origin context** (Geny frontend vs avatar-editor service) 라 같은 JS bundle 안에 함께 들어가지 않음. nginx 로 같은 host 로 보이지만 실제 페이지 로드는 분리. ✅
- **Spine 도입 시**: Geny frontend 가 추가하는 `@esotericsoftware/spine-pixi` 는 Pixi v7 호환 패키지. geny-avatar 의 `-v8` 패키지와 무관. ✅
- **남은 위험**: 향후 Geny 가 Pixi v8 로 업그레이드해야 한다면 `pixi-live2d-display` 의 v8 호환성 (currently beta) 도 같이 검증 필요. 본 통합과 별개 작업.

### 6.2 submodule 동기화 부담

- 사용자가 `git pull` 만 하면 submodule 은 갱신 안 됨 — `git submodule update --recursive` 별도 필요.
- **완화**: README 에 명시 + Makefile / scripts/setup.sh 에 한 줄로 묶기 + CI 에서 `git clone --recurse-submodules` 가이드.
- 의도적 trade: 자동 pull 보다 명시적 commit pin 의 안정성을 선호 (사용자의 결정).

### 6.3 baked zip schema 변경

- geny-avatar 가 자기 속도로 발전하다가 baked zip 포맷을 바꾸면 Geny 의 import 가 깨짐.
- **완화**: `avatar-editor.json` 안에 `schemaVersion` 필드 (이미 buildBundle 의 GenyAvatarExport 에 있음 — buildModelZip 에도 동일 필드 추가). Geny 는 알려진 schemaVersion 만 install. 새 버전 만나면 "geny-avatar 가 너무 신버전 — Geny 업그레이드 필요" 친절한 에러.
- 본 plan 의 V1 schemaVersion = `1` 로 freeze.

### 6.4 SpineCanvas 의 기능 비대칭

- 기존 Live2DCanvas 는 lipsync / beat sync / expression / blink 등 풍부.
- SpineCanvas 첫 버전은 idle animation 재생 + viewport 만.
- VTuber 페르소나 통합 (lipsync 등) 은 Spine 의 motion 모델이 다르므로 별도 sprint (Phase F 후속).
- 본 plan V1 의 SpineCanvas 는 "보이고 간단히 움직임" 수준이면 충분.

### 6.5 nginx basePath 의 Next.js trailing-slash 함정

- Next.js basePath="/avatar-editor" + nginx proxy_pass http://avatar-editor:3000/ 조합은 trailing slash 에 민감.
- **해법**: nginx location 블록에서 `proxy_pass http://avatar-editor:3000;` (trailing slash 없이) + Next.js basePath 만으로 처리. 잘못 설정하면 `/avatar-editor/_next/...` 가 404.
- B.5 PR 에서 정확한 조합 확정 + 한 줄 brief 메모.

### 6.6 dev compose 의 build 시간

- avatar-editor 서비스 첫 build 가 3~5 분 (pnpm install + Next.js build).
- **완화**: dev compose 에서는 standalone build 대신 `next dev` 로 hot reload (별도 dev Dockerfile 또는 `target=dev` multi-stage). prod compose 만 standalone.
- 사용자가 "tts-local" 처럼 profile 로 켜고 끌 수 있게 → `profiles: ["avatar"]` 도 고려. 디폴트는 enabled.

### 6.7 (Editor) 자산의 반복 import

- 동일 puppet 을 여러 번 보내면 (Editor), (Editor 2), (Editor 3) 식 누적.
- **완화**: BakedImportsModal 의 install UI 에 "기존 (Editor) 자산 덮어쓰기" 옵션 추가 (선택). 디폴트는 새 entry.
- 사용자가 정리는 직접 (라이브러리에서 delete).

---

## 7. 시각 검증 가이드 (V1 완료 시점)

```bash
# from scratch
git clone --recurse-submodules https://github.com/CocoRoF/Geny.git
cd Geny
docker compose -f docker-compose.dev.yml up --build

# checkpoints:
# 1. http://localhost:3000/                 → Geny landing
# 2. http://localhost:3000/avatar-editor/   → geny-avatar landing (basePath 적용 확인)
# 3. /avatar-editor/edit/builtin/spineboy → spineboy 편집 진입
# 4. ✨ generate 1~2 region → "apply to atlas"
# 5. "Send to Geny" 클릭 → "보냈습니다" toast
# 6. Geny 의 VTuber 설정 → "Avatar Editor 가져오기" → 모달 → spineboy zip 보임
# 7. install 클릭 → "spineboy (Editor)" 가 모델 list 에 등장 (chip: spine)
# 8. 선택 → SpineCanvas mount → spineboy 등장 + idle animation 재생
# 9. 기존 Hiyori Pro 선택 → Live2DCanvas 동작 (회귀 X)
```

---

## 8. 진행 결산 (V1 완료)

본 plan 은 5/10 한 세션에 걸쳐 전 phase 완료. 실제 PR 합산은 27개 atomic 목표보다 적음 — 일부 sprint 가 자연스럽게 흡수됨 (C.4/C.5 → C.3, D.4/D.7 → D.5, E.1/E.2 → 코드 audit 으로 대체):

| Phase | 계획 | 실제 산출 | 종결 commit / tag |
|---|---|---|---|
| A | A.1~A.5 (geny-avatar repo) | 5 sprint + A.6/A.7/A.8/A.9 hotfix | geny-avatar v0.2.0 → v0.2.4 → v0.3.x |
| B | B.1~B.6 (infra) | 6 sprint | nginx prod 라우팅 + 5 compose + submodule pin |
| C | C.1~C.5 (backend import) | 3 sprint (C.4/C.5 흡수) + Phase G (animationConfig schemaVersion 2 NAME→INDEX) | install endpoint + spine static + emotionMap translate |
| D | D.1~D.7 (frontend renderer) | 5 sprint (D.4/D.7 흡수) | spine-pixi-v7 + SpineCanvas + AvatarCanvas + BakedImportsModal |
| E | E.1~E.4 (검증 + 폴리시) | 코드 audit (E.1/E.2 대체) + 본 문서 갱신 (E.3) + README freshness pass (E.4) | 본 sign-off |

**계획 외 추가 작업** (사용자 보고 / 발견 시점에 끼어든 것):

- nginx 13일째 reload 안 됨 + redirect loop hotfix
- Pixi v8 SSR navigator 부재 (`node:20-alpine` → `:22-alpine`)
- 업로드 puppet 에서 expression preview silent fail (`rewriteLive2DManifest` Expressions 누락)
- post-merge hook 도입 (배포 스크립트 폐기, plain `git pull` 로 vendor 자동 fast-forward)

## 9. V1 이후 (별도 추적)

본 통합 V1 의 의도적 한계 (plan 6.x) 중 후속 sprint 가 필요한 항목:

- **Spine 의 lipsync / emotion blend**: 현재 SpineCanvas 는 idle + viewport 만. Live2D 의 expression Add/Multiply 와 다른 모델이라 별도 통합.
- **Spine 의 hit-area tap motion**: 현재 viewport drag/zoom 만.
- ✅ **(Editor) 자산의 덮어쓰기 옵션** — 2026-05-10 완료. BakedImportsModal 에 per-card 체크박스 + backend `replace_existing` flag. 기존 `<base> (Editor*)` entries 매칭 → on-disk 디렉터리 삭제 + registry 정리 → 신규는 깔끔한 `(Editor)` 슬롯 차지.
- **schemaVersion 3+**: 현재 `2` 까지만. 다중 매핑 hit-area / 기타 필드 확장 시 양쪽 레포 동시 갱신.
- **Pixi v8 으로 Geny 프론트 업그레이드**: `pixi-live2d-display` 의 v8 호환성 (currently beta) 검증 후 별건 phase.
