'use client';

/**
 * SectionHelpModal — per-section deep-help modal.
 *
 * Wide layout (max-w-5xl) so dense content can breathe; long prose
 * is still capped per-paragraph via the Prose component (~62ch) so
 * reading lines stay short. All long-form fields (summary,
 * whatItDoes, option.description, config.description, bullet items)
 * support a tiny markdown subset — see Prose.tsx.
 */

import { X } from 'lucide-react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { useI18n } from '@/lib/i18n';
import { getSectionHelp } from './content';
import { InlineMarkup, Prose } from './Prose';
import type {
  ConfigField,
  OptionContent,
  RelatedSection,
} from './types';

export interface SectionHelpModalProps {
  open: boolean;
  onClose: () => void;
  /** Help-content key (e.g., "stage01.validator"). */
  helpId: string | null;
}

export default function SectionHelpModal({
  open,
  onClose,
  helpId,
}: SectionHelpModalProps) {
  const { t } = useI18n();
  const locale = useI18n((s) => s.locale);

  if (!helpId) return null;
  const factory = getSectionHelp(helpId);
  if (!factory) return null;
  const content = factory(locale);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="max-w-5xl p-0 max-h-[90vh] flex flex-col gap-0">
        {/* ── Header ── */}
        <header className="flex items-start gap-4 px-8 pt-7 pb-6 border-b border-[hsl(var(--border))] shrink-0">
          <div className="flex-1 min-w-0">
            <div className="text-[0.625rem] uppercase tracking-[0.1em] font-semibold text-[hsl(var(--muted-foreground))]">
              {t('envManagement.sectionHelp.eyebrow')}
            </div>
            <h2 className="text-[1.5rem] font-semibold text-[hsl(var(--foreground))] mt-2 leading-tight">
              {content.title}
            </h2>
            <p className="text-[0.9375rem] text-[hsl(var(--muted-foreground))] mt-3.5 leading-7">
              <InlineMarkup text={content.summary} />
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center justify-center w-8 h-8 rounded-md text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))] transition-colors shrink-0"
            aria-label={t('common.close')}
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        {/* ── Body ── */}
        <div className="flex-1 min-h-0 overflow-y-auto px-8 py-8 flex flex-col gap-10">
          {/* What it does */}
          <Block title={t('envManagement.sectionHelp.whatItDoes')}>
            <Prose text={content.whatItDoes} />
          </Block>

          {/* Stage-level config (if any) */}
          {content.configFields && content.configFields.length > 0 && (
            <Block title={t('envManagement.sectionHelp.sectionConfig')}>
              <ConfigList fields={content.configFields} />
            </Block>
          )}

          {/* Per-option content */}
          {content.options.length > 0 && (
            <Block title={t('envManagement.sectionHelp.options')}>
              <div className="flex flex-col gap-6">
                {content.options.map((opt) => (
                  <OptionBlock key={opt.id} option={opt} />
                ))}
              </div>
            </Block>
          )}

          {/* Related sections */}
          {content.relatedSections && content.relatedSections.length > 0 && (
            <Block title={t('envManagement.sectionHelp.related')}>
              <ul className="flex flex-col gap-3.5">
                {content.relatedSections.map((rel, idx) => (
                  <RelatedRow key={idx} item={rel} />
                ))}
              </ul>
            </Block>
          )}

          {/* Code ref */}
          {content.codeRef && (
            <Block title={t('envManagement.sectionHelp.codeRef')}>
              <code className="text-[0.8125rem] font-mono text-[hsl(var(--muted-foreground))] break-all">
                {content.codeRef}
              </code>
            </Block>
          )}
        </div>

        {/* ── Footer ── */}
        <footer className="flex items-center justify-end gap-2 px-8 py-4 border-t border-[hsl(var(--border))] bg-[hsl(var(--card))] shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center gap-1.5 h-9 px-4 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] text-[0.8125rem] font-medium text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))] transition-colors"
          >
            {t('common.close')}
          </button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Building blocks
// ─────────────────────────────────────────────────────────────────────

function Block({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4">
      <h3 className="text-[0.6875rem] font-semibold uppercase tracking-[0.12em] text-[hsl(var(--muted-foreground))]">
        {title}
      </h3>
      {children}
    </section>
  );
}

function ConfigList({ fields }: { fields: ConfigField[] }) {
  return (
    <div className="flex flex-col gap-2.5">
      {fields.map((f) => (
        <ConfigRow key={f.name} field={f} />
      ))}
    </div>
  );
}

function ConfigRow({ field }: { field: ConfigField }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-2.5 p-4 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--card))]">
      {/* Top: friendly label + required pill */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[0.9375rem] font-semibold text-[hsl(var(--foreground))]">
          {field.label}
        </span>
        {field.required && (
          <span className="text-[0.625rem] uppercase tracking-[0.08em] font-semibold px-1.5 py-0.5 rounded text-[hsl(var(--destructive))] bg-[hsl(var(--destructive)/0.1)]">
            {t('common.required')}
          </span>
        )}
      </div>

      {/* Meta line: manifest key · type · default */}
      <div className="flex items-center gap-2 flex-wrap text-[0.75rem]">
        <code className="font-mono text-[hsl(var(--foreground))] bg-[hsl(var(--accent))] border border-[hsl(var(--border))] px-1.5 py-[0.0625rem] rounded">
          {field.name}
        </code>
        <span className="text-[hsl(var(--muted-foreground))]">·</span>
        <span className="text-[hsl(var(--muted-foreground))]">{field.type}</span>
        {field.default !== undefined && (
          <>
            <span className="text-[hsl(var(--muted-foreground))]">·</span>
            <span className="text-[hsl(var(--muted-foreground))]">
              {t('envManagement.sectionHelp.defaultIs', { v: field.default })}
            </span>
          </>
        )}
      </div>

      {/* Description (with markup) */}
      <div className="text-[0.875rem] text-[hsl(var(--muted-foreground))] leading-7">
        <InlineMarkup text={field.description} />
      </div>
    </div>
  );
}

function OptionBlock({ option }: { option: OptionContent }) {
  const { t } = useI18n();
  return (
    <article className="flex flex-col gap-5 p-6 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--card))]">
      <header className="flex items-baseline gap-3 flex-wrap">
        <h4 className="text-[1.125rem] font-semibold text-[hsl(var(--foreground))] leading-tight">
          {option.label}
        </h4>
        <code className="text-[0.75rem] font-mono text-[hsl(var(--muted-foreground))] bg-[hsl(var(--accent))] border border-[hsl(var(--border))] px-1.5 py-[0.0625rem] rounded">
          {option.id}
        </code>
      </header>

      <Prose text={option.description} />

      {/* Best-for / Avoid-when as a 2-up grid on wide modal */}
      {((option.bestFor.length > 0) ||
        (option.avoidWhen && option.avoidWhen.length > 0)) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-5 pt-1">
          {option.bestFor.length > 0 && (
            <BulletList
              title={t('envManagement.sectionHelp.bestFor')}
              tone="positive"
              items={option.bestFor}
            />
          )}
          {option.avoidWhen && option.avoidWhen.length > 0 && (
            <BulletList
              title={t('envManagement.sectionHelp.avoidWhen')}
              tone="warn"
              items={option.avoidWhen}
            />
          )}
        </div>
      )}

      {option.config && option.config.length > 0 && (
        <div className="flex flex-col gap-3 pt-1">
          <h5 className="text-[0.6875rem] font-semibold uppercase tracking-[0.12em] text-[hsl(var(--muted-foreground))]">
            {t('envManagement.sectionHelp.runtimeConfig')}
          </h5>
          <ConfigList fields={option.config} />
        </div>
      )}

      {option.gotchas && option.gotchas.length > 0 && (
        <BulletList
          title={t('envManagement.sectionHelp.gotchas')}
          tone="warn"
          items={option.gotchas}
        />
      )}

      {option.codeRef && (
        <div className="pt-3 border-t border-[hsl(var(--border))] text-[0.75rem]">
          <span className="text-[hsl(var(--muted-foreground))] font-medium mr-2">
            {t('envManagement.sectionHelp.codeRef')}
          </span>
          <code className="font-mono text-[hsl(var(--muted-foreground))] break-all">
            {option.codeRef}
          </code>
        </div>
      )}
    </article>
  );
}

function BulletList({
  title,
  tone,
  items,
}: {
  title: string;
  tone: 'positive' | 'warn';
  items: string[];
}) {
  const dotColor =
    tone === 'positive'
      ? 'bg-emerald-500 dark:bg-emerald-400'
      : 'bg-amber-500 dark:bg-amber-400';
  return (
    <div className="flex flex-col gap-2.5 min-w-0">
      <h5 className="text-[0.6875rem] font-semibold uppercase tracking-[0.12em] text-[hsl(var(--muted-foreground))]">
        {title}
      </h5>
      <ul className="flex flex-col gap-2.5">
        {items.map((it, idx) => (
          <li
            key={idx}
            className="flex items-start gap-2.5 text-[0.9375rem] leading-7 text-[hsl(var(--foreground))]"
          >
            <span
              className={`w-1.5 h-1.5 rounded-full mt-[0.625rem] shrink-0 ${dotColor}`}
            />
            <span>
              <InlineMarkup text={it} />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RelatedRow({ item }: { item: RelatedSection }) {
  return (
    <li className="text-[0.9375rem] leading-7">
      <span className="font-semibold text-[hsl(var(--foreground))]">
        {item.label}
      </span>
      <span className="text-[hsl(var(--muted-foreground))]">
        {' — '}
        <InlineMarkup text={item.body} />
      </span>
    </li>
  );
}
