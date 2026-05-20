'use client';

/**
 * Stage06ApiEditor — curated editor for s06_api (the LLM caller).
 *
 * The single most-edited stage: pick the model + sampling. Hides the
 * raw artifact / strategy / config controls behind a "고급 설정"
 * disclosure since 99% of users only touch model_override.
 *
 * model_override semantics:
 *   - null → use pipeline.model (the default)
 *   - object → ModelConfig for THIS stage only; nullable per-key (any
 *     unset key falls back to pipeline.model for that key)
 *
 * Save flow: edits go straight to draft.stages[6].model_override via
 * patchStage(6, { model_override: ... }).
 */

import { useI18n } from '@/lib/i18n';
import { useEnvironmentDraftStore } from '@/store/useEnvironmentDraftStore';
import type { StageManifestEntry, StageModelOverride } from '@/types/environment';
import { ModelConfigEditor } from '@/components/builder/ModelConfigEditor';
import {
  MODEL_CATALOG,
  PROVIDER_DEFAULT_MODEL,
  inferProvider,
  parseProviderId,
  type ProviderId,
} from '@/lib/modelCatalog';
import { Switch } from '@/components/ui/switch';
import SectionHelpButton from '../section_help/SectionHelpButton';

interface Props {
  order: number;
  entry: StageManifestEntry;
}

export default function Stage06ApiEditor({ order, entry }: Props) {
  const { t } = useI18n();
  const draft = useEnvironmentDraftStore((s) => s.draft);
  const patchStage = useEnvironmentDraftStore((s) => s.patchStage);


  const overrideOn = entry.model_override !== null && entry.model_override !== undefined;
  const pipelineModel = (draft?.model ?? {}) as Record<string, unknown>;

  const toggleOverride = (next: boolean) => {
    if (next) {
      // Seed with the pipeline defaults so the user starts from
      // something that works rather than an empty form. They can
      // override any subset.
      patchStage(order, {
        model_override: { ...pipelineModel } as unknown as StageModelOverride,
      });
    } else {
      patchStage(order, { model_override: null });
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {/* ── Model override ── */}
      <section className="flex flex-col gap-3 p-3 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--card))]">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-[0.8125rem] font-semibold text-[hsl(var(--foreground))]">
                {t('envManagement.stage06.modelTitle')}
              </span>
              <SectionHelpButton helpId="stage06.modelOverride" />
            </div>
            <div className="text-[0.6875rem] text-[hsl(var(--muted-foreground))]">
              {overrideOn
                ? t('envManagement.stage06.overrideOnDesc')
                : t('envManagement.stage06.overrideOffDesc', {
                    model:
                      (pipelineModel.model as string | undefined) ??
                      '(default)',
                  })}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-[0.6875rem] text-[hsl(var(--muted-foreground))]">
              {overrideOn
                ? t('envManagement.stage06.overrideToggleOn')
                : t('envManagement.stage06.overrideToggleOff')}
            </span>
            <Switch checked={overrideOn} onCheckedChange={toggleOverride} />
          </div>
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
                // StageModelOverride has explicit fields (model: string?,
                // ...) plus a [key: string]: unknown index signature.
                // Record<string, unknown> only provides the index-sig view
                // of properties so TS can't prove e.g. `model` is a string.
                // Cast through unknown — the runtime shape matches the
                // executor's Dict[str, Any] contract.
                patchStage(order, {
                  model_override: next as unknown as StageModelOverride,
                });
              }}
              onClearError={() => {}}
              // Provider resolution priority:
              //   1. ``entry.config.provider`` — the canonical persisted
              //      choice (matches GlobalSettingsView's pattern). This
              //      is what makes Claude Code (CLI) selectable at all,
              //      since its default model ids (sonnet/opus/haiku)
              //      can't be uniquely inferred from the model name
              //      alone.
              //   2. ``inferProvider(model)`` — fallback for legacy
              //      manifests that predate the explicit config field.
              provider={
                parseProviderId(entry.config?.provider) ??
                inferProvider(
                  (entry.model_override?.model as string | undefined) ?? '',
                )
              }
              onProviderChange={(next: ProviderId) => {
                // Always persist the explicit choice — otherwise
                // inferProvider re-runs on the next render and the
                // selection silently reverts (the original bug:
                // picking Claude Code (CLI) snapped back to Anthropic
                // because "sonnet" prefix-matched to claude-*).
                const currentConfig = (entry.config ?? {}) as Record<string, unknown>;
                const currentOverride = (entry.model_override ?? {}) as Record<string, unknown>;
                const currentModel = (currentOverride.model as string | undefined) ?? '';
                // Keep the model in the new provider's catalog so the
                // dropdown shows a valid option. vLLM is free-form so
                // leave any user-typed id alone.
                let nextOverride = currentOverride;
                if (next !== 'vllm') {
                  const inCatalog = MODEL_CATALOG[next].some(
                    (o) => o.id === currentModel,
                  );
                  if (!inCatalog) {
                    nextOverride = {
                      ...currentOverride,
                      model: PROVIDER_DEFAULT_MODEL[next],
                    };
                  }
                }
                patchStage(order, {
                  config: { ...currentConfig, provider: next },
                  model_override: nextOverride as unknown as StageModelOverride,
                });
              }}
            />
          </div>
        )}

        {!overrideOn && (
          <div className="border-t border-[hsl(var(--border))] pt-3 text-[0.7rem] text-[hsl(var(--muted-foreground))]">
            {t('envManagement.stage06.useDefaultHint')}
          </div>
        )}
      </section>

    </div>
  );
}
