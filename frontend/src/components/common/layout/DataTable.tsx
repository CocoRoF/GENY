'use client';

/**
 * DataTable — the ONE canonical table/list (tone & manner source of truth).
 *
 * Two row shapes, one chrome:
 *   • columns mode  — aligned data columns (CSS grid). Reference: Tasks tab.
 *   • renderRow mode — rich custom rows (icon + badges + text). Reference: Hooks tab.
 * Both share: per-row action buttons (RowActions), click-to-expand inline detail,
 * row hover, dividers, density, and the empty state. Built on existing primitives
 * (ActionButton, EmptyState) + tokens only.
 */

import { useState, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { ChevronRight } from 'lucide-react';
import { EmptyState } from './EmptyState';
import { ActionButton } from './ActionButton';
import { cn } from './cn';

export interface DataColumn<T> {
  key: string;
  header?: ReactNode;
  render: (row: T) => ReactNode;
  /** CSS grid track (e.g. '8rem', 'auto', 'minmax(0,1fr)'). Default 'minmax(0,1fr)'. */
  width?: string;
  align?: 'left' | 'right' | 'center';
  mono?: boolean;
  className?: string;
}

export interface DataRowAction {
  icon?: LucideIcon;
  label: ReactNode;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  title?: string;
  spinIcon?: boolean;
}

/** Standalone row-action button group — usable on its own (cards, etc.). */
export function RowActions({ actions, className }: { actions: DataRowAction[]; className?: string }) {
  if (!actions.length) return null;
  return (
    <div className={cn('flex items-center gap-1 shrink-0', className)}>
      {actions.map((a, i) => (
        <ActionButton
          key={i}
          variant={a.danger ? 'danger' : 'secondary'}
          icon={a.icon}
          spinIcon={a.spinIcon}
          disabled={a.disabled}
          title={a.title}
          onClick={(e) => {
            e.stopPropagation();
            a.onClick();
          }}
        >
          {a.label}
        </ActionButton>
      ))}
    </div>
  );
}

const ALIGN: Record<string, string> = {
  left: 'text-left',
  right: 'text-right justify-self-end',
  center: 'text-center justify-self-center',
};

export interface DataTableProps<T> {
  rows: T[];
  keyOf: (row: T) => string;
  /** Aligned columns. Ignored when `renderRow` is given. */
  columns?: DataColumn<T>[];
  /** Rich custom row content (overrides columns). */
  renderRow?: (row: T) => ReactNode;
  rowActions?: (row: T) => DataRowAction[];
  /** Click a row to toggle inline detail (rendered by `renderExpanded`). */
  expandable?: boolean;
  renderExpanded?: (row: T) => ReactNode;
  /** Alternative to expand — handle a row click (e.g. open a detail view). */
  onRowClick?: (row: T) => void;
  loading?: boolean;
  empty?: ReactNode;
  density?: 'compact' | 'normal';
  hoverable?: boolean;
  className?: string;
}

export function DataTable<T>({
  rows,
  keyOf,
  columns,
  renderRow,
  rowActions,
  expandable = false,
  renderExpanded,
  onRowClick,
  loading = false,
  empty,
  density = 'normal',
  hoverable = true,
  className,
}: DataTableProps<T>) {
  const [openKeys, setOpenKeys] = useState<Set<string>>(new Set());
  const toggle = (k: string) =>
    setOpenKeys((s) => {
      const n = new Set(s);
      n.has(k) ? n.delete(k) : n.add(k);
      return n;
    });

  const useColumns = !renderRow && !!columns?.length;
  const gridTemplate = useColumns
    ? columns!.map((c) => c.width || 'minmax(0,1fr)').join(' ')
    : undefined;
  const rowPad = density === 'compact' ? 'px-3 py-1.5' : 'px-4 py-2.5';

  if (!loading && rows.length === 0) {
    return <>{empty ?? <EmptyState title="No items" />}</>;
  }

  return (
    <div className={cn('flex flex-col', className)}>
      {useColumns && columns!.some((c) => c.header) && (
        <div className={cn('flex items-center gap-3 px-4 py-2 border-b border-[hsl(var(--border))]')}>
          {expandable && <span className="w-3.5 shrink-0" />}
          <div
            className="grid gap-3 flex-1 min-w-0 text-[0.6875rem] uppercase tracking-wider text-[hsl(var(--muted-foreground))] font-semibold"
            style={{ gridTemplateColumns: gridTemplate }}
          >
            {columns!.map((c) => (
              <div key={c.key} className={cn('min-w-0 truncate', ALIGN[c.align ?? 'left'])}>
                {c.header}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="divide-y divide-[hsl(var(--border))]">
        {rows.map((row) => {
          const k = keyOf(row);
          const isOpen = expandable && openKeys.has(k);
          const acts = rowActions?.(row) ?? [];
          const clickable = !!onRowClick || expandable;
          const handle = () => {
            if (onRowClick) onRowClick(row);
            else if (expandable) toggle(k);
          };
          return (
            <div key={k}>
              <div
                role={clickable ? 'button' : undefined}
                tabIndex={clickable ? 0 : undefined}
                onClick={clickable ? handle : undefined}
                onKeyDown={
                  clickable
                    ? (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          handle();
                        }
                      }
                    : undefined
                }
                className={cn(
                  'flex items-start gap-3 w-full text-left',
                  rowPad,
                  hoverable && clickable && 'cursor-pointer hover:bg-[hsl(var(--accent))] transition-colors',
                )}
              >
                {expandable && (
                  <ChevronRight
                    className={cn(
                      'w-3.5 h-3.5 shrink-0 mt-0.5 text-[hsl(var(--muted-foreground))] transition-transform',
                      isOpen && 'rotate-90',
                    )}
                  />
                )}
                {useColumns ? (
                  <div
                    className="grid gap-3 flex-1 min-w-0 items-center"
                    style={{ gridTemplateColumns: gridTemplate }}
                  >
                    {columns!.map((c) => (
                      <div
                        key={c.key}
                        className={cn(
                          'min-w-0 truncate text-[0.8125rem] text-[hsl(var(--foreground))]',
                          ALIGN[c.align ?? 'left'],
                          c.mono && 'font-mono',
                          c.className,
                        )}
                      >
                        {c.render(row)}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="flex-1 min-w-0">{renderRow?.(row)}</div>
                )}
                {acts.length > 0 && <RowActions actions={acts} className="mt-0.5" />}
              </div>

              {isOpen && renderExpanded && (
                <div
                  className={cn(
                    'bg-[hsl(var(--card)/0.5)] border-t border-[hsl(var(--border))]',
                    density === 'compact' ? 'px-3 py-3' : 'px-4 py-4',
                    expandable && 'pl-10',
                  )}
                >
                  {renderExpanded(row)}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default DataTable;
