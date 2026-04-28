/** Tool detail — opsidian_read (Geny / opsidian family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `opsidian_read returns the full markdown body of a specific Opsidian note. Use it to consume the user\'s actual notes — opinions, references, in-progress thoughts, project notes. Different from Read (filesystem): opsidian_read goes through the host\'s Opsidian integration which understands vault structure, frontmatter, and link resolution.

Returns:
  - The note body as raw markdown
  - Frontmatter (parsed YAML metadata if present)
  - Internal-link references (\`[[wikilinks]]\`) the agent can follow with subsequent opsidian_read calls

The agent should treat opsidian_read content as user-authoritative — much like a curated knowledge entry. Cite it back to the user when relevant ("you wrote in your X note that…").

Read-only. To save something into Opsidian, the user does it themselves. Geny\'s SendUserFile can deliver a generated markdown blob; the user copies it into their vault on their own terms.`,
  bestFor: [
    'Following up on an opsidian_browse hit',
    'Consuming the user\'s notes for grounded response building',
    'Following [[wikilinks]] across the user\'s knowledge graph',
  ],
  avoidWhen: [
    'You don\'t have a name — opsidian_browse first',
    'Looking at host-side curated knowledge — that\'s knowledge_*',
    'Wanting to write — Opsidian is read-only',
  ],
  gotchas: [
    'Returns raw markdown including frontmatter delimiters. Parse the yaml separately if needed.',
    '[[wikilinks]] are returned as-is. The agent decides whether to follow them — they\'re not auto-resolved into content.',
    'Sync lag — recently-edited notes may not be visible until the user\'s vault syncs.',
    'Some host configs return only the body, omitting frontmatter. Check the response shape against your deployment.',
  ],
  examples: [
    {
      caption: 'Read a specific Opsidian note',
      body: `{
  "name": "project-x/architecture-overview"
}`,
      note: 'Returns the full markdown body + frontmatter. [[wikilinks]] surface as raw text the agent can chase later.',
    },
  ],
  relatedTools: ['opsidian_browse', 'knowledge_read', 'Read'],
  relatedStages: ['Stage 18 (Memory)'],
  codeRef:
    'Geny / backend/tools/built_in/knowledge_tools.py:OpsidianReadTool',
};

const ko: ToolDetailContent = {
  body: `opsidian_read는 특정 Opsidian 노트의 풀 마크다운 body를 반환합니다. 사용자의 실제 노트 — 의견, 참조, 진행 중 생각, 프로젝트 노트 — 소비에 사용. Read(파일시스템)와 다름: opsidian_read는 vault 구조, frontmatter, 링크 해석을 이해하는 호스트의 Opsidian 통합 거침.

반환:
  - raw 마크다운으로 노트 body
  - Frontmatter(있으면 파싱된 YAML 메타데이터)
  - 에이전트가 후속 opsidian_read 호출로 follow 가능한 internal-link 참조(\`[[wikilinks]]\`)

에이전트가 opsidian_read 콘텐츠를 사용자 authoritative로 취급해야 — 큐레이션 지식 항목과 비슷. 관련 시 사용자에게 다시 인용("당신의 X 노트에 작성한 대로…").

Read-only. Opsidian에 무언가 저장하려면 사용자 본인이 함. Geny의 SendUserFile이 생성된 마크다운 blob 전달; 사용자가 자신의 조건으로 vault에 복사.`,
  bestFor: [
    'opsidian_browse 히트 follow-up',
    '근거 있는 응답 구축을 위해 사용자 노트 소비',
    '사용자 지식 그래프에서 [[wikilinks]] follow',
  ],
  avoidWhen: [
    '이름 없음 — 먼저 opsidian_browse',
    '호스트 측 큐레이션 지식 보기 — 그건 knowledge_*',
    '쓰기 원함 — Opsidian read-only',
  ],
  gotchas: [
    'Frontmatter delimiter 포함한 raw 마크다운 반환. 필요 시 yaml 별도 파싱.',
    '[[wikilinks]]는 그대로 반환. 에이전트가 follow 여부 결정 — 자동으로 콘텐츠로 resolve 안 됨.',
    'Sync lag — 최근 편집 노트는 사용자 vault sync 전까지 안 보일 수 있음.',
    '일부 호스트 설정은 body만 반환, frontmatter 생략. 배포에 대해 응답 형태 확인.',
  ],
  examples: [
    {
      caption: '특정 Opsidian 노트 읽기',
      body: `{
  "name": "project-x/architecture-overview"
}`,
      note: '풀 마크다운 body + frontmatter 반환. [[wikilinks]]는 에이전트가 나중에 chase 가능한 raw 텍스트로 표면화.',
    },
  ],
  relatedTools: ['opsidian_browse', 'knowledge_read', 'Read'],
  relatedStages: ['18단계 (Memory)'],
  codeRef:
    'Geny / backend/tools/built_in/knowledge_tools.py:OpsidianReadTool',
};

export const opsidianReadToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
