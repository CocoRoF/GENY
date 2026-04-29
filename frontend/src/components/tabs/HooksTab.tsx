'use client';

/**
 * HooksTab — view & edit the executor's HookConfig.
 *
 * H.2 (cycle 20260426_2) — full schema rewrite to match the executor's
 * ``HookConfigEntry`` after H.1 fixed the backend. Inputs:
 *   - event picker (16 lowercase HookEvent values)
 *   - command (single executable) + args (one per line)
 *   - match dict editor (key/value rows; today's only meaningful key is "tool")
 *   - env table (key/value rows)
 *   - working_dir (optional)
 *   - timeout_ms (optional)
 *   - top-level audit_log_path
 *
 * Header still surfaces the dual gate (file-side ``enabled`` + env opt-in
 * ``GENY_ALLOW_HOOKS``) so the operator sees at a glance why an entry
 * isn't firing.
 */

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  hookApi,
  HOOK_EVENTS,
  HookEvent,
  HookEntryPayload,
  HookEntryRow,
  HookEntriesResponse,
  HookListResponse,
  HookFiresResponse,
} from '@/lib/api';
import { Pencil, Plug, Trash2, X } from 'lucide-react';
import { EditorModal, ActionButton } from '@/components/layout';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useI18n } from '@/lib/i18n';
import EnvDefaultStarToggle from '@/components/env_management/EnvDefaultStarToggle';
import { useEnvDefaults } from '@/components/env_management/useEnvDefaults';
import { hookIdFromEditable } from '@/lib/envDefaultsApi';
import {
  RegistryPageShell,
  RegistrySection,
  RegistryCard,
  RegistryEmptyState,
  RegistryActionButton,
} from '@/components/env_management/registry';

type HookRow = HookEntryRow;

interface KvRow {
  key: string;
  value: string;
}

interface EntryFormState {
  event: HookEvent;
  command: string;        // single executable
  argsText: string;       // one per line
  timeout_ms: string;     // free-text → parseInt
  match: KvRow[];         // dict rows
  env: KvRow[];           // dict rows
  working_dir: string;
}

const EMPTY_FORM: EntryFormState = {
  event: 'pre_tool_use',
  command: '',
  argsText: '',
  timeout_ms: '',
  match: [],
  env: [],
  working_dir: '',
};

function rowsToDict(rows: KvRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows) {
    const k = r.key.trim();
    if (!k) continue;
    out[k] = r.value;
  }
  return out;
}

function dictToRows(d: Record<string, unknown> | null | undefined): KvRow[] {
  if (!d || typeof d !== 'object') return [];
  return Object.entries(d).map(([k, v]) => ({ key: k, value: String(v ?? '') }));
}

function formToPayload(f: EntryFormState): HookEntryPayload {
  const ms = f.timeout_ms.trim() ? Number.parseInt(f.timeout_ms.trim(), 10) : null;
  const args = f.argsText
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const wd = f.working_dir.trim();
  return {
    event: f.event,
    command: f.command.trim(),
    args: args.length ? args : undefined,
    timeout_ms: ms !== null && !Number.isNaN(ms) ? ms : null,
    match: f.match.length ? rowsToDict(f.match) : undefined,
    env: f.env.length ? rowsToDict(f.env) : undefined,
    working_dir: wd.length ? wd : null,
  };
}

function rowToForm(row: HookEntryRow): EntryFormState {
  return {
    event: row.event as HookEvent,
    command: row.command,
    argsText: (row.args ?? []).join('\n'),
    timeout_ms: row.timeout_ms != null ? String(row.timeout_ms) : '',
    match: dictToRows(row.match),
    env: dictToRows(row.env),
    working_dir: row.working_dir ?? '',
  };
}

function summarizeMatch(m: Record<string, unknown> | undefined): string {
  if (!m) return '*';
  const entries = Object.entries(m);
  if (entries.length === 0) return '*';
  return entries.map(([k, v]) => `${k}=${String(v)}`).join(', ');
}

function KvEditor({
  rows,
  onChange,
  keyPlaceholder = 'key',
  valuePlaceholder = 'value',
  emptyHint,
}: {
  rows: KvRow[];
  onChange: (rows: KvRow[]) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  emptyHint?: string;
}) {
  return (
    <div className="grid gap-1.5">
      {rows.length === 0 && emptyHint && (
        <div className="text-[0.6875rem] text-[var(--text-muted)] italic">{emptyHint}</div>
      )}
      {rows.map((row, i) => (
        <div key={i} className="flex gap-1.5 items-center">
          <Input
            value={row.key}
            placeholder={keyPlaceholder}
            onChange={(e) => {
              const next = [...rows];
              next[i] = { ...next[i], key: e.target.value };
              onChange(next);
            }}
            className="font-mono text-[0.75rem] flex-1"
          />
          <Input
            value={row.value}
            placeholder={valuePlaceholder}
            onChange={(e) => {
              const next = [...rows];
              next[i] = { ...next[i], value: e.target.value };
              onChange(next);
            }}
            className="font-mono text-[0.75rem] flex-1"
          />
          <button
            type="button"
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
            className="text-[var(--text-muted)] hover:text-red-600 p-1"
            title="Remove"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...rows, { key: '', value: '' }])}
        className="text-[0.75rem] text-[var(--primary-color)] hover:underline self-start"
      >
        + Add row
      </button>
    </div>
  );
}

export interface HooksTabProps {
  /** Deprecated — embedded mode is no longer used after Phase 5
   *  (env-side picker uses HostEnvSelectionPicker). The prop
   *  remains for callers still passing it; it has no effect. */
  embedded?: boolean;
}

export function HooksTab(_props: HooksTabProps = {}) {
  const { t } = useI18n();
  const [editable, setEditable] = useState<HookEntriesResponse | null>(null);
  const [inspect, setInspect] = useState<HookListResponse | null>(null);
  const [fires, setFires] = useState<HookFiresResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Lazy-load env-defaults on mount so the ★ column hydrates without
  // each row firing its own GET. The store de-dups concurrent calls.
  const loadEnvDefaultsOnce = useEnvDefaults((s) => s.loadOnce);
  useEffect(() => {
    loadEnvDefaultsOnce();
  }, [loadEnvDefaultsOnce]);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingTarget, setEditingTarget] = useState<{ event: string; idx: number } | null>(null);
  const [form, setForm] = useState<EntryFormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const [auditDraft, setAuditDraft] = useState('');
  const [savingAudit, setSavingAudit] = useState(false);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const [edit, ins, recent] = await Promise.all([
        hookApi.listEditable(),
        hookApi.inspect(),
        hookApi.recentFires(50),
      ]);
      setEditable(edit);
      setInspect(ins);
      setFires(recent);
      setAuditDraft(edit.audit_log_path ?? '');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const grouped = useMemo(() => {
    const map = new Map<string, HookEntryRow[]>();
    (editable?.entries ?? []).forEach((row) => {
      if (!map.has(row.event)) map.set(row.event, []);
      map.get(row.event)!.push(row);
    });
    return map;
  }, [editable]);

  const openCreate = () => {
    setEditingTarget(null);
    setForm(EMPTY_FORM);
    setEditorOpen(true);
  };

  const openEdit = (row: HookEntryRow) => {
    setEditingTarget({ event: row.event, idx: row.idx });
    setForm(rowToForm(row));
    setEditorOpen(true);
  };

  const submitForm = async () => {
    const payload = formToPayload(form);
    if (!payload.command) {
      setError('command is required');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = editingTarget
        ? await hookApi.replace(editingTarget.event, editingTarget.idx, payload)
        : await hookApi.append(payload);
      setEditable(res);
      setAuditDraft(res.audit_log_path ?? '');
      try {
        const ins = await hookApi.inspect();
        setInspect(ins);
      } catch {/* ignore */}
      toast.success(editingTarget ? 'Hook updated' : 'Hook added');
      setEditorOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const deleteEntry = async (row: HookEntryRow) => {
    const confirmed = window.confirm(
      `Delete hook ${row.event}#${row.idx} (${row.command})?`,
    );
    if (!confirmed) return;
    setError(null);
    try {
      const res = await hookApi.remove(row.event, row.idx);
      setEditable(res);
      try {
        const ins = await hookApi.inspect();
        setInspect(ins);
      } catch {/* ignore */}
      toast.success(`Removed hook ${row.event}#${row.idx}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const toggleEnabled = async () => {
    if (!editable) return;
    setError(null);
    try {
      const res = await hookApi.setEnabled(!editable.enabled);
      setEditable(res);
      try {
        const ins = await hookApi.inspect();
        setInspect(ins);
      } catch {/* ignore */}
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const saveAuditLog = async () => {
    setSavingAudit(true);
    setError(null);
    try {
      const trimmed = auditDraft.trim();
      const res = await hookApi.setAuditLog(trimmed.length ? trimmed : null);
      setEditable(res);
      setAuditDraft(res.audit_log_path ?? '');
      toast.success(trimmed ? 'Audit log path saved' : 'Audit log path cleared');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingAudit(false);
    }
  };

  const totalEditable = editable?.entries.length ?? 0;
  const totalLoaded = inspect?.entries.length ?? 0;
  const fileEnabled = editable?.enabled ?? false;
  const envOptIn = inspect?.env_opt_in ?? false;
  const willFire = fileEnabled && envOptIn;
  const addLabel = t('envManagement.registry.hooks.addLabel');

  const subtitle = (
    <>
      File:{' '}
      <button
        type="button"
        onClick={toggleEnabled}
        className={`font-mono ${
          fileEnabled
            ? 'text-emerald-600 dark:text-emerald-400'
            : 'text-[hsl(var(--muted-foreground))]'
        } hover:underline`}
        title="Toggle"
      >
        {fileEnabled ? 'enabled' : 'disabled'}
      </button>
      {' · Env '}
      <span className="font-mono">GENY_ALLOW_HOOKS</span>:{' '}
      <span
        className={
          'font-mono ' +
          (envOptIn ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600')
        }
      >
        {envOptIn ? 'set' : 'unset'}
      </span>
      {' · '}
      {totalEditable} editable / {totalLoaded} loaded
      {editable && (
        <>
          {' · '}
          <span className="font-mono">{editable.settings_path}</span>
        </>
      )}
    </>
  );

  const liveBadge = (
    <span
      className={`inline-flex items-center h-7 px-2 rounded-md text-[0.6875rem] uppercase tracking-wider font-semibold border ${
        willFire
          ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
          : 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300'
      }`}
      title={
        willFire
          ? 'Both file flag and GENY_ALLOW_HOOKS are set — hooks will fire.'
          : 'Hooks will NOT fire — both file flag AND GENY_ALLOW_HOOKS env var must be set.'
      }
    >
      {willFire ? 'live' : 'gated'}
    </span>
  );

  const isEmpty = totalEditable === 0 && !loading;

  const auditLogSection = (
    <section className="rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-3 space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-[0.6875rem] uppercase tracking-wider text-[hsl(var(--muted-foreground))] font-semibold">
          Audit log
        </h3>
        <span className="text-[0.6875rem] text-[hsl(var(--muted-foreground))]">
          fires-tracking · 권장
        </span>
      </div>
      <div className="flex gap-1.5 items-center">
        <Input
          value={auditDraft}
          onChange={(e) => setAuditDraft(e.target.value)}
          placeholder="/var/log/geny/hooks.jsonl"
          className="font-mono text-[0.75rem]"
        />
        <ActionButton
          onClick={saveAuditLog}
          disabled={
            savingAudit ||
            auditDraft.trim() === (editable?.audit_log_path ?? '')
          }
        >
          {savingAudit ? 'Saving…' : 'Save'}
        </ActionButton>
      </div>
      <div className="text-[0.6875rem] text-[hsl(var(--muted-foreground))]">
        Empty = no audit log. 운영 환경에선 비워두지 마세요 — 발화가 추적되지
        않습니다.
      </div>
    </section>
  );

  const recentFiresSection = (
    <section>
      <h3 className="text-[0.6875rem] uppercase tracking-wider text-[hsl(var(--muted-foreground))] font-semibold mb-2 flex items-center gap-2">
        Recent fires
        {fires?.audit_path && (
          <span className="text-[hsl(var(--muted-foreground))] font-normal font-mono normal-case">
            {fires.audit_path}
          </span>
        )}
      </h3>
      {!fires?.audit_path ? (
        <div className="text-[0.75rem] text-[hsl(var(--muted-foreground))]">
          No <span className="font-mono">audit_log_path</span> configured. Set
          one above to capture fires.
        </div>
      ) : !fires.exists ? (
        <div className="text-[0.75rem] text-[hsl(var(--muted-foreground))]">
          Audit log file not yet created — fires will appear here once a hook
          runs.
        </div>
      ) : fires.fires.length === 0 ? (
        <div className="text-[0.75rem] text-[hsl(var(--muted-foreground))]">
          No fires yet.
        </div>
      ) : (
        <div className="rounded-lg border border-[hsl(var(--border))] overflow-hidden bg-[hsl(var(--card))]">
          {fires.truncated && (
            <div className="px-2 py-1 text-[0.6875rem] text-amber-800 bg-amber-500/10 border-b border-amber-500/30">
              Truncated — older fires omitted.
            </div>
          )}
          <ul className="max-h-72 overflow-y-auto divide-y divide-[hsl(var(--border))]">
            {fires.fires
              .slice()
              .reverse()
              .map((row, i) => (
                <li key={i} className="px-2 py-1.5 text-[0.75rem] font-mono">
                  <details>
                    <summary className="cursor-pointer truncate">
                      {String(row.record.event ?? row.record.hook_event ?? 'fire')}
                      {' · '}
                      {String(
                        row.record.tool_name ??
                          row.record.payload_tool_name ??
                          '',
                      )}
                      {' · '}
                      <span className="text-[hsl(var(--muted-foreground))]">
                        {String(row.record.ts ?? row.record.timestamp ?? '')}
                      </span>
                    </summary>
                    <pre className="mt-1 text-[0.6875rem] text-[hsl(var(--muted-foreground))] whitespace-pre-wrap">
                      {JSON.stringify(row.record, null, 2)}
                    </pre>
                  </details>
                </li>
              ))}
          </ul>
        </div>
      )}
    </section>
  );

  const modal = (
    <EditorModal
      open={editorOpen}
      onClose={() => setEditorOpen(false)}
      title={editingTarget ? `Edit ${editingTarget.event}#${editingTarget.idx}` : 'Add hook'}
        saving={saving}
        footer={
          <>
            <ActionButton onClick={() => setEditorOpen(false)} disabled={saving}>
              Cancel
            </ActionButton>
            <ActionButton
              variant="primary"
              onClick={submitForm}
              disabled={saving || !form.command.trim()}
            >
              {saving ? 'Saving…' : editingTarget ? 'Save' : 'Create'}
            </ActionButton>
          </>
        }
      >
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label>Event</Label>
            <Select
              value={form.event}
              onValueChange={(v) => setForm({ ...form, event: v as HookEvent })}
              disabled={!!editingTarget}
            >
              <SelectTrigger title={editingTarget ? 'Change event by deleting and re-adding' : ''}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {HOOK_EVENTS.map((ev) => (
                  <SelectItem key={ev} value={ev}>{ev}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="hook-cmd">Command <span className="opacity-60">(single executable path)</span></Label>
            <Input
              id="hook-cmd"
              value={form.command}
              onChange={(e) => setForm({ ...form, command: e.target.value })}
              placeholder="/usr/local/bin/audit-hook"
              className="font-mono"
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="hook-args">Args <span className="opacity-60">(one per line; no shell interpolation)</span></Label>
            <Textarea
              id="hook-args"
              value={form.argsText}
              onChange={(e) => setForm({ ...form, argsText: e.target.value })}
              placeholder={'--session\n${session_id}'}
              className="font-mono text-[0.75rem]"
              rows={3}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="hook-timeout">Timeout <span className="opacity-60">(ms)</span></Label>
              <Input
                id="hook-timeout"
                value={form.timeout_ms}
                onChange={(e) => setForm({ ...form, timeout_ms: e.target.value })}
                placeholder="5000"
                inputMode="numeric"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="hook-wd">Working dir <span className="opacity-60">(optional)</span></Label>
              <Input
                id="hook-wd"
                value={form.working_dir}
                onChange={(e) => setForm({ ...form, working_dir: e.target.value })}
                placeholder="/tmp"
                className="font-mono"
              />
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label>Match <span className="opacity-60">(empty = match every event of this kind; today only the &quot;tool&quot; key is honored)</span></Label>
            <KvEditor
              rows={form.match}
              onChange={(rows) => setForm({ ...form, match: rows })}
              keyPlaceholder="tool"
              valuePlaceholder="Bash"
              emptyHint='No match filter — fires for every event. Add e.g. tool=Bash to limit.'
            />
          </div>

          <div className="grid gap-1.5">
            <Label>Env <span className="opacity-60">(extra environment variables for the subprocess)</span></Label>
            <KvEditor
              rows={form.env}
              onChange={(rows) => setForm({ ...form, env: rows })}
              keyPlaceholder="DEBUG"
              valuePlaceholder="1"
              emptyHint="No extra env. Parent env is inherited."
            />
          </div>
        </div>
      </EditorModal>
  );

  return (
    <>
      <RegistryPageShell
        icon={Plug}
        title={t('envManagement.registry.hooks.title')}
        subtitle={subtitle}
        countLabel={t('envManagement.registry.hooks.countLabel', {
          n: String(totalEditable),
        })}
        bannerNote={t('envManagement.registry.hooks.bannerNote')}
        addLabel={addLabel}
        onAdd={openCreate}
        onRefresh={refresh}
        loading={loading}
        error={error}
        onDismissError={() => setError(null)}
        headerExtras={liveBadge}
      >
        {auditLogSection}

        {isEmpty ? (
          <RegistryEmptyState
            icon={Plug}
            title={t('envManagement.registry.hooks.emptyTitle')}
            hint={t('envManagement.registry.emptyHint', { addLabel })}
            addLabel={addLabel}
            onAdd={openCreate}
          />
        ) : (
          Array.from(grouped.entries()).map(([event, rows]) => (
            <RegistrySection key={event} label={event} count={rows.length}>
              {rows.map((row) => (
                <HookCard
                  key={`${row.event}-${row.idx}`}
                  row={row}
                  onEdit={() => openEdit(row)}
                  onDelete={() => deleteEntry(row)}
                />
              ))}
            </RegistrySection>
          ))
        )}

        {recentFiresSection}
      </RegistryPageShell>

      {modal}
    </>
  );
}

export default HooksTab;

// ── Card ─────────────────────────────────────────────────────────

function HookCard({
  row,
  onEdit,
  onDelete,
}: {
  row: HookRow;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const argsCount = (row.args ?? []).length;
  const matchSummary = summarizeMatch(row.match);
  return (
    <RegistryCard
      icon={Plug}
      title={row.command || '—'}
      titleMono
      subtitle={
        argsCount > 0 ? (
          <span className="opacity-80">{(row.args ?? []).join(' ')}</span>
        ) : undefined
      }
      badges={[
        ...(row.timeout_ms != null
          ? [
              {
                label: t('envManagement.registry.hooks.timeoutMs', {
                  n: String(row.timeout_ms),
                }),
                tone: 'neutral' as const,
              },
            ]
          : []),
        ...(matchSummary && matchSummary !== '—'
          ? [{ label: matchSummary, tone: 'info' as const }]
          : []),
        ...(argsCount > 0
          ? [
              {
                label: t('envManagement.registry.hooks.argsCount', {
                  n: String(argsCount),
                }),
                tone: 'neutral' as const,
              },
            ]
          : []),
      ]}
      meta={`#${row.idx}`}
      star={
        <EnvDefaultStarToggle
          category="hooks"
          itemId={hookIdFromEditable({
            event: row.event,
            command: row.command,
            args: row.args,
          })}
        />
      }
      actions={
        <>
          <RegistryActionButton
            icon={Pencil}
            onClick={onEdit}
            title={t('envManagement.registry.editTip')}
            variant="primary"
          />
          <RegistryActionButton
            icon={Trash2}
            onClick={onDelete}
            title={t('envManagement.registry.deleteTip')}
            variant="danger"
          />
        </>
      }
    />
  );
}
