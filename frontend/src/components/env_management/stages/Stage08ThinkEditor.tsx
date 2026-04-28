'use client';

/**
 * Stage08ThinkEditor — curated editor for s08_think.
 *
 * Two slot pickers: processor (passthrough / extract_and_store /
 * filter) + budget_planner (static / adaptive). Inline configs:
 *   filter → exclude_patterns (chip list)
 *   static → budget_tokens
 *   adaptive → base / min / max budgets, tools_bonus, reflection_bonus
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
import {
  ChipList,
  InlinePanel,
  NumberRow,
  TilePicker,
  readSlotConfig,
  type TileOption,
} from './_CuratedHelpers';

const PROCESSOR_OPTIONS: TileOption[] = [
  { id: 'passthrough', titleKey: 'envManagement.stage08.processor.passthrough.title', descKey: 'envManagement.stage08.processor.passthrough.desc' },
  { id: 'extract_and_store', titleKey: 'envManagement.stage08.processor.extract.title', descKey: 'envManagement.stage08.processor.extract.desc' },
  { id: 'filter', titleKey: 'envManagement.stage08.processor.filter.title', descKey: 'envManagement.stage08.processor.filter.desc' },
];

const BUDGET_OPTIONS: TileOption[] = [
  { id: 'static', titleKey: 'envManagement.stage08.budget.static.title', descKey: 'envManagement.stage08.budget.static.desc' },
  { id: 'adaptive', titleKey: 'envManagement.stage08.budget.adaptive.title', descKey: 'envManagement.stage08.budget.adaptive.desc' },
];

interface Props {
  order: number;
  entry: StageManifestEntry;
}

export default function Stage08ThinkEditor({ order, entry }: Props) {
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

  const procAvail = new Set(intro?.strategy_slots?.['processor']?.available_impls ?? PROCESSOR_OPTIONS.map((o) => o.id));
  const budAvail = new Set(intro?.strategy_slots?.['budget_planner']?.available_impls ?? BUDGET_OPTIONS.map((o) => o.id));

  const currentProc = entry.strategies?.['processor'] ?? intro?.strategy_slots?.['processor']?.current_impl ?? 'passthrough';
  const currentBud = entry.strategies?.['budget_planner'] ?? intro?.strategy_slots?.['budget_planner']?.current_impl ?? 'static';

  const setSlot = (slot: string, id: string) =>
    patchStage(order, { strategies: { ...(entry.strategies ?? {}), [slot]: id } });

  const procConfig = readSlotConfig(entry, 'processor');
  const patchProcConfig = (next: Record<string, unknown>) =>
    patchStage(order, {
      strategy_configs: { ...(entry.strategy_configs ?? {}), processor: next },
    });

  const budConfig = readSlotConfig(entry, 'budget_planner');
  const patchBudConfig = (next: Record<string, unknown>) =>
    patchStage(order, {
      strategy_configs: { ...(entry.strategy_configs ?? {}), budget_planner: next },
    });

  return (
    <div className="flex flex-col gap-4">
      <TilePicker
        titleKey="envManagement.stage08.processorTitle"
        hintKey="envManagement.stage08.processorHint"
        helpId="stage08.processor"
        options={PROCESSOR_OPTIONS}
        available={procAvail}
        current={currentProc}
        onPick={(id) => setSlot('processor', id)}
        cols={3}
      >
        {currentProc === 'filter' && (
          <InlinePanel>
            <ChipList
              label={t('envManagement.stage08.config.filter.excludePatterns')}
              hint={t('envManagement.stage08.config.filter.excludePatternsHint')}
              items={
                Array.isArray(procConfig.exclude_patterns)
                  ? (procConfig.exclude_patterns as string[])
                  : []
              }
              onChange={(next) => patchProcConfig({ ...procConfig, exclude_patterns: next })}
              placeholder={t('envManagement.stage08.config.filter.placeholder')}
            />
          </InlinePanel>
        )}
      </TilePicker>

      <TilePicker
        titleKey="envManagement.stage08.budgetTitle"
        hintKey="envManagement.stage08.budgetHint"
        helpId="stage08.budgetPlanner"
        options={BUDGET_OPTIONS}
        available={budAvail}
        current={currentBud}
        onPick={(id) => setSlot('budget_planner', id)}
        cols={2}
      >
        {currentBud === 'static' && (
          <InlinePanel>
            <NumberRow
              label={t('envManagement.stage08.config.static.budgetTokens')}
              hint={t('envManagement.stage08.config.static.budgetTokensHint')}
              value={(budConfig.budget_tokens as number | undefined) ?? 10_000}
              min={0}
              step={500}
              onChange={(v) => patchBudConfig({ ...budConfig, budget_tokens: v })}
            />
          </InlinePanel>
        )}
        {currentBud === 'adaptive' && (
          <InlinePanel>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <NumberRow
                label={t('envManagement.stage08.config.adaptive.base')}
                value={(budConfig.base_budget as number | undefined) ?? 4_000}
                min={0}
                step={500}
                onChange={(v) => patchBudConfig({ ...budConfig, base_budget: v })}
              />
              <NumberRow
                label={t('envManagement.stage08.config.adaptive.min')}
                value={(budConfig.min_budget as number | undefined) ?? 2_000}
                min={0}
                step={500}
                onChange={(v) => patchBudConfig({ ...budConfig, min_budget: v })}
              />
              <NumberRow
                label={t('envManagement.stage08.config.adaptive.max')}
                value={(budConfig.max_budget as number | undefined) ?? 24_000}
                min={0}
                step={500}
                onChange={(v) => patchBudConfig({ ...budConfig, max_budget: v })}
              />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <NumberRow
                label={t('envManagement.stage08.config.adaptive.toolsBonus')}
                hint={t('envManagement.stage08.config.adaptive.toolsBonusHint')}
                value={(budConfig.tools_bonus as number | undefined) ?? 4_000}
                min={0}
                step={500}
                onChange={(v) => patchBudConfig({ ...budConfig, tools_bonus: v })}
              />
              <NumberRow
                label={t('envManagement.stage08.config.adaptive.reflectionBonus')}
                hint={t('envManagement.stage08.config.adaptive.reflectionBonusHint')}
                value={(budConfig.reflection_bonus as number | undefined) ?? 4_000}
                min={0}
                step={500}
                onChange={(v) => patchBudConfig({ ...budConfig, reflection_bonus: v })}
              />
            </div>
          </InlinePanel>
        )}
      </TilePicker>

    </div>
  );
}
