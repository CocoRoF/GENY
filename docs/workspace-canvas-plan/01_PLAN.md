# 세션 Workspace + 문서 편집 + 파일 반환 + Canvas 탭 — 설계 계획서

> 작성일: 2026-07-02 · 대상: geny-executor + Geny
> 근거: 5방향 병렬 코드 조사 (executor workspace 서브시스템 / 업로드→에이전트 경로 / 파일 반환·렌더 경로 / 편집 툴체인 / 프론트 탭 아키텍처)

---

## 0. 한 줄 요약 (TL;DR)

세 요구(①세션별 워크스페이스 ②in-memory 편집 도구 ③파일 반환+채팅 표시)와 Canvas 탭은 **대부분의 기반이 이미 존재**하고, 끊어진 배선이 명확하다:

| 요구 | 이미 있는 것 | 끊어진 곳 (핵심 갭) |
|------|-------------|---------------------|
| ① 세션 워크스페이스 | `storage_path` 주입, Read/Write/Edit/Glob 파일도구+path guard, Storage 탭/API | 업로드 파일이 **세션 밖**(`/static/uploads` 전역)에만 저장됨. 비이미지 파일은 프롬프트에 `[attached file: …]` **플레이스홀더만** 주입 → 에이전트가 실제로 읽을 수 없음. "이 턴에 반드시 사용" 계약 없음 |
| ② 편집 도구 | SandboxExecTool, Geny 커스텀 툴 패턴, 파일도구 | **오피스 라이브러리 전무**(python-pptx/openpyxl/docx/Pillow 어디에도 없음), 렌더러(LibreOffice) 없음, working-copy(draft) 개념 없음 |
| ③ 파일 반환 | **executor `SendUserFileTool` + `UserFileChannel` ABC 이미 존재!** 프론트 `ChatAttachment` 스키마+`AttachmentList` 렌더러 완성, DB `attachments` 컬럼 존재, sha256 정적 서빙 존재 | **Geny가 `UserFileChannel`을 구현하지 않아 도구가 죽어있음.** 에이전트 메시지에 attachments가 한 번도 채워진 적 없음 |
| Canvas 탭 | 탭 레지스트리(`SESSION_TAB_DEFS`+`TAB_MAP`), `FileViewer`(md/html/code 50+언어), 폴링 패턴 | Canvas 탭 자체 + 오피스 파일 프리뷰(pptx→이미지 등) |

**전략**: 반환 경로(③)는 이미 있는 계약의 배선이므로 가장 싸고 먼저. 워크스페이스 규약(①)이 그 기반. 편집 도구(②)와 Canvas(④)는 그 위에.

---

## 1. 현황 진단 (조사 결과, file:line)

### 1.1 executor 워크스페이스 서브시스템 — 존재하지만 "cwd 스택"이지 "파일 보관소"가 아님
- `workspace/types.py:10-50` `Workspace`(cwd/branch/lsp/env) + `stack.py` `WorkspaceStack`(push/pop, worktree용) — **Environment>Workspace 탭이 보여주는 것은 이 cwd 스택**. 이번에 만들 "사용자 파일 보관소"와는 **다른 개념** (이름 충돌 주의).
- `tools/base.py:85-160` `ToolContext.storage_path` — 세션 저장 루트(`/data/geny_agent_sessions/<sid>`)가 이미 모든 도구에 주입됨 (`agent_session.py:2678-2683`).
- 파일 도구(Read/Write/Edit/Glob)는 `working_dir` 루트 + `_path_guard` 화이트리스트로 동작. **storage를 브라우징하는 전용 도구는 없음**.

### 1.2 업로드 → 에이전트 경로 — 이미지는 되고, 파일은 껍데기만
- 업로드: `POST /api/uploads` → sha256 content-addressed `/static/uploads/<shard>/<sha>.<ext>` (10MiB, 이미지+PDF/TXT/CSV/JSON/ZIP/DOCX/XLSX 허용) (`upload_controller.py:132-213`).
- 브로드캐스트 시 `file://` URI로 변환되어 executor로 전달 (`chat_controller.py:549-552`, `agent_session.py:3187-3193`).
- executor `s01_input`: **이미지는 vision 블록으로 정상 주입. 비이미지 파일은 `[attached file: name (mime)]` 텍스트 한 줄**(types.py:89, PDF document-block 전환은 TODO로 명시됨) → **pptx를 올려도 에이전트는 내용에 접근 불가**.
- 턴 이후: 업로드 파일은 전역 `/static/uploads`에 영존하지만 **세션 워크스페이스와 무관** — 에이전트가 나중에 도구로 접근할 경로가 없음.

### 1.3 파일 반환 경로 — 계약은 완성, 배선만 끊김 (최대 발견)
- executor: `operator_tools.py:189-238` **`SendUserFileTool`** — `ctx.extras["user_file_channel"]`(ABC, `channels/user_file_channel.py:20-28`)에 위임. **호스트(Geny)가 채널을 구현·주입하지 않아 현재 사용 불가.**
- Geny 프론트: `ChatAttachment` 타입(`types/index.ts:214-230`) + `AttachmentList`(`MessageList.tsx:38-88`, 이미지 인라인 + 파일 다운로드 링크) **이미 완성** — 유저 업로드에만 쓰이는 중.
- DB `chat_message.attachments` 컬럼 존재(`chat_message.py:26`), WS `message` 이벤트가 attachments 포함 dict 전송. **에이전트 메시지 저장부(`agent_executor.py:1405-1414` 등)가 attachments를 채운 적이 없을 뿐.**

### 1.4 편집 툴체인 — 전무
- executor venv / Geny backend venv / GAPT sandbox 이미지 어디에도 python-pptx·openpyxl·python-docx·Pillow·LibreOffice **없음**.
- ⚠️ 조사 보고서 정정: python-pptx는 슬라이드→이미지 **렌더링 불가**(그런 API 없음). pptx/docx **프리뷰 이미지는 LibreOffice headless(soffice)** 또는 외부 변환이 필요.

### 1.5 프론트 탭/프리뷰 — Canvas 재료 충분
- 탭 추가 = `TabNavigation.tsx:54-69` `SESSION_TAB_DEFS` + `TabContent.tsx:36-51` `TAB_MAP` + i18n `tabs.*` + `SectionIcons` 4곳.
- `FileViewer`(md/html/iframe/코드 50+언어/JSON) 재사용 가능. 바이너리는 placeholder뿐 → 이미지/PDF/오피스 프리뷰는 신규.
- 실시간 갱신: WorkspaceTab식 폴링(10s) 또는 WS. 시작은 폴링으로 충분.

---

## 2. 아키텍처 결정

### D1. 세션 워크스페이스 = `storage_path` 아래 디렉토리 규약 (신규 인프라 0)
```
/data/geny_agent_sessions/<sid>/workspace/
    uploads/    ← 유저가 올린 파일의 세션 사본 (턴 시점에 복사)
    drafts/     ← 작업중 사본(workspace-in-memory): drafts/<job>/ {원본사본, 편집본, preview/, manifest.json}
    out/        ← 완성·반환된 산출물
```
- 기존 Storage 탭/API(`/api/agents/{id}/storage`)가 그대로 브라우징·다운로드 제공. path guard로 이 루트에 한정.
- **이름 충돌 처리**: executor의 `WorkspaceStack`(cwd 스택)과 구분해 코드에서는 `files workspace`/`session_workspace`로 명명. Environment>Workspace 탭은 그대로.

### D2. "업로드 파일은 그 턴에 반드시 사용" = 세션 복사 + 강한 주입 계약
- **Geny(브로드캐스트 시)**: 첨부를 `workspace/uploads/`에 복사하고 attachment 페이로드에 `workspace_path` 필드 추가.
- **executor(s01_input)**: 비이미지 파일을 플레이스홀더 대신 → **(a)** PDF는 Anthropic document 블록(기존 TODO 해소), **(b)** 그 외는 "파일이 `workspace/uploads/<name>`에 저장됨. **이 턴에서 반드시 이 파일을 도구로 열어 처리하라**"는 지시 블록으로 주입. 이미지 vision 블록은 현행 유지.
- 이후 턴: 파일은 uploads/에 남고, 에이전트는 Read/Glob(+아래 ListWorkspace)으로 언제든 접근. (선택) 시스템 프롬프트에 vault-map처럼 워크스페이스 파일 몇 개를 한 줄 요약 주입.

### D3. 편집 도구 = Geny 백엔드 커스텀 툴 (sandbox 아님) + LibreOffice는 백엔드 이미지에
- **위치 결정**: GAPT sandbox 경유(파일을 base64로 넣고 빼는 오버헤드 + 컨테이너마다 pip install) 대신, **Geny 백엔드 커스텀 툴**(기존 `backend/tools/` 패턴)로. storage_path 직접 접근 가능, 의존성은 백엔드 이미지에 1회 설치.
  - `python-pptx + openpyxl + python-docx + Pillow` ≈ 50MB (requirements 추가)
  - `libreoffice --headless` + `poppler-utils(pdftoppm)` ≈ 400~600MB — **프리뷰 렌더(pptx/docx→pdf→png)의 유일한 현실적 로컬 경로**. 백엔드 이미지 1회 비용. (거부 시: 프리뷰 없는 편집만 먼저 — 결정 필요 §6-Q1)
- **도구 세트(1차)**: `doc_convert`(pptx/docx/xlsx→pdf/png/텍스트 추출), `pptx_edit`(텍스트 치환/슬라이드 텍스트박스/노트), `xlsx_edit`(셀/행 조작), `docx_edit`(문단/치환). 모두 draft 사본에만 작동. 범용 탈출구는 기존 python/sandbox 도구.
- **draft 규약**: 편집 요청 → `drafts/<job>/`에 사본 생성 → 편집 → `preview/`에 png 재생성 → 사용자 확인 → `out/`으로 확정(+반환). `manifest.json`(원본, 상태 editing/done, 갱신시각)이 Canvas 탭의 데이터 소스.

### D4. 파일 반환 = 기존 `SendUserFile`/`UserFileChannel` 계약을 Geny가 구현 (executor 무변경)
- Geny가 `UserFileChannel` 구현: 파일을 sha256으로 `/static/uploads`에 복사(기존 dedup 재사용) → `ChatAttachment` dict 생성 → 턴별 pending 버퍼에 적재.
- `agent_session`이 채널을 `extras["user_file_channel"]`로 주입, 턴 종료 시 pending attachments를 `ExecutionResult`→`store.add_message(attachments=…)`로 전달.
- **프론트 변경 ≈ 0** — `AttachmentList`가 에이전트 메시지의 attachments를 이미 렌더. WS도 이미 전달.
- 오토노머스 경로(`delivery.py post_autonomous_message`)에도 동일 필드 전파.

### D5. Canvas 탭 = 워크스페이스 브라우저 + draft 프리뷰
- 등록 4곳(§1.5). 아이콘 `SectionIcons.canvas`(Palette 등), i18n `tabs.canvas`.
- 레이아웃: 좌측 워크스페이스 트리(uploads/drafts/out, StorageTab 트리 재사용) + 우측 프리뷰:
  - md/코드/html/json → 기존 `FileViewer`
  - 이미지 → `<img>` (storage read를 바이너리 지원으로 확장 또는 정적 URL)
  - pptx/docx draft → `drafts/<job>/preview/*.png` 슬라이드 페이저
  - xlsx/csv → 서버 파싱(openpyxl)→JSON 테이블
- 활성 draft(manifest 기준 editing 상태)를 상단에 "지금 작업중" 밴드로. 갱신은 5s 폴링부터(추후 WS `file_changed`).

---

## 3. 단계별 로드맵 (각 단계 독립 배포·검증)

### Phase 1 — 파일 반환 배선 (③, 최소·최대 ROI, executor 무변경)
Geny `UserFileChannel` 구현 + `agent_session` 주입 + 턴 결과 attachments 수집 → `add_message`/WS → 채팅 렌더(기존). 오토노머스 경로 포함.
**검증**: 에이전트에게 "텍스트 파일 만들어서 보내줘" → 채팅에 다운로드 링크; 이미지 생성 → 인라인 프리뷰.

### Phase 2 — 세션 워크스페이스 + must-use 주입 (①)
Geny: 브로드캐스트 시 `workspace/uploads/` 복사 + `workspace_path` 필드. executor(마이너 릴리스): `s01_input` 파일 블록 개선(PDF document 블록 + must-use 지시) + `ListWorkspaceTool`(선택). Storage 탭은 자동으로 workspace/ 노출.
**검증**: pptx 업로드 → 에이전트가 그 턴에 파일 경로를 받고 도구로 읽음; 다음 턴에 "아까 그 파일" 접근 성공.

### Phase 3 — 편집 툴체인 (②)
백엔드 이미지에 python 라이브러리(+LibreOffice, Q1 승인 시). `doc_convert`/`pptx_edit`/`xlsx_edit`/`docx_edit` 커스텀 툴 + draft 규약(manifest).
**검증**: pptx 업로드 → "2번 슬라이드 제목 바꿔줘" → draft 생성·편집·프리뷰 png 재생성 → Phase 1 경로로 편집본 반환.

### Phase 4 — Canvas 탭 (④)
탭 등록 + 트리 + 타입별 프리뷰 + 활성 draft 밴드 + 폴링.
**검증**: Phase 3 편집 진행 중 Canvas에서 슬라이드 프리뷰 실시간(5s) 갱신 확인.

*(P1↔P2 순서는 독립적이라 병행 가능. P3는 P2 의존, P4는 P3 프리뷰 산출물 의존.)*

---

## 4. executor vs Geny 배치 (extend-executor 원칙)

| 변경 | 소속 | 릴리스 |
|------|------|--------|
| `s01_input` 파일 블록(PDF document + must-use 지시) | **executor** | 마이너 버전 (유일한 executor 변경) |
| `ListWorkspaceTool` (storage 브라우징, 선택) | **executor** | 〃 |
| `SendUserFileTool`/`UserFileChannel` | executor — **이미 존재, 무변경** | — |
| UserFileChannel 구현·주입, attachments 수집·저장 | Geny | — |
| uploads 세션 복사, workspace 규약, draft manifest | Geny | — |
| 문서 편집 툴 4종 + LibreOffice 렌더 | Geny (backend/tools) | 백엔드 이미지 재빌드 |
| Canvas 탭 | Geny (frontend) | — |

## 5. 리스크
- **LibreOffice 이미지 비대화**(~400-600MB): 백엔드 이미지 1회 비용이지만 빌드 시간↑. 대안 없음(로컬 프리뷰 렌더 필수 조건). 미승인 시 프리뷰 없이 편집·반환만.
- **대용량/악성 파일**: 10MiB 업로드 한도 기존 유지, 편집 도구는 draft 사본에만 작동 + path guard.
- **soffice 동시 실행**: 헤드리스 변환은 프로세스 락 필요(동시 변환 큐 1개로 직렬화).
- **executor 릴리스 절차**: PyPI publish → 핀 범프 → 재빌드 (기존 절차, simple-index 전파 대기 주의).
- **이름 충돌**: 기존 WorkspaceStack/Workspace 탭과 혼동 — 코드·문서에서 `session files workspace`로 일관 명명.

## 6. 결정 사항 (2026-07-02 사용자 확정)
- **Q1. LibreOffice 승인** — 백엔드 이미지에 설치(권장 docker-compose 실행 시 기본 포함). README에 LibreOffice가 문서 프리뷰의 권장 의존성임을 명확히 표기.
- **Q2. 반환 파일 = 세션 storage** — 세션이 만든 산출물이므로 `storage_path/workspace/out/`에 저장, 다운로드 URL은 세션 storage 엔드포인트 경유(세션 삭제 시 함께 소멸 — 의도된 수명).
- **Q3. Canvas 탭 항상 표시** — 워크스페이스 브라우저 겸용.
