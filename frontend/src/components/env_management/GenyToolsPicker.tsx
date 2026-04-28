'use client';

/**
 * GenyToolsPicker — checkbox grid over the Geny-side external tool
 * catalog (the surface advertised by `GenyToolProvider`, exposed via
 * `/api/tools/catalog/external`).
 *
 * Selected names land in `manifest.tools.external`. The provider
 * advertises every entry at session boot — the manifest decides which
 * ones the agent is actually allowed to attach. Empty array means
 * "no Geny tools attached"; the executor's own BUILT_IN_TOOL_CLASSES
 * are independent and live in `manifest.tools.built_in` (managed by
 * the Executor Built-in tab next door).
 */

import { useEffect, useMemo, useState } from 'react';
import { Loader2, Search } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import {
  externalToolCatalogApi,
  type ExternalToolEntry,
} from '@/lib/api';
import { Input } from '@/components/ui/input';

export interface GenyToolsPickerProps {
  value: string[];
  onChange: (next: string[]) => void;
  hint?: string;
}

export default function GenyToolsPicker({
  value,
  onChange,
  hint,
}: GenyToolsPickerProps) {
  const { t } = useI18n();
  const [catalog, setCatalog] = useState<ExternalToolEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    let cancelled = false;
    externalToolCatalogApi
      .list()
      .then((res) => {
        if (cancelled) return;
        setCatalog(res.tools);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setCatalog([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const grouped = useMemo(() => {
    if (!catalog) return new Map<string, ExternalToolEntry[]>();
    const q = query.trim().toLowerCase();
    const filtered = q
      ? catalog.filter(
          (e) =>
            e.name.toLowerCase().includes(q) ||
            e.description.toLowerCase().includes(q),
        )
      : catalog;
    const map = new Map<string, ExternalToolEntry[]>();
    for (const t of filtered) {
      const key = t.category || 'other';
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(t);
    }
    return map;
  }, [catalog, query]);

  const selectedSet = useMemo(() => new Set(value), [value]);

  const toggle = (name: string) => {
    if (selectedSet.has(name)) {
      onChange(value.filter((n) => n !== name));
    } else {
      onChange([...value, name]);
    }
  };

  const selectAll = () => {
    if (!catalog) return;
    onChange(catalog.map((t) => t.name));
  };
  const clearAll = () => onChange([]);

  if (catalog === null) {
    return (
      <div className="flex items-center gap-2 text-[0.75rem] text-[hsl(var(--muted-foreground))] py-3">
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        {t('envManagement.genyTools.loading')}
      </div>
    );
  }

  if (error) {
    return (
      <div className="px-3 py-2 rounded-md bg-[rgba(239,68,68,0.1)] border border-[rgba(239,68,68,0.3)] text-[0.75rem] text-[var(--danger-color)]">
        {t('envManagement.genyTools.loadError', { error })}
      </div>
    );
  }

  if (catalog.length === 0) {
    return (
      <div className="text-[0.8125rem] text-[hsl(var(--muted-foreground))] italic py-3">
        {t('envManagement.genyTools.empty')}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {hint && (
        <p className="text-[0.75rem] text-[hsl(var(--muted-foreground))] leading-relaxed">
          {hint}
        </p>
      )}

      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[hsl(var(--muted-foreground))]" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('envManagement.genyTools.searchPlaceholder')}
            className="h-8 pl-8 text-[0.75rem]"
          />
        </div>
        <span className="text-[0.6875rem] tabular-nums text-[hsl(var(--muted-foreground))] shrink-0">
          {value.length} / {catalog.length}
        </span>
        <div className="inline-flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={selectAll}
            className="h-8 px-2.5 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--primary)/0.08)] text-[hsl(var(--primary))] text-[0.7rem] font-medium hover:bg-[hsl(var(--primary)/0.16)] transition-colors"
          >
            {t('envManagement.genyTools.selectAll')}
          </button>
          <button
            type="button"
            onClick={clearAll}
            className="h-8 px-2.5 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] text-[0.7rem] font-medium text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))] transition-colors"
          >
            {t('envManagement.genyTools.clear')}
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        {Array.from(grouped.entries()).map(([category, entries]) => {
          const inGroup = entries.length;
          const selectedInGroup = entries.filter((e) =>
            selectedSet.has(e.name),
          ).length;
          return (
            <section
              key={category}
              className="flex flex-col gap-2 p-3 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))]"
            >
              <header className="flex items-center justify-between gap-2">
                <h4 className="text-[0.8125rem] font-semibold text-[hsl(var(--foreground))]">
                  {category}
                </h4>
                <span className="text-[0.625rem] tabular-nums text-[hsl(var(--muted-foreground))]">
                  {selectedInGroup}/{inGroup}
                </span>
              </header>
              <ul className="grid grid-cols-1 md:grid-cols-2 gap-1">
                {entries.map((entry) => {
                  const checked = selectedSet.has(entry.name);
                  return (
                    <li key={entry.name}>
                      <label
                        className={`flex items-start gap-2 px-2 py-1.5 rounded cursor-pointer transition-colors ${
                          checked
                            ? 'bg-[hsl(var(--primary)/0.06)]'
                            : 'hover:bg-[hsl(var(--accent))]'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggle(entry.name)}
                          className="mt-0.5 cursor-pointer accent-[hsl(var(--primary))]"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="font-mono text-[0.75rem] text-[hsl(var(--foreground))] truncate">
                            {entry.name}
                          </div>
                          {entry.description && (
                            <div className="text-[0.6875rem] text-[hsl(var(--muted-foreground))] truncate">
                              {entry.description}
                            </div>
                          )}
                        </div>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
