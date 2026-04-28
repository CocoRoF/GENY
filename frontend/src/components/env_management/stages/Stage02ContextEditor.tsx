'use client';

/**
 * Stage02ContextEditor — curated editor for s02_context.
 *
 * Three slot pickers (strategy / compactor / retriever) plus the
 * stage-level `stateless` toggle. When the picked impl exposes its
 * own runtime config (executor PR #157 added configure() to most of
 * them), an inline panel lights up so the user can tune the knob
 * without dropping into Advanced.
 */

import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { catalogApi } from '@/lib/environmentApi';
import { localizeIntrospection } from '../stage_locale';
import { useEnvironmentDraftStore } from '@/store/useEnvironmentDraftStore';
import type {
  StageIntrospection,
  StageManifestEntry,
} from '@/types/environment';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import StageGenericEditor from '../StageGenericEditor';

const STRATEGY_OPTIONS = [
  { id: 'simple_load', titleKey: 'envManagement.stage02.strategy.simple_load.title', descKey: 'envManagement.stage02.strategy.simple_load.desc' },
  { id: 'hybrid', titleKey: 'envManagement.stage02.strategy.hybrid.title', descKey: 'envManagement.stage02.strategy.hybrid.desc' },
  { id: 'progressive_disclosure', titleKey: 'envManagement.stage02.strategy.progressive_disclosure.title', descKey: 'envManagement.stage02.strategy.progressive_disclosure.desc' },
];

const COMPACTOR_OPTIONS = [
  { id: 'truncate', titleKey: 'envManagement.stage02.compactor.truncate.title', descKey: 'envManagement.stage02.compactor.truncate.desc' },
  { id: 'summary', titleKey: 'envManagement.stage02.compactor.summary.title', descKey: 'envManagement.stage02.compactor.summary.desc' },
  { id: 'sliding_window', titleKey: 'envManagement.stage02.compactor.sliding_window.title', descKey: 'envManagement.stage02.compactor.sliding_window.desc' },
];

const RETRIEVER_OPTIONS = [
  { id: 'null', titleKey: 'envManagement.stage02.retriever.null.title', descKey: 'envManagement.stage02.retriever.null.desc' },
  { id: 'static', titleKey: 'envManagement.stage02.retriever.static.title', descKey: 'envManagement.stage02.retriever.static.desc' },
];

interface Props {
  order: number;
  entry: StageManifestEntry;
}

export default function Stage02ContextEditor({ order, entry }: Props) {
  const { t } = useI18n();
  const locale = useI18n((s) => s.locale);
  const patchStage = useEnvironmentDraftStore((s) => s.patchStage);
  const [intro, setIntro] = useState<StageIntrospection | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);

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

  const availableStrategy = new Set(intro?.strategy_slots?.['strategy']?.available_impls ?? STRATEGY_OPTIONS.map((o) => o.id));
  const availableCompactor = new Set(intro?.strategy_slots?.['compactor']?.available_impls ?? COMPACTOR_OPTIONS.map((o) => o.id));
  const availableRetriever = new Set(intro?.strategy_slots?.['retriever']?.available_impls ?? RETRIEVER_OPTIONS.map((o) => o.id));

  const currentStrategy = entry.strategies?.['strategy'] ?? intro?.strategy_slots?.['strategy']?.current_impl ?? 'simple_load';
  const currentCompactor = entry.strategies?.['compactor'] ?? intro?.strategy_slots?.['compactor']?.current_impl ?? 'truncate';
  const currentRetriever = entry.strategies?.['retriever'] ?? intro?.strategy_slots?.['retriever']?.current_impl ?? 'null';

  const setSlot = (slot: string, id: string) =>
    patchStage(order, {
      strategies: { ...(entry.strategies ?? {}), [slot]: id },
    });

  const slotConfig = (slot: string) =>
    (entry.strategy_configs?.[slot] as Record<string, unknown> | undefined) ?? {};
  const patchSlotConfig = (slot: string, next: Record<string, unknown>) =>
    patchStage(order, {
      strategy_configs: { ...(entry.strategy_configs ?? {}), [slot]: next },
    });

  // stage.config — stateless
  const cfg = (entry.config as Record<string, unknown>) ?? {};
  const stateless = cfg.stateless === true;
  const setStateless = (v: boolean) => patchStage(order, { config: { ...cfg, stateless: v } });

  return (
    <div className="flex flex-col gap-4">
      {/* ── Stateless toggle (stage.config) ── */}
      <section className="flex items-center justify-between gap-3 p-3 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--card))]">
        <div className="min-w-0">
          <div className="text-[0.8125rem] font-semibold text-[hsl(var(--foreground))]">
            {t('envManagement.stage02.statelessTitle')}
          </div>
          <div className="text-[0.6875rem] text-[hsl(var(--muted-foreground))] mt-0.5">
            {t('envManagement.stage02.statelessDesc')}
          </div>
        </div>
        <Switch checked={stateless} onCheckedChange={setStateless} />
      </section>

      {/* ── Strategy ── */}
      <SlotSection
        titleKey="envManagement.stage02.strategyTitle"
        hintKey="envManagement.stage02.strategyHint"
        options={STRATEGY_OPTIONS}
        available={availableStrategy}
        current={currentStrategy}
        onPick={(id) => setSlot('strategy', id)}
        unavailableTitle={t('envManagement.stage02.unavailable')}
      >
        {currentStrategy === 'hybrid' && (
          <IntField
            label={t('envManagement.stage02.config.hybrid.maxRecentTurns')}
            hint={t('envManagement.stage02.config.hybrid.maxRecentTurnsHint')}
            value={(slotConfig('strategy').max_recent_turns as number | undefined) ?? 20}
            min={1}
            onChange={(n) => patchSlotConfig('strategy', { ...slotConfig('strategy'), max_recent_turns: n })}
          />
        )}
        {currentStrategy === 'progressive_disclosure' && (
          <IntField
            label={t('envManagement.stage02.config.progressive.summaryThreshold')}
            hint={t('envManagement.stage02.config.progressive.summaryThresholdHint')}
            value={(slotConfig('strategy').summary_threshold as number | undefined) ?? 10}
            min={1}
            onChange={(n) => patchSlotConfig('strategy', { ...slotConfig('strategy'), summary_threshold: n })}
          />
        )}
      </SlotSection>

      {/* ── Compactor ── */}
      <SlotSection
        titleKey="envManagement.stage02.compactorTitle"
        hintKey="envManagement.stage02.compactorHint"
        options={COMPACTOR_OPTIONS}
        available={availableCompactor}
        current={currentCompactor}
        onPick={(id) => setSlot('compactor', id)}
        unavailableTitle={t('envManagement.stage02.unavailable')}
      >
        {currentCompactor === 'truncate' && (
          <IntField
            label={t('envManagement.stage02.config.truncate.keepLast')}
            hint={t('envManagement.stage02.config.truncate.keepLastHint')}
            value={(slotConfig('compactor').keep_last as number | undefined) ?? 20}
            min={1}
            onChange={(n) => patchSlotConfig('compactor', { ...slotConfig('compactor'), keep_last: n })}
          />
        )}
        {currentCompactor === 'summary' && (
          <>
            <IntField
              label={t('envManagement.stage02.config.summary.keepRecent')}
              hint={t('envManagement.stage02.config.summary.keepRecentHint')}
              value={(slotConfig('compactor').keep_recent as number | undefined) ?? 10}
              min={1}
              onChange={(n) => patchSlotConfig('compactor', { ...slotConfig('compactor'), keep_recent: n })}
            />
            <TextareaField
              label={t('envManagement.stage02.config.summary.summaryText')}
              hint={t('envManagement.stage02.config.summary.summaryTextHint')}
              value={(slotConfig('compactor').summary_text as string | undefined) ?? ''}
              onChange={(v) => patchSlotConfig('compactor', { ...slotConfig('compactor'), summary_text: v })}
            />
          </>
        )}
        {currentCompactor === 'sliding_window' && (
          <IntField
            label={t('envManagement.stage02.config.slidingWindow.windowSize')}
            hint={t('envManagement.stage02.config.slidingWindow.windowSizeHint')}
            value={(slotConfig('compactor').window_size as number | undefined) ?? 30}
            min={1}
            onChange={(n) => patchSlotConfig('compactor', { ...slotConfig('compactor'), window_size: n })}
          />
        )}
      </SlotSection>

      {/* ── Retriever ── */}
      <SlotSection
        titleKey="envManagement.stage02.retrieverTitle"
        hintKey="envManagement.stage02.retrieverHint"
        options={RETRIEVER_OPTIONS}
        available={availableRetriever}
        current={currentRetriever}
        onPick={(id) => setSlot('retriever', id)}
        unavailableTitle={t('envManagement.stage02.unavailable')}
      />

      {/* ── Advanced ── */}
      <section className="rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--card))]">
        <button
          type="button"
          onClick={() => setAdvancedOpen((v) => !v)}
          className="w-full flex items-center gap-2 px-3 py-2 text-[0.8125rem] font-semibold text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))] transition-colors text-left"
        >
          {advancedOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          {t('envManagement.advancedTitle')}
          <span className="text-[0.6875rem] font-normal text-[hsl(var(--muted-foreground))]">
            {t('envManagement.advancedHintGeneric')}
          </span>
        </button>
        {advancedOpen && (
          <div className="px-3 pb-3 border-t border-[hsl(var(--border))] pt-3">
            <StageGenericEditor order={order} entry={entry} />
          </div>
        )}
      </section>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Reusable bits
// ─────────────────────────────────────────────────────────────────────

interface SlotOption {
  id: string;
  titleKey: string;
  descKey: string;
}

interface SlotSectionProps {
  titleKey: string;
  hintKey: string;
  options: SlotOption[];
  available: Set<string>;
  current: string;
  onPick: (id: string) => void;
  unavailableTitle: string;
  children?: React.ReactNode;
}

function SlotSection({
  titleKey,
  hintKey,
  options,
  available,
  current,
  onPick,
  unavailableTitle,
  children,
}: SlotSectionProps) {
  const { t } = useI18n();
  return (
    <section className="flex flex-col gap-2 p-3 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--card))]">
      <header className="flex items-center gap-2">
        <h4 className="text-[0.8125rem] font-semibold text-[hsl(var(--foreground))]">
          {t(titleKey)}
        </h4>
      </header>
      <p className="text-[0.7rem] text-[hsl(var(--muted-foreground))] leading-relaxed">
        {t(hintKey)}
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        {options.map((opt) => {
          const isAvailable = available.has(opt.id);
          const isActive = current === opt.id;
          return (
            <button
              key={opt.id}
              type="button"
              disabled={!isAvailable}
              onClick={() => onPick(opt.id)}
              className={`flex items-start gap-2 p-2.5 rounded-md border text-left transition-colors ${
                isActive
                  ? 'border-[hsl(var(--primary))] bg-[hsl(var(--primary)/0.08)]'
                  : 'border-[hsl(var(--border))] bg-[hsl(var(--background))] hover:bg-[hsl(var(--accent))]'
              } ${!isAvailable ? 'opacity-40 cursor-not-allowed' : ''}`}
              title={!isAvailable ? unavailableTitle : undefined}
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
      {children}
    </section>
  );
}

interface IntFieldProps {
  label: string;
  hint?: string;
  value: number;
  min?: number;
  max?: number;
  onChange: (v: number) => void;
}

function IntField({ label, hint, value, min, max, onChange }: IntFieldProps) {
  return (
    <div className="flex flex-col gap-1 pt-3 mt-1 border-t border-[hsl(var(--border))]">
      <label className="text-[0.75rem] font-medium text-[hsl(var(--foreground))]">{label}</label>
      {hint && (
        <p className="text-[0.6875rem] text-[hsl(var(--muted-foreground))]">{hint}</p>
      )}
      <Input
        type="number"
        value={String(value)}
        min={min}
        max={max}
        onChange={(e) => {
          const n = parseInt(e.target.value, 10);
          if (!isNaN(n)) onChange(n);
        }}
        className="h-7 text-[0.75rem] max-w-[180px] font-mono"
      />
    </div>
  );
}

interface TextareaFieldProps {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
}

function TextareaField({ label, hint, value, onChange }: TextareaFieldProps) {
  return (
    <div className="flex flex-col gap-1 pt-3 mt-1 border-t border-[hsl(var(--border))]">
      <label className="text-[0.75rem] font-medium text-[hsl(var(--foreground))]">{label}</label>
      {hint && (
        <p className="text-[0.6875rem] text-[hsl(var(--muted-foreground))]">{hint}</p>
      )}
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        className="text-[0.75rem] resize-y"
      />
    </div>
  );
}
