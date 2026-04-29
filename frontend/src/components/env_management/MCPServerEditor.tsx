'use client';

/**
 * MCPServerEditor — env-scoped curated CRUD over `manifest.tools.mcp_servers`.
 *
 * Each entry describes how to spawn an MCP server subprocess at session
 * start. Fields mirror the canonical entry shape from
 * `geny_executor.mcp.manager.MCPManager`:
 *
 *   {
 *     name: string,                 // required, prefix for tool names
 *     command: string,              // required, executable
 *     args?: string[],              // command-line args
 *     env?: Record<string, string>, // per-server env vars
 *     disabled?: boolean,           // skip at boot without removing entry
 *     autoApprove?: string[],       // tool names that bypass HITL
 *   }
 *
 * Edit happens through a modal so the panel stays compact in list mode.
 */

import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Database,
  Globe,
  Pencil,
  Plus,
  Power,
  RefreshCw,
  Server,
  Star,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import {
  customMcpApi,
  type CustomMcpServerSummary,
} from '@/lib/api';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useEnvDefaults } from './useEnvDefaults';
import {
  customMcpToEnvEntry,
  type MCPServerEntry,
  type MCPTransport,
} from '@/lib/mcpServerEntry';

// Re-export so existing callers (`import { MCPServerEntry } from '@/components/env_management/MCPServerEditor'`)
// keep working — the canonical home is now lib/, but the store
// already had import paths pinned to this file.
export type { MCPServerEntry, MCPTransport };
export { customMcpToEnvEntry };

// MCPServerEntry / MCPTransport / customMcpToEnvEntry live in
// `@/lib/mcpServerEntry` — see the re-export at the top of the
// imports block. Keeping them in lib/ lets the new-draft seeder
// (Zustand store) consume the converter without importing this
// component file.

export interface MCPServerEditorProps {
  value: MCPServerEntry[];
  onChange: (next: MCPServerEntry[]) => void;
}

export default function MCPServerEditor({
  value,
  onChange,
}: MCPServerEditorProps) {
  const { t } = useI18n();
  const [editing, setEditing] = useState<{
    index: number;
    draft: MCPServerEntry;
  } | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const startAdd = () => {
    setEditing({
      index: -1,
      draft: { name: '', command: '', args: [], env: {}, disabled: false },
    });
  };

  /** Add a snapshot of one or more host-registered MCP servers. The
   *  picker handles fetching and shape conversion via
   *  `customMcpToEnvEntry`; we just append (skipping duplicates by
   *  name). */
  const addFromHost = (entries: MCPServerEntry[]) => {
    const existing = new Set(value.map((e) => e.name));
    const additions = entries.filter((e) => !existing.has(e.name));
    if (additions.length > 0) {
      onChange([...value, ...additions]);
    }
    setPickerOpen(false);
  };

  const startEdit = (idx: number) => {
    setEditing({ index: idx, draft: { ...value[idx] } });
  };

  const cancelEdit = () => setEditing(null);

  const saveEdit = (next: MCPServerEntry) => {
    if (!next.name.trim()) return;
    // stdio entries need a command; http/sse entries need a url. The
    // form modal only edits stdio today (Phase 7 deferred the
    // transport switcher) — the picker is the path for http/sse.
    if ((next.transport ?? 'stdio') === 'stdio' && !(next.command ?? '').trim()) {
      return;
    }
    if (editing!.index < 0) {
      onChange([...value, next]);
    } else {
      const copy = [...value];
      copy[editing!.index] = next;
      onChange(copy);
    }
    setEditing(null);
  };

  const removeAt = (idx: number) => {
    if (!confirm(t('envManagement.mcpEditor.confirmRemove'))) return;
    onChange(value.filter((_, i) => i !== idx));
  };

  const toggleDisabled = (idx: number) => {
    const copy = [...value];
    copy[idx] = { ...copy[idx], disabled: !copy[idx].disabled };
    onChange(copy);
  };

  return (
    <div className="flex flex-col gap-3">
      {value.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-6 text-[hsl(var(--muted-foreground))]">
          <Server className="w-6 h-6 opacity-50" />
          <span className="text-[0.8125rem] italic">
            {t('envManagement.mcpEditor.empty')}
          </span>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {value.map((entry, idx) => (
            <li
              key={`${entry.name}-${idx}`}
              className="flex items-start gap-3 p-3 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))]"
            >
              <Server
                className={`w-4 h-4 mt-1 shrink-0 ${
                  entry.disabled
                    ? 'text-[hsl(var(--muted-foreground))]'
                    : 'text-[hsl(var(--primary))]'
                }`}
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[0.8125rem] font-semibold text-[hsl(var(--foreground))] truncate">
                    {entry.name || '(unnamed)'}
                  </span>
                  <TransportBadge transport={entry.transport ?? 'stdio'} />
                  {entry.disabled && (
                    <span className="text-[0.625rem] uppercase tracking-wider px-1.5 py-0.5 rounded font-medium bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]">
                      {t('envManagement.mcpEditor.disabledBadge')}
                    </span>
                  )}
                </div>
                <code className="text-[0.6875rem] font-mono text-[hsl(var(--muted-foreground))] break-all">
                  {(entry.transport ?? 'stdio') === 'stdio'
                    ? `${entry.command ?? ''}${
                        entry.args && entry.args.length > 0
                          ? ' ' + entry.args.join(' ')
                          : ''
                      }`
                    : entry.url ?? '(no url)'}
                </code>
                <div className="flex items-center gap-3 mt-1 text-[0.6875rem] text-[hsl(var(--muted-foreground))]">
                  <span>
                    env:{' '}
                    <span className="tabular-nums">
                      {Object.keys(entry.env ?? {}).length}
                    </span>
                  </span>
                  {(entry.transport ?? 'stdio') !== 'stdio' && (
                    <span>
                      headers:{' '}
                      <span className="tabular-nums">
                        {Object.keys(entry.headers ?? {}).length}
                      </span>
                    </span>
                  )}
                  <span>
                    autoApprove:{' '}
                    <span className="tabular-nums">
                      {(entry.autoApprove ?? []).length}
                    </span>
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-0.5 shrink-0">
                <button
                  type="button"
                  onClick={() => toggleDisabled(idx)}
                  title={
                    entry.disabled
                      ? t('envManagement.mcpEditor.enableTip')
                      : t('envManagement.mcpEditor.disableTip')
                  }
                  className="w-7 h-7 inline-flex items-center justify-center rounded text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))] transition-colors"
                >
                  <Power className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => startEdit(idx)}
                  title={t('envManagement.mcpEditor.editTip')}
                  className="w-7 h-7 inline-flex items-center justify-center rounded text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--primary))] hover:bg-[hsl(var(--accent))] transition-colors"
                >
                  <Pencil className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => removeAt(idx)}
                  title={t('envManagement.mcpEditor.removeTip')}
                  className="w-7 h-7 inline-flex items-center justify-center rounded text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--destructive))] hover:bg-[hsl(var(--destructive)/0.1)] transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          className="inline-flex items-center justify-center gap-1.5 h-9 px-3 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] text-[0.8125rem] font-medium text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--primary))] hover:bg-[hsl(var(--accent))] transition-colors"
          title="호스트 등록소의 MCP 서버에서 골라 스냅샷 추가"
        >
          <Database className="w-4 h-4" />
          호스트에서 추가
        </button>
        <button
          type="button"
          onClick={startAdd}
          className="inline-flex items-center justify-center gap-1.5 h-9 px-3 rounded-md border border-dashed border-[hsl(var(--border))] bg-[hsl(var(--background))] text-[0.8125rem] font-medium text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--primary))] hover:border-[hsl(var(--primary)/0.4)] hover:bg-[hsl(var(--accent))] transition-colors"
        >
          <Plus className="w-4 h-4" />
          {t('envManagement.mcpEditor.addServer')}
        </button>
      </div>

      {editing && (
        <ServerEditModal
          isNew={editing.index < 0}
          initial={editing.draft}
          onCancel={cancelEdit}
          onSave={saveEdit}
        />
      )}

      {pickerOpen && (
        <HostMcpPicker
          alreadyPicked={new Set(value.map((e) => e.name))}
          onCancel={() => setPickerOpen(false)}
          onAdd={addFromHost}
        />
      )}
    </div>
  );
}

// ── Transport badge ─────────────────────────────────────────────

function TransportBadge({ transport }: { transport: MCPTransport }) {
  const palette: Record<MCPTransport, { Icon: typeof Terminal; tone: string }> = {
    stdio: {
      Icon: Terminal,
      tone: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30',
    },
    http: {
      Icon: Globe,
      tone: 'bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/30',
    },
    sse: {
      Icon: Globe,
      tone: 'bg-violet-500/15 text-violet-700 dark:text-violet-300 border-violet-500/30',
    },
  };
  const { Icon, tone } = palette[transport];
  return (
    <span
      className={`inline-flex items-center gap-1 text-[0.625rem] uppercase tracking-wider px-1.5 py-0.5 rounded font-semibold border ${tone}`}
    >
      <Icon className="w-2.5 h-2.5" />
      {transport}
    </span>
  );
}

// ── Host MCP picker dialog ───────────────────────────────────────

/**
 * Modal that lists every custom MCP server registered host-wide.
 * Operator picks one or more, we snapshot the config into the env
 * via `customMcpToEnvEntry`. ★-marked servers float to the top so
 * the operator's curated set is one click away even when the host
 * registry is large.
 *
 * Only fetches host data while open — the env panel doesn't need
 * the catalog until the operator asks. Server-side errors render
 * inline so the dialog stays open and the operator can retry.
 */
function HostMcpPicker({
  alreadyPicked,
  onCancel,
  onAdd,
}: {
  alreadyPicked: Set<string>;
  onCancel: () => void;
  onAdd: (entries: MCPServerEntry[]) => void;
}) {
  const [servers, setServers] = useState<CustomMcpServerSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Pull the env-defaults cache so ★ rows can be highlighted +
  // floated up. The store is shared across the page so this
  // costs no extra fetch — the registry tabs already loaded it.
  const envDefaultsState = useEnvDefaults();
  const starredSet = new Set(envDefaultsState.data.mcp_servers ?? []);
  useEffect(() => {
    envDefaultsState.loadOnce();
  }, [envDefaultsState]);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await customMcpApi.list();
      setServers(res.servers ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  // ★-first then alphabetical. Already-in-env entries sink to the
  // bottom + render disabled (so the operator sees the registry's
  // full state, not a confusingly-empty list).
  const sorted = [...servers].sort((a, b) => {
    const aPicked = alreadyPicked.has(a.name) ? 1 : 0;
    const bPicked = alreadyPicked.has(b.name) ? 1 : 0;
    if (aPicked !== bPicked) return aPicked - bPicked;
    const aStar = starredSet.has(a.name) ? 0 : 1;
    const bStar = starredSet.has(b.name) ? 0 : 1;
    if (aStar !== bStar) return aStar - bStar;
    return a.name.localeCompare(b.name);
  });

  const toggle = (name: string) => {
    if (alreadyPicked.has(name)) return;
    const next = new Set(selected);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setSelected(next);
  };

  const submit = async () => {
    if (selected.size === 0) return;
    setLoading(true);
    setError(null);
    try {
      const entries = await Promise.all(
        Array.from(selected).map(async (name) => {
          const detail = await customMcpApi.get(name);
          return customMcpToEnvEntry(name, detail.config ?? {});
        }),
      );
      onAdd(entries);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[1px] p-4"
      onClick={onCancel}
    >
      <div
        className="relative w-full max-w-2xl max-h-[90vh] flex flex-col rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between gap-3 px-4 py-3 border-b border-[hsl(var(--border))] shrink-0">
          <div>
            <h3 className="text-[0.9375rem] font-semibold text-[hsl(var(--foreground))]">
              호스트 MCP 서버에서 추가
            </h3>
            <p className="text-[0.7rem] text-[hsl(var(--muted-foreground))] mt-0.5">
              선택한 서버의 설정을 이 환경에 스냅샷으로 추가합니다. 추가 후
              env에서 자유롭게 편집/disable 가능 — 호스트 변경은 영향 없음.
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="w-7 h-7 inline-flex items-center justify-center rounded text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))]"
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        <div className="flex items-center justify-between gap-2 px-4 py-2 border-b border-[hsl(var(--border))] shrink-0">
          <span className="text-[0.7rem] text-[hsl(var(--muted-foreground))]">
            {servers.length}개 등록 ·{' '}
            <span className="text-violet-600 dark:text-violet-400">
              ★ {(envDefaultsState.data.mcp_servers ?? []).length}
            </span>{' '}
            · 선택 {selected.size}
          </span>
          <button
            type="button"
            onClick={load}
            disabled={loading}
            className="inline-flex items-center gap-1 h-7 px-2 rounded text-[0.7rem] text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))] disabled:opacity-50"
          >
            <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
            새로고침
          </button>
        </div>

        {error && (
          <div className="px-4 py-2 bg-red-500/10 border-b border-red-500/30 text-[0.7rem] text-red-700 dark:text-red-300 shrink-0">
            <AlertTriangle className="w-3 h-3 inline mr-1" />
            {error}
          </div>
        )}

        <div className="flex-1 min-h-0 overflow-y-auto">
          {sorted.length === 0 && !loading && (
            <div className="p-6 text-center text-[0.8125rem] text-[hsl(var(--muted-foreground))] italic">
              호스트에 등록된 MCP 서버가 없습니다. /environments?tab=mcp에서
              먼저 등록하세요.
            </div>
          )}
          {sorted.map((s) => {
            const picked = alreadyPicked.has(s.name);
            const checked = selected.has(s.name);
            const starred = starredSet.has(s.name);
            return (
              <button
                key={s.name}
                type="button"
                onClick={() => toggle(s.name)}
                disabled={picked}
                className={`w-full flex items-start gap-3 px-4 py-2 text-left border-b border-[hsl(var(--border))] last:border-b-0 ${
                  picked
                    ? 'cursor-not-allowed opacity-50'
                    : checked
                      ? 'bg-violet-500/10 hover:bg-violet-500/15'
                      : 'hover:bg-[hsl(var(--accent))]/40'
                }`}
              >
                <span
                  className={`mt-0.5 inline-flex w-4 h-4 items-center justify-center rounded border shrink-0 ${
                    picked
                      ? 'bg-[hsl(var(--muted))] border-[hsl(var(--border))] text-[hsl(var(--muted-foreground))]'
                      : checked
                        ? 'bg-violet-500 border-violet-500 text-white'
                        : 'border-[hsl(var(--border))] bg-[hsl(var(--background))] text-transparent'
                  }`}
                >
                  <Check className="w-3 h-3" />
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-[0.8125rem] font-semibold truncate text-[hsl(var(--foreground))]">
                      {s.name}
                    </span>
                    {starred && (
                      <Star
                        className="w-3 h-3 text-violet-500 shrink-0"
                        fill="currentColor"
                      />
                    )}
                    {s.type && (
                      <span className="text-[0.5625rem] uppercase text-[hsl(var(--muted-foreground))]">
                        {s.type}
                      </span>
                    )}
                    {picked && (
                      <span className="text-[0.5625rem] uppercase text-[hsl(var(--muted-foreground))]">
                        — 이미 추가됨
                      </span>
                    )}
                  </div>
                  {s.description && (
                    <div className="text-[0.7rem] text-[hsl(var(--muted-foreground))] line-clamp-1 mt-0.5">
                      {s.description}
                    </div>
                  )}
                </div>
              </button>
            );
          })}
        </div>

        <footer className="flex items-center justify-end gap-2 px-4 py-3 border-t border-[hsl(var(--border))] shrink-0">
          <button
            type="button"
            onClick={onCancel}
            className="h-8 px-3 rounded-md border border-[hsl(var(--border))] text-[0.8125rem] font-medium text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))]"
          >
            취소
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={selected.size === 0 || loading}
            className="h-8 px-3 rounded-md bg-violet-500 text-white text-[0.8125rem] font-medium hover:bg-violet-600 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? '추가하는 중…' : `${selected.size}개 추가`}
          </button>
        </footer>
      </div>
    </div>
  );
}

function ServerEditModal({
  isNew,
  initial,
  onCancel,
  onSave,
}: {
  isNew: boolean;
  initial: MCPServerEntry;
  onCancel: () => void;
  onSave: (next: MCPServerEntry) => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(initial.name);
  const [command, setCommand] = useState(initial.command ?? '');
  const [argsText, setArgsText] = useState(
    (initial.args ?? []).join('\n'),
  );
  const [envText, setEnvText] = useState(
    Object.entries(initial.env ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join('\n'),
  );
  const [autoApproveText, setAutoApproveText] = useState(
    (initial.autoApprove ?? []).join('\n'),
  );
  const [disabled, setDisabled] = useState(!!initial.disabled);
  const [error, setError] = useState<string | null>(null);

  const handleSave = () => {
    const trimmedName = name.trim();
    const trimmedCommand = command.trim();
    if (!trimmedName) {
      setError(t('envManagement.mcpEditor.errorNoName'));
      return;
    }
    if (!trimmedCommand) {
      setError(t('envManagement.mcpEditor.errorNoCommand'));
      return;
    }
    const args = argsText
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const env: Record<string, string> = {};
    for (const line of envText.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) {
        setError(t('envManagement.mcpEditor.errorBadEnv', { line: trimmed }));
        return;
      }
      env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1);
    }
    const autoApprove = autoApproveText
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const out: MCPServerEntry = {
      name: trimmedName,
      command: trimmedCommand,
    };
    if (args.length > 0) out.args = args;
    if (Object.keys(env).length > 0) out.env = env;
    if (autoApprove.length > 0) out.autoApprove = autoApprove;
    if (disabled) out.disabled = true;
    onSave(out);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[1px] p-4"
      onClick={onCancel}
    >
      <div
        className="relative w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between gap-3 px-4 py-3 border-b border-[hsl(var(--border))] sticky top-0 bg-[hsl(var(--card))] z-10">
          <h3 className="text-[0.9375rem] font-semibold text-[hsl(var(--foreground))]">
            {isNew
              ? t('envManagement.mcpEditor.addTitle')
              : t('envManagement.mcpEditor.editTitle')}
          </h3>
          <button
            type="button"
            onClick={onCancel}
            className="w-7 h-7 inline-flex items-center justify-center rounded-md text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))] transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        <div className="p-4 flex flex-col gap-4">
          {error && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-[rgba(239,68,68,0.1)] border border-[rgba(239,68,68,0.3)] text-[0.75rem] text-[var(--danger-color)]">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              {error}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="mcp-name">
                {t('envManagement.mcpEditor.name')}
              </Label>
              <Input
                id="mcp-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="filesystem"
                className="font-mono text-[0.8125rem]"
              />
              <p className="text-[0.6875rem] text-[hsl(var(--muted-foreground))]">
                {t('envManagement.mcpEditor.nameHint')}
              </p>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="mcp-command">
                {t('envManagement.mcpEditor.command')}
              </Label>
              <Input
                id="mcp-command"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="npx"
                className="font-mono text-[0.8125rem]"
              />
              <p className="text-[0.6875rem] text-[hsl(var(--muted-foreground))]">
                {t('envManagement.mcpEditor.commandHint')}
              </p>
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="mcp-args">
              {t('envManagement.mcpEditor.args')}{' '}
              <span className="opacity-60">
                ({t('envManagement.mcpEditor.onePerLine')})
              </span>
            </Label>
            <Textarea
              id="mcp-args"
              value={argsText}
              onChange={(e) => setArgsText(e.target.value)}
              rows={3}
              className="font-mono text-[0.75rem]"
              placeholder="-y\n@modelcontextprotocol/server-filesystem\n/path/to/root"
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="mcp-env">
              {t('envManagement.mcpEditor.env')}{' '}
              <span className="opacity-60">
                (KEY=VALUE, {t('envManagement.mcpEditor.onePerLine').toLowerCase()})
              </span>
            </Label>
            <Textarea
              id="mcp-env"
              value={envText}
              onChange={(e) => setEnvText(e.target.value)}
              rows={3}
              className="font-mono text-[0.75rem]"
              placeholder="GITHUB_TOKEN=ghp_xxx\nDEBUG=1"
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="mcp-auto">
              {t('envManagement.mcpEditor.autoApprove')}{' '}
              <span className="opacity-60">
                ({t('envManagement.mcpEditor.onePerLine')})
              </span>
            </Label>
            <Textarea
              id="mcp-auto"
              value={autoApproveText}
              onChange={(e) => setAutoApproveText(e.target.value)}
              rows={2}
              className="font-mono text-[0.75rem]"
              placeholder="read_file\nlist_directory"
            />
            <p className="text-[0.6875rem] text-[hsl(var(--muted-foreground))]">
              {t('envManagement.mcpEditor.autoApproveHint')}
            </p>
          </div>

          <div className="flex items-center justify-between gap-3 px-3 py-2 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))]">
            <div className="flex flex-col gap-0.5">
              <span className="text-[0.8125rem] font-medium text-[hsl(var(--foreground))]">
                {t('envManagement.mcpEditor.disabledLabel')}
              </span>
              <span className="text-[0.6875rem] text-[hsl(var(--muted-foreground))]">
                {t('envManagement.mcpEditor.disabledHint')}
              </span>
            </div>
            <Switch checked={disabled} onCheckedChange={setDisabled} />
          </div>
        </div>

        <footer className="flex items-center justify-end gap-2 px-4 py-3 border-t border-[hsl(var(--border))] sticky bottom-0 bg-[hsl(var(--card))] z-10">
          <button
            type="button"
            onClick={onCancel}
            className="h-9 px-3.5 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] text-[0.8125rem] font-medium text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))] transition-colors"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={handleSave}
            className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-md bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] text-[0.8125rem] font-medium hover:opacity-90 transition-opacity"
          >
            <Check className="w-3.5 h-3.5" />
            {isNew
              ? t('envManagement.mcpEditor.add')
              : t('envManagement.mcpEditor.save')}
          </button>
        </footer>
      </div>
    </div>
  );
}
