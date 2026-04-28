'use client';

/**
 * ToolDetailModal — per-tool deep walkthrough.
 *
 * Two layers:
 *   - Always-on: name + family/category badge + localised summary +
 *     parameter table + capability chips (executor tools only). Pulled
 *     from the catalog API response that the parent picker already
 *     loaded.
 *   - Optional registered content (`tool_help/registry.ts`): longer
 *     walkthrough body, best-for / avoid-when / gotcha bullets,
 *     example invocations, related tools / stages, source pointer.
 *
 * Tools with no registered content still get the basics, so the
 * modal is meaningful from day one — Phase C fills in the rich
 * sections per family over time.
 */

import { X, AlertTriangle, Code2, ListChecks, Wrench } from 'lucide-react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { useI18n } from '@/lib/i18n';
import { getToolDetail } from './registry';
import { Prose } from '../section_help/Prose';

export interface CapabilityFlags {
  read_only?: boolean;
  destructive?: boolean;
  network_egress?: boolean;
  concurrency_safe?: boolean;
  idempotent?: boolean;
}

export interface ToolDetailModalProps {
  open: boolean;
  onClose: () => void;
  /** Tool name (canonical, matches catalog). Used to look up
   *  registered deep content. */
  name: string | null;
  /** Localised description from the catalog. */
  description: string;
  /** Family / category label for the eyebrow line. */
  family?: string;
  /** Optional capability flags (executor tools have these; Geny tools
   *  generally don't). */
  capabilities?: CapabilityFlags;
  /** Optional input schema (executor tools — JSON Schema dict). */
  inputSchema?: Record<string, unknown> | null;
}

interface ParameterRow {
  name: string;
  type: string;
  required: boolean;
  description: string;
  defaultValue?: string;
}

function flattenSchema(schema: unknown): ParameterRow[] {
  if (!schema || typeof schema !== 'object') return [];
  const obj = schema as Record<string, unknown>;
  const props = obj.properties as Record<string, unknown> | undefined;
  if (!props) return [];
  const required = new Set<string>(
    Array.isArray(obj.required) ? (obj.required as string[]) : [],
  );
  const rows: ParameterRow[] = [];
  for (const [key, raw] of Object.entries(props)) {
    if (!raw || typeof raw !== 'object') continue;
    const p = raw as Record<string, unknown>;
    const type = typeof p.type === 'string'
      ? (p.type as string)
      : Array.isArray(p.type)
        ? (p.type as string[]).join(' | ')
        : 'any';
    rows.push({
      name: key,
      type,
      required: required.has(key),
      description:
        typeof p.description === 'string' ? (p.description as string) : '',
      defaultValue:
        p.default !== undefined ? JSON.stringify(p.default) : undefined,
    });
  }
  return rows;
}

export default function ToolDetailModal({
  open,
  onClose,
  name,
  description,
  family,
  capabilities,
  inputSchema,
}: ToolDetailModalProps) {
  const { t } = useI18n();
  const locale = useI18n((s) => s.locale);

  if (!name) return null;
  const factory = getToolDetail(name);
  const detail = factory ? factory(locale) : null;
  const params = flattenSchema(inputSchema ?? null);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="max-w-4xl p-0 max-h-[90vh] flex flex-col gap-0">
        {/* ── Header ── */}
        <header className="flex items-start gap-4 px-8 pt-7 pb-6 border-b border-[hsl(var(--border))] shrink-0">
          <div className="flex-1 min-w-0">
            {family && (
              <div className="text-[0.625rem] uppercase tracking-[0.1em] font-semibold text-[hsl(var(--muted-foreground))]">
                {family}
              </div>
            )}
            <h2 className="text-[1.5rem] font-mono font-semibold text-[hsl(var(--foreground))] mt-2 leading-tight">
              {name}
            </h2>
            {description && (
              <p className="text-[0.875rem] text-[hsl(var(--muted-foreground))] mt-2 leading-relaxed max-w-[64ch]">
                {description}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 -mt-1 -mr-2 inline-flex items-center justify-center w-8 h-8 rounded-md text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))] transition-colors"
            aria-label="close"
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        {/* ── Scrollable body ── */}
        <div className="flex-1 min-h-0 overflow-y-auto px-8 py-6 flex flex-col gap-7">
          {/* ── Capability chips ── */}
          {capabilities && Object.values(capabilities).some(Boolean) && (
            <Section title={t('envManagement.toolDetail.capabilities')}>
              <div className="flex flex-wrap gap-1.5">
                {capabilities.read_only && (
                  <CapabilityChip
                    label={t('envManagement.builtinExplorer.cap.readOnly')}
                    tone="emerald"
                  />
                )}
                {capabilities.destructive && (
                  <CapabilityChip
                    label={t('envManagement.builtinExplorer.cap.destructive')}
                    tone="red"
                  />
                )}
                {capabilities.network_egress && (
                  <CapabilityChip
                    label={t('envManagement.builtinExplorer.cap.network')}
                    tone="amber"
                  />
                )}
                {capabilities.concurrency_safe && (
                  <CapabilityChip
                    label={t('envManagement.builtinExplorer.cap.parallel')}
                    tone="blue"
                  />
                )}
                {capabilities.idempotent && (
                  <CapabilityChip
                    label={t('envManagement.builtinExplorer.cap.idempotent')}
                    tone="gray"
                  />
                )}
              </div>
            </Section>
          )}

          {/* ── Parameter table ── */}
          {params.length > 0 && (
            <Section title={t('envManagement.toolDetail.parameters')}>
              <ul className="flex flex-col gap-2.5">
                {params.map((p) => (
                  <li
                    key={p.name}
                    className="grid grid-cols-[max-content_max-content_1fr] gap-x-3 gap-y-1 px-3 py-2 rounded-md bg-[hsl(var(--muted))] border border-[hsl(var(--border))]"
                  >
                    <code className="font-mono text-[0.8125rem] font-semibold text-[hsl(var(--foreground))]">
                      {p.name}
                      {p.required && (
                        <span className="ml-1 text-[hsl(var(--destructive))]">
                          *
                        </span>
                      )}
                    </code>
                    <code className="font-mono text-[0.6875rem] uppercase tracking-wide text-[hsl(var(--muted-foreground))] self-center">
                      {p.type}
                    </code>
                    <span className="text-[0.6875rem] text-[hsl(var(--muted-foreground))] self-center tabular-nums">
                      {p.defaultValue !== undefined && (
                        <>
                          {t('envManagement.toolDetail.defaultLabel')}{' '}
                          <code className="font-mono">{p.defaultValue}</code>
                        </>
                      )}
                    </span>
                    {p.description && (
                      <p className="col-span-3 text-[0.75rem] text-[hsl(var(--foreground))] leading-relaxed">
                        {p.description}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {/* ── Deep walkthrough (optional) ── */}
          {detail && (
            <>
              {detail.body && (
                <Section title={t('envManagement.toolDetail.howItWorks')}>
                  <Prose text={detail.body} />
                </Section>
              )}

              {detail.bestFor && detail.bestFor.length > 0 && (
                <Section
                  title={t('envManagement.toolDetail.bestFor')}
                  icon={ListChecks}
                  tone="emerald"
                >
                  <BulletList items={detail.bestFor} />
                </Section>
              )}

              {detail.avoidWhen && detail.avoidWhen.length > 0 && (
                <Section
                  title={t('envManagement.toolDetail.avoidWhen')}
                  icon={AlertTriangle}
                  tone="amber"
                >
                  <BulletList items={detail.avoidWhen} />
                </Section>
              )}

              {detail.gotchas && detail.gotchas.length > 0 && (
                <Section
                  title={t('envManagement.toolDetail.gotchas')}
                  icon={AlertTriangle}
                  tone="red"
                >
                  <BulletList items={detail.gotchas} />
                </Section>
              )}

              {detail.examples && detail.examples.length > 0 && (
                <Section
                  title={t('envManagement.toolDetail.examples')}
                  icon={Code2}
                >
                  <div className="flex flex-col gap-3">
                    {detail.examples.map((ex, i) => (
                      <div
                        key={i}
                        className="rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] overflow-hidden"
                      >
                        <div className="px-3 py-2 text-[0.75rem] text-[hsl(var(--foreground))] border-b border-[hsl(var(--border))] bg-[hsl(var(--muted))]">
                          {ex.caption}
                        </div>
                        <pre className="px-3 py-2 text-[0.7rem] font-mono text-[hsl(var(--foreground))] overflow-x-auto whitespace-pre-wrap">
                          {ex.body}
                        </pre>
                        {ex.note && (
                          <div className="px-3 py-2 text-[0.7rem] text-[hsl(var(--muted-foreground))] leading-relaxed border-t border-[hsl(var(--border))]">
                            {ex.note}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </Section>
              )}

              {(detail.relatedTools?.length || 0) +
                (detail.relatedStages?.length || 0) >
                0 && (
                <Section
                  title={t('envManagement.toolDetail.related')}
                  icon={Wrench}
                >
                  <div className="flex flex-col gap-1.5">
                    {detail.relatedTools && detail.relatedTools.length > 0 && (
                      <div className="flex items-baseline gap-2 flex-wrap text-[0.75rem]">
                        <span className="text-[hsl(var(--muted-foreground))]">
                          {t('envManagement.toolDetail.relatedTools')}
                        </span>
                        {detail.relatedTools.map((rt) => (
                          <code
                            key={rt}
                            className="font-mono text-[0.7rem] px-1.5 py-0.5 rounded bg-[hsl(var(--muted))] border border-[hsl(var(--border))]"
                          >
                            {rt}
                          </code>
                        ))}
                      </div>
                    )}
                    {detail.relatedStages &&
                      detail.relatedStages.length > 0 && (
                        <div className="flex items-baseline gap-2 flex-wrap text-[0.75rem]">
                          <span className="text-[hsl(var(--muted-foreground))]">
                            {t('envManagement.toolDetail.relatedStages')}
                          </span>
                          {detail.relatedStages.map((s) => (
                            <span
                              key={s}
                              className="text-[0.7rem] px-1.5 py-0.5 rounded bg-[hsl(var(--primary)/0.08)] text-[hsl(var(--primary))] border border-[hsl(var(--primary)/0.3)]"
                            >
                              {s}
                            </span>
                          ))}
                        </div>
                      )}
                  </div>
                </Section>
              )}

              {detail.codeRef && (
                <Section title={t('envManagement.toolDetail.codeRef')}>
                  <code className="font-mono text-[0.7rem] text-[hsl(var(--muted-foreground))] break-all">
                    {detail.codeRef}
                  </code>
                </Section>
              )}
            </>
          )}

          {!detail && !description && params.length === 0 && (
            <div className="text-[0.8125rem] italic text-[hsl(var(--muted-foreground))] py-6 text-center">
              {t('envManagement.toolDetail.empty')}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Section({
  title,
  icon: Icon,
  tone,
  children,
}: {
  title: string;
  icon?: React.ComponentType<{ className?: string }>;
  tone?: 'emerald' | 'amber' | 'red';
  children: React.ReactNode;
}) {
  const toneClass =
    tone === 'emerald'
      ? 'text-emerald-700 dark:text-emerald-300'
      : tone === 'amber'
        ? 'text-amber-700 dark:text-amber-300'
        : tone === 'red'
          ? 'text-red-700 dark:text-red-300'
          : 'text-[hsl(var(--muted-foreground))]';
  return (
    <section className="flex flex-col gap-2">
      <h3
        className={`flex items-center gap-1.5 text-[0.6875rem] uppercase tracking-[0.1em] font-semibold ${toneClass}`}
      >
        {Icon && <Icon className="w-3.5 h-3.5" />}
        {title}
      </h3>
      {children}
    </section>
  );
}

function BulletList({ items }: { items: string[] }) {
  return (
    <ul className="flex flex-col gap-1.5 pl-1">
      {items.map((b, i) => (
        <li
          key={i}
          className="flex items-start gap-2 text-[0.8125rem] text-[hsl(var(--foreground))]"
        >
          <span className="mt-2 w-1 h-1 rounded-full bg-[hsl(var(--muted-foreground))] shrink-0" />
          <span className="leading-relaxed">{b}</span>
        </li>
      ))}
    </ul>
  );
}

function CapabilityChip({
  label,
  tone,
}: {
  label: string;
  tone: 'emerald' | 'red' | 'amber' | 'blue' | 'gray';
}) {
  const map: Record<typeof tone, string> = {
    emerald:
      'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30',
    red: 'bg-red-500/10 text-red-700 dark:text-red-300 border-red-500/30',
    amber:
      'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30',
    blue: 'bg-blue-500/10 text-blue-700 dark:text-blue-300 border-blue-500/30',
    gray: 'bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))] border-[hsl(var(--border))]',
  };
  return (
    <span
      className={`inline-flex items-center px-2 py-1 rounded text-[0.625rem] font-medium uppercase tracking-wider border ${map[tone]}`}
    >
      {label}
    </span>
  );
}
