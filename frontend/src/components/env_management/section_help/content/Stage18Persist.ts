/**
 * Help content for Stage 18 → Persistence slot.
 */

import type { SectionHelpContent, SectionHelpFactory } from '../types';

const en: SectionHelpContent = {
  title: 'Memory persistence',
  summary:
    "Where the memory strategy's output actually lives. Strategy decides WHAT to write; persistence decides WHERE — in-process Python state, on-disk JSON files, or nothing at all (ephemeral memory that vanishes on restart).",
  whatItDoes: `Once Stage 18's strategy has produced a memory artifact (raw transcript, reflective summary, structured insights), the persister stores it. Different persisters trade durability vs simplicity:

- **None** — no persistence, memory exists only for the lifetime of the current pipeline instance
- **In-memory** — Python dict on the registry, survives within the process but vanishes on restart
- **File** — JSON files on disk, survives restarts and can be read back across sessions

For production agents that should remember a user across sessions, you need **File** (or a custom persister talking to a real database).`,
  options: [
    {
      id: 'null',
      label: 'None',
      description: `No persistence. Memory exists only in the current pipeline's RAM. When the pipeline instance is garbage collected, memory is gone.

Default for stateless agents.`,
      bestFor: [
        'Stateless API endpoints',
        'Test pipelines',
        'Pair with `no_memory` strategy for true memorylessness',
      ],
      avoidWhen: [
        'You want any cross-session memory at all',
      ],
      codeRef:
        'geny-executor / s18_memory/artifact/default/persisters.py:NullPersister',
    },
    {
      id: 'in_memory',
      label: 'In-memory',
      description: `Memory lives in a Python dict on a process-wide registry. Survives within the process — multiple sessions on the same agent see the same memory store — but vanishes on process restart.

Useful for short-lived agents or local development where restart-survival isn\'t needed.`,
      bestFor: [
        'Short-lived processes (CI runs, scripts) where restart isn\'t a concern',
        'Local development — easier than file persistence, no disk artifacts',
        'In-process multi-session pipelines (one process, many users) where in-RAM is enough',
      ],
      avoidWhen: [
        'Production agents — restart wipes everything',
        'Multi-process / multi-host setups — in-memory is process-local',
      ],
      gotchas: [
        'Memory keys typically include session_id. Make sure your host generates stable session_ids if you want a session\'s memory to survive when the same user reconnects.',
      ],
      codeRef:
        'geny-executor / s18_memory/artifact/default/persisters.py:InMemoryPersister',
    },
    {
      id: 'file',
      label: 'File',
      description: `JSON files on disk. Each session\'s memory writes to \`{base_dir}/{session_id}.json\`. Atomic writes (temp file + os.replace) so partial files never appear.

Default \`base_dir\` is \`.geny/memory\` — relative to the working directory of the host process. Set explicitly for production deployments.`,
      bestFor: [
        'Production pipelines on a single host',
        'Local agents where memory should survive restart',
        'Anything where you want to grep / inspect / migrate memory between sessions',
      ],
      avoidWhen: [
        'Multi-host deployments — file persistence is local to the host',
        'High-concurrency setups — file locking semantics are minimal; concurrent same-session writes can race',
      ],
      config: [
        {
          name: 'base_dir',
          label: 'Base directory',
          type: 'string',
          default: '.geny/memory',
          description:
            'Filesystem path where session memory files are stored. Stored at `strategy_configs.persister.base_dir`. Relative paths resolve against the host\'s working directory.',
        },
      ],
      gotchas: [
        'Files are JSON-serialised — non-JSON-serialisable Python objects in the memory artifact will fail to write. The strategies all produce JSON-safe shapes; custom strategies should ensure the same.',
        'No size cap. Long sessions produce large JSON files. The persister doesn\'t prune old entries — that\'s the strategy\'s concern (or use append_only with caution).',
      ],
      codeRef:
        'geny-executor / s18_memory/artifact/default/persisters.py:FilePersister',
    },
  ],
  relatedSections: [
    {
      label: 'Strategy (previous slot in this stage)',
      body: 'Strategy decides shape; persistence decides location. Both required.',
    },
    {
      label: 'Stage 20 — Persist',
      body: 'Stage 20 persists pipeline-level checkpoints (state snapshots, audit logs). Stage 18 persists agent memory (insights, transcripts). Different concerns, similar mechanics — both can use file-based persistence.',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/stages/s18_memory/artifact/default/persisters.py',
};

const ko: SectionHelpContent = {
  title: '메모리 영속성 (Persistence)',
  summary:
    '메모리 전략의 출력이 실제로 어디 사는지. Strategy 가 무엇을 쓸지 결정; persistence 가 어디 — in-process Python state, on-disk JSON 파일, 또는 아무것도 (재시작 시 사라지는 임시 메모리).',
  whatItDoes: `18단계의 strategy 가 메모리 아티팩트 (raw 트랜스크립트, reflective 요약, 구조화 인사이트) 생산하면 persister 가 저장. 다른 persister 들이 durability vs simplicity trade:

- **None** — persistence 없음, 메모리가 현재 파이프라인 인스턴스 lifetime 동안만 존재
- **In-memory** — registry 의 Python dict, 프로세스 내에서 살아남지만 재시작 시 사라짐
- **File** — 디스크의 JSON 파일, 재시작 후에도 살아남고 세션 간 다시 읽을 수 있음

세션 간 사용자 기억해야 하는 프로덕션 에이전트는 **File** (또는 실제 데이터베이스와 talk 하는 커스텀 persister) 필요.`,
  options: [
    {
      id: 'null',
      label: '없음 (None)',
      description: `Persistence 없음. 메모리가 현재 파이프라인의 RAM 에만 존재. 파이프라인 인스턴스가 garbage collect 되면 메모리 사라짐.

상태 없는 에이전트의 기본값.`,
      bestFor: [
        '상태 없는 API 엔드포인트',
        '테스트 파이프라인',
        '진짜 메모리 없음을 위해 `no_memory` strategy 와 짝',
      ],
      avoidWhen: [
        '어떤 세션 간 메모리든 원할 때',
      ],
      codeRef:
        'geny-executor / s18_memory/artifact/default/persisters.py:NullPersister',
    },
    {
      id: 'in_memory',
      label: '인메모리 (In-memory)',
      description: `메모리가 프로세스 전역 registry 의 Python dict 에 살음. 프로세스 내에서 살아남음 — 같은 에이전트의 여러 세션이 같은 메모리 저장소 봄 — 하지만 프로세스 재시작 시 사라짐.

재시작 생존이 필요 없는 단기 에이전트나 로컬 개발에 유용.`,
      bestFor: [
        '재시작이 관심사 아닌 단기 프로세스 (CI 실행, 스크립트)',
        '로컬 개발 — 파일 persistence 보다 쉽고, 디스크 아티팩트 없음',
        'in-RAM 으로 충분한 in-process 멀티 세션 파이프라인 (한 프로세스, 많은 사용자)',
      ],
      avoidWhen: [
        '프로덕션 에이전트 — 재시작이 모든 것 wipe',
        '멀티 프로세스 / 멀티 호스트 setup — in-memory 는 프로세스 로컬',
      ],
      gotchas: [
        '메모리 키는 일반적으로 session_id 포함. 같은 사용자가 다시 연결할 때 세션의 메모리가 살아남길 원하면 호스트가 안정된 session_id 생성하는지 확인.',
      ],
      codeRef:
        'geny-executor / s18_memory/artifact/default/persisters.py:InMemoryPersister',
    },
    {
      id: 'file',
      label: '파일 (File)',
      description: `디스크의 JSON 파일. 각 세션의 메모리가 \`{base_dir}/{session_id}.json\` 으로 씀. 원자적 쓰기 (temp 파일 + os.replace) 로 partial 파일이 절대 나타나지 않음.

기본 \`base_dir\` 은 \`.geny/memory\` — 호스트 프로세스의 작업 디렉토리에 상대적. 프로덕션 배포는 명시적으로 설정.`,
      bestFor: [
        '단일 호스트의 프로덕션 파이프라인',
        '메모리가 재시작 후 살아남아야 하는 로컬 에이전트',
        '세션 간 메모리 grep / inspect / 마이그레이션 원하는 모든 것',
      ],
      avoidWhen: [
        '멀티 호스트 배포 — 파일 persistence 는 호스트 로컬',
        '고동시성 setup — 파일 락 의미론이 최소; 동시 같은 세션 쓰기가 race 가능',
      ],
      config: [
        {
          name: 'base_dir',
          label: '베이스 디렉토리',
          type: 'string',
          default: '.geny/memory',
          description:
            '세션 메모리 파일이 저장되는 파일시스템 경로. `strategy_configs.persister.base_dir` 에 저장. 상대 경로는 호스트의 작업 디렉토리에 대해 resolve.',
        },
      ],
      gotchas: [
        '파일은 JSON 직렬화 — 메모리 아티팩트의 non-JSON-serialisable Python 객체는 쓰기 실패. 모든 strategy 가 JSON-safe 모양 생산; 커스텀 strategy 도 같은 것 보장해야 함.',
        '크기 cap 없음. 장기 세션이 큰 JSON 파일 생산. Persister 가 오래된 항목 prune 안 함 — 그것은 strategy 의 관심사 (또는 신중하게 append_only 사용).',
      ],
      codeRef:
        'geny-executor / s18_memory/artifact/default/persisters.py:FilePersister',
    },
  ],
  relatedSections: [
    {
      label: '전략 (이 단계의 이전 슬롯)',
      body: 'Strategy 가 모양 결정; persistence 가 위치 결정. 둘 다 필요.',
    },
    {
      label: '20단계 — Persist',
      body: '20단계는 파이프라인 레벨 체크포인트 persist (state 스냅샷, 감사 로그). 18단계는 에이전트 메모리 persist (인사이트, 트랜스크립트). 다른 관심사, 비슷한 메커닉스 — 둘 다 파일 기반 persistence 사용 가능.',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/stages/s18_memory/artifact/default/persisters.py',
};

export const stage18PersistHelp: SectionHelpFactory = (locale) =>
  locale === 'ko' ? ko : en;
