# PR F2 — feat(frontend): LLM Backends panel — Claude Code login UX

| 항목 | 값 |
|---|---|
| Repo | `Geny` |
| Branch | `feat/llm-backend/f2-frontend-editors` (deleted) |
| Base SHA | `160d9f9` |
| PR # | [#780](https://github.com/CocoRoF/Geny/pull/780) |
| Merge SHA | `1c8674b` |
| Status | **merged** |

## 신규 컴포넌트

- `LLMBackendsPanel.tsx` — 6-card grid. Per-card:
  - status badge (Ready / Login required / Not configured)
  - detail line (e.g. `binary at /usr/local/bin/claude; version=...; auth=subscription`)
  - install_help 안내 (not ready일 때)
  - Re-check button (CLI provider만)
- SettingsTab 사이드바에 "LLM Backends" 가상 카테고리 추가 → panel swap.
- `lib/api.ts`에 `llmBackendsApi` (health / recheckClaudeCode / recheckCopilot / subagents) + types.

## End-to-end UX

1. Settings → Claude Code (CLI) 카드 → enabled 토글 + binary 경로 (자동탐지) + (선택) API key 붙여넣기
2. (구독 사용 시) 터미널에서 `claude auth login`
3. Settings → LLM Backends → Re-check → 카드가 Ready로 전환
4. Env Management에서 새 environment 생성 → Stage 6 provider를 `claude_code_cli`로 변경
5. VTuber / Worker session 시작 → 실제로 claude CLI subprocess가 LLM 호출 담당
