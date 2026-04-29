'use client';

/**
 * McpServerFormModal — beginner-friendly form for creating + editing
 * a custom MCP server. Replaces the original modal (cycle 20260426_2)
 * which jammed every field into one undifferentiated grid.
 *
 * Goals (operator brief, Phase 9.1):
 *
 *   1. Localised — Korean labels render correctly when locale=ko.
 *   2. Beginner-friendly — section breaks, per-field help text,
 *      visual transport selector with descriptions, smart defaults.
 *   3. Structured ↔ JSON harmony — the structured form is primary;
 *      a "JSON 미리보기" panel lives below it and updates as the
 *      operator types, so power users can verify the wire shape
 *      without leaving the form.
 *   4. JSON mode still available — the top toggle flips the editor
 *      to a single textarea for ad-hoc fields the structured form
 *      doesn't model.
 *
 * Layout:
 *
 *   ┌─ Header ────────────────────────────────────────────────┐
 *   │ {createTitle | editTitle}        [Structured | JSON]  ✕ │
 *   ├─ Body (sections) ───────────────────────────────────────┤
 *   │ ▶ 식별 정보       (name, description)                  │
 *   │ ▶ 연결 방식       (radio cards: stdio / HTTP / SSE)    │
 *   │ ▶ 실행 설정       (command/args OR url, transport-aware)│
 *   │ ▶ 환경 변수       (KV editor)                          │
 *   │ ▶ HTTP 헤더        (KV editor, http/sse only)           │
 *   │ ▶ JSON 미리보기   (collapsible, read-only)             │
 *   ├─ Footer ────────────────────────────────────────────────┤
 *   │                              [Cancel]    [Create/Save] │
 *   └─────────────────────────────────────────────────────────┘
 *
 * Each section is a borderless block with its own heading + hint.
 * Visual rhythm matches `OverviewView`'s welcome card (rounded
 * tinted icon, generous spacing, muted descriptions).
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Box,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Globe,
  HelpCircle,
  Info,
  Plus,
  Radio,
  RefreshCw,
  Save,
  Server,
  Terminal,
  XCircle,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { customMcpApi, type MCPTestConnectionResponse } from '@/lib/api';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

// ─────────────────────────────────────────────────────────────
// Form state model
// ─────────────────────────────────────────────────────────────

const NAME_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/;

const TRANSPORTS = ['stdio', 'http', 'sse'] as const;
export type Transport = (typeof TRANSPORTS)[number];

interface KvRow {
  key: string;
  value: string;
}

interface FormState {
  name: string;
  description: string;
  mode: 'structured' | 'json';
  transport: Transport;
  command: string;
  argsText: string;
  envRows: KvRow[];
  url: string;
  headerRows: KvRow[];
  /** JSON-mode authoritative source. Synced on mode switch. */
  configJson: string;
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

/** Parse executor-shape JSON → structured fields (best-effort).
 *  Unknown keys land in `configJson` and survive when the operator
 *  flips back to JSON mode. */
function jsonToStructured(raw: Record<string, unknown>): Partial<FormState> {
  const transportRaw = typeof raw.transport === 'string' ? raw.transport : 'stdio';
  const transport: Transport = (TRANSPORTS as readonly string[]).includes(transportRaw)
    ? (transportRaw as Transport)
    : 'stdio';
  return {
    transport,
    command: typeof raw.command === 'string' ? raw.command : '',
    argsText: Array.isArray(raw.args) ? (raw.args as string[]).join('\n') : '',
    envRows: dictToRows(raw.env),
    url: typeof raw.url === 'string' ? raw.url : '',
    headerRows: dictToRows(raw.headers),
  };
}

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────

export interface McpServerFormSubmit {
  name: string;
  config: Record<string, unknown>;
  description: string;
}

export interface McpServerFormModalProps {
  open: boolean;
  /** When true, the form is editing an existing entry — name disabled. */
  editingExisting: boolean;
  /** Initial name (edit only). */
  initialName?: string;
  /** Initial config dict (edit only). */
  initialConfig?: Record<string, unknown>;
  /** Initial description (edit only). */
  initialDescription?: string;
  saving: boolean;
  /** External error to surface above the footer. */
  error?: string | null;
  onClose: () => void;
  onSubmit: (payload: McpServerFormSubmit) => void;
}

export default function McpServerFormModal({
  open,
  editingExisting,
  initialName = '',
  initialConfig,
  initialDescription = '',
  saving,
  error: externalError,
  onClose,
  onSubmit,
}: McpServerFormModalProps) {
  const { t } = useI18n();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [innerError, setInnerError] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(true);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<
    MCPTestConnectionResponse | null
  >(null);

  // Reset form when the modal opens or initial values change.
  useEffect(() => {
    if (!open) return;
    if (editingExisting && initialConfig) {
      const structured = jsonToStructured(initialConfig);
      setForm({
        ...EMPTY_FORM,
        ...structured,
        name: initialName,
        description: initialDescription,
        configJson: JSON.stringify(initialConfig, null, 2),
      });
    } else {
      setForm(EMPTY_FORM);
    }
    setInnerError(null);
    setTestResult(null);
  }, [open, editingExisting, initialName, initialDescription, initialConfig]);

  // Stale the test result whenever the form changes — yesterday's
  // "connected" tells the operator nothing about the config they
  // just edited.
  useEffect(() => {
    setTestResult(null);
  }, [
    form.transport,
    form.command,
    form.argsText,
    form.url,
    form.envRows,
    form.headerRows,
    form.configJson,
    form.mode,
  ]);

  if (!open) return null;

  const error = innerError ?? externalError ?? null;

  // Live JSON of the structured form. In structured mode, this is
  // the preview; in JSON mode, the textarea owns the source of
  // truth and this still shows the parsed result for symmetry.
  const liveJson = useMemo(() => {
    if (form.mode === 'json') {
      try {
        const parsed = JSON.parse(form.configJson || '{}');
        return JSON.stringify(parsed, null, 2);
      } catch {
        return form.configJson;
      }
    }
    return JSON.stringify(structuredToJson(form), null, 2);
  }, [form]);

  const switchMode = (next: 'structured' | 'json') => {
    if (next === form.mode) return;
    if (next === 'json') {
      setForm({
        ...form,
        mode: 'json',
        configJson: JSON.stringify(structuredToJson(form), null, 2),
      });
    } else {
      try {
        const parsed = JSON.parse(form.configJson || '{}');
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error('config must be a JSON object');
        }
        const structured = jsonToStructured(parsed as Record<string, unknown>);
        setForm({ ...form, ...structured, mode: 'structured' });
        setInnerError(null);
      } catch (e) {
        setInnerError(
          t('envManagement.registry.mcp.form.errorBadJson', {
            detail: e instanceof Error ? e.message : 'parse error',
          }),
        );
      }
    }
  };

  /** Build the wire-shape config the test endpoint expects. Mirrors
   *  `submit()` minus the validation gates — we want the server to
   *  echo back its real error if e.g. the command is missing,
   *  rather than refusing to fire because the structured form
   *  isn't fully populated yet. */
  const buildConfigForTest = (): Record<string, unknown> | null => {
    if (form.mode === 'structured') {
      return structuredToJson(form);
    }
    try {
      const parsed = JSON.parse(form.configJson || '{}');
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return null;
      }
      return parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  };

  const handleTest = async () => {
    setInnerError(null);
    const config = buildConfigForTest();
    if (config === null) {
      setInnerError(
        t('envManagement.registry.mcp.form.errorBadJson', {
          detail: 'config is not a valid JSON object',
        }),
      );
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const res = await customMcpApi.test(form.name.trim() || 'preflight', config);
      setTestResult(res);
    } catch (e) {
      setTestResult({
        success: false,
        latency_ms: 0,
        tools_discovered: 0,
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setTesting(false);
    }
  };

  const submit = () => {
    setInnerError(null);
    const trimmedName = form.name.trim();
    if (!trimmedName) {
      setInnerError(t('envManagement.registry.mcp.form.errorNoName'));
      return;
    }
    if (!NAME_RE.test(trimmedName)) {
      setInnerError(t('envManagement.registry.mcp.form.errorBadName'));
      return;
    }
    let config: Record<string, unknown>;
    if (form.mode === 'structured') {
      if (form.transport === 'stdio' && !form.command.trim()) {
        setInnerError(t('envManagement.registry.mcp.form.errorNoCommand'));
        return;
      }
      if (form.transport !== 'stdio' && !form.url.trim()) {
        setInnerError(t('envManagement.registry.mcp.form.errorNoUrl'));
        return;
      }
      config = structuredToJson(form);
    } else {
      try {
        const parsed = JSON.parse(form.configJson);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error('config must be a JSON object');
        }
        config = parsed as Record<string, unknown>;
      } catch (e) {
        setInnerError(
          t('envManagement.registry.mcp.form.errorBadJson', {
            detail: e instanceof Error ? e.message : 'parse error',
          }),
        );
        return;
      }
    }
    onSubmit({
      name: trimmedName,
      config,
      description: form.description.trim(),
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[1px] p-4"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-3xl max-h-[92vh] flex flex-col rounded-2xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Header ── */}
        <header className="flex items-center justify-between gap-3 px-5 py-4 border-b border-[hsl(var(--border))] shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className="inline-flex items-center justify-center w-10 h-10 rounded-xl bg-[hsl(var(--primary)/0.1)] shrink-0">
              <Server className="w-5 h-5 text-[hsl(var(--primary))]" strokeWidth={2} />
            </div>
            <div className="min-w-0">
              <h3 className="text-[1rem] font-semibold text-[hsl(var(--foreground))] truncate">
                {editingExisting
                  ? t('envManagement.registry.mcp.form.editTitle')
                  : t('envManagement.registry.mcp.form.createTitle')}
              </h3>
              <ModeToggle mode={form.mode} onChange={switchMode} t={t} />
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 inline-flex items-center justify-center rounded-md text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))]"
            aria-label="close"
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        {/* ── Body (scrollable) ── */}
        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 flex flex-col gap-5">
          {form.mode === 'structured' ? (
            <>
              <IdentitySection form={form} setForm={setForm} editingExisting={editingExisting} />
              <TransportSection form={form} setForm={setForm} />
              <ConnectionSection form={form} setForm={setForm} />
              <KvSection
                title={t('envManagement.registry.mcp.form.sectionEnv')}
                hint={t('envManagement.registry.mcp.form.envHint')}
                rows={form.envRows}
                onChange={(envRows) => setForm({ ...form, envRows })}
                keyPlaceholder="GITHUB_TOKEN"
                valuePlaceholder="ghp_…"
                icon={Box}
              />
              {form.transport !== 'stdio' && (
                <KvSection
                  title={t('envManagement.registry.mcp.form.sectionHeaders')}
                  hint={t('envManagement.registry.mcp.form.headersHint')}
                  rows={form.headerRows}
                  onChange={(headerRows) => setForm({ ...form, headerRows })}
                  keyPlaceholder="Authorization"
                  valuePlaceholder="Bearer …"
                  icon={Globe}
                />
              )}
              <JsonPreviewSection
                json={liveJson}
                open={previewOpen}
                onToggle={() => setPreviewOpen((v) => !v)}
                t={t}
              />
            </>
          ) : (
            <>
              <IdentitySection form={form} setForm={setForm} editingExisting={editingExisting} />
              <Section
                icon={Box}
                title="JSON config"
                hint={t('envManagement.registry.mcp.form.previewReadonlyHint')}
              >
                <Textarea
                  value={form.configJson}
                  onChange={(e) => setForm({ ...form, configJson: e.target.value })}
                  rows={16}
                  spellCheck={false}
                  className="font-mono text-[0.75rem]"
                />
              </Section>
            </>
          )}

          {error && (
            <div className="flex items-start gap-2 px-3 py-2 rounded-lg border border-red-500/30 bg-red-500/10 text-[0.75rem] text-red-700 dark:text-red-300">
              <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <div className="flex-1">{error}</div>
            </div>
          )}

          {testResult && <TestResultChip result={testResult} t={t} />}
        </div>

        {/* ── Footer ── */}
        <footer className="flex items-center gap-2 px-5 py-4 border-t border-[hsl(var(--border))] shrink-0">
          <button
            type="button"
            onClick={handleTest}
            disabled={testing || saving}
            title={t('envManagement.registry.mcp.form.testHint')}
            className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] text-[0.8125rem] font-medium text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {testing ? (
              <>
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                {t('envManagement.registry.mcp.form.testRunning')}
              </>
            ) : (
              <>
                <Zap className="w-3.5 h-3.5" />
                {t('envManagement.registry.mcp.form.testButton')}
              </>
            )}
          </button>
          <div className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="h-9 px-4 rounded-md border border-[hsl(var(--border))] text-[0.8125rem] font-medium text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))] disabled:opacity-50"
          >
            {t('envManagement.registry.cancel')}
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={saving}
            className="inline-flex items-center gap-1.5 h-9 px-4 rounded-md bg-violet-500 text-white text-[0.8125rem] font-medium hover:bg-violet-600 disabled:opacity-50 shadow-sm"
          >
            {saving ? (
              <>
                <Save className="w-4 h-4 animate-pulse" />
                {t('envManagement.registry.saving')}
              </>
            ) : (
              <>
                <Save className="w-4 h-4" />
                {editingExisting
                  ? t('envManagement.registry.mcp.form.editBtn')
                  : t('envManagement.registry.mcp.form.createBtn')}
              </>
            )}
          </button>
        </footer>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Section primitive
// ─────────────────────────────────────────────────────────────

function Section({
  icon: Icon,
  title,
  hint,
  rightSlot,
  children,
}: {
  icon: LucideIcon;
  title: string;
  hint?: string;
  rightSlot?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section>
      <header className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2">
          <Icon className="w-3.5 h-3.5 text-[hsl(var(--muted-foreground))]" />
          <h4 className="text-[0.6875rem] uppercase tracking-wider font-semibold text-[hsl(var(--muted-foreground))]">
            {title}
          </h4>
        </div>
        {rightSlot}
      </header>
      {hint && (
        <p className="text-[0.7rem] text-[hsl(var(--muted-foreground))] mb-2 leading-relaxed">
          {hint}
        </p>
      )}
      {children}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────
// Mode toggle (Structured / JSON)
// ─────────────────────────────────────────────────────────────

function ModeToggle({
  mode,
  onChange,
  t,
}: {
  mode: 'structured' | 'json';
  onChange: (m: 'structured' | 'json') => void;
  t: (k: string, v?: Record<string, string>) => string;
}) {
  return (
    <div className="inline-flex rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] p-0.5 mt-1">
      {(['structured', 'json'] as const).map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => onChange(m)}
          title={t(`envManagement.registry.mcp.form.mode${m === 'structured' ? 'Structured' : 'Json'}Tip`)}
          className={`px-2.5 py-1 rounded text-[0.6875rem] font-medium transition-colors ${
            mode === m
              ? 'bg-violet-500 text-white shadow-sm'
              : 'bg-transparent text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]'
          }`}
        >
          {t(`envManagement.registry.mcp.form.mode${m === 'structured' ? 'Structured' : 'Json'}`)}
        </button>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Identity section (name + description)
// ─────────────────────────────────────────────────────────────

function IdentitySection({
  form,
  setForm,
  editingExisting,
}: {
  form: FormState;
  setForm: (f: FormState) => void;
  editingExisting: boolean;
}) {
  const { t } = useI18n();
  return (
    <Section icon={HelpCircle} title={t('envManagement.registry.mcp.form.sectionIdentity')}>
      <div className="grid gap-3">
        <div className="grid gap-1.5">
          <Label
            htmlFor="mcp-name"
            label={t('envManagement.registry.mcp.form.nameLabel')}
            required
            hint={t('envManagement.registry.mcp.form.nameHint')}
          />
          <Input
            id="mcp-name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            disabled={editingExisting}
            placeholder={t('envManagement.registry.mcp.form.namePlaceholder')}
            className="font-mono"
          />
        </div>
        <div className="grid gap-1.5">
          <Label
            htmlFor="mcp-desc"
            label={t('envManagement.registry.mcp.form.descriptionLabel')}
            hint={t('envManagement.registry.mcp.form.descriptionHint')}
          />
          <Input
            id="mcp-desc"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            placeholder={t('envManagement.registry.mcp.form.descriptionPlaceholder')}
          />
        </div>
      </div>
    </Section>
  );
}

// ─────────────────────────────────────────────────────────────
// Transport section (radio cards)
// ─────────────────────────────────────────────────────────────

function TransportSection({
  form,
  setForm,
}: {
  form: FormState;
  setForm: (f: FormState) => void;
}) {
  const { t } = useI18n();
  const options: Array<{
    value: Transport;
    Icon: LucideIcon;
    label: string;
    hint: string;
    accent: string;
  }> = [
    {
      value: 'stdio',
      Icon: Terminal,
      label: t('envManagement.registry.mcp.form.transportStdioLabel'),
      hint: t('envManagement.registry.mcp.form.transportStdioHint'),
      accent: 'emerald',
    },
    {
      value: 'http',
      Icon: Globe,
      label: t('envManagement.registry.mcp.form.transportHttpLabel'),
      hint: t('envManagement.registry.mcp.form.transportHttpHint'),
      accent: 'sky',
    },
    {
      value: 'sse',
      Icon: Radio,
      label: t('envManagement.registry.mcp.form.transportSseLabel'),
      hint: t('envManagement.registry.mcp.form.transportSseHint'),
      accent: 'violet',
    },
  ];
  return (
    <Section icon={Globe} title={t('envManagement.registry.mcp.form.sectionTransport')}>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        {options.map(({ value, Icon, label, hint, accent }) => {
          const active = form.transport === value;
          const accentClass = active
            ? accent === 'emerald'
              ? 'border-emerald-500 bg-emerald-500/10'
              : accent === 'sky'
                ? 'border-sky-500 bg-sky-500/10'
                : 'border-violet-500 bg-violet-500/10'
            : 'border-[hsl(var(--border))] bg-[hsl(var(--background))] hover:border-[hsl(var(--primary)/0.4)]';
          const iconClass = active
            ? accent === 'emerald'
              ? 'text-emerald-600 dark:text-emerald-400'
              : accent === 'sky'
                ? 'text-sky-600 dark:text-sky-400'
                : 'text-violet-600 dark:text-violet-400'
            : 'text-[hsl(var(--muted-foreground))]';
          return (
            <button
              key={value}
              type="button"
              onClick={() => setForm({ ...form, transport: value })}
              className={`flex flex-col items-start gap-1.5 p-3 rounded-lg border transition-all text-left ${accentClass}`}
            >
              <div className="flex items-center gap-1.5">
                <Icon className={`w-3.5 h-3.5 ${iconClass}`} />
                <span className="text-[0.8125rem] font-semibold text-[hsl(var(--foreground))]">
                  {label}
                </span>
              </div>
              <p className="text-[0.7rem] text-[hsl(var(--muted-foreground))] leading-snug">
                {hint}
              </p>
            </button>
          );
        })}
      </div>
    </Section>
  );
}

// ─────────────────────────────────────────────────────────────
// Connection section (transport-aware)
// ─────────────────────────────────────────────────────────────

function ConnectionSection({
  form,
  setForm,
}: {
  form: FormState;
  setForm: (f: FormState) => void;
}) {
  const { t } = useI18n();
  return (
    <Section
      icon={Terminal}
      title={t('envManagement.registry.mcp.form.sectionConnection')}
    >
      {form.transport === 'stdio' ? (
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label
              htmlFor="mcp-cmd"
              label={t('envManagement.registry.mcp.form.commandLabel')}
              required
              hint={t('envManagement.registry.mcp.form.commandHint')}
            />
            <Input
              id="mcp-cmd"
              value={form.command}
              onChange={(e) => setForm({ ...form, command: e.target.value })}
              placeholder={t('envManagement.registry.mcp.form.commandPlaceholder')}
              className="font-mono"
            />
          </div>
          <div className="grid gap-1.5">
            <Label
              htmlFor="mcp-args"
              label={t('envManagement.registry.mcp.form.argsLabel')}
              hint={t('envManagement.registry.mcp.form.argsHint')}
            />
            <Textarea
              id="mcp-args"
              value={form.argsText}
              onChange={(e) => setForm({ ...form, argsText: e.target.value })}
              rows={4}
              placeholder={t('envManagement.registry.mcp.form.argsPlaceholder')}
              className="font-mono text-[0.75rem]"
            />
          </div>
        </div>
      ) : (
        <div className="grid gap-1.5">
          <Label
            htmlFor="mcp-url"
            label={t('envManagement.registry.mcp.form.urlLabel')}
            required
            hint={t('envManagement.registry.mcp.form.urlHint')}
          />
          <Input
            id="mcp-url"
            value={form.url}
            onChange={(e) => setForm({ ...form, url: e.target.value })}
            placeholder={t('envManagement.registry.mcp.form.urlPlaceholder')}
            className="font-mono text-[0.75rem]"
          />
        </div>
      )}
    </Section>
  );
}

// ─────────────────────────────────────────────────────────────
// KV editor section (env / headers)
// ─────────────────────────────────────────────────────────────

function KvSection({
  icon,
  title,
  hint,
  rows,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
}: {
  icon: LucideIcon;
  title: string;
  hint: string;
  rows: KvRow[];
  onChange: (rows: KvRow[]) => void;
  keyPlaceholder: string;
  valuePlaceholder: string;
}) {
  const { t } = useI18n();
  return (
    <Section icon={icon} title={title} hint={hint}>
      <div className="flex flex-col gap-2">
        {rows.map((row, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <Input
              value={row.key}
              onChange={(e) => {
                const next = [...rows];
                next[i] = { ...next[i], key: e.target.value };
                onChange(next);
              }}
              placeholder={keyPlaceholder}
              className="font-mono text-[0.75rem] w-[35%]"
            />
            <Input
              value={row.value}
              onChange={(e) => {
                const next = [...rows];
                next[i] = { ...next[i], value: e.target.value };
                onChange(next);
              }}
              placeholder={valuePlaceholder}
              className="font-mono text-[0.75rem] flex-1"
            />
            <button
              type="button"
              onClick={() => onChange(rows.filter((_, j) => j !== i))}
              className="text-[hsl(var(--muted-foreground))] hover:text-red-500 p-1"
              title={t('envManagement.registry.mcp.form.removeRow')}
              aria-label="remove"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => onChange([...rows, { key: '', value: '' }])}
          className="self-start inline-flex items-center gap-1 text-[0.7rem] text-[hsl(var(--primary))] hover:underline"
        >
          <Plus className="w-3 h-3" />
          {t('envManagement.registry.mcp.form.addRow')}
        </button>
      </div>
    </Section>
  );
}

// ─────────────────────────────────────────────────────────────
// JSON preview (collapsible)
// ─────────────────────────────────────────────────────────────

function JsonPreviewSection({
  json,
  open,
  onToggle,
  t,
}: {
  json: string;
  open: boolean;
  onToggle: () => void;
  t: (k: string, v?: Record<string, string>) => string;
}) {
  return (
    <section className="rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))]">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left hover:bg-[hsl(var(--accent))]/40 transition-colors"
      >
        <div className="flex items-center gap-2">
          {open ? (
            <ChevronDown className="w-3.5 h-3.5 text-[hsl(var(--muted-foreground))]" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-[hsl(var(--muted-foreground))]" />
          )}
          <h4 className="text-[0.6875rem] uppercase tracking-wider font-semibold text-[hsl(var(--muted-foreground))]">
            {t('envManagement.registry.mcp.form.sectionPreview')}
          </h4>
        </div>
        <span className="text-[0.6875rem] text-[hsl(var(--muted-foreground))]">
          {open
            ? t('envManagement.registry.mcp.form.previewToggleHide')
            : t('envManagement.registry.mcp.form.previewToggleShow')}
        </span>
      </button>
      {open && (
        <div className="border-t border-[hsl(var(--border))] p-3">
          <p className="text-[0.6875rem] text-[hsl(var(--muted-foreground))] mb-2 leading-relaxed">
            {t('envManagement.registry.mcp.form.previewReadonlyHint')}
          </p>
          <pre className="text-[0.75rem] font-mono bg-[hsl(var(--muted))]/30 rounded p-3 overflow-x-auto leading-relaxed">
            {json}
          </pre>
        </div>
      )}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────
// Test connection result chip
// ─────────────────────────────────────────────────────────────

function TestResultChip({
  result,
  t,
}: {
  result: MCPTestConnectionResponse;
  t: (k: string, v?: Record<string, string>) => string;
}) {
  if (result.success) {
    return (
      <div className="flex items-start gap-2 px-3 py-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 text-[0.75rem] text-emerald-700 dark:text-emerald-300">
        <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
        <div className="flex-1">
          <div className="font-semibold">
            {t('envManagement.registry.mcp.form.testSuccess', {
              n: String(result.tools_discovered),
            })}
          </div>
          <div className="text-[0.6875rem] opacity-80 tabular-nums mt-0.5">
            {result.latency_ms.toFixed(1)}ms
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-2 px-3 py-2 rounded-lg border border-red-500/40 bg-red-500/10 text-[0.75rem] text-red-700 dark:text-red-300">
      <XCircle className="w-4 h-4 mt-0.5 shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="font-semibold">
          {t('envManagement.registry.mcp.form.testFailed', {
            detail: '',
          }).replace(/:\s*$/, '')}
        </div>
        <pre className="text-[0.6875rem] opacity-90 mt-1 whitespace-pre-wrap break-words font-mono">
          {result.error ?? '(no error message)'}
        </pre>
        <div className="text-[0.6875rem] opacity-70 tabular-nums mt-1">
          {result.latency_ms.toFixed(1)}ms
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Label primitive (with required marker + hint)
// ─────────────────────────────────────────────────────────────

function Label({
  htmlFor,
  label,
  required,
  hint,
}: {
  htmlFor: string;
  label: string;
  required?: boolean;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <label
        htmlFor={htmlFor}
        className="text-[0.75rem] font-medium text-[hsl(var(--foreground))]"
      >
        {label}
        {required && <span className="text-red-500 ml-0.5">*</span>}
      </label>
      {hint && (
        <span className="text-[0.6875rem] text-[hsl(var(--muted-foreground))] leading-snug">
          {hint}
        </span>
      )}
    </div>
  );
}
