/**
 * Help content for Stage 20 → Persister slot.
 */

import type { SectionHelpContent, SectionHelpFactory } from '../types';

const en: SectionHelpContent = {
  title: 'Checkpoint persister',
  summary:
    "Where the per-turn checkpoint actually goes. Stage 20's frequency policy decides WHEN to write; the persister decides WHERE. The two stage-18-and-20 storage layers are independent — Stage 18 stores agent memory, Stage 20 stores pipeline-state checkpoints.",
  whatItDoes: `A **checkpoint** is a snapshot of pipeline state at the end of a turn — \`state.iteration\`, \`state.messages\`, \`state.metadata\`, \`state.shared\`, \`state.completion_signal\`, \`state.total_cost_usd\`, etc. Hosts use checkpoints to:

- resume a session from a known-good state
- audit "what did the pipeline look like at turn 7?"
- replay scenarios from a recorded snapshot

The persister stores the \`CheckpointRecord\` produced by Stage 20. The frequency policy (next slot) decides whether to write each turn.`,
  options: [
    {
      id: 'no_persist',
      label: 'None',
      description: `No-op persister. Returns \`None\` from every \`write()\` call. Stage 20 still runs (frequency check, event emission) but no actual storage happens.

Default for pipelines that don't need cross-restart resumability.`,
      bestFor: [
        'Stateless API endpoints',
        'Test pipelines',
        'Pipelines where Stage 18 (memory) is the only persistent layer needed',
      ],
      avoidWhen: [
        'You need session resume on restart — `file` persister or a custom backend',
      ],
      codeRef:
        'geny-executor / s20_persist/artifact/default/persisters.py:NoPersister',
    },
    {
      id: 'file',
      label: 'File',
      description: `JSON file per checkpoint. Files live at \`{base_dir}/{session_id}/{checkpoint_id}.json\`. Atomic writes (tempfile + os.replace) so partial files never appear. Per-session subdirectories keep listing cheap.

Default \`base_dir\` is \`.geny/checkpoints\`. Production deployments should set this explicitly to a known path with appropriate permissions.`,
      bestFor: [
        'Production agents on a single host with disk',
        'Local development — easy to inspect / grep / migrate',
        'Anything where session resume after restart is a requirement',
      ],
      avoidWhen: [
        'Multi-host deployments — file persister is local-only',
        'High-concurrency pipelines — file lock is a single threading.Lock, fine for one process but doesn\'t coordinate across processes',
      ],
      config: [
        {
          name: 'base_dir',
          label: 'Base directory',
          type: 'string',
          default: '.geny/checkpoints',
          required: true,
          description:
            'Filesystem root for checkpoint files. Per-session subdirectories created automatically. Stored at `strategy_configs.persister.base_dir`.',
        },
      ],
      gotchas: [
        '`session_id` may be empty in some test setups — files then go under `_unknown/`. Production should always have stable session IDs.',
        'No retention policy. Old checkpoint files accumulate forever unless the host runs a cleanup. Stage 20 doesn\'t prune.',
        'Listing checkpoints involves scanning every session directory. For very-many-session deployments this can get slow — host-side indexing helps.',
      ],
      codeRef:
        'geny-executor / s20_persist/artifact/default/persisters.py:FilePersister',
    },
  ],
  relatedSections: [
    {
      label: 'Frequency (next slot in this stage)',
      body: 'Persister stores checkpoints; frequency decides which turns get checkpointed. Pair `file` + `every_n_turns` for periodic snapshots, `file` + `on_significant` for event-driven snapshots.',
    },
    {
      label: 'Stage 18 — Memory persistence',
      body: 'Stage 18 stores agent memory; Stage 20 stores pipeline checkpoints. Different layers, different purposes — Stage 18 = "what the agent learned", Stage 20 = "what the pipeline state was".',
    },
    {
      label: 'Pipeline.resume()',
      body: 'Hosts call `Pipeline.resume(checkpoint_id)` to restore from a checkpoint. Without a persister actually writing, there\'s nothing to resume from.',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/stages/s20_persist/artifact/default/persisters.py',
};

const ko: SectionHelpContent = {
  title: '체크포인트 영속자 (Persister)',
  summary:
    '턴별 체크포인트가 실제로 어디 가는지. 20단계의 빈도 policy 가 WHEN 결정; persister 가 WHERE 결정. 18단계와 20단계 두 저장소 레이어는 독립 — 18단계가 에이전트 메모리, 20단계가 파이프라인 state 체크포인트 저장.',
  whatItDoes: `**체크포인트**는 턴 끝에서의 파이프라인 state 스냅샷 — \`state.iteration\`, \`state.messages\`, \`state.metadata\`, \`state.shared\`, \`state.completion_signal\`, \`state.total_cost_usd\` 등. 호스트가 체크포인트를 사용하는 곳:

- 알려진-good state 에서 세션 재개
- "턴 7 에서 파이프라인이 어떻게 보였나?" 감사
- 기록된 스냅샷에서 시나리오 replay

Persister 가 20단계가 생산한 \`CheckpointRecord\` 저장. 빈도 policy (다음 슬롯) 가 매 턴 쓸지 결정.`,
  options: [
    {
      id: 'no_persist',
      label: '없음',
      description: `No-op persister. 모든 \`write()\` 호출에서 \`None\` 반환. 20단계가 여전히 실행 (빈도 체크, 이벤트 emission) 하지만 실제 저장은 안 일어남.

재시작 간 resume 가능성 필요 없는 파이프라인의 기본값.`,
      bestFor: [
        '상태 없는 API 엔드포인트',
        '테스트 파이프라인',
        '필요한 유일한 persistent 레이어가 18단계 (메모리) 인 파이프라인',
      ],
      avoidWhen: [
        '재시작 시 세션 resume 필요할 때 — `file` persister 또는 커스텀 backend',
      ],
      codeRef:
        'geny-executor / s20_persist/artifact/default/persisters.py:NoPersister',
    },
    {
      id: 'file',
      label: '파일 (File)',
      description: `체크포인트당 JSON 파일. 파일이 \`{base_dir}/{session_id}/{checkpoint_id}.json\` 에 살음. 원자적 쓰기 (tempfile + os.replace) 로 partial 파일이 절대 나타나지 않음. 세션별 하위 디렉토리가 listing 을 cheap 하게 유지.

기본 \`base_dir\` 은 \`.geny/checkpoints\`. 프로덕션 배포는 적절한 권한의 알려진 경로로 명시 설정.`,
      bestFor: [
        '디스크 있는 단일 호스트의 프로덕션 에이전트',
        '로컬 개발 — inspect / grep / 마이그레이션 쉬움',
        '재시작 후 세션 resume 이 요구사항인 모든 것',
      ],
      avoidWhen: [
        '멀티 호스트 배포 — 파일 persister 는 로컬 전용',
        '고동시성 파이프라인 — 파일 락이 단일 threading.Lock, 한 프로세스엔 fine 이지만 프로세스 간 coordinate 안 됨',
      ],
      config: [
        {
          name: 'base_dir',
          label: '베이스 디렉토리',
          type: 'string',
          default: '.geny/checkpoints',
          required: true,
          description:
            '체크포인트 파일의 파일시스템 루트. 세션별 하위 디렉토리는 자동 생성. `strategy_configs.persister.base_dir` 에 저장.',
        },
      ],
      gotchas: [
        '일부 테스트 setup 에서 `session_id` 가 비어있을 수 있음 — 파일이 그러면 `_unknown/` 아래로. 프로덕션은 항상 안정된 세션 ID 가져야 함.',
        '보존 policy 없음. 오래된 체크포인트 파일이 호스트가 cleanup 실행 안 하면 영원히 누적. 20단계가 prune 안 함.',
        '체크포인트 listing 이 모든 세션 디렉토리 스캔 포함. 매우 많은 세션 배포에서 느려질 수 있음 — 호스트 측 인덱싱이 도움.',
      ],
      codeRef:
        'geny-executor / s20_persist/artifact/default/persisters.py:FilePersister',
    },
  ],
  relatedSections: [
    {
      label: '빈도 (이 단계의 다음 슬롯)',
      body: 'Persister 가 체크포인트 저장; 빈도가 어떤 턴이 체크포인트 받을지 결정. 주기적 스냅샷은 `file` + `every_n_turns`, 이벤트 주도 스냅샷은 `file` + `on_significant` 짝.',
    },
    {
      label: '18단계 — 메모리 영속성',
      body: '18단계가 에이전트 메모리 저장; 20단계가 파이프라인 체크포인트 저장. 다른 레이어, 다른 목적 — 18단계 = "에이전트가 배운 것", 20단계 = "파이프라인 state 가 어땠는지".',
    },
    {
      label: 'Pipeline.resume()',
      body: '호스트가 체크포인트에서 복원하려고 `Pipeline.resume(checkpoint_id)` 호출. 실제로 쓰는 persister 없이 resume 할 게 없음.',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/stages/s20_persist/artifact/default/persisters.py',
};

export const stage20PersisterHelp: SectionHelpFactory = (locale) =>
  locale === 'ko' ? ko : en;
