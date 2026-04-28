'use client';

/**
 * Stage12AgentEditor — curated editor for s12_agent.
 *
 * One slot picker (orchestrator) plus the stage.config field
 * `max_delegations`.
 */

import { useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { catalogApi } from '@/lib/environmentApi';
import { localizeIntrospection } from '../stage_locale';
import { useEnvironmentDraftStore } from '@/store/useEnvironmentDraftStore';
import type {
  StageIntrospection,
  StageManifestEntry,
} from '@/types/environment';
import { Input } from '@/components/ui/input';
import { TilePicker, type TileOption } from './_CuratedHelpers';

const ORCHESTRATOR_OPTIONS: TileOption[] = [
  { id: 'single_agent', titleKey: 'envManagement.stage12.orch.single.title', descKey: 'envManagement.stage12.orch.single.desc' },
  { id: 'delegate', titleKey: 'envManagement.stage12.orch.delegate.title', descKey: 'envManagement.stage12.orch.delegate.desc' },
  { id: 'evaluator', titleKey: 'envManagement.stage12.orch.evaluator.title', descKey: 'envManagement.stage12.orch.evaluator.desc' },
  { id: 'subagent_type', titleKey: 'envManagement.stage12.orch.subagent.title', descKey: 'envManagement.stage12.orch.subagent.desc' },
];

interface Props {
  order: number;
  entry: StageManifestEntry;
}

export default function Stage12AgentEditor({ order, entry }: Props) {
  const { t } = useI18n();
  const locale = useI18n((s) => s.locale);
  const patchStage = useEnvironmentDraftStore((s) => s.patchStage);
  const [intro, setIntro] = useState<StageIntrospection | null>(null);

  useEffect(() => {
    let cancelled = false;
    catalogApi
      .stage(order)
      .then((res) => !cancelled && setIntro(localizeIntrospection(res, locale)))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [order, locale]);

  const available = new Set(intro?.strategy_slots?.['orchestrator']?.available_impls ?? ORCHESTRATOR_OPTIONS.map((o) => o.id));
  const current = entry.strategies?.['orchestrator'] ?? intro?.strategy_slots?.['orchestrator']?.current_impl ?? 'single_agent';
  const setSlot = (id: string) =>
    patchStage(order, { strategies: { ...(entry.strategies ?? {}), orchestrator: id } });

  const cfg = (entry.config as Record<string, unknown>) ?? {};
  const maxDelegations = typeof cfg.max_delegations === 'number' ? (cfg.max_delegations as number) : 4;
  const setMaxDelegations = (n: number) =>
    patchStage(order, { config: { ...cfg, max_delegations: n } });

  return (
    <div className="flex flex-col gap-4">
      <TilePicker
        titleKey="envManagement.stage12.orchTitle"
        hintKey="envManagement.stage12.orchHint"
        helpId="stage12.orchestrator"
        options={ORCHESTRATOR_OPTIONS}
        available={available}
        current={current}
        onPick={setSlot}
        cols={2}
      />

      <section className="flex flex-col gap-1 p-3 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--card))]">
        <label className="text-[0.8125rem] font-semibold text-[hsl(var(--foreground))]">
          {t('envManagement.stage12.maxDelegationsTitle')}
        </label>
        <p className="text-[0.6875rem] text-[hsl(var(--muted-foreground))]">
          {t('envManagement.stage12.maxDelegationsDesc')}
        </p>
        <Input
          type="number"
          min={0}
          value={String(maxDelegations)}
          onChange={(e) => {
            const n = parseInt(e.target.value, 10);
            if (!isNaN(n) && n >= 0) setMaxDelegations(n);
          }}
          className="h-7 text-[0.75rem] max-w-[120px] font-mono"
        />
      </section>

    </div>
  );
}
