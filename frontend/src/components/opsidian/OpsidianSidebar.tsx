'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useOpsidianStore, type SidebarPanel } from '@/store/useOpsidianStore';
import { useI18n } from '@/lib/i18n';
import { memoryApi } from '@/lib/api';
import {
  FolderOpen,
  File,
  Tag,
  Link2,
  ChevronRight,
  ChevronDown,
  Search,
  GitGraph,
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
    setSidebarCollapsed,
    setSidebarPanel,
    setViewMode,
    openFile,
    setFileDetail,
    setFiles,
    setCategories,
    setMemoryIndex,
    setMemoryStats,
    setGraphData,
    setLoading,
  } = useOpsidianStore();
  const { t } = useI18n();

  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(
    new Set(['daily', 'topics', 'projects', 'insights', 'root'])
  );
  const [filterText, setFilterText] = useState('');

  const toggleCategory = (cat: string) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

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

  const handleFileClick = async (filename: string) => {
    openFile(filename);
    if (selectedSessionId) {
      try {
        const detail = await memoryApi.readFile(selectedSessionId, filename);
        setFileDetail(detail);
      } catch (e) {
        console.error('Failed to read file:', e);
      }
    }
  };

  const handleRefresh = async () => {
    if (!selectedSessionId) return;
    setLoading(true);
    try {
      const [indexRes, graphRes, catsRes] = await Promise.all([
        memoryApi.getIndex(selectedSessionId),
        memoryApi.getGraph(selectedSessionId),
        memoryApi.listCategories(selectedSessionId),
      ]);
      setMemoryIndex(indexRes.index);
      setMemoryStats(indexRes.stats);
      setFiles(indexRes.index.files);
      setCategories(catsRes.categories || []);
      setGraphData(graphRes.nodes, graphRes.edges);
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
          onClick={() => setViewMode('editor')}
        >
          <FileText size={13} /> {t('opsidian.editor')}
        </button>
        <button
          className={`obs-sb-view-btn ${viewMode === 'graph' ? 'active' : ''}`}
          onClick={() => setViewMode('graph')}
        >
          <GitGraph size={13} /> {t('opsidian.graph')}
        </button>
        <button
          className={`obs-sb-view-btn ${viewMode === 'conversation' ? 'active' : ''}`}
          onClick={() => setViewMode('conversation')}
          title={t('opsidian.conversationHint')}
        >
          <MessageSquare size={13} /> {t('opsidian.conversation')}
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
                const expanded = expandedCategories.has(cat);
                const isEmpty = catFiles.length === 0;
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
                      <span className="obs-sb-cat-count">{catFiles.length}</span>
                    </button>
                    {expanded && !isEmpty && (
                      <div className="obs-sb-cat-files">
                        {catFiles.map((f) => (
                          <button
                            key={f.filename}
                            className={`obs-sb-file ${selectedFile === f.filename ? 'active' : ''}`}
                            onClick={() => handleFileClick(f.filename)}
                            title={f.filename}
                          >
                            <span
                              className="obs-sb-imp-dot"
                              style={{ background: IMPORTANCE_DOT[f.importance] || IMPORTANCE_DOT.medium }}
                            />
                            <span className="obs-sb-file-title">{f.title || f.filename}</span>
                          </button>
                        ))}
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
