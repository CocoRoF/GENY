/** Tool detail — EnterWorktree (executor / worktree family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `EnterWorktree creates (or attaches to) a git worktree for a branch and pushes it onto the executor's WorkspaceStack. While the worktree is active, file-touching tools (Read, Write, Edit, Bash with relative paths, etc.) operate inside the worktree's filesystem and the worktree's branch — not the original CWD's branch.

The model is "branch into isolated workspace, work, exit cleanly". Two common scenarios:

  1. **Experimental work without polluting main**: \`branch: "exp/refactor-auth"\` creates a fresh worktree off the current HEAD. Edits land on the new branch; \`main\` is untouched until the agent merges or the user reviews.

  2. **Concurrent edits**: multiple sub-agents can each EnterWorktree on different branches and work in parallel without stepping on each other.

WorkspaceStack is a LIFO push/pop structure. EnterWorktree pushes; ExitWorktree pops. While the stack has entries, all path resolution (Read / Write / Bash / etc.) routes through the topmost worktree's CWD. The original CWD is preserved at the bottom of the stack and restored when the stack empties.

Existing worktrees: if a worktree for the requested branch already exists at a known location, EnterWorktree reuses it instead of creating a new one. Creates fresh from the current HEAD when the branch doesn't exist.`,
  bestFor: [
    'Branch-isolated experimental edits ("try this approach without committing to main")',
    'Sub-agent fan-out where each branch needs its own working tree',
    'Compare-then-merge workflows — work on a branch, exit, then diff against main',
  ],
  avoidWhen: [
    'You\'re only doing read operations — worktree overhead is wasted',
    'The repo isn\'t a git repo — EnterWorktree errors out',
    'You need uncommitted changes to follow you across branches — worktrees isolate them',
  ],
  gotchas: [
    'Forgetting ExitWorktree leaves the worktree active for the rest of the session — subsequent file ops go to the wrong tree.',
    'Uncommitted changes in the original CWD don\'t move to the new worktree. They stay in the original tree, isolated.',
    'The worktree directory is created adjacent to the main repo (typically `<repo>.worktrees/<branch>`). Disk usage adds up if many branches accumulate.',
    'Permissions / hooks evaluate against the WORKTREE\'s file paths, not the main repo\'s. Permission rules with absolute paths must account for the worktree base.',
  ],
  examples: [
    {
      caption: 'Branch off and start editing',
      body: `{
  "branch": "exp/auth-refactor"
}`,
      note: 'Creates (or reuses) a worktree at <repo>.worktrees/exp/auth-refactor; subsequent Read/Edit/Bash run there.',
    },
  ],
  relatedTools: ['ExitWorktree', 'Bash', 'Read', 'Write', 'Edit'],
  relatedStages: [],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/worktree_tools.py:EnterWorktreeTool + src/geny_executor/workspace.py:WorkspaceStack',
};

const ko: ToolDetailContent = {
  body: `EnterWorktree는 브랜치에 대한 git worktree를 생성(또는 attach)하고 실행기의 WorkspaceStack에 push합니다. worktree 활성 중에는 파일 다루는 도구(Read, Write, Edit, 상대 경로 Bash 등)가 원래 CWD의 브랜치가 아닌 worktree의 파일시스템과 worktree의 브랜치 안에서 동작.

모델은 "격리된 작업 공간으로 분기, 작업, 깔끔하게 종료". 두 가지 흔한 시나리오:

  1. **main 오염 없는 실험 작업**: \`branch: "exp/refactor-auth"\`가 현재 HEAD에서 새 worktree 생성. 편집은 새 브랜치에 land; \`main\`은 에이전트가 merge하거나 사용자가 리뷰할 때까지 unchanged.

  2. **동시 편집**: 여러 sub-agent가 각각 다른 브랜치에 EnterWorktree하고 서로 밟지 않고 병렬 작업 가능.

WorkspaceStack은 LIFO push/pop 구조. EnterWorktree는 push; ExitWorktree는 pop. 스택에 항목이 있는 동안 모든 경로 해석(Read / Write / Bash 등)이 최상단 worktree의 CWD를 통해 라우팅. 원래 CWD는 스택 바닥에 보존되고 스택이 비면 복원.

기존 worktree: 요청된 브랜치의 worktree가 알려진 위치에 이미 존재하면 EnterWorktree가 새로 만들지 않고 재사용. 브랜치가 없으면 현재 HEAD에서 새로 생성.`,
  bestFor: [
    '브랜치 격리 실험 편집("main 커밋 없이 이 접근 시도")',
    '각 브랜치가 자체 작업 트리 필요한 sub-agent fan-out',
    '비교 후 merge 워크플로 — 브랜치에서 작업, exit, main 대비 diff',
  ],
  avoidWhen: [
    '읽기 작업만 하는 경우 — worktree 오버헤드 낭비',
    'repo가 git repo 아님 — EnterWorktree 에러',
    '커밋되지 않은 변경이 브랜치 간 따라가야 하는 경우 — worktree가 격리시킴',
  ],
  gotchas: [
    'ExitWorktree 잊으면 worktree가 세션 나머지 동안 활성 — 후속 파일 작업이 잘못된 트리로 감.',
    '원래 CWD의 커밋 안 된 변경은 새 worktree로 이동 안 함. 원래 트리에 격리됨.',
    'worktree 디렉토리는 main repo 인접하게 생성(보통 `<repo>.worktrees/<branch>`). 많은 브랜치 누적 시 디스크 사용량 누적.',
    'Permissions / hooks가 main repo 아닌 WORKTREE의 파일 경로 기준으로 평가. 절대 경로 permission 규칙은 worktree base 고려.',
  ],
  examples: [
    {
      caption: '분기 후 편집 시작',
      body: `{
  "branch": "exp/auth-refactor"
}`,
      note: '<repo>.worktrees/exp/auth-refactor에 worktree 생성(또는 재사용); 후속 Read/Edit/Bash가 거기서 실행.',
    },
  ],
  relatedTools: ['ExitWorktree', 'Bash', 'Read', 'Write', 'Edit'],
  relatedStages: [],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/worktree_tools.py:EnterWorktreeTool + src/geny_executor/workspace.py:WorkspaceStack',
};

export const enterWorktreeToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
