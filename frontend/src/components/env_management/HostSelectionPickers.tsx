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
 * Permissions picker is intentionally a placeholder — the runtime
 * does not yet enforce env-level permission narrowing. The UI ships
 * so manifests written today are forward-compatible; the picker is
 * disabled and labelled as such.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { agentApi } from '@/lib/api';
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

// ── Permissions (mockup) ──────────────────────────────────────

/**
 * Permissions picker is not yet wired to runtime enforcement — the
 * field exists in `manifest.host_selections.permissions` so manifests
 * written today are forward-compatible, but the executor does not
 * intersect host permission rules with the env selection. The picker
 * renders disabled with mock items so the UX shape is visible.
 *
 * When real enforcement lands, drop the mock data + flip `disabled`
 * to false and wire to `/api/permissions/list`.
 */
export function PermissionEnvPicker() {
  const draft = useEnvironmentDraftStore((s) => s.draft);
  const patch = useEnvironmentDraftStore((s) => s.patchHostSelections);

  const value = useMemo(
    () => draft?.host_selections?.permissions ?? ['*'],
    [draft],
  );

  // Mock items — shape mirrors what /api/permissions/list returns
  // (rule per row), so the UI doesn't have to change when the real
  // fetch lands.
  const items: HostItem[] = [
    {
      id: 'rule:Read:*',
      label: 'Read: *',
      description: '모든 경로의 Read 도구 허용',
      badges: [{ text: 'allow', tone: 'good' }],
    },
    {
      id: 'rule:Bash:rm',
      label: 'Bash: rm',
      description: 'rm 시작 명령 차단',
      badges: [{ text: 'deny', tone: 'warn' }],
    },
    {
      id: 'rule:Write:./',
      label: 'Write: ./',
      description: '워크스페이스 내부 Write만 허용',
      badges: [{ text: 'allow', tone: 'good' }],
    },
  ];

  return (
    <div className="flex flex-col gap-2">
      <div className="px-3 py-2 rounded-md border border-dashed border-[hsl(var(--border))] bg-[hsl(var(--muted))]/40 text-[0.7rem] text-[hsl(var(--muted-foreground))] leading-relaxed">
        <span className="font-semibold uppercase tracking-wider mr-2">
          Preview
        </span>
        권한 영역의 env-level subset 선택은 매니페스트에 저장되지만 현재
        executor가 강제하지 않습니다. UI는 향후 enforcement가 들어올 때
        manifest 호환성이 유지되도록 미리 노출 — 실제 동작은 호스트의
        settings.json이 그대로 적용됩니다.
      </div>
      <HostEnvSelectionPicker
        items={items}
        value={value}
        onChange={(next) => patch({ permissions: next })}
        itemNoun="권한 룰"
        disabled
      />
    </div>
  );
}
