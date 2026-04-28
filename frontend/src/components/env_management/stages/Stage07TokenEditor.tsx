'use client';

/**
 * Stage07TokenEditor — curated editor for s07_token.
 *
 * tracker (default / detailed) + calculator (anthropic_pricing /
 * custom_pricing / unified_pricing). Only `custom_pricing` has
 * runtime-tunable knobs.
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
  Advanced,
  InlinePanel,
  NumberRow,
  TilePicker,
  readSlotConfig,
  type TileOption,
} from './_CuratedHelpers';

const TRACKER_OPTIONS: TileOption[] = [
  { id: 'default', titleKey: 'envManagement.stage07.tracker.default.title', descKey: 'envManagement.stage07.tracker.default.desc' },
  { id: 'detailed', titleKey: 'envManagement.stage07.tracker.detailed.title', descKey: 'envManagement.stage07.tracker.detailed.desc' },
];

const CALC_OPTIONS: TileOption[] = [
  { id: 'anthropic_pricing', titleKey: 'envManagement.stage07.calc.anthropic.title', descKey: 'envManagement.stage07.calc.anthropic.desc' },
  { id: 'custom_pricing', titleKey: 'envManagement.stage07.calc.custom.title', descKey: 'envManagement.stage07.calc.custom.desc' },
  { id: 'unified_pricing', titleKey: 'envManagement.stage07.calc.unified.title', descKey: 'envManagement.stage07.calc.unified.desc' },
];

interface Props {
  order: number;
  entry: StageManifestEntry;
}

export default function Stage07TokenEditor({ order, entry }: Props) {
  const { t } = useI18n();
  const locale = useI18n((s) => s.locale);
  const patchStage = useEnvironmentDraftStore((s) => s.patchStage);
  const [intro, setIntro] = useState<StageIntrospection | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);

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

  const trackerAvail = new Set(intro?.strategy_slots?.['tracker']?.available_impls ?? TRACKER_OPTIONS.map((o) => o.id));
  const calcAvail = new Set(intro?.strategy_slots?.['calculator']?.available_impls ?? CALC_OPTIONS.map((o) => o.id));

  const currentTracker = entry.strategies?.['tracker'] ?? intro?.strategy_slots?.['tracker']?.current_impl ?? 'default';
  const currentCalc = entry.strategies?.['calculator'] ?? intro?.strategy_slots?.['calculator']?.current_impl ?? 'anthropic_pricing';

  const setSlot = (slot: string, id: string) =>
    patchStage(order, { strategies: { ...(entry.strategies ?? {}), [slot]: id } });

  const calcConfig = readSlotConfig(entry, 'calculator');
  const patchCalcConfig = (next: Record<string, unknown>) =>
    patchStage(order, {
      strategy_configs: { ...(entry.strategy_configs ?? {}), calculator: next },
    });

  return (
    <div className="flex flex-col gap-4">
      <TilePicker
        titleKey="envManagement.stage07.trackerTitle"
        hintKey="envManagement.stage07.trackerHint"
        options={TRACKER_OPTIONS}
        available={trackerAvail}
        current={currentTracker}
        onPick={(id) => setSlot('tracker', id)}
        cols={2}
      />

      <TilePicker
        titleKey="envManagement.stage07.calcTitle"
        hintKey="envManagement.stage07.calcHint"
        options={CALC_OPTIONS}
        available={calcAvail}
        current={currentCalc}
        onPick={(id) => setSlot('calculator', id)}
        cols={3}
      >
        {currentCalc === 'custom_pricing' && (
          <InlinePanel>
            <NumberRow
              label={t('envManagement.stage07.config.custom.inputRate')}
              hint={t('envManagement.stage07.config.custom.inputRateHint')}
              value={(calcConfig.input_per_million as number | undefined) ?? 3.0}
              step={0.01}
              min={0}
              onChange={(v) => patchCalcConfig({ ...calcConfig, input_per_million: v })}
            />
            <NumberRow
              label={t('envManagement.stage07.config.custom.outputRate')}
              hint={t('envManagement.stage07.config.custom.outputRateHint')}
              value={(calcConfig.output_per_million as number | undefined) ?? 15.0}
              step={0.01}
              min={0}
              onChange={(v) => patchCalcConfig({ ...calcConfig, output_per_million: v })}
            />
          </InlinePanel>
        )}
      </TilePicker>

      <Advanced order={order} entry={entry} open={advancedOpen} onToggle={() => setAdvancedOpen((v) => !v)} />
    </div>
  );
}
