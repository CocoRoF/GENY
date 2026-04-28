'use client';

/**
 * SectionHelpModal — per-section deep-help modal.
 *
 * Width is generous (max-w-5xl, ~1024px) because the content is
 * naturally dense: per-impl description paragraphs, config tables
 * with manifest-key paths, bullet lists, code refs. Long paragraph
 * lines are still capped at ~75ch via max-w-prose so reading
 * doesn't sprawl across the full width.
 */

import { X } from 'lucide-react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { useI18n } from '@/lib/i18n';
import { getSectionHelp } from './content';
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
        <header className="flex items-start gap-4 px-8 pt-7 pb-5 border-b border-[hsl(var(--border))] shrink-0">
          <div className="flex-1 min-w-0">
            <div className="text-[0.625rem] uppercase tracking-[0.08em] font-semibold text-[hsl(var(--muted-foreground))]">
              {t('envManagement.sectionHelp.eyebrow')}
            </div>
            <h2 className="text-[1.375rem] font-semibold text-[hsl(var(--foreground))] mt-1.5 leading-tight">
              {content.title}
            </h2>
            <p className="text-[0.9375rem] text-[hsl(var(--muted-foreground))] mt-3 leading-7 max-w-[75ch]">
              {content.summary}
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
        <div className="flex-1 min-h-0 overflow-y-auto px-8 py-7 flex flex-col gap-9">
          {/* What it does */}
          <Block title={t('envManagement.sectionHelp.whatItDoes')}>
            <p className="text-[0.9375rem] text-[hsl(var(--foreground))] leading-7 whitespace-pre-line max-w-[75ch]">
              {content.whatItDoes}
            </p>
          </Block>

          {/* Stage-level config (if any) */}
          {content.configFields && content.configFields.length > 0 && (
            <Block title={t('envManagement.sectionHelp.sectionConfig')}>
              <ConfigTable fields={content.configFields} />
            </Block>
          )}

          {/* Per-option content */}
          {content.options.length > 0 && (
            <Block title={t('envManagement.sectionHelp.options')}>
              <div className="flex flex-col gap-5">
                {content.options.map((opt) => (
                  <OptionBlock key={opt.id} option={opt} />
                ))}
              </div>
            </Block>
          )}

          {/* Related sections */}
          {content.relatedSections && content.relatedSections.length > 0 && (
            <Block title={t('envManagement.sectionHelp.related')}>
              <ul className="flex flex-col gap-3 max-w-[80ch]">
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
      <h3 className="text-[0.6875rem] font-semibold uppercase tracking-[0.1em] text-[hsl(var(--muted-foreground))]">
        {title}
      </h3>
      {children}
    </section>
  );
}

function ConfigTable({ fields }: { fields: ConfigField[] }) {
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
    <div className="flex flex-col gap-2 p-4 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--card))]">
      {/* Top: friendly label */}
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
        <code className="font-mono text-[hsl(var(--foreground))] bg-[hsl(var(--accent))] px-1.5 py-0.5 rounded">
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

      {/* Description */}
      <p className="text-[0.875rem] text-[hsl(var(--muted-foreground))] leading-6 max-w-[75ch]">
        {field.description}
      </p>
    </div>
  );
}

function OptionBlock({ option }: { option: OptionContent }) {
  const { t } = useI18n();
  return (
    <article className="flex flex-col gap-4 p-5 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--card))]">
      <header className="flex items-baseline gap-2.5 flex-wrap">
        <h4 className="text-[1.0625rem] font-semibold text-[hsl(var(--foreground))]">
          {option.label}
        </h4>
        <code className="text-[0.75rem] font-mono text-[hsl(var(--muted-foreground))] bg-[hsl(var(--accent))] px-1.5 py-0.5 rounded">
          {option.id}
        </code>
      </header>

      <p className="text-[0.9375rem] text-[hsl(var(--foreground))] leading-7 whitespace-pre-line max-w-[75ch]">
        {option.description}
      </p>

      {/* Best-for / Avoid-when as a 2-up grid on wide modal */}
      {((option.bestFor.length > 0) || (option.avoidWhen && option.avoidWhen.length > 0)) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5 pt-1">
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
          <h5 className="text-[0.6875rem] font-semibold uppercase tracking-[0.1em] text-[hsl(var(--muted-foreground))]">
            {t('envManagement.sectionHelp.runtimeConfig')}
          </h5>
          <ConfigTable fields={option.config} />
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
        <div className="pt-2 border-t border-[hsl(var(--border))] text-[0.75rem]">
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
      <h5 className="text-[0.6875rem] font-semibold uppercase tracking-[0.1em] text-[hsl(var(--muted-foreground))]">
        {title}
      </h5>
      <ul className="flex flex-col gap-2">
        {items.map((it, idx) => (
          <li
            key={idx}
            className="flex items-start gap-2.5 text-[0.875rem] text-[hsl(var(--foreground))] leading-6"
          >
            <span
              className={`w-1.5 h-1.5 rounded-full mt-[0.5rem] shrink-0 ${dotColor}`}
            />
            <span className="max-w-[68ch]">{it}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RelatedRow({ item }: { item: RelatedSection }) {
  return (
    <li className="text-[0.875rem] leading-6">
      <span className="font-semibold text-[hsl(var(--foreground))]">
        {item.label}
      </span>
      <span className="text-[hsl(var(--muted-foreground))]"> — {item.body}</span>
    </li>
  );
}
