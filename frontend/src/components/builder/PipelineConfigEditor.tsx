'use client';

/**
 * PipelineConfigEditor — form panel for `manifest.pipeline` (a.k.a.
 * `PipelineConfig`). Mirrors the executor's `PipelineConfig` field
 * set, omitting the deploy-time secret (`api_key`) and the nested
 * `model` block (which has its own editor — `ModelConfigEditor`).
 *
 * Save semantics: shallow-merge against current values; only changed
 * keys are PATCHed. `Reset` reverts to the on-disk snapshot.
 *
 * Layout: this component is a pure form section that fills its
 * parent's width — containers (e.g. GlobalSettingsView) decide the
 * outer max-width.
 */

import { useEffect, useMemo, useState } from 'react';
import { Save, RotateCcw } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { ActionButton } from '@/components/layout';

export interface PipelineDraft {
  name: string;
  base_url: string;
  max_iterations: string;          // free-text → int
  cost_budget_usd: string;         // free-text → float
  context_window_budget: string;   // free-text → int
  stream: boolean;
  single_turn: boolean;
  artifacts: string;               // JSON textarea
  metadata: string;                // JSON textarea
}

export interface PipelineConfigEditorProps {
  initial: Record<string, unknown>;
  saving: boolean;
  error: string | null;
  onSave: (changes: Record<string, unknown>) => void;
  onClearError: () => void;
}

function snapshotToDraft(src: Record<string, unknown>): PipelineDraft {
  return {
    name: typeof src.name === 'string' ? src.name : '',
    base_url: typeof src.base_url === 'string' ? src.base_url : '',
    max_iterations:
      typeof src.max_iterations === 'number' ? String(src.max_iterations) : '',
    cost_budget_usd:
      typeof src.cost_budget_usd === 'number' ? String(src.cost_budget_usd) : '',
    context_window_budget:
      typeof src.context_window_budget === 'number'
        ? String(src.context_window_budget)
        : '',
    stream: typeof src.stream === 'boolean' ? src.stream : true,
    single_turn: typeof src.single_turn === 'boolean' ? src.single_turn : false,
    artifacts: src.artifacts ? JSON.stringify(src.artifacts, null, 2) : '',
    metadata: src.metadata ? JSON.stringify(src.metadata, null, 2) : '',
  };
}

function tryParseJsonObject(s: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const trimmed = s.trim();
  if (!trimmed) return { ok: true, value: {} };
  try {
    const v = JSON.parse(trimmed);
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      return { ok: false, error: 'must be a JSON object' };
    }
    return { ok: true, value: v as Record<string, unknown> };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'invalid JSON' };
  }
}

function buildChanges(
  initial: Record<string, unknown>,
  draft: PipelineDraft,
): { ok: true; changes: Record<string, unknown> } | { ok: false; error: string } {
  const out: Record<string, unknown> = {};

  if (draft.name && draft.name !== initial.name) out.name = draft.name;
  if (draft.base_url && draft.base_url !== initial.base_url) out.base_url = draft.base_url;

  for (const [key, raw] of Object.entries({
    max_iterations: draft.max_iterations,
    context_window_budget: draft.context_window_budget,
  })) {
    if (!raw.trim()) continue;
    const n = Number.parseInt(raw, 10);
    if (Number.isNaN(n) || n < 1) {
      return { ok: false, error: `${key}: must be a positive integer` };
    }
    if (n !== initial[key]) out[key] = n;
  }

  if (draft.cost_budget_usd.trim()) {
    const n = Number.parseFloat(draft.cost_budget_usd);
    if (Number.isNaN(n) || n < 0) {
      return { ok: false, error: 'cost_budget_usd: must be >= 0' };
    }
    if (n !== initial.cost_budget_usd) out.cost_budget_usd = n;
  }

  if (draft.stream !== initial.stream) out.stream = draft.stream;
  if (draft.single_turn !== initial.single_turn) out.single_turn = draft.single_turn;

  for (const [key, raw] of Object.entries({
    artifacts: draft.artifacts,
    metadata: draft.metadata,
  })) {
    const parsed = tryParseJsonObject(raw);
    if (!parsed.ok) {
      return { ok: false, error: `${key}: ${parsed.error}` };
    }
    const initJson = JSON.stringify(initial[key] ?? {});
    const newJson = JSON.stringify(parsed.value);
    if (initJson !== newJson) out[key] = parsed.value;
  }

  return { ok: true, changes: out };
}

export function PipelineConfigEditor({
  initial,
  saving,
  error,
  onSave,
  onClearError,
}: PipelineConfigEditorProps) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<PipelineDraft>(() => snapshotToDraft(initial));

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

  const update = <K extends keyof PipelineDraft>(key: K, value: PipelineDraft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    onClearError();
  };

  return (
    <section className="flex flex-col gap-4 w-full">
      <header className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-0.5 min-w-0">
          <h3 className="text-[1rem] font-semibold text-[hsl(var(--foreground))]">
            {t('envManagement.pipelineEditor.title')}
          </h3>
          <p className="text-[0.75rem] text-[hsl(var(--muted-foreground))] leading-relaxed">
            {t('envManagement.pipelineEditor.description')}
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

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="grid gap-1.5">
          <Label htmlFor="pl-name">
            {t('envManagement.pipelineEditor.name')}
          </Label>
          <Input
            id="pl-name"
            value={draft.name}
            onChange={(e) => update('name', e.target.value)}
            placeholder={t('envManagement.pipelineEditor.namePlaceholder')}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="pl-base-url">
            {t('envManagement.pipelineEditor.baseUrl')}
          </Label>
          <Input
            id="pl-base-url"
            value={draft.base_url}
            onChange={(e) => update('base_url', e.target.value)}
            placeholder={t('envManagement.pipelineEditor.baseUrlPlaceholder')}
            className="font-mono text-[0.75rem]"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="grid gap-1.5">
          <Label htmlFor="pl-max-iter">
            {t('envManagement.pipelineEditor.maxIterations')}{' '}
            <span className="opacity-60">
              ({t('envManagement.pipelineEditor.maxIterationsHint')})
            </span>
          </Label>
          <Input
            id="pl-max-iter"
            value={draft.max_iterations}
            onChange={(e) => update('max_iterations', e.target.value)}
            placeholder="50"
            inputMode="numeric"
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="pl-ctx">
            {t('envManagement.pipelineEditor.contextWindow')}{' '}
            <span className="opacity-60">
              ({t('envManagement.pipelineEditor.contextWindowHint')})
            </span>
          </Label>
          <Input
            id="pl-ctx"
            value={draft.context_window_budget}
            onChange={(e) => update('context_window_budget', e.target.value)}
            placeholder="200000"
            inputMode="numeric"
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="pl-cost">
            {t('envManagement.pipelineEditor.costBudget')}{' '}
            <span className="opacity-60">
              ({t('envManagement.pipelineEditor.costBudgetHint')})
            </span>
          </Label>
          <Input
            id="pl-cost"
            value={draft.cost_budget_usd}
            onChange={(e) => update('cost_budget_usd', e.target.value)}
            placeholder={t('envManagement.pipelineEditor.costBudgetPlaceholder')}
            inputMode="decimal"
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <label className="flex items-center gap-2 text-[0.8125rem] cursor-pointer">
          <Switch
            checked={draft.stream}
            onCheckedChange={(v) => update('stream', !!v)}
          />
          {t('envManagement.pipelineEditor.stream')}
          <span className="text-[hsl(var(--muted-foreground))] text-[0.6875rem]">
            ({t('envManagement.pipelineEditor.streamHint')})
          </span>
        </label>
        <label className="flex items-center gap-2 text-[0.8125rem] cursor-pointer">
          <Switch
            checked={draft.single_turn}
            onCheckedChange={(v) => update('single_turn', !!v)}
          />
          {t('envManagement.pipelineEditor.singleTurn')}
          <span className="text-[hsl(var(--muted-foreground))] text-[0.6875rem]">
            ({t('envManagement.pipelineEditor.singleTurnHint')})
          </span>
        </label>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="pl-artifacts">
          {t('envManagement.pipelineEditor.artifacts')}{' '}
          <span className="opacity-60">
            ({t('envManagement.pipelineEditor.artifactsHint')})
          </span>
        </Label>
        <Textarea
          id="pl-artifacts"
          value={draft.artifacts}
          onChange={(e) => update('artifacts', e.target.value)}
          rows={4}
          className="font-mono text-[0.75rem]"
          placeholder={'{\n  "evaluate": "adaptive"\n}'}
        />
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="pl-metadata">
          {t('envManagement.pipelineEditor.metadata')}{' '}
          <span className="opacity-60">
            ({t('envManagement.pipelineEditor.metadataHint')})
          </span>
        </Label>
        <Textarea
          id="pl-metadata"
          value={draft.metadata}
          onChange={(e) => update('metadata', e.target.value)}
          rows={4}
          className="font-mono text-[0.75rem]"
          placeholder="{}"
        />
      </div>
    </section>
  );
}

export default PipelineConfigEditor;
