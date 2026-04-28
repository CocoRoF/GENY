'use client';

/**
 * StageGenericEditor — the "Advanced" surface that every stage detail
 * view shares (curated stages embed it inside their <details>).
 *
 * Philosophy:
 *   - Show ALL editable manifest sections every time. Never hide a
 *     section just because the stage doesn't read it — instead mark
 *     it with a "이 단계 미사용" badge so power users still know the
 *     field exists and can fall through to a generic editor for any
 *     stage.
 *   - The Active toggle and Artifact picker are rendered by
 *     StageDetailView (header + first card) so they're not duplicated
 *     here.
 *
 * Sections rendered (always):
 *   1. Strategies (per-slot impl + impl_schemas)
 *   2. Chains (chain_order)
 *   3. Stage config (artifact's config_schema)
 *   4. Model override (raw editor)
 *   5. Tool binding (raw editor)
 *
 * Each section that doesn't apply to the current stage gets the
 * inactive badge but still renders read-only-ish content so the user
 * sees the empty shape.
 */

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { catalogApi } from '@/lib/environmentApi';
import { useI18n } from '@/lib/i18n';
import type {
  StageIntrospection,
  StageManifestEntry,
  StageModelOverride,
  StageToolBinding,
} from '@/types/environment';
import { useEnvironmentDraftStore } from '@/store/useEnvironmentDraftStore';
import { localizeIntrospection } from './stage_locale';
import {
  StrategiesEditor,
  ChainsEditor,
} from '@/components/environment/StrategyEditors';
import JsonSchemaForm, {
  type JsonSchema,
} from '@/components/environment/JsonSchemaForm';
import { ModelConfigEditor } from '@/components/builder/ModelConfigEditor';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';

interface Props {
  order: number;
  entry: StageManifestEntry;
}

export default function StageGenericEditor({ order, entry }: Props) {
  const { t } = useI18n();
  const locale = useI18n((s) => s.locale);
  const patchStage = useEnvironmentDraftStore((s) => s.patchStage);

  const [intro, setIntro] = useState<StageIntrospection | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const fetcher =
      entry.artifact && entry.artifact !== 'default'
        ? catalogApi.artifactByStage(order, entry.artifact)
        : catalogApi.stage(order);
    fetcher
      .then((res) => {
        if (cancelled) return;
        setIntro(localizeIntrospection(res, locale));
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [order, entry.artifact, locale]);

  const configSchema: JsonSchema | null = (intro?.config_schema as
    | JsonSchema
    | null
    | undefined) ?? null;

  const hasStrategies =
    !!intro && Object.keys(intro.strategy_slots).length > 0;
  const hasChains = !!intro && Object.keys(intro.strategy_chains).length > 0;
  const hasConfig = !!intro && !!configSchema;
  const supportsModelOverride = !!intro?.model_override_supported;
  const supportsToolBinding = !!intro?.tool_binding_supported;

  return (
    <div className="flex flex-col gap-4">
      {loading && (
        <div className="flex items-center gap-2 text-[0.75rem] text-[hsl(var(--muted-foreground))] p-3">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          {t('envManagement.loadingSchema')}
        </div>
      )}

      {error && (
        <div className="px-3 py-2 rounded-md bg-red-500/10 border border-red-500/30 text-[0.75rem] text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {/* ── Strategies ── */}
      <SectionHeader
        title={t('envManagement.stageStrategies')}
        applicable={hasStrategies}
      />
      {hasStrategies ? (
        <StrategiesEditor
          slots={intro!.strategy_slots}
          strategies={entry.strategies || {}}
          strategyConfigs={entry.strategy_configs || {}}
          onChangeStrategies={(next) =>
            patchStage(order, { strategies: next })
          }
          onChangeStrategyConfigs={(next) =>
            patchStage(order, { strategy_configs: next })
          }
        />
      ) : (
        <EmptyHint text={t('envManagement.advanced.noStrategies')} />
      )}

      {/* ── Chains ── */}
      <SectionHeader
        title={t('envManagement.stageChains')}
        applicable={hasChains}
      />
      {hasChains ? (
        <ChainsEditor
          chains={intro!.strategy_chains}
          chainOrder={entry.chain_order || {}}
          onChangeChainOrder={(next) =>
            patchStage(order, { chain_order: next })
          }
        />
      ) : (
        <EmptyHint text={t('envManagement.advanced.noChains')} />
      )}

      {/* ── Stage config ── */}
      <SectionHeader
        title={t('envManagement.stageConfig')}
        applicable={hasConfig}
      />
      {hasConfig ? (
        <div className="p-3 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--card))]">
          <JsonSchemaForm
            schema={configSchema!}
            value={entry.config || {}}
            onChange={(next) => patchStage(order, { config: next })}
          />
        </div>
      ) : (
        <EmptyHint text={t('envManagement.advanced.noConfig')} />
      )}

      {/* ── Model override ── */}
      <SectionHeader
        title={t('envManagement.modelOverrideTitle')}
        applicable={supportsModelOverride}
      />
      <ModelOverridePanel
        order={order}
        entry={entry}
        applicable={supportsModelOverride}
      />

      {/* ── Tool binding ── */}
      <SectionHeader
        title={t('envManagement.toolBindingTitle')}
        applicable={supportsToolBinding}
      />
      <ToolBindingPanel
        order={order}
        entry={entry}
        applicable={supportsToolBinding}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Section helpers
// ─────────────────────────────────────────────────────────────────────

function SectionHeader({
  title,
  applicable,
}: {
  title: string;
  applicable: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-2 mt-1">
      <h4 className="text-[0.75rem] font-semibold uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
        {title}
      </h4>
      {!applicable && (
        <span className="text-[0.625rem] uppercase tracking-wider px-1.5 py-0.5 rounded bg-[hsl(var(--accent))] text-[hsl(var(--muted-foreground))] border border-[hsl(var(--border))]">
          {t('envManagement.advanced.notApplicable')}
        </span>
      )}
    </div>
  );
}

function EmptyHint({ text }: { text: string }) {
  return (
    <p className="text-[0.7rem] text-[hsl(var(--muted-foreground))] italic px-1">
      {text}
    </p>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Model override
// ─────────────────────────────────────────────────────────────────────

function ModelOverridePanel({
  order,
  entry,
  applicable,
}: {
  order: number;
  entry: StageManifestEntry;
  applicable: boolean;
}) {
  const { t } = useI18n();
  const patchStage = useEnvironmentDraftStore((s) => s.patchStage);
  const overrideOn = !!entry.model_override;

  const toggleOverride = (next: boolean) => {
    if (next) {
      patchStage(order, {
        model_override: { ...(entry.model_override ?? {}) } as StageModelOverride,
      });
    } else {
      patchStage(order, { model_override: null });
    }
  };

  if (!applicable && !overrideOn) {
    return <EmptyHint text={t('envManagement.advanced.modelOverrideNA')} />;
  }

  return (
    <div className="flex flex-col gap-2 p-3 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--card))]">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[0.7rem] text-[hsl(var(--muted-foreground))] leading-relaxed min-w-0">
          {applicable
            ? t('envManagement.advanced.modelOverrideHint')
            : t('envManagement.advanced.modelOverrideNAEditing')}
        </div>
        <Switch checked={overrideOn} onCheckedChange={toggleOverride} />
      </div>
      {overrideOn && (
        <div className="border-t border-[hsl(var(--border))] pt-3">
          <ModelConfigEditor
            initial={(entry.model_override as Record<string, unknown>) ?? {}}
            saving={false}
            error={null}
            onSave={(changes) => {
              const next = {
                ...((entry.model_override as Record<string, unknown>) ?? {}),
                ...changes,
              };
              patchStage(order, {
                model_override: next as unknown as StageModelOverride,
              });
            }}
            onClearError={() => {}}
          />
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Tool binding (raw JSON for now — schema-aware editor can replace later)
// ─────────────────────────────────────────────────────────────────────

function ToolBindingPanel({
  order,
  entry,
  applicable,
}: {
  order: number;
  entry: StageManifestEntry;
  applicable: boolean;
}) {
  const { t } = useI18n();
  const patchStage = useEnvironmentDraftStore((s) => s.patchStage);
  const bindingOn = !!entry.tool_binding;

  const [text, setText] = useState(() =>
    entry.tool_binding ? JSON.stringify(entry.tool_binding, null, 2) : '',
  );
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setText(entry.tool_binding ? JSON.stringify(entry.tool_binding, null, 2) : '');
    setErr(null);
  }, [JSON.stringify(entry.tool_binding)]);

  const toggle = (next: boolean) => {
    if (next) {
      patchStage(order, {
        tool_binding: (entry.tool_binding ?? {
          allowed: null,
          blocked: null,
          extra_context: {},
        }) as StageToolBinding,
      });
    } else {
      patchStage(order, { tool_binding: null });
    }
  };

  const commit = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) {
      setErr(null);
      patchStage(order, {
        tool_binding: { allowed: null, blocked: null, extra_context: {} } as StageToolBinding,
      });
      return;
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        setErr(t('envManagement.advanced.toolBindingErrorObject'));
        return;
      }
      setErr(null);
      patchStage(order, { tool_binding: parsed as StageToolBinding });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  if (!applicable && !bindingOn) {
    return <EmptyHint text={t('envManagement.advanced.toolBindingNA')} />;
  }

  return (
    <div className="flex flex-col gap-2 p-3 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--card))]">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[0.7rem] text-[hsl(var(--muted-foreground))] leading-relaxed min-w-0">
          {applicable
            ? t('envManagement.advanced.toolBindingHint')
            : t('envManagement.advanced.toolBindingNAEditing')}
        </div>
        <Switch checked={bindingOn} onCheckedChange={toggle} />
      </div>
      {bindingOn && (
        <div className="border-t border-[hsl(var(--border))] pt-3 flex flex-col gap-1">
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={(e) => commit(e.target.value)}
            placeholder='{\n  "allowed": ["read_file", "write_file"],\n  "blocked": null,\n  "extra_context": null\n}'
            rows={6}
            className="font-mono text-[0.75rem] leading-relaxed resize-y"
            spellCheck={false}
          />
          {err && (
            <p className="text-[0.6875rem] text-red-600 dark:text-red-400">
              {err}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
