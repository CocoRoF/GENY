'use client';

/**
 * BuiltinToolsExplorer — rich curated picker for the executor's
 * BUILT_IN_TOOL_CLASSES catalog. Replaces the dense ToolCheckboxGrid
 * for the Globals → Executor Built-in panel.
 *
 * Layout philosophy:
 *
 *   - Full panel width, no fixed-height scroll container — the parent
 *     surface scrolls. The grid breathes.
 *   - Each tool is a card: name + one-line description + capability
 *     chips (read-only / destructive / network / parallel / idempotent).
 *     Clicking the card toggles selection; the whole surface is the
 *     hit target, not just the checkbox.
 *   - Each feature family is a section with its own icon, count,
 *     "select / clear family" toggle. No collapse — the family is
 *     either visible or filtered out by search.
 *   - Filter chips above the grid narrow by capability ("read-only
 *     only", "no network", "no destructive").
 *   - Quick-pick presets at the top apply curated bundles ("Code
 *     agent", "Research agent", "Operator agent", etc.) so users
 *     don't have to hand-toggle 20 tools to express common roles.
 *
 * Wildcard \`["*"]\` semantics preserved: it stays an explicit "all
 * tools, even future additions" mode, distinct from selecting all
 * names individually.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Bell,
  Check,
  Clock,
  Code2,
  Compass,
  Eye,
  FolderTree,
  GitBranch,
  Globe,
  ListChecks,
  ListTodo,
  Loader2,
  MessageCircleQuestion,
  Network,
  Plug,
  RefreshCw,
  Search,
  Send,
  Settings,
  Sparkles,
  Square,
  Terminal,
  Users,
  Wrench,
  X,
  Zap,
} from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import {
  frameworkToolApi,
  type FrameworkToolDetail,
} from '@/lib/api';
import { Input } from '@/components/ui/input';

export interface BuiltinToolsExplorerProps {
  value: string[];
  onChange: (next: string[]) => void;
}

type CapabilityFilter = 'all' | 'read_only' | 'no_destructive' | 'no_network';

interface PresetDef {
  id: string;
  families: string[];
}

const PRESETS: PresetDef[] = [
  { id: 'code', families: ['filesystem', 'shell', 'dev', 'meta'] },
  { id: 'research', families: ['web', 'meta', 'workflow'] },
  { id: 'operator', families: ['operator', 'cron', 'tasks'] },
  { id: 'orchestrator', families: ['agent', 'workflow', 'tasks', 'meta'] },
  { id: 'communication', families: ['messaging', 'interaction', 'notification'] },
  { id: 'mcp', families: ['mcp'] },
];

const FAMILY_ICONS: Record<
  string,
  React.ComponentType<{ className?: string }>
> = {
  filesystem: FolderTree,
  shell: Terminal,
  web: Globe,
  workflow: ListChecks,
  meta: Compass,
  agent: Users,
  tasks: ListTodo,
  interaction: MessageCircleQuestion,
  notification: Bell,
  mcp: Plug,
  worktree: GitBranch,
  dev: Code2,
  operator: Settings,
  messaging: Send,
  cron: Clock,
};

const FAMILY_ORDER = [
  'filesystem',
  'shell',
  'web',
  'meta',
  'workflow',
  'agent',
  'tasks',
  'interaction',
  'notification',
  'messaging',
  'mcp',
  'worktree',
  'dev',
  'operator',
  'cron',
];

export default function BuiltinToolsExplorer({
  value,
  onChange,
}: BuiltinToolsExplorerProps) {
  const { t } = useI18n();
  const [tools, setTools] = useState<FrameworkToolDetail[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<CapabilityFilter>('all');

  useEffect(() => {
    let cancelled = false;
    const fetch = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await frameworkToolApi.list();
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
  }, []);

  const isWildcard = value.includes('*');
  const selectedSet = useMemo(() => new Set(value), [value]);

  const grouped = useMemo(() => {
    const m = new Map<string, FrameworkToolDetail[]>();
    if (!tools) return m;
    for (const tool of tools) {
      const g = tool.feature_group || 'other';
      if (!m.has(g)) m.set(g, []);
      m.get(g)!.push(tool);
    }
    // Stable, opinionated family ordering — frequently-used families
    // first so the user sees the obvious picks without scrolling.
    const ordered = new Map<string, FrameworkToolDetail[]>();
    for (const family of FAMILY_ORDER) {
      if (m.has(family)) ordered.set(family, m.get(family)!);
    }
    for (const [k, v] of m) {
      if (!ordered.has(k)) ordered.set(k, v);
    }
    return ordered;
  }, [tools]);

  const filteredGroups = useMemo(() => {
    if (!tools) return new Map<string, FrameworkToolDetail[]>();
    const q = search.trim().toLowerCase();
    const out = new Map<string, FrameworkToolDetail[]>();
    for (const [family, list] of grouped) {
      const hits = list.filter((tool) => {
        if (q) {
          const hay = `${tool.name} ${tool.description || ''}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        const caps = tool.capabilities ?? {};
        if (filter === 'read_only' && !caps.read_only) return false;
        if (filter === 'no_destructive' && caps.destructive) return false;
        if (filter === 'no_network' && caps.network_egress) return false;
        return true;
      });
      if (hits.length > 0) out.set(family, hits);
    }
    return out;
  }, [grouped, search, filter, tools]);

  const totalCount = tools?.length ?? 0;
  const selectedCount = isWildcard ? totalCount : value.length;

  // ── Mutators ──
  const replaceWildcardFirst = (): string[] => {
    if (!isWildcard) return [...value];
    return tools ? tools.map((t) => t.name) : [];
  };

  const toggleTool = (name: string) => {
    const base = replaceWildcardFirst();
    const set = new Set(base);
    if (set.has(name)) set.delete(name);
    else set.add(name);
    onChange(Array.from(set));
  };

  const toggleFamily = (family: string) => {
    const list = grouped.get(family) ?? [];
    const names = list.map((t) => t.name);
    const base = replaceWildcardFirst();
    const set = new Set(base);
    const allOn = names.every((n) => set.has(n));
    if (allOn) names.forEach((n) => set.delete(n));
    else names.forEach((n) => set.add(n));
    onChange(Array.from(set));
  };

  const applyPreset = (preset: PresetDef) => {
    const base = replaceWildcardFirst();
    const set = new Set(base);
    for (const family of preset.families) {
      const list = grouped.get(family) ?? [];
      list.forEach((t) => set.add(t.name));
    }
    onChange(Array.from(set));
  };

  const handleWildcard = () => onChange(['*']);
  const handleClear = () => onChange([]);

  // ── Render ──
  if (loading) {
    return (
      <div className="flex items-center gap-2 py-6 text-[hsl(var(--muted-foreground))] text-[0.8125rem]">
        <Loader2 className="w-4 h-4 animate-spin" />
        {t('common.loading')}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-between gap-3 px-3 py-2 rounded-md bg-red-500/10 border border-red-500/30 text-[0.75rem] text-red-700 dark:text-red-300">
        <span className="flex items-center gap-2">
          <AlertTriangle className="w-3.5 h-3.5" />
          {error}
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
        {t('envManagement.builtinExplorer.empty')}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* ── Wildcard banner ── */}
      {isWildcard && (
        <div className="flex items-start gap-3 px-4 py-3 rounded-md border border-[hsl(var(--primary)/0.3)] bg-[hsl(var(--primary)/0.06)]">
          <Sparkles className="w-4 h-4 text-[hsl(var(--primary))] mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-[0.8125rem] font-semibold text-[hsl(var(--foreground))]">
              {t('envManagement.builtinExplorer.wildcardTitle')}
            </div>
            <p className="text-[0.7rem] text-[hsl(var(--muted-foreground))] leading-relaxed mt-0.5">
              {t('envManagement.builtinExplorer.wildcardHint')}
            </p>
          </div>
          <button
            type="button"
            onClick={() => onChange(replaceWildcardFirst())}
            className="shrink-0 inline-flex items-center gap-1 h-7 px-2.5 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] text-[0.7rem] font-medium hover:bg-[hsl(var(--accent))] transition-colors"
          >
            {t('envManagement.builtinExplorer.unfreeze')}
          </button>
        </div>
      )}

      {/* ── Quick presets ── */}
      <section>
        <h4 className="text-[0.625rem] uppercase tracking-wider font-semibold text-[hsl(var(--muted-foreground))] mb-2">
          {t('envManagement.builtinExplorer.presetsTitle')}
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
              {t(`envManagement.builtinExplorer.preset.${preset.id}`)}
            </button>
          ))}
          <button
            type="button"
            onClick={handleWildcard}
            disabled={isWildcard}
            className={`inline-flex items-center gap-1.5 h-8 px-3 rounded-md border text-[0.75rem] font-medium transition-colors ${
              isWildcard
                ? 'border-[hsl(var(--primary)/0.4)] bg-[hsl(var(--primary)/0.08)] text-[hsl(var(--primary))]'
                : 'border-[hsl(var(--border))] bg-[hsl(var(--background))] hover:border-[hsl(var(--primary)/0.4)] hover:bg-[hsl(var(--primary)/0.06)] hover:text-[hsl(var(--primary))]'
            }`}
          >
            <Sparkles className="w-3.5 h-3.5" />
            {t('envManagement.builtinExplorer.preset.everything')}
          </button>
          <button
            type="button"
            onClick={handleClear}
            disabled={value.length === 0}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] text-[0.75rem] font-medium text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--destructive))] hover:border-[hsl(var(--destructive)/0.4)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <X className="w-3.5 h-3.5" />
            {t('envManagement.builtinExplorer.preset.clear')}
          </button>
        </div>
      </section>

      {/* ── Search + filter chips + status ── */}
      <section className="flex flex-col gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[200px] max-w-[360px]">
            <Search
              size={14}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[hsl(var(--muted-foreground))] pointer-events-none"
            />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('envManagement.builtinExplorer.searchPlaceholder')}
              className="pl-8 h-9 text-[0.8125rem]"
            />
          </div>

          <FilterChip
            active={filter === 'all'}
            onClick={() => setFilter('all')}
            label={t('envManagement.builtinExplorer.filter.all')}
          />
          <FilterChip
            active={filter === 'read_only'}
            onClick={() => setFilter('read_only')}
            label={t('envManagement.builtinExplorer.filter.readOnly')}
            tone="emerald"
            icon={Eye}
          />
          <FilterChip
            active={filter === 'no_destructive'}
            onClick={() => setFilter('no_destructive')}
            label={t('envManagement.builtinExplorer.filter.noDestructive')}
            tone="amber"
          />
          <FilterChip
            active={filter === 'no_network'}
            onClick={() => setFilter('no_network')}
            label={t('envManagement.builtinExplorer.filter.noNetwork')}
            tone="amber"
          />

          <div className="ml-auto text-[0.75rem] text-[hsl(var(--muted-foreground))] tabular-nums">
            <span className="font-semibold text-[hsl(var(--foreground))]">
              {selectedCount}
            </span>{' '}
            / {totalCount}{' '}
            {t('envManagement.builtinExplorer.selectedSuffix')}
          </div>
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
            isWildcard={isWildcard}
            selectedSet={selectedSet}
            onToggleTool={toggleTool}
            onToggleFamily={toggleFamily}
          />
        ))}
        {filteredGroups.size === 0 && (
          <div className="text-[0.8125rem] italic text-[hsl(var(--muted-foreground))] py-6 text-center">
            {t('envManagement.builtinExplorer.noMatch')}
          </div>
        )}
      </section>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────

function FilterChip({
  active,
  onClick,
  label,
  tone,
  icon: Icon,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  tone?: 'emerald' | 'amber';
  icon?: React.ComponentType<{ className?: string }>;
}) {
  const activeStyles =
    tone === 'emerald'
      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
      : tone === 'amber'
        ? 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300'
        : 'border-[hsl(var(--primary)/0.4)] bg-[hsl(var(--primary)/0.1)] text-[hsl(var(--primary))]';
  const idleStyles =
    'border-[hsl(var(--border))] bg-[hsl(var(--background))] text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))]';
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 h-9 px-3 rounded-md border text-[0.75rem] font-medium transition-colors ${
        active ? activeStyles : idleStyles
      }`}
    >
      {Icon && <Icon className="w-3.5 h-3.5" />}
      {label}
    </button>
  );
}

function FamilySection({
  family,
  list,
  allList,
  isWildcard,
  selectedSet,
  onToggleTool,
  onToggleFamily,
}: {
  family: string;
  list: FrameworkToolDetail[];
  allList: FrameworkToolDetail[];
  isWildcard: boolean;
  selectedSet: Set<string>;
  onToggleTool: (name: string) => void;
  onToggleFamily: (family: string) => void;
}) {
  const { t } = useI18n();
  const Icon = FAMILY_ICONS[family] ?? Wrench;
  const allNames = allList.map((tt) => tt.name);
  const selectedInFamily = isWildcard
    ? allNames.length
    : allNames.filter((n) => selectedSet.has(n)).length;
  const allOn = isWildcard || selectedInFamily === allNames.length;
  const noneOn = !isWildcard && selectedInFamily === 0;

  return (
    <section className="rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))]">
      <header className="flex items-center gap-3 px-3 py-2.5 border-b border-[hsl(var(--border))]">
        <span className="inline-flex items-center justify-center w-8 h-8 rounded-md bg-[hsl(var(--primary)/0.08)] text-[hsl(var(--primary))] shrink-0">
          <Icon className="w-4 h-4" />
        </span>
        <div className="flex-1 min-w-0">
          <h4 className="text-[0.875rem] font-semibold text-[hsl(var(--foreground))] capitalize">
            {family}
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
            checked={isWildcard || selectedSet.has(tool.name)}
            onToggle={() => onToggleTool(tool.name)}
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
}: {
  tool: FrameworkToolDetail;
  checked: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  const caps = tool.capabilities ?? {};
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`group flex flex-col gap-2 p-3 rounded-md border text-left transition-all ${
        checked
          ? 'border-[hsl(var(--primary)/0.5)] bg-[hsl(var(--primary)/0.06)] shadow-sm'
          : 'border-[hsl(var(--border))] bg-[hsl(var(--card))] hover:border-[hsl(var(--primary)/0.3)] hover:bg-[hsl(var(--accent))]'
      }`}
    >
      <div className="flex items-start gap-2">
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
      </div>
      {tool.description && (
        <p className="text-[0.7rem] text-[hsl(var(--muted-foreground))] leading-relaxed line-clamp-3">
          {tool.description}
        </p>
      )}
      <div className="flex items-center gap-1 flex-wrap mt-auto">
        {caps.read_only && (
          <CapabilityChip
            label={t('envManagement.builtinExplorer.cap.readOnly')}
            tone="emerald"
            icon={Eye}
          />
        )}
        {caps.destructive && (
          <CapabilityChip
            label={t('envManagement.builtinExplorer.cap.destructive')}
            tone="red"
            icon={AlertTriangle}
          />
        )}
        {caps.network_egress && (
          <CapabilityChip
            label={t('envManagement.builtinExplorer.cap.network')}
            tone="amber"
            icon={Network}
          />
        )}
        {caps.concurrency_safe && (
          <CapabilityChip
            label={t('envManagement.builtinExplorer.cap.parallel')}
            tone="blue"
          />
        )}
        {caps.idempotent && (
          <CapabilityChip
            label={t('envManagement.builtinExplorer.cap.idempotent')}
            tone="gray"
          />
        )}
      </div>
    </button>
  );
}

function CapabilityChip({
  label,
  tone,
  icon: Icon,
}: {
  label: string;
  tone: 'emerald' | 'red' | 'amber' | 'blue' | 'gray';
  icon?: React.ComponentType<{ className?: string }>;
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
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[0.625rem] font-medium uppercase tracking-wider border ${map[tone]}`}
    >
      {Icon && <Icon className="w-2.5 h-2.5" />}
      {label}
    </span>
  );
}
