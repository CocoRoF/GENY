'use client';

/**
 * ToolPickerField — categorized multiselect for the skill's
 * `allowed_tools` field.
 *
 * Replaces the raw CSV textarea with a chip-based picker that
 * pulls the actual catalog of tools available in this Geny
 * deployment:
 *
 *   • Executor built-in tools (`/api/tools/catalog/framework`):
 *     Read / Write / Bash / Edit / etc. — the things a SKILL.md
 *     most often wants to declare.
 *   • Geny external tools (`/api/tools/catalog/external`):
 *     custom tools dropped into `backend/tools/custom/` plus the
 *     wrapper-style `built_in` advertised by GenyToolProvider.
 *   • Free-form input: power users can still type a name the
 *     catalog doesn't know about (wildcards like `mcp__*`, future
 *     tools, etc.). The "+ 도구 추가" entry exposes a typeahead
 *     that lets them confirm an unknown name on Enter.
 *
 * Selected names render as removable chips. Removing a chip drops
 * it from the underlying value; the value stays the comma-separated
 * shape `SkillFormModal` already expects so the rest of the form
 * machinery doesn't need to change.
 *
 * Visual rhythm matches the rest of the form modal — sectioned
 * label / hint at the top, picker below, chips wrap.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Plus, X, Search } from 'lucide-react';
import {
  externalToolCatalogApi,
  frameworkToolApi,
  type ExternalToolEntry,
  type FrameworkToolDetail,
} from '@/lib/api';
import { useI18n } from '@/lib/i18n';

interface CatalogEntry {
  name: string;
  description: string;
  group: string; // 'executor' | 'geny' | 'custom-typed'
  feature?: string;
}

export interface ToolPickerFieldProps {
  /** Comma-separated tool names — the same shape SkillFormModal
   *  passes to/from `formToPayload`. */
  value: string;
  onChange: (next: string) => void;
  /** When true the picker is read-only — chips render but the
   *  add-button + chip-delete are disabled. View mode in the form
   *  modal flips this on. */
  disabled?: boolean;
}

function parseValue(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function joinValue(names: string[]): string {
  return names.join(', ');
}

export default function ToolPickerField({
  value,
  onChange,
  disabled = false,
}: ToolPickerFieldProps) {
  const { t } = useI18n();
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // ── Catalog load (executor + Geny tools) ───────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const [framework, external] = await Promise.allSettled([
          frameworkToolApi.list(),
          externalToolCatalogApi.list(),
        ]);
        if (cancelled) return;
        const next: CatalogEntry[] = [];
        if (framework.status === 'fulfilled') {
          framework.value.tools.forEach((tool: FrameworkToolDetail) => {
            next.push({
              name: tool.name,
              description: tool.description,
              group: 'executor',
              feature: tool.feature_group,
            });
          });
        }
        if (external.status === 'fulfilled') {
          external.value.tools.forEach((tool: ExternalToolEntry) => {
            // Skip entries the executor catalog already covers (Geny's
            // "external.built_in" mirrors executor names for some tools).
            if (next.some((e) => e.name === tool.name)) return;
            next.push({
              name: tool.name,
              description: tool.description,
              group: tool.category === 'custom' ? 'geny' : 'executor',
            });
          });
        }
        // Sort within group, group-order stable: executor → geny.
        next.sort((a, b) => {
          if (a.group !== b.group) return a.group.localeCompare(b.group);
          return a.name.localeCompare(b.name);
        });
        setCatalog(next);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Click-outside closes the picker ────────────────────────────
  useEffect(() => {
    if (!pickerOpen) return;
    const onClick = (ev: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(ev.target as Node)
      ) {
        setPickerOpen(false);
        setQuery('');
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [pickerOpen]);

  // ── Derived state ─────────────────────────────────────────────
  const selected = useMemo(() => parseValue(value), [value]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  // Annotate each selected chip — `unknown: true` means it's not
  // in the catalog (typed manually / catalog still loading / etc.).
  const selectedChips = useMemo(
    () =>
      selected.map((name) => ({
        name,
        entry: catalog.find((e) => e.name === name),
      })),
    [selected, catalog],
  );

  const filteredCatalog = useMemo(() => {
    const q = query.trim().toLowerCase();
    return catalog.filter((entry) => {
      if (selectedSet.has(entry.name)) return false;
      if (!q) return true;
      return (
        entry.name.toLowerCase().includes(q) ||
        (entry.description ?? '').toLowerCase().includes(q)
      );
    });
  }, [catalog, query, selectedSet]);

  const customQueryAllowed =
    query.trim().length > 0 &&
    !selectedSet.has(query.trim()) &&
    !catalog.some((e) => e.name === query.trim());

  // ── Mutation helpers ──────────────────────────────────────────
  const add = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed || selectedSet.has(trimmed)) return;
    onChange(joinValue([...selected, trimmed]));
    setQuery('');
    inputRef.current?.focus();
  };

  const remove = (name: string) => {
    if (disabled) return;
    onChange(joinValue(selected.filter((n) => n !== name)));
  };

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (disabled) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      // Prefer first filtered catalog match; fall back to raw query.
      if (filteredCatalog.length > 0) {
        add(filteredCatalog[0].name);
      } else if (customQueryAllowed) {
        add(query.trim());
      }
    } else if (
      e.key === 'Backspace' &&
      query.length === 0 &&
      selected.length > 0
    ) {
      // Delete the last chip on backspace from an empty input.
      remove(selected[selected.length - 1]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setPickerOpen(false);
      setQuery('');
    }
  };

  // ── Render ────────────────────────────────────────────────────
  const groupLabel = (group: string): string => {
    if (group === 'executor') {
      return t('envManagement.registry.skills.toolPickerGroupExecutor');
    }
    if (group === 'geny') {
      return t('envManagement.registry.skills.toolPickerGroupGeny');
    }
    return group;
  };

  return (
    <div
      ref={containerRef}
      className="rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] focus-within:ring-1 focus-within:ring-[hsl(var(--primary))]"
    >
      {/* Selected chips + add button */}
      <div className="flex flex-wrap gap-1.5 p-2 min-h-[2.5rem]">
        {selectedChips.length === 0 && !pickerOpen && (
          <span className="text-[0.75rem] text-[hsl(var(--muted-foreground))] self-center">
            {t('envManagement.registry.skills.toolPickerEmpty')}
          </span>
        )}
        {selectedChips.map(({ name, entry }) => (
          <span
            key={name}
            title={entry?.description}
            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-[0.7rem] font-mono ${
              entry
                ? entry.group === 'executor'
                  ? 'border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300'
                  : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                : 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300'
            }`}
          >
            {name}
            {!entry && (
              <span
                className="text-[0.6rem] opacity-70 normal-case font-sans"
                title={t('envManagement.registry.skills.toolPickerCustomHint')}
              >
                ({t('envManagement.registry.skills.toolPickerCustomTag')})
              </span>
            )}
            {!disabled && (
              <button
                type="button"
                onClick={() => remove(name)}
                className="text-current opacity-60 hover:opacity-100"
                aria-label={`remove ${name}`}
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </span>
        ))}
        {!disabled && (
          <button
            type="button"
            onClick={() => {
              setPickerOpen((v) => !v);
              if (!pickerOpen) {
                // Wait one tick so the input mounts.
                setTimeout(() => inputRef.current?.focus(), 0);
              }
            }}
            className="inline-flex items-center gap-1 h-6 px-2 rounded-md border border-dashed border-[hsl(var(--border))] text-[0.7rem] font-medium text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))]"
            title={t('envManagement.registry.skills.toolPickerAddTip')}
          >
            <Plus className="w-3 h-3" />
            {t('envManagement.registry.skills.toolPickerAdd')}
          </button>
        )}
      </div>

      {/* Picker dropdown */}
      {pickerOpen && !disabled && (
        <div className="border-t border-[hsl(var(--border))] p-2">
          <div className="flex items-center gap-1.5 px-2 py-1 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--card))]">
            <Search className="w-3.5 h-3.5 text-[hsl(var(--muted-foreground))]" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onInputKeyDown}
              placeholder={t(
                'envManagement.registry.skills.toolPickerSearchPlaceholder',
              )}
              className="flex-1 bg-transparent border-none outline-none text-[0.8125rem] font-mono"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>

          {error && (
            <div className="mt-2 text-[0.7rem] text-red-600 dark:text-red-400">
              {t('envManagement.registry.skills.toolPickerLoadError', {
                error,
              })}
            </div>
          )}

          {loading ? (
            <div className="mt-2 text-[0.7rem] text-[hsl(var(--muted-foreground))]">
              {t('envManagement.registry.skills.toolPickerLoading')}
            </div>
          ) : (
            <div className="mt-2 max-h-60 overflow-y-auto flex flex-col gap-0.5">
              {filteredCatalog.length === 0 && !customQueryAllowed && (
                <div className="text-[0.7rem] text-[hsl(var(--muted-foreground))] py-2 text-center">
                  {query
                    ? t('envManagement.registry.skills.toolPickerNoMatch')
                    : t('envManagement.registry.skills.toolPickerEmptyCatalog')}
                </div>
              )}
              {/* Group headers */}
              {(() => {
                const grouped: Record<string, CatalogEntry[]> = {};
                filteredCatalog.forEach((entry) => {
                  (grouped[entry.group] ??= []).push(entry);
                });
                return Object.entries(grouped).map(([group, entries]) => (
                  <div key={group} className="mt-1 first:mt-0">
                    <div className="px-2 py-0.5 text-[0.6rem] uppercase tracking-wider text-[hsl(var(--muted-foreground))] font-semibold">
                      {groupLabel(group)} ({entries.length})
                    </div>
                    {entries.map((entry) => (
                      <button
                        key={entry.name}
                        type="button"
                        onClick={() => add(entry.name)}
                        className="w-full flex items-start gap-2 px-2 py-1 rounded text-left hover:bg-[hsl(var(--accent))]"
                      >
                        <Check className="w-3 h-3 mt-1 opacity-0" />
                        <div className="flex-1 min-w-0">
                          <div className="text-[0.75rem] font-mono text-[hsl(var(--foreground))]">
                            {entry.name}
                          </div>
                          {entry.description && (
                            <div className="text-[0.65rem] text-[hsl(var(--muted-foreground))] line-clamp-2">
                              {entry.description}
                            </div>
                          )}
                        </div>
                      </button>
                    ))}
                  </div>
                ));
              })()}
              {customQueryAllowed && (
                <button
                  type="button"
                  onClick={() => add(query.trim())}
                  className="mt-2 w-full flex items-center gap-2 px-2 py-1.5 rounded border border-dashed border-amber-500/40 bg-amber-500/5 text-[0.7rem] text-amber-700 dark:text-amber-300 hover:bg-amber-500/10"
                >
                  <Plus className="w-3 h-3" />
                  {t('envManagement.registry.skills.toolPickerAddCustom', {
                    name: query.trim(),
                  })}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {!pickerOpen && !disabled && (
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          className="w-full flex items-center justify-center gap-1 px-2 py-1 border-t border-[hsl(var(--border))] text-[0.65rem] text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))] hover:text-[hsl(var(--foreground))]"
        >
          <ChevronDown className="w-3 h-3" />
          {t('envManagement.registry.skills.toolPickerOpenCatalog')}
        </button>
      )}
    </div>
  );
}
