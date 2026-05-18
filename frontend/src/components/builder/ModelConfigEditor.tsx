'use client';

/**
 * ModelConfigEditor — form panel for `manifest.model` (a.k.a.
 * `ModelConfig`). Mirrors every field on the executor's `ModelConfig`
 * except `api_key` (a deploy-time secret).
 *
 * Save semantics: shallow-merge against current values; only changed
 * keys are PATCHed. Empty inputs are treated as "leave unchanged"
 * rather than "clear" — to clear an optional field, edit the manifest
 * via ImportManifestModal.
 *
 * Layout: this component is a pure form section that fills its
 * parent's width. Containers (e.g. GlobalSettingsView) decide the
 * outer max-width.
 *
 * Provider awareness: when a parent passes `provider`/`onProviderChange`
 * (the global model panel does, per-stage `model_override` cards do
 * not), the editor renders a segmented Anthropic / OpenAI / Google /
 * vLLM selector at the top and uses ModelPicker — provider-keyed
 * catalogs from `lib/modelCatalog.ts`, free-form for vLLM. Without
 * those props the editor falls back to a free-form model input
 * (the per-stage override case).
 */

import { useEffect, useMemo, useState } from 'react';
import { Save, RotateCcw, AlertTriangle, ExternalLink, Loader2 } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { PROVIDERS, type ProviderId } from '@/lib/modelCatalog';
import { useLLMBackendsHealthStore } from '@/store/useLLMBackendsHealthStore';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ActionButton } from '@/components/layout';
import { ModelPicker } from './ModelPicker';

const THINKING_TYPE_VALUES = ['enabled', 'disabled', 'adaptive'] as const;
const THINKING_DISPLAY_VALUES = ['summarized', 'omitted'] as const;
type ThinkingType = (typeof THINKING_TYPE_VALUES)[number];
type ThinkingDisplay = (typeof THINKING_DISPLAY_VALUES)[number] | '';

export interface ModelDraft {
  model: string;
  max_tokens: string;
  temperature: string;
  top_p: string;
  top_k: string;
  stop_sequences: string;       // one per line
  thinking_enabled: boolean;
  thinking_budget_tokens: string;
  thinking_type: ThinkingType | '';
  thinking_display: ThinkingDisplay;
}

export interface ModelConfigEditorProps {
  initial: Record<string, unknown>;
  saving: boolean;
  error: string | null;
  onSave: (changes: Record<string, unknown>) => void;
  onClearError: () => void;
  /** Provider awareness — when both are supplied, render a provider
   *  selector and a curated model picker. When omitted (per-stage
   *  override cards), fall back to a plain free-form model input. */
  provider?: ProviderId;
  onProviderChange?: (next: ProviderId) => void;
}

function snapshotToDraft(src: Record<string, unknown>): ModelDraft {
  const tt =
    typeof src.thinking_type === 'string' &&
    (THINKING_TYPE_VALUES as readonly string[]).includes(src.thinking_type)
      ? (src.thinking_type as ThinkingType)
      : '';
  const td =
    typeof src.thinking_display === 'string' &&
    (THINKING_DISPLAY_VALUES as readonly string[]).includes(src.thinking_display)
      ? (src.thinking_display as ThinkingDisplay)
      : '';
  const stop = Array.isArray(src.stop_sequences)
    ? (src.stop_sequences as string[]).join('\n')
    : '';
  return {
    model: typeof src.model === 'string' ? src.model : '',
    max_tokens: typeof src.max_tokens === 'number' ? String(src.max_tokens) : '',
    temperature: typeof src.temperature === 'number' ? String(src.temperature) : '',
    top_p: typeof src.top_p === 'number' ? String(src.top_p) : '',
    top_k: typeof src.top_k === 'number' ? String(src.top_k) : '',
    stop_sequences: stop,
    thinking_enabled: typeof src.thinking_enabled === 'boolean' ? src.thinking_enabled : false,
    thinking_budget_tokens:
      typeof src.thinking_budget_tokens === 'number' ? String(src.thinking_budget_tokens) : '',
    thinking_type: tt,
    thinking_display: td,
  };
}

function buildChanges(
  initial: Record<string, unknown>,
  draft: ModelDraft,
): { ok: true; changes: Record<string, unknown> } | { ok: false; error: string } {
  const out: Record<string, unknown> = {};

  if (draft.model && draft.model !== initial.model) out.model = draft.model;

  for (const [key, raw, min] of [
    ['max_tokens', draft.max_tokens, 1] as const,
    ['top_k', draft.top_k, 1] as const,
    ['thinking_budget_tokens', draft.thinking_budget_tokens, 1] as const,
  ]) {
    if (!raw.trim()) continue;
    const n = Number.parseInt(raw, 10);
    if (Number.isNaN(n) || n < min) {
      return { ok: false, error: `${key}: must be an integer >= ${min}` };
    }
    if (n !== initial[key]) out[key] = n;
  }

  if (draft.temperature.trim()) {
    const n = Number.parseFloat(draft.temperature);
    if (Number.isNaN(n) || n < 0 || n > 2) {
      return { ok: false, error: 'temperature: must be in [0.0, 2.0]' };
    }
    if (n !== initial.temperature) out.temperature = n;
  }
  if (draft.top_p.trim()) {
    const n = Number.parseFloat(draft.top_p);
    if (Number.isNaN(n) || n < 0 || n > 1) {
      return { ok: false, error: 'top_p: must be in [0.0, 1.0]' };
    }
    if (n !== initial.top_p) out.top_p = n;
  }

  if (draft.stop_sequences.trim()) {
    const arr = draft.stop_sequences
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const initJson = JSON.stringify(initial.stop_sequences ?? []);
    const newJson = JSON.stringify(arr);
    if (initJson !== newJson) out.stop_sequences = arr;
  }

  if (draft.thinking_enabled !== (initial.thinking_enabled ?? false)) {
    out.thinking_enabled = draft.thinking_enabled;
  }
  if (draft.thinking_type && draft.thinking_type !== initial.thinking_type) {
    out.thinking_type = draft.thinking_type;
  }
  if (draft.thinking_display && draft.thinking_display !== initial.thinking_display) {
    out.thinking_display = draft.thinking_display;
  }

  return { ok: true, changes: out };
}

export function ModelConfigEditor({
  initial,
  saving,
  error,
  onSave,
  onClearError,
  provider,
  onProviderChange,
}: ModelConfigEditorProps) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<ModelDraft>(() => snapshotToDraft(initial));
  const providerAware = provider !== undefined && onProviderChange !== undefined;

  useEffect(() => {
    setDraft(snapshotToDraft(initial));
  }, [initial]);

  const buildResult = useMemo(() => buildChanges(initial, draft), [initial, draft]);
  const dirty = buildResult.ok ? Object.keys(buildResult.changes).length > 0 : true;

  const handleSave = () => {
    if (!buildResult.ok) return;
    if (Object.keys(buildResult.changes).length === 0) return;
    onSave(buildResult.changes);
  };

  const handleReset = () => {
    setDraft(snapshotToDraft(initial));
    onClearError();
  };

  const update = <K extends keyof ModelDraft>(key: K, value: ModelDraft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    onClearError();
  };

  return (
    <section className="flex flex-col gap-4 w-full">
      <header className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-0.5 min-w-0">
          <h3 className="text-[1rem] font-semibold text-[hsl(var(--foreground))]">
            {t('envManagement.modelEditor.title')}
          </h3>
          <p className="text-[0.75rem] text-[hsl(var(--muted-foreground))] leading-relaxed">
            {t('envManagement.modelEditor.description')}
          </p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <ActionButton icon={RotateCcw} onClick={handleReset} disabled={saving || !dirty}>
            {t('common.reset')}
          </ActionButton>
          <ActionButton
            variant="primary"
            icon={Save}
            onClick={handleSave}
            disabled={saving || !dirty || !buildResult.ok}
          >
            {saving ? t('envManagement.saving') : t('common.save')}
          </ActionButton>
        </div>
      </header>

      {error && (
        <div className="px-3 py-2 rounded-md bg-[rgba(239,68,68,0.1)] border border-[rgba(239,68,68,0.3)] text-[0.75rem] text-[var(--danger-color)]">
          {error}
        </div>
      )}
      {!buildResult.ok && (
        <div className="px-3 py-2 rounded-md bg-[rgba(245,158,11,0.1)] border border-[rgba(245,158,11,0.3)] text-[0.75rem] text-[var(--warning-color)]">
          {buildResult.error}
        </div>
      )}

      {providerAware && (
        <ProviderTabStrip
          provider={provider!}
          onProviderChange={onProviderChange!}
          t={t}
        />
      )}

      <div className="grid gap-1.5">
        <Label htmlFor="md-model">
          {t('envManagement.modelEditor.modelLabel')}
        </Label>
        {providerAware ? (
          <ModelPicker
            id="md-model"
            provider={provider!}
            value={draft.model}
            onChange={(v) => update('model', v)}
          />
        ) : (
          <Input
            id="md-model"
            value={draft.model}
            onChange={(e) => update('model', e.target.value)}
            placeholder="claude-sonnet-4-6"
            className="font-mono text-[0.75rem]"
          />
        )}
        <p className="text-[0.6875rem] text-[hsl(var(--muted-foreground))]">
          {t(
            providerAware && provider === 'vllm'
              ? 'envManagement.modelEditor.vllmHint'
              : 'envManagement.modelEditor.modelHint',
          )}
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="grid gap-1.5">
          <Label htmlFor="md-max-tokens">
            {t('envManagement.modelEditor.maxTokens')}{' '}
            <span className="opacity-60">
              ({t('envManagement.modelEditor.maxTokensHint')})
            </span>
          </Label>
          <Input
            id="md-max-tokens"
            value={draft.max_tokens}
            onChange={(e) => update('max_tokens', e.target.value)}
            placeholder="8192"
            inputMode="numeric"
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="md-temp">
            {t('envManagement.modelEditor.temperature')}{' '}
            <span className="opacity-60">
              ({t('envManagement.modelEditor.temperatureHint')})
            </span>
          </Label>
          <Input
            id="md-temp"
            value={draft.temperature}
            onChange={(e) => update('temperature', e.target.value)}
            placeholder="0.0"
            inputMode="decimal"
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="md-top-p">
            {t('envManagement.modelEditor.topP')}{' '}
            <span className="opacity-60">
              ({t('envManagement.modelEditor.topPHint')})
            </span>
          </Label>
          <Input
            id="md-top-p"
            value={draft.top_p}
            onChange={(e) => update('top_p', e.target.value)}
            placeholder={t('envManagement.modelEditor.unset')}
            inputMode="decimal"
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="md-top-k">
            {t('envManagement.modelEditor.topK')}{' '}
            <span className="opacity-60">
              ({t('envManagement.modelEditor.topKHint')})
            </span>
          </Label>
          <Input
            id="md-top-k"
            value={draft.top_k}
            onChange={(e) => update('top_k', e.target.value)}
            placeholder={t('envManagement.modelEditor.unset')}
            inputMode="numeric"
          />
        </div>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="md-stop">
          {t('envManagement.modelEditor.stopSequences')}{' '}
          <span className="opacity-60">
            ({t('envManagement.modelEditor.stopSequencesHint')})
          </span>
        </Label>
        <Textarea
          id="md-stop"
          value={draft.stop_sequences}
          onChange={(e) => update('stop_sequences', e.target.value)}
          rows={3}
          className="font-mono text-[0.75rem]"
          placeholder={t('envManagement.modelEditor.stopSequencesPlaceholder')}
        />
      </div>

      <fieldset className="grid gap-3 border border-[hsl(var(--border))] rounded-md p-3">
        <legend className="px-1 text-[0.75rem] font-medium text-[hsl(var(--foreground))]">
          {t('envManagement.modelEditor.thinkingFieldset')}
        </legend>
        <label className="flex items-center gap-2 text-[0.8125rem] cursor-pointer">
          <Switch
            checked={draft.thinking_enabled}
            onCheckedChange={(v) => update('thinking_enabled', !!v)}
          />
          {t('envManagement.modelEditor.thinkingEnabled')}
        </label>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="md-think-budget">
              {t('envManagement.modelEditor.thinkingBudget')}{' '}
              <span className="opacity-60">
                ({t('envManagement.modelEditor.thinkingBudgetHint')})
              </span>
            </Label>
            <Input
              id="md-think-budget"
              value={draft.thinking_budget_tokens}
              onChange={(e) => update('thinking_budget_tokens', e.target.value)}
              placeholder="10000"
              inputMode="numeric"
              disabled={!draft.thinking_enabled}
            />
          </div>
          <div className="grid gap-1.5">
            <Label>{t('envManagement.modelEditor.thinkingType')}</Label>
            <Select
              value={draft.thinking_type || undefined}
              onValueChange={(v) => update('thinking_type', v as ThinkingType)}
              disabled={!draft.thinking_enabled}
            >
              <SelectTrigger>
                <SelectValue placeholder="enabled" />
              </SelectTrigger>
              <SelectContent>
                {THINKING_TYPE_VALUES.map((v) => (
                  <SelectItem key={v} value={v}>{v}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label>{t('envManagement.modelEditor.thinkingDisplay')}</Label>
            <Select
              value={draft.thinking_display || undefined}
              onValueChange={(v) => update('thinking_display', v as ThinkingDisplay)}
              disabled={!draft.thinking_enabled}
            >
              <SelectTrigger>
                <SelectValue placeholder={t('envManagement.modelEditor.thinkingDisplayDefault')} />
              </SelectTrigger>
              <SelectContent>
                {THINKING_DISPLAY_VALUES.map((v) => (
                  <SelectItem key={v} value={v}>{v}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </fieldset>
    </section>
  );
}


/**
 * Provider tab strip — gates each tab on the live ``GET
 * /api/llm-backends/health`` probe. Providers whose card is "Not
 * configured" in the LLM Backends panel get rendered as disabled
 * (faded, no pointer events, tooltip + native title attribute
 * explaining what's missing). If the currently selected provider is
 * itself unavailable a warning banner surfaces above the strip with
 * a one-click jump to Settings.
 *
 * The fetch is deduped via ``useLLMBackendsHealthStore`` so the three
 * editors on a single Environment page (global + stage6 + stage18)
 * share one snapshot.
 */
function ProviderTabStrip({
  provider,
  onProviderChange,
  t,
}: {
  provider: ProviderId;
  onProviderChange: (next: ProviderId) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const providers = useLLMBackendsHealthStore((s) => s.providers);
  const loaded = useLLMBackendsHealthStore((s) => s.loaded);
  const loading = useLLMBackendsHealthStore((s) => s.loading);
  const error = useLLMBackendsHealthStore((s) => s.error);
  const generation = useLLMBackendsHealthStore((s) => s.generation);
  const fetchHealth = useLLMBackendsHealthStore((s) => s.fetch);

  // Trigger the fetch once per generation. ``markStale()`` bumps the
  // generation when a sibling modal saves a credential so we re-probe.
  useEffect(() => {
    fetchHealth();
  }, [fetchHealth, generation]);

  // Cross-tab refresh: if the user fixed a credential in the LLM
  // Backends settings (a separate browser tab) and switches back here,
  // the visibilitychange / focus event triggers a force-refetch so the
  // gate reflects the fresh state without a manual page reload.
  useEffect(() => {
    const onFocus = () => {
      void fetchHealth(true);
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') onFocus();
    });
    return () => {
      window.removeEventListener('focus', onFocus);
    };
  }, [fetchHealth]);

  const currentAvailable = providers[provider]?.available === true;
  const currentLabel =
    PROVIDERS.find((p) => p.id === provider)?.label ?? provider;

  return (
    <div className="grid gap-1.5">
      <Label>{t('envManagement.modelEditor.providerLabel')}</Label>

      {/* Tab strip */}
      <div className="inline-flex items-center p-0.5 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] w-fit flex-wrap gap-0.5">
        {PROVIDERS.map((p) => {
          const active = p.id === provider;
          const row = providers[p.id];
          // While the probe is in-flight, leave everything enabled so
          // the user isn't blocked on a slow network — flip to
          // disabled only once we have a verdict.
          const available =
            !loaded ? true : row?.available === true;
          const isDisabled = !available;
          const tooltip = isDisabled
            ? t('envManagement.modelEditor.providerUnavailableTip', { provider: p.label })
            : undefined;

          return (
            <button
              key={p.id}
              type="button"
              onClick={() => {
                if (isDisabled) return;
                onProviderChange(p.id);
              }}
              disabled={isDisabled}
              title={tooltip}
              aria-disabled={isDisabled}
              className={`h-7 px-3 text-[0.75rem] font-medium rounded transition-colors inline-flex items-center gap-1.5 ${
                active
                  ? 'bg-[hsl(var(--primary)/0.12)] text-[hsl(var(--primary))]'
                  : isDisabled
                    ? 'text-[hsl(var(--muted-foreground))] opacity-40 cursor-not-allowed'
                    : 'text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]'
              }`}
            >
              {p.label}
              {isDisabled && (
                <span className="text-[0.6rem] uppercase tracking-wide font-semibold text-[hsl(var(--muted-foreground))] opacity-80">
                  · {t('envManagement.modelEditor.providerUnavailableBadge')}
                </span>
              )}
            </button>
          );
        })}
        {loading && !loaded && (
          <span className="inline-flex items-center gap-1 px-2 text-[0.6875rem] text-[hsl(var(--muted-foreground))]">
            <Loader2 className="w-3 h-3 animate-spin" />
            {t('envManagement.modelEditor.providerHealthLoading')}
          </span>
        )}
      </div>

      {/* Generic hint */}
      <p className="text-[0.6875rem] text-[hsl(var(--muted-foreground))]">
        {t('envManagement.modelEditor.providerHint')}
      </p>

      {/* Fetch error — informational, don't block the editor */}
      {error && (
        <p className="text-[0.6875rem] text-[hsl(var(--muted-foreground))]">
          {t('envManagement.modelEditor.providerHealthError', { error })}
        </p>
      )}

      {/* Current provider unavailable — surface a warning + CTA */}
      {loaded && !currentAvailable && (
        <div className="mt-1 px-3 py-2 rounded-md bg-[rgba(245,158,11,0.1)] border border-[rgba(245,158,11,0.3)] text-[0.75rem] text-[var(--warning-color)] flex items-start gap-2">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="leading-relaxed">
              {t('envManagement.modelEditor.providerCurrentUnavailable', {
                provider: currentLabel,
              })}
            </p>
            <a
              href="/?tab=settings&settings_category=llm_backends"
              target="_blank"
              rel="noreferrer"
              className="mt-1 inline-flex items-center gap-1 text-[0.6875rem] font-medium text-[var(--warning-color)] hover:underline"
            >
              {t('envManagement.modelEditor.providerOpenSettings')}
              <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        </div>
      )}
    </div>
  );
}


export default ModelConfigEditor;
