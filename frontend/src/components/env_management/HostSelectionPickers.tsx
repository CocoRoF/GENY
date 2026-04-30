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
import { agentApi } from '@/lib/api';
import { permissionId } from '@/lib/envDefaultsApi';
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
