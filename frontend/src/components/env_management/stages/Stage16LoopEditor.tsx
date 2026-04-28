'use client';

/**
 * Stage16LoopEditor — curated editor for s16_loop.
 *
 * One slot picker (controller) plus stage.config: max_turns +
 * early_stop_on (chip list of completion signals).
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
import {
  ChipList,
  TilePicker,
  type TileOption,
} from './_CuratedHelpers';

const CONTROLLER_OPTIONS: TileOption[] = [
  { id: 'standard', titleKey: 'envManagement.stage16.controller.standard.title', descKey: 'envManagement.stage16.controller.standard.desc' },
  { id: 'single_turn', titleKey: 'envManagement.stage16.controller.single_turn.title', descKey: 'envManagement.stage16.controller.single_turn.desc' },
  { id: 'budget_aware', titleKey: 'envManagement.stage16.controller.budget_aware.title', descKey: 'envManagement.stage16.controller.budget_aware.desc' },
  { id: 'multi_dim_budget', titleKey: 'envManagement.stage16.controller.multi_dim_budget.title', descKey: 'envManagement.stage16.controller.multi_dim_budget.desc' },
];

interface Props {
  order: number;
  entry: StageManifestEntry;
}

export default function Stage16LoopEditor({ order, entry }: Props) {
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

  const available = new Set(intro?.strategy_slots?.['controller']?.available_impls ?? CONTROLLER_OPTIONS.map((o) => o.id));
  const current = entry.strategies?.['controller'] ?? intro?.strategy_slots?.['controller']?.current_impl ?? 'standard';
  const setSlot = (id: string) =>
    patchStage(order, { strategies: { ...(entry.strategies ?? {}), controller: id } });

  const cfg = (entry.config as Record<string, unknown>) ?? {};
  const maxTurns = typeof cfg.max_turns === 'number' ? (cfg.max_turns as number) : 0;
  const earlyStop = Array.isArray(cfg.early_stop_on) ? (cfg.early_stop_on as string[]) : [];
  const setCfg = (next: Record<string, unknown>) =>
    patchStage(order, { config: { ...cfg, ...next } });

  return (
    <div className="flex flex-col gap-4">
      <TilePicker
        titleKey="envManagement.stage16.controllerTitle"
        hintKey="envManagement.stage16.controllerHint"
        helpId="stage16.controller"
        options={CONTROLLER_OPTIONS}
        available={available}
        current={current}
        onPick={setSlot}
        cols={2}
      />

      <section className="flex flex-col gap-3 p-3 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--card))]">
        <div className="flex flex-col gap-1">
          <label className="text-[0.8125rem] font-semibold text-[hsl(var(--foreground))]">
            {t('envManagement.stage16.maxTurnsTitle')}
          </label>
          <p className="text-[0.6875rem] text-[hsl(var(--muted-foreground))]">
            {t('envManagement.stage16.maxTurnsDesc')}
          </p>
          <Input
            type="number"
            min={0}
            value={String(maxTurns)}
            onChange={(e) => {
              const n = parseInt(e.target.value, 10);
              if (!isNaN(n) && n >= 0) setCfg({ max_turns: n });
            }}
            className="h-7 text-[0.75rem] max-w-[120px] font-mono"
          />
        </div>

        <div className="pt-3 border-t border-[hsl(var(--border))]">
          <ChipList
            label={t('envManagement.stage16.earlyStopTitle')}
            hint={t('envManagement.stage16.earlyStopDesc')}
            items={earlyStop}
            onChange={(next) => setCfg({ early_stop_on: next })}
            placeholder="COMPLETE / ERROR / BLOCKED ..."
          />
        </div>
      </section>

    </div>
  );
}
