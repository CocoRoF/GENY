'use client';

/**
 * HostSelectionPickers — three wrappers around HostEnvSelectionPicker
 * that fetch the host registry and bind to
 * `draft.host_selections.{hooks,skills,permissions}`.
 *
 * The pickers are the ENV-side of the host-registered + env-pickable
 * pattern (geny-executor 1.3.3 `HostSelections`). The HOST-side
 * editors (HooksTab / SkillsTab / PermissionsTab) keep editing the
 * registry; these pickers only choose which subset is active in the
 * current environment.
 *
 * Phase 9.9.1 — the permissions picker, previously a disabled
 * mockup, now fetches real rules from `/api/permissions/list` and
 * persists selections that the backend honours via
 * `service.permission.install_permission_rules(host_selection=...)`.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  agentApi,
  subagentTypeApi,
  type SubagentTypeRow,
  sandboxToolPacksApi,
  type SandboxToolPackSummary,
  personaPresetsApi,
  type PersonaPresetSummary,
  type PersonaPresetDefinition,
} from '@/lib/api';
import { permissionId } from '@/lib/envDefaultsApi';
import { triggerPresetApi } from '@/lib/triggerPresetApi';
import type { TriggerPresetSummary } from '@/types/triggerPreset';
import {
  useEnvironmentDraftStore,
  type SubworkerTypeConfig,
} from '@/store/useEnvironmentDraftStore';
import HostEnvSelectionPicker, {
  type HostItem,
} from './HostEnvSelectionPicker';

// ── Skills ────────────────────────────────────────────────────

export function SkillEnvPicker() {
  const draft = useEnvironmentDraftStore((s) => s.draft);
  const patch = useEnvironmentDraftStore((s) => s.patchHostSelections);

  const [items, setItems] = useState<HostItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorText, setErrorText] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setErrorText(null);
    try {
      const res = await agentApi.skillsList();
      const next: HostItem[] = (res.skills ?? []).map((s, idx) => {
        // id and name can both be null for malformed SKILL.md frontmatter;
        // fall back to a positional id so the row is still selectable
        // (the user will see the bad entry in the host editor below).
        const stable = s.id || s.name || `__unnamed_${idx}__`;
        return {
          id: stable,
          label: s.name || stable,
          description: s.description ?? undefined,
          badges: [
            ...(s.model
              ? [{ text: s.model, tone: 'neutral' as const }]
              : []),
            ...(s.allowed_tools?.length
              ? [
                  {
                    text: `tools: ${s.allowed_tools.length}`,
                    tone: 'neutral' as const,
                  },
                ]
              : []),
          ],
        };
      });
      setItems(next);
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : String(err));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const value = useMemo(
    () => draft?.host_selections?.skills ?? ['*'],
    [draft],
  );

  return (
    <HostEnvSelectionPicker
      items={items}
      value={value}
      onChange={(next) => patch({ skills: next })}
      itemNoun="스킬"
      loading={loading}
      errorText={errorText}
    />
  );
}

// ── Permissions ───────────────────────────────────────────────

/**
 * PermissionEnvPicker — fetches the cascade-merged permission rules
 * (host settings.json + project + local) and lets the operator pick
 * a per-env subset. Selection is persisted to
 * `manifest.host_selections.permissions` and the backend
 * `install_permission_rules()` honours it at session boot.
 *
 * Each rule's id is computed via `permissionId()` (matches the host
 * tab's EnvDefaultStarToggle ids — same `tool::pattern::behavior`
 * shape the backend filter uses).
 */
export function PermissionEnvPicker() {
  const draft = useEnvironmentDraftStore((s) => s.draft);
  const patch = useEnvironmentDraftStore((s) => s.patchHostSelections);

  const [items, setItems] = useState<HostItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorText, setErrorText] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setErrorText(null);
    try {
      const res = await agentApi.permissionsList();
      const next: HostItem[] = (res.rules ?? []).map((r) => {
        const id = permissionId({
          tool_name: r.tool_name,
          pattern: r.pattern,
          behavior: r.behavior,
        });
        const headline = r.pattern
          ? `${r.tool_name} · ${r.pattern}`
          : `${r.tool_name} · *`;
        const tone =
          r.behavior === 'allow'
            ? ('good' as const)
            : r.behavior === 'deny'
              ? ('warn' as const)
              : ('neutral' as const);
        return {
          id,
          label: headline,
          description: r.reason ?? undefined,
          badges: [
            { text: r.behavior, tone },
            ...(r.source
              ? [{ text: r.source, tone: 'neutral' as const }]
              : []),
          ],
        };
      });
      setItems(next);
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : String(err));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const value = useMemo(
    () => draft?.host_selections?.permissions ?? ['*'],
    [draft],
  );

  return (
    <HostEnvSelectionPicker
      items={items}
      value={value}
      onChange={(next) => patch({ permissions: next })}
      itemNoun="권한 룰"
      loading={loading}
      errorText={errorText}
    />
  );
}

// ── Trigger preset ─────────────────────────────────────────────

/**
 * TriggerEnvPicker — maps this env to a host-shared VTuber trigger
 * preset (geny-executor 2.6.0). Unlike the hook/skill/permission
 * pickers — which select a *subset* of host registrations — a trigger
 * mapping is a single optional id stored at
 * `host_selections.extras.trigger_preset_id`.
 *
 * Leaving it unset ("기본값 사용") removes the key entirely so the env
 * carries no mapping and the backend resolves the host-designated
 * default preset at session boot.
 */
export function TriggerEnvPicker() {
  const draft = useEnvironmentDraftStore((s) => s.draft);
  const setTriggerPresetId = useEnvironmentDraftStore(
    (s) => s.setTriggerPresetId,
  );

  const [presets, setPresets] = useState<TriggerPresetSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorText, setErrorText] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErrorText(null);
    triggerPresetApi
      .list()
      .then((res) => {
        if (!cancelled) setPresets(res.presets);
      })
      .catch((err) => {
        if (!cancelled) {
          setErrorText(err instanceof Error ? err.message : String(err));
          setPresets([]);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selected = useMemo(() => {
    const raw = draft?.host_selections?.extras?.trigger_preset_id;
    return typeof raw === 'string' ? raw : '';
  }, [draft]);

  return (
    <div className="flex flex-col gap-2">
      <label className="text-[0.8125rem] font-medium text-[hsl(var(--foreground))]">
        트리거 프리셋
      </label>
      <select
        value={selected}
        onChange={(e) => setTriggerPresetId(e.target.value || null)}
        disabled={loading}
        className="w-full h-9 px-2.5 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] text-[0.8125rem] text-[hsl(var(--foreground))] focus:outline-none focus:ring-2 focus:ring-violet-500/40 disabled:opacity-60"
      >
        <option value="">기본값 사용 (매핑 안 함)</option>
        {presets.map((p) => (
          <option key={p.id} value={p.id}>
            {p.enabled ? '⚡' : '⏸'} {p.name}
          </option>
        ))}
      </select>
      {errorText ? (
        <p className="text-[0.7rem] text-rose-600 dark:text-rose-400 leading-relaxed">
          {errorText}
        </p>
      ) : (
        <p className="text-[0.7rem] text-[hsl(var(--muted-foreground))] leading-relaxed">
          비워두면 기본 트리거 프리셋을 사용합니다.
        </p>
      )}
    </div>
  );
}

/**
 * PersonaPresetPicker — attach a single Persona Preset to this environment.
 * Stored at `host_selections.extras.persona_preset_id`; at session build the
 * preset is compiled to a persona prompt and prepended to the system prompt.
 * Leaving it unset removes the key (no persona overlay).
 */
export function PersonaPresetPicker() {
  const draft = useEnvironmentDraftStore((s) => s.draft);
  const setPersonaPresetId = useEnvironmentDraftStore((s) => s.setPersonaPresetId);

  const [presets, setPresets] = useState<PersonaPresetSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorText, setErrorText] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErrorText(null);
    personaPresetsApi
      .list()
      .then((res) => {
        if (!cancelled) setPresets(res.presets || []);
      })
      .catch((err) => {
        if (!cancelled) {
          setErrorText(err instanceof Error ? err.message : String(err));
          setPresets([]);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selected = useMemo(() => {
    const raw = draft?.host_selections?.extras?.persona_preset_id;
    return typeof raw === 'string' ? raw : '';
  }, [draft]);

  // What the chosen preset actually IS.
  //
  // The picker used to be a bare name dropdown, which is how a preset can
  // be copied, given an outgoing MBTI and a high enthusiasm, and still
  // carry `default_mood: calm` from the original — the compiled prompt
  // then says "Your resting disposition leans calm" and every reply comes
  // out calm while the summary line reads ESFP. Nothing on screen showed
  // the contradiction, so the only way to find it was to read the
  // compiled prompt in a database.
  // Keyed by id rather than cleared in an effect: "nothing is selected"
  // is derivable at render, and clearing it with a synchronous setState
  // would be a cascading render for a fact we already know.
  // One piece of state, keyed by the id it answers for, so "which preset"
  // and "settled or not" cannot disagree — and both "nothing selected"
  // and "still loading" are derived at render rather than written by a
  // synchronous setState inside the effect.
  const [loaded, setLoaded] = useState<
    { id: string; defn: PersonaPresetDefinition | null } | null
  >(null);
  const [showPrompt, setShowPrompt] = useState(false);
  const settled = !!selected && loaded?.id === selected;
  const detail = settled ? loaded!.defn : null;
  const detailBusy = !!selected && !settled;

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    personaPresetsApi
      .get(selected)
      .then((d) => { if (!cancelled) setLoaded({ id: selected, defn: d }); })
      .catch(() => { if (!cancelled) setLoaded({ id: selected, defn: null }); });
    return () => { cancelled = true; };
  }, [selected]);

  return (
    <div className="flex flex-col gap-2">
      <label className="text-[0.8125rem] font-medium text-[hsl(var(--foreground))]">
        페르소나
      </label>
      <select
        value={selected}
        onChange={(e) => setPersonaPresetId(e.target.value || null)}
        disabled={loading}
        className="w-full h-9 px-2.5 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] text-[0.8125rem] text-[hsl(var(--foreground))] focus:outline-none focus:ring-2 focus:ring-violet-500/40 disabled:opacity-60"
      >
        <option value="">적용 안 함</option>
        {presets.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}{p.mbti ? ` · ${p.mbti}` : ''}
          </option>
        ))}
      </select>
      {errorText ? (
        <p className="text-[0.7rem] text-rose-600 dark:text-rose-400 leading-relaxed">{errorText}</p>
      ) : (
        <p className="text-[0.7rem] text-[hsl(var(--muted-foreground))] leading-relaxed">
          이 환경의 세션에 적용할 페르소나(성격)를 선택합니다. 페르소나는 「페르소나」 탭에서 만들 수 있어요.
        </p>
      )}

      {selected && (detail || detailBusy) && (
        <div className="mt-1 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--muted))]/30 p-3 flex flex-col gap-2">
          {detailBusy && !detail ? (
            <p className="text-[0.7rem] text-[hsl(var(--muted-foreground))]">불러오는 중…</p>
          ) : detail ? (
            <>
              <div className="flex flex-wrap items-center gap-1.5">
                {[detail.mbti, detail.enneagram && `에니어 ${detail.enneagram}`, detail.archetype]
                  .filter(Boolean)
                  .map((tag) => (
                    <span
                      key={String(tag)}
                      className="px-1.5 py-0.5 rounded text-[0.68rem] bg-[hsl(var(--background))] border border-[hsl(var(--border))] text-[hsl(var(--foreground))]"
                    >
                      {String(tag)}
                    </span>
                  ))}
              </div>

              {/* The field that silently decides tone. It is stated on its
                  own line, in the same words the compiled prompt uses, so
                  a lively MBTI sitting on a calm resting mood is visible
                  here instead of only in the agent's replies. */}
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[0.72rem]">
                <dt className="text-[hsl(var(--muted-foreground))]">기본 감정</dt>
                <dd className="text-[hsl(var(--foreground))]">
                  {detail.emotion?.default_mood || 'neutral'}
                  <span className="text-[hsl(var(--muted-foreground))]">
                    {' '}· 표현 강도 {detail.emotion?.expressiveness ?? 50}
                    {detail.emotion?.preferred_tags?.length
                      ? ` · 주로 ${detail.emotion.preferred_tags.join(', ')}`
                      : ''}
                  </span>
                </dd>
                <dt className="text-[hsl(var(--muted-foreground))]">외향/열의</dt>
                <dd className="text-[hsl(var(--foreground))]">
                  {detail.ocean?.extraversion ?? 50} / {detail.style?.enthusiasm ?? 50}
                </dd>
                <dt className="text-[hsl(var(--muted-foreground))]">말투</dt>
                <dd className="text-[hsl(var(--foreground))]">
                  {detail.speech?.honorific === 'banmal' ? '반말' : '존댓말'}
                  {detail.speech?.self_reference ? ` · 자칭 "${detail.speech.self_reference}"` : ''}
                </dd>
              </dl>

              {(detail.emotion?.default_mood === 'calm' ||
                detail.emotion?.default_mood === 'neutral') &&
                (detail.ocean?.extraversion ?? 50) >= 70 && (
                  <p className="text-[0.7rem] text-amber-600 dark:text-amber-400 leading-relaxed">
                    외향적인 성격인데 기본 감정이 «{detail.emotion?.default_mood}» 입니다 — 프롬프트에
                    «resting disposition leans {detail.emotion?.default_mood}» 가 들어가 말투가 차분해집니다.
                    활발하게 하려면 「페르소나」 탭에서 기본 감정을 바꿔 주세요.
                  </p>
                )}

              <button
                type="button"
                onClick={() => setShowPrompt((v) => !v)}
                className="self-start text-[0.7rem] underline text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]"
              >
                {showPrompt ? '프롬프트 접기' : '적용될 프롬프트 보기'}
              </button>
              {showPrompt && (
                <pre className="max-h-56 overflow-auto whitespace-pre-wrap text-[0.68rem] leading-relaxed p-2 rounded bg-[hsl(var(--background))] border border-[hsl(var(--border))] text-[hsl(var(--foreground))]">
                  {detail.compiled_prompt || '(비어 있음)'}
                </pre>
              )}
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}

/**
 * SandboxToolPacksPicker — opt this environment into one or more Sandbox Tool
 * Packs. Only ENABLED packs are selectable (the global owner gate); the
 * selection is written to `host_selections.extras.sandbox_tool_packs`. A pack's
 * tools + skills load for every session of this env, each running in the pack's
 * own snapshotted workspace.
 */
export function SandboxToolPacksPicker() {
  const draft = useEnvironmentDraftStore((s) => s.draft);
  const setSandboxToolPacks = useEnvironmentDraftStore(
    (s) => s.setSandboxToolPacks,
  );

  const [packs, setPacks] = useState<SandboxToolPackSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorText, setErrorText] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErrorText(null);
    sandboxToolPacksApi
      .list()
      .then((res) => {
        if (!cancelled) setPacks(res.packs || []);
      })
      .catch((err) => {
        if (!cancelled) {
          setErrorText(err instanceof Error ? err.message : String(err));
          setPacks([]);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selected = useMemo(() => {
    const raw = draft?.host_selections?.extras?.sandbox_tool_packs;
    return Array.isArray(raw) ? (raw as string[]) : [];
  }, [draft]);

  const enabledPacks = useMemo(() => packs.filter((p) => p.enabled), [packs]);

  const toggle = useCallback(
    (packId: string) => {
      const set = new Set(selected);
      if (set.has(packId)) set.delete(packId);
      else set.add(packId);
      setSandboxToolPacks(Array.from(set));
    },
    [selected, setSandboxToolPacks],
  );

  return (
    <div className="flex flex-col gap-2">
      <label className="text-[0.8125rem] font-medium text-[hsl(var(--foreground))]">
        샌드박스 도구 팩 (Sandbox Tool Packs)
      </label>
      {loading ? (
        <p className="text-[0.7rem] text-[hsl(var(--muted-foreground))] animate-pulse">
          로딩 중…
        </p>
      ) : errorText ? (
        <p className="text-[0.7rem] text-rose-600 dark:text-rose-400 leading-relaxed">
          {errorText}
        </p>
      ) : enabledPacks.length === 0 ? (
        <p className="text-[0.7rem] text-[hsl(var(--muted-foreground))] leading-relaxed">
          활성화된 팩이 없습니다. 팩 관리자에서 팩을 먼저 enable 하세요.
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {enabledPacks.map((p) => {
            const on = selected.includes(p.id);
            return (
              <label
                key={p.id}
                className="flex items-start gap-2 px-2.5 py-1.5 rounded-md border border-[hsl(var(--border))] hover:bg-[hsl(var(--muted))]/40 cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => toggle(p.id)}
                  className="mt-0.5 accent-violet-500"
                />
                <span className="min-w-0">
                  <span className="text-[0.8125rem] font-medium text-[hsl(var(--foreground))]">
                    {p.name}
                  </span>
                  <span className="text-[0.7rem] text-[hsl(var(--muted-foreground))] ml-1.5">
                    {p.tool_count} tool{p.tool_count === 1 ? '' : 's'} · {p.skill_count} skill
                    {p.skill_count === 1 ? '' : 's'}
                  </span>
                  {p.description && (
                    <span className="block text-[0.7rem] text-[hsl(var(--muted-foreground))] truncate">
                      {p.description}
                    </span>
                  )}
                </span>
              </label>
            );
          })}
        </div>
      )}
      <p className="text-[0.7rem] text-[hsl(var(--muted-foreground))] leading-relaxed">
        선택한 팩의 도구·스킬이 이 환경의 모든 세션에 로드됩니다.
      </p>
    </div>
  );
}

/**
 * OwnedSubagentPicker — declare the persistent **sub-agent** an agent on this
 * env OWNS. Stored at `host_selections.extras.owned_subagent`. The companion
 * is built from THIS (the parent's) env — it inherits its tools / model /
 * stages — so there is no separate sub-agent env to pick; a toggle turns
 * ownership on and an optional system prompt gives it a role. Off → the agent
 * owns no persistent companion (it can still use one-shot sub-workers).
 */
/** Geny-provided sub-agent role presets — strong starter prompts the user can
 *  apply then tweak. (LLM instructions are kept in English by policy.) Empty
 *  system_prompt → the backend uses the executor's strong default companion
 *  persona (DEFAULT_PERSISTENT_SUBAGENT_PROMPT, geny-executor >=2.8.0). */
const SUBAGENT_PRESETS: { id: string; label: string; prompt: string }[] = [
  {
    id: 'general',
    label: '범용 자율 어시스턴트',
    prompt:
      'You are a capable autonomous companion working alongside your owner. ' +
      'Take on whole tasks, execute them end-to-end with the available tools, ' +
      'verify your work, and report concise, actionable results. Be proactive, ' +
      'make sound assumptions, and only ask when genuinely blocked.',
  },
  {
    id: 'researcher',
    label: '리서치 전문가',
    prompt:
      'You are a research specialist. Investigate questions deeply and ' +
      'accurately, cross-checking sources and citing concrete evidence ' +
      '(file:line, URLs). Separate verified facts from inference and deliver ' +
      'well-structured findings. Do not mutate state.',
  },
  {
    id: 'coder',
    label: '코드 작업자',
    prompt:
      'You are a focused software engineer. Implement, fix, and refactor code ' +
      'precisely. Read the surrounding code first, match its conventions, make ' +
      'minimal correct changes, and verify (build/tests) before reporting ' +
      'exactly what you changed.',
  },
  {
    id: 'planner',
    label: '기획·문서 작성',
    prompt:
      'You are a planning and documentation specialist. Turn goals into clear, ' +
      'structured plans and write precise, well-organized documents. Be ' +
      'concrete, complete, and easy to follow.',
  },
  {
    id: 'critic',
    label: '비평가·리뷰어',
    prompt:
      'You are a rigorous reviewer. Scrutinize work for real defects — ' +
      'correctness, security, edge cases, unmet requirements — and report ' +
      'substantiated, well-located findings ranked by severity. Read-only.',
  },
];

export function OwnedSubagentPicker() {
  const draft = useEnvironmentDraftStore((s) => s.draft);
  const setOwnedSubagent = useEnvironmentDraftStore((s) => s.setOwnedSubagent);

  const owned = useMemo(() => {
    const raw = draft?.host_selections?.extras?.owned_subagent as
      | { enabled?: boolean; system_prompt?: string }
      | undefined;
    return {
      enabled: !!raw,
      system_prompt:
        typeof raw?.system_prompt === 'string' ? raw.system_prompt : '',
    };
  }, [draft]);

  return (
    <div className="flex flex-col gap-3">
      <label className="flex items-center gap-2.5 cursor-pointer">
        <input
          type="checkbox"
          checked={owned.enabled}
          onChange={(e) =>
            setOwnedSubagent(
              e.target.checked
                ? { enabled: true, system_prompt: owned.system_prompt || undefined }
                : null,
            )
          }
          className="h-4 w-4 accent-violet-500"
        />
        <span className="text-[0.8125rem] font-medium text-[hsl(var(--foreground))]">
          이 환경의 에이전트가 영속 sub-agent를 소유
        </span>
      </label>
      <p className="text-[0.7rem] text-[hsl(var(--muted-foreground))] leading-relaxed">
        {owned.enabled
          ? '소유 companion은 이 환경(부모)의 도구·모델·단계를 그대로 사용합니다. 작업을 완전 위임하면 자율 수행 후 완료 알림을 받습니다.'
          : '끄면 영속 companion 없이 일회성 sub-worker(Agent 도구 / Stage 12)만 사용합니다.'}
      </p>

      {owned.enabled && (
        <div className="flex flex-col gap-2">
          <label className="text-[0.75rem] font-medium text-[hsl(var(--muted-foreground))]">
            역할 프리셋 — 적용 후 자유롭게 수정
          </label>
          <div className="flex flex-wrap gap-1.5">
            {SUBAGENT_PRESETS.map((p) => {
              const active = owned.system_prompt === p.prompt;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() =>
                    setOwnedSubagent({ enabled: true, system_prompt: p.prompt })
                  }
                  className={
                    'text-[0.7rem] px-2.5 h-7 rounded-full border transition-colors ' +
                    (active
                      ? 'border-violet-500 bg-violet-500/15 text-violet-700 dark:text-violet-300'
                      : 'border-[hsl(var(--border))] text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--muted))]')
                  }
                >
                  {p.label}
                </button>
              );
            })}
            {owned.system_prompt && (
              <button
                type="button"
                onClick={() =>
                  setOwnedSubagent({ enabled: true, system_prompt: undefined })
                }
                className="text-[0.7rem] px-2.5 h-7 rounded-full border border-[hsl(var(--border))] text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--muted))]"
              >
                기본값으로 초기화
              </button>
            )}
          </div>
          <label className="text-[0.75rem] font-medium text-[hsl(var(--muted-foreground))] mt-1">
            시스템 프롬프트 (역할) — 선택
          </label>
          <textarea
            rows={5}
            value={owned.system_prompt}
            onChange={(e) =>
              setOwnedSubagent({
                enabled: true,
                system_prompt: e.target.value || undefined,
              })
            }
            placeholder="이 companion의 역할/지시를 직접 지정하거나 위 프리셋을 적용하세요. 비워두면 강력한 기본 companion 페르소나가 적용됩니다."
            className="w-full px-2.5 py-2 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] text-[0.8125rem] text-[hsl(var(--foreground))] placeholder:text-[hsl(var(--muted-foreground))] resize-y focus:outline-none focus:ring-2 focus:ring-violet-500/40"
          />
        </div>
      )}
    </div>
  );
}

// ── Sub-Worker types (one-shot delegation roster) ─────────────

const _INPUT_CLS =
  'w-full h-8 px-2 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] text-[0.75rem] text-[hsl(var(--foreground))] placeholder:text-[hsl(var(--muted-foreground))] focus:outline-none focus:ring-2 focus:ring-violet-500/40';

/**
 * SubworkerTypesPicker — precise per-env roster for the ONE-SHOT sub-workers
 * an agent spawns via the Agent tool (Stage 12). Each row overlays the seed
 * catalog by `agent_type`: edit a seed type's model / provider / system prompt
 * / tools, add a brand-new type, or disable one. Stored at
 * `host_selections.extras.subworker_types`; the backend
 * (`SubagentRegistryBuilder`) applies it when building the session registry.
 * No rows → the env uses the default seed roster unchanged.
 */
export function SubworkerTypesPicker() {
  const draft = useEnvironmentDraftStore((s) => s.draft);
  const setSubworkerTypes = useEnvironmentDraftStore((s) => s.setSubworkerTypes);

  const [seed, setSeed] = useState<SubagentTypeRow[]>([]);
  useEffect(() => {
    let cancelled = false;
    subagentTypeApi
      .list()
      .then((res) => {
        if (!cancelled) setSeed(res.types);
      })
      .catch(() => {
        /* seed hint is optional */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const rows = useMemo<SubworkerTypeConfig[]>(() => {
    const raw = draft?.host_selections?.extras?.subworker_types;
    return Array.isArray(raw) ? (raw as SubworkerTypeConfig[]) : [];
  }, [draft]);

  const commit = (next: SubworkerTypeConfig[]) => setSubworkerTypes(next);
  const updateRow = (i: number, patch: Partial<SubworkerTypeConfig>) =>
    commit(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const removeRow = (i: number) => commit(rows.filter((_, idx) => idx !== i));
  const addRow = (agent_type = '') =>
    commit([...rows, { agent_type, enabled: true }]);

  // Seed types not yet overridden — offered as quick "override" starters.
  const overridable = seed.filter(
    (s) => !rows.some((r) => r.agent_type === s.agent_type),
  );

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[0.7rem] text-[hsl(var(--muted-foreground))] leading-relaxed">
        일회성 sub-worker(에이전트가 Agent 도구로 위임)의 타입별 정밀 설정입니다.
        시드 타입을 오버라이드하거나 새 타입을 추가하고, 모델·프로바이더·시스템
        프롬프트·허용 도구를 지정할 수 있습니다. 행이 없으면 기본 시드 로스터를
        그대로 사용합니다.
      </p>

      {rows.length > 0 && (
        <div className="flex flex-col gap-3">
          {rows.map((r, i) => (
            <div
              key={i}
              className="rounded-lg border border-[hsl(var(--border))] p-3 flex flex-col gap-2 bg-[hsl(var(--muted))]/30"
            >
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={r.enabled !== false}
                  onChange={(e) => updateRow(i, { enabled: e.target.checked })}
                  title={r.enabled === false ? '비활성 (로스터에서 제거)' : '활성'}
                  className="h-4 w-4 accent-violet-500"
                />
                <input
                  type="text"
                  value={r.agent_type}
                  onChange={(e) => updateRow(i, { agent_type: e.target.value })}
                  placeholder="agent_type (예: worker, translator)"
                  className={_INPUT_CLS + ' font-medium flex-1'}
                />
                <button
                  type="button"
                  onClick={() => removeRow(i)}
                  className="text-[0.7rem] px-2 h-8 rounded-md border border-[hsl(var(--border))] text-rose-600 dark:text-rose-400 hover:bg-rose-500/10"
                >
                  삭제
                </button>
              </div>
              {r.enabled !== false && (
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="text"
                    value={r.model ?? ''}
                    onChange={(e) => updateRow(i, { model: e.target.value })}
                    placeholder="모델 (비우면 상속)"
                    className={_INPUT_CLS}
                  />
                  <input
                    type="text"
                    value={r.provider ?? ''}
                    onChange={(e) => updateRow(i, { provider: e.target.value })}
                    placeholder="프로바이더 (비우면 부모)"
                    className={_INPUT_CLS}
                  />
                  <input
                    type="text"
                    value={r.description ?? ''}
                    onChange={(e) =>
                      updateRow(i, { description: e.target.value })
                    }
                    placeholder="설명 (위임 시 LLM에 노출)"
                    className={_INPUT_CLS + ' col-span-2'}
                  />
                  <input
                    type="text"
                    value={(r.allowed_tools ?? []).join(', ')}
                    onChange={(e) =>
                      updateRow(i, {
                        allowed_tools: e.target.value
                          .split(',')
                          .map((t) => t.trim())
                          .filter(Boolean),
                      })
                    }
                    placeholder="허용 도구 (쉼표, 비우면 전체). 예: Read, Grep, WebFetch"
                    className={_INPUT_CLS + ' col-span-2'}
                  />
                  <textarea
                    rows={3}
                    value={r.system_prompt ?? ''}
                    onChange={(e) =>
                      updateRow(i, { system_prompt: e.target.value })
                    }
                    placeholder="시스템 프롬프트 (역할/지시). 비우면 기본."
                    className="col-span-2 w-full px-2 py-1.5 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] text-[0.75rem] text-[hsl(var(--foreground))] placeholder:text-[hsl(var(--muted-foreground))] resize-y focus:outline-none focus:ring-2 focus:ring-violet-500/40"
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => addRow('')}
          className="text-[0.7rem] px-2.5 h-8 rounded-md border border-[hsl(var(--border))] text-[hsl(var(--foreground))] hover:bg-[hsl(var(--muted))]"
        >
          + 커스텀 타입
        </button>
        {overridable.map((s) => (
          <button
            key={s.agent_type}
            type="button"
            onClick={() => addRow(s.agent_type)}
            title={s.description}
            className="text-[0.7rem] px-2.5 h-8 rounded-md border border-dashed border-[hsl(var(--border))] text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--muted))]"
          >
            + {s.agent_type} 오버라이드
          </button>
        ))}
      </div>
    </div>
  );
}
