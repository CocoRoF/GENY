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
  HookEntryRow,
  HookEntriesResponse,
  HookListResponse,
  HookFiresResponse,
} from '@/lib/api';
import { Pencil, Plug, Trash2 } from 'lucide-react';
import { ActionButton } from '@/components/layout';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/lib/i18n';
import EnvDefaultStarToggle from '@/components/env_management/EnvDefaultStarToggle';
import { useEnvDefaults } from '@/components/env_management/useEnvDefaults';
import { hookIdFromEditable } from '@/lib/envDefaultsApi';
import HookFormModal, {
  type HookFormSubmit,
} from '@/components/env_management/hooks/HookFormModal';
import {
  RegistryPageShell,
  RegistrySection,
  RegistryCard,
  RegistryEmptyState,
  RegistryActionButton,
} from '@/components/env_management/registry';

type HookRow = HookEntryRow;

/** Format a hook entry's match dict for the card meta line. */
function summarizeMatch(m: Record<string, unknown> | undefined): string {
  if (!m) return '*';
  const entries = Object.entries(m);
  if (entries.length === 0) return '*';
  return entries.map(([k, v]) => `${k}=${String(v)}`).join(', ');
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
  const [editingRow, setEditingRow] = useState<HookEntryRow | null>(null);
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
    setEditingRow(null);
    setError(null);
    setEditorOpen(true);
  };

  const openEdit = (row: HookEntryRow) => {
    setEditingTarget({ event: row.event, idx: row.idx });
    setEditingRow(row);
    setError(null);
    setEditorOpen(true);
  };

  const handleSubmit = async (payload: HookFormSubmit) => {
    setSaving(true);
    setError(null);
    try {
      // Coerce HookFormSubmit (which always has the keys) into the
      // optional-key shape `hookApi` expects — empty dicts/arrays
      // become undefined so the wire payload stays compact.
      const wire = {
        event: payload.event,
        command: payload.command,
        args: payload.args.length ? payload.args : undefined,
        timeout_ms: payload.timeout_ms,
        match: Object.keys(payload.match).length ? payload.match : undefined,
        env: Object.keys(payload.env).length ? payload.env : undefined,
        working_dir: payload.working_dir,
      };
      const res = editingTarget
        ? await hookApi.replace(editingTarget.event, editingTarget.idx, wire)
        : await hookApi.append(wire);
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
    <HookFormModal
      open={editorOpen}
      editingTarget={editingTarget}
      initialRow={editingRow}
      saving={saving}
      error={error}
      onClose={() => setEditorOpen(false)}
      onSubmit={handleSubmit}
    />
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
