<p align="center">
  <img src="img/Geny_full_logo.png" alt="Geny" width="520"/>
</p>

<h1 align="center">🧞 Geny — <em>Geny Execute, Not You</em></h1>

<p align="center"><em>지니가 할게, 넌 가만히 있어.</em></p>

<p align="center">
수다스러운 Live2D / Spine VTuber 와 tool 을 굴리는 Sub-Worker 를 짝지어, 3D 도시에서 협업하는 모습을 시각화하고, 5개 LLM backend 를 설정 한 번으로 전환하는 <strong>멀티 에이전트 VTuber + 자율 워커</strong> 플랫폼.
</p>

<p align="center">
<a href="README.md">English README</a> ·
<a href="docs/architecture.md">아키텍처</a> ·
<a href="docs/providers.md">LLM Providers</a> ·
<a href="docs/sessions.md">Session &amp; Delegation</a> ·
<a href="docs/environments.md">Environments</a> ·
<a href="docs/error_codes.md">Error Codes</a>
</p>

<!-- 📸 IMAGE NEEDED: hero 스크린샷 — 에이전트가 걸어다니는 3D 도시 + VTuber 채팅 패널 + Live2D 아바타 -->
> 📸 **이미지 필요** — _hero 스크린샷: 에이전트가 걸어다니는 3D 도시, VTuber 채팅 패널, Live2D 아바타._

---

## 🌐 Geny 에코시스템

Geny 는 **스택 최상단의 제품**입니다 — 아래의 모든 프로젝트를 하나의 경험으로 묶습니다: 말하는 아바타, 실제 작업을 처리하는 자율 워커, 에이전트가 코드를 안전하게 다루는 샌드박스, 그리고 그 모두를 구동하는 엔진.

<!-- 📸 IMAGE NEEDED: 아래 ASCII 맵을 대체할 다이어그램 -->

```
                  Geny — 최상위 제품 (아래 전부를 사용)   ← 현재 위치
                    │
      ┌─────────────┼──────────────┐
   에이전트 엔진     아바타        샌드박스 + 배포
      │             │              │
      ▼             ▼              ▼
 geny-executor  geny-avatar      GAPT
  (엔진)        (아바타 에디터)  (AI DevOps 플랫폼)
```

| 프로젝트 | 무엇인가 | 스택에서의 역할 |
|---|---|---|
| [**Geny**](https://github.com/CocoRoF/Geny) | 멀티 에이전트 VTuber + 자율 워커 플랫폼 | 🏛️ 최상위 제품 — 아래 전부를 사용 |
| [**geny-executor**](https://github.com/CocoRoF/geny-executor) | 21단계 manifest 기반 에이전트 파이프라인 · PyPI · MIT | ⚙️ 모든 것이 돌아가는 엔진 |
| [**GAPT**](https://github.com/CocoRoF/geny-adapted-project-toolkit) | 셀프호스트 AI DevOps 플랫폼 — 샌드박스·편집·빌드·배포 | 🛠️ 에이전트가 실제 레포를 안전하게 다루는 곳 |
| [**geny-avatar**](https://github.com/CocoRoF/geny-avatar) | AI 텍스처 생성 기반 2D 라이브 아바타 에디터 | 🎭 Geny 의 얼굴이 만들어지는 곳 |

> **➡️ 현재 위치: `Geny`** — 에코시스템 전체를 묶는 제품.

---

## ⬇️ 데스크탑 접속기 다운로드

데스크탑 하단에 떠 있는 **VTuber 접속기** — 서버는 그대로 두고, 화면 하단에 살아있는 아바타를 띄웁니다.

<!-- 📸 IMAGE NEEDED: 데스크탑 접속기 — 실제 바탕화면 하단에 떠 있는 아바타 + 트레이 메뉴 -->
> 📸 **이미지 필요** — _데스크탑 접속기: 실제 바탕화면 하단의 떠 있는 아바타 + 트레이 메뉴._

### 1) 설치 파일 — **[➡️ 최신 릴리스(Releases)에서 받기](https://github.com/CocoRoF/Geny/releases/latest)**

| OS | 파일 | 설치 / 첫 실행 |
|---|---|---|
| 🪟 **Windows** | `Geny-Setup-*.exe` | 더블클릭 → SmartScreen 경고 시 **자세히 → 실행** (현재 무서명) |
| 🍎 **macOS** | `Geny-*.dmg` | 열어서 Applications 로 드래그 → 첫 실행은 **우클릭 → 열기** (Gatekeeper) |
| 🐧 **Linux** | `Geny-*.AppImage` / `*.deb` | AppImage: `chmod +x Geny-*.AppImage && ./Geny-*.AppImage` · deb: `sudo dpkg -i Geny-*.deb` |

> 설치 파일이 안 보이면 릴리스가 빌드 중입니다 — 공개 repo 라서 GitHub Actions 가 macOS/Windows/Linux 설치 파일을 자동 생성합니다.

### 2) 실행 후 — **3가지만 입력하면 바로 사용**

1. **Geny 서버 주소** — 기본값 `https://geny-x.hrletsgo.me` 가 채워져 있습니다 (직접 호스팅 중이면 그 주소).
2. **admin 아이디**
3. **admin 비밀번호**

→ **로그인** 하면 토큰이 OS 키체인에 저장되고 하단에 아바타가 떠서 바로 사용 가능합니다. (아바타 드래그 = 이동, 트레이 아이콘 = 설정/업데이트/종료)

### 자동 업데이트

v0.3.0 부터 접속기는 **GitHub Releases 를 통해 스스로 업데이트**합니다 — 실행 중 새 릴리스를 감지해 내려받고, 재시작 시 적용(트레이 → *업데이트 확인* 으로 수동 확인도 가능). Windows·Linux(AppImage) 는 무서명으로도 동작하며, macOS 자동 업데이트는 코드서명 이후 활성화됩니다. *한 번만 수동 설치하면 이후 버전은 자동.*

### 소스에서 직접 빌드

```bash
git clone https://github.com/CocoRoF/Geny.git
cd Geny/desktop
npm install
npm run dev          # 개발 실행
npm run dist:win     # / dist:mac / dist:linux — 설치 파일 직접 생성
```

자세히: [`desktop/README.md`](desktop/README.md) · 설계: [`dev_docs/vtuber-desktop/PLAN.md`](dev_docs/vtuber-desktop/PLAN.md)

---

## Geny 가 무엇인가

<img src="img/Geny_Charactor.png" align="right" width="200" alt="Geny 캐릭터"/>

| 개념 | 역할 |
|---|---|
| **VTuber 세션** | 대화의 얼굴. Live2D / Spine 아바타, 페르소나 prompt, TTS, 감정 tag. 사용자와 대화하고, 실제 작업은 짝지어진 Sub-Worker 에게 위임. |
| **Sub-Worker 세션** | 실행 레이어. tool 사용 agent — 파일/쉘/웹 fetch/MCP-bridge 호스트 tool 모두. 결과는 구조화된 `[SUB_WORKER_RESULT]` 메시지로 보고. |
| **Environment** | 21개 stage + provider + tool set 을 모두 핀하는 직렬화된 [`EnvironmentManifest`](docs/environments.md) artifact. 단일 artifact, 결정적 재생산. |
| **3D 도시 플레이그라운드** | Three.js / React Three Fiber 대시보드 — 세션이 절차적으로 생성된 도시를 걸어다니는 캐릭터로 표현. |
| **5개 LLM backend** | `anthropic` / `openai` / `google` / `vllm` (self-host) / `claude_code_cli` — env 단위로 선택, 코드 변경 없음. |
| **Stable error code** | 모든 executor 실패가 안정된 `exec.<component>.<reason>` 코드로 표면화. Frontend 가 한국어/영어 actionable 메시지로 i18n 렌더. |

Backend 는 [`geny-executor`](https://github.com/CocoRoF/geny-executor) 위에서 구축 — 21단계 manifest 기반 agent pipeline (LangChain 없음, LangGraph 없음). Frontend 는 Next.js 16 + R3F 기반 3D + Pixi.js (whiteboard / 2D overlay) + 한국어/영어 i18n.

---

## 아키텍처 (한 눈에)

<!-- 📸 IMAGE NEEDED: 아래 ASCII 맵을 대체/보완할 다이어그램 -->

```
┌────────────────────────── Geny ──────────────────────────────────┐
│                                                                  │
│  Frontend (Next.js 16 + R3F + Pixi)                              │
│   ├── 3D City Playground (Three.js / R3F)                        │
│   ├── VTuber chat panel + Live2D / Spine 아바타                  │
│   ├── Environment editor (21-stage manifest UI)                  │
│   ├── LLM Backends 설정 (5 provider 카드)                        │
│   ├── Memory / Knowledge / Whiteboard tab                        │
│   └── Logs tab (i18n 처리된 error code, tool trace, stage event) │
│                                                                  │
│  Backend (FastAPI)                                               │
│   ├── controller/  ← FastAPI routes (sessions, env, vtuber, …)   │
│   ├── service/                                                   │
│   │   ├── executor/    ← geny-executor 연결                      │
│   │   ├── gapt/        ← GAPT client + workspace provider        │
│   │   ├── environment/ ← manifest store + 템플릿                 │
│   │   ├── llm_patches/ ← 한국어 에러 envelope + CLI tool tap     │
│   │   ├── memory/      ← 세션 memory v2 + vector retrieval       │
│   │   ├── permission/  ← per-tool ACL 평가기                     │
│   │   ├── vtuber/      ← Live2D / Spine 라이브러리 + thinking-tg │
│   │   └── chat/        ← chat-room store + delegation 라우팅     │
│   ├── tools/  ← auto-load Python tool (send DM, memory, …)       │
│   ├── mcp/    ← auto-load MCP server config                      │
│   ├── scripts/geny_mcp_bridge.py ← CLI 용 per-session MCP wrap   │
│   └── prompts/  ← role markdown (vtuber.md, worker.md, …)        │
│                                                                  │
│  geny-executor ≥2.21  (PyPI 의존)                                │
│   ├── 21-stage agent pipeline                                    │
│   ├── 5개 LLM client 구현                                        │
│   ├── ContainerCLIRunner + SandboxHandle (샌드박스에서 CLI 실행)│
│   └── ExecutorErrorCode taxonomy                                 │
│                                                                  │
│  gapt/  ← GAPT submodule (샌드박스/devops 플랫폼)                │
│   ├── server/  FastAPI control plane (projects/workspaces/…)     │
│   ├── per-workspace 컨테이너 (git · fs · terminal · preview)    │
│   └── deploy pipeline (compose / ssh / webhook target)           │
└──────────────────────────────────────────────────────────────────┘
```

전체 아키텍처 문서 → [`docs/architecture.md`](docs/architecture.md).
Geny ⇄ GAPT 통합 → [`docs/analysis/gapt-integration-plan.md`](docs/analysis/gapt-integration-plan.md).

---

## 주요 기능

### 🎭 VTuber ↔ Sub-Worker pairing
모든 VTuber 세션은 자동으로 Sub-Worker 와 짝지어집니다. VTuber 는 대화와 페르소나를 담당, Sub-Worker 가 실제 작업. 위임은 단일 MCP-bridge tool (`mcp__geny__send_direct_message_internal`) 로 흐름 — [`docs/sessions.md`](docs/sessions.md) 참조.

### 🧠 5개 LLM backend, 하나의 selector
설정 → LLM 백엔드 에 5개 provider (Anthropic / OpenAI / Google / vLLM / Claude Code CLI) 각각 health probe + auth flow 카드 제공. 모든 environment 의 Stage 6 가 드롭다운으로 선택 — [`docs/providers.md`](docs/providers.md) 참조.

<!-- 📸 IMAGE NEEDED: 설정 → LLM 백엔드 — 5개 provider 카드 + health 상태 -->
> 📸 **이미지 필요** — _설정 → LLM 백엔드: 5개 provider 카드와 health 상태._

### 🛠️ Manifest 기반 environment
Pipeline 은 `EnvironmentManifest` JSON artifact 로 정의됨 — 21 stage, slot 마다 strategy 1개, 버전 관리. UI 의 environment editor 가 모든 preset (worker / VTuber / Sub-Worker) 을 코드 없이 customise 가능 — [`docs/environments.md`](docs/environments.md) 참조.

<!-- 📸 IMAGE NEEDED: Environment editor — 21단계 manifest UI + strategy 드롭다운 -->
> 📸 **이미지 필요** — _Environment editor: 21단계 manifest UI + strategy 드롭다운._

### 🌐 Per-session MCP wrap (Claude Code CLI)
세션이 `claude_code_cli` 를 Stage 6 backend 로 핀하면, Geny 는 per-session MCP bridge 를 attach 해 spawned CLI 의 LLM 이 **Geny 의 tool registry** 를 `mcp__geny__<tool>` 로 보게 함 — 파일 작업, web fetch, memory, blog publisher, sub-worker delegation 모두 CLI 의 agentic loop 안에서 native 호출 가능.

### 🏷️ Stable error code + i18n
모든 executor exception 은 안정된 `exec.<component>.<reason>` 코드를 carry. 세션 로그가 raw 영어 서버 에러 대신 한국어 메시지 + 권장 다음 단계를 렌더 — [`docs/error_codes.md`](docs/error_codes.md) 참조.

### 🏙️ 3D 도시 플레이그라운드
활성 세션이 절차적 Kenney-asset 도시 안에서 걸어다니는 캐릭터로 표현됨. A* pathfinding, 본 애니메이션, 시간대 사이클. R3F + Drei + Three.js.

<!-- 📸 IMAGE NEEDED: 3D 도시 플레이그라운드 — 절차적 도시를 걸어다니는 에이전트 + 시간대 조명 -->
> 📸 **이미지 필요** — _3D 도시 플레이그라운드: 절차적 도시를 걸어다니는 에이전트 + 시간대 조명._

### 🎨 Live2D + Spine + AI-bake 아바타
Geny 에 별도 puppet-editor 서비스 ([`geny-avatar`](https://github.com/CocoRoF/geny-avatar)) 가 git submodule 로 포함됨. Spine 또는 Cubism puppet 업로드, 레이어 분해, 마스크 페인팅, AI 텍스처 재생성, Geny 의 VTuber 라이브러리에 직접 bake.

### 🔊 TTS / STT / 음성 노트
출력은 edge-tts, 입력은 Whisper, 다화자 장면은 OmniVoice 통합. 음성 노트 기능으로 whiteboard 에 받아쓰기 가능.

### 📚 Knowledge whiteboard + Memory v2
세션 메모리가 `geny-executor` 의 Stage 2 (Context) + Stage 18 (Memory) 를 거침 — progressive disclosure, vault map, vector retrieval. Knowledge whiteboard 는 다이어그램 작업용 협업 Pixi.js 캔버스.

### 🤖 Multi-pod 지원
Redis 기반 세션 메타데이터 sharding 으로 여러 backend pod 가 한 사용자를 서빙 — 클라우드 배포에 유용.

### 📦 샌드박스 프로젝트 & 배포 (GAPT)
프로젝트 / 워크스페이스 / 샌드박스 / 배포는 **[GAPT](https://github.com/CocoRoF/geny-adapted-project-toolkit)** (`geny-adapted-project-toolkit`) 에 위임되며, [`gapt/`](gapt/) 에 **git submodule** 로 포함됩니다 (`main` 추적; `git pull` 시 [`.githooks/post-merge`](.githooks/post-merge) 로 자동 롤). GAPT 는 각 워크스페이스를 격리 컨테이너에서 실행하고 (git · 파일 작업 · 터미널 · dev-server 프리뷰 · compose/ssh 배포 타깃), Postgres 기반 + Caddy 라우팅. Geny 는 자체 에이전트 런타임(페르소나 · 음성 · 감정 · 메모리)을 유지하면서 executor 의 `ContainerCLIRunner` 로 세션을 GAPT 워크스페이스에 연결 — 에이전트는 샌드박스 안에서 코드를 편집하고, Geny 의 해자는 호스트 측에 그대로 남습니다. 에이전트는 GAPT 의 41-tool MCP 로 GAPT 를 직접 조종할 수도 있습니다. 설계: [`docs/analysis/gapt-integration-plan.md`](docs/analysis/gapt-integration-plan.md) · 배포 + 테스트: [`docs/operations/gapt-test-guide.md`](docs/operations/gapt-test-guide.md).

---

## 프로젝트 구조

```
geny/
├── README.md / README_ko.md          # 이 hub
├── img/                              # 로고/스크린샷
├── docs/                             # 주제별 문서 (architecture, sessions, …)
├── backend/                          # FastAPI + geny-executor 호스트
│   ├── main.py                       # 앱 entry + executor 연결
│   ├── pyproject.toml                # geny-executor >= 2.21.0 pin
│   ├── controller/                   # FastAPI routes
│   │   ├── agent_controller.py       # 세션 + 스트림 + invoke
│   │   ├── llm_backends_controller.py# 5 provider health + auth
│   │   ├── mcp_bridge_controller.py  # per-session MCP RPC
│   │   ├── vtuber_*.py               # VTuber 라이브러리 + chat + thinking
│   │   ├── memory_*.py               # memory + knowledge + opsidian
│   │   ├── chat_controller.py        # chat-room CRUD
│   │   ├── environment_controller.py # manifest editor backend
│   │   └── …                         # cron, whiteboard, voice-notes, …
│   ├── service/
│   │   ├── executor/                 # AgentSessionManager + AgentSession
│   │   ├── gapt/                     # GAPT client + workspace provider
│   │   ├── environment/              # manifest store + 템플릿
│   │   ├── llm_patches.py            # 한국어 에러 envelope + CLI tool tap
│   │   ├── memory/                   # 세션 memory v2
│   │   ├── permission/               # per-tool ACL
│   │   ├── vtuber/                   # Live2D / Spine 라이브러리 + trigger
│   │   ├── chat/                     # chat-room store + delegation
│   │   ├── config/                   # ConfigManager + 설정 카드
│   │   ├── logging/                  # SessionLogger (error_code 지원)
│   │   └── …
│   ├── tools/                        # auto-load Python tool
│   │   ├── built_in/                 # messaging, memory, knowledge
│   │   └── custom/                   # web_search, browser, whiteboard, blog
│   ├── mcp/                          # auto-load MCP server config
│   ├── scripts/geny_mcp_bridge.py    # CLI MCP wrap 용 stdio bridge
│   └── prompts/                      # role markdown (vtuber.md, worker.md, …)
├── frontend/                         # Next.js 16 + R3F + Pixi
│   └── src/
│       ├── components/               # tab, modal, panel, env_management/…
│       ├── lib/                      # api.ts, i18n/, modelCatalog.ts, …
│       ├── store/                    # Zustand store
│       └── types/                    # 공유 TypeScript type
├── vendor/geny-avatar/               # puppet-editor submodule
├── gapt/                             # GAPT git submodule (main 추적)
│   ├── server/                       # FastAPI control plane (projects/workspaces/…)
│   ├── compose/                      # GAPT compose stack (postgres/redis/caddy/…)
│   ├── docker/workspace/             # per-workspace 샌드박스 이미지
│   └── mcp/                          # GAPT 용 41-tool 에이전트 MCP
└── docker-compose.{yml,dev,prod}.yml # compose stack
```

개발자용 backend 내부 아키텍처 맵은 [`backend/docs/`](backend/docs/) 와 [`docs/architecture.md`](docs/architecture.md) 참조.

---

## 기술 스택

| Layer | 기술 |
|---|---|
| **Frontend** | Next.js 16, React 19, TypeScript, Tailwind CSS v4, Zustand 5, Pixi.js |
| **3D 엔진** | Three.js, React Three Fiber, Drei |
| **아바타** | Live2D Cubism, Spine 4, [geny-avatar](https://github.com/CocoRoF/geny-avatar) 에디터 |
| **Backend** | Python 3.11+, FastAPI, Uvicorn |
| **Agent pipeline** | [`geny-executor`](https://github.com/CocoRoF/geny-executor) (21 stage, 5 provider) |
| **LLM SDK** | `anthropic`, `openai`, `google-genai` + vLLM (OpenAI 호환) + Claude Code CLI subprocess |
| **MCP** | 호스트 attach 서버 + per-session CLI MCP wrap |
| **TTS / STT** | edge-tts (출력), Whisper (입력), OmniVoice (다화자) |
| **Persistence** | PostgreSQL (sessions, memory, knowledge), Redis (multi-pod 메타데이터, optional) |
| **Container** | Docker Compose (dev / prod 프로필 + OAuth 자격증명 생존을 위한 named volume) |

---

## 설치

### ⚡ 한 줄 설치 (추천) — `./geny up`

GPU·API 키·submodule 없이 가장 빠르게 띄우는 경량(lite) 경로입니다.

```bash
git clone https://github.com/CocoRoF/Geny.git
cd Geny
./geny up            # postgres + backend + frontend (GPU-free, 키 0개)
```

`./geny up`이 알아서: docker/compose 확인 → `.env` 시드(없으면 sample 복사) → 빌드·기동 → 백엔드 healthy 대기 → 접속 URL 안내. **http://localhost:3000** 접속 → 관리자 계정 생성 → **Settings → LLM 백엔드**에서:

- **로컬·키 0개**: Ollama를 켠 뒤 Ollama 카드에서 *모델 검색* → 바로 사용.
- **클라우드**: Anthropic / OpenAI / Google 키를 해당 카드에 붙여넣기.

기타 명령:

```bash
./geny up --full     # + 아바타 에디터(submodule) + 로컬 GPU TTS/STT (NVIDIA 필요)
./geny doctor        # 호스트 설정 진단 ( --fix 로 .env 시드·submodule 초기화 )
./geny logs backend  # 로그 추적
./geny update        # git pull + 재빌드 + 재시작
./geny down          # 정지
```

> lite 스택은 음성(TTS)이 클라우드 edge-tts로 동작합니다. 자체호스팅 고품질 음성(OmniVoice)·STT(Whisper)는 NVIDIA GPU가 있을 때 `./geny up --full`로 켜집니다.

### 🐳 Docker (수동)

```bash
# 1. submodule 포함 clone (gapt + geny-avatar + geny-licensed-assets)
git clone --recurse-submodules https://github.com/CocoRoF/Geny.git
cd Geny
# --recurse-submodules 없이 clone 했다면:
#   git submodule update --init --recursive
# main 추적 submodule (gapt, geny-avatar) 을 매 pull 마다 자동 롤:
#   git config core.hooksPath .githooks   # 1회; `submodule update --remote` 실행
# GAPT 를 최신 upstream main 으로 갱신:
#   git submodule update --remote gapt && git add gapt && git commit -m "chore: bump gapt"

# 2. 설정
cp backend/.env.example backend/.env
# backend/.env 편집 — 최소 ANTHROPIC_API_KEY 설정 (또는 Settings 의 OAuth 사용)

# 3. 실행
docker compose up --build
```

**http://localhost:3000** 접속.

Compose 프로필:

| 파일 | 용도 |
|---|---|
| `docker-compose.yml` | 기본 dev 스택 |
| `docker-compose.dev.yml` / `dev-core.yml` | hot-reload bind mount 가 있는 dev |
| `docker-compose.prod.yml` / `prod-core.yml` | nginx 뒤의 프로덕션 |

커스텀 port + 데이터 디렉토리는 [`docs/architecture.md`](docs/architecture.md) 참조.

### Manual 설정

비-Docker 개발은 [`docs/architecture.md`](docs/architecture.md) 의 확장 섹션 참조. 최소 요구사항: Python 3.11+, Node.js 18+, Claude Code CLI (`npm i -g @anthropic-ai/claude-code`), 최소 1개 provider 자격증명.

---

## Avatar Editor (geny-avatar)

Geny 에는 Next.js puppet-editor 서비스 ([`geny-avatar`](https://github.com/CocoRoF/geny-avatar)) 가 git submodule (`vendor/geny-avatar`) 로 포함돼 있습니다. Spine 또는 Cubism puppet 업로드, 레이어 분해, 마스크 페인팅, AI (gpt-image-2 / SAM) 텍스처 재생성, Geny VTuber 라이브러리에 직접 bake (`(Editor)` 접미사로 표시).

`vendor/geny-avatar` 는 버전 관리된 `post-merge` hook ([`.githooks/post-merge`](.githooks/post-merge)) 으로 `main` 을 추적 — 서버가 매번 `git pull` 마다 submodule 을 fast-forward 합니다.

```bash
git config core.hooksPath .githooks       # clone 마다 1회
git pull                                  # vendor/geny-avatar fast-forward
docker compose -f docker-compose.prod.yml --profile tts-local up -d --build avatar-editor backend
```

상세 통합 문서 → [`docs/_archive/`](docs/_archive/) (geny-avatar 통합 sprint).

---

## 환경 변수

`backend/.env` 에 설정:

| 변수 | 설명 | 기본값 |
|---|---|---|
| `APP_HOST` | 서버 bind 주소 | `0.0.0.0` |
| `APP_PORT` | 서버 port | `8000` |
| `DEBUG_MODE` | verbose logging | `false` |
| `ANTHROPIC_API_KEY` | Anthropic key (Settings OAuth 도 가능) | — |
| `OPENAI_API_KEY` | OpenAI key (Settings 에서 붙여넣기 가능) | — |
| `GOOGLE_API_KEY` | Google GenAI key | — |
| `GITHUB_TOKEN` | PR 자동화용 GitHub PAT | — |
| `USE_REDIS` | Redis multi-pod 메타데이터 활성화 | `false` |
| `REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD` | Redis | `localhost` / `6379` / — |
| `GENY_AGENT_STORAGE_ROOT` | 세션 저장 경로 | `/data/geny_agent_sessions` (Docker) |

Frontend 의 `API_URL` env (shell, build-time) 가 backend target 을 override — [`docs/architecture.md`](docs/architecture.md) 참조.

---

## 빠른 API 투어

Geny 는 `/api/` 아래에 REST + SSE 노출:

```bash
# VTuber 세션 생성 (Sub-Worker 자동 페어링)
curl -X POST http://localhost:8000/api/sessions \
  -H "Content-Type: application/json" \
  -d '{
    "session_name": "geny-1",
    "role": "vtuber",
    "env_id": "template-vtuber-env",
    "character_display_name": "Geny"
  }'

# 세션 리스트
curl http://localhost:8000/api/sessions

# VTuber 에게 메시지 (복잡 task 는 자동 Sub-Worker 위임)
curl -X POST http://localhost:8000/api/chat/rooms/<room_id>/messages \
  -H "Content-Type: application/json" \
  -d '{"content": "test.txt 만들어서 자기소개 적어놔"}'

# 세션 로그 스트림 (SSE)
curl -N http://localhost:8000/api/command/logs/<session_id>/stream
```

| Endpoint 그룹 | 용도 |
|---|---|
| `/api/sessions` | 세션 CRUD + status |
| `/api/agent/sessions/{id}/invoke` | one-shot invoke |
| `/api/command/logs/{id}/stream` | SSE 로그 스트림 (i18n 용 error_code 포함) |
| `/api/chat/rooms/*` | chat-room store (VTuber ↔ 사용자) |
| `/api/environments` | manifest CRUD + 템플릿 |
| `/api/llm-backends` | 5 provider health, auth, login flow |
| `/api/internal/mcp/{sid}/rpc` | per-session MCP bridge (CLI wrap) |
| `/api/vtuber/library` | Live2D / Spine 모델 레지스트리 |
| `/api/memory/*` | 세션 memory + knowledge whiteboard |

전체 API 레퍼런스 → backend 실행 중 `/docs` (FastAPI 자동 생성).

---

## 🔌 Tools & Skills

### DB 기반 커스텀 tool (UI 기반 — 추천)

Python 작성 없이 HTTP API 를 tool 로 등록 — **환경관리 → 커스텀 도구** 탭:

| Backend kind | 역할 |
|---|---|
| `http` | HTTP 요청 전송. URL/헤더/바디에 `${arg:foo}` / `${secret:KEY}` / `${session:session_id}` placeholder |
| `mcp_proxy` | upstream MCP 서버의 tool 을 새 이름 + 선택적 schema overlay 로 재노출 |
| `builtin_alias` | 기존 `backend/tools/custom/*_tools.py` Python tool 위 metadata overlay — Geny 는 `blog_agent_*` 패밀리를 이 방식의 샘플로 제공 |

전체 가이드 → [`docs/custom_tools.md`](docs/custom_tools.md).

`custom_tools` 테이블의 JSONB row 로 저장 (모델: [`backend/service/database/models/custom_tool.py`](backend/service/database/models/custom_tool.py)) 되고, 매 CRUD 변경 시 live `ToolLoader` 로 hot-reload — 프로세스 재시작 없음.

### MCP 서버 auto-load

`backend/mcp/` 에 `.json` 떨어뜨리면 env manifest 가 pull-in 한 모든 세션에서 사용 가능:

```jsonc
// backend/mcp/github.json
{
  "type": "http",
  "url": "https://api.github.com/mcp/",
  "description": "GitHub MCP server"
}
```

[`backend/mcp/README.md`](backend/mcp/README.md) 참조.

### Python tool auto-register

`backend/tools/custom/` 에 `*_tools.py` 떨어뜨리기:

```python
# backend/tools/custom/search_db_tools.py
from tools.base import tool

@tool
def search_database(query: str) -> str:
    """데이터베이스 검색"""
    return f"검색 결과: {query}"

TOOLS = [search_database]
```

[`backend/tools/README.md`](backend/tools/README.md) 참조. 더 풍부한 UX(설명/schema 편집/UI 에서 dry-run)는 위 **DB 기반 커스텀 tool** 경로 권장.

### Skills (SKILL.md)

세션마다 번들되는 슬래시 커맨드형 skill. Geny 는 여러 tier 제공:

- `executor` — `geny-executor` 자체에 번들.
- `geny` — 1st-party Geny skill (`backend/skills/bundled/`).
- `sample` — Geny 제공 *템플릿* (`backend/skills/samples/`), 자기 skill 로 복사해 사용.
- `user` — 운영자 제공 (`~/.geny/skills/`, `skills.user_skills_enabled` 로 opt-in).

**환경관리 → SKILLS** 탭에서 관리.

### Per-session MCP wrap (Claude Code CLI)

세션의 Stage 6 provider 가 `claude_code_cli` 일 때, Geny 는 stdio MCP bridge (`scripts/geny_mcp_bridge.py`) 를 통해 자신의 tool registry 를 spawned CLI 의 LLM 에 attach. CLI 의 LLM 이 `send_direct_message_internal`, `memory_write`, `web_search` 등을 `mcp__geny__<tool>` 로 보고 native 호출 가능 — 전체 흐름은 [`docs/sessions.md`](docs/sessions.md) 참조.

---

## 에러 핸들링 + i18n

모든 executor exception 이 안정된 [`ExecutorErrorCode`](https://github.com/CocoRoF/geny-executor/blob/main/docs/error_codes.md) (예: `exec.cli.auth_failed`) 를 carry. Backend 가 `SessionLogger` 를 거쳐 SSE payload 로 전달, frontend 가 `executor.<code>` i18n 룩업으로 한국어 메시지 + actionable 다음 단계를 렌더. raw 영어 서버 메시지 대신 사용자가 보는 것:

> Claude Code CLI 인증이 만료됐어요. 설정 → LLM 백엔드 → Claude Code (CLI) 카드의 ‘다시 로그인’을 누르거나 `ANTHROPIC_API_KEY` 를 붙여넣어 주세요.

전체 흐름 → [`docs/error_codes.md`](docs/error_codes.md).

---

## Cross-platform 지원

- **Windows**: `%LOCALAPPDATA%\geny_agent_sessions`, `.cmd`/`.exe` 자동 감지.
- **macOS / Linux**: `/tmp/geny_agent_sessions` (호스트) → `/data/geny_agent_sessions` (컨테이너).

---

## 커뮤니티

| 기여자 | 내용 | Link |
|---|---|---|
| <a href="https://github.com/SonAIengine"><img src="https://avatars.githubusercontent.com/u/166786347?v=4&s=48" width="48" height="48" alt="Son Seong Jun" title="Son Seong Jun"/></a> [`graph-tool-call`](https://github.com/SonAIengine/graph-tool-call) | Tool-Search-Logic 영감 | — |

---

## 관련 프로젝트

**Geny 에코시스템** — 위 [Geny 에코시스템](#-geny-에코시스템) 섹션 참조:

- [**geny-executor**](https://github.com/CocoRoF/geny-executor) — Geny backend 가 돌아가는 21단계 에이전트 파이프라인 (MIT)
- [**GAPT**](https://github.com/CocoRoF/geny-adapted-project-toolkit) — Geny 가 프로젝트 & 배포를 위임하는 샌드박스 / DevOps 플랫폼 (`gapt/` submodule)
- [**geny-avatar**](https://github.com/CocoRoF/geny-avatar) — Geny 에 아바타를 bake 하는 puppet 에디터 (`vendor/geny-avatar` submodule)

---

## 라이선스

MIT.

---

## 버전 히스토리

| 날짜 | 주요 변경 |
|---|---|
| 2026-05-22 | Doc 재정비 — README EN/KO, docs/* 주제별 문서 |
| 2026-05-22 | Phase 2: executor error code → frontend i18n (PR #830) |
| 2026-05-21 | geny-executor 2.1.0 — `ExecutorErrorCode` taxonomy + 구조화된 event payload |
| 2026-05-20 | geny-executor 2.0.6 — copilot_cli 제거 + compat patch 4종 upstream |
| 2026-05-19 | Phase I — claude_code_cli MCP wrap (per-session bridge + tool_use strip + observability tap) |
| 2026-04-29 | host_selections (env-scoped hook / skill / permission picker) |

전체 로그 → [GitHub commit history](https://github.com/CocoRoF/Geny/commits/main).

---

> _현재 사용자 모드: 한국어가 주 — 영어는 ENG 버튼으로 즉시 전환 가능._
