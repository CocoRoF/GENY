/** Tool detail — ExitWorktree (executor / worktree family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `ExitWorktree pops the topmost worktree off the WorkspaceStack and restores the previous CWD. After exit, file-touching tools resolve paths against whichever workspace is now on top — usually the original CWD, unless the agent had nested EnterWorktree calls.

Three exit options for uncommitted changes inside the worktree:
  - **stash** (default): \`git stash\` the changes; they survive in the worktree's stash list and can be popped later by re-entering the same worktree.
  - **discard**: hard reset — uncommitted changes are lost. Use only when you\'re certain the work is throwaway.
  - **keep**: leave the changes in the worktree as-is. Useful if another agent will continue the work later.

ExitWorktree does NOT delete the worktree directory itself. The worktree persists at \`<repo>.worktrees/<branch>\` until \`git worktree remove\` is run explicitly (usually via Bash). This is intentional — re-entering the same branch later picks up where you left off.

If the stack is empty (no active worktree), ExitWorktree returns success with a no-op.`,
  bestFor: [
    'Closing the EnterWorktree → work → ExitWorktree loop',
    'Stashing in-progress work before switching to a different worktree',
    'Discarding throwaway experimental work',
  ],
  avoidWhen: [
    'You\'re still working — exit when done, not mid-task',
    'You want to permanently remove the worktree directory — Bash `git worktree remove` after ExitWorktree, in two steps',
  ],
  gotchas: [
    'Default is stash — uncommitted work survives but isn\'t obviously visible. The agent should remember to re-enter and pop the stash later.',
    '`discard` is irreversible. The stash list isn\'t consulted; the changes are gone.',
    'The worktree directory persists. ExitWorktree without a follow-up `git worktree remove` leaves disk artefacts behind.',
    'Nested EnterWorktree calls require matched ExitWorktree calls. Skipping one leaves the wrong worktree on top of the stack.',
  ],
  examples: [
    {
      caption: 'Exit and stash uncommitted changes',
      body: `{
  "uncommitted": "stash"
}`,
      note: 'Stack pops; stash list inside the worktree gains a new entry the agent can pop on re-entry.',
    },
  ],
  relatedTools: ['EnterWorktree', 'Bash'],
  relatedStages: [],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/worktree_tools.py:ExitWorktreeTool',
};

const ko: ToolDetailContent = {
  body: `ExitWorktree는 WorkspaceStack의 최상단 worktree를 pop하고 이전 CWD를 복원합니다. exit 후 파일 다루는 도구는 현재 최상단 워크스페이스 기준으로 경로 해석 — 보통 원래 CWD(에이전트가 EnterWorktree를 중첩 호출하지 않았다면).

worktree 안의 커밋되지 않은 변경에 대한 세 가지 exit 옵션:
  - **stash**(기본): \`git stash\`로 변경사항을 worktree의 stash 리스트에 보존 — 같은 worktree 재진입 시 나중에 pop 가능.
  - **discard**: hard reset — 커밋되지 않은 변경 손실. 작업이 throwaway라고 확신할 때만 사용.
  - **keep**: 변경사항을 worktree에 그대로 둠. 다른 에이전트가 나중에 작업 이어갈 때 유용.

ExitWorktree는 worktree 디렉토리 자체를 삭제하지 않습니다. worktree는 \`<repo>.worktrees/<branch>\`에 영속, 명시적으로 \`git worktree remove\` 실행 시까지(보통 Bash로). 의도적 — 같은 브랜치 나중에 재진입 시 이어서 작업 가능.

스택이 비어있으면(active worktree 없음) ExitWorktree는 no-op으로 성공 반환.`,
  bestFor: [
    'EnterWorktree → 작업 → ExitWorktree 루프 종결',
    '다른 worktree로 전환 전 진행 중 작업 stash',
    'Throwaway 실험 작업 discard',
  ],
  avoidWhen: [
    '아직 작업 중 — 끝났을 때 exit, 작업 중간 아님',
    'worktree 디렉토리 영구 제거 원할 때 — ExitWorktree 후 Bash \`git worktree remove\`로 두 단계',
  ],
  gotchas: [
    '기본값이 stash — 커밋되지 않은 작업이 살아있지만 명확히 보이지 않음. 에이전트가 재진입 후 stash pop 기억해야 함.',
    '`discard`는 비가역. stash 리스트 참조 안 함; 변경사항이 사라짐.',
    'worktree 디렉토리는 영속. ExitWorktree 후 \`git worktree remove\` 후속 없으면 디스크 아티팩트 잔존.',
    '중첩 EnterWorktree 호출은 매칭되는 ExitWorktree 필요. 하나 skip하면 잘못된 worktree가 스택 최상단.',
  ],
  examples: [
    {
      caption: 'exit하고 커밋되지 않은 변경 stash',
      body: `{
  "uncommitted": "stash"
}`,
      note: '스택 pop; worktree 안의 stash 리스트에 에이전트가 재진입 시 pop할 수 있는 새 항목 추가.',
    },
  ],
  relatedTools: ['EnterWorktree', 'Bash'],
  relatedStages: [],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/worktree_tools.py:ExitWorktreeTool',
};

export const exitWorktreeToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
