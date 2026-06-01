'use client';

/**
 * Stage10ToolsEditor — the single source of truth for "which tools does
 * this env expose".
 *
 * Cycle 20260525_1 consolidation: Stage 0's three tool sub-panels
 * (Executor Built-in / Geny Built-in / MCP) were removed; their
 * editing surface lives here now, organised under a 4-category
 * sidebar so the operator can move between catalogs without leaving
 * the stage editor.
 *
 *   ┌─ Stage 10 — 도구 ────────────────────────────────────────────┐
 *   │  ┌─ 카테고리 ─────────┐ ┌─ Picker ────────────────────────┐ │
 *   │  │ Executor Built-in │ │ (selected category's catalog)    │ │
 *   │  │ Geny Built-in     │ │                                  │ │
 *   │  │ Custom Tools      │ │                                  │ │
 *   │  │ MCP Servers       │ │                                  │ │
 *   │  └───────────────────┘ └──────────────────────────────────┘ │
 *   │                                                              │
 *   │  ──────────────────────────────────────────────────────────  │
 *   │  ▸ 이 단계만 따로 제한 (allowed / blocked) ─ collapsed       │
 *   └──────────────────────────────────────────────────────────────┘
 *
 * manifest mapping:
 *
 *   Executor Built-in → manifest.tools.built_in[]    (framework BUILT_IN_TOOL_CLASSES)
 *   Geny Built-in     → manifest.tools.external[]    (source_kind ∈ {geny_builtin, geny_custom_file})
 *   Custom Tools      → manifest.tools.external[]    (source_kind = custom_db — DB python_inline)
 *   MCP Servers       → manifest.tools.mcp_servers[] (full snapshot copy)
 *
 * The stage-active toggle (`이 단계 실행`) and stage-local
 * ``tool_binding`` (allowed / blocked) are stage-specific concerns
 * and live further down the page.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Box,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Filter,
  Layers,
  Network,
  Sparkles,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { useEnvironmentDraftStore } from '@/store/useEnvironmentDraftStore';
import {
  externalToolCatalogApi,
  type ExternalToolEntry,
} from '@/lib/api';
import type {
  StageManifestEntry,
  StageToolBinding,
} from '@/types/environment';
import ToolCheckboxGrid from '../ToolCheckboxGrid';
import GenyToolsExplorer from '../GenyToolsExplorer';
import MCPServerEditor, { type MCPServerEntry } from '../MCPServerEditor';
import SectionHelpButton from '../section_help/SectionHelpButton';

interface Props {
  order: number;
  entry: StageManifestEntry;
}

type CategoryId =
  | 'executor'
  | 'geny'
  | 'custom_builtin'
  | 'custom'
  | 'mcp';

// Catalog ``source_kind`` sets per GenyToolsExplorer window.
//
//   Geny Built-in   = ``tools/built_in/*_tools.py`` — Geny 공식 in-repo
//   Custom Built-in = ``tools/custom/*_tools.py``   — 운영자가 repo 에 추가
//   Custom Tools    = DB python_inline / http / mcp_proxy — 웹에서 정의
//
// All three windows write to the same ``manifest.tools.external[]``
// field; ``filterSourceKinds`` only scopes what each operator sees.
const GENY_BUILTIN_KINDS = ['geny_builtin'] as const;
const CUSTOM_BUILTIN_KINDS = ['geny_custom_file'] as const;
const CUSTOM_TOOLS_KINDS = ['custom_db'] as const;

interface CategoryDef {
  id: CategoryId;
  icon: LucideIcon;
  /** i18n leaf under ``envManagement.stage10.cat.<id>``. */
  i18nKey: string;
  /** Fallback Korean label when the i18n bundle is missing the key. */
  fallbackLabel: string;
  /** Short subtitle / fallback. */
  fallbackHint: string;
}

const CATEGORIES: CategoryDef[] = [
  {
    id: 'executor',
    icon: Box,
    i18nKey: 'executor',
    fallbackLabel: 'Executor Built-in',
    fallbackHint:
      'geny-executor 프레임워크의 BUILT_IN_TOOL_CLASSES — Read / Write / Bash / WebFetch ...',
  },
  {
    id: 'geny',
    icon: Sparkles,
    i18nKey: 'geny',
    fallbackLabel: 'Geny Built-in',
    fallbackHint:
      'Geny 공식 in-repo 도구 — tools/built_in/*_tools.py (memory / knowledge / session / messaging / geny_tools)',
  },
  {
    id: 'custom_builtin',
    icon: Layers,
    i18nKey: 'custom_builtin',
    fallbackLabel: 'Custom Built-in',
    fallbackHint:
      '운영자가 repo 에 추가한 in-repo 도구 — tools/custom/*_tools.py (browser, web_search, web_fetch)',
  },
  {
    id: 'custom',
    icon: Wrench,
    i18nKey: 'custom',
    fallbackLabel: 'Custom Tools',
    fallbackHint:
      'DB python_inline / http / mcp_proxy — 환경관리 → 커스텀 도구 탭에서 web 으로 정의',
  },
  {
    id: 'mcp',
    icon: Network,
    i18nKey: 'mcp',
    fallbackLabel: 'MCP Servers',
    fallbackHint: '환경관리 → MCP 탭에서 등록된 서버 중 이 env 가 사용할 것',
  },
];

export default function Stage10ToolsEditor({ order, entry }: Props) {
  const { t } = useI18n();
  const draft = useEnvironmentDraftStore((s) => s.draft);
  const patchStage = useEnvironmentDraftStore((s) => s.patchStage);
  const patchTools = useEnvironmentDraftStore((s) => s.patchTools);

  const [category, setCategory] = useState<CategoryId>('executor');
  const [bindingOpen, setBindingOpen] = useState(false);

  const builtInList = (draft?.tools?.built_in ?? []) as string[];
  const externalList = (draft?.tools?.external ?? []) as string[];
  const mcpServers = (draft?.tools?.mcp_servers ?? []) as Array<
    Record<string, unknown>
  >;

  // Catalog lookup for the sidebar badges. The picker pane fetches
  // its own copy; we keep a slim mirror here so each sidebar item can
  // render a per-category "selected / total" badge without waiting
  // for the picker to mount. One fetch per Stage 10 entry — cheap.
  const [catalog, setCatalog] = useState<ExternalToolEntry[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const r = await externalToolCatalogApi.list('ko');
        if (!cancelled) setCatalog(r.tools);
      } catch {
        // Catalog miss → badges fall back to total selection count.
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, []);

  const binding = (entry.tool_binding ?? {}) as StageToolBinding;
  const filterMode: 'inherit' | 'allowlist' | 'blocklist' = (() => {
    if (binding.allowed && binding.allowed.length > 0) return 'allowlist';
    if (binding.blocked && binding.blocked.length > 0) return 'blocklist';
    return 'inherit';
  })();

  const setFilterMode = (next: 'inherit' | 'allowlist' | 'blocklist') => {
    if (next === 'inherit') {
      patchStage(order, { tool_binding: null });
      return;
    }
    const seed: StageToolBinding =
      next === 'allowlist'
        ? { stage_order: order, allowed: [], blocked: null }
        : { stage_order: order, allowed: null, blocked: [] };
    patchStage(order, { tool_binding: seed });
  };

  const setAllowed = (names: string[]) => {
    patchStage(order, {
      tool_binding: {
        ...binding,
        stage_order: binding.stage_order ?? order,
        allowed: names,
        blocked: null,
      },
    });
  };
  const setBlocked = (names: string[]) => {
    patchStage(order, {
      tool_binding: {
        ...binding,
        stage_order: binding.stage_order ?? order,
        blocked: names,
        allowed: null,
      },
    });
  };

  // ── Per-category badges (right side of each sidebar button) ──
  // Wildcard ``["*"]`` collapses to a length of 1 in JS, which would
  // render as "1 / N" — misleading when the manifest actually means
  // "every tool in this category". Render ★ in that mode.
  const wildcardBuiltIn = builtInList.includes('*');

  // Split externalList into per-source-kind windows using the catalog
  // mirror. A tool name we haven't seen in the catalog (race during
  // first paint, or a stale manifest reference to a since-removed
  // tool) is excluded from the count — that's the safe default and
  // matches what the picker shows.
  const windowCounts = useMemo(() => {
    const selectedSet = new Set(externalList);
    let gs = 0, gt = 0;          // geny_builtin
    let cbs = 0, cbt = 0;         // geny_custom_file ("Custom Built-in")
    let cs = 0, ct = 0;           // custom_db ("Custom Tools")
    for (const e of catalog ?? []) {
      if (e.source_kind === 'geny_builtin') {
        gt += 1;
        if (selectedSet.has(e.name)) gs += 1;
      } else if (e.source_kind === 'geny_custom_file') {
        cbt += 1;
        if (selectedSet.has(e.name)) cbs += 1;
      } else if (e.source_kind === 'custom_db') {
        ct += 1;
        if (selectedSet.has(e.name)) cs += 1;
      }
    }
    return {
      geny: { sel: gs, total: gt },
      customBuiltin: { sel: cbs, total: cbt },
      custom: { sel: cs, total: ct },
    };
  }, [catalog, externalList]);

  const fmtBadge = (sel: number, total: number) =>
    catalog == null ? `${externalList.length}` : `${sel} / ${total}`;
  const genyBadge = fmtBadge(windowCounts.geny.sel, windowCounts.geny.total);
  const customBuiltinBadge = fmtBadge(
    windowCounts.customBuiltin.sel,
    windowCounts.customBuiltin.total,
  );
  const customBadge = fmtBadge(
    windowCounts.custom.sel,
    windowCounts.custom.total,
  );
  const executorBadge = wildcardBuiltIn
    ? '★'
    : `${builtInList.length} / 38`;
  const mcpBadge = `${mcpServers.length}`;

  const catLabel = (cat: CategoryDef) =>
    t(`envManagement.stage10.cat.${cat.i18nKey}.label`, {}) ||
    cat.fallbackLabel;
  const catHint = (cat: CategoryDef) =>
    t(`envManagement.stage10.cat.${cat.i18nKey}.hint`, {}) || cat.fallbackHint;

  const activeCat = CATEGORIES.find((c) => c.id === category) ?? CATEGORIES[0];

  return (
    <div className="flex flex-col gap-4">
      {/* ── Category sidebar + picker ── */}
      <section className="rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--card))] overflow-hidden">
        <header className="flex items-center justify-between gap-2 px-3 py-2 border-b border-[hsl(var(--border))]">
          <div className="flex items-center gap-2">
            <Layers className="w-3.5 h-3.5 text-[hsl(var(--primary))]" />
            <h4 className="text-[0.8125rem] font-semibold text-[hsl(var(--foreground))]">
              {t('envManagement.stage10.toolSourcesTitle', {}) ||
                '도구 소스'}
            </h4>
            <SectionHelpButton helpId="stage10.builtIn" />
          </div>
          <p className="text-[0.7rem] text-[hsl(var(--muted-foreground))]">
            {catHint(activeCat)}
          </p>
        </header>

        <div className="flex gap-0 min-h-[300px]">
          {/* Left sidebar */}
          <nav className="flex flex-col w-56 shrink-0 border-r border-[hsl(var(--border))]">
            {CATEGORIES.map((cat) => {
              const active = cat.id === category;
              const Icon = cat.icon;
              const labelBadge = (() => {
                switch (cat.id) {
                  case 'executor':
                    return executorBadge;
                  case 'geny':
                    return genyBadge;
                  case 'custom_builtin':
                    return customBuiltinBadge;
                  case 'custom':
                    return customBadge;
                  case 'mcp':
                    return mcpBadge;
                }
              })();
              return (
                <button
                  key={cat.id}
                  type="button"
                  onClick={() => setCategory(cat.id)}
                  className={[
                    'flex items-center justify-between gap-2 px-3 py-2 text-left text-[0.8125rem] border-l-2 transition-colors',
                    active
                      ? 'border-l-[hsl(var(--primary))] bg-[hsl(var(--primary)/0.06)] text-[hsl(var(--foreground))] font-medium'
                      : 'border-l-transparent text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))]',
                  ].join(' ')}
                >
                  <span className="flex items-center gap-2 min-w-0">
                    <Icon className="w-3.5 h-3.5 shrink-0" />
                    <span className="truncate">{catLabel(cat)}</span>
                  </span>
                  <span
                    className={[
                      'text-[0.625rem] tabular-nums px-1.5 py-0.5 rounded',
                      active
                        ? 'bg-[hsl(var(--primary)/0.16)] text-[hsl(var(--primary))]'
                        : 'bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]',
                    ].join(' ')}
                  >
                    {labelBadge}
                  </span>
                </button>
              );
            })}
          </nav>

          {/* Right picker */}
          <div className="flex-1 min-w-0 p-3">
            {category === 'executor' && (
              <ToolCheckboxGrid
                value={builtInList}
                onChange={(names) => patchTools({ built_in: names })}
                mode="allowlist"
                hint={
                  t('envManagement.stage10.cat.executor.pickerHint', {}) ||
                  'BUILT_IN_TOOL_CLASSES — Read / Write / Bash / Glob / Grep / WebFetch / WebSearch / TodoWrite / Agent / Cron / Task ...'
                }
              />
            )}

            {category === 'geny' && (
              <GenyToolsExplorer
                value={externalList}
                onChange={(names) => patchTools({ external: names })}
                filterSourceKinds={GENY_BUILTIN_KINDS}
              />
            )}

            {category === 'custom_builtin' && (
              <GenyToolsExplorer
                value={externalList}
                onChange={(names) => patchTools({ external: names })}
                filterSourceKinds={CUSTOM_BUILTIN_KINDS}
              />
            )}

            {category === 'custom' && (
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-end">
                  <Link
                    href="/environments?tab=custom_tools"
                    className="inline-flex items-center gap-1 text-[0.7rem] text-[hsl(var(--primary))] hover:underline no-underline"
                  >
                    {t('envManagement.stage10.cat.custom.manageLink', {}) ||
                      '커스텀 도구 정의 / 편집'}
                    <ExternalLink className="w-3 h-3" />
                  </Link>
                </div>
                <GenyToolsExplorer
                  value={externalList}
                  onChange={(names) => patchTools({ external: names })}
                  filterSourceKinds={CUSTOM_TOOLS_KINDS}
                />
              </div>
            )}

            {category === 'mcp' && (
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-end">
                  <Link
                    href="/environments?tab=mcp"
                    className="inline-flex items-center gap-1 text-[0.7rem] text-[hsl(var(--primary))] hover:underline no-underline"
                  >
                    {t('envManagement.stage10.mcpManage')}
                    <ExternalLink className="w-3 h-3" />
                  </Link>
                </div>
                <MCPServerEditor
                  value={mcpServers as unknown as MCPServerEntry[]}
                  onChange={(next) =>
                    patchTools({
                      mcp_servers: next as unknown as Array<
                        Record<string, unknown>
                      >,
                    })
                  }
                />
              </div>
            )}
          </div>
        </div>
      </section>

      {/* ── Stage-specific binding (allowed / blocked) ── */}
      <section className="rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--card))]">
        <button
          type="button"
          onClick={() => setBindingOpen((v) => !v)}
          className="w-full flex items-center gap-2 px-3 py-2 text-[0.8125rem] font-semibold text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))] transition-colors text-left"
        >
          {bindingOpen ? (
            <ChevronDown className="w-3.5 h-3.5" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5" />
          )}
          <Filter className="w-3.5 h-3.5 text-[hsl(var(--primary))]" />
          {t('envManagement.stage10.bindingTitle')}
          <span className="text-[0.6875rem] font-normal text-[hsl(var(--muted-foreground))]">
            {t(`envManagement.stage10.bindingMode.${filterMode}`)}
          </span>
        </button>
        {bindingOpen && (
          <div className="px-3 pb-3 border-t border-[hsl(var(--border))] pt-3 flex flex-col gap-3">
            <p className="text-[0.7rem] text-[hsl(var(--muted-foreground))] leading-relaxed">
              {t('envManagement.stage10.bindingHint')}
            </p>
            <div className="flex items-center gap-2 flex-wrap">
              {(['inherit', 'allowlist', 'blocklist'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setFilterMode(m)}
                  className={`px-2.5 py-1 rounded-full border text-[0.7rem] font-medium transition-colors ${
                    filterMode === m
                      ? 'border-[hsl(var(--primary))] bg-[hsl(var(--primary)/0.12)] text-[hsl(var(--primary))]'
                      : 'border-[hsl(var(--border))] text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))]'
                  }`}
                >
                  {t(`envManagement.stage10.bindingMode.${m}`)}
                </button>
              ))}
            </div>

            {filterMode === 'allowlist' && (
              <ToolCheckboxGrid
                value={binding.allowed ?? []}
                onChange={setAllowed}
                mode="allowlist"
                hint={t('envManagement.stage10.allowedHint')}
                hideBulkControls
              />
            )}
            {filterMode === 'blocklist' && (
              <ToolCheckboxGrid
                value={binding.blocked ?? []}
                onChange={setBlocked}
                mode="blocklist"
                hint={t('envManagement.stage10.blockedHint')}
                hideBulkControls
              />
            )}
            {filterMode === 'inherit' && (
              <p className="text-[0.7rem] text-[hsl(var(--muted-foreground))] italic">
                {t('envManagement.stage10.inheritHint')}
              </p>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
