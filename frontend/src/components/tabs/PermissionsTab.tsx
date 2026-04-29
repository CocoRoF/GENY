'use client';

/**
 * PermissionsTab — view & edit the executor's permission rules
 * (PR-E.2.2). Lives behind the dev-only "Permissions" global tab.
 *
 * Layout:
 *   [Header: mode + sources consulted]
 *   [Rules table: tool / behavior / pattern / source / reason / actions]
 *   [Add modal: same fields, behavior+source dropdown]
 *
 * Read state comes from /api/permissions/list (cascade-merged) so the
 * operator sees what the matrix actually loaded — including yaml-only
 * rules that aren't editable here. Writes go through /api/permissions/rules
 * which mutates user-scope settings.json. Rules from non-user sources
 * surface in the table read-only with a hint pointing at the file.
 */

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  permissionApi,
  PermissionRulePayload,
  PermissionBehavior,
  PermissionSource,
  PermissionListResponse,
  PermissionRulesResponse,
  PERMISSION_MODES,
  EXECUTOR_PERMISSION_MODES,
} from '@/lib/api';
import { RefreshCw, Plus, Pencil, Trash2, Shield } from 'lucide-react';
import {
  TabShell,
  EditorModal,
  StatusBadge,
  ActionButton,
  type BadgeTone,
} from '@/components/layout';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import HostRegistryBanner from '@/components/env_management/HostRegistryBanner';

const BEHAVIOR_OPTIONS: PermissionBehavior[] = ['allow', 'deny', 'ask'];
const SOURCE_OPTIONS: PermissionSource[] = ['user', 'project', 'local', 'cli', 'preset'];

const BEHAVIOR_TONE: Record<string, BadgeTone> = {
  allow: 'success',
  deny: 'danger',
  ask: 'warning',
};

interface RuleFormState {
  tool_name: string;
  behavior: PermissionBehavior;
  pattern: string;
  source: PermissionSource;
  reason: string;
}

const EMPTY_FORM: RuleFormState = {
  tool_name: '',
  behavior: 'ask',
  pattern: '',
  source: 'user',
  reason: '',
};

function formToPayload(f: RuleFormState): PermissionRulePayload {
  return {
    tool_name: f.tool_name.trim(),
    behavior: f.behavior,
    pattern: f.pattern.trim() ? f.pattern.trim() : null,
    source: f.source,
    reason: f.reason.trim() ? f.reason.trim() : null,
  };
}

export interface PermissionsTabProps {
  /** When true, renders without the TabShell outer chrome (for embedding
   *  inside another panel — see Globals view). */
  embedded?: boolean;
}

export function PermissionsTab({ embedded = false }: PermissionsTabProps) {
  const [editable, setEditable] = useState<PermissionRulesResponse | null>(null);
  const [inspect, setInspect] = useState<PermissionListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [form, setForm] = useState<RuleFormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  // R.1 (cycle 20260426_2) — mode pickers reflect settings.json values
  // (null = section absent → install layer falls back to env / default).
  const [savingMode, setSavingMode] = useState(false);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const [edit, ins] = await Promise.all([
        permissionApi.listEditable(),
        permissionApi.inspect(),
      ]);
      setEditable(edit);
      setInspect(ins);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const editableCount = editable?.rules.length ?? 0;
  const inspectCount = inspect?.rules.length ?? 0;

  // Map index in editable.rules to ensure delete/replace target the
  // user-scope file. Non-user-scope rules from inspect are read-only
  // here (their PUT target index doesn't exist in editable).
  const editableIdxByKey = useMemo(() => {
    const map = new Map<string, number>();
    editable?.rules.forEach((r, idx) => {
      const key = `${r.tool_name}::${r.pattern ?? ''}::${r.behavior}::${r.source}`;
      map.set(key, idx);
    });
    return map;
  }, [editable]);

  const openCreate = () => {
    setEditingIdx(null);
    setForm(EMPTY_FORM);
    setEditorOpen(true);
  };

  const openEdit = (idx: number) => {
    const r = editable?.rules[idx];
    if (!r) return;
    setEditingIdx(idx);
    setForm({
      tool_name: r.tool_name,
      behavior: r.behavior,
      pattern: r.pattern ?? '',
      source: r.source ?? 'user',
      reason: r.reason ?? '',
    });
    setEditorOpen(true);
  };

  const submitForm = async () => {
    if (!form.tool_name.trim()) {
      setError('tool_name is required');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const payload = formToPayload(form);
      const res = editingIdx === null
        ? await permissionApi.append(payload)
        : await permissionApi.replace(editingIdx, payload);
      setEditable(res);
      // Inspect view will go stale until next refresh; trigger one.
      try {
        const ins = await permissionApi.inspect();
        setInspect(ins);
      } catch {/* keep stale inspect — no harm */}
      toast.success(
        editingIdx === null ? 'Permission rule added' : 'Permission rule updated',
      );
      setEditorOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleModeChange = async (
    field: 'mode' | 'executor_mode',
    value: string,
  ) => {
    setSavingMode(true);
    setError(null);
    try {
      const res = await permissionApi.patchMode({ [field]: value });
      setEditable(res);
      try {
        const ins = await permissionApi.inspect();
        setInspect(ins);
      } catch {/* keep stale inspect */}
      toast.success(`Permission ${field} = ${value}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingMode(false);
    }
  };

  const deleteRule = async (idx: number) => {
    const target = editable?.rules[idx];
    if (!target) return;
    const confirmed = window.confirm(
      `Delete permission rule for ${target.tool_name} (${target.behavior})?`,
    );
    if (!confirmed) return;
    setError(null);
    try {
      const res = await permissionApi.remove(idx);
      setEditable(res);
      try {
        const ins = await permissionApi.inspect();
        setInspect(ins);
      } catch {/* keep stale inspect */}
      toast.success(`Removed rule for ${target.tool_name}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const subtitle = (
    <>
      Mode: <span className="font-mono uppercase">{inspect?.mode ?? '—'}</span>{' '}
      · {inspectCount} rule{inspectCount === 1 ? '' : 's'} loaded
      {editable && (
        <> · {editableCount} editable in <span className="font-mono">{editable.settings_path}</span></>
      )}
    </>
  );

  const actions = (
    <>
      {/* R.1 — mode pickers. Reflect settings.json:permissions
          values; falling back to inspect's resolved value (which
          accounts for env / defaults) when the file omits them. */}
      <div className="hidden md:flex items-center gap-1.5">
        <span className="text-[0.6875rem] uppercase text-[var(--text-muted)] font-semibold tracking-wider">
          Mode
        </span>
        <Select
          value={editable?.mode ?? inspect?.mode ?? 'advisory'}
          onValueChange={(v) => handleModeChange('mode', v)}
          disabled={savingMode}
        >
          <SelectTrigger className="h-7 w-[110px] text-[0.75rem]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PERMISSION_MODES.map((m) => (
              <SelectItem key={m} value={m}>{m}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-[0.6875rem] uppercase text-[var(--text-muted)] font-semibold tracking-wider ml-2">
          Exec
        </span>
        <Select
          value={editable?.executor_mode ?? 'default'}
          onValueChange={(v) => handleModeChange('executor_mode', v)}
          disabled={savingMode}
        >
          <SelectTrigger className="h-7 w-[120px] text-[0.75rem]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {EXECUTOR_PERMISSION_MODES.map((m) => (
              <SelectItem key={m} value={m}>{m}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <ActionButton variant="primary" icon={Plus} onClick={openCreate}>
        Add rule
      </ActionButton>
      <ActionButton icon={RefreshCw} spinIcon={loading} onClick={refresh} disabled={loading}>
        Refresh
      </ActionButton>
    </>
  );

  const body = (
    <div className={embedded ? 'p-0' : 'h-full min-h-0 overflow-y-auto p-3 space-y-4'}>
        {!embedded && (
          <HostRegistryBanner note="권한 룰의 env 별 narrowing은 매니페스트에 저장되지만 실제 enforcement는 호스트의 settings.json이 그대로 적용 (preview)." />
        )}
        <table className="w-full text-[0.8125rem]">
          <thead>
            <tr className="text-[0.6875rem] uppercase tracking-wider text-[var(--text-muted)] border-b border-[var(--border-color)]">
              <th className="text-left py-1.5 px-2">Tool</th>
              <th className="text-left py-1.5 px-2">Behavior</th>
              <th className="text-left py-1.5 px-2">Pattern</th>
              <th className="text-left py-1.5 px-2">Source</th>
              <th className="text-left py-1.5 px-2">Reason</th>
              <th className="text-right py-1.5 px-2 w-20">Actions</th>
            </tr>
          </thead>
          <tbody>
            {(inspect?.rules ?? []).map((r, viewIdx) => {
              const key = `${r.tool_name}::${r.pattern ?? ''}::${r.behavior}::${r.source}`;
              const editIdx = editableIdxByKey.get(key);
              const editable_ = editIdx !== undefined;
              return (
                <tr
                  key={`${key}-${viewIdx}`}
                  className="border-b border-[var(--border-color)] hover:bg-[var(--bg-tertiary)]"
                >
                  <td className="py-1.5 px-2 font-mono">{r.tool_name}</td>
                  <td className="py-1.5 px-2">
                    <StatusBadge tone={BEHAVIOR_TONE[r.behavior] ?? 'neutral'}>
                      {r.behavior}
                    </StatusBadge>
                  </td>
                  <td className="py-1.5 px-2 font-mono text-[0.75rem]">{r.pattern ?? '—'}</td>
                  <td className="py-1.5 px-2 text-[0.75rem]">{r.source}</td>
                  <td className="py-1.5 px-2 text-[0.75rem] text-[var(--text-secondary)]">
                    {r.reason ?? ''}
                  </td>
                  <td className="py-1.5 px-2 text-right">
                    {editable_ ? (
                      <div className="flex items-center justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => openEdit(editIdx!)}
                          className="text-[var(--text-muted)] hover:text-[var(--primary-color)]"
                          title="Edit"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => deleteRule(editIdx!)}
                          className="text-[var(--text-muted)] hover:text-red-600"
                          title="Delete"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ) : (
                      <span
                        className="text-[0.625rem] text-[var(--text-muted)] italic"
                        title="Read-only — defined outside user-scope settings.json"
                      >
                        external
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
            {(inspect?.rules ?? []).length === 0 && !loading && (
              <tr>
                <td colSpan={6} className="text-center py-6 text-[var(--text-muted)]">
                  No rules. Click <span className="font-mono">Add rule</span> to create one.
                </td>
              </tr>
            )}
          </tbody>
        </table>

        {inspect?.sources_consulted && inspect.sources_consulted.length > 0 && (
          <details className="mt-4 text-[0.75rem] text-[var(--text-muted)]">
            <summary className="cursor-pointer">Sources consulted ({inspect.sources_consulted.length})</summary>
            <ul className="mt-1 ml-4 list-disc">
              {inspect.sources_consulted.map((p) => (
                <li key={p} className="font-mono">{p}</li>
              ))}
            </ul>
          </details>
        )}
    </div>
  );

  const modal = (
    <EditorModal
      open={editorOpen}
      onClose={() => setEditorOpen(false)}
      title={editingIdx === null ? 'Add rule' : `Edit rule #${editingIdx}`}
        saving={saving}
        footer={
          <>
            <ActionButton onClick={() => setEditorOpen(false)} disabled={saving}>
              Cancel
            </ActionButton>
            <ActionButton
              variant="primary"
              onClick={submitForm}
              disabled={saving || !form.tool_name.trim()}
            >
              {saving ? 'Saving…' : editingIdx === null ? 'Create' : 'Save'}
            </ActionButton>
          </>
        }
      >
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="perm-tool">Tool name *</Label>
            <Input
              id="perm-tool"
              value={form.tool_name}
              onChange={(e) => setForm({ ...form, tool_name: e.target.value })}
              placeholder="Bash, Read, * (any), ..."
              className="font-mono"
            />
          </div>
          <div className="grid gap-1.5">
            <Label>Behavior</Label>
            <Select
              value={form.behavior}
              onValueChange={(v) => setForm({ ...form, behavior: v as PermissionBehavior })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BEHAVIOR_OPTIONS.map((b) => (
                  <SelectItem key={b} value={b}>{b}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="perm-pattern">Pattern <span className="opacity-60">(optional, glob/regex per executor)</span></Label>
            <Input
              id="perm-pattern"
              value={form.pattern}
              onChange={(e) => setForm({ ...form, pattern: e.target.value })}
              placeholder="git push *"
              className="font-mono"
            />
          </div>
          <div className="grid gap-1.5">
            <Label>Source</Label>
            <Select
              value={form.source}
              onValueChange={(v) => setForm({ ...form, source: v as PermissionSource })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SOURCE_OPTIONS.map((s) => (
                  <SelectItem key={s} value={s}>{s}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="perm-reason">Reason <span className="opacity-60">(optional, surfaced in UI)</span></Label>
            <Textarea
              id="perm-reason"
              value={form.reason}
              onChange={(e) => setForm({ ...form, reason: e.target.value })}
              rows={2}
            />
          </div>
        </div>
      </EditorModal>
  );

  if (embedded) {
    return (
      <div className="flex flex-col gap-3">
        {error && (
          <div className="flex items-center justify-between gap-3 px-3 py-2 rounded-md bg-[rgba(239,68,68,0.1)] border border-[rgba(239,68,68,0.3)] text-[0.75rem] text-[var(--danger-color)]">
            <span>{error}</span>
            <button
              type="button"
              onClick={() => setError(null)}
              className="text-[0.7rem] underline hover:no-underline"
            >
              dismiss
            </button>
          </div>
        )}
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="text-[0.6875rem] text-[hsl(var(--muted-foreground))] flex-1 min-w-0">
            {subtitle}
          </div>
          <div className="flex items-center gap-1.5 shrink-0 flex-wrap">{actions}</div>
        </div>
        {body}
        {modal}
      </div>
    );
  }

  return (
    <TabShell
      title="Permissions"
      icon={Shield}
      subtitle={subtitle}
      actions={actions}
      error={error}
      onDismissError={() => setError(null)}
    >
      {body}
      {modal}
    </TabShell>
  );
}

export default PermissionsTab;
