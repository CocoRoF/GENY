# GAPT ⇄ Geny ⇄ geny-executor — 상호작용 구조 & 테스트 가이드

설계 리포트([`../analysis/gapt-integration-plan.md`](../analysis/gapt-integration-plan.md))의
실무 짝 문서입니다. **(1) 세 컴포넌트가 실제로 어떻게 맞물려 돌아가는지(어떤 도구·호출·네트워크를
쓰는지)**와 **(2) 라이브(`:2222`)에서 테스트하는 방법**을 설명합니다.

---

## 0. 한눈에 — 역할 분담

| 컴포넌트 | 책임 | 위치 |
|---|---|---|
| **geny-executor** | 에이전트 파이프라인 + **샌드박스 "실행" 프리미티브** (CLI/툴을 컨테이너 안에서 `docker exec`로 실행) | PyPI 의존성 (`>=2.23.0`) |
| **GAPT** | 프로젝트/워크스페이스/샌드박스 **플랫폼** (컨테이너 라이프사이클·git·fs·터미널·preview·deploy, Postgres) | Geny **git submodule** `Geny/gapt/`, 2222에 자체 스택 |
| **Geny** | 에이전트 런타임(페르소나·음성·감정·메모리) + **GAPT에 위임**(프로젝트/샌드박스) | `Geny/backend` |

핵심 원칙: **Geny의 해자(페르소나·음성·감정·메모리)는 호스트에 그대로 두고, "코드 실행"만 GAPT
워크스페이스 컨테이너 안으로 옮긴다.**

---

## 1. 상호작용 메커니즘 (어떤 도구를 쓰나)

세 가지 채널로 맞물립니다. ① Geny→GAPT **HTTP API**, ② Geny→워크스페이스 **docker exec**,
③ 워크스페이스→Geny **MCP 브리지**.

### ① Geny → GAPT 제어 평면 : HTTP (`/_gapt/api/**`)
- 도구: **`GaptClient`** (`backend/service/gapt/client.py`, httpx 비동기).
- 인증: 단일 admin **세션 쿠키** — `POST /_gapt/api/auth/login {id,password}` → 쿠키.
  (GAPT가 쿠키를 `Secure`로 굽기 때문에 내부 http 홉에서 httpx jar가 버림 → **쿠키를 수동으로
  헤더에 실어** 보냄. gapt-mcp와 동일 전략.)
- 네트워크: geny-backend가 **`gapt-net`**에 합류 → `http://gapt-server:8088/_gapt/api/...` 직접 호출.
- 쓰는 곳: **`GaptWorkspaceProvider`** (`provider.py`) 가 세션마다 프로젝트(`geny`)/워크스페이스
  (`<session_id>`)를 **get-or-create** (`list_projects`/`create_project`/`list_workspaces`/
  `create_workspace`/`wait_workspace_running`).

### ② Geny → 워크스페이스 컨테이너 : `docker exec`
- 도구: geny-executor의 **`ContainerCLIRunner`** + 내장 툴 샌드박스(`tools/_sandbox.py`).
- 전제: geny-backend가 **`/var/run/docker.sock`** 마운트 + **`docker` CLI 바이너리** 보유
  (backend Dockerfile에 `COPY --from=docker:28-cli`). 그래서 호스트 데몬에 직접 `docker exec`.
- 형태: `docker exec -i -w /workspace --env … gapt-ws-<wid> <cmd>`
  - `claude_code_cli` 백엔드 → `<cmd>` = `claude <argv>` (CLI 자체가 컨테이너 안에서 자기 툴 실행).
  - SDK 백엔드(anthropic/openai/…) → 내장 **bash/read/write/edit/grep/glob** 툴이 각자
    `cat`/`tee`/`bash -lc`/`grep`/globstar 를 컨테이너 안에서 실행.
- 워크스페이스 컨테이너(`gapt-ws-<wid>`)는 **sysbox-runc** 런타임으로 떠서 커널 수준 격리.

### ③ 워크스페이스 → Geny : MCP 브리지 (Geny 고유 툴)
- `claude_code_cli` 세션에서 Geny 고유 툴(메모리·DM·whiteboard 등)은 CLI의 **MCP 설정**
  (`mcp_config`, `build_container_cli_client`가 그대로 전달)이 `geny_mcp_bridge`를 띄워
  geny-backend의 `/api/internal/mcp/{sid}/rpc`로 HTTP 콜백하는 구조.
- 컨테이너가 `gapt-net`(+ geny 네트워크)에 있어 geny-backend에 도달 가능. (브리지 URL/토큰을
  컨테이너 env로 주입하는 것이 전제 — 라이브 세션에서 점검 권장. 파일/셸 실행 자체는 ①②로
  이미 검증됨.)

### geny-executor의 세 가지 seam (어떻게 "끼워넣는가")
- `SandboxHandle` (Protocol): `container_name` + 비동기 `ensure()` 만 있으면 됨. GAPT의
  `WorkspaceSandbox`와 Geny의 `GaptSandboxHandle` 둘 다 충족.
- `Pipeline.attach_runtime(sandbox=handle)` 한 줄이면:
  - (CLI 경로) 자격증명 번들에서 resolve한 `claude_code_cli` 클라이언트를 `ContainerCLIRunner`로
    **자동 래핑** — api_key·mcp_config·allow_tools 등 **이미 계산된 kwargs 재사용**(호스트가 재구현 X).
  - (SDK 경로) 같은 sandbox를 **Tool 스테이지에도 stamp** → 내장 fs/셸 툴이 컨테이너에서 실행.
- 게이트: `ToolContext.sandbox`가 없으면(기본) **바이트 단위로 기존 호스트 실행과 동일** → 일반
  채팅 무영향.

### 데이터 흐름 (세션 1개 기준)
```
Geny 세션 생성 (GENY_GAPT_WORKSPACES=1)
  │
  ├─① GaptWorkspaceProvider.ensure_workspace
  │     └─ GaptClient → GAPT: 프로젝트(geny)/워크스페이스(session_id) get-or-create
  │     └─ GaptSandboxHandle(container = gapt-ws-<wid>)  반환
  │
  ├─  AgentSession._build_pipeline → pipeline.attach_runtime(sandbox = handle)
  │     └─ executor: claude_code_cli 클라이언트를 ContainerCLIRunner로 래핑
  │                 + Tool 스테이지 context.sandbox = handle (SDK 경로용)
  │
  └─  매 턴:
       ├─② handle.ensure() → GaptClient → GAPT가 gapt-ws-<wid> 를 docker run(sysbox)으로 기동
       ├─② docker exec -w /workspace gapt-ws-<wid> …   (docker.sock 경유)
       │     ├─ CLI 백엔드:  claude <argv>            (CLI가 컨테이너서 자기 툴 실행)
       │     └─ SDK 백엔드:  bash/cat/tee/grep …      (내장 툴이 컨테이너서 I/O)
       └─③ (선택) 컨테이너 안 Geny 고유 툴 → MCP 브리지 → geny-backend
```
→ 에이전트의 **Read/Write/Edit/Bash/grep/glob/git**이 전부 `gapt-ws-<wid>`의 `/workspace`
안에서 일어남. Geny 메모리/페르소나/음성은 호스트 쪽 그대로.

---

## 2. 테스트 방법

### 2a. GAPT 웹 UI (Geny 도메인 뒤에서)
- **UI:** `https://geny-x.hrletsgo.me/_gapt/app/`
- **로그인:** id `admin`, 비번 = 호스트의 `deploy/gapt/.env`의 `GAPT_ADMIN_PASSWORD`:
  ```bash
  ssh -p 2222 hrjang@116.47.69.209 \
    "sudo grep GAPT_ADMIN_PASSWORD /home/hrjang/docker_web/Geny/deploy/gapt/.env"
  ```
- UI에서 프로젝트 생성 → 워크스페이스(샌드박스 컨테이너) 생성 → 파일 브라우저/터미널/dev 서버/
  preview/deploy 까지 GAPT 전체 기능 사용 가능.

### 2b. Geny 세션을 GAPT 워크스페이스 안에서 실행 (핵심, opt-in)
기본 OFF라 기존 채팅 무영향. 호스트에서 플래그만 켭니다:
```bash
ssh -p 2222 hrjang@116.47.69.209
cd /home/hrjang/docker_web/Geny
sudo sed -i '/^GENY_GAPT_WORKSPACES=/d' .env; echo 'GENY_GAPT_WORKSPACES=1' | sudo tee -a .env
sudo docker compose -f docker-compose.prod.yml up -d --no-deps backend
sudo docker network connect gapt-net geny-backend-prod 2>/dev/null || true
```
그다음 Geny UI/접속기에서:
1. 새 **Agent 세션** 생성 (claude_code_cli **또는** anthropic/openai 백엔드 — 둘 다 샌드박싱됨).
2. *"hello.txt 파일에 'from the sandbox'라고 쓰고 디렉토리 목록 보여줘"* 요청.
3. 파일이 **호스트가 아니라 GAPT 워크스페이스 안**에 생겼는지 확인:
   - GAPT UI → `geny` 프로젝트 → 세션 id 워크스페이스 → Files → `hello.txt`, 또는 호스트에서:
     ```bash
     sudo docker ps --format '{{.Names}}' | grep '^gapt-ws-'
     sudo docker exec <gapt-ws-...> ls -la /workspace
     ```
4. geny-backend 컨테이너 파일시스템엔 안 생겼는지 확인(에이전트는 자기 `/workspace`만 봄).

**끄기:** `.env`에서 `GENY_GAPT_WORKSPACES=0` 후 backend 재생성. 플래그가 켜져 있어도 GAPT가
다운이면 프로비저닝이 best-effort라 **호스트 실행으로 폴백**하므로 켜둬도 안전.

### 2c. UI 없이 직접 검증 (executor 실제 경로 그대로)
```bash
# 워크스페이스 프로비저닝 + 컨테이너 기동 (executor의 spawn 직전 단계)
sudo docker exec geny-backend-prod sh -lc 'cd /app && python -c "
import asyncio
from service.gapt import get_gapt_client, GaptWorkspaceProvider
async def main():
    c = get_gapt_client()
    h = await GaptWorkspaceProvider(c).ensure_workspace(project_slug=\"geny\", workspace_name=\"manual-test\")
    await h.ensure()
    print(h.container_name)
    await c.aclose()
asyncio.run(main())
"'
# ContainerCLIRunner가 하는 것과 똑같이 컨테이너 안으로 exec:
WS=$(sudo docker ps --format '{{.Names}}' | grep '^gapt-ws-' | tail -1)
sudo docker exec geny-backend-prod docker exec -w /workspace "$WS" sh -c 'echo hi; pwd; whoami; claude --version'
sudo docker inspect -f '{{.HostConfig.Runtime}}' "$WS"   # → sysbox-runc
# → hi / /workspace / ubuntu / 2.1.x (Claude Code) — 전부 샌드박스 안
```

### 2d. 테스트 워크스페이스 정리
```bash
sudo docker exec geny-backend-prod sh -lc 'cd /app && python -c "
import asyncio
from service.gapt import get_gapt_client
async def main():
    c=get_gapt_client()
    projs=await c.list_projects(); items=projs.get(\"projects\") if isinstance(projs,dict) else projs
    pid=next((p[\"id\"] for p in items if p.get(\"slug\")==\"geny\"), None)
    wss=await c.list_workspaces(pid); wl=wss.get(\"workspaces\") if isinstance(wss,dict) else wss
    for w in wl or []:
        if w[\"name\"].startswith(\"manual-test\"):
            await c.delete(f\"/_gapt/api/workspaces/{w[\"id\"]}\"); print(\"deleted\", w[\"name\"])
    await c.aclose()
asyncio.run(main())"'
```

---

## 3. 구성요소 위치 (코드 레퍼런스)

| 무엇 | 어디 |
|---|---|
| ContainerCLIRunner / SandboxHandle / build_container_cli_client | `geny-executor` `llm_client/_cli_runtime.py`, `claude_code.py` |
| `attach_runtime(sandbox=)` → CLI 래핑 + Tool stage stamp | `geny-executor` `core/pipeline.py` (`_build_client_for`, `_set_tool_stage_sandbox`) |
| SDK 툴 샌드박싱 (bash/read/write/edit/grep/glob) | `geny-executor` `tools/_sandbox.py` + `tools/built_in/*` |
| GaptClient / GaptWorkspaceProvider / GaptSandboxHandle | `Geny/backend/service/gapt/` |
| 세션 배선 (프로비저닝 + sandbox 전달) | `Geny/backend/service/executor/agent_session_manager.py`, `agent_session.py` |
| GAPT 워크스페이스 컨테이너 + 런타임 | `Geny/gapt/server/.../domains/workspace_sandbox/manager.py` (`--runtime`) |
| GAPT 스택 배포 (Geny nginx 뒤) | `Geny/deploy/gapt/docker-compose.geny.yml`, `Geny/gapt/compose/docker-compose.tunnel.yml` |
| nginx `/_gapt`·`/preview` 라우트 | `Geny/nginx/nginx.conf` |

배포/호스트 운영 절차는 [`gapt-deploy.md`](gapt-deploy.md) 참고.
