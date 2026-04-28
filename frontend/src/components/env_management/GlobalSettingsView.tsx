'use client';

/**
 * GlobalSettingsView — body view for "stage 0" (env-wide globals).
 *
 * Lives in the same body slot as StageDetailView. Replaces the old
 * right-side GlobalSettingsDrawer: globals are now selectable from
 * the stage progress bar like any pipeline stage.
 *
 * Layout mirrors StageDetailView so the visual rhythm stays consistent
 * when the user clicks between stage 0 and stages 1..21.
 */

import { useState } from 'react';
import {
  Cpu,
  ExternalLink,
  Layers,
  Plug,
  Settings2,
  Shield,
  Sparkles,
  Wrench,
} from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { useTheme } from '@/lib/theme';
import { useAppStore } from '@/store/useAppStore';
import { useEnvironmentDraftStore } from '@/store/useEnvironmentDraftStore';
import { ModelConfigEditor } from '@/components/builder/ModelConfigEditor';
import { PipelineConfigEditor } from '@/components/builder/PipelineConfigEditor';
import {
  MODEL_CATALOG,
  PROVIDER_DEFAULT_MODEL,
  PROVIDERS,
  inferProvider,
  type ProviderId,
} from '@/lib/modelCatalog';
import ToolCheckboxGrid from './ToolCheckboxGrid';

const S06_API_ORDER = 6;

type Panel = 'model' | 'pipeline' | 'tools' | 'externals';

const HEADER_PALETTE = {
  light: {
    bg: 'rgb(237 233 254)',
    fg: 'rgb(91 33 182)',
    border: 'rgb(139 92 246)',
  },
  dark: {
    bg: 'rgb(76 29 149 / 0.45)',
    fg: 'rgb(196 181 253)',
    border: 'rgb(167 139 250)',
  },
} as const;

export default function GlobalSettingsView() {
  const { t } = useI18n();
  const { theme } = useTheme();
  const palette = HEADER_PALETTE[theme === 'dark' ? 'dark' : 'light'];
  const draft = useEnvironmentDraftStore((s) => s.draft);
  const patchModel = useEnvironmentDraftStore((s) => s.patchModel);
  const patchPipeline = useEnvironmentDraftStore((s) => s.patchPipeline);
  const patchTools = useEnvironmentDraftStore((s) => s.patchTools);
  const patchStage = useEnvironmentDraftStore((s) => s.patchStage);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const setEnvSubTab = useAppStore((s) => s.setEnvSubTab);

  const [panel, setPanel] = useState<Panel>('model');

  if (!draft) return null;

  const builtInCount = (draft.tools?.built_in ?? []).length;
  const mcpCount = (draft.tools?.mcp_servers ?? []).length;
  const adhocCount = (draft.tools?.adhoc ?? []).length;

  // ── Provider state ──
  // Source of truth is `manifest.stages[s06_api].config.provider`. When
  // that's unset we fall back to inferring from the model id prefix
  // (executor's `_infer_api_artifact` parity).
  const apiStage = draft.stages.find((s) => s.order === S06_API_ORDER);
  const apiConfig = (apiStage?.config ?? {}) as Record<string, unknown>;
  const explicitProvider =
    typeof apiConfig.provider === 'string' ? (apiConfig.provider as string) : '';
  const validIds: string[] = PROVIDERS.map((p) => p.id);
  const provider: ProviderId = (
    validIds.includes(explicitProvider)
      ? (explicitProvider as ProviderId)
      : inferProvider(draft.model?.model as string | undefined)
  );

  const handleProviderChange = (next: ProviderId) => {
    patchStage(S06_API_ORDER, { config: { ...apiConfig, provider: next } });
    // vLLM is free-form — leave whatever the user typed last alone.
    if (next === 'vllm') return;
    // If the current model already lives in the new provider's
    // catalog, keep it. Otherwise drop to the recommended default.
    const currentModel = (draft.model?.model as string | undefined) ?? '';
    const inCatalog = MODEL_CATALOG[next].some((o) => o.id === currentModel);
    if (!inCatalog) {
      patchModel({ model: PROVIDER_DEFAULT_MODEL[next] });
    }
  };

  const goToLibrary = (sub: string) => {
    setActiveTab('library');
    setEnvSubTab(sub);
  };

  return (
    <div className="flex-1 min-h-0 overflow-y-auto bg-[hsl(var(--background))]">
      <div className="max-w-[1300px] mx-auto p-6 flex flex-col gap-6">
        {/* ── Header ── */}
        <header className="flex items-center gap-3">
          <span
            className="inline-flex items-center justify-center w-12 h-12 rounded-full text-[1rem] font-bold tabular-nums shrink-0"
            style={{
              background: palette.bg,
              color: palette.fg,
              border: `2px solid ${palette.border}`,
              boxShadow: '0 1px 4px -1px rgb(139 92 246 / 0.18)',
            }}
          >
            <Settings2 className="w-5 h-5" />
          </span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-[1.125rem] font-semibold text-[hsl(var(--foreground))]">
                {t('envManagement.globalSectionTitle')}
              </h2>
              <span
                className="text-[0.625rem] uppercase tracking-wider px-1.5 py-0.5 rounded font-medium"
                style={{ background: palette.bg, color: palette.fg }}
              >
                {t('envManagement.compactBar.globalsLabel')}
              </span>
            </div>
            <p className="text-[0.8125rem] text-[hsl(var(--muted-foreground))] mt-1 leading-relaxed">
              {t('envManagement.globalSectionHint')}
            </p>
          </div>
        </header>

        {/* ── Sub-tab strip + body ── */}
        <div className="flex gap-4 min-h-0">
          <nav className="flex flex-col gap-0.5 w-44 shrink-0">
            <SubTabButton
              icon={Cpu}
              label={t('envManagement.global.model')}
              active={panel === 'model'}
              onClick={() => setPanel('model')}
            />
            <SubTabButton
              icon={Layers}
              label={t('envManagement.global.pipeline')}
              active={panel === 'pipeline'}
              onClick={() => setPanel('pipeline')}
            />
            <SubTabButton
              icon={Wrench}
              label={t('envManagement.global.tools')}
              active={panel === 'tools'}
              onClick={() => setPanel('tools')}
              badge={`${builtInCount + mcpCount + adhocCount}`}
            />
            <SubTabButton
              icon={ExternalLink}
              label={t('envManagement.global.externals')}
              active={panel === 'externals'}
              onClick={() => setPanel('externals')}
            />
          </nav>

          <div className="flex-1 min-w-0 p-4 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--card))]">
            {panel === 'model' && (
              <ModelConfigEditor
                initial={draft.model ?? {}}
                saving={false}
                error={null}
                onSave={(changes) => patchModel(changes)}
                onClearError={() => {}}
                provider={provider}
                onProviderChange={handleProviderChange}
              />
            )}
            {panel === 'pipeline' && (
              <PipelineConfigEditor
                initial={draft.pipeline ?? {}}
                saving={false}
                error={null}
                onSave={(changes) => patchPipeline(changes)}
                onClearError={() => {}}
              />
            )}
            {panel === 'tools' && (
              <div className="flex flex-col gap-3">
                <p className="text-[0.8125rem] text-[hsl(var(--muted-foreground))]">
                  {t('envManagement.global.toolsHint')}
                </p>
                <div className="grid grid-cols-3 gap-2">
                  <ToolStatCard
                    label={t('envManagement.global.builtInTools')}
                    count={builtInCount}
                  />
                  <ToolStatCard
                    label={t('envManagement.global.mcpServers')}
                    count={mcpCount}
                  />
                  <ToolStatCard
                    label={t('envManagement.global.customTools')}
                    count={adhocCount}
                  />
                </div>
                <ToolCheckboxGrid
                  value={(draft.tools?.built_in ?? []) as string[]}
                  onChange={(names) => patchTools({ built_in: names })}
                  mode="allowlist"
                  hint={t('envManagement.global.toolsPickerHint')}
                />
              </div>
            )}
            {panel === 'externals' && (
              <div className="flex flex-col gap-3">
                <p className="text-[0.8125rem] text-[hsl(var(--muted-foreground))]">
                  {t('envManagement.global.externalsHint')}
                </p>
                <div className="flex flex-col gap-2">
                  <ExternalLinkRow
                    icon={Plug}
                    label={t('tabs.hooks') ?? 'Hooks'}
                    description={t('envManagement.global.hooksDesc')}
                    onClick={() => goToLibrary('hooks')}
                  />
                  <ExternalLinkRow
                    icon={Shield}
                    label={t('tabs.permissions') ?? 'Permissions'}
                    description={t('envManagement.global.permissionsDesc')}
                    onClick={() => goToLibrary('permissions')}
                  />
                  <ExternalLinkRow
                    icon={Sparkles}
                    label={t('tabs.skills') ?? 'Skills'}
                    description={t('envManagement.global.skillsDesc')}
                    onClick={() => goToLibrary('skills')}
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function SubTabButton({
  icon: Icon,
  label,
  active,
  onClick,
  badge,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  active: boolean;
  onClick: () => void;
  badge?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-2 px-2.5 py-1.5 rounded-md text-[0.8125rem] text-left transition-colors ${
        active
          ? 'bg-[hsl(var(--accent))] text-[hsl(var(--foreground))] font-semibold'
          : 'text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))]/60 hover:text-[hsl(var(--foreground))]'
      }`}
    >
      <Icon className="w-3.5 h-3.5" />
      <span className="flex-1 truncate">{label}</span>
      {badge !== undefined && (
        <span className="text-[0.6875rem] tabular-nums text-[hsl(var(--muted-foreground))]">
          {badge}
        </span>
      )}
    </button>
  );
}

function ToolStatCard({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex flex-col gap-0.5 p-3 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))]">
      <span className="text-[0.6875rem] uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
        {label}
      </span>
      <span className="text-lg font-semibold tabular-nums text-[hsl(var(--foreground))]">
        {count}
      </span>
    </div>
  );
}

function ExternalLinkRow({
  icon: Icon,
  label,
  description,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-start gap-3 p-3 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] hover:bg-[hsl(var(--accent))] transition-colors text-left group"
    >
      <Icon className="w-4 h-4 text-[hsl(var(--primary))] mt-0.5 shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-[0.8125rem] font-medium text-[hsl(var(--foreground))]">
          {label}
        </div>
        <div className="text-[0.7rem] text-[hsl(var(--muted-foreground))] mt-0.5">
          {description}
        </div>
      </div>
      <ExternalLink className="w-3.5 h-3.5 text-[hsl(var(--muted-foreground))] group-hover:text-[hsl(var(--primary))] mt-0.5 shrink-0" />
    </button>
  );
}
