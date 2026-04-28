'use client';

/**
 * Stage20PersistEditor — curated editor for s20_persist.
 *
 * persister (no_persist / file) + frequency (every_turn /
 * every_n_turns / on_significant). Inline configs:
 *   file → base_dir
 *   every_n_turns → n
 *   on_significant → significant_events list + escalate_on_high_importance
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
  BoolRow,
  ChipList,
  InlinePanel,
  NumberRow,
  StringRow,
  TilePicker,
  readSlotConfig,
  type TileOption,
} from './_CuratedHelpers';

const PERSISTER_OPTIONS: TileOption[] = [
  { id: 'no_persist', titleKey: 'envManagement.stage20.persister.no_persist.title', descKey: 'envManagement.stage20.persister.no_persist.desc' },
  { id: 'file', titleKey: 'envManagement.stage20.persister.file.title', descKey: 'envManagement.stage20.persister.file.desc' },
];

const FREQ_OPTIONS: TileOption[] = [
  { id: 'every_turn', titleKey: 'envManagement.stage20.frequency.every_turn.title', descKey: 'envManagement.stage20.frequency.every_turn.desc' },
  { id: 'every_n_turns', titleKey: 'envManagement.stage20.frequency.every_n_turns.title', descKey: 'envManagement.stage20.frequency.every_n_turns.desc' },
  { id: 'on_significant', titleKey: 'envManagement.stage20.frequency.on_significant.title', descKey: 'envManagement.stage20.frequency.on_significant.desc' },
];

const DEFAULT_SIGNIFICANT_EVENTS = [
  'hitl.decision',
  'hitl.timeout',
  'tool_review.flag',
  'memory.insight_recorded',
  'summary.written',
  'task.failed',
];

interface Props {
  order: number;
  entry: StageManifestEntry;
}

export default function Stage20PersistEditor({ order, entry }: Props) {
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

  const persAvail = new Set(intro?.strategy_slots?.['persister']?.available_impls ?? PERSISTER_OPTIONS.map((o) => o.id));
  const freqAvail = new Set(intro?.strategy_slots?.['frequency']?.available_impls ?? FREQ_OPTIONS.map((o) => o.id));

  const currentPers = entry.strategies?.['persister'] ?? intro?.strategy_slots?.['persister']?.current_impl ?? 'no_persist';
  const currentFreq = entry.strategies?.['frequency'] ?? intro?.strategy_slots?.['frequency']?.current_impl ?? 'every_turn';

  const setSlot = (slot: string, id: string) =>
    patchStage(order, { strategies: { ...(entry.strategies ?? {}), [slot]: id } });

  const persConfig = readSlotConfig(entry, 'persister');
  const patchPersConfig = (next: Record<string, unknown>) =>
    patchStage(order, {
      strategy_configs: { ...(entry.strategy_configs ?? {}), persister: next },
    });

  const freqConfig = readSlotConfig(entry, 'frequency');
  const patchFreqConfig = (next: Record<string, unknown>) =>
    patchStage(order, {
      strategy_configs: { ...(entry.strategy_configs ?? {}), frequency: next },
    });

  return (
    <div className="flex flex-col gap-4">
      <TilePicker
        titleKey="envManagement.stage20.persisterTitle"
        helpId="stage20.persister"
        hintKey="envManagement.stage20.persisterHint"
        options={PERSISTER_OPTIONS}
        available={persAvail}
        current={currentPers}
        onPick={(id) => setSlot('persister', id)}
        cols={2}
      >
        {currentPers === 'file' && (
          <InlinePanel>
            <StringRow
              label={t('envManagement.stage20.config.file.baseDir')}
              hint={t('envManagement.stage20.config.file.baseDirHint')}
              value={(persConfig.base_dir as string | undefined) ?? '.geny/checkpoints'}
              placeholder=".geny/checkpoints"
              onChange={(v) => patchPersConfig({ ...persConfig, base_dir: v })}
            />
          </InlinePanel>
        )}
      </TilePicker>

      <TilePicker
        titleKey="envManagement.stage20.frequencyTitle"
        helpId="stage20.frequency"
        hintKey="envManagement.stage20.frequencyHint"
        options={FREQ_OPTIONS}
        available={freqAvail}
        current={currentFreq}
        onPick={(id) => setSlot('frequency', id)}
        cols={3}
      >
        {currentFreq === 'every_n_turns' && (
          <InlinePanel>
            <NumberRow
              label={t('envManagement.stage20.config.everyN.n')}
              hint={t('envManagement.stage20.config.everyN.nHint')}
              value={(freqConfig.n as number | undefined) ?? 5}
              min={1}
              onChange={(v) => patchFreqConfig({ ...freqConfig, n: v })}
            />
          </InlinePanel>
        )}
        {currentFreq === 'on_significant' && (
          <InlinePanel>
            <ChipList
              label={t('envManagement.stage20.config.significant.events')}
              hint={t('envManagement.stage20.config.significant.eventsHint')}
              items={
                Array.isArray(freqConfig.significant_events)
                  ? (freqConfig.significant_events as string[])
                  : DEFAULT_SIGNIFICANT_EVENTS
              }
              onChange={(next) => patchFreqConfig({ ...freqConfig, significant_events: next })}
              placeholder="event.type"
            />
            <BoolRow
              label={t('envManagement.stage20.config.significant.escalate')}
              hint={t('envManagement.stage20.config.significant.escalateHint')}
              value={freqConfig.escalate_on_high_importance !== false}
              onChange={(v) =>
                patchFreqConfig({ ...freqConfig, escalate_on_high_importance: v })
              }
            />
          </InlinePanel>
        )}
      </TilePicker>

    </div>
  );
}
