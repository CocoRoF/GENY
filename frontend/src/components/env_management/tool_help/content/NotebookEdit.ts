/** Tool detail — NotebookEdit (executor / filesystem family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `NotebookEdit operates on Jupyter notebook files (\`.ipynb\`). Notebooks are JSON containing a list of cells; this tool gives the agent cell-level granularity instead of forcing the round-trip through Edit on the raw JSON (which is brittle because of cell metadata, output blobs, and nbformat version drift).

Three modes:
  - \`replace\` (default): swap the source of the cell at \`cell_index\` with \`new_source\`
  - \`insert\`: insert a new cell at \`cell_index\` (existing cells shift down)
  - \`delete\`: remove the cell at \`cell_index\`

Cells have a \`cell_type\` (\`code\` / \`markdown\` / \`raw\`). The tool preserves cell type by default; pass an explicit \`cell_type\` only when changing it.

Outputs are NOT touched. The tool edits source only — execution metadata, output blocks, execution_count etc. survive verbatim. To reset outputs, the agent should run the notebook (e.g. via Bash + \`jupyter nbconvert --to notebook --execute\`) or use a separate cleanup pass.

cell_index is 0-based. Out-of-range indices return errors rather than silently appending — this is intentional so the agent doesn't pile junk cells at the end of a notebook.`,
  bestFor: [
    'Editing a specific cell of a notebook the user is iterating on',
    'Inserting a setup / teardown cell at a known index',
    'Removing a stale cell without re-writing the whole notebook',
  ],
  avoidWhen: [
    'Editing a regular Python file — use Edit, not NotebookEdit',
    'Reformatting cell outputs — the tool doesn\'t touch outputs',
    'Wholesale notebook rewrite — Write is more honest about the size of the change',
  ],
  gotchas: [
    'cell_index is 0-based and out-of-range errors out instead of appending.',
    'Outputs are preserved across edits — to clear them, execute the notebook separately.',
    'Cell type isn\'t inferred from content; pass cell_type if you\'re converting code → markdown or vice versa.',
    'JSON Schema strict — extra fields in new_source are dropped silently.',
  ],
  examples: [
    {
      caption: 'Replace cell 3 with new code',
      body: `{
  "notebook_path": "/repo/analysis.ipynb",
  "cell_index": 3,
  "new_source": "import pandas as pd\\ndf = pd.read_csv('data.csv')\\ndf.head()"
}`,
      note: 'Source replaced; output of the previous run survives until re-execution.',
    },
  ],
  relatedTools: ['Read', 'Write', 'Bash', 'REPL'],
  relatedStages: ['Stage 10 (Tools)'],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/notebook_edit_tool.py:NotebookEditTool',
};

const ko: ToolDetailContent = {
  body: `NotebookEdit는 Jupyter 노트북 파일(\`.ipynb\`)을 다룹니다. 노트북은 셀 리스트를 포함하는 JSON; 이 도구는 셀 메타데이터, 출력 blob, nbformat 버전 drift 때문에 brittle한 raw JSON에 대한 Edit 우회 대신 에이전트에게 셀 레벨 granularity를 제공합니다.

세 모드:
  - \`replace\`(기본): \`cell_index\` 셀의 source를 \`new_source\`로 교체
  - \`insert\`: \`cell_index\`에 새 셀 삽입(기존 셀 아래로 shift)
  - \`delete\`: \`cell_index\` 셀 제거

셀은 \`cell_type\`(\`code\` / \`markdown\` / \`raw\`)이 있습니다. 도구가 기본적으로 셀 타입을 보존; 변경할 때만 명시적 \`cell_type\` 전달.

출력은 건드리지 않습니다. 도구는 source만 편집 — 실행 메타데이터, 출력 블록, execution_count 등은 그대로 유지. 출력 리셋은 에이전트가 노트북을 실행하거나(예: Bash + \`jupyter nbconvert --to notebook --execute\`) 별도 cleanup 패스 수행해야 함.

cell_index는 0-based. 범위 밖 인덱스는 silent append 대신 에러 반환 — 의도적, 에이전트가 노트북 끝에 정크 셀을 쌓지 못하도록.`,
  bestFor: [
    '사용자가 반복 작업 중인 노트북의 특정 셀 편집',
    '알려진 인덱스에 setup / teardown 셀 삽입',
    '전체 노트북 재작성 없이 stale 셀 제거',
  ],
  avoidWhen: [
    '일반 Python 파일 편집 — NotebookEdit 말고 Edit 사용',
    '셀 출력 reformat — 도구가 출력을 건드리지 않음',
    '노트북 전체 재작성 — Write가 변경 규모에 더 정직',
  ],
  gotchas: [
    'cell_index는 0-based이며 범위 밖이면 append 대신 에러.',
    '편집 간 출력이 보존됨 — 클리어하려면 별도로 노트북 실행.',
    '내용에서 셀 타입 추론하지 않음; code → markdown 변환 등이면 cell_type 전달.',
    'JSON Schema strict — new_source의 extra 필드는 silent drop.',
  ],
  examples: [
    {
      caption: '셀 3을 새 코드로 교체',
      body: `{
  "notebook_path": "/repo/analysis.ipynb",
  "cell_index": 3,
  "new_source": "import pandas as pd\\ndf = pd.read_csv('data.csv')\\ndf.head()"
}`,
      note: 'source 교체; 이전 실행의 출력은 재실행 전까지 보존.',
    },
  ],
  relatedTools: ['Read', 'Write', 'Bash', 'REPL'],
  relatedStages: ['10단계 (Tools)'],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/notebook_edit_tool.py:NotebookEditTool',
};

export const notebookEditToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
