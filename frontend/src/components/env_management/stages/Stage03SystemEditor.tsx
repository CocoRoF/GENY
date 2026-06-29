'use client';

/**
 * Stage03SystemEditor — curated editor for s03_system. THIS is where
 * the system prompt actually lives in the manifest (config.prompt
 * under the StaticPromptBuilder builder, or composable blocks under
 * ComposablePromptBuilder).
 *
 * The friendly textarea + starter-chip UX that originally landed in
 * Stage 1 belongs here — moved in cycle 20260427_3 once the
 * stage-1-vs-stage-3 contract was double-checked.
 */

import { useEffect, useState } from 'react';
import { useI18n, translate } from '@/lib/i18n';
import { catalogApi } from '@/lib/environmentApi';
import { localizeIntrospection } from '../stage_locale';
import { useEnvironmentDraftStore } from '@/store/useEnvironmentDraftStore';
import type {
  StageIntrospection,
  StageManifestEntry,
} from '@/types/environment';
import { Textarea } from '@/components/ui/textarea';
import SectionHelpButton from '../section_help/SectionHelpButton';

const STARTER_CHIPS = [
  { id: 'concise', textKey: 'envManagement.stage03.starters.concise' },
  { id: 'tools', textKey: 'envManagement.stage03.starters.tools' },
  { id: 'cite', textKey: 'envManagement.stage03.starters.cite' },
  { id: 'plan', textKey: 'envManagement.stage03.starters.plan' },
  { id: 'safety', textKey: 'envManagement.stage03.starters.safety' },
];

// Tile ids must match geny-executor's registered impl keys exactly.
// builder slot registry: static | composable | dynamic_persona.
// (Class names like "StaticPromptBuilder" are NOT what
// catalog.available_impls returns — using them silently disables
// every tile.)
const BUILDER_OPTIONS = [
  {
    id: 'static',
    titleKey: 'envManagement.stage03.builder.static.title',
    descKey: 'envManagement.stage03.builder.static.desc',
  },
  {
    id: 'composable',
    titleKey: 'envManagement.stage03.builder.composable.title',
    descKey: 'envManagement.stage03.builder.composable.desc',
  },
];

interface Props {
  order: number;
  entry: StageManifestEntry;
  // Curated editors render in basic mode; developer mode falls through
  // to StageGenericEditor. We still accept the prop so the prompt vs
  // builder-picker split is explicit (and future-proof if the curated
  // editor ever mounts in developer mode). Defaults to 'basic'.
  viewMode?: 'basic' | 'developer';
}

export default function Stage03SystemEditor({
  order,
  entry,
  viewMode = 'basic',
}: Props) {
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

  const availableBuilder = new Set(
    intro?.strategy_slots?.['builder']?.available_impls ??
      BUILDER_OPTIONS.map((o) => o.id),
  );
  const currentBuilder =
    entry.strategies?.['builder'] ??
    intro?.strategy_slots?.['builder']?.current_impl ??
    'static';

  const setBuilder = (id: string) =>
    patchStage(order, {
      strategies: { ...(entry.strategies ?? {}), builder: id },
    });

  const cfg = (entry.config as Record<string, unknown>) ?? {};
  const prompt =
    typeof cfg.prompt === 'string' ? (cfg.prompt as string) : '';
  const charCount = prompt.length;

  const setPrompt = (next: string) => {
    patchStage(order, { config: { ...cfg, prompt: next } });
  };

  const insertChip = (text: string) => {
    if (!prompt.trim()) {
      setPrompt(text);
      return;
    }
    const sep = prompt.endsWith('\n') ? '' : '\n';
    setPrompt(prompt + sep + text);
  };

  const isStatic = currentBuilder === 'static';
  const isBasic = viewMode === 'basic';

  return (
    <div className="flex flex-col gap-4">
      {/* ── Builder picker (developer/advanced concern only) ──
          In basic mode the user only sees the editable system prompt
          below; the static/composable/dynamic builder slot is an
          advanced knob, surfaced in developer mode (here, or via the
          generic StrategiesEditor when the curated editor is bypassed). */}
      {!isBasic && (
        <section className="flex flex-col gap-2 p-3 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--card))]">
          <header className="flex items-center gap-2">
            <h4 className="text-[0.8125rem] font-semibold text-[hsl(var(--foreground))]">
              {t('envManagement.stage03.builderTitle')}
            </h4>
            <SectionHelpButton helpId="stage03.builder" />
          </header>
          <p className="text-[0.7rem] text-[hsl(var(--muted-foreground))] leading-relaxed">
            {t('envManagement.stage03.builderHint')}
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {BUILDER_OPTIONS.map((opt) => {
              const available = availableBuilder.has(opt.id);
              const active = currentBuilder === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  disabled={!available}
                  onClick={() => setBuilder(opt.id)}
                  className={`flex items-start gap-2 p-2.5 rounded-md border text-left transition-colors ${
                    active
                      ? 'border-[hsl(var(--primary))] bg-[hsl(var(--primary)/0.08)]'
                      : 'border-[hsl(var(--border))] bg-[hsl(var(--background))] hover:bg-[hsl(var(--accent))]'
                  } ${!available ? 'opacity-40 cursor-not-allowed' : ''}`}
                  title={!available ? t('envManagement.stage03.unavailable') : undefined}
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
          {/* Composable also pulls in global persona blocks — one-line
              developer note, kept out of basic mode so it never hides
              the prompt textarea. */}
          {!isStatic && (
            <p className="text-[0.6875rem] text-[hsl(var(--muted-foreground))] leading-relaxed pt-1">
              {t('envManagement.stage03.composableDevNote')}
            </p>
          )}
        </section>
      )}

      {/* ── System prompt textarea ── shown in every mode for every
          builder. config.prompt is the effective per-env system prompt
          (the backend seeds it for presets and applies it at session
          build regardless of the selected builder). */}
      <section className="flex flex-col gap-2 p-3 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--card))]">
        <header className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h4 className="text-[0.8125rem] font-semibold text-[hsl(var(--foreground))]">
              {t('envManagement.stage03.systemPromptTitle')}
            </h4>
            <SectionHelpButton helpId="stage03.systemPrompt" />
          </div>
          <span className="text-[0.6875rem] text-[hsl(var(--muted-foreground))] tabular-nums">
            {t('envManagement.stage03.charCount', { n: String(charCount) })}
          </span>
        </header>
        <p className="text-[0.6875rem] text-[hsl(var(--muted-foreground))]">
          {t('envManagement.stage03.systemPromptBasicHint')}
        </p>
        <Textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={t('envManagement.stage03.systemPromptPlaceholder')}
          rows={10}
          className="font-mono text-[0.8125rem] leading-relaxed resize-y"
        />
        <p className="text-[0.6875rem] text-[hsl(var(--muted-foreground))]">
          {t('envManagement.stage03.systemPromptHint')}
        </p>

        <div className="flex flex-col gap-1.5 pt-2 border-t border-[hsl(var(--border))]">
          <div className="text-[0.6875rem] font-semibold uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
            {t('envManagement.stage03.startersTitle')}
          </div>
          <div className="flex flex-wrap gap-1">
            {STARTER_CHIPS.map((chip) => {
              // `label` is the localized chip caption/tooltip (visual only).
              // `value` is forced to the ENGLISH instruction text via the
              // explicit-locale `translate('en', …)` overload, so what gets
              // committed into stage.config.prompt — the text actually SENT
              // to the backend on every LLM call — is English regardless of
              // the selected UI locale. The persona replies in Korean via
              // the backend persona contract, not via a Korean default here.
              const label = t(chip.textKey);
              const value = translate('en', chip.textKey);
              return (
                <button
                  key={chip.id}
                  type="button"
                  onClick={() => insertChip(value)}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-full border border-dashed border-[hsl(var(--border))] text-[0.7rem] text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))] hover:text-[hsl(var(--foreground))] hover:border-[hsl(var(--primary))] transition-colors"
                  title={label}
                >
                  + {label.length > 32 ? label.slice(0, 32) + '…' : label}
                </button>
              );
            })}
          </div>
        </div>
      </section>
    </div>
  );
}
