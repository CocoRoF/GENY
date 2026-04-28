'use client';

/**
 * Stage17EmitEditor — curated editor for s17_emit.
 *
 * One chain (`emitters`) of emitter impls (text / callback / vtuber /
 * tts). Chain runs in order; each emitter can be added, removed, or
 * reordered. None expose runtime config (callbacks/emotion handlers
 * are bound at the host side, not in the manifest).
 */

import { useEffect, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Plus,
  Trash2,
} from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { catalogApi } from '@/lib/environmentApi';
import { localizeIntrospection } from '../stage_locale';
import { useEnvironmentDraftStore } from '@/store/useEnvironmentDraftStore';
import type {
  StageIntrospection,
  StageManifestEntry,
} from '@/types/environment';
import SectionHelpButton from '../section_help/SectionHelpButton';

const EMITTER_META: Record<string, { titleKey: string; descKey: string }> = {
  text: { titleKey: 'envManagement.stage17.emit.text.title', descKey: 'envManagement.stage17.emit.text.desc' },
  callback: { titleKey: 'envManagement.stage17.emit.callback.title', descKey: 'envManagement.stage17.emit.callback.desc' },
  vtuber: { titleKey: 'envManagement.stage17.emit.vtuber.title', descKey: 'envManagement.stage17.emit.vtuber.desc' },
  tts: { titleKey: 'envManagement.stage17.emit.tts.title', descKey: 'envManagement.stage17.emit.tts.desc' },
};

interface Props {
  order: number;
  entry: StageManifestEntry;
}

export default function Stage17EmitEditor({ order, entry }: Props) {
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

  const chain = intro?.strategy_chains?.['emitters'];
  const availableEmitters = chain?.available_impls ?? Object.keys(EMITTER_META);
  const currentChain = entry.chain_order?.['emitters'] ?? chain?.current_impls ?? [];
  const remaining = availableEmitters.filter((id) => !currentChain.includes(id));

  const setChain = (next: string[]) =>
    patchStage(order, { chain_order: { ...(entry.chain_order ?? {}), emitters: next } });

  const move = (idx: number, delta: number) => {
    const target = idx + delta;
    if (target < 0 || target >= currentChain.length) return;
    const next = [...currentChain];
    [next[idx], next[target]] = [next[target], next[idx]];
    setChain(next);
  };
  const remove = (idx: number) => setChain(currentChain.filter((_, i) => i !== idx));
  const add = (id: string) => {
    if (!id || currentChain.includes(id)) return;
    setChain([...currentChain, id]);
  };

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-2 p-3 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--card))]">
        <header className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h4 className="text-[0.8125rem] font-semibold text-[hsl(var(--foreground))]">
              {t('envManagement.stage17.chainTitle')}
            </h4>
            <SectionHelpButton helpId="stage17.emitters" />
          </div>
          <span className="text-[0.625rem] text-[hsl(var(--muted-foreground))] tabular-nums">
            {currentChain.length} / {availableEmitters.length}
          </span>
        </header>
        <p className="text-[0.7rem] text-[hsl(var(--muted-foreground))] leading-relaxed">
          {t('envManagement.stage17.chainHint')}
        </p>

        {currentChain.length === 0 && (
          <p className="text-[0.7rem] italic text-[hsl(var(--muted-foreground))] py-2">
            {t('envManagement.stage17.empty')}
          </p>
        )}

        <ol className="flex flex-col gap-1.5">
          {currentChain.map((id, idx) => {
            const meta = EMITTER_META[id];
            return (
              <li
                key={`${id}-${idx}`}
                className="flex items-center gap-2 p-2 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))]"
              >
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
                  >
                    <ArrowUp className="w-3 h-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => move(idx, +1)}
                    disabled={idx === currentChain.length - 1}
                    className="w-6 h-6 inline-flex items-center justify-center rounded text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  >
                    <ArrowDown className="w-3 h-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(idx)}
                    className="w-6 h-6 inline-flex items-center justify-center rounded text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--destructive))] hover:bg-[hsl(var(--destructive)/0.1)] transition-colors"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
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
              <option value="">{t('envManagement.stage17.addPick')}</option>
              {remaining.map((id) => (
                <option key={id} value={id}>
                  {EMITTER_META[id] ? t(EMITTER_META[id].titleKey) : id}
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
