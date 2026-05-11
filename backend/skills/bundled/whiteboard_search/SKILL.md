---
name: whiteboard-search
description: 사용자가 자기 노트나 공유한 라이브러리에서 무언가를 찾으라고 할 때, opsidian_search → knowledge_search 의 올바른 사다리를 따라 검색하고 결과를 자연스럽게 요약한다.
allowed_tools:
  - opsidian_search
  - opsidian_browse
  - opsidian_read
  - knowledge_search
  - knowledge_list
  - knowledge_read
execution_mode: inline
examples:
  - "내가 옵시디언에 X 관련해서 적어둔 거 있어?"
  - "저번에 우리가 정리한 노트 다시 찾아줘"
  - "라이브러리에 뭐가 들어있는지 보여줘"
---

# Whiteboard Search — 사용자 노트 / 라이브러리 검색

사용자가 자기 노트나 공유된 라이브러리에서 무언가를 찾으라고 할 때 이 skill 을 사용한다.

## 두 종류의 저장소를 먼저 구분하라

- **User Opsidian** (개인 vault) — 사용자가 매일 작성하고 캡처하는 raw 노트. `opsidian_*` 도구로 접근. 카테고리: `inbox / daily / topics / projects / insights`.
- **Curated Knowledge** (라이브러리) — 사용자가 "Share with VTuber > Library" 로 명시 공유한, 정리된 subset. `knowledge_*` 도구로 접근. **너에게 가장 신뢰할 수 있는 출처다 — 사용자가 직접 골라 보낸 것이기 때문.**

## 검색 사다리 (Search Ladder)

사용자 요청이 모호하면 **둘 다** 시도하고 합친다:

1. **`opsidian_search(query, max_results=5)`** — 키워드 검색. 가장 빠르고 사용자의 raw 의도를 잘 잡는다.
2. 결과가 0~1 개이거나 score 가 낮으면 → **`knowledge_search(query, max_results=5)`** 로 curated 측 의미 검색.
3. 가장 가능성 높은 1~3 개 노트에 대해 **`knowledge_read(filename)`** 또는 **`opsidian_read(filename)`** 로 본문 확인.
4. 본문을 그대로 dump 하지 말고 **2~3 문장으로 요약** 하여 사용자에게 전달. 필요 시 핵심 인용 1~2 줄만.

## 사용자가 카테고리나 태그를 지정한 경우

- 카테고리 명시 ("내 daily 노트 중에…") → `opsidian_browse(category="daily")` 로 좁힌 뒤 그 안에서 검색.
- 태그 명시 ("#API 태그된 거…") → `opsidian_browse(tag="API")`.
- 두 도구의 결과를 받아 score 또는 recency 로 ranking 한 뒤 상위만 read.

## ViewLedger 의 `⚑` 마커 활용

- 시스템 프롬프트의 `[Spotlight Context]` 블록이나 tool 결과의 `_view.counts.read > 0` 인 노트는 **이미 본 자료**.
- 처음 본 듯 다루지 말고 "지난번 그 노트…" / "전에 같이 봤던 X에서…" 같은 맥락으로 잇는다.
- `_view.counts.injected` 가 높으면 spotlight 으로도 자주 등장한 핵심 노트 — 사용자가 중요시한다는 신호.

## 큰 vault 보호

`opsidian_search` 가 `"warning": "Vault has N notes; opsidian_search caps out at 500 …"` 응답을 주면:

- 사용자에게 "노트가 많아서 한 번에 다 못 봐 — 카테고리나 태그를 줄래?" 라고 정중히 묻고
- 응답 받으면 `opsidian_browse(category=..., tag=...)` 로 좁혀서 재시도.

## 결과 가공 규칙

- raw filename (`topics/foo.md`) 을 그대로 노출하지 말고 노트의 **title** 을 사용한다.
- JSON / frontmatter / raw wikilink 를 chat 에 그대로 붙여넣지 말 것.
- 결과가 0개면: "관련된 노트를 못 찾았어. 더 구체적인 키워드나 카테고리(daily/topics/projects/insights/inbox)를 알려주면 다시 찾아볼게."
- 결과가 매우 많으면 상위 3개만 요약하고 "더 보여줄까?" 로 끝낸다.

## 금기

- 한 turn 에 도구 5번 이상 호출 금지 — 매번 충분히 좁힌 후 호출.
- 본문 raw markdown 을 chat 에 그대로 붙여넣지 말 것 (특히 frontmatter, wikilink).
- 사용자에게 검색 결과를 JSON / table 로 보여주지 말 것 — 자연어 요약.
- `[Spotlight Context]` 블록의 내용을 사용자 발화로 착각하지 말 것 — 이건 시스템이 너에게 알려주는 상태일 뿐, 사용자가 방금 말한 것이 아니다.
