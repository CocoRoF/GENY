# 05 — Improvement plan: post-audit refactor

> *[04_AUDIT.md](04_AUDIT.md) 의 결함을 5개 작은 PR (Q1 ~ Q5) 로 묶는다. 각 PR 은 독립 출시 가능. 가장 큰 impact 부터.*

작성일: **2026-05-11**
선행: [04_AUDIT.md](04_AUDIT.md)

---

## 0. 우선순위 매트릭스

| Q | 한 줄 | 결함 카테고리 | 코드 변경 | 사용자 가치 | 추정 |
|---|---|---|---|---|---|
| **Q1** | Agent 가 화이트보드를 *발견* 할 수 있게 | 발견성 (1.1~1.5) | persona / config / template | 가장 큼 | 1일 |
| **Q2** | Organizer Accept 가 *실제로 실행* 되게 | 스펙/구현 미스매치 (2.C) | organizer.py + controller | 큼 (지금 dead feature) | 1일 |
| **Q3** | "공유한 것" 의 가시성과 lifecycle UI | UX (2.B, 2.E, 2.F) | 신규 컴포넌트 + 약간의 backend | 중 | 1.5일 |
| **Q4** | Library 공유의 첨부 / vector / provenance | 통합 (2.D, 3.1, 3.5) | controller + curated_knowledge_manager | 중 | 1일 |
| **Q5** | Inbox 카드 / 제목 / 출처 라벨 polish | UX polish (2.A, 1.4) | 컨트롤러 (title 생성) + Inbox UI | 작음 | 0.5일 |

순서: Q1 → Q2 → Q3 → Q4 → Q5. Q1 이 가장 leverage 큼 (도구가 발견되어야 나머지가 의미 있음).

---

## Q1 — Agent 가 화이트보드를 발견할 수 있게

### 목표
VTuber 가 *처음부터* 화이트보드 도구 5종을 알고, 언제 어느 것을 쓰는지 명확한 ladder 를 갖는다.

### 작업

**Q1.1 — Default flip + roster 통합**

- `LTMConfig.curated_knowledge_enabled` 기본값 **`False` → `True`** ([ltm_config.py:72](../../backend/service/config/sub_config/general/ltm_config.py#L72))
- VTuber 의 `_VTUBER_CUSTOM_TOOL_WHITELIST` 에 `whiteboard_describe`, `whiteboard_extract_links` 추가 ([templates.py:61](../../backend/service/environment/templates.py#L61))
- 한 줄 변경. 즉시 영향: VTuber roster 에 7+2 = 9 도구 (knowledge_search / read / list / promote, opsidian_browse / read / search, whiteboard_describe / extract_links)

**Q1.2 — 페르소나에 도구 ladder 박기**

[backend/prompts/vtuber.md](../../backend/prompts/vtuber.md) 에 새 섹션 추가:

```markdown
## Knowledge tools

The user maintains a personal vault (Opsidian) and a curated layer
(Curated Knowledge). When the user asks about their own notes, use
this ladder before guessing:

1. **`opsidian_search(query)`** — keyword search of the user's vault.
2. **`knowledge_search(query)`** — semantic + keyword search of the
   *curated* subset the user has explicitly promoted.
3. **`knowledge_read(filename)`** / **`opsidian_read(filename)`** —
   fetch a specific note once you know the filename.
4. **`whiteboard_describe(capture_id)`** — when an image is shared and
   you can't see it directly, get a text caption you can react to.
5. **`whiteboard_extract_links(filename)`** — pull every URL from
   a note's body.

When a `[Spotlight Context]` block lists items with ⚑ hints, you
have already seen those notes — continue the thread instead of
treating them as new. When a `[USER_SHARED]` trigger fires, the
user has just shared something specific; reach for whiteboard_*
tools to enrich your reaction.
```

**Q1.3 — `PERSONA_GUIDANCE` 항상 노출**

[spotlight_block.py:68](../../backend/service/whiteboard/spotlight_block.py#L68) 의 조건부 append 제거. 빈 spotlight 일 때도 페르소나가 spotlight 개념을 알 수 있게. 또는 위 Q1.2 의 ladder 안에 통합.

**Q1.4 — `[USER_SHARED]` 트리거 페이로드 보강**

[user_shared_trigger.py:34](../../backend/service/whiteboard/user_shared_trigger.py#L34) `_compose_trigger_prompt` 에:
- 비전 가능 모델 → image content block 첨부
- 비전 비가용 모델 + image attachment → **자동으로 `whiteboard_describe` 결과 (이미 P4 PostCaptureHook 이 caption 만듦)** 를 prompt 에 inline

이러면 1.1 의 default-on roster 와 결합하여 비전 비가용 모델도 첫 turn 에 image 내용 인지 가능.

### DoD
- [ ] VTuber default 세션의 도구 list 에 `whiteboard_describe` / `whiteboard_extract_links` 포함 (단위 테스트로 검증)
- [ ] 새 vtuber 세션 첫 prompt 에 도구 ladder 가 시스템 텍스트로 들어감
- [ ] Spotlight 없는 상태에서도 페르소나가 spotlight 개념을 알고 있음
- [ ] 비전 비가용 모델로 screenshot 공유 → 다음 turn 에 caption inline (placeholder 가 아님)

### 위험
- `vtuber.md` 길이 증가 → 작은 모델 컨텍스트 압박. 측정 후 ladder 를 별도 prompt block (`HostKnowledgeToolsBlock`) 으로 분리 가능

---

## Q2 — Organizer Accept 가 실제로 실행되게

### 목표
사용자가 Accept 를 누르면 카드만 사라지는 게 아니라 **제안된 `proposed_action` 이 진짜로 일어난다**.

### 작업

**Q2.1 — `apply_suggestion(suggestion)` 분기 헬퍼**

신규 `backend/service/whiteboard/organizer_apply.py`:

```python
async def apply_suggestion(username: str, suggestion: OrganizationSuggestion) -> Dict[str, Any]:
    action = suggestion.proposed_action
    if action == "promote_to_library":
        # 신규: P2a fix 의 share_to_library 와 동일 경로 재사용
        # for each note in suggestion.note_filenames → write to curated
        ...
    elif action == "group":
        # 사용자가 cluster label 을 카테고리 또는 태그로 받음
        # for each note → mgr.update_note(filename, tags=[*old_tags, suggestion.proposed_label])
        ...
    elif action == "merge":
        # 두 노트의 본문을 하나로 합치고 다른 하나는 archive
        # 보수적: 합치는 대신 둘 다 같은 태그로 묶고 사용자가 직접 정리
        ...
    elif action == "archive":
        # 노트를 archive/ 카테고리로 이동 (또는 frontmatter 에 archived:true)
        ...
    elif action == "tag":
        # tags 에 proposed_label 추가
        ...
    return {"applied": True, "action": action, "affected": [...]}
```

5개 액션 모두 *명시적* 구현. 사양 보존: Organizer 자체는 propose 만, 이 헬퍼가 실제 실행.

**Q2.2 — `organizer_accept` 가 apply 호출**

[whiteboard_controller.py:906](../../backend/controller/whiteboard_controller.py#L906) 의 `organizer_accept` 가 update_status 직후 `apply_suggestion` 호출. 반환에 `applied: {...}` 추가.

**Q2.3 — Undo / Revert 옵션 (보너스)**

사용자가 accept 후 결과가 마음에 안 들면 되돌리고 싶을 수 있음. 작은 시작: `apply_suggestion` 이 변경 전 상태 (affected note 들의 메타) 를 audit log 에 기록 → 사용자가 "지난 organize 되돌리기" 1회.

이건 Q5 또는 별도 PR 로 미룰 수 있음. 우선 Q2.1 + Q2.2.

### DoD
- [ ] 5개 action (group/merge/promote_to_library/archive/tag) 모두 apply 코드 경로 존재
- [ ] Accept 후 노트 메타가 실제로 변경됨 (단위 테스트로 affected note 의 tags / category 확인)
- [ ] frontend SuggestionsBar accept 응답에 `applied` 페이로드 표시 (toast: "Grouped 5 notes as 'API debugging'")

### 위험
- `merge` 액션이 destructive — 안전 보수적 구현 (두 노트 모두 보존 + 같은 태그) 권장
- audit log 로그 부풀음 가능 — 그래서 Undo 는 작은 scope 로

---

## Q3 — 공유 이력의 가시성과 lifecycle UI

### 목표
사용자가 "내가 무엇을 공유했고, 지금 무엇이 활성 spotlight 인지, 어떻게 unsare 하는지" 를 한눈에 본다.

### 작업

**Q3.1 — 활성 Spotlight 패널**

신규 `frontend/src/components/user-opsidian/ActiveSpotlightsPanel.tsx`:
- `GET /api/opsidian/spotlight` 호출하여 활성 항목 list
- 각 항목: title + session_id + TTL countdown + "Unpin" 버튼 (`DELETE /api/opsidian/spotlight/{id}`)
- VTuber 채팅 패널 옆 또는 user-opsidian 사이드바 footer

**Q3.2 — Inbox 카드 + Note editor 의 "공유됨" 배지**

- Inbox 카드 — 캡처가 한 번이라도 Library / Spotlight 된 적 있으면 작은 배지 ("📚" / "🎯" / 둘 다)
- Note editor 헤더 — 같은 배지
- 데이터 출처: `_captures.jsonl` 의 share 이력 또는 ViewLedger 또는 신규 `_share_log.jsonl`

**Q3.3 — Curated 측 "Where from" 라벨**

curated 노트 viewer 가 `frontmatter.source` 를 읽어 `"📚 From inbox/foo.md by you"` / `"⚙️ Auto-curated"` 라벨 표시. 클릭 가능 → user opsidian 의 origin 으로 이동 (origin 이 아직 존재할 때).

### DoD
- [ ] VTuber 화면 (또는 user-opsidian 사이드바) 에 활성 spotlight 패널 — countdown 자동 갱신
- [ ] Inbox 카드와 노트 헤더에 공유 이력 배지
- [ ] Curated 노트 viewer 상단에 출처 라벨 + origin 으로 jump

### 위험
- countdown 업데이트가 1초 간격이면 re-render 부담 → 30초 간격으로 충분
- 공유 이력 저장소 위치 결정 — 가장 단순: SpotlightStore 의 in-memory + audit log 이미 있는 `_captures.jsonl` 확장

---

## Q4 — Library 공유의 첨부 / vector / provenance 보강

### 목표
사용자가 "Library 로 공유" 누르면, VTuber 가 그 노트를 즉시 search 할 수 있고, 이미지가 안 깨지며, 자동 vs 명시 차이를 사용자가 식별할 수 있다.

### 작업

**Q4.1 — 첨부 copy on Library promote**

[whiteboard_controller.py share_to_library](../../backend/controller/whiteboard_controller.py) 가 body 의 `![[file.png]]` wikilink 를 파싱 → 각 첨부를 `_user_opsidian/_attachments/` 에서 `_curated_knowledge/_attachments/` 로 복사. 신규 wikilink 는 curated path 를 가리키도록 rewrite.

`CuratedKnowledgeManager` 에 `attachments_dir` / `save_attachment` 헬퍼 추가 (기존 user 측과 동일 패턴).

`/api/curated/attachments/{path}` 엔드포인트도 추가 (또는 attachment URL builder 가 vault kind 별 분기).

**Q4.2 — Vector reindex 즉시 실행**

`share_to_library` 가 write 직후 `curated_mgr.provider.vector().reindex_one(filename)` 또는 동등한 호출. share 후 5초 안에 `knowledge_search` 가 결과를 반환해야 함.

**Q4.3 — `meta.source` 를 first-class 메타로**

`CuratedKnowledgeManager._meta_to_dict` 가 `source: "curated"` 로 hardcode 하는 부분 ([curated_knowledge.py:144](../../backend/service/memory/curated_knowledge.py#L144)) 수정 — frontmatter 의 진짜 `source` 값 반영. UI 가 그 값을 라벨로 사용 가능.

신규 query param `?source=share:*` 로 promoted 노트만 필터.

**Q4.4 — Library unshare 엔드포인트**

`POST /api/opsidian/library/{curated_filename}/unshare` — curated 노트 삭제 + 첨부 GC + vector clean. UI 에서 Curated note viewer 에 "Remove from Library" 버튼 노출 (사용자가 직접 공유한 노트에 한해).

### DoD
- [ ] 이미지 있는 노트를 Library 공유 → curated 측 viewer 에서 이미지 즉시 렌더
- [ ] share 5초 내 `knowledge_search` 가 그 노트 발견
- [ ] curated 노트 list 에서 `source` 별 필터 가능 (사용자 명시 / 자동 / 기타)
- [ ] Library 공유한 노트를 사용자가 unshare 할 수 있음 → vector / 첨부 정리

### 위험
- 첨부 복사로 디스크 사용량 ~2배 (user + curated 양쪽) — 옵션: hardlink 사용 (`os.link`) 으로 한 binary 만 보관
- vector reindex 동기 호출이 share 응답 지연시킴 → background task 로 분리하고 결과 polling 가능

---

## Q5 — Inbox 카드 / 제목 / Promote 단축

### 목표
화이트보드가 매일 쓰는 도구가 되려면 카드 grid 가 scannable 해야 함. 작은 polish 묶음.

### 작업

**Q5.1 — 캡처 제목 enrichment**

[whiteboard_controller._default_title_for](../../backend/controller/whiteboard_controller.py) 가 timestamp 만이 아니라 capture source / dimensions / OCR snippet (P4 도구 활용) 포함:
- screenshot: 이미지 dimensions + window title metadata (가능하면)
- text: 첫 줄 ≤ 40자 prefix
- audio: duration ("12 s audio capture")
- 자동 caption 이 있으면 그 첫 문장

**Q5.2 — 카드 type 아이콘 풍부화**

[InboxPanel.tsx:421](../../frontend/src/components/user-opsidian/InboxPanel.tsx#L421) — 첨부 유무 / 캡처 source / 공유 이력을 미니 아이콘으로:
- 📸 screenshot / 📋 clipboard / 📁 file
- 🔗 if URLs in body
- 📚 / 🎯 if already shared

**Q5.3 — Inbox 카드의 quick-actions**

카드 hover 시 inline 버튼 노출: "Share Library" / "Share Spotlight" / "Discard" — 클릭 → 4단계가 아닌 1 클릭에 share.

**Q5.4 — SuggestionsBar 가 cluster note list 전체 표시**

[SuggestionsBar.tsx:284](../../frontend/src/components/user-opsidian/SuggestionsBar.tsx#L284) — 노트 수 6 이상일 때 "+ N more" 만 보임. 대신 expand/collapse 토글 추가.

### DoD
- [ ] Inbox 카드 제목이 timestamp + content hint
- [ ] 카드에 작은 메타 아이콘 (3종): source / 공유 이력 / 첨부 종류
- [ ] hover 시 quick-share 버튼 1 클릭 가능
- [ ] SuggestionsBar 의 cluster 가 모든 멤버 노트를 펼쳐서 볼 수 있음

### 위험
- 카드 정보 과부하 — 미니 아이콘만, hover 시에만 추가 정보. 카드 시각 복잡도 ≤ 4 elements

---

## 통합: 작업 순서와 의존성

```
Q1 (발견성)  ──┐
              ├──► Q3 (가시성) ──► Q4 (첨부/vector) ──► Q5 (polish)
Q2 (실행)    ──┘
```

- Q1, Q2 는 독립 — 병렬 가능
- Q3 는 Q1 ("페르소나가 공유 이력 본다") 와 약하게 결합
- Q4 는 Q1.1 (curated default-on) 의 후속 — 활성화된 curated 가 비어있으면 effect 없음
- Q5 는 모두 끝난 후 polish

각 Q 는 **별도 PR + merge** 사이클. P0 ~ P5 의 원래 phased approach 와 동일 리듬.

---

## 비목표 / 후속 (별도 사이클)

| 항목 | 이유 |
|---|---|
| Round-trip (curated 편집 → user vault sync) | 두 store 간 synchronisation 은 별도 design 필요 |
| Curated 내부의 자동 정리 (Organizer 의 curated 버전) | 일단 user vault 만 |
| 협업 (멀티 사용자 화이트보드) | 인증 / 권한 모델 별도 |
| 자유 캔버스 (Excalidraw) | P0 의 `drawing` enum slot 만 갖춤 |
| 음성 메모 자동 전사 | P0 의 `audio` enum + `register_post_capture_hook('audio', whisper_hook)` 자리 |

이들은 모두 *기존 후크 위에서* 구현 가능하므로 후속 사이클에서 코어 변경 없이 시작 가능.

---

## 검증 / 측정 지표

각 Q 머지 후 정량적 / 정성적 측정:

| 지표 | 도구 | 기대 |
|---|---|---|
| Tool call hit rate | ViewLedger `searched` / `read` 카운트 | Q1 후 증가 |
| Organizer accept → 실제 효과 | UI 에 toast + audit log entry | Q2 후 100% 실행 |
| Active spotlight 가시성 | 사용자 1명 watch session | Q3 후 즉시 보임 |
| Share 후 search 성공률 | share → 5초 후 knowledge_search 호출 | Q4 후 ≥ 95% |
| Inbox 카드 scan time (사용자 본인 reported) | 비공식 | Q5 후 < 3초 / 카드 |

---

## 다음 행동

1. 이 plan 검토 / 우선순위 confirm (사용자)
2. **Q1 부터** 시작 — 가장 leverage 큼
3. 각 Q 마다: branch → 변경 → pytest + npm build → PR → merge
4. 5 Q 모두 끝나면 짧은 "post-improvement audit" 한 번 더 (regression 확인)

이 plan 의 결함도 사이클이 지나면 다시 audit 받을 수 있음. 그것이 정상.
