'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useOpsidianStore, type SidebarPanel } from '@/store/useOpsidianStore';
import { useI18n } from '@/lib/i18n';
import {
  FolderOpen,
  File,
  Tag,
  Link2,
  ChevronRight,
  ChevronDown,
  Search,
  GitGraph,
  Sparkles,
  FileText,
  PanelLeftClose,
  PanelLeftOpen,
  ArrowLeft,
  RefreshCw,
  MessageSquare,
} from 'lucide-react';

// CATEGORY_ICONS now lives in `@/lib/memoryCategories` — single
// source of truth shared with MemoryTab / QuickSwitcher /
// WikilinkPicker / NoteViewer. Re-export for the existing call
// sites in this file (which use the local name).
import { CATEGORY_ICONS as SHARED_CATEGORY_ICONS } from '@/lib/memoryCategories';
const CATEGORY_ICONS = SHARED_CATEGORY_ICONS;

const CATEGORY_COLORS: Record<string, string> = {
  daily: '#f59e0b',
  topics: '#3b82f6',
  projects: '#8b5cf6',
  insights: '#ec4899',
  root: '#64748b',
};

const IMPORTANCE_DOT: Record<string, string> = {
  critical: '#ef4444',
  high: '#f59e0b',
  medium: '#3b82f6',
  low: '#64748b',
};

// Time-series categories — render their files grouped under date headers
// (newest day first) instead of one flat list, so daily / observations /
// executions read by date. Shared with the loader, which uses the same
// split to decide whether a category expands into days or into notes.
import {
  DATE_GROUPED_CATEGORIES,
  loadCategory,
  loadDay,
  ensureFullIndex,
  openVault,
  openNote,
} from '@/lib/vaultCatalog';

type _FileLike = { modified?: string; created?: string };

/** Group files into ``[YYYY-MM-DD, files][]`` sorted newest-day first. Files
 *  with no date fall into an "—" bucket sorted last. */
function groupFilesByDate<T extends _FileLike>(files: T[]): Array<[string, T[]]> {
  const buckets: Record<string, T[]> = {};
  for (const f of files) {
    const raw = f.modified || f.created || '';
    const day = raw.length >= 10 ? raw.slice(0, 10) : '—';
    (buckets[day] ||= []).push(f);
  }
  return Object.entries(buckets).sort((a, b) => {
    if (a[0] === '—') return 1;
    if (b[0] === '—') return -1;
    return b[0].localeCompare(a[0]);
  });
}

export default function OpsidianSidebar() {
  const {
    files,
    categories,
    selectedFile,
    selectedSessionId,
    sidebarCollapsed,
    sidebarPanel,
    viewMode,
    memoryIndex,
    overview,
    daysByCategory,
    loadedDays,
    setSidebarCollapsed,
    setSidebarPanel,
    setViewMode,
    setLoading,
  } = useOpsidianStore();
  const { t } = useI18n();

  // Everything starts COLLAPSED — a long-running session accumulates
  // thousands of dated notes, so the tree must open one level at a time
  // (category → date → notes), never as one flat dump.
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(
    new Set()
  );
  // Date sub-groups inside time-series categories, keyed `${cat}/${day}`.
  const [expandedDates, setExpandedDates] = useState<Set<string>>(new Set());
  const [filterText, setFilterText] = useState('');
  // A live filter overrides collapse state — matches must be visible.
  const isFiltering = filterText.trim().length > 0;

  // Expanding is what triggers a fetch — that is the whole point of the
  // tree. Collapsing fetches nothing, and an already-loaded day is free
  // the second time (the loader short-circuits on `loadedDays`).
  const toggleCategory = (cat: string) => {
    const opening = !expandedCategories.has(cat);
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
    if (opening && selectedSessionId) {
      loadCategory(selectedSessionId, cat).catch((e) =>
        console.error(`Failed to open category ${cat}:`, e),
      );
    }
  };

  const toggleDate = (cat: string, day: string) => {
    const key = `${cat}/${day}`;
    const opening = !expandedDates.has(key);
    setExpandedDates((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    if (opening && selectedSessionId) {
      loadDay(selectedSessionId, cat, day).catch((e) =>
        console.error(`Failed to open ${key}:`, e),
      );
    }
  };

  // Tags and backlinks are whole-vault questions; their panels pay for
  // the full index the first time one of them is opened, rather than
  // every session open paying for panels nobody looked at.
  useEffect(() => {
    if (!selectedSessionId) return;
    if (sidebarPanel !== 'tags' && sidebarPanel !== 'backlinks') return;
    ensureFullIndex(selectedSessionId).catch((e) =>
      console.error('Failed to load the full index:', e),
    );
  }, [sidebarPanel, selectedSessionId]);

  // Reveal the selection: a note opened from anywhere else (graph node,
  // wikilink, search, digest) expands its category + date group so the
  // tree always shows where you are. Implemented as the React
  // "adjust state during render" pattern (not an effect) — the lint
  // forbids setState inside effects, and this genuinely derives from
  // the store's selection.
  const [lastRevealed, setLastRevealed] = useState<string | null>(null);
  if (selectedFile && selectedFile !== lastRevealed && files[selectedFile]) {
    setLastRevealed(selectedFile);
    const f = files[selectedFile];
    const cat = f.category || 'root';
    if (!expandedCategories.has(cat)) {
      setExpandedCategories(new Set(expandedCategories).add(cat));
    }
    if (DATE_GROUPED_CATEGORIES.has(cat)) {
      const raw = f.modified || f.created || '';
      const day = raw.length >= 10 ? raw.slice(0, 10) : '—';
      const key = `${cat}/${day}`;
      if (!expandedDates.has(key)) {
        setExpandedDates(new Set(expandedDates).add(key));
      }
    }
  }

  // Scroll the now-visible active row into view (pure DOM side effect).
  useEffect(() => {
    if (!selectedFile) return;
    const raf = requestAnimationFrame(() => {
      document
        .querySelector('.obs-sb-file.active')
        ?.scrollIntoView({ block: 'nearest' });
    });
    return () => cancelAnimationFrame(raf);
  }, [selectedFile]);

  // Group files by category — every category folder (canonical +
  // host-defined) gets a slot even when it currently holds zero
  // notes. Empty folders render as a dim row with a `(0)` count so
  // the operator sees the full vault structure at all times.
  const grouped = useMemo(() => {
    const groups: Record<string, typeof files[string][]> = {};

    // Seed every known category from the categories API response so
    // empty folders survive into the render pass below.
    for (const c of categories || []) {
      if (c.name) groups[c.name] = [];
    }

    Object.values(files).forEach((f) => {
      const cat = f.category || 'root';
      if (!groups[cat]) groups[cat] = [];
      if (filterText) {
        const q = filterText.toLowerCase();
        if (
          f.title.toLowerCase().includes(q) ||
          f.filename.toLowerCase().includes(q) ||
          f.tags.some((t) => t.includes(q))
        ) {
          groups[cat].push(f);
        }
      } else {
        groups[cat].push(f);
      }
    });
    // Sort files by modified desc
    for (const cat of Object.keys(groups)) {
      groups[cat].sort((a, b) => (b.modified || '').localeCompare(a.modified || ''));
    }
    return groups;
  }, [files, categories, filterText]);

  // Stable order — categories[] from the backend keeps the canonical
  // sort (NOTE_CATEGORIES first, then host-defined alphabetically).
  // Fall back to alphabetical when categories haven't loaded yet.
  const orderedCategoryNames = useMemo(() => {
    const known = new Set<string>();
    const out: string[] = [];
    for (const c of categories || []) {
      if (c.name && !known.has(c.name)) {
        out.push(c.name);
        known.add(c.name);
      }
    }
    // Append any category that appeared in `files` but was missing
    // from the categories API (host-defined that hasn't been picked
    // up yet — corner case).
    for (const cat of Object.keys(grouped)) {
      if (!known.has(cat)) {
        out.push(cat);
        known.add(cat);
      }
    }
    return out;
  }, [categories, grouped]);

  // Counts straight from the catalogue — what a folder holds, whether or
  // not any of it has been fetched. `categories[].file_count` is the
  // fallback for stores with no catalogue.
  const catalogCounts = useMemo(() => {
    const map: Record<string, number> = {};
    for (const c of categories || []) {
      if (c.name && typeof c.file_count === 'number') map[c.name] = c.file_count;
    }
    for (const k of overview?.kinds || []) map[k.kind] = k.count;
    return map;
  }, [categories, overview]);

  /** Day rows for a date-grouped category.
   *
   * Prefers the catalogue (which knows every day, including ones whose
   * notes have never been fetched) and falls back to grouping whatever
   * is loaded — which is what a store with no catalogue, or a filter in
   * progress, has to work with.
   */
  const dayRowsFor = (cat: string): { day: string; count: number }[] => {
    const catalogued = daysByCategory[cat];
    if (catalogued && !isFiltering) return catalogued;
    return groupFilesByDate(grouped[cat] || []).map(([day, fs]) => ({
      day,
      count: fs.length,
    }));
  };

  /** The notes of one day that are actually in hand. Empty until the day
   *  is expanded — which is the design, not a gap. */
  const filesForDay = (cat: string, day: string) =>
    (grouped[cat] || []).filter((f) => {
      const raw = f.modified || f.created || '';
      return (raw.length >= 10 ? raw.slice(0, 10) : '—') === day;
    });

  const categoryDescriptions = useMemo(() => {
    const map: Record<string, string> = {};
    for (const c of categories || []) {
      if (c.description) map[c.name] = c.description;
    }
    return map;
  }, [categories]);

  // Tags from index
  const sortedTags = useMemo(
    () => Object.entries(memoryIndex?.tag_map || {}).sort((a, b) => b[1].length - a[1].length),
    [memoryIndex?.tag_map]
  );

  // Backlinks for selected file
  const backlinks = useMemo(() => {
    if (!selectedFile || !files[selectedFile]) return [];
    return files[selectedFile].linked_from || [];
  }, [selectedFile, files]);

  const handleFileClick = (filename: string) => openNote(selectedSessionId, filename);

  // `aria-current`: the highlight was the ONLY signal that this note is the
  // open one, which leaves anyone not reading colour with nothing.
  const renderFileRow = (f: (typeof files)[string]) => (
    <button
      key={f.filename}
      className={`obs-sb-file ${selectedFile === f.filename ? 'active' : ''}`}
      onClick={() => handleFileClick(f.filename)}
      aria-current={selectedFile === f.filename ? 'true' : undefined}
      title={f.filename}
    >
      <span
        className="obs-sb-imp-dot"
        style={{ background: IMPORTANCE_DOT[f.importance] || IMPORTANCE_DOT.medium }}
      />
      <span className="obs-sb-file-title">{f.title || f.filename}</span>
    </button>
  );

  // Refresh re-asks the counts. It deliberately does NOT re-pull every
  // note: what is open stays open and re-fetches on the next expand, and
  // refreshing a vault must not cost more than opening one.
  const handleRefresh = async () => {
    if (!selectedSessionId) return;
    setLoading(true);
    try {
      await openVault(selectedSessionId);
      useOpsidianStore.setState({ daysByCategory: {}, loadedDays: {} });
    } finally {
      setLoading(false);
    }
  };

  if (sidebarCollapsed) {
    return (
      <div className="obs-sidebar obs-sidebar-collapsed">
        <button className="obs-sb-toggle" onClick={() => setSidebarCollapsed(false)} title={t('opsidian.files')}>
          <PanelLeftOpen size={16} />
        </button>
        <div className="obs-sb-collapsed-icons">
          <button
            className={`obs-sb-icon-btn ${sidebarPanel === 'files' ? 'active' : ''}`}
            onClick={() => { setSidebarPanel('files'); setSidebarCollapsed(false); }}
            title={t('opsidian.files')}
          >
            <FolderOpen size={16} />
          </button>
          <button
            className={`obs-sb-icon-btn ${sidebarPanel === 'tags' ? 'active' : ''}`}
            onClick={() => { setSidebarPanel('tags'); setSidebarCollapsed(false); }}
            title={t('opsidian.tags')}
          >
            <Tag size={16} />
          </button>
          <button
            className={`obs-sb-icon-btn ${sidebarPanel === 'backlinks' ? 'active' : ''}`}
            onClick={() => { setSidebarPanel('backlinks'); setSidebarCollapsed(false); }}
            title={t('opsidian.links')}
          >
            <Link2 size={16} />
          </button>
        </div>
        <div className="obs-sb-collapsed-bottom">
          <button
            className={`obs-sb-icon-btn ${viewMode === 'graph' ? 'active' : ''}`}
            onClick={() => setViewMode(viewMode === 'graph' ? 'editor' : 'graph')}
            title={t('opsidian.graph')}
          >
            <GitGraph size={16} />
          </button>
          <button
            className={`obs-sb-icon-btn ${viewMode === 'conversation' ? 'active' : ''}`}
            onClick={() => setViewMode(viewMode === 'conversation' ? 'editor' : 'conversation')}
            title={t('opsidian.conversation')}
          >
            <MessageSquare size={16} />
          </button>
          <button
            className={`obs-sb-icon-btn ${viewMode === 'search' ? 'active' : ''}`}
            onClick={() => setViewMode(viewMode === 'search' ? 'editor' : 'search')}
            title={t('opsidian.search')}
          >
            <Search size={16} />
          </button>
        </div>

      </div>
    );
  }

  return (
    <div className="obs-sidebar">
      {/* Header */}
      <div className="obs-sb-header">
        <Link href="/" className="obs-sb-back" title={t('opsidian.goHome')}>
          <ArrowLeft size={14} />
        </Link>
        <span className="obs-sb-brand">{t('opsidian.title')}</span>
        <div className="obs-sb-header-actions">
          {/* Search — icon only, sits to the left of refresh.
              Toggles ``viewMode='search'`` (re-clicking returns
              to ``editor``) so the existing SearchPanel route is
              reused. Plan note — keep this in the header rather
              than the view-mode switcher so the switcher reads as
              the three primary surfaces (editor / graph /
              conversation) only. */}
          <button
            className={`obs-sb-icon-btn ${viewMode === 'search' ? 'active' : ''}`}
            onClick={() => setViewMode(viewMode === 'search' ? 'editor' : 'search')}
            title={t('opsidian.search')}
            aria-label={t('opsidian.search')}
          >
            <Search size={13} />
          </button>
          <button className="obs-sb-icon-btn" onClick={handleRefresh} title={t('opsidian.refresh')}>
            <RefreshCw size={13} />
          </button>
          <button className="obs-sb-toggle" onClick={() => setSidebarCollapsed(true)}>
            <PanelLeftClose size={14} />
          </button>
        </div>
      </div>

      {/* Panel switcher */}
      <div className="obs-sb-tabs">
        {([
          ['files', FolderOpen, t('opsidian.files')],
          ['tags', Tag, t('opsidian.tags')],
          ['backlinks', Link2, t('opsidian.links')],
        ] as [SidebarPanel, typeof FolderOpen, string][]).map(([key, Icon, label]) => (
          <button
            key={key}
            className={`obs-sb-tab ${sidebarPanel === key ? 'active' : ''}`}
            onClick={() => setSidebarPanel(key)}
          >
            <Icon size={13} />
            {label}
          </button>
        ))}
      </div>

      {/* View mode switcher — three primary surfaces. Search is
          a transient affordance and lives in the header bar
          (icon-only) so the switcher stays balanced once
          Conversation joined. */}
      <div className="obs-sb-view-modes">
        <button
          className={`obs-sb-view-btn ${viewMode === 'editor' ? 'active' : ''}`}
          aria-pressed={viewMode === 'editor'}
          onClick={() => setViewMode('editor')}
        >
          <FileText size={16} /> {t('opsidian.editor')}
        </button>
        <button
          className={`obs-sb-view-btn ${viewMode === 'graph' ? 'active' : ''}`}
          aria-pressed={viewMode === 'graph'}
          onClick={() => setViewMode('graph')}
        >
          <GitGraph size={16} /> {t('opsidian.graph')}
        </button>
        <button
          className={`obs-sb-view-btn ${viewMode === 'conversation' ? 'active' : ''}`}
          aria-pressed={viewMode === 'conversation'}
          onClick={() => setViewMode('conversation')}
          title={t('opsidian.conversationHint')}
        >
          <MessageSquare size={16} /> {t('opsidian.conversation')}
        </button>
        <button
          className={`obs-sb-view-btn ${viewMode === 'digest' ? 'active' : ''}`}
          aria-pressed={viewMode === 'digest'}
          onClick={() => setViewMode('digest')}
          title={t('opsidian.digestHint')}
        >
          <Sparkles size={16} /> {t('opsidian.digest')}
        </button>
      </div>

      {/* Content */}
      <div className="obs-sb-body">
        {/* FILES panel */}
        {sidebarPanel === 'files' && (
          <>
            <div className="obs-sb-filter">
              <Search size={12} className="obs-sb-filter-icon" />
              <input
                type="text"
                placeholder={t('opsidian.filterPlaceholder')}
                value={filterText}
                onChange={(e) => setFilterText(e.target.value)}
                className="obs-sb-filter-input"
              />
            </div>
            <div className="obs-sb-tree">
              {orderedCategoryNames.map((cat) => {
                const catFiles = grouped[cat] || [];
                // While a filter is active, hide categories that have
                // zero matching files — non-matching empty folders
                // would just clutter the filtered list.
                if (filterText && catFiles.length === 0) return null;
                const CatIcon = CATEGORY_ICONS[cat] || File;
                const expanded = isFiltering || expandedCategories.has(cat);
                // The count comes from the catalogue, not from what has
                // been loaded — a collapsed folder must show how much is
                // IN it, and nothing has been fetched yet at that point.
                const catCount = catalogCounts[cat];
                const isEmpty =
                  catCount != null ? catCount === 0 : catFiles.length === 0;
                const description = categoryDescriptions[cat];
                return (
                  <div
                    key={cat}
                    className={`obs-sb-category ${isEmpty ? 'obs-sb-cat-empty' : ''}`}
                  >
                    <button
                      className="obs-sb-cat-header"
                      onClick={() => toggleCategory(cat)}
                      title={description || cat}
                      style={isEmpty ? { opacity: 0.55 } : undefined}
                    >
                      {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                      <CatIcon size={13} style={{ color: CATEGORY_COLORS[cat] }} />
                      <span className="obs-sb-cat-name">{cat}</span>
                      <span className="obs-sb-cat-count">
                        {catCount ?? catFiles.length}
                      </span>
                    </button>
                    {expanded && !isEmpty && (
                      <div className="obs-sb-cat-files">
                        {DATE_GROUPED_CATEGORIES.has(cat)
                          ? dayRowsFor(cat).map(({ day, count }) => {
                              const dayKey = `${cat}/${day}`;
                              const dayExpanded =
                                isFiltering || expandedDates.has(dayKey);
                              const dayFiles = filesForDay(cat, day);
                              return (
                                <div key={day} className="obs-sb-date-group">
                                  <button
                                    className="obs-sb-date-header"
                                    onClick={() => toggleDate(cat, day)}
                                  >
                                    {dayExpanded ? (
                                      <ChevronDown size={11} />
                                    ) : (
                                      <ChevronRight size={11} />
                                    )}
                                    <span className="obs-sb-date-text">{day}</span>
                                    <span className="obs-sb-date-count">{count}</span>
                                  </button>
                                  {dayExpanded &&
                                    (dayFiles.length > 0 ? (
                                      dayFiles.map((f) => renderFileRow(f))
                                    ) : loadedDays[dayKey] ? null : (
                                      <div className="obs-sb-date-loading">…</div>
                                    ))}
                                </div>
                              );
                            })
                          : catFiles.map((f) => renderFileRow(f))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}

        {/* TAGS panel */}
        {sidebarPanel === 'tags' && (
          <div className="obs-sb-tags">
            {sortedTags.length === 0 ? (
              <p className="obs-sb-muted">{t('opsidian.noTags')}</p>
            ) : (
              sortedTags.map(([tag, fns]) => (
                <button
                  key={tag}
                  className="obs-sb-tag-item"
                  onClick={() => {
                    if (fns.length > 0) handleFileClick(fns[0]);
                  }}
                >
                  <Tag size={12} />
                  <span className="obs-sb-tag-name">#{tag}</span>
                  <span className="obs-sb-tag-count">{fns.length}</span>
                </button>
              ))
            )}
          </div>
        )}

        {/* BACKLINKS panel */}
        {sidebarPanel === 'backlinks' && (
          <div className="obs-sb-backlinks">
            {!selectedFile ? (
              <p className="obs-sb-muted">{t('opsidian.selectNote')}</p>
            ) : backlinks.length === 0 ? (
              <p className="obs-sb-muted">{t('opsidian.selectNote')}</p>
            ) : (
              backlinks.map((fn) => {
                const info = files[fn];
                return (
                  <button
                    key={fn}
                    className="obs-sb-file"
                    onClick={() => handleFileClick(fn)}
                  >
                    <Link2 size={12} />
                    <span className="obs-sb-file-title">{info?.title || fn}</span>
                  </button>
                );
              })
            )}

            {/* Forward links */}
            {selectedFile && files[selectedFile]?.links_to?.length > 0 && (
              <>
                <div className="obs-sb-section-title">{t('opsidian.outlinksLabel')}</div>
                {files[selectedFile].links_to.map((target) => {
                  const targetFile = Object.values(files).find(
                    (f) => f.filename.toLowerCase().includes(target.toLowerCase())
                  );
                  return (
                    <button
                      key={target}
                      className="obs-sb-file"
                      onClick={() => targetFile && handleFileClick(targetFile.filename)}
                    >
                      <ChevronRight size={12} />
                      <span className="obs-sb-file-title">{target}</span>
                    </button>
                  );
                })}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
