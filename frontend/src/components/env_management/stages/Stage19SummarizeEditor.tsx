'use client';

/**
 * Stage19SummarizeEditor — curated editor for s19_summarize.
 *
 * summarizer (no_summary / rule_based) + importance (fixed /
 * heuristic). rule_based has the bulk of the runtime knobs; fixed
 * exposes a single grade selector.
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
  ChipList,
  InlinePanel,
  NumberRow,
  TilePicker,
  readSlotConfig,
  type TileOption,
} from './_CuratedHelpers';

const SUMMARIZER_OPTIONS: TileOption[] = [
  { id: 'no_summary', titleKey: 'envManagement.stage19.summarizer.no_summary.title', descKey: 'envManagement.stage19.summarizer.no_summary.desc' },
  { id: 'rule_based', titleKey: 'envManagement.stage19.summarizer.rule_based.title', descKey: 'envManagement.stage19.summarizer.rule_based.desc' },
];

const IMPORTANCE_OPTIONS: TileOption[] = [
  { id: 'fixed', titleKey: 'envManagement.stage19.importance.fixed.title', descKey: 'envManagement.stage19.importance.fixed.desc' },
  { id: 'heuristic', titleKey: 'envManagement.stage19.importance.heuristic.title', descKey: 'envManagement.stage19.importance.heuristic.desc' },
];

const GRADE_VALUES = ['low', 'medium', 'high', 'critical'] as const;

interface Props {
  order: number;
  entry: StageManifestEntry;
}

export default function Stage19SummarizeEditor({ order, entry }: Props) {
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

  const sumAvail = new Set(intro?.strategy_slots?.['summarizer']?.available_impls ?? SUMMARIZER_OPTIONS.map((o) => o.id));
  const impAvail = new Set(intro?.strategy_slots?.['importance']?.available_impls ?? IMPORTANCE_OPTIONS.map((o) => o.id));

  const currentSum = entry.strategies?.['summarizer'] ?? intro?.strategy_slots?.['summarizer']?.current_impl ?? 'no_summary';
  const currentImp = entry.strategies?.['importance'] ?? intro?.strategy_slots?.['importance']?.current_impl ?? 'fixed';

  const setSlot = (slot: string, id: string) =>
    patchStage(order, { strategies: { ...(entry.strategies ?? {}), [slot]: id } });

  const sumConfig = readSlotConfig(entry, 'summarizer');
  const patchSumConfig = (next: Record<string, unknown>) =>
    patchStage(order, {
      strategy_configs: { ...(entry.strategy_configs ?? {}), summarizer: next },
    });

  const impConfig = readSlotConfig(entry, 'importance');
  const patchImpConfig = (next: Record<string, unknown>) =>
    patchStage(order, {
      strategy_configs: { ...(entry.strategy_configs ?? {}), importance: next },
    });

  const grade = (impConfig.grade as string | undefined) ?? 'medium';

  return (
    <div className="flex flex-col gap-4">
      <TilePicker
        titleKey="envManagement.stage19.summarizerTitle"
        hintKey="envManagement.stage19.summarizerHint"
        options={SUMMARIZER_OPTIONS}
        available={sumAvail}
        current={currentSum}
        onPick={(id) => setSlot('summarizer', id)}
        cols={2}
      >
        {currentSum === 'rule_based' && (
          <InlinePanel>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <NumberRow
                label={t('envManagement.stage19.config.rule.maxSentences')}
                value={(sumConfig.max_sentences as number | undefined) ?? 3}
                min={1}
                onChange={(v) => patchSumConfig({ ...sumConfig, max_sentences: v })}
              />
              <NumberRow
                label={t('envManagement.stage19.config.rule.maxFacts')}
                value={(sumConfig.max_facts as number | undefined) ?? 5}
                min={0}
                onChange={(v) => patchSumConfig({ ...sumConfig, max_facts: v })}
              />
              <NumberRow
                label={t('envManagement.stage19.config.rule.maxEntities')}
                value={(sumConfig.max_entities as number | undefined) ?? 8}
                min={0}
                onChange={(v) => patchSumConfig({ ...sumConfig, max_entities: v })}
              />
            </div>
            <ChipList
              label={t('envManagement.stage19.config.rule.extraTags')}
              hint={t('envManagement.stage19.config.rule.extraTagsHint')}
              items={Array.isArray(sumConfig.extra_tags) ? (sumConfig.extra_tags as string[]) : []}
              onChange={(next) => patchSumConfig({ ...sumConfig, extra_tags: next })}
              placeholder={t('envManagement.stage19.config.rule.extraTagsPlaceholder')}
            />
          </InlinePanel>
        )}
      </TilePicker>

      <TilePicker
        titleKey="envManagement.stage19.importanceTitle"
        hintKey="envManagement.stage19.importanceHint"
        options={IMPORTANCE_OPTIONS}
        available={impAvail}
        current={currentImp}
        onPick={(id) => setSlot('importance', id)}
        cols={2}
      >
        {currentImp === 'fixed' && (
          <InlinePanel>
            <div className="flex flex-col gap-1">
              <label className="text-[0.75rem] font-medium text-[hsl(var(--foreground))]">
                {t('envManagement.stage19.config.fixed.grade')}
              </label>
              <p className="text-[0.6875rem] text-[hsl(var(--muted-foreground))]">
                {t('envManagement.stage19.config.fixed.gradeHint')}
              </p>
              <div className="flex gap-1.5 flex-wrap">
                {GRADE_VALUES.map((g) => {
                  const isActive = grade === g;
                  return (
                    <button
                      key={g}
                      type="button"
                      onClick={() => patchImpConfig({ ...impConfig, grade: g })}
                      className={`h-7 px-3 rounded-md text-[0.7rem] font-medium uppercase tracking-wider transition-colors ${
                        isActive
                          ? 'border border-[hsl(var(--primary))] bg-[hsl(var(--primary)/0.1)] text-[hsl(var(--primary))]'
                          : 'border border-[hsl(var(--border))] bg-[hsl(var(--background))] text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))]'
                      }`}
                    >
                      {g}
                    </button>
                  );
                })}
              </div>
            </div>
          </InlinePanel>
        )}
      </TilePicker>

      <Advanced order={order} entry={entry} open={advancedOpen} onToggle={() => setAdvancedOpen((v) => !v)} />
    </div>
  );
}
