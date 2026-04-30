'use client';

/**
 * PermissionFormModal — beginner-friendly form for creating + editing
 * a permission rule. Same hero+section pattern as McpServerFormModal /
 * SkillFormModal / HookFormModal so the four host-registry forms read
 * as siblings.
 *
 * Operator brief (Phase 9.5): the previous EditorModal was a flat 5-
 * field grid (tool / behavior / pattern / source / reason) where the
 * `behavior` value was a Select chip with no explanation, and `pattern`
 * had a single English placeholder ("git push *"). New users could not
 * tell `allow` from `ask` without reading docs, and were confused by
 * `pattern` (does it mean glob? regex? args? path?).
 *
 * Layout:
 *
 *   ┌─ Header (icon-tile + title + close) ─────────────────────┐
 *   ├─ Body (sectioned, scrollable) ───────────────────────────┤
 *   │ ▶ 대상         (tool name + optional pattern)            │
 *   │ ▶ 정책         (behavior — radio cards w/ description)   │
 *   │ ▶ 컨텍스트     (source + reason — editorial)             │
 *   └───────────────────────────────────────────────────────────┘
 *
 * Behaviour is the headline decision so it gets visual radio cards
 * (allow / deny / ask), each with its own one-liner — no docs trip
 * required to pick the right one.
 */

import { useEffect, useState } from 'react';
import {
  Check,
  FileText,
  Info,
  Save,
  Shield,
  ShieldCheck,
  ShieldX,
  Tag,
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
import {
  type PermissionBehavior,
  type PermissionRulePayload,
  type PermissionSource,
} from '@/lib/api';
import RegistryFormShell from '@/components/env_management/registry/RegistryFormShell';

const SOURCE_OPTIONS: PermissionSource[] = ['user', 'project', 'local', 'cli', 'preset'];

// ─────────────────────────────────────────────────────────────
// Form state model
// ─────────────────────────────────────────────────────────────

interface FormState {
  tool_name: string;
  behavior: PermissionBehavior;
  pattern: string;
  source: PermissionSource;
  reason: string;
}

const EMPTY_FORM: FormState = {
  tool_name: '',
  behavior: 'ask',
  pattern: '',
  source: 'user',
  reason: '',
};

function formToPayload(f: FormState): {
  payload: PermissionRulePayload | null;
  error: string | null;
} {
  if (!f.tool_name.trim() || !f.behavior) {
    return { payload: null, error: 'errorRequired' };
  }
  return {
    payload: {
      tool_name: f.tool_name.trim(),
      behavior: f.behavior,
      pattern: f.pattern.trim() ? f.pattern.trim() : null,
      source: f.source,
      reason: f.reason.trim() ? f.reason.trim() : null,
    },
    error: null,
  };
}

function ruleToForm(rule: PermissionRulePayload): FormState {
  return {
    tool_name: rule.tool_name ?? '',
    behavior: rule.behavior,
    pattern: rule.pattern ?? '',
    source: rule.source ?? 'user',
    reason: rule.reason ?? '',
  };
}

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────

export interface PermissionFormModalProps {
  editingIdx: number | null;
  initialRule?: PermissionRulePayload | null;
  saving: boolean;
  error?: string | null;
  onClose: () => void;
  onSubmit: (payload: PermissionRulePayload) => void;
}

export default function PermissionFormModal({
  editingIdx,
  initialRule,
  saving,
  error: externalError,
  onClose,
  onSubmit,
}: PermissionFormModalProps) {
  const { t } = useI18n();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [innerError, setInnerError] = useState<string | null>(null);

  useEffect(() => {
    if (editingIdx !== null && initialRule) {
      setForm(ruleToForm(initialRule));
    } else {
      setForm(EMPTY_FORM);
    }
    setInnerError(null);
  }, [editingIdx, initialRule]);

  const error = innerError ?? externalError ?? null;

  const submit = () => {
    setInnerError(null);
    const { payload, error: errKey } = formToPayload(form);
    if (!payload) {
      setInnerError(
        errKey
          ? t(`envManagement.registry.permissions.form.${errKey}`)
          : 'Invalid form',
      );
      return;
    }
    onSubmit(payload);
  };

  const title =
    editingIdx === null
      ? t('envManagement.registry.permissions.form.createTitle')
      : t('envManagement.registry.permissions.form.editTitle', {
          idx: String(editingIdx),
        });

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
            {editingIdx === null
              ? t('envManagement.registry.permissions.form.createBtn')
              : t('envManagement.registry.permissions.form.editBtn')}
          </>
        )}
      </button>
    </>
  );

  return (
    <RegistryFormShell
      icon={Shield}
      title={title}
      backLabel={t('envManagement.registry.backToList')}
      onBack={onClose}
      error={error}
      onDismissError={() => setInnerError(null)}
      footer={footer}
    >
      <IdentitySection form={form} setForm={setForm} />
      <PolicySection form={form} setForm={setForm} />
      <ContextSection form={form} setForm={setForm} />
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
// Identity section (tool + pattern)
// ─────────────────────────────────────────────────────────────

function IdentitySection({
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
      title={t('envManagement.registry.permissions.form.sectionIdentity')}
    >
      <div className="grid gap-3">
        <div className="grid gap-1.5">
          <Label
            htmlFor="perm-tool"
            label={t('envManagement.registry.permissions.form.toolLabel')}
            required
            hint={t('envManagement.registry.permissions.form.toolHint')}
          />
          <Input
            id="perm-tool"
            value={form.tool_name}
            onChange={(e) => setForm({ ...form, tool_name: e.target.value })}
            placeholder={t('envManagement.registry.permissions.form.toolPlaceholder')}
            className="font-mono text-[0.8125rem]"
          />
        </div>
        <div className="grid gap-1.5">
          <Label
            htmlFor="perm-pattern"
            label={t('envManagement.registry.permissions.form.patternLabel')}
            hint={t('envManagement.registry.permissions.form.patternHint')}
          />
          <Input
            id="perm-pattern"
            value={form.pattern}
            onChange={(e) => setForm({ ...form, pattern: e.target.value })}
            placeholder={t('envManagement.registry.permissions.form.patternPlaceholder')}
            className="font-mono text-[0.8125rem]"
          />
        </div>
      </div>
    </Section>
  );
}

// ─────────────────────────────────────────────────────────────
// Policy section (behavior radio cards)
// ─────────────────────────────────────────────────────────────

interface BehaviorChoice {
  value: PermissionBehavior;
  icon: LucideIcon;
  labelKey: string;
  hintKey: string;
  // Tailwind ring + bg accents per behavior — visual cue.
  selectedTone: string;
  iconTone: string;
}

const BEHAVIOR_CHOICES: BehaviorChoice[] = [
  {
    value: 'allow',
    icon: ShieldCheck,
    labelKey: 'behaviorAllowLabel',
    hintKey: 'behaviorAllowHint',
    selectedTone: 'border-emerald-500/60 bg-emerald-500/10 ring-1 ring-emerald-500/30',
    iconTone: 'text-emerald-600 dark:text-emerald-400',
  },
  {
    value: 'deny',
    icon: ShieldX,
    labelKey: 'behaviorDenyLabel',
    hintKey: 'behaviorDenyHint',
    selectedTone: 'border-red-500/60 bg-red-500/10 ring-1 ring-red-500/30',
    iconTone: 'text-red-600 dark:text-red-400',
  },
  {
    value: 'ask',
    icon: Info,
    labelKey: 'behaviorAskLabel',
    hintKey: 'behaviorAskHint',
    selectedTone: 'border-amber-500/60 bg-amber-500/10 ring-1 ring-amber-500/30',
    iconTone: 'text-amber-600 dark:text-amber-400',
  },
];

function PolicySection({
  form,
  setForm,
}: {
  form: FormState;
  setForm: (f: FormState) => void;
}) {
  const { t } = useI18n();
  return (
    <Section
      icon={Shield}
      title={t('envManagement.registry.permissions.form.sectionPolicy')}
      hint={t('envManagement.registry.permissions.form.behaviorHint')}
    >
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        {BEHAVIOR_CHOICES.map((choice) => {
          const selected = form.behavior === choice.value;
          const Icon = choice.icon;
          return (
            <button
              key={choice.value}
              type="button"
              onClick={() => setForm({ ...form, behavior: choice.value })}
              className={`relative text-left rounded-xl border p-3 transition-all ${
                selected
                  ? choice.selectedTone
                  : 'border-[hsl(var(--border))] bg-[hsl(var(--background))] hover:bg-[hsl(var(--accent))]/40'
              }`}
            >
              {selected && (
                <div className="absolute top-2 right-2 w-4 h-4 rounded-full bg-violet-500 text-white inline-flex items-center justify-center">
                  <Check className="w-2.5 h-2.5" strokeWidth={3} />
                </div>
              )}
              <div className="flex items-center gap-2 mb-1">
                <Icon className={`w-4 h-4 ${choice.iconTone}`} />
                <span className="text-[0.8125rem] font-semibold text-[hsl(var(--foreground))]">
                  {t(`envManagement.registry.permissions.form.${choice.labelKey}`)}
                </span>
              </div>
              <p className="text-[0.6875rem] text-[hsl(var(--muted-foreground))] leading-snug">
                {t(`envManagement.registry.permissions.form.${choice.hintKey}`)}
              </p>
            </button>
          );
        })}
      </div>
    </Section>
  );
}

// ─────────────────────────────────────────────────────────────
// Context section (source + reason)
// ─────────────────────────────────────────────────────────────

function ContextSection({
  form,
  setForm,
}: {
  form: FormState;
  setForm: (f: FormState) => void;
}) {
  const { t } = useI18n();
  return (
    <Section
      icon={FileText}
      title={t('envManagement.registry.permissions.form.sectionContext')}
    >
      <div className="grid gap-3">
        <div className="grid gap-1.5">
          <Label
            label={t('envManagement.registry.permissions.form.sourceLabel')}
            hint={t('envManagement.registry.permissions.form.sourceHint')}
          />
          <Select
            value={form.source}
            onValueChange={(v) =>
              setForm({ ...form, source: v as PermissionSource })
            }
          >
            <SelectTrigger className="font-mono text-[0.8125rem]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SOURCE_OPTIONS.map((s) => (
                <SelectItem key={s} value={s} className="font-mono">
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label
            htmlFor="perm-reason"
            label={t('envManagement.registry.permissions.form.reasonLabel')}
            hint={t('envManagement.registry.permissions.form.reasonHint')}
          />
          <Textarea
            id="perm-reason"
            value={form.reason}
            onChange={(e) => setForm({ ...form, reason: e.target.value })}
            rows={2}
            placeholder={t(
              'envManagement.registry.permissions.form.reasonPlaceholder',
            )}
            className="text-[0.8125rem]"
          />
        </div>
      </div>
    </Section>
  );
}
