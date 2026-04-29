'use client';

/**
 * McpServersTab — host-shared registry for custom MCP servers.
 *
 * Reads from /api/mcp/custom. Cycle 20260429 Phase 8 refactored
 * the layout from a two-pane (sidebar list + JSON detail) into
 * the shared registry primitives — one card per server, edit
 * happens in a modal that doubles as the JSON inspector. Net
 * result: the four host-registry tabs all read the same way at
 * a glance instead of MCP being the odd shaped one.
 *
 * Form supports two modes:
 *   - Structured: per-transport fields (stdio command/args, http/
 *     sse url/headers, plus shared env)
 *   - Raw JSON: fallback for any field structured mode doesn't yet
 *     model
 *
 * Per-session OAuth flow lives inside MCPAdminPanel.
 */

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { customMcpApi, CustomMcpServerSummary } from '@/lib/api';
import {
  Globe,
  Network,
  Pencil,
  Save,
  Server,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import { EditorModal, ActionButton } from '@/components/layout';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { useI18n } from '@/lib/i18n';
import EnvDefaultStarToggle from '@/components/env_management/EnvDefaultStarToggle';
import { useEnvDefaults } from '@/components/env_management/useEnvDefaults';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  RegistryPageShell,
  RegistryGrid,
  RegistryCard,
  RegistryEmptyState,
  RegistryActionButton,
} from '@/components/env_management/registry';

const NAME_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/;

const TRANSPORTS = ['stdio', 'http', 'sse'] as const;
type Transport = (typeof TRANSPORTS)[number];

interface KvRow {
  key: string;
  value: string;
}

interface FormState {
  name: string;
  description: string;
  mode: 'structured' | 'json';
  // Structured fields. ``configJson`` is the raw fallback / JSON-mode source.
  transport: Transport;
  command: string;        // stdio
  argsText: string;       // stdio (one per line)
  envRows: KvRow[];       // all transports
  url: string;            // http / sse
  headerRows: KvRow[];    // http / sse
  configJson: string;     // JSON-mode authoritative; structured-mode synced on switch
}

const EMPTY_FORM: FormState = {
  name: '',
  description: '',
  mode: 'structured',
  transport: 'stdio',
  command: 'uvx',
  argsText: 'mcp-server-fetch',
  envRows: [],
  url: '',
  headerRows: [],
  configJson: '{\n  "command": "uvx",\n  "args": ["mcp-server-fetch"]\n}',
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

function dictToRows(d: unknown): KvRow[] {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return [];
  return Object.entries(d as Record<string, unknown>).map(([k, v]) => ({
    key: k,
    value: String(v ?? ''),
  }));
}

/** Serialise structured fields → executor-shape JSON. */
function structuredToJson(f: FormState): Record<string, unknown> {
  const out: Record<string, unknown> = { transport: f.transport };
  if (f.transport === 'stdio') {
    out.command = f.command.trim();
    const args = f.argsText
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (args.length) out.args = args;
  } else {
    if (f.url.trim()) out.url = f.url.trim();
    const headers = rowsToDict(f.headerRows);
    if (Object.keys(headers).length) out.headers = headers;
  }
  const env = rowsToDict(f.envRows);
  if (Object.keys(env).length) out.env = env;
  if (f.description.trim()) out.description = f.description.trim();
  return out;
}

/** Parse executor-shape JSON → structured fields (best-effort). */
function jsonToStructured(raw: Record<string, unknown>): Partial<FormState> {
  const transportRaw = typeof raw.transport === 'string' ? raw.transport : 'stdio';
  // Cast through ``readonly string[]`` so .includes() accepts the
  // string-typed ``transportRaw`` — TS strict mode rejects an
  // ``as Transport`` argument when the source isn't already narrowed
  // to a tuple element.
  const transport: Transport = (TRANSPORTS as readonly string[]).includes(transportRaw)
    ? (transportRaw as Transport)
    : 'stdio';
  const out: Partial<FormState> = {
    transport,
    command: typeof raw.command === 'string' ? raw.command : '',
    argsText: Array.isArray(raw.args) ? (raw.args as string[]).join('\n') : '',
    envRows: dictToRows(raw.env),
    url: typeof raw.url === 'string' ? raw.url : '',
    headerRows: dictToRows(raw.headers),
  };
  return out;
}

function KvEditor({
  rows,
  onChange,
  keyPlaceholder = 'key',
  valuePlaceholder = 'value',
}: {
  rows: KvRow[];
  onChange: (rows: KvRow[]) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
}) {
  return (
    <div className="grid gap-1.5">
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

export function McpServersTab() {
  const { t } = useI18n();
  const [servers, setServers] = useState<CustomMcpServerSummary[]>([]);
  const [customDir, setCustomDir] = useState<string>('');

  const loadEnvDefaultsOnce = useEnvDefaults((s) => s.loadOnce);
  useEffect(() => {
    loadEnvDefaultsOnce();
  }, [loadEnvDefaultsOnce]);
  const [editorOpen, setEditorOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [editingExisting, setEditingExisting] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await customMcpApi.list();
      setServers(r.servers);
      setCustomDir(r.custom_dir);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const openCreate = () => {
    setEditingExisting(false);
    setForm(EMPTY_FORM);
    setEditorOpen(true);
  };

  const openEdit = async (name: string) => {
    setEditingExisting(true);
    setError(null);
    try {
      const d = await customMcpApi.get(name);
      const cfg = d.config as Record<string, unknown>;
      const structured = jsonToStructured(cfg);
      setForm({
        ...EMPTY_FORM,
        name: d.name,
        description: typeof cfg.description === 'string' ? cfg.description : '',
        configJson: JSON.stringify(cfg, null, 2),
        ...structured,
      });
      setEditorOpen(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  /** When the user toggles between structured and json modes, sync
   *  whichever one was just edited into the other so neither view
   *  goes stale. */
  const switchMode = (next: 'structured' | 'json') => {
    if (next === form.mode) return;
    if (next === 'json') {
      // Structured → JSON: serialise.
      const cfg = structuredToJson(form);
      setForm({ ...form, mode: 'json', configJson: JSON.stringify(cfg, null, 2) });
    } else {
      // JSON → Structured: parse (best-effort; unknown keys lost).
      try {
        const parsed = JSON.parse(form.configJson || '{}');
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error('config must be a JSON object');
        }
        const structured = jsonToStructured(parsed as Record<string, unknown>);
        setForm({ ...form, ...structured, mode: 'structured' });
      } catch (e) {
        setError(
          'Cannot switch to structured mode — JSON invalid (' +
            (e instanceof Error ? e.message : 'parse error') +
            '). Fix it first or stay in JSON mode.',
        );
      }
    }
  };

  const submitForm = async () => {
    if (!NAME_RE.test(form.name)) {
      setError('name must be lower-case alnum / dash / underscore (2-64 chars)');
      return;
    }
    let parsed: Record<string, unknown>;
    if (form.mode === 'structured') {
      parsed = structuredToJson(form);
    } else {
      try {
        const v = JSON.parse(form.configJson);
        if (typeof v !== 'object' || v === null || Array.isArray(v)) {
          throw new Error('config must be a JSON object');
        }
        parsed = v as Record<string, unknown>;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return;
      }
    }
    setSaving(true);
    setError(null);
    try {
      if (editingExisting) {
        await customMcpApi.replace(form.name, parsed, form.description || undefined);
      } else {
        await customMcpApi.create(form.name, parsed, form.description || undefined);
      }
      toast.success(editingExisting ? `Updated ${form.name}` : `Created ${form.name}`);
      setEditorOpen(false);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const onDelete = async (name: string) => {
    if (!window.confirm(`Delete custom MCP server "${name}"?`)) return;
    try {
      await customMcpApi.remove(name);
      toast.success(`Deleted ${name}`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const isEmpty = !loading && servers.length === 0;
  const addLabel = t('envManagement.registry.mcp.addLabel');

  return (
    <>
      <RegistryPageShell
        icon={Network}
        title={t('envManagement.registry.mcp.title')}
        subtitle={
          customDir ? (
            <>
              {t('envManagement.registry.mcp.subtitle')} ·{' '}
              <span className="font-mono">{customDir}</span>
            </>
          ) : (
            t('envManagement.registry.mcp.subtitle')
          )
        }
        countLabel={t('envManagement.registry.mcp.countLabel', {
          n: String(servers.length),
        })}
        bannerNote={t('envManagement.registry.mcp.bannerNote')}
        addLabel={addLabel}
        onAdd={openCreate}
        onRefresh={refresh}
        loading={loading}
        error={error}
        onDismissError={() => setError(null)}
      >
        {isEmpty ? (
          <RegistryEmptyState
            icon={Network}
            title={t('envManagement.registry.mcp.emptyTitle')}
            hint={t('envManagement.registry.emptyHint', { addLabel })}
            addLabel={addLabel}
            onAdd={openCreate}
          />
        ) : (
          <RegistryGrid>
            {servers.map((s) => (
              <McpServerCard
                key={s.name}
                summary={s}
                onEdit={() => openEdit(s.name)}
                onDelete={() => onDelete(s.name)}
              />
            ))}
          </RegistryGrid>
        )}
      </RegistryPageShell>

      <EditorModal
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        title={editingExisting ? `Edit ${form.name}` : 'New custom MCP server'}
        saving={saving}
        width="xl"
        footer={
          <>
            <ActionButton onClick={() => setEditorOpen(false)} disabled={saving}>
              Cancel
            </ActionButton>
            <ActionButton variant="primary" icon={Save} onClick={submitForm} disabled={saving}>
              {saving ? 'Saving…' : editingExisting ? 'Save' : 'Create'}
            </ActionButton>
          </>
        }
      >
        <div className="grid gap-3">
          <div className="grid grid-cols-3 gap-3">
            <div className="grid gap-1.5 col-span-2">
              <Label htmlFor="mcp-name">Name *</Label>
              <Input
                id="mcp-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                disabled={editingExisting}
                placeholder="e.g. github"
                className="font-mono"
              />
            </div>
            <div className="grid gap-1.5">
              <Label>Editor mode</Label>
              <div className="inline-flex rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] p-0.5">
                {(['structured', 'json'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => switchMode(m)}
                    className={`flex-1 px-2 py-1 rounded text-[0.6875rem] font-medium cursor-pointer transition-colors ${
                      form.mode === m
                        ? 'bg-[var(--primary-color)] text-white'
                        : 'bg-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                    }`}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="mcp-desc">Description <span className="opacity-60">(optional)</span></Label>
            <Input
              id="mcp-desc"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </div>

          {form.mode === 'structured' ? (
            <>
              <div className="grid gap-1.5">
                <Label>Transport</Label>
                <Select
                  value={form.transport}
                  onValueChange={(v) => setForm({ ...form, transport: v as Transport })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TRANSPORTS.map((tr) => (
                      <SelectItem key={tr} value={tr}>{tr}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {form.transport === 'stdio' ? (
                <>
                  <div className="grid gap-1.5">
                    <Label htmlFor="mcp-command">Command <span className="opacity-60">(executable path)</span></Label>
                    <Input
                      id="mcp-command"
                      value={form.command}
                      onChange={(e) => setForm({ ...form, command: e.target.value })}
                      placeholder="uvx"
                      className="font-mono"
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="mcp-args">Args <span className="opacity-60">(one per line)</span></Label>
                    <Textarea
                      id="mcp-args"
                      value={form.argsText}
                      onChange={(e) => setForm({ ...form, argsText: e.target.value })}
                      rows={4}
                      placeholder={'mcp-server-fetch'}
                      className="font-mono text-[0.75rem]"
                    />
                  </div>
                </>
              ) : (
                <>
                  <div className="grid gap-1.5">
                    <Label htmlFor="mcp-url">URL</Label>
                    <Input
                      id="mcp-url"
                      value={form.url}
                      onChange={(e) => setForm({ ...form, url: e.target.value })}
                      placeholder="https://mcp.example.com/sse"
                      className="font-mono text-[0.75rem]"
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label>Headers</Label>
                    <KvEditor
                      rows={form.headerRows}
                      onChange={(rows) => setForm({ ...form, headerRows: rows })}
                      keyPlaceholder="Authorization"
                      valuePlaceholder="Bearer …"
                    />
                  </div>
                </>
              )}

              <div className="grid gap-1.5">
                <Label>Env <span className="opacity-60">(extra environment variables)</span></Label>
                <KvEditor
                  rows={form.envRows}
                  onChange={(rows) => setForm({ ...form, envRows: rows })}
                  keyPlaceholder="GITHUB_TOKEN"
                  valuePlaceholder="ghp_…"
                />
              </div>
            </>
          ) : (
            <div className="grid gap-1.5">
              <Label htmlFor="mcp-cfg">Config <span className="opacity-60">(JSON object)</span></Label>
              <Textarea
                id="mcp-cfg"
                value={form.configJson}
                onChange={(e) => setForm({ ...form, configJson: e.target.value })}
                rows={14}
                spellCheck={false}
                className="font-mono text-xs"
              />
            </div>
          )}
        </div>
      </EditorModal>
    </>
  );
}

export default McpServersTab;

// ── Card ────────────────────────────────────────────────────────

function McpServerCard({
  summary,
  onEdit,
  onDelete,
}: {
  summary: CustomMcpServerSummary;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  // Read transport from the summary's `type` field if present
  // (controller surfaces it as a hint for the list view). Default
  // to stdio for back-compat with summaries that don't carry it.
  const transport = (summary.type ?? 'stdio') as
    | 'stdio'
    | 'http'
    | 'sse'
    | string;
  const isStdio = transport === 'stdio';
  const TransportIcon = isStdio ? Terminal : Globe;
  const transportTone = isStdio
    ? 'good'
    : transport === 'sse'
      ? 'info'
      : 'info';

  return (
    <RegistryCard
      icon={Server}
      title={summary.name}
      titleMono
      description={summary.description ?? '—'}
      badges={[
        { label: transport, tone: transportTone, icon: TransportIcon },
      ]}
      star={
        <EnvDefaultStarToggle category="mcp_servers" itemId={summary.name} />
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
