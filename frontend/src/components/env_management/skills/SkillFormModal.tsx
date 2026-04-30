'use client';

/**
 * SkillFormModal — beginner-friendly form for creating + editing a
 * user skill. Same hero+section pattern as McpServerFormModal so
 * the operator builds muscle memory across the four host registries.
 *
 * Operator brief (Phase 9.3): the previous EditorModal stuffed every
 * SKILL.md frontmatter field into a single column with no grouping
 * or hints — IDs, JSON extras, and the markdown body all read the
 * same. New users couldn't tell what `effort` or `execution_mode`
 * actually did, and the body was rendered as a plain textarea with
 * zero scaffolding. Net result: skills only ever got registered by
 * people who already knew the schema.
 *
 * Layout:
 *
 *   ┌─ Header (icon-tile + title + Cancel/Save) ────────────┐
 *   ├─ Body (sectioned, scrollable) ────────────────────────┤
 *   │ ▶ 식별 정보       (ID + Name + Description)          │
 *   │ ▶ 분류 & 메타     (Category + Effort + Version)      │
 *   │ ▶ 도구 & 실행     (Allowed tools / Model / Exec mode) │
 *   │ ▶ 예시            (when the LLM should call this)    │
 *   │ ▶ 본문            (markdown content)                  │
 *   │ ▶ 고급            (extras JSON, collapsible)         │
 *   └────────────────────────────────────────────────────────┘
 *
 * Each section has a heading + leading hint. Each field has its
 * own micro-hint under the label. The result reads like a guided
 * walkthrough: ID first ("this is the slash command"), then name,
 * then the description (with explicit "this is what the LLM uses
 * to decide whether to call you"), then meta, then tools, then
 * examples for intent matching, then the actual markdown body.
 */

import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Cpu,
  Eye,
  EyeOff,
  FlaskConical,
  HelpCircle,
  Info,
  ListChecks,
  Save,
  Sparkles,
  Tag,
  Wrench,
  X,
  XCircle,
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
import { skillsApi, type SkillDetail, type SkillTestResponse } from '@/lib/api';

// ─────────────────────────────────────────────────────────────
// Form state model
// ─────────────────────────────────────────────────────────────

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

interface FormState {
  id: string;
  name: string;
  description: string;
  body: string;
  category: string;
  effort: string;
  modelOverride: string;
  allowedTools: string;
  examples: string;
  version: string;
  executionMode: string; // '' | 'inline' | 'fork'
  extrasText: string;
}

const EMPTY_FORM: FormState = {
  id: '',
  name: '',
  description: '',
  body: '',
  category: '',
  effort: '',
  modelOverride: '',
  allowedTools: '',
  examples: '',
  version: '',
  executionMode: '',
  extrasText: '',
};

export interface SkillFormSubmit {
  id: string;
  name: string;
  description: string;
  body: string;
  model_override: string | null;
  category: string | null;
  effort: string | null;
  allowed_tools: string[];
  examples: string[];
  version: string | null;
  execution_mode: string | null;
  extras?: Record<string, string | number | boolean>;
}

function formToPayload(f: FormState): {
  payload: SkillFormSubmit | null;
  error: string | null;
  errorVars?: Record<string, string>;
} {
  const id = f.id.trim();
  const name = f.name.trim();
  const description = f.description.trim();
  if (!id || !name || !description) {
    return { payload: null, error: 'errorRequired' };
  }
  if (!ID_RE.test(id)) {
    return { payload: null, error: 'errorBadId' };
  }
  let extras: Record<string, string | number | boolean> | undefined;
  const trimmedExtras = f.extrasText.trim();
  if (trimmedExtras) {
    try {
      const parsed = JSON.parse(trimmedExtras);
      if (
        parsed &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed)
      ) {
        extras = {};
        for (const [k, v] of Object.entries(parsed)) {
          if (
            typeof v === 'string' ||
            typeof v === 'number' ||
            typeof v === 'boolean'
          ) {
            extras[k] = v;
          }
        }
      } else {
        return { payload: null, error: 'errorBadExtras', errorVars: { detail: 'must be a JSON object' } };
      }
    } catch (e) {
      return {
        payload: null,
        error: 'errorBadExtras',
        errorVars: { detail: e instanceof Error ? e.message : 'parse error' },
      };
    }
  }
  return {
    payload: {
      id,
      name,
      description,
      body: f.body,
      model_override: f.modelOverride.trim() || null,
      category: f.category.trim() || null,
      effort: f.effort.trim() || null,
      allowed_tools: f.allowedTools
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      examples: f.examples
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
      version: f.version.trim() || null,
      execution_mode: f.executionMode.trim() || null,
      ...(extras ? { extras } : {}),
    },
    error: null,
  };
}

function detailToForm(d: SkillDetail): FormState {
  return {
    id: d.id,
    name: d.name ?? '',
    description: d.description ?? '',
    body: d.body,
    category: d.category ?? '',
    effort: d.effort ?? '',
    modelOverride: d.model ?? '',
    allowedTools: d.allowed_tools.join(', '),
    examples: d.examples.join('\n'),
    version: d.version ?? '',
    executionMode: d.execution_mode ?? '',
    extrasText:
      d.extras && Object.keys(d.extras).length > 0
        ? JSON.stringify(d.extras, null, 2)
        : '',
  };
}

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────

export interface SkillFormModalProps {
  open: boolean;
  editingExisting: boolean;
  /** Initial detail (edit mode). */
  initialDetail?: SkillDetail | null;
  saving: boolean;
  error?: string | null;
  onClose: () => void;
  onSubmit: (payload: SkillFormSubmit) => void;
}

export default function SkillFormModal({
  open,
  editingExisting,
  initialDetail,
  saving,
  error: externalError,
  onClose,
  onSubmit,
}: SkillFormModalProps) {
  const { t } = useI18n();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [innerError, setInnerError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<SkillTestResponse | null>(null);
  const [compiledOpen, setCompiledOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (editingExisting && initialDetail) {
      setForm(detailToForm(initialDetail));
    } else {
      setForm(EMPTY_FORM);
    }
    setInnerError(null);
    setAdvancedOpen(false);
    setTestResult(null);
    setCompiledOpen(false);
  }, [open, editingExisting, initialDetail]);

  if (!open) return null;

  const error = innerError ?? externalError ?? null;

  const submit = () => {
    setInnerError(null);
    const { payload, error: errKey, errorVars } = formToPayload(form);
    if (!payload) {
      setInnerError(
        errKey ? t(`envManagement.registry.skills.form.${errKey}`, errorVars) : 'Invalid form',
      );
      return;
    }
    onSubmit(payload);
  };

  const runTest = async () => {
    setInnerError(null);
    const { payload, error: errKey, errorVars } = formToPayload(form);
    if (!payload) {
      setInnerError(
        errKey ? t(`envManagement.registry.skills.form.${errKey}`, errorVars) : 'Invalid form',
      );
      return;
    }
    setTesting(true);
    try {
      const res = await skillsApi.test({
        id: payload.id,
        name: payload.name,
        description: payload.description,
        body: payload.body,
        model_override: payload.model_override,
        allowed_tools: payload.allowed_tools,
        category: payload.category,
        effort: payload.effort,
        examples: payload.examples,
        version: payload.version,
        execution_mode: payload.execution_mode,
        ...(payload.extras ? { extras: payload.extras } : {}),
      });
      setTestResult(res);
      setCompiledOpen(false);
    } catch (e) {
      setInnerError(e instanceof Error ? e.message : String(e));
    } finally {
      setTesting(false);
    }
  };

  const slashPreview = form.id.trim() || 'your-skill';
  const title = editingExisting
    ? t('envManagement.registry.skills.form.editTitle', { id: slashPreview })
    : t('envManagement.registry.skills.form.createTitle');

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
              <Sparkles className="w-5 h-5 text-[hsl(var(--primary))]" strokeWidth={2} />
            </div>
            <h3 className="text-[1rem] font-semibold text-[hsl(var(--foreground))] truncate">
              {title}
            </h3>
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

        {/* ── Body ── */}
        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 flex flex-col gap-5">
          <IdentitySection
            form={form}
            setForm={setForm}
            editingExisting={editingExisting}
          />
          <MetaSection form={form} setForm={setForm} />
          <ExecutionSection form={form} setForm={setForm} />
          <ExamplesSection form={form} setForm={setForm} />
          <BodySection form={form} setForm={setForm} />
          <AdvancedSection
            form={form}
            setForm={setForm}
            open={advancedOpen}
            onToggle={() => setAdvancedOpen((v) => !v)}
          />

          {testResult && (
            <TestResultPanel
              result={testResult}
              compiledOpen={compiledOpen}
              onToggleCompiled={() => setCompiledOpen((v) => !v)}
              onClose={() => setTestResult(null)}
            />
          )}

          {error && (
            <div className="flex items-start gap-2 px-3 py-2 rounded-lg border border-red-500/30 bg-red-500/10 text-[0.75rem] text-red-700 dark:text-red-300">
              <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <div className="flex-1">{error}</div>
            </div>
          )}
        </div>

        {/* ── Footer ── */}
        <footer className="flex items-center justify-between gap-2 px-5 py-4 border-t border-[hsl(var(--border))] shrink-0">
          <button
            type="button"
            onClick={runTest}
            disabled={saving || testing}
            title={t('envManagement.registry.skills.form.testHint')}
            className="inline-flex items-center gap-1.5 h-9 px-4 rounded-md border border-[hsl(var(--border))] text-[0.8125rem] font-medium text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))] disabled:opacity-50"
          >
            <FlaskConical className={`w-4 h-4 ${testing ? 'animate-pulse' : ''}`} />
            {testing
              ? t('envManagement.registry.skills.form.testingLabel')
              : t('envManagement.registry.skills.form.testBtn')}
          </button>
          <div className="flex items-center gap-2">
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
                    ? t('envManagement.registry.skills.form.editBtn')
                    : t('envManagement.registry.skills.form.createBtn')}
                </>
              )}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Test result panel (Phase 9.7)
// ─────────────────────────────────────────────────────────────

function TestResultPanel({
  result,
  compiledOpen,
  onToggleCompiled,
  onClose,
}: {
  result: SkillTestResponse;
  compiledOpen: boolean;
  onToggleCompiled: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const ok = result.ok;
  return (
    <div
      className={`rounded-xl border p-3 flex flex-col gap-2 ${
        ok
          ? 'border-emerald-500/40 bg-emerald-500/5'
          : 'border-red-500/40 bg-red-500/5'
      }`}
    >
      <header className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {ok ? (
            <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
          ) : (
            <XCircle className="w-4 h-4 text-red-600 dark:text-red-400" />
          )}
          <span
            className={`text-[0.8125rem] font-semibold ${
              ok ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-700 dark:text-red-300'
            }`}
          >
            {ok
              ? t('envManagement.registry.skills.form.testOk')
              : t('envManagement.registry.skills.form.testFailed')}
          </span>
          <span className="text-[0.6875rem] text-[hsl(var(--muted-foreground))]">
            {t('envManagement.registry.skills.form.testBodyStats', {
              chars: String(result.body_chars),
              lines: String(result.body_lines),
            })}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-[0.6875rem] text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:underline"
        >
          {t('envManagement.registry.skills.form.testCloseLabel')}
        </button>
      </header>

      {result.errors.length > 0 && (
        <div className="rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-2">
          <div className="flex items-center gap-1.5 mb-1">
            <XCircle className="w-3.5 h-3.5 text-red-600 dark:text-red-400" />
            <span className="text-[0.6875rem] uppercase tracking-wider font-semibold text-red-700 dark:text-red-300">
              {t('envManagement.registry.skills.form.testErrors')} ({result.errors.length})
            </span>
          </div>
          <ul className="text-[0.75rem] text-red-700 dark:text-red-300 space-y-0.5 list-disc ml-4">
            {result.errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}

      {result.warnings.length > 0 && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-2">
          <div className="flex items-center gap-1.5 mb-1">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
            <span className="text-[0.6875rem] uppercase tracking-wider font-semibold text-amber-700 dark:text-amber-300">
              {t('envManagement.registry.skills.form.testWarnings')} ({result.warnings.length})
            </span>
          </div>
          <ul className="text-[0.75rem] text-amber-800 dark:text-amber-200 space-y-0.5 list-disc ml-4">
            {result.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))]">
        <button
          type="button"
          onClick={onToggleCompiled}
          className="w-full flex items-center justify-between px-2.5 py-1.5 hover:bg-[hsl(var(--accent))]/40 transition-colors"
        >
          <div className="flex items-center gap-1.5">
            {compiledOpen ? (
              <ChevronDown className="w-3.5 h-3.5 text-[hsl(var(--muted-foreground))]" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5 text-[hsl(var(--muted-foreground))]" />
            )}
            <span className="text-[0.6875rem] uppercase tracking-wider font-semibold text-[hsl(var(--muted-foreground))]">
              {t('envManagement.registry.skills.form.testCompiled')}
            </span>
          </div>
          <span className="text-[0.65rem] text-[hsl(var(--muted-foreground))]">
            {t('envManagement.registry.skills.form.testCompiledHint')}
          </span>
        </button>
        {compiledOpen && (
          <pre className="border-t border-[hsl(var(--border))] px-3 py-2 text-[0.7rem] font-mono whitespace-pre-wrap break-words max-h-64 overflow-y-auto text-[hsl(var(--foreground))]">
            {result.skill_md}
          </pre>
        )}
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

// ─────────────────────────────────────────────────────────────
// Identity (id + name + description)
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
  const slashId = form.id.trim() || 'your-skill';
  return (
    <Section
      icon={HelpCircle}
      title={t('envManagement.registry.skills.form.sectionIdentity')}
    >
      <div className="grid gap-3">
        <div className="grid gap-1.5">
          <Label
            htmlFor="skill-id"
            label={t('envManagement.registry.skills.form.idLabel')}
            required
            hint={t('envManagement.registry.skills.form.idHint', {
              id: slashId,
            })}
          />
          <div className="flex items-center gap-2">
            <span className="text-[0.8125rem] text-[hsl(var(--muted-foreground))] font-mono shrink-0">
              /
            </span>
            <Input
              id="skill-id"
              value={form.id}
              onChange={(e) => setForm({ ...form, id: e.target.value })}
              disabled={editingExisting}
              placeholder={t('envManagement.registry.skills.form.idPlaceholder')}
              className="font-mono"
            />
          </div>
        </div>
        <div className="grid gap-1.5">
          <Label
            htmlFor="skill-name"
            label={t('envManagement.registry.skills.form.nameLabel')}
            required
            hint={t('envManagement.registry.skills.form.nameHint')}
          />
          <Input
            id="skill-name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder={t('envManagement.registry.skills.form.namePlaceholder')}
          />
        </div>
        <div className="grid gap-1.5">
          <Label
            htmlFor="skill-desc"
            label={t('envManagement.registry.skills.form.descriptionLabel')}
            required
            hint={t('envManagement.registry.skills.form.descriptionHint')}
          />
          <Textarea
            id="skill-desc"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            placeholder={t(
              'envManagement.registry.skills.form.descriptionPlaceholder',
            )}
            rows={2}
            className="leading-relaxed"
          />
        </div>
      </div>
    </Section>
  );
}

// ─────────────────────────────────────────────────────────────
// Meta (category, effort, version)
// ─────────────────────────────────────────────────────────────

function MetaSection({
  form,
  setForm,
}: {
  form: FormState;
  setForm: (f: FormState) => void;
}) {
  const { t } = useI18n();
  return (
    <Section
      icon={Tag}
      title={t('envManagement.registry.skills.form.sectionMeta')}
    >
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="grid gap-1.5">
          <Label
            htmlFor="skill-cat"
            label={t('envManagement.registry.skills.form.categoryLabel')}
            hint={t('envManagement.registry.skills.form.categoryHint')}
          />
          <Input
            id="skill-cat"
            value={form.category}
            onChange={(e) => setForm({ ...form, category: e.target.value })}
            placeholder={t('envManagement.registry.skills.form.categoryPlaceholder')}
          />
        </div>
        <div className="grid gap-1.5">
          <Label
            htmlFor="skill-eff"
            label={t('envManagement.registry.skills.form.effortLabel')}
            hint={t('envManagement.registry.skills.form.effortHint')}
          />
          <Select
            value={form.effort || '__none__'}
            onValueChange={(v) =>
              setForm({ ...form, effort: v === '__none__' ? '' : v })
            }
          >
            <SelectTrigger id="skill-eff">
              <SelectValue
                placeholder={t('envManagement.registry.skills.form.effortPlaceholder')}
              />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">—</SelectItem>
              <SelectItem value="low">low</SelectItem>
              <SelectItem value="medium">medium</SelectItem>
              <SelectItem value="high">high</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label
            htmlFor="skill-ver"
            label={t('envManagement.registry.skills.form.versionLabel')}
            hint={t('envManagement.registry.skills.form.versionHint')}
          />
          <Input
            id="skill-ver"
            value={form.version}
            onChange={(e) => setForm({ ...form, version: e.target.value })}
            placeholder={t('envManagement.registry.skills.form.versionPlaceholder')}
            className="font-mono text-[0.75rem]"
          />
        </div>
      </div>
    </Section>
  );
}

// ─────────────────────────────────────────────────────────────
// Execution (model_override, execution_mode, allowed_tools)
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
      icon={Wrench}
      title={t('envManagement.registry.skills.form.sectionExecution')}
    >
      <div className="grid gap-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="grid gap-1.5">
            <Label
              htmlFor="skill-model"
              label={t('envManagement.registry.skills.form.modelOverrideLabel')}
              hint={t('envManagement.registry.skills.form.modelOverrideHint')}
            />
            <Input
              id="skill-model"
              value={form.modelOverride}
              onChange={(e) =>
                setForm({ ...form, modelOverride: e.target.value })
              }
              placeholder={t(
                'envManagement.registry.skills.form.modelOverridePlaceholder',
              )}
              className="font-mono text-[0.75rem]"
            />
          </div>
          <div className="grid gap-1.5">
            <Label
              htmlFor="skill-exec"
              label={t('envManagement.registry.skills.form.executionModeLabel')}
              hint={t('envManagement.registry.skills.form.executionModeHint')}
            />
            <Select
              value={form.executionMode || '__inline__'}
              onValueChange={(v) =>
                setForm({
                  ...form,
                  executionMode: v === '__inline__' ? '' : v,
                })
              }
            >
              <SelectTrigger id="skill-exec">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__inline__">
                  {t('envManagement.registry.skills.form.executionModeInline')}
                </SelectItem>
                <SelectItem value="fork">
                  {t('envManagement.registry.skills.form.executionModeFork')}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="grid gap-1.5">
          <Label
            htmlFor="skill-tools"
            label={t('envManagement.registry.skills.form.allowedToolsLabel')}
            hint={t('envManagement.registry.skills.form.allowedToolsHint')}
          />
          <Input
            id="skill-tools"
            value={form.allowedTools}
            onChange={(e) => setForm({ ...form, allowedTools: e.target.value })}
            placeholder={t(
              'envManagement.registry.skills.form.allowedToolsPlaceholder',
            )}
            className="font-mono"
          />
        </div>
      </div>
    </Section>
  );
}

// ─────────────────────────────────────────────────────────────
// Examples
// ─────────────────────────────────────────────────────────────

function ExamplesSection({
  form,
  setForm,
}: {
  form: FormState;
  setForm: (f: FormState) => void;
}) {
  const { t } = useI18n();
  return (
    <Section
      icon={ListChecks}
      title={t('envManagement.registry.skills.form.sectionExamples')}
      hint={t('envManagement.registry.skills.form.examplesHint')}
    >
      <Textarea
        id="skill-ex"
        value={form.examples}
        onChange={(e) => setForm({ ...form, examples: e.target.value })}
        rows={4}
        placeholder={t('envManagement.registry.skills.form.examplesPlaceholder')}
        className="leading-relaxed"
      />
    </Section>
  );
}

// ─────────────────────────────────────────────────────────────
// Body (markdown)
// ─────────────────────────────────────────────────────────────

function BodySection({
  form,
  setForm,
}: {
  form: FormState;
  setForm: (f: FormState) => void;
}) {
  const { t } = useI18n();
  const [previewOpen, setPreviewOpen] = useState(false);

  const previewToggle = (
    <button
      type="button"
      onClick={() => setPreviewOpen((v) => !v)}
      className={`inline-flex items-center gap-1 h-6 px-2 rounded-md text-[0.65rem] font-medium border transition-colors ${
        previewOpen
          ? 'border-violet-500/50 bg-violet-500/10 text-violet-700 dark:text-violet-300 hover:bg-violet-500/15'
          : 'border-[hsl(var(--border))] bg-transparent text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))]'
      }`}
      title={
        previewOpen
          ? t('envManagement.registry.skills.form.bodyPreviewToggleOn')
          : t('envManagement.registry.skills.form.bodyPreviewToggleOff')
      }
    >
      {previewOpen ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
      {previewOpen
        ? t('envManagement.registry.skills.form.bodyPreviewToggleOn')
        : t('envManagement.registry.skills.form.bodyPreviewToggleOff')}
    </button>
  );

  const editor = (
    <Textarea
      id="skill-body"
      value={form.body}
      onChange={(e) => setForm({ ...form, body: e.target.value })}
      rows={12}
      placeholder={t('envManagement.registry.skills.form.bodyPlaceholder')}
      className="font-mono text-[0.75rem] leading-relaxed h-full min-h-[18rem]"
      spellCheck={false}
    />
  );

  // Split editor + preview when toggle is on. Preview pane mirrors the
  // chat / wiki markdown surface so what the operator sees here is what
  // the LLM will see when the skill body is injected — including GFM
  // tables, fenced code, and inline code.
  return (
    <Section
      icon={Cpu}
      title={t('envManagement.registry.skills.form.sectionBody')}
      hint={t('envManagement.registry.skills.form.bodyHint')}
      rightSlot={previewToggle}
    >
      {previewOpen ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-[0.65rem] uppercase tracking-wider text-[hsl(var(--muted-foreground))] font-semibold">
              {t('envManagement.registry.skills.form.bodyEditLabel')}
            </span>
            {editor}
          </div>
          <div className="flex flex-col gap-1 min-w-0">
            <span className="text-[0.65rem] uppercase tracking-wider text-[hsl(var(--muted-foreground))] font-semibold">
              {t('envManagement.registry.skills.form.bodyPreviewLabel')}
            </span>
            <div className="flex-1 min-h-[18rem] rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] overflow-y-auto px-3 py-2">
              {form.body.trim() ? (
                <article className="wiki-markdown text-[0.8125rem] leading-relaxed">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {form.body}
                  </ReactMarkdown>
                </article>
              ) : (
                <p className="text-[0.75rem] text-[hsl(var(--muted-foreground))] italic">
                  {t('envManagement.registry.skills.form.bodyPreviewEmpty')}
                </p>
              )}
            </div>
          </div>
        </div>
      ) : (
        editor
      )}
    </Section>
  );
}

// ─────────────────────────────────────────────────────────────
// Advanced (extras JSON, collapsible)
// ─────────────────────────────────────────────────────────────

function AdvancedSection({
  form,
  setForm,
  open,
  onToggle,
}: {
  form: FormState;
  setForm: (f: FormState) => void;
  open: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
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
            {t('envManagement.registry.skills.form.sectionExtras')}
          </h4>
        </div>
      </button>
      {open && (
        <div className="border-t border-[hsl(var(--border))] p-3">
          <div className="grid gap-1.5">
            <Label
              htmlFor="skill-extras"
              label={t('envManagement.registry.skills.form.extrasLabel')}
              hint={t('envManagement.registry.skills.form.extrasHint')}
            />
            <Textarea
              id="skill-extras"
              value={form.extrasText}
              onChange={(e) =>
                setForm({ ...form, extrasText: e.target.value })
              }
              rows={3}
              spellCheck={false}
              placeholder={t('envManagement.registry.skills.form.extrasPlaceholder')}
              className="font-mono text-[0.75rem]"
            />
          </div>
        </div>
      )}
    </section>
  );
}
