'use client';

/**
 * OverviewView — the canvas-first first-page view (cycle 20260427_2 PR-2).
 *
 * Two states:
 *   - draft === null  → RegistryPageShell + StartFromPicker (cycle
 *                       20260429 Phase 8.2: same chrome as the four
 *                       host-registry tabs so /environments reads
 *                       uniformly across all tabs)
 *   - draft !== null  → big PipelineCanvas + a "click any stage to
 *                       configure it" hint pill at the bottom
 *
 * Picking a stage on the canvas hands off to the parent's onSelectStage,
 * which switches the shell to the "stage" view mode.
 */

import { useEffect, useState } from 'react';
import { Layers, MousePointerClick } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { useEnvironmentDraftStore } from '@/store/useEnvironmentDraftStore';
import { environmentApi } from '@/lib/environmentApi';
import PipelineCanvas from '@/components/session-env/PipelineCanvas';
import StartFromPicker from './StartFromPicker';
import { RegistryPageShell } from './registry';

export interface OverviewViewProps {
  onSelectStage: (order: number) => void;
}

export default function OverviewView({ onSelectStage }: OverviewViewProps) {
  const { t } = useI18n();
  const draft = useEnvironmentDraftStore((s) => s.draft);
  const stageDirty = useEnvironmentDraftStore((s) => s.stageDirty);
  const newDraft = useEnvironmentDraftStore((s) => s.newDraft);
  const seeding = useEnvironmentDraftStore((s) => s.seeding);

  // Count of existing envs — surfaced in the shell's header chip
  // so the welcome page reads at the same density as the host
  // registry tabs ("3 servers loaded" / "21 hooks loaded" / etc.).
  const [envCount, setEnvCount] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [tick, setTick] = useState(0); // forces StartFromPicker remount on refresh

  useEffect(() => {
    let cancelled = false;
    environmentApi
      .list()
      .then((envs) => {
        if (!cancelled) setEnvCount(envs.length);
      })
      .catch(() => {
        if (!cancelled) setEnvCount(null);
      });
    return () => {
      cancelled = true;
    };
  }, [tick]);

  // ── Empty state — no draft yet
  if (!draft) {
    const handleAdd = async () => {
      try {
        await newDraft();
      } catch {
        /* error surfaces via store.error → CompactMetaBar banner */
      }
    };
    const handleRefresh = () => {
      setRefreshing(true);
      setTick((v) => v + 1);
      // The StartFromPicker re-fetches on remount; clear the
      // spinner after a short tick so the affordance reads as
      // "I clicked refresh" without flashing.
      setTimeout(() => setRefreshing(false), 400);
    };
    return (
      <RegistryPageShell
        icon={Layers}
        title={t('envManagement.welcomeTitle')}
        subtitle={t('envManagement.welcomeDescription')}
        countLabel={
          envCount !== null
            ? `${envCount}${t('envManagement.registry.countSuffix') || ''}개 환경`
            : undefined
        }
        addLabel={
          seeding ? t('envManagement.seeding') : t('envManagement.newDraft')
        }
        onAdd={handleAdd}
        onRefresh={handleRefresh}
        loading={seeding || refreshing}
      >
        <StartFromPicker key={tick} omitBlankRow />
      </RegistryPageShell>
    );
  }

  // ── Draft active — big canvas
  // The .stage-circle class + --pipe-* CSS variables are scoped under
  // .pipeline-scope in globals.css; without that wrapper the stage
  // nodes render as bare numbers + labels (no circles, no colour, no
  // grid). Mirror the wrapper used by SessionEnvironmentTab.
  return (
    <div className="pipeline-scope flex-1 min-h-0 flex flex-col bg-[hsl(var(--background))] relative">
      <PipelineCanvas
        stages={draft.stages}
        selectedOrder={null}
        onSelectStage={(order) => {
          if (order != null) onSelectStage(order);
        }}
        dirtyOrders={stageDirty}
        interactive={false}
      />
      {/* Bottom hint pill — gentle nudge that stages are clickable */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-[hsl(var(--card))]/95 backdrop-blur border border-[hsl(var(--border))] shadow-md text-[0.7rem] text-[hsl(var(--muted-foreground))] pointer-events-none">
        <MousePointerClick className="w-3 h-3 text-[hsl(var(--primary))]" />
        {t('envManagement.canvasHint')}
      </div>
    </div>
  );
}
