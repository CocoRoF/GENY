'use client';

/**
 * Stage04GuardEditor — curated editor for s04_guard.
 *
 * Stage 4 is a chain stage (no slots) with one chain: `guards`. Users
 * pick which guards to run, in what order, and tune each guard's
 * threshold inline. Stage-level controls: max_chain_length, fail_fast.
 */

import { useEffect, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
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
import SectionHelpButton from '../section_help/SectionHelpButton';

const GUARD_META: Record<
  string,
  { titleKey: string; descKey: string }
> = {
  token_budget: {
    titleKey: 'envManagement.stage04.guards.token_budget.title',
    descKey: 'envManagement.stage04.guards.token_budget.desc',
  },
  cost_budget: {
    titleKey: 'envManagement.stage04.guards.cost_budget.title',
    descKey: 'envManagement.stage04.guards.cost_budget.desc',
  },
  iteration: {
    titleKey: 'envManagement.stage04.guards.iteration.title',
    descKey: 'envManagement.stage04.guards.iteration.desc',
  },
  permission: {
    titleKey: 'envManagement.stage04.guards.permission.title',
    descKey: 'envManagement.stage04.guards.permission.desc',
  },
};

interface Props {
  order: number;
  entry: StageManifestEntry;
}

export default function Stage04GuardEditor({ order, entry }: Props) {
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

  const chain = intro?.strategy_chains?.['guards'];
  const availableGuards = chain?.available_impls ?? Object.keys(GUARD_META);
  const currentChain =
    entry.chain_order?.['guards'] ?? chain?.current_impls ?? [];
  const remaining = availableGuards.filter((g) => !currentChain.includes(g));

  const setChain = (next: string[]) =>
    patchStage(order, {
      chain_order: { ...(entry.chain_order ?? {}), guards: next },
    });

  const move = (idx: number, delta: number) => {
    const target = idx + delta;
    if (target < 0 || target >= currentChain.length) return;
    const next = [...currentChain];
    [next[idx], next[target]] = [next[target], next[idx]];
    setChain(next);
  };
  const remove = (idx: number) =>
    setChain(currentChain.filter((_, i) => i !== idx));
  const add = (id: string) => {
    if (!id || currentChain.includes(id)) return;
    setChain([...currentChain, id]);
  };

  // Per-guard config — stored under entry.strategy_configs[guard_name].
  // (Yes, strategy_configs is shared with slots; chain impls read the
  // same dict by their impl name.)
  const guardConfig = (id: string) =>
    (entry.strategy_configs?.[id] as Record<string, unknown> | undefined) ?? {};
  const patchGuardConfig = (id: string, next: Record<string, unknown>) =>
    patchStage(order, {
      strategy_configs: { ...(entry.strategy_configs ?? {}), [id]: next },
    });

  // Stage-level config
  const cfg = (entry.config as Record<string, unknown>) ?? {};
  const maxChainLength =
    typeof cfg.max_chain_length === 'number' ? (cfg.max_chain_length as number) : 32;
  const failFast = cfg.fail_fast !== false; // default true
  const setMaxChainLength = (n: number) =>
    patchStage(order, { config: { ...cfg, max_chain_length: n } });
  const setFailFast = (v: boolean) =>
    patchStage(order, { config: { ...cfg, fail_fast: v } });

  return (
    <div className="flex flex-col gap-4">
      {/* ── Stage config: fail_fast, max_chain_length ── */}
      <section className="flex flex-col gap-3 p-3 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--card))]">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[0.8125rem] font-semibold text-[hsl(var(--foreground))]">
                {t('envManagement.stage04.failFastTitle')}
              </span>
              <SectionHelpButton helpId="stage04.config" />
            </div>
            <div className="text-[0.6875rem] text-[hsl(var(--muted-foreground))] mt-0.5">
              {t('envManagement.stage04.failFastDesc')}
            </div>
          </div>
          <Switch checked={failFast} onCheckedChange={setFailFast} />
        </div>
        <div className="flex items-center justify-between gap-3 pt-2 border-t border-[hsl(var(--border))]">
          <div className="min-w-0">
            <div className="text-[0.8125rem] font-semibold text-[hsl(var(--foreground))]">
              {t('envManagement.stage04.maxChainLengthTitle')}
            </div>
            <div className="text-[0.6875rem] text-[hsl(var(--muted-foreground))] mt-0.5">
              {t('envManagement.stage04.maxChainLengthDesc')}
            </div>
          </div>
          <Input
            type="number"
            min={1}
            value={String(maxChainLength)}
            onChange={(e) => {
              const n = parseInt(e.target.value, 10);
              if (!isNaN(n) && n >= 1) setMaxChainLength(n);
            }}
            className="h-7 text-[0.75rem] w-[80px] font-mono shrink-0"
          />
        </div>
      </section>

      {/* ── Guard chain ── */}
      <section className="flex flex-col gap-2 p-3 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--card))]">
        <header className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h4 className="text-[0.8125rem] font-semibold text-[hsl(var(--foreground))]">
              {t('envManagement.stage04.chainTitle')}
            </h4>
            <SectionHelpButton helpId="stage04.chain" />
          </div>
          <span className="text-[0.625rem] text-[hsl(var(--muted-foreground))] tabular-nums">
            {currentChain.length} / {availableGuards.length}
          </span>
        </header>
        <p className="text-[0.7rem] text-[hsl(var(--muted-foreground))] leading-relaxed">
          {t('envManagement.stage04.chainHint')}
        </p>

        {currentChain.length === 0 && (
          <p className="text-[0.7rem] italic text-[hsl(var(--muted-foreground))] py-2">
            {t('envManagement.stage04.empty')}
          </p>
        )}

        <ol className="flex flex-col gap-2">
          {currentChain.map((id, idx) => {
            const meta = GUARD_META[id];
            return (
              <li
                key={`${id}-${idx}`}
                className="flex flex-col gap-2 p-2.5 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))]"
              >
                <div className="flex items-center gap-2">
                  <span className="text-[0.625rem] font-mono text-[hsl(var(--muted-foreground))] w-5 shrink-0 tabular-nums">
                    {idx + 1}.
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-[0.8125rem] font-medium text-[hsl(var(--foreground))]">
                      {meta ? t(meta.titleKey) : id}
                    </div>
                    {meta && (
                      <div className="text-[0.6875rem] text-[hsl(var(--muted-foreground))] mt-0.5">
                        {t(meta.descKey)}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-0.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => move(idx, -1)}
                      disabled={idx === 0}
                      className="w-6 h-6 inline-flex items-center justify-center rounded text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                      aria-label="up"
                    >
                      <ArrowUp className="w-3 h-3" />
                    </button>
                    <button
                      type="button"
                      onClick={() => move(idx, +1)}
                      disabled={idx === currentChain.length - 1}
                      className="w-6 h-6 inline-flex items-center justify-center rounded text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                      aria-label="down"
                    >
                      <ArrowDown className="w-3 h-3" />
                    </button>
                    <button
                      type="button"
                      onClick={() => remove(idx)}
                      className="w-6 h-6 inline-flex items-center justify-center rounded text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--destructive))] hover:bg-[hsl(var(--destructive)/0.1)] transition-colors"
                      aria-label={t('common.delete')}
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                </div>
                <GuardConfigInline
                  id={id}
                  config={guardConfig(id)}
                  onChange={(next) => patchGuardConfig(id, next)}
                />
              </li>
            );
          })}
        </ol>

        {remaining.length > 0 && (
          <div className="flex items-center gap-1.5 mt-1">
            <select
              value=""
              onChange={(e) => {
                add(e.target.value);
                e.target.value = '';
              }}
              className="h-7 px-2 rounded-md bg-[hsl(var(--background))] border border-[hsl(var(--border))] text-[0.75rem] focus:outline-none flex-1"
            >
              <option value="">
                {t('envManagement.stage04.addGuardPick')}
              </option>
              {remaining.map((id) => (
                <option key={id} value={id}>
                  {GUARD_META[id] ? t(GUARD_META[id].titleKey) : id}
                </option>
              ))}
            </select>
            <span className="text-[0.7rem] text-[hsl(var(--muted-foreground))] inline-flex items-center gap-1">
              <Plus className="w-3 h-3" />
              {t('common.add')}
            </span>
          </div>
        )}
      </section>

    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Per-guard inline config
// ─────────────────────────────────────────────────────────────────────

interface GuardConfigInlineProps {
  id: string;
  config: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}

function GuardConfigInline({ id, config, onChange }: GuardConfigInlineProps) {
  const { t } = useI18n();

  if (id === 'token_budget') {
    return (
      <InlineNumber
        label={t('envManagement.stage04.config.token_budget.minRemaining')}
        value={(config.min_remaining_tokens as number | undefined) ?? 10_000}
        min={0}
        step={1000}
        onChange={(n) => onChange({ ...config, min_remaining_tokens: n })}
      />
    );
  }
  if (id === 'cost_budget') {
    const v = config.max_cost_usd;
    return (
      <InlineNumber
        label={t('envManagement.stage04.config.cost_budget.maxCost')}
        value={typeof v === 'number' ? v : 0}
        min={0}
        step={0.01}
        nullable
        nulledLabel={t('envManagement.stage04.config.cost_budget.useSession')}
        onChange={(n) => onChange({ ...config, max_cost_usd: n })}
        onClear={() => onChange({ ...config, max_cost_usd: null })}
        isNull={v === null || v === undefined}
      />
    );
  }
  if (id === 'iteration') {
    const v = config.max_iterations;
    return (
      <InlineNumber
        label={t('envManagement.stage04.config.iteration.maxIterations')}
        value={typeof v === 'number' ? v : 0}
        min={1}
        nullable
        nulledLabel={t('envManagement.stage04.config.iteration.useSession')}
        onChange={(n) => onChange({ ...config, max_iterations: n })}
        onClear={() => onChange({ ...config, max_iterations: null })}
        isNull={v === null || v === undefined}
      />
    );
  }
  if (id === 'permission') {
    const allowed = Array.isArray(config.allowed_tools)
      ? (config.allowed_tools as string[])
      : [];
    const blocked = Array.isArray(config.blocked_tools)
      ? (config.blocked_tools as string[])
      : [];
    return (
      <div className="flex flex-col gap-2">
        <ChipList
          label={t('envManagement.stage04.config.permission.allowed')}
          hint={t('envManagement.stage04.config.permission.allowedHint')}
          items={allowed}
          onChange={(next) => onChange({ ...config, allowed_tools: next })}
          placeholder="tool_name"
        />
        <ChipList
          label={t('envManagement.stage04.config.permission.blocked')}
          hint={t('envManagement.stage04.config.permission.blockedHint')}
          items={blocked}
          onChange={(next) => onChange({ ...config, blocked_tools: next })}
          placeholder="tool_name"
        />
      </div>
    );
  }
  return null;
}

interface InlineNumberProps {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  nullable?: boolean;
  nulledLabel?: string;
  isNull?: boolean;
  onChange: (v: number) => void;
  onClear?: () => void;
}

function InlineNumber({
  label,
  value,
  min,
  max,
  step,
  nullable,
  nulledLabel,
  isNull,
  onChange,
  onClear,
}: InlineNumberProps) {
  return (
    <div className="flex flex-col gap-1 pt-2 border-t border-[hsl(var(--border))]">
      <label className="text-[0.7rem] font-medium text-[hsl(var(--muted-foreground))]">
        {label}
      </label>
      <div className="flex items-center gap-1.5">
        <Input
          type="number"
          value={isNull ? '' : String(value)}
          min={min}
          max={max}
          step={step}
          onChange={(e) => {
            const n = step && step < 1 ? parseFloat(e.target.value) : parseInt(e.target.value, 10);
            if (!isNaN(n)) onChange(n);
          }}
          placeholder={nullable && isNull ? nulledLabel : undefined}
          className="h-7 text-[0.75rem] max-w-[160px] font-mono"
        />
        {nullable && !isNull && onClear && (
          <button
            type="button"
            onClick={onClear}
            className="h-7 px-2 inline-flex items-center gap-1 rounded-md border border-dashed border-[hsl(var(--border))] text-[0.7rem] text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))] transition-colors"
          >
            <X className="w-3 h-3" />
          </button>
        )}
      </div>
    </div>
  );
}

interface ChipListProps {
  label: string;
  hint?: string;
  items: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
}

function ChipList({ label, hint, items, onChange, placeholder }: ChipListProps) {
  const { t } = useI18n();
  const [draft, setDraft] = useState('');
  const add = () => {
    const v = draft.trim();
    if (!v || items.includes(v)) {
      setDraft('');
      return;
    }
    onChange([...items, v]);
    setDraft('');
  };
  return (
    <div className="flex flex-col gap-1 pt-2 border-t border-[hsl(var(--border))]">
      <label className="text-[0.7rem] font-medium text-[hsl(var(--muted-foreground))]">
        {label}
      </label>
      {hint && (
        <p className="text-[0.65rem] text-[hsl(var(--muted-foreground))]">{hint}</p>
      )}
      {items.length > 0 && (
        <ul className="flex flex-wrap gap-1">
          {items.map((p, idx) => (
            <li
              key={`${p}-${idx}`}
              className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-md bg-[hsl(var(--accent))] border border-[hsl(var(--border))]"
            >
              <code className="text-[0.65rem] font-mono">{p}</code>
              <button
                type="button"
                onClick={() => onChange(items.filter((_, i) => i !== idx))}
                className="w-4 h-4 inline-flex items-center justify-center rounded hover:bg-[hsl(var(--destructive)/0.15)] text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--destructive))] transition-colors"
              >
                <X className="w-3 h-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-1.5">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          placeholder={placeholder}
          className="h-7 text-[0.75rem] flex-1"
        />
        <button
          type="button"
          onClick={add}
          disabled={!draft.trim()}
          className="h-7 px-2 inline-flex items-center gap-1 rounded-md border border-[hsl(var(--border))] text-[0.7rem] hover:bg-[hsl(var(--accent))] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          <Plus className="w-3 h-3" />
          {t('common.add')}
        </button>
      </div>
    </div>
  );
}
