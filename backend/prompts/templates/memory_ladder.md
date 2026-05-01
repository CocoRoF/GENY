## Recalling Your Memory

도구로만 메모리에 접근하세요. 시스템 프롬프트엔 본문이 들어 있지 않습니다 — 이 ladder 는 모든 role 에 공통이며 지도와 도구 사용법만 안내합니다.

### 빠른 점검
1. `memory_status(category?, tag?)` — vault 의 카테고리·태그·최근 갱신 요약. 어디부터 볼지 결정용.

### 검색 → 읽기 (가장 자주 쓰는 path)
2. `memory_search(query, category?, kind?, counterpart?, limit?)`
   — 후보 filename·점수·1-line snippet 만 반환. **본문은 안 옴.**
   카테고리 권장 (plan §1.5):
   - `conversations` — 특정 turn 의 verbatim 본문 (가장 정확). 매 record_message 가 자동 작성.
   - `dms` — 카운터파트별 일일 묶음 인덱스. wikilink 로 conversations/ 를 가리킴.
   - `insights` — LLM 이 distill 한 정제 지식.
   - `topics` / `MEMORY` / `projects` — 사람이 작성한 narrative.
   - `compactions` — context compaction 이 발생했던 기록.
3. `memory_read(filename)` — 본문 전체 읽기. step 2 결과의 filename 을 그대로 전달.

### 카운터파트 / Stream 탐색
4. `memory_with(counterpart, kinds?, limit?, since?)` — 카운터파트별 InteractionEvent 리스트.
5. `memory_event(event_id)` — 특정 이벤트의 raw payload + linked parent.
6. `memory_artifact(event_id, path)` — 그 이벤트가 만든 파일의 raw 내용.

### 쓰기 / 정리
7. `memory_write(title, content, category?, tags?)` — 새 노트 작성. category 는 보통
   `topics` / `projects` / `insights`. **`conversations` / `dms` / `compactions` / `daily-journal` 는 자동 카테고리이므로 직접 쓰지 마세요.**
8. `memory_link(source, target)` — wikilink 추가.
9. `memory_distill(counterpart, update_note?)` — 카운터파트의 conversations/ 를 LLM 으로
   요약 → `insights/counterpart-<id>.md` 갱신 (옵션) 또는 `insights/<slug>.md` 작성.

### 원칙
- 본문이 필요하다 싶을 때만 `read` 하세요. 그 전엔 `status`/`search` 로 지도만.
- `conversations/` 는 leaf source-of-truth 입니다 — 어떤 turn 의 정확한 글자가 필요하면 거기를 보세요.
- `dms/`, `daily-journal/` 는 인덱스이고 본문은 conversations/ 에 있어요.
- `insights/` 는 distill 된 결론입니다 — 정확한 사실은 conversations/ 가 정답.
- 시스템 프롬프트의 `## Vault Map` 섹션이 카테고리·태그·최근 갱신을 요약합니다 — 매 턴 자동 갱신되니 거기서 시작하세요.
