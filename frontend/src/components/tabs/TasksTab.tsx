'use client';

/**
 * TasksTab — view + manage background tasks (PR-A.5.5).
 *
 * Wraps the /api/agents/{sid}/tasks/ endpoints from PR-A.5.4.
 * Polls every 5 s while mounted so a long-running shell job updates
 * status without manual refresh. Stop button cancels in-flight tasks
 * via DELETE; the runner marks them CANCELLED.
 */

import { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n';
import { useAppStore } from '@/store/useAppStore';
import Selector, { type SelectorItem } from '@/components/ui/Selector';
import {
  backgroundTaskApi,
  BackgroundTaskRecord,
  commandApi,
  subagentTypeApi,
  SubagentTypeRow,
  adminTelemetryApi,
} from '@/lib/api';
import type { LogEntry } from '@/types';
import { RefreshCw, Square, Eye, Plus, ListChecks, ChevronLeft, FileText, Activity } from 'lucide-react';
import {
  TabShell,
  EditorModal,
  ConfirmModal,
  EmptyState,
  StatusBadge,
  ActionButton,
  IconButton,
  DataTable,
  type BadgeTone,
} from '@/components/common/layout';
import MarkdownRenderer from '@/components/file-viewer/MarkdownRenderer';
import ExecutionTimeline from '@/components/execution/ExecutionTimeline';
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

const STATUS_TONE: Record<BackgroundTaskRecord['status'], BadgeTone> = {
  pending: 'neutral',
  running: 'info',
  done: 'success',
  failed: 'danger',
  cancelled: 'warning',
};

function formatDuration(start: string | null, end: string | null): string {
  if (!start) return '—';
  const a = new Date(start).getTime();
  const b = end ? new Date(end).getTime() : Date.now();
  const sec = Math.max(0, Math.round((b - a) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  return `${min}m ${sec % 60}s`;
}

export function TasksTab() {
  const { t } = useI18n();
  const sessionId = useAppStore((s) => s.selectedSessionId) || '';
  const [rows, setRows] = useState<BackgroundTaskRecord[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // PR-F.3.2 — New Task modal.
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newKind, setNewKind] = useState('shell');
  const [newPayload, setNewPayload] = useState('{}');
  const [newSubagentType, setNewSubagentType] = useState<string>('');
  const [subagentTypes, setSubagentTypes] = useState<SubagentTypeRow[]>([]);
  // PR-F.6.6 — runner capacity meter.
  const [capacity, setCapacity] = useState<{ in_flight: number | null; max: number | null } | null>(null);
  // Inline detail view: when set, the tab renders the task's detail page
  // (output + tool trail) instead of the list. Back clears it.
  const [detailRow, setDetailRow] = useState<BackgroundTaskRecord | null>(null);
  const [stopRow, setStopRow] = useState<BackgroundTaskRecord | null>(null);

  useEffect(() => {
    subagentTypeApi.list()
      .then((r) => setSubagentTypes(r.types))
      .catch(() => {/* viewer is optional */});
    const loadStatus = () => {
      adminTelemetryApi.systemStatus()
        .then((r) => {
          if (r.task_runner) {
            setCapacity({
              in_flight: r.task_runner.in_flight ?? null,
              max: r.task_runner.max_concurrency ?? null,
            });
          }
        })
        .catch(() => {});
    };
    loadStatus();
  }, []);

  const refresh = useCallback(async () => {
    if (!sessionId) return;
    setLoading(true);
    setError(null);
    try {
      const resp = await backgroundTaskApi.list(sessionId, {
        status: statusFilter || undefined,
        limit: 50,
      });
      setRows(resp.tasks);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [sessionId, statusFilter]);

  // Manual-refresh model: load once per session/filter change; the user
  // refreshes explicitly (no background polling).
  useEffect(() => {
    refresh();
  }, [refresh]);

  // Keep the open detail's header (status/duration) fresh as the list reloads.
  useEffect(() => {
    setDetailRow((cur) => {
      if (!cur) return cur;
      const next = rows.find((r) => r.task_id === cur.task_id);
      return next && (next.status !== cur.status || next.completed_at !== cur.completed_at)
        ? next
        : cur;
    });
  }, [rows]);

  const handleStop = useCallback(
    async (taskId: string) => {
      if (!sessionId) return;
      try {
        await backgroundTaskApi.stop(sessionId, taskId);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        refresh();
      }
    },
    [sessionId, refresh],
  );

  // PR-F.3.2 — submit a new background task.
  const handleCreate = async () => {
    if (!sessionId) return;
    let payload: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(newPayload);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('payload must be a JSON object');
      }
      payload = parsed as Record<string, unknown>;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    if (newSubagentType) {
      payload.subagent_type = newSubagentType;
    }
    setCreating(true);
    setError(null);
    try {
      await backgroundTaskApi.create(sessionId, newKind.trim() || 'shell', payload);
      toast.success(`Submitted ${newKind || 'shell'} task`);
      setCreateOpen(false);
      setNewPayload('{}');
      setNewSubagentType('');
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  if (!sessionId) {
    return (
      <TabShell title="Background Tasks" icon={ListChecks}>
        <EmptyState
          title="No session selected"
          description="Select a session to view its background tasks."
        />
      </TabShell>
    );
  }

  return (
    <TabShell
      title="Background Tasks"
      icon={ListChecks}
      actions={
        detailRow ? undefined : (
        <>
          {capacity && (capacity.in_flight !== null || capacity.max !== null) && (
            <StatusBadge
              tone="info"
              uppercase
              className="h-7"
              title="Process-wide BackgroundTaskRunner load"
            >
              {capacity.in_flight ?? '?'} / {capacity.max ?? '∞'}
            </StatusBadge>
          )}
          <Selector
            variant="field"
            size="sm"
            fullWidth={false}
            minWidthPx={160}
            ariaLabel="Status filter"
            value={statusFilter}
            onChange={setStatusFilter}
            items={[
              { id: '', label: 'All statuses' },
              { id: 'pending', label: 'Pending' },
              { id: 'running', label: 'Running' },
              { id: 'done', label: 'Done' },
              { id: 'failed', label: 'Failed' },
              { id: 'cancelled', label: 'Cancelled' },
            ] as SelectorItem[]}
          />
          <IconButton icon={Plus} variant="primary" title="New task" onClick={() => setCreateOpen(true)} />
          <IconButton icon={RefreshCw} title="Refresh" spin={loading} onClick={refresh} disabled={loading} />
        </>
        )
      }
      error={error}
      onDismissError={() => setError(null)}
    >
      {detailRow ? (
        <TaskDetailView
          task={detailRow}
          sessionId={sessionId}
          onBack={() => setDetailRow(null)}
        />
      ) : (
      <div className="h-full min-h-0 overflow-y-auto p-4">
      <div className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-card)] overflow-hidden">
        <DataTable
          rows={rows}
          keyOf={(r) => r.task_id}
          empty={
            <EmptyState
              icon={ListChecks}
              title="No tasks"
              description="Tools that submit background work (TaskCreate / Cron-fired jobs) will appear here."
            />
          }
          columns={[
            { key: 'id', header: 'Task ID', mono: true, width: 'minmax(7rem,1.3fr)', render: (r) => `${r.task_id.slice(0, 12)}…` },
            { key: 'kind', header: 'Kind', width: 'minmax(0,1fr)', render: (r) => r.kind },
            {
              key: 'status',
              header: 'Status',
              width: 'minmax(0,1.5fr)',
              render: (r) => (
                <span className="inline-flex items-center gap-2 min-w-0">
                  <StatusBadge tone={STATUS_TONE[r.status]}>{r.status}</StatusBadge>
                  {r.error && (
                    <span className="text-xs text-rose-400 truncate">{r.error}</span>
                  )}
                </span>
              ),
            },
            { key: 'dur', header: 'Duration', mono: true, width: 'minmax(4.5rem,0.8fr)', render: (r) => formatDuration(r.started_at, r.completed_at) },
          ]}
          rowActions={(row) => {
            const isTerminal =
              row.status === 'done' || row.status === 'failed' || row.status === 'cancelled';
            return [
              { icon: Eye, label: 'Output', onClick: () => setDetailRow(row), title: 'View output + tool trail' },
              {
                icon: Square,
                label: 'Stop',
                danger: true,
                disabled: isTerminal,
                onClick: () => setStopRow(row),
                title: isTerminal ? 'Already finished' : 'Stop this task',
              },
            ];
          }}
        />
      </div>
      </div>
      )}

      <EditorModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="New background task"
        saving={creating}
        width="lg"
        footer={
          <>
            <ActionButton onClick={() => setCreateOpen(false)} disabled={creating}>
              Cancel
            </ActionButton>
            <ActionButton
              variant="primary"
              onClick={handleCreate}
              disabled={creating || !newKind.trim()}
            >
              {creating ? 'Submitting…' : 'Create'}
            </ActionButton>
          </>
        }
      >
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="task-kind">Kind</Label>
            <Input
              id="task-kind"
              value={newKind}
              onChange={(e) => setNewKind(e.target.value)}
              placeholder="shell, agent, …"
            />
          </div>
          {subagentTypes.length > 0 && (
            <div className="grid gap-1.5">
              <Label>Subagent type <span className="opacity-60">(optional)</span></Label>
              <Select
                value={newSubagentType || '__none__'}
                onValueChange={(v) => setNewSubagentType(v === '__none__' ? '' : v)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="— none —" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">— none —</SelectItem>
                  {subagentTypes.map((t) => (
                    <SelectItem key={t.agent_type} value={t.agent_type}>
                      {t.agent_type} — {t.description.slice(0, 60)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="task-payload">Payload <span className="opacity-60">(JSON object)</span></Label>
            <Textarea
              id="task-payload"
              value={newPayload}
              onChange={(e) => setNewPayload(e.target.value)}
              rows={6}
              className="font-mono text-xs"
            />
          </div>
        </div>
      </EditorModal>

      {/* Stop confirmation — reusable ConfirmModal */}
      <ConfirmModal
        open={!!stopRow}
        onClose={() => setStopRow(null)}
        onConfirm={async () => {
          if (stopRow) await handleStop(stopRow.task_id);
          setStopRow(null);
        }}
        title={t('tasksTab.stopTitle')}
        danger
        confirmLabel={t('tasksTab.stopConfirmLabel')}
        cancelLabel={t('tasksTab.stopCancelLabel')}
        message={
          stopRow ? (
            <span>
              <span className="font-mono text-xs">{stopRow.task_id.slice(0, 12)}…</span>{' '}
              {t('tasksTab.stopQuestion', { kind: stopRow.kind })}
              {stopRow.kind === 'subagent' && t('tasksTab.stopSubagentNote')}
            </span>
          ) : null
        }
      />
    </TabShell>
  );
}

/**
 * TaskDetailView — inline detail page for one task (rendered IN the tasks tab,
 * not a modal). Shows the rendered Output (markdown) + the granular tool trail
 * (ExecutionTimeline, the same view as the session log tab). Back returns to the list.
 *
 * The tool trail is fetched for the sub-agent's own log when available
 * (payload.sub_agent_id), falling back to the owning session's log — so a
 * sub-agent task surfaces real TOOL/RESULT/RESPONSE entries.
 */
function TaskDetailView({
  task,
  sessionId,
  onBack,
}: {
  task: BackgroundTaskRecord;
  sessionId: string;
  onBack: () => void;
}) {
  const { t } = useI18n();
  const [output, setOutput] = useState('');
  const [outLoading, setOutLoading] = useState(true);
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [logLoading, setLogLoading] = useState(true);
  const [logSource, setLogSource] = useState<string>('');
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [showAllLevels, setShowAllLevels] = useState(true);

  const payload = (task.payload || {}) as Record<string, unknown>;
  const subAgentId = typeof payload.sub_agent_id === 'string' ? payload.sub_agent_id : '';
  const ownerId = typeof payload._session_id === 'string' ? payload._session_id : sessionId;
  const taskLabel = typeof payload.task === 'string' ? payload.task : '';

  const load = useCallback(async () => {
    setOutLoading(true);
    try {
      setOutput(await backgroundTaskApi.output(sessionId, task.task_id));
    } catch (e) {
      setOutput(t('tasksTab.outputLoadError', { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setOutLoading(false);
    }
    setLogLoading(true);
    try {
      // THIS assignment's own trail first (per-assignment key = task_id with
      // ':'→'_', matching the backend's trail_log_key), then the sub_agent_id
      // (legacy concatenated log), then the owning session as a last resort.
      const perAssignment = task.task_id.replace(/:/g, '_');
      const candidates = [perAssignment, subAgentId, ownerId].filter(Boolean);
      let used = '';
      let res: Awaited<ReturnType<typeof commandApi.getLogs>> | null = null;
      for (const c of candidates) {
        res = await commandApi.getLogs(c, 400).catch(() => null);
        if (res && res.entries?.length) {
          used = c;
          break;
        }
      }
      setLogSource(used || candidates[0] || '');
      setEntries(res?.entries || []);
    } catch {
      setEntries([]);
    } finally {
      setLogLoading(false);
    }
  }, [sessionId, task.task_id, subAgentId, ownerId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="h-full min-h-0 flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--border-color)] bg-[var(--bg-secondary)]">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs border border-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
        >
          <ChevronLeft className="w-3.5 h-3.5" /> {t('tasksTab.back')}
        </button>
        <div className="min-w-0 flex items-center gap-2">
          <span className="text-[var(--text-primary)] font-medium">{task.kind}</span>
          <span className="font-mono text-xs text-[var(--text-muted)]">{task.task_id.slice(0, 16)}…</span>
          <StatusBadge tone={STATUS_TONE[task.status]}>{task.status}</StatusBadge>
          <span className="font-mono text-xs text-[var(--text-muted)]">
            {formatDuration(task.started_at, task.completed_at)}
          </span>
        </div>
        <IconButton
          icon={RefreshCw}
          title={t('tasksTab.refresh')}
          spin={outLoading || logLoading}
          onClick={() => void load()}
          className="ml-auto"
        />
      </div>

      {taskLabel && (
        <div className="px-4 py-2 text-xs text-[var(--text-secondary)] border-b border-[var(--border-color)] bg-[var(--bg-tertiary)] truncate">
          {taskLabel}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto">
        {/* Output (rendered markdown) */}
        <section className="border-b border-[var(--border-color)]">
          <div className="flex items-center gap-1.5 px-4 pt-3 pb-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
            <FileText className="w-3.5 h-3.5" /> {t('tasksTab.sectionOutput')}
          </div>
          {outLoading ? (
            <div className="px-4 py-6 text-sm text-[var(--text-muted)] animate-pulse">{t('tasksTab.loading')}</div>
          ) : output.trim() ? (
            <div className="text-[var(--text-primary)]">
              <MarkdownRenderer content={output} />
            </div>
          ) : (
            <div className="px-4 py-6 text-sm text-[var(--text-muted)]">
              {t('tasksTab.noOutput')}
            </div>
          )}
        </section>

        {/* Granular tool trail */}
        <section>
          <div className="flex items-center gap-1.5 px-4 pt-3 pb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
            <Activity className="w-3.5 h-3.5" /> {t('tasksTab.sectionToolTrail')}
            {logSource && (
              <span className="font-mono normal-case font-normal text-[0.65rem] text-[var(--text-muted)]">
                · {logSource.slice(0, 14)}
              </span>
            )}
          </div>
          {logLoading ? (
            <div className="px-4 py-6 text-sm text-[var(--text-muted)] animate-pulse">{t('tasksTab.loading')}</div>
          ) : entries.length ? (
            <div className="px-2 pb-4">
              <ExecutionTimeline
                entries={entries}
                selectedIndex={selectedIdx}
                onSelectEntry={setSelectedIdx}
                showAllLevels={showAllLevels}
                onToggleShowAll={() => setShowAllLevels((v) => !v)}
                isExecuting={task.status === 'running'}
              />
            </div>
          ) : (
            <div className="px-4 py-6 text-sm text-[var(--text-muted)]">
              {t('tasksTab.noToolTrail')}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

export default TasksTab;
