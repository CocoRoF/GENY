'use client';

/**
 * Stage21YieldEditor — curated editor for s21_yield.
 *
 * One slot picker (formatter). multi_format exposes the `formats`
 * subset (text/structured/markdown — toggle each on/off) plus an
 * include_thinking flag.
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
  BoolRow,
  InlinePanel,
  TilePicker,
  readSlotConfig,
  type TileOption,
} from './_CuratedHelpers';

const FORMATTER_OPTIONS: TileOption[] = [
  { id: 'default', titleKey: 'envManagement.stage21.formatter.default.title', descKey: 'envManagement.stage21.formatter.default.desc' },
  { id: 'structured', titleKey: 'envManagement.stage21.formatter.structured.title', descKey: 'envManagement.stage21.formatter.structured.desc' },
  { id: 'streaming', titleKey: 'envManagement.stage21.formatter.streaming.title', descKey: 'envManagement.stage21.formatter.streaming.desc' },
  { id: 'multi_format', titleKey: 'envManagement.stage21.formatter.multi_format.title', descKey: 'envManagement.stage21.formatter.multi_format.desc' },
];

const SUPPORTED_FORMATS = ['text', 'structured', 'markdown'] as const;
const DEFAULT_FORMATS = [...SUPPORTED_FORMATS];

interface Props {
  order: number;
  entry: StageManifestEntry;
}

export default function Stage21YieldEditor({ order, entry }: Props) {
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

  const available = new Set(intro?.strategy_slots?.['formatter']?.available_impls ?? FORMATTER_OPTIONS.map((o) => o.id));
  const current = entry.strategies?.['formatter'] ?? intro?.strategy_slots?.['formatter']?.current_impl ?? 'default';
  const setSlot = (id: string) =>
    patchStage(order, { strategies: { ...(entry.strategies ?? {}), formatter: id } });

  const fmtConfig = readSlotConfig(entry, 'formatter');
  const patchFmtConfig = (next: Record<string, unknown>) =>
    patchStage(order, {
      strategy_configs: { ...(entry.strategy_configs ?? {}), formatter: next },
    });

  const formats = (Array.isArray(fmtConfig.formats) ? (fmtConfig.formats as string[]) : DEFAULT_FORMATS)
    .filter((f) => SUPPORTED_FORMATS.includes(f as typeof SUPPORTED_FORMATS[number]));
  const includeThinking = fmtConfig.include_thinking === true;

  const toggleFormat = (f: string) => {
    const next = formats.includes(f)
      ? formats.filter((x) => x !== f)
      : [...formats, f];
    if (next.length === 0) return; // executor requires at least 1
    patchFmtConfig({ ...fmtConfig, formats: next });
  };

  return (
    <div className="flex flex-col gap-4">
      <TilePicker
        titleKey="envManagement.stage21.formatterTitle"
        helpId="stage21.formatter"
        hintKey="envManagement.stage21.formatterHint"
        options={FORMATTER_OPTIONS}
        available={available}
        current={current}
        onPick={setSlot}
        cols={2}
      >
        {current === 'multi_format' && (
          <InlinePanel>
            <div className="flex flex-col gap-1">
              <label className="text-[0.75rem] font-medium text-[hsl(var(--foreground))]">
                {t('envManagement.stage21.config.multi.formats')}
              </label>
              <p className="text-[0.6875rem] text-[hsl(var(--muted-foreground))]">
                {t('envManagement.stage21.config.multi.formatsHint')}
              </p>
              <div className="flex gap-1.5 flex-wrap">
                {SUPPORTED_FORMATS.map((f) => {
                  const isActive = formats.includes(f);
                  const isOnly = isActive && formats.length === 1;
                  return (
                    <button
                      key={f}
                      type="button"
                      onClick={() => toggleFormat(f)}
                      disabled={isOnly}
                      className={`h-7 px-3 rounded-md text-[0.7rem] font-medium uppercase tracking-wider transition-colors ${
                        isActive
                          ? 'border border-[hsl(var(--primary))] bg-[hsl(var(--primary)/0.1)] text-[hsl(var(--primary))]'
                          : 'border border-[hsl(var(--border))] bg-[hsl(var(--background))] text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))]'
                      } ${isOnly ? 'cursor-not-allowed opacity-70' : ''}`}
                      title={isOnly ? t('envManagement.stage21.config.multi.minOne') : undefined}
                    >
                      {f}
                    </button>
                  );
                })}
              </div>
            </div>
            <BoolRow
              label={t('envManagement.stage21.config.multi.includeThinking')}
              hint={t('envManagement.stage21.config.multi.includeThinkingHint')}
              value={includeThinking}
              onChange={(v) => patchFmtConfig({ ...fmtConfig, include_thinking: v })}
            />
          </InlinePanel>
        )}
      </TilePicker>

      <Advanced order={order} entry={entry} open={advancedOpen} onToggle={() => setAdvancedOpen((v) => !v)} />
    </div>
  );
}
