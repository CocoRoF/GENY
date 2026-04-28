'use client';

/**
 * Stage13TaskRegistryEditor — curated editor for s13_task_registry.
 *
 * Two slot pickers: registry (in_memory only) + policy
 * (fire_and_forget / eager_wait / timed_wait). timed_wait exposes a
 * runtime-tunable timeout_seconds; the `executor` callable on
 * eager_wait/timed_wait is a Python-side concern, so it stays in
 * Advanced.
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

const REGISTRY_OPTIONS: TileOption[] = [
  { id: 'in_memory', titleKey: 'envManagement.stage13.registry.in_memory.title', descKey: 'envManagement.stage13.registry.in_memory.desc' },
];

const POLICY_OPTIONS: TileOption[] = [
  { id: 'fire_and_forget', titleKey: 'envManagement.stage13.policy.fire.title', descKey: 'envManagement.stage13.policy.fire.desc' },
  { id: 'eager_wait', titleKey: 'envManagement.stage13.policy.eager.title', descKey: 'envManagement.stage13.policy.eager.desc' },
  { id: 'timed_wait', titleKey: 'envManagement.stage13.policy.timed.title', descKey: 'envManagement.stage13.policy.timed.desc' },
];

interface Props {
  order: number;
  entry: StageManifestEntry;
}

export default function Stage13TaskRegistryEditor({ order, entry }: Props) {
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

  const regAvail = new Set(intro?.strategy_slots?.['registry']?.available_impls ?? REGISTRY_OPTIONS.map((o) => o.id));
  const polAvail = new Set(intro?.strategy_slots?.['policy']?.available_impls ?? POLICY_OPTIONS.map((o) => o.id));
  const currentReg = entry.strategies?.['registry'] ?? intro?.strategy_slots?.['registry']?.current_impl ?? 'in_memory';
  const currentPol = entry.strategies?.['policy'] ?? intro?.strategy_slots?.['policy']?.current_impl ?? 'fire_and_forget';

  const setSlot = (slot: string, id: string) =>
    patchStage(order, { strategies: { ...(entry.strategies ?? {}), [slot]: id } });

  const polConfig = readSlotConfig(entry, 'policy');
  const patchPolConfig = (next: Record<string, unknown>) =>
    patchStage(order, {
      strategy_configs: { ...(entry.strategy_configs ?? {}), policy: next },
    });

  return (
    <div className="flex flex-col gap-4">
      <TilePicker
        titleKey="envManagement.stage13.registryTitle"
        hintKey="envManagement.stage13.registryHint"
        helpId="stage13.registry"
        options={REGISTRY_OPTIONS}
        available={regAvail}
        current={currentReg}
        onPick={(id) => setSlot('registry', id)}
        cols={1}
      />

      <TilePicker
        titleKey="envManagement.stage13.policyTitle"
        hintKey="envManagement.stage13.policyHint"
        helpId="stage13.policy"
        options={POLICY_OPTIONS}
        available={polAvail}
        current={currentPol}
        onPick={(id) => setSlot('policy', id)}
        cols={3}
      >
        {currentPol === 'timed_wait' && (
          <InlinePanel>
            <NumberRow
              label={t('envManagement.stage13.config.timed.timeoutSeconds')}
              hint={t('envManagement.stage13.config.timed.timeoutSecondsHint')}
              value={(polConfig.timeout_seconds as number | undefined) ?? 30}
              min={0}
              step={1}
              onChange={(v) => patchPolConfig({ ...polConfig, timeout_seconds: v })}
            />
          </InlinePanel>
        )}
      </TilePicker>

      <Advanced order={order} entry={entry} open={advancedOpen} onToggle={() => setAdvancedOpen((v) => !v)} />
    </div>
  );
}
