'use client';

/**
 * HookFormModal — beginner-friendly form for creating + editing a
 * hook entry. Same hero+section pattern as McpServerFormModal +
 * SkillFormModal so the four host-registry forms read as siblings.
 *
 * Operator brief (Phase 9.4): the previous EditorModal exposed the
 * full hook schema (event / command / args / timeout / match / env /
 * working_dir) as one undifferentiated grid with English-only
 * labels. The "Match" field's behaviour ("only the 'tool' key is
 * honored today") was buried in a parenthetical, and the 16 events
 * had no descriptions — the operator had to know what
 * `permission_denied` vs `permission_request` actually meant.
 *
 * Layout:
 *
 *   ┌─ Header (icon-tile + title + close) ─────────────────────┐
 *   ├─ Body (sectioned, scrollable) ───────────────────────────┤
 *   │ ▶ 트리거          (event Select + live description card) │
 *   │ ▶ 실행 명령       (command + args)                       │
 *   │ ▶ 매칭 조건       (match dict, only "tool" today)        │
 *   │ ▶ 실행 환경       (timeout + working_dir + env)          │
 *   └───────────────────────────────────────────────────────────┘
 *
 * The trigger section is the headline — picking the right event is
 * the most common new-user mistake. Every event gets a one-line
 * description that updates as the operator changes the Select, so
 * the difference between e.g. `pre_tool_use` and `post_tool_use` is
 * visible without a docs trip.
 */

import { useEffect, useState } from 'react';
import {
  Box,
  Filter,
  Info,
  Plug,
  Plus,
  Save,
  Settings2,
  Terminal,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { HOOK_EVENTS, type HookEvent, type HookEntryRow } from '@/lib/api';
import RegistryFormShell from '@/components/env_management/registry/RegistryFormShell';

// ─────────────────────────────────────────────────────────────
// Form state model
// ─────────────────────────────────────────────────────────────

interface KvRow {
  key: string;
  value: string;
}

interface FormState {
  event: HookEvent;
  command: string;
  argsText: string;
  timeoutMs: string;
  match: KvRow[];
  env: KvRow[];
  workingDir: string;
}

const EMPTY_FORM: FormState = {
  event: 'pre_tool_use',
  command: '',
  argsText: '',
  timeoutMs: '',
  match: [],
  env: [],
  workingDir: '',
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
  return Object.entries(d).map(([k, v]) => ({ key: k, value: String(v) }));
}

export interface HookFormSubmit {
  event: HookEvent;
  command: string;
  args: string[];
  timeout_ms: number | null;
  match: Record<string, string>;
  env: Record<string, string>;
  working_dir: string | null;
}

function formToPayload(f: FormState): {
  payload: HookFormSubmit | null;
  error: string | null;
} {
  if (!f.event || !f.command.trim()) {
    return { payload: null, error: 'errorRequired' };
  }
  const args = f.argsText
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  let timeout: number | null = null;
  const t = f.timeoutMs.trim();
  if (t) {
    const n = parseInt(t, 10);
    if (Number.isFinite(n) && n > 0) timeout = n;
  }
  return {
    payload: {
      event: f.event,
      command: f.command.trim(),
      args,
      timeout_ms: timeout,
      match: rowsToDict(f.match),
      env: rowsToDict(f.env),
      working_dir: f.workingDir.trim() || null,
    },
    error: null,
  };
}

function rowToForm(row: HookEntryRow): FormState {
  return {
    event: row.event as HookEvent,
    command: row.command ?? '',
    argsText: (row.args ?? []).join('\n'),
    timeoutMs: row.timeout_ms != null ? String(row.timeout_ms) : '',
    match: dictToRows((row.match ?? null) as Record<string, unknown> | null),
    env: dictToRows((row.env ?? null) as Record<string, unknown> | null),
    workingDir: row.working_dir ?? '',
  };
}

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────

export interface HookFormModalProps {
  editingTarget: { event: string; idx: number } | null;
  initialRow?: HookEntryRow | null;
  saving: boolean;
  error?: string | null;
  onClose: () => void;
  onSubmit: (payload: HookFormSubmit) => void;
}

export default function HookFormModal({
  editingTarget,
  initialRow,
  saving,
  error: externalError,
  onClose,
  onSubmit,
}: HookFormModalProps) {
  const { t } = useI18n();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [innerError, setInnerError] = useState<string | null>(null);

  useEffect(() => {
    if (editingTarget && initialRow) {
      setForm(rowToForm(initialRow));
    } else {
      setForm(EMPTY_FORM);
    }
    setInnerError(null);
  }, [editingTarget, initialRow]);

  const error = innerError ?? externalError ?? null;

  const submit = () => {
    setInnerError(null);
    const { payload, error: errKey } = formToPayload(form);
    if (!payload) {
      setInnerError(
        errKey
          ? t(`envManagement.registry.hooks.form.${errKey}`)
          : 'Invalid form',
      );
      return;
    }
    onSubmit(payload);
  };

  const title = editingTarget
    ? t('envManagement.registry.hooks.form.editTitle', {
        event: editingTarget.event,
        idx: String(editingTarget.idx),
      })
    : t('envManagement.registry.hooks.form.createTitle');

  const footer = (
    <>
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
            {editingTarget
              ? t('envManagement.registry.hooks.form.editBtn')
              : t('envManagement.registry.hooks.form.createBtn')}
          </>
        )}
      </button>
    </>
  );

  return (
    <RegistryFormShell
      icon={Plug}
      title={title}
      backLabel={t('envManagement.registry.backToList')}
      onBack={onClose}
      error={error}
      onDismissError={() => setInnerError(null)}
      footer={footer}
    >
      <TriggerSection
        form={form}
        setForm={setForm}
        disableEventSwitch={!!editingTarget}
      />
      <ExecutionSection form={form} setForm={setForm} />
      <KvSection
        icon={Filter}
        title={t('envManagement.registry.hooks.form.sectionMatch')}
        hint={t('envManagement.registry.hooks.form.matchHint')}
        rows={form.match}
        onChange={(match) => setForm({ ...form, match })}
        keyPlaceholder="tool"
        valuePlaceholder="Bash"
      />
      <RuntimeSection form={form} setForm={setForm} />
    </RegistryFormShell>
  );
}

// ─────────────────────────────────────────────────────────────
// Section primitives
// ─────────────────────────────────────────────────────────────

function Section({
  icon: Icon,
  title,
  hint,
  children,
}: {
  icon: LucideIcon;
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <header className="flex items-center gap-2 mb-2">
        <Icon className="w-3.5 h-3.5 text-[hsl(var(--muted-foreground))]" />
        <h4 className="text-[0.6875rem] uppercase tracking-wider font-semibold text-[hsl(var(--muted-foreground))]">
          {title}
        </h4>
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

function Label({
  htmlFor,
  label,
  required,
  hint,
}: {
  htmlFor?: string;
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

// ─────────────────────────────────────────────────────────────
// Trigger section (event Select + description)
// ─────────────────────────────────────────────────────────────

function TriggerSection({
  form,
  setForm,
  disableEventSwitch,
}: {
  form: FormState;
  setForm: (f: FormState) => void;
  disableEventSwitch: boolean;
}) {
  const { t } = useI18n();
  const description = t(`envManagement.registry.hooks.form.events.${form.event}`);
  return (
    <Section
      icon={Settings2}
      title={t('envManagement.registry.hooks.form.sectionTrigger')}
    >
      <div className="grid gap-3">
        <div className="grid gap-1.5">
          <Label
            htmlFor="hook-event"
            label={t('envManagement.registry.hooks.form.eventLabel')}
            required
            hint={
              disableEventSwitch
                ? t('envManagement.registry.hooks.form.eventCantChangeHint')
                : t('envManagement.registry.hooks.form.eventHint')
            }
          />
          <Select
            value={form.event}
            onValueChange={(v) =>
              setForm({ ...form, event: v as HookEvent })
            }
            disabled={disableEventSwitch}
          >
            <SelectTrigger id="hook-event" className="font-mono text-[0.8125rem]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {HOOK_EVENTS.map((ev) => (
                <SelectItem key={ev} value={ev} className="font-mono">
                  {ev}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {/* Live event description card — updates as the operator
            picks a different event so the meaning is visible without
            leaving the form. */}
        <div className="flex items-start gap-2 px-3 py-2 rounded-lg border border-sky-500/30 bg-sky-500/5 text-[0.75rem] text-sky-800 dark:text-sky-300">
          <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <div className="flex-1 leading-relaxed">{description}</div>
        </div>
      </div>
    </Section>
  );
}

// ─────────────────────────────────────────────────────────────
// Execution section (command + args)
// ─────────────────────────────────────────────────────────────

function ExecutionSection({
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
      title={t('envManagement.registry.hooks.form.sectionExecution')}
    >
      <div className="grid gap-3">
        <div className="grid gap-1.5">
          <Label
            htmlFor="hook-cmd"
            label={t('envManagement.registry.hooks.form.commandLabel')}
            required
            hint={t('envManagement.registry.hooks.form.commandHint')}
          />
          <Input
            id="hook-cmd"
            value={form.command}
            onChange={(e) => setForm({ ...form, command: e.target.value })}
            placeholder={t('envManagement.registry.hooks.form.commandPlaceholder')}
            className="font-mono"
          />
        </div>
        <div className="grid gap-1.5">
          <Label
            htmlFor="hook-args"
            label={t('envManagement.registry.hooks.form.argsLabel')}
            hint={t('envManagement.registry.hooks.form.argsHint')}
          />
          <Textarea
            id="hook-args"
            value={form.argsText}
            onChange={(e) => setForm({ ...form, argsText: e.target.value })}
            rows={4}
            placeholder={t('envManagement.registry.hooks.form.argsPlaceholder')}
            className="font-mono text-[0.75rem]"
          />
        </div>
      </div>
    </Section>
  );
}

// ─────────────────────────────────────────────────────────────
// Runtime section (timeout + working_dir + env)
// ─────────────────────────────────────────────────────────────

function RuntimeSection({
  form,
  setForm,
}: {
  form: FormState;
  setForm: (f: FormState) => void;
}) {
  const { t } = useI18n();
  return (
    <Section
      icon={Settings2}
      title={t('envManagement.registry.hooks.form.sectionRuntime')}
    >
      <div className="grid gap-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="grid gap-1.5">
            <Label
              htmlFor="hook-timeout"
              label={t('envManagement.registry.hooks.form.timeoutLabel')}
              hint={t('envManagement.registry.hooks.form.timeoutHint')}
            />
            <Input
              id="hook-timeout"
              value={form.timeoutMs}
              onChange={(e) => setForm({ ...form, timeoutMs: e.target.value })}
              placeholder={t('envManagement.registry.hooks.form.timeoutPlaceholder')}
              inputMode="numeric"
              className="font-mono text-[0.8125rem]"
            />
          </div>
          <div className="grid gap-1.5">
            <Label
              htmlFor="hook-wd"
              label={t('envManagement.registry.hooks.form.workingDirLabel')}
              hint={t('envManagement.registry.hooks.form.workingDirHint')}
            />
            <Input
              id="hook-wd"
              value={form.workingDir}
              onChange={(e) => setForm({ ...form, workingDir: e.target.value })}
              placeholder={t('envManagement.registry.hooks.form.workingDirPlaceholder')}
              className="font-mono text-[0.8125rem]"
            />
          </div>
        </div>
        <KvSection
          icon={Box}
          title={t('envManagement.registry.mcp.form.sectionEnv')}
          hint={t('envManagement.registry.hooks.form.envHint')}
          rows={form.env}
          onChange={(env) => setForm({ ...form, env })}
          keyPlaceholder="DEBUG"
          valuePlaceholder="1"
          inline
        />
      </div>
    </Section>
  );
}

// ─────────────────────────────────────────────────────────────
// KV editor (env / match)
// ─────────────────────────────────────────────────────────────

function KvSection({
  icon,
  title,
  hint,
  rows,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
  inline = false,
}: {
  icon: LucideIcon;
  title: string;
  hint: string;
  rows: KvRow[];
  onChange: (rows: KvRow[]) => void;
  keyPlaceholder: string;
  valuePlaceholder: string;
  /** When true, render without the section heading (used as a
   *  sub-block inside Runtime where the parent already has a
   *  heading). */
  inline?: boolean;
}) {
  const { t } = useI18n();
  const body = (
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
  );
  if (inline) {
    return (
      <div className="grid gap-1.5">
        <Label label={title} hint={hint} />
        {body}
      </div>
    );
  }
  return (
    <Section icon={icon} title={title} hint={hint}>
      {body}
    </Section>
  );
}
