'use client';

/**
 * SectionHelpModal — per-section deep-help modal.
 *
 * Same shell shape as StageInfoModal so visually it reads as a
 * smaller-scope sibling: Dialog primitive + scrollable body + close
 * footer. Content is data-driven from section_help/content/<file>.ts.
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
      <DialogContent className="max-w-2xl p-0 max-h-[90vh] flex flex-col gap-0">
        {/* ── Header ── */}
        <header className="flex items-start gap-3 px-5 pt-5 pb-4 border-b border-[hsl(var(--border))] shrink-0">
          <div className="flex-1 min-w-0">
            <div className="text-[0.625rem] uppercase tracking-wider font-semibold text-[hsl(var(--muted-foreground))]">
              {t('envManagement.sectionHelp.eyebrow')}
            </div>
            <h2 className="text-[1.0625rem] font-semibold text-[hsl(var(--foreground))] mt-0.5">
              {content.title}
            </h2>
            <p className="text-[0.8125rem] text-[hsl(var(--muted-foreground))] mt-1.5 leading-relaxed">
              {content.summary}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center justify-center w-8 h-8 rounded-md text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))] transition-colors shrink-0 -mt-1 -mr-1"
            aria-label={t('common.close')}
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        {/* ── Body ── */}
        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 flex flex-col gap-5">
          {/* What it does */}
          <Block title={t('envManagement.sectionHelp.whatItDoes')}>
            <p className="text-[0.8125rem] text-[hsl(var(--foreground))] leading-relaxed whitespace-pre-line">
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
              <div className="flex flex-col gap-3">
                {content.options.map((opt) => (
                  <OptionBlock key={opt.id} option={opt} />
                ))}
              </div>
            </Block>
          )}

          {/* Related sections */}
          {content.relatedSections && content.relatedSections.length > 0 && (
            <Block title={t('envManagement.sectionHelp.related')}>
              <ul className="flex flex-col gap-2">
                {content.relatedSections.map((rel, idx) => (
                  <RelatedRow key={idx} item={rel} />
                ))}
              </ul>
            </Block>
          )}

          {/* Code ref */}
          {content.codeRef && (
            <Block title={t('envManagement.sectionHelp.codeRef')}>
              <code className="text-[0.7rem] font-mono text-[hsl(var(--muted-foreground))] break-all">
                {content.codeRef}
              </code>
            </Block>
          )}
        </div>

        {/* ── Footer ── */}
        <footer className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[hsl(var(--border))] bg-[hsl(var(--card))] shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] text-[0.75rem] font-medium text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))] transition-colors"
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
    <section className="flex flex-col gap-2">
      <h3 className="text-[0.6875rem] font-semibold uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
        {title}
      </h3>
      {children}
    </section>
  );
}

function ConfigTable({ fields }: { fields: ConfigField[] }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-2">
      {fields.map((f) => (
        <div
          key={f.name}
          className="flex flex-col gap-1 p-2.5 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--card))]"
        >
          <div className="flex items-center gap-2 flex-wrap">
            <code className="text-[0.75rem] font-mono font-semibold text-[hsl(var(--foreground))]">
              {f.name}
            </code>
            <span className="text-[0.625rem] uppercase tracking-wider px-1.5 py-0.5 rounded bg-[hsl(var(--accent))] text-[hsl(var(--muted-foreground))]">
              {f.type}
            </span>
            {f.required && (
              <span className="text-[0.625rem] font-semibold text-[var(--danger-color)]">
                {t('common.required')}
              </span>
            )}
            {f.default !== undefined && (
              <span className="text-[0.625rem] text-[hsl(var(--muted-foreground))]">
                {t('envManagement.sectionHelp.defaultIs', { v: f.default })}
              </span>
            )}
          </div>
          <div className="text-[0.75rem] text-[hsl(var(--muted-foreground))] leading-relaxed">
            {f.description}
          </div>
          <div className="text-[0.6875rem] font-medium text-[hsl(var(--foreground))]">
            {f.label}
          </div>
        </div>
      ))}
    </div>
  );
}

function OptionBlock({ option }: { option: OptionContent }) {
  const { t } = useI18n();
  return (
    <article className="flex flex-col gap-2 p-3 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--card))]">
      <header className="flex items-center gap-2 flex-wrap">
        <h4 className="text-[0.875rem] font-semibold text-[hsl(var(--foreground))]">
          {option.label}
        </h4>
        <code className="text-[0.6875rem] font-mono text-[hsl(var(--muted-foreground))]">
          {option.id}
        </code>
      </header>
      <p className="text-[0.8125rem] text-[hsl(var(--foreground))] leading-relaxed whitespace-pre-line">
        {option.description}
      </p>

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

      {option.config && option.config.length > 0 && (
        <div className="pt-1">
          <h5 className="text-[0.6875rem] font-semibold uppercase tracking-wider text-[hsl(var(--muted-foreground))] mb-1.5">
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
        <div className="pt-1 text-[0.6875rem] text-[hsl(var(--muted-foreground))]">
          <span className="font-semibold mr-1">
            {t('envManagement.sectionHelp.codeRef')}:
          </span>
          <code className="font-mono break-all">{option.codeRef}</code>
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
    <div className="flex flex-col gap-1">
      <h5 className="text-[0.6875rem] font-semibold uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
        {title}
      </h5>
      <ul className="flex flex-col gap-1">
        {items.map((it, idx) => (
          <li
            key={idx}
            className="flex items-start gap-2 text-[0.8125rem] text-[hsl(var(--foreground))] leading-relaxed"
          >
            <span
              className={`w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 ${dotColor}`}
            />
            <span>{it}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RelatedRow({ item }: { item: RelatedSection }) {
  return (
    <li className="text-[0.8125rem] leading-relaxed">
      <span className="font-semibold text-[hsl(var(--foreground))]">
        {item.label}
      </span>
      <span className="text-[hsl(var(--muted-foreground))]"> — {item.body}</span>
    </li>
  );
}
