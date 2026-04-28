'use client';

/**
 * Stage05CacheEditor — curated editor for s05_cache.
 *
 * One slot picker (`strategy`) plus the stage-level `cache_prefix`
 * string. Cache strategy only matters for Anthropic models (executor's
 * _supports_cache_control gate).
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
import SectionHelpButton from '../section_help/SectionHelpButton';

const STRATEGY_OPTIONS = [
  {
    id: 'no_cache',
    titleKey: 'envManagement.stage05.strategy.no_cache.title',
    descKey: 'envManagement.stage05.strategy.no_cache.desc',
  },
  {
    id: 'system_cache',
    titleKey: 'envManagement.stage05.strategy.system_cache.title',
    descKey: 'envManagement.stage05.strategy.system_cache.desc',
  },
  {
    id: 'aggressive_cache',
    titleKey: 'envManagement.stage05.strategy.aggressive_cache.title',
    descKey: 'envManagement.stage05.strategy.aggressive_cache.desc',
  },
];

interface Props {
  order: number;
  entry: StageManifestEntry;
}

export default function Stage05CacheEditor({ order, entry }: Props) {
  const { t } = useI18n();
  const locale = useI18n((s) => s.locale);
  const patchStage = useEnvironmentDraftStore((s) => s.patchStage);
  const [intro, setIntro] = useState<StageIntrospection | null>(null);

  useEffect(() => {
    let cancelled = false;
    catalogApi
      .stage(order)
      .then((res) => {
        if (!cancelled) setIntro(localizeIntrospection(res, locale));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [order, locale]);

  const available = new Set(
    intro?.strategy_slots?.['strategy']?.available_impls ??
      STRATEGY_OPTIONS.map((o) => o.id),
  );
  const current =
    entry.strategies?.['strategy'] ??
    intro?.strategy_slots?.['strategy']?.current_impl ??
    'no_cache';

  const setStrategy = (id: string) =>
    patchStage(order, {
      strategies: { ...(entry.strategies ?? {}), strategy: id },
    });

  const slotConfig =
    (entry.strategy_configs?.['strategy'] as Record<string, unknown> | undefined) ??
    {};
  const patchSlotConfig = (next: Record<string, unknown>) =>
    patchStage(order, {
      strategy_configs: { ...(entry.strategy_configs ?? {}), strategy: next },
    });

  const cfg = (entry.config as Record<string, unknown>) ?? {};
  const cachePrefix = typeof cfg.cache_prefix === 'string' ? (cfg.cache_prefix as string) : '';
  const setCachePrefix = (v: string) =>
    patchStage(order, { config: { ...cfg, cache_prefix: v } });

  return (
    <div className="flex flex-col gap-4">
      {/* ── Strategy picker ── */}
      <section className="flex flex-col gap-2 p-3 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--card))]">
        <header className="flex items-center gap-2">
          <h4 className="text-[0.8125rem] font-semibold text-[hsl(var(--foreground))]">
            {t('envManagement.stage05.strategyTitle')}
          </h4>
          <SectionHelpButton helpId="stage05.strategy" />
        </header>
        <p className="text-[0.7rem] text-[hsl(var(--muted-foreground))] leading-relaxed">
          {t('envManagement.stage05.strategyHint')}
        </p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          {STRATEGY_OPTIONS.map((opt) => {
            const isAvailable = available.has(opt.id);
            const isActive = current === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                disabled={!isAvailable}
                onClick={() => setStrategy(opt.id)}
                className={`flex items-start gap-2 p-2.5 rounded-md border text-left transition-colors ${
                  isActive
                    ? 'border-[hsl(var(--primary))] bg-[hsl(var(--primary)/0.08)]'
                    : 'border-[hsl(var(--border))] bg-[hsl(var(--background))] hover:bg-[hsl(var(--accent))]'
                } ${!isAvailable ? 'opacity-40 cursor-not-allowed' : ''}`}
              >
                <div className="min-w-0">
                  <div className="text-[0.8125rem] font-medium text-[hsl(var(--foreground))]">
                    {t(opt.titleKey)}
                  </div>
                  <div className="text-[0.6875rem] text-[hsl(var(--muted-foreground))] mt-0.5">
                    {t(opt.descKey)}
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        {current === 'aggressive_cache' && (
          <div className="flex flex-col gap-1 pt-3 mt-1 border-t border-[hsl(var(--border))]">
            <label className="text-[0.75rem] font-medium text-[hsl(var(--foreground))]">
              {t('envManagement.stage05.config.aggressive.stableOffset')}
            </label>
            <p className="text-[0.6875rem] text-[hsl(var(--muted-foreground))]">
              {t('envManagement.stage05.config.aggressive.stableOffsetHint')}
            </p>
            <Input
              type="number"
              min={0}
              value={String((slotConfig.stable_history_offset as number | undefined) ?? 4)}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                if (!isNaN(n) && n >= 0)
                  patchSlotConfig({ ...slotConfig, stable_history_offset: n });
              }}
              className="h-7 text-[0.75rem] max-w-[160px] font-mono"
            />
          </div>
        )}

        <div className="flex flex-col gap-1 pt-3 mt-1 border-t border-[hsl(var(--border))]">
          <label className="text-[0.75rem] font-medium text-[hsl(var(--foreground))]">
            {t('envManagement.stage05.cachePrefixTitle')}
          </label>
          <p className="text-[0.6875rem] text-[hsl(var(--muted-foreground))]">
            {t('envManagement.stage05.cachePrefixDesc')}
          </p>
          <Input
            value={cachePrefix}
            onChange={(e) => setCachePrefix(e.target.value)}
            placeholder="agent:vtuber:"
            className="h-7 text-[0.75rem] max-w-[300px] font-mono"
          />
        </div>
      </section>

    </div>
  );
}
