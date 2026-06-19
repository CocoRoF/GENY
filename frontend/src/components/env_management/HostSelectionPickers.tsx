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
import { agentApi, subagentTypeApi, type SubagentTypeRow } from '@/lib/api';
import { permissionId } from '@/lib/envDefaultsApi';
import { triggerPresetApi } from '@/lib/triggerPresetApi';
import type { TriggerPresetSummary } from '@/types/triggerPreset';
import { useEnvironmentDraftStore } from '@/store/useEnvironmentDraftStore';
import HostEnvSelectionPicker, {
  type HostItem,
} from './HostEnvSelectionPicker';

// ── Hooks ─────────────────────────────────────────────────────

/** Stable id for a hook entry. The host's hooks.yaml has no explicit
 *  id field — entries are identified by their (event, command) tuple,
 *  which is what the manifest selection list stores. */
function hookId(entry: { event: string; command: string[] }): string {
  return `${entry.event}::${entry.command.join(' ')}`;
}

export function HookEnvPicker() {
  const draft = useEnvironmentDraftStore((s) => s.draft);
  const patch = useEnvironmentDraftStore((s) => s.patchHostSelections);

  const [items, setItems] = useState<HostItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorText, setErrorText] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setErrorText(null);
    try {
      const res = await agentApi.hooksList();
      const next: HostItem[] = (res.entries ?? []).map((e) => ({
        id: hookId(e),
        label: e.event,
        description: e.command.join(' '),
        badges: [
          ...(e.timeout_ms != null
            ? [{ text: `${e.timeout_ms}ms`, tone: 'neutral' as const }]
            : []),
          ...(e.tool_filter?.length
            ? [
                {
                  text: `tools: ${e.tool_filter.length}`,
                  tone: 'neutral' as const,
                },
              ]
            : []),
        ],
      }));
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
    () => draft?.host_selections?.hooks ?? ['*'],
    [draft],
  );

  return (
    <HostEnvSelectionPicker
      items={items}
      value={value}
      onChange={(next) => patch({ hooks: next })}
      itemNoun="훅"
      loading={loading}
      errorText={errorText}
    />
  );
}

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
 * OwnedSubagentPicker — declare the persistent **sub-agent** an agent on this
 * env OWNS (geny-executor 2.7.0). Stored at
 * `host_selections.extras.owned_subagent = { type }`. The session manager
 * spawns this sub-agent at creation for ANY agent on the env (a VTuber is then
 * just "an agent on a vtuber env + an avatar"). Leaving it "소유 안 함" removes
 * the key → the agent owns no persistent companion (it can still use one-shot
 * sub-workers via the Agent tool / Stage 12).
 */
export function OwnedSubagentPicker() {
  const draft = useEnvironmentDraftStore((s) => s.draft);
  const setOwnedSubagent = useEnvironmentDraftStore((s) => s.setOwnedSubagent);

  const [types, setTypes] = useState<SubagentTypeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorText, setErrorText] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErrorText(null);
    subagentTypeApi
      .list()
      .then((res) => {
        if (!cancelled) setTypes(res.types);
      })
      .catch((err) => {
        if (!cancelled) {
          setErrorText(err instanceof Error ? err.message : String(err));
          setTypes([]);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const owned = useMemo(() => {
    const raw = draft?.host_selections?.extras?.owned_subagent as
      | { type?: string; model?: string; system_prompt?: string }
      | undefined;
    return {
      type: typeof raw?.type === 'string' ? raw.type : '',
      model: typeof raw?.model === 'string' ? raw.model : '',
      system_prompt:
        typeof raw?.system_prompt === 'string' ? raw.system_prompt : '',
    };
  }, [draft]);

  const selectedDesc = useMemo(
    () => types.find((t) => t.agent_type === owned.type)?.description ?? '',
    [types, owned.type],
  );

  // Merge one field, preserving the rest. Clearing the type drops ownership.
  const update = (patch: Partial<typeof owned>) => {
    const next = { ...owned, ...patch };
    if (!next.type) {
      setOwnedSubagent(null);
      return;
    }
    setOwnedSubagent({
      type: next.type,
      model: next.model || undefined,
      system_prompt: next.system_prompt || undefined,
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        <label className="text-[0.8125rem] font-medium text-[hsl(var(--foreground))]">
          영속 Sub-Agent (소유)
        </label>
        <select
          value={owned.type}
          onChange={(e) => update({ type: e.target.value })}
          disabled={loading}
          className="w-full h-9 px-2.5 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] text-[0.8125rem] text-[hsl(var(--foreground))] focus:outline-none focus:ring-2 focus:ring-violet-500/40 disabled:opacity-60"
        >
          <option value="">소유 안 함 (없음)</option>
          {types.map((t) => (
            <option key={t.agent_type} value={t.agent_type}>
              {t.agent_type}
            </option>
          ))}
        </select>
        {errorText ? (
          <p className="text-[0.7rem] text-rose-600 dark:text-rose-400 leading-relaxed">
            {errorText}
          </p>
        ) : (
          <p className="text-[0.7rem] text-[hsl(var(--muted-foreground))] leading-relaxed">
            {owned.type
              ? `이 환경의 에이전트는 영속 '${owned.type}' sub-agent를 소유합니다 — 작업을 완전 위임하면 자율 수행 후 완료 알림을 받습니다.${selectedDesc ? ` (${selectedDesc})` : ''}`
              : '소유하지 않으면 영속 companion 없이 일회성 sub-worker(Agent 도구)만 사용합니다.'}
          </p>
        )}
      </div>

      {/* Precise overrides — only meaningful when a sub-agent is owned. */}
      {owned.type && (
        <>
          <div className="flex flex-col gap-1.5">
            <label className="text-[0.75rem] font-medium text-[hsl(var(--muted-foreground))]">
              모델 오버라이드 (선택)
            </label>
            <input
              type="text"
              value={owned.model}
              onChange={(e) => update({ model: e.target.value })}
              placeholder="비워두면 부모/환경 모델을 상속"
              className="w-full h-9 px-2.5 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] text-[0.8125rem] text-[hsl(var(--foreground))] placeholder:text-[hsl(var(--muted-foreground))] focus:outline-none focus:ring-2 focus:ring-violet-500/40"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-[0.75rem] font-medium text-[hsl(var(--muted-foreground))]">
              시스템 프롬프트 오버라이드 (선택)
            </label>
            <textarea
              rows={4}
              value={owned.system_prompt}
              onChange={(e) => update({ system_prompt: e.target.value })}
              placeholder="이 sub-agent의 역할/지시를 직접 지정. 비워두면 기본 페르소나."
              className="w-full px-2.5 py-2 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] text-[0.8125rem] text-[hsl(var(--foreground))] placeholder:text-[hsl(var(--muted-foreground))] resize-y focus:outline-none focus:ring-2 focus:ring-violet-500/40"
            />
          </div>
        </>
      )}
    </div>
  );
}
