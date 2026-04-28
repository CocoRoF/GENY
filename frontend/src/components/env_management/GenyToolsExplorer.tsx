'use client';

/**
 * GenyToolsExplorer — rich curated picker for the Geny-side tool
 * catalog (`GenyToolProvider`, exposed at `/api/tools/catalog/external`).
 *
 * Mirrors BuiltinToolsExplorer's card-based layout: per-category
 * sections with icons, capability-free tool cards (Geny tools don't
 * carry the executor-side capability metadata), search, select-all/
 * clear, and quick presets that target sub-families derived from
 * the tool name prefix (memory_* / knowledge_* / opsidian_* / etc.).
 *
 * Localised descriptions: the catalog endpoint accepts `?lang=ko`
 * and returns the Korean translations from
 * `backend/controller/_tool_descriptions_ko.py`. The current locale
 * from useI18n is forwarded so the picker stays in sync with the
 * rest of the UI.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Bell,
  BookOpen,
  Brain,
  Check,
  Clock,
  Compass,
  Database,
  FolderTree,
  Gamepad2,
  Globe,
  HelpCircle,
  Inbox,
  Loader2,
  MessageCircle,
  Network,
  Newspaper,
  RefreshCw,
  Search,
  Send,
  Sparkles,
  Square,
  Users,
  Wrench,
  X,
  Zap,
} from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import {
  externalToolCatalogApi,
  type ExternalToolEntry,
} from '@/lib/api';
import { Input } from '@/components/ui/input';
import ToolDetailModal from './tool_help/ToolDetailModal';
// Side-effect: registers per-tool deep content into the help registry.
import './tool_help/content';

export interface GenyToolsExplorerProps {
  value: string[];
  onChange: (next: string[]) => void;
}

interface SubFamily {
  id: string;
  /** Tool-name prefix used to bucket entries (without trailing _). */
  prefix: string;
  icon: React.ComponentType<{ className?: string }>;
}

/** Sub-categories derived from tool name prefixes. The base catalog
 *  groups everything as `built_in` / `custom`; the prefix-based
 *  family inside is a UI concept that doesn't change semantics. */
const SUB_FAMILIES: SubFamily[] = [
  { id: 'memory', prefix: 'memory_', icon: Brain },
  { id: 'knowledge', prefix: 'knowledge_', icon: BookOpen },
  { id: 'opsidian', prefix: 'opsidian_', icon: FolderTree },
  { id: 'session', prefix: 'session_', icon: Users },
  { id: 'room', prefix: 'room_', icon: MessageCircle },
  { id: 'browser', prefix: 'browser_', icon: Globe },
  { id: 'web', prefix: 'web_', icon: Network },
];

/** Exact-name mappings for tools whose names don't fit a clean prefix. */
const EXPLICIT_FAMILY_MAP: Record<string, string> = {
  send_room_message: 'room',
  send_direct_message_external: 'messaging',
  send_direct_message_internal: 'messaging',
  read_room_messages: 'room',
  read_inbox: 'messaging',
  news_search: 'web',
  feed: 'game',
  gift: 'game',
  play: 'game',
  talk: 'game',
};

const EXTRA_FAMILY_ICONS: Record<
  string,
  React.ComponentType<{ className?: string }>
> = {
  messaging: Inbox,
  game: Gamepad2,
  news: Newspaper,
  database: Database,
  cron: Clock,
  notification: Bell,
  meta: Compass,
  send: Send,
  sparkles: Sparkles,
};

interface PresetDef {
  id: string;
  families: string[];
}

const PRESETS: PresetDef[] = [
  { id: 'memory', families: ['memory', 'knowledge', 'opsidian'] },
  { id: 'team', families: ['session', 'room', 'messaging'] },
  { id: 'web', families: ['browser', 'web'] },
  { id: 'game', families: ['game'] },
];

function familyOf(toolName: string): string {
  if (toolName in EXPLICIT_FAMILY_MAP) return EXPLICIT_FAMILY_MAP[toolName];
  for (const fam of SUB_FAMILIES) {
    if (toolName.startsWith(fam.prefix)) return fam.id;
  }
  return 'other';
}

function familyIcon(id: string): React.ComponentType<{ className?: string }> {
  const sub = SUB_FAMILIES.find((s) => s.id === id);
  if (sub) return sub.icon;
  if (id in EXTRA_FAMILY_ICONS) return EXTRA_FAMILY_ICONS[id];
  return Wrench;
}

const FAMILY_ORDER = [
  'memory',
  'knowledge',
  'opsidian',
  'session',
  'room',
  'messaging',
  'game',
  'browser',
  'web',
  'other',
];

export default function GenyToolsExplorer({
  value,
  onChange,
}: GenyToolsExplorerProps) {
  const { t } = useI18n();
  const locale = useI18n((s) => s.locale);
  const [tools, setTools] = useState<ExternalToolEntry[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [detailTool, setDetailTool] = useState<ExternalToolEntry | null>(null);

  // Re-fetch whenever the locale flips so descriptions stay in sync.
  useEffect(() => {
    let cancelled = false;
    const fetch = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await externalToolCatalogApi.list(locale);
        if (!cancelled) setTools(res.tools);
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    fetch();
    return () => {
      cancelled = true;
    };
  }, [locale]);

  const selectedSet = useMemo(() => new Set(value), [value]);

  const grouped = useMemo(() => {
    const m = new Map<string, ExternalToolEntry[]>();
    if (!tools) return m;
    for (const tool of tools) {
      const fam = familyOf(tool.name);
      if (!m.has(fam)) m.set(fam, []);
      m.get(fam)!.push(tool);
    }
    const ordered = new Map<string, ExternalToolEntry[]>();
    for (const family of FAMILY_ORDER) {
      if (m.has(family)) ordered.set(family, m.get(family)!);
    }
    for (const [k, v] of m) {
      if (!ordered.has(k)) ordered.set(k, v);
    }
    // Sort tools alphabetically within each family for stable display.
    for (const list of ordered.values()) {
      list.sort((a, b) => a.name.localeCompare(b.name));
    }
    return ordered;
  }, [tools]);

  const filteredGroups = useMemo(() => {
    if (!tools) return new Map<string, ExternalToolEntry[]>();
    const q = search.trim().toLowerCase();
    if (!q) return grouped;
    const out = new Map<string, ExternalToolEntry[]>();
    for (const [family, list] of grouped) {
      const hits = list.filter((tool) => {
        const hay = `${tool.name} ${tool.description || ''}`.toLowerCase();
        return hay.includes(q);
      });
      if (hits.length > 0) out.set(family, hits);
    }
    return out;
  }, [grouped, search, tools]);

  const totalCount = tools?.length ?? 0;
  const selectedCount = value.length;

  const toggleTool = (name: string) => {
    const set = new Set(value);
    if (set.has(name)) set.delete(name);
    else set.add(name);
    onChange(Array.from(set));
  };

  const toggleFamily = (family: string) => {
    const list = grouped.get(family) ?? [];
    const names = list.map((t) => t.name);
    const set = new Set(value);
    const allOn = names.every((n) => set.has(n));
    if (allOn) names.forEach((n) => set.delete(n));
    else names.forEach((n) => set.add(n));
    onChange(Array.from(set));
  };

  const applyPreset = (preset: PresetDef) => {
    const set = new Set(value);
    for (const family of preset.families) {
      const list = grouped.get(family) ?? [];
      list.forEach((t) => set.add(t.name));
    }
    onChange(Array.from(set));
  };

  const handleSelectAll = () => {
    if (!tools) return;
    onChange(tools.map((t) => t.name));
  };
  const handleClear = () => onChange([]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-6 text-[hsl(var(--muted-foreground))] text-[0.8125rem]">
        <Loader2 className="w-4 h-4 animate-spin" />
        {t('envManagement.genyTools.loading')}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-between gap-3 px-3 py-2 rounded-md bg-red-500/10 border border-red-500/30 text-[0.75rem] text-red-700 dark:text-red-300">
        <span className="flex items-center gap-2">
          <AlertTriangle className="w-3.5 h-3.5" />
          {t('envManagement.genyTools.loadError', { error })}
        </span>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="inline-flex items-center gap-1 text-[0.7rem] underline hover:no-underline"
        >
          <RefreshCw className="w-3 h-3" />
          {t('common.refresh')}
        </button>
      </div>
    );
  }

  if (!tools || tools.length === 0) {
    return (
      <div className="text-[0.8125rem] italic text-[hsl(var(--muted-foreground))] py-4">
        {t('envManagement.genyTools.empty')}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* ── Quick presets ── */}
      <section>
        <h4 className="text-[0.625rem] uppercase tracking-wider font-semibold text-[hsl(var(--muted-foreground))] mb-2">
          {t('envManagement.genyExplorer.presetsTitle')}
        </h4>
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => applyPreset(preset)}
              title={preset.families.join(' + ')}
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] text-[0.75rem] font-medium text-[hsl(var(--foreground))] hover:border-[hsl(var(--primary)/0.4)] hover:bg-[hsl(var(--primary)/0.06)] hover:text-[hsl(var(--primary))] transition-colors"
            >
              <Zap className="w-3.5 h-3.5" />
              {t(`envManagement.genyExplorer.preset.${preset.id}`)}
            </button>
          ))}
          <button
            type="button"
            onClick={handleSelectAll}
            disabled={selectedCount === totalCount}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] text-[0.75rem] font-medium text-[hsl(var(--foreground))] hover:border-[hsl(var(--primary)/0.4)] hover:bg-[hsl(var(--primary)/0.06)] hover:text-[hsl(var(--primary))] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <Sparkles className="w-3.5 h-3.5" />
            {t('envManagement.genyExplorer.preset.everything')}
          </button>
          <button
            type="button"
            onClick={handleClear}
            disabled={selectedCount === 0}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] text-[0.75rem] font-medium text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--destructive))] hover:border-[hsl(var(--destructive)/0.4)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <X className="w-3.5 h-3.5" />
            {t('envManagement.genyExplorer.preset.clear')}
          </button>
        </div>
      </section>

      {/* ── Search + status ── */}
      <section className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-[360px]">
          <Search
            size={14}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[hsl(var(--muted-foreground))] pointer-events-none"
          />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('envManagement.genyTools.searchPlaceholder')}
            className="pl-8 h-9 text-[0.8125rem]"
          />
        </div>
        <div className="ml-auto text-[0.75rem] text-[hsl(var(--muted-foreground))] tabular-nums">
          <span className="font-semibold text-[hsl(var(--foreground))]">
            {selectedCount}
          </span>{' '}
          / {totalCount}{' '}
          {t('envManagement.builtinExplorer.selectedSuffix')}
        </div>
      </section>

      {/* ── Family sections ── */}
      <section className="flex flex-col gap-3">
        {Array.from(filteredGroups.entries()).map(([family, list]) => (
          <FamilySection
            key={family}
            family={family}
            list={list}
            allList={grouped.get(family) ?? list}
            selectedSet={selectedSet}
            onToggleTool={toggleTool}
            onToggleFamily={toggleFamily}
            onShowDetail={(tool) => setDetailTool(tool)}
          />
        ))}
        {filteredGroups.size === 0 && (
          <div className="text-[0.8125rem] italic text-[hsl(var(--muted-foreground))] py-6 text-center">
            {t('envManagement.genyExplorer.noMatch')}
          </div>
        )}
      </section>

      <ToolDetailModal
        open={detailTool !== null}
        onClose={() => setDetailTool(null)}
        name={detailTool?.name ?? null}
        description={detailTool?.description ?? ''}
        family={detailTool?.category}
      />
    </div>
  );
}

function FamilySection({
  family,
  list,
  allList,
  selectedSet,
  onToggleTool,
  onToggleFamily,
  onShowDetail,
}: {
  family: string;
  list: ExternalToolEntry[];
  allList: ExternalToolEntry[];
  selectedSet: Set<string>;
  onToggleTool: (name: string) => void;
  onToggleFamily: (family: string) => void;
  onShowDetail: (tool: ExternalToolEntry) => void;
}) {
  const { t } = useI18n();
  const Icon = familyIcon(family);
  const allNames = allList.map((tt) => tt.name);
  const selectedInFamily = allNames.filter((n) => selectedSet.has(n)).length;
  const allOn = selectedInFamily === allNames.length;
  const noneOn = selectedInFamily === 0;
  const familyLabel = t(`envManagement.genyExplorer.family.${family}`);

  return (
    <section className="rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))]">
      <header className="flex items-center gap-3 px-3 py-2.5 border-b border-[hsl(var(--border))]">
        <span className="inline-flex items-center justify-center w-8 h-8 rounded-md bg-[hsl(var(--primary)/0.08)] text-[hsl(var(--primary))] shrink-0">
          <Icon className="w-4 h-4" />
        </span>
        <div className="flex-1 min-w-0">
          <h4 className="text-[0.875rem] font-semibold text-[hsl(var(--foreground))]">
            {familyLabel}
          </h4>
          <p className="text-[0.6875rem] text-[hsl(var(--muted-foreground))] tabular-nums">
            {selectedInFamily} / {allNames.length}{' '}
            {t('envManagement.builtinExplorer.selectedSuffix')}
          </p>
        </div>
        <button
          type="button"
          onClick={() => onToggleFamily(family)}
          className={`inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border text-[0.7rem] font-medium transition-colors ${
            allOn
              ? 'border-[hsl(var(--border))] bg-[hsl(var(--background))] text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--destructive))] hover:border-[hsl(var(--destructive)/0.4)]'
              : 'border-[hsl(var(--primary)/0.4)] bg-[hsl(var(--primary)/0.08)] text-[hsl(var(--primary))] hover:bg-[hsl(var(--primary)/0.16)]'
          }`}
        >
          {allOn
            ? t('envManagement.builtinExplorer.family.clear')
            : noneOn
              ? t('envManagement.builtinExplorer.family.selectAll')
              : t('envManagement.builtinExplorer.family.completeAll')}
        </button>
      </header>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2 p-3">
        {list.map((tool) => (
          <ToolCard
            key={tool.name}
            tool={tool}
            checked={selectedSet.has(tool.name)}
            onToggle={() => onToggleTool(tool.name)}
            onShowDetail={() => onShowDetail(tool)}
          />
        ))}
      </div>
    </section>
  );
}

function ToolCard({
  tool,
  checked,
  onToggle,
  onShowDetail,
}: {
  tool: ExternalToolEntry;
  checked: boolean;
  onToggle: () => void;
  onShowDetail: () => void;
}) {
  const { t } = useI18n();
  return (
    <div
      onClick={onToggle}
      className={`group relative flex flex-col gap-2 p-3 rounded-md border text-left cursor-pointer transition-all ${
        checked
          ? 'border-[hsl(var(--primary)/0.5)] bg-[hsl(var(--primary)/0.06)] shadow-sm'
          : 'border-[hsl(var(--border))] bg-[hsl(var(--card))] hover:border-[hsl(var(--primary)/0.3)] hover:bg-[hsl(var(--accent))]'
      }`}
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onShowDetail();
        }}
        title={t('envManagement.toolDetail.openTip')}
        aria-label={t('envManagement.toolDetail.openTip')}
        className="absolute right-2 top-2 inline-flex items-center justify-center w-6 h-6 rounded-md text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--primary))] hover:bg-[hsl(var(--accent))] transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100"
      >
        <HelpCircle className="w-3.5 h-3.5" />
      </button>
      <div className="flex items-start gap-2 pr-6">
        <span
          className={`shrink-0 mt-0.5 inline-flex items-center justify-center w-4 h-4 rounded transition-colors ${
            checked
              ? 'bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]'
              : 'bg-[hsl(var(--background))] border border-[hsl(var(--border))] text-transparent group-hover:border-[hsl(var(--primary)/0.4)]'
          }`}
        >
          {checked ? (
            <Check className="w-3 h-3" strokeWidth={3} />
          ) : (
            <Square className="w-3 h-3 opacity-0" />
          )}
        </span>
        <code className="text-[0.8125rem] font-mono font-semibold text-[hsl(var(--foreground))] truncate flex-1">
          {tool.name}
        </code>
        {tool.category && (
          <span className="shrink-0 text-[0.625rem] uppercase tracking-wider px-1.5 py-0.5 rounded font-medium bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))] border border-[hsl(var(--border))]">
            {tool.category}
          </span>
        )}
      </div>
      {tool.description && (
        <p className="text-[0.7rem] text-[hsl(var(--muted-foreground))] leading-relaxed line-clamp-3">
          {tool.description}
        </p>
      )}
    </div>
  );
}
