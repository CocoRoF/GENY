'use client';

/**
 * GlobalSettingsView — body view for "stage 0" (env-wide globals).
 *
 * Lives in the same body slot as StageDetailView. Replaces the old
 * right-side GlobalSettingsDrawer: globals are now selectable from
 * the stage progress bar like any pipeline stage.
 *
 * Cycle 20260428 Phase 1 — restructured from 4 panels to 8, grouped
 * by scope:
 *
 *   Environment-scoped (lives in `manifest.*` — env-specific):
 *     1. 기본 모델 설정       → ModelConfigEditor
 *     2. 스테이지 기본 설정   → PipelineConfigEditor
 *     3. Executor Built-in    → ToolCheckboxGrid (manifest.tools.built_in)
 *     4. Geny Built-in        → GenyToolsPicker  (manifest.tools.external)
 *     5. MCP                  → env MCP-server count + Library link
 *
 *   Host-scoped (lives outside the manifest — shared across every
 *   environment, host-level files):
 *     6. 훅       → .geny/hooks.yaml
 *     7. 권한     → settings.json
 *     8. 스킬     → ~/.geny/skills + project skills/
 *
 * Phase 2 will add per-tab SectionHelpModal content. Phase 3 will
 * embed the host-level editors inline (extracted from HooksTab,
 * PermissionsTab, SkillsTab, MCPAdminPanel).
 */

import { useState } from 'react';
import {
  Cpu,
  ExternalLink,
  Layers,
  Network,
  Plug,
  Settings2,
  Shield,
  Sparkles,
  Wrench,
  Boxes,
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
import GenyToolsPicker from './GenyToolsPicker';
import HostScopedLinkPanel from './HostScopedLinkPanel';
import MCPServerEditor from './MCPServerEditor';
import SectionHelpButton from './section_help/SectionHelpButton';
import { HooksTab } from '@/components/tabs/HooksTab';
import { PermissionsTab } from '@/components/tabs/PermissionsTab';

const S06_API_ORDER = 6;

type Panel =
  | 'model'
  | 'pipeline'
  | 'executorTools'
  | 'genyTools'
  | 'mcp'
  | 'hooks'
  | 'permissions'
  | 'skills';

const PANEL_HELP_ID: Record<Panel, string> = {
  model: 'globals.model',
  pipeline: 'globals.pipeline',
  executorTools: 'globals.executorTools',
  genyTools: 'globals.genyTools',
  mcp: 'globals.mcp',
  hooks: 'globals.hooks',
  permissions: 'globals.permissions',
  skills: 'globals.skills',
};

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
  const genyCount = (draft.tools?.external ?? []).length;
  const mcpCount = (draft.tools?.mcp_servers ?? []).length;

  // ── Provider state ──
  const apiStage = draft.stages.find((s) => s.order === S06_API_ORDER);
  const apiConfig = (apiStage?.config ?? {}) as Record<string, unknown>;
  const explicitProvider =
    typeof apiConfig.provider === 'string' ? (apiConfig.provider as string) : '';
  const validIds: string[] = PROVIDERS.map((p) => p.id);
  const provider: ProviderId = validIds.includes(explicitProvider)
    ? (explicitProvider as ProviderId)
    : inferProvider(draft.model?.model as string | undefined);

  const handleProviderChange = (next: ProviderId) => {
    patchStage(S06_API_ORDER, { config: { ...apiConfig, provider: next } });
    if (next === 'vllm') return;
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
          <nav className="flex flex-col gap-0.5 w-52 shrink-0">
            <NavGroupLabel label={t('envManagement.globals.navGroupEnv')} />
            <SubTabButton
              icon={Cpu}
              label={t('envManagement.globals.navModel')}
              active={panel === 'model'}
              onClick={() => setPanel('model')}
            />
            <SubTabButton
              icon={Layers}
              label={t('envManagement.globals.navPipeline')}
              active={panel === 'pipeline'}
              onClick={() => setPanel('pipeline')}
            />
            <SubTabButton
              icon={Wrench}
              label={t('envManagement.globals.navExecutorTools')}
              active={panel === 'executorTools'}
              onClick={() => setPanel('executorTools')}
              badge={`${builtInCount}`}
            />
            <SubTabButton
              icon={Boxes}
              label={t('envManagement.globals.navGenyTools')}
              active={panel === 'genyTools'}
              onClick={() => setPanel('genyTools')}
              badge={`${genyCount}`}
            />
            <SubTabButton
              icon={Network}
              label={t('envManagement.globals.navMcp')}
              active={panel === 'mcp'}
              onClick={() => setPanel('mcp')}
              badge={`${mcpCount}`}
            />

            <NavGroupLabel
              label={t('envManagement.globals.navGroupHost')}
              className="mt-3"
            />
            <SubTabButton
              icon={Plug}
              label={t('envManagement.globals.navHooks')}
              active={panel === 'hooks'}
              onClick={() => setPanel('hooks')}
              hostBadge
            />
            <SubTabButton
              icon={Shield}
              label={t('envManagement.globals.navPermissions')}
              active={panel === 'permissions'}
              onClick={() => setPanel('permissions')}
              hostBadge
            />
            <SubTabButton
              icon={Sparkles}
              label={t('envManagement.globals.navSkills')}
              active={panel === 'skills'}
              onClick={() => setPanel('skills')}
              hostBadge
            />
          </nav>

          <div className="relative flex-1 min-w-0 p-4 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--card))]">
            <div className="absolute right-3 top-3 z-10">
              <SectionHelpButton helpId={PANEL_HELP_ID[panel]} />
            </div>
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

            {panel === 'executorTools' && (
              <div className="flex flex-col gap-4">
                <PanelHeader
                  title={t('envManagement.globals.executorTools.title')}
                  description={t(
                    'envManagement.globals.executorTools.description',
                  )}
                />
                <ToolCheckboxGrid
                  value={(draft.tools?.built_in ?? []) as string[]}
                  onChange={(names) => patchTools({ built_in: names })}
                  mode="allowlist"
                  hint={t('envManagement.global.toolsPickerHint')}
                />
              </div>
            )}

            {panel === 'genyTools' && (
              <div className="flex flex-col gap-4">
                <PanelHeader
                  title={t('envManagement.globals.genyTools.title')}
                  description={t('envManagement.globals.genyTools.description')}
                />
                <GenyToolsPicker
                  value={(draft.tools?.external ?? []) as string[]}
                  onChange={(names) => patchTools({ external: names })}
                />
              </div>
            )}

            {panel === 'mcp' && (
              <div className="flex flex-col gap-4">
                <PanelHeader
                  title={t('envManagement.globals.mcp.title')}
                  description={t('envManagement.globals.mcp.description')}
                />
                <MCPServerEditor
                  value={
                    (draft.tools?.mcp_servers ?? []) as Parameters<
                      typeof MCPServerEditor
                    >[0]['value']
                  }
                  onChange={(next) =>
                    patchTools({
                      mcp_servers: next as unknown as Array<
                        Record<string, unknown>
                      >,
                    })
                  }
                />
                <div className="pt-3 border-t border-[hsl(var(--border))] flex items-center justify-between gap-3">
                  <span className="text-[0.6875rem] text-[hsl(var(--muted-foreground))]">
                    {mcpCount === 0
                      ? t('envManagement.globals.mcp.envCountZero')
                      : t('envManagement.globals.mcp.envCount', {
                          n: String(mcpCount),
                        })}
                  </span>
                  <button
                    type="button"
                    onClick={() => goToLibrary('mcpServers')}
                    className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] text-[0.75rem] font-medium text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))] transition-colors"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    {t('envManagement.globals.mcp.manageLink')}
                  </button>
                </div>
              </div>
            )}

            {panel === 'hooks' && (
              <div className="flex flex-col gap-4">
                <PanelHeader
                  title={t('envManagement.globals.hooks.title')}
                  description={t('envManagement.globals.hooks.description')}
                />
                <HostBadge />
                <HooksTab embedded />
              </div>
            )}

            {panel === 'permissions' && (
              <div className="flex flex-col gap-4">
                <PanelHeader
                  title={t('envManagement.globals.permissions.title')}
                  description={t(
                    'envManagement.globals.permissions.description',
                  )}
                />
                <HostBadge />
                <PermissionsTab embedded />
              </div>
            )}

            {panel === 'skills' && (
              <HostScopedLinkPanel
                icon={Sparkles}
                title={t('envManagement.globals.skills.title')}
                description={t('envManagement.globals.skills.description')}
                primaryActionLabel={t(
                  'envManagement.globals.skills.manageLink',
                )}
                onPrimaryAction={() => goToLibrary('skills')}
              >
                <Bullets keyPath="envManagement.globals.skills.bullets" />
              </HostScopedLinkPanel>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function NavGroupLabel({
  label,
  className = '',
}: {
  label: string;
  className?: string;
}) {
  return (
    <div
      className={`px-2 pt-1 pb-1 text-[0.625rem] uppercase tracking-wider font-semibold text-[hsl(var(--muted-foreground))] ${className}`}
    >
      {label}
    </div>
  );
}

function SubTabButton({
  icon: Icon,
  label,
  active,
  onClick,
  badge,
  hostBadge,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  active: boolean;
  onClick: () => void;
  badge?: string;
  hostBadge?: boolean;
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
      <Icon className="w-3.5 h-3.5 shrink-0" />
      <span className="flex-1 truncate">{label}</span>
      {badge !== undefined && (
        <span className="text-[0.6875rem] tabular-nums text-[hsl(var(--muted-foreground))] shrink-0">
          {badge}
        </span>
      )}
      {hostBadge && (
        <ExternalLink className="w-3 h-3 text-[hsl(var(--muted-foreground))] shrink-0" />
      )}
    </button>
  );
}

function PanelHeader({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <h3 className="text-[0.9375rem] font-semibold text-[hsl(var(--foreground))]">
        {title}
      </h3>
      <p className="text-[0.75rem] text-[hsl(var(--muted-foreground))] leading-relaxed">
        {description}
      </p>
    </div>
  );
}

function HostBadge() {
  const { t } = useI18n();
  return (
    <div className="px-3 py-2 rounded-md bg-amber-500/10 border border-amber-500/30 text-[0.7rem] text-amber-800 dark:text-amber-300 leading-relaxed">
      <span className="font-semibold uppercase tracking-wider mr-2">
        {t('envManagement.globals.hostBadge')}
      </span>
      {t('envManagement.globals.hostBadgeNote')}
    </div>
  );
}

/** Bullet list rendered from an i18n key whose raw value is a string[]. */
function Bullets({ keyPath }: { keyPath: string }) {
  const { tRaw } = useI18n();
  const items = tRaw<string[] | undefined>(keyPath);
  if (!Array.isArray(items) || items.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1.5 pl-1">
      {items.map((b, i) => (
        <li
          key={i}
          className="flex items-start gap-2 text-[0.8125rem] text-[hsl(var(--foreground))]"
        >
          <span className="mt-2 w-1 h-1 rounded-full bg-[hsl(var(--muted-foreground))] shrink-0" />
          <span className="leading-relaxed">{b}</span>
        </li>
      ))}
    </ul>
  );
}
