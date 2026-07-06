'use client';

import { useEffect, useCallback, useState, useMemo, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useUserOpsidianStore } from '@/store/useUserOpsidianStore';
import { useAuthStore } from '@/store/useAuthStore';
import { useAppStore } from '@/store/useAppStore';
import { userOpsidianApi } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useMultiSelection } from '@/lib/useMultiSelection';
import { useHubMode } from '@/components/OpsidianHubContext';
import RightPanel from '../opsidian/RightPanel';
import Link from 'next/link';
import {
  Brain,
  FolderOpen,
  File,
  Tag,
  Link2,
  ChevronRight,
  ChevronDown,
  Search,
  GitGraph,
  FileText,
  Calendar,
  Lightbulb,
  FolderKanban,
  Bookmark,
  Inbox,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Trash2,
  RefreshCw,
  Save,
  X,
  ArrowLeft,
  Home,
  Edit3,
  Loader2,
  Sparkles,
  Copy,
} from 'lucide-react';
import UnifiedGraphView from '../knowledge-graph/UnifiedGraphView';
import CurationSettingsPanel from './CurationSettingsPanel';
import InboxPanel from './InboxPanel';
import {
  attachmentMarkdownComponents,
  attachmentUrlTransform,
  preprocessAttachmentEmbeds,
} from './AttachmentEmbed';
import { uploadCaptureFile } from '@/lib/captureSources';
import ShareWithVTuberMenu from './ShareWithVTuberMenu';
import { useOpsidianShortcuts } from '../opsidian/useOpsidianShortcuts';
import MarkdownToolbar, { useMarkdownEditorKeys } from '../opsidian/MarkdownToolbar';
import QuickSwitcher from '../opsidian/QuickSwitcher';
import TagInput from '../opsidian/TagInput';
import WikilinkPicker from '../opsidian/WikilinkPicker';
import ShortcutHelp from '../opsidian/ShortcutHelp';
import ContextMenu from '../opsidian/ContextMenu';
import '../opsidian/opsidian.css';

// ─── Constants ────────────────────────────────────────────────
const CATEGORY_ICONS: Record<string, typeof File> = {
  inbox: Inbox,
  daily: Calendar,
  topics: Bookmark,
  projects: FolderKanban,
  insights: Lightbulb,
  root: FileText,
};

const CATEGORY_COLORS: Record<string, string> = {
  inbox: '#10b981',  // whiteboard P1 — fresh / unrefined captures
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

const IMPORTANCE_STYLES: Record<string, { bg: string; color: string; label: string }> = {
  critical: { bg: 'rgba(239,68,68,0.15)', color: '#ef4444', label: 'Critical' },
  high: { bg: 'rgba(245,158,11,0.15)', color: '#f59e0b', label: 'High' },
  medium: { bg: 'rgba(59,130,246,0.1)', color: '#3b82f6', label: 'Medium' },
  low: { bg: 'rgba(100,116,139,0.1)', color: '#64748b', label: 'Low' },
};

// ─── Main View ────────────────────────────────────────────────
export default function UserOpsidianView() {
  const { isAuthenticated, initialized, isLoading, checkAuth } = useAuthStore();
  const { t } = useI18n();
  const hub = useHubMode();

  // Ensure auth status is checked when this view mounts
  useEffect(() => {
    if (!initialized) checkAuth();
  }, [initialized, checkAuth]);
  const {
    files,
    selectedFile,
    fileDetail,
    openFiles,
    viewMode,
    sidebarCollapsed,
    rightPanelOpen,
    memoryIndex,
    sidebarPanel,
    graphNodes,
    graphEdges,
    searchQuery,
    searchResults,
    searching,
    setLoading,
    setMemoryIndex,
    setStats,
    setFiles,
    setGraphData,
    setViewMode,
    setSidebarCollapsed,
    setFileDetail,
    openFile,
    closeFile,
    setSidebarPanel,
    setSearchQuery,
    setSearchResults,
    setSearching,
    setUsername,
  } = useUserOpsidianStore();

  // ─── Load data on mount ──
  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [indexRes, graphRes] = await Promise.all([
        userOpsidianApi.getIndex(),
        userOpsidianApi.getGraph(),
      ]);
      setMemoryIndex(indexRes.index);
      setStats({
        total_files: indexRes.stats.total_files ?? 0,
        total_chars: indexRes.stats.long_term_chars ?? 0,
        categories: indexRes.stats.categories ?? {},
        total_tags: indexRes.stats.total_tags ?? 0,
        total_links: indexRes.stats.total_links ?? 0,
      });
      setFiles(indexRes.index.files);
      setGraphData(graphRes.nodes, graphRes.edges);
      setUsername(indexRes.username);
    } catch (err) {
      console.error('Failed to load user opsidian data:', err);
    } finally {
      setLoading(false);
    }
  }, [setLoading, setMemoryIndex, setStats, setFiles, setGraphData, setUsername]);

  useEffect(() => {
    if (isAuthenticated) {
      loadData();
    }
  }, [isAuthenticated, loadData]);

  // Register refresh callback for hub StatusBar
  useEffect(() => {
    if (hub) {
      hub.refreshRef.current = loadData;
    }
  }, [hub, loadData]);

  // ─── Modals & overlays ──
  const [showCurationSettings, setShowCurationSettings] = useState(false);
  const [showQuickSwitcher, setShowQuickSwitcher] = useState(false);
  const [showShortcutHelp, setShowShortcutHelp] = useState(false);
  const [showWikilinkPicker, setShowWikilinkPicker] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; filename: string } | null>(null);

  // ─── Keyboard shortcuts ──
  useOpsidianShortcuts({
    onQuickSearch: () => setShowQuickSwitcher(true),
    onShowShortcuts: () => setShowShortcutHelp(true),
    onNewNote: () => handleNewNote(),
    onToggleEdit: () => { /* handled inside NoteEditor */ },
    onSave: () => { /* handled inside NoteEditor */ },
    onCancel: () => {
      if (showQuickSwitcher) setShowQuickSwitcher(false);
      else if (showShortcutHelp) setShowShortcutHelp(false);
      else if (showWikilinkPicker) setShowWikilinkPicker(false);
      else if (showCurationSettings) setShowCurationSettings(false);
    },
    onToggleSidebar: () => setSidebarCollapsed(!sidebarCollapsed),
    onToggleRightPanel: () => useUserOpsidianStore.getState().setRightPanelOpen(!rightPanelOpen),
    onNextTab: () => {
      if (openFiles.length < 2 || !selectedFile) return;
      const idx = openFiles.indexOf(selectedFile);
      handleSelectFile(openFiles[(idx + 1) % openFiles.length]);
    },
    onPrevTab: () => {
      if (openFiles.length < 2 || !selectedFile) return;
      const idx = openFiles.indexOf(selectedFile);
      handleSelectFile(openFiles[(idx - 1 + openFiles.length) % openFiles.length]);
    },
    onCloseTab: () => { if (selectedFile) closeFile(selectedFile); },
    onEditorView: () => setViewMode('editor'),
    onGraphView: () => setViewMode('graph'),
    onSearchView: () => setViewMode('search'),
  });

  // ─── Draft note for inline creation ──
  const [draftNote, setDraftNote] = useState<{
    title: string; content: string; category: string;
    importance: string; tags: string[];
  } | null>(null);

  // ─── File selection handler ──
  const handleSelectFile = useCallback(
    async (filename: string) => {
      openFile(filename);
      setDraftNote(null);
      try {
        const detail = await userOpsidianApi.readFile(filename);
        setFileDetail(detail);
      } catch (e) {
        console.error('Failed to read file:', e);
      }
    },
    [openFile, setFileDetail],
  );

  const handleNewNote = useCallback(() => {
    setDraftNote({ title: '', content: '', category: 'topics', importance: 'medium', tags: [] });
    useUserOpsidianStore.getState().setSelectedFile(null);
    useUserOpsidianStore.getState().setFileDetail(null);
    setViewMode('editor');
  }, [setViewMode]);

  const handleSaveDraft = useCallback(async (draft: {
    title: string; content: string; category: string;
    importance: string; tags: string[];
  }) => {
    try {
      const res = await userOpsidianApi.createFile({
        title: draft.title || t('opsidian.untitled'),
        content: draft.content || '',
        category: draft.category,
        tags: draft.tags,
        importance: draft.importance,
      });
      setDraftNote(null);
      await loadData();
      await handleSelectFile(res.filename);
    } catch (e) {
      console.error('Create failed:', e);
    }
  }, [loadData, handleSelectFile, t]);

  // ─── Auth guard ──
  if (isLoading || !initialized) {
    return (
      <div className="opsidian-root" style={{ alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center', color: 'var(--obs-text-muted)' }}>
          <Loader2 size={32} className="spin" style={{ marginBottom: 12, color: 'var(--obs-purple)' }} />
          <p style={{ fontSize: 14 }}>{t('common.loading')}</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="opsidian-root" style={{ alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center', color: 'var(--obs-text-muted)' }}>
          <Brain size={48} strokeWidth={1.2} style={{ marginBottom: 16, color: 'var(--obs-purple)' }} />
          <h2 style={{ margin: '0 0 8px', color: 'var(--obs-text)', fontSize: 20 }}>{t('opsidian.title')}</h2>
          <p style={{ fontSize: 14 }}>{t('opsidian.loginRequired')}</p>
          <Link
            href="/"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 16,
              padding: '8px 20px', borderRadius: 8, background: 'var(--obs-purple)',
              color: '#fff', textDecoration: 'none', fontSize: 13, fontWeight: 600,
            }}
          >
            <Home size={14} /> {t('opsidian.goHome')}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="opsidian-root">
      {/* Modals & Overlays */}
      {showCurationSettings && (
        <CurationSettingsPanel onClose={() => setShowCurationSettings(false)} />
      )}
      {showQuickSwitcher && (
        <QuickSwitcher
          files={files}
          onSelect={handleSelectFile}
          onClose={() => setShowQuickSwitcher(false)}
          onCreateNote={handleNewNote}
        />
      )}
      {showShortcutHelp && (
        <ShortcutHelp onClose={() => setShowShortcutHelp(false)} />
      )}
      {showWikilinkPicker && (
        <WikilinkPicker
          files={files}
          onSelect={(filename, alias) => {
            // Insert wikilink at cursor in active editor (NoteEditor handles its own)
            // This is a fallback — NoteEditor's own picker is preferred
            console.log('Wikilink selected:', filename, alias);
            setShowWikilinkPicker(false);
          }}
          onClose={() => setShowWikilinkPicker(false)}
        />
      )}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={[
            { label: t('opsidian.openInNewTab'), icon: <FileText size={12} />, onClick: () => handleSelectFile(contextMenu.filename) },
            { label: t('opsidian.copyWikilink'), icon: <Copy size={12} />, onClick: () => navigator.clipboard.writeText(`[[${contextMenu.filename.replace(/\.md$/, '')}]]`) },
            { label: '', onClick: () => {}, divider: true },
            { label: t('opsidian.confirmDelete').replace('?', ''), icon: <Trash2 size={12} />, danger: true, onClick: async () => { if (confirm(t('opsidian.confirmDelete'))) { await userOpsidianApi.deleteFile(contextMenu.filename); loadData(); } } },
          ]}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* Left sidebar */}
      <Sidebar
        files={files}
        selectedFile={selectedFile}
        sidebarCollapsed={sidebarCollapsed}
        sidebarPanel={sidebarPanel}
        viewMode={viewMode}
        memoryIndex={memoryIndex}
        onSelectFile={handleSelectFile}
        onSetSidebarCollapsed={setSidebarCollapsed}
        onSetSidebarPanel={setSidebarPanel}
        onSetViewMode={setViewMode}
        onRefresh={loadData}
        onNewNote={handleNewNote}
        onOpenCurationSettings={() => setShowCurationSettings(true)}
      />

      {/* Main content */}
      <div
        className="opsidian-main"
        style={{
          marginLeft: sidebarCollapsed ? 40 : 260,
          marginRight: rightPanelOpen ? 280 : 0,
        }}
      >
        {/* Tabs */}
        <Tabs
          openFiles={openFiles}
          selectedFile={selectedFile}
          files={files}
          onSelectFile={handleSelectFile}
          onCloseFile={closeFile}
        />

        {/* Content */}
        <div className="opsidian-content">
          {viewMode === 'editor' && (
            draftNote
              ? <DraftEditor
                  draft={draftNote}
                  onUpdate={setDraftNote}
                  onSave={handleSaveDraft}
                  onDiscard={() => setDraftNote(null)}
                  allFiles={files}
                />
              : <NoteEditor
                  fileDetail={fileDetail}
                  selectedFile={selectedFile}
                  onSelectFile={handleSelectFile}
                  onRefresh={loadData}
                  allFiles={files}
                />
          )}
          {viewMode === 'inbox' && (
            <InboxPanel
              onSelectFile={(fn) => {
                handleSelectFile(fn);
                setViewMode('editor');
              }}
            />
          )}
          {viewMode === 'graph' && (
            <UnifiedGraphView nodes={graphNodes} edges={graphEdges} onSelectFile={handleSelectFile} />
          )}
          {viewMode === 'search' && (
            <SearchView
              query={searchQuery}
              results={searchResults}
              searching={searching}
              onSetQuery={setSearchQuery}
              onSetResults={setSearchResults}
              onSetSearching={setSearching}
              onSelectFile={handleSelectFile}
            />
          )}
        </div>
      </div>

      {/* Right panel */}
      {rightPanelOpen && <RightPanel />}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// SUB-COMPONENTS
// ═══════════════════════════════════════════════════════════════

// ─── Sidebar ──────────────────────────────────────────────────
function Sidebar({
  files, selectedFile, sidebarCollapsed, sidebarPanel, viewMode, memoryIndex,
  onSelectFile, onSetSidebarCollapsed, onSetSidebarPanel, onSetViewMode, onRefresh, onNewNote,
  onOpenCurationSettings,
}: {
  files: Record<string, import('@/types').MemoryFileInfo>;
  selectedFile: string | null;
  sidebarCollapsed: boolean;
  sidebarPanel: string;
  viewMode: string;
  memoryIndex: import('@/types').MemoryIndex | null;
  onSelectFile: (fn: string) => void;
  onSetSidebarCollapsed: (v: boolean) => void;
  onSetSidebarPanel: (p: 'files' | 'tags' | 'backlinks') => void;
  onSetViewMode: (v: 'editor' | 'graph' | 'search' | 'inbox') => void;
  onRefresh: () => void;
  onNewNote: () => void;
  onOpenCurationSettings: () => void;
}) {
  const { t } = useI18n();
  // Start collapsed — large vaults must open one level at a time.
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(
    new Set(),
  );
  const [filterText, setFilterText] = useState('');
  const [bulkDeleting, setBulkDeleting] = useState(false);

  const toggleCategory = (cat: string) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  const grouped = useMemo(() => {
    const groups: Record<string, (typeof files)[string][]> = {};
    Object.values(files).forEach((f) => {
      const cat = f.category || 'root';
      if (!groups[cat]) groups[cat] = [];
      if (filterText) {
        const q = filterText.toLowerCase();
        if (
          f.title.toLowerCase().includes(q) ||
          f.filename.toLowerCase().includes(q) ||
          f.tags.some((tg) => tg.includes(q))
        ) {
          groups[cat].push(f);
        }
      } else {
        groups[cat].push(f);
      }
    });
    return groups;
  }, [files, filterText]);

  // Flat ordered list of currently-visible filenames — drives the
  // Shift+click range selection. Skips collapsed categories so
  // ranging only spans what the user can actually see.
  const visibleFilenames = useMemo(() => {
    const out: string[] = [];
    for (const [cat, catFiles] of Object.entries(grouped)) {
      if (!expandedCategories.has(cat)) continue;
      for (const f of catFiles) out.push(f.filename);
    }
    return out;
  }, [grouped, expandedCategories]);

  const selection = useMultiSelection({ ids: visibleFilenames });

  const handleFileClick = useCallback(
    (event: React.MouseEvent, filename: string) => {
      const openIntent = selection.isOpenIntent(event);
      selection.handleItemClick(event, filename);
      if (openIntent) onSelectFile(filename);
    },
    [selection, onSelectFile],
  );

  const handleBulkDelete = useCallback(async () => {
    const ids = Array.from(selection.selectedIds);
    if (ids.length === 0) return;
    if (
      !confirm(
        `Delete ${ids.length} ${ids.length === 1 ? 'note' : 'notes'}? This cannot be undone.`,
      )
    ) {
      return;
    }
    setBulkDeleting(true);
    try {
      await userOpsidianApi.batchDeleteFiles(ids);
      selection.clear();
      onRefresh();
    } catch (e) {
      alert(`Bulk delete failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBulkDeleting(false);
    }
  }, [selection, onRefresh]);

  // Delete-key shortcut while the sidebar selection is non-empty.
  useEffect(() => {
    if (selection.selectedIds.size === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      const editing =
        tag === 'input' ||
        tag === 'textarea' ||
        tag === 'select' ||
        (target as HTMLElement | null)?.isContentEditable;
      if (editing) return;
      e.preventDefault();
      handleBulkDelete();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selection.selectedIds.size, handleBulkDelete]);

  const tagMap = memoryIndex?.tag_map ?? {};

  if (sidebarCollapsed) {
    return (
      <div className="obs-sidebar obs-sidebar-collapsed">
        <button className="obs-sb-toggle" onClick={() => onSetSidebarCollapsed(false)}>
          <PanelLeftOpen size={16} />
        </button>
        <div className="obs-sb-collapsed-icons">
          <button className={`obs-sb-icon-btn ${viewMode === 'editor' ? 'active' : ''}`} onClick={() => onSetViewMode('editor')} title={t('opsidian.editor')}>
            <FileText size={16} />
          </button>
          <button className={`obs-sb-icon-btn ${viewMode === 'inbox' ? 'active' : ''}`} onClick={() => onSetViewMode('inbox')} title="Whiteboard inbox">
            <Inbox size={16} />
          </button>
          <button className={`obs-sb-icon-btn ${viewMode === 'graph' ? 'active' : ''}`} onClick={() => onSetViewMode('graph')} title={t('opsidian.graph')}>
            <GitGraph size={16} />
          </button>
          <button className={`obs-sb-icon-btn ${viewMode === 'search' ? 'active' : ''}`} onClick={() => onSetViewMode('search')} title={t('opsidian.search')}>
            <Search size={16} />
          </button>
        </div>
        <div className="obs-sb-collapsed-bottom">
          <button className="obs-sb-icon-btn" onClick={onRefresh} title={t('opsidian.refresh')}>
            <RefreshCw size={14} />
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
          <button className="obs-sb-toggle" onClick={onNewNote} title={t('opsidian.createNote')}>
            <Plus size={13} />
          </button>
          <button className="obs-sb-toggle" onClick={onOpenCurationSettings} title={t('opsidian.curationSettings')}>
            <Sparkles size={13} style={{ color: '#f59e0b' }} />
          </button>
          <button className="obs-sb-toggle" onClick={onRefresh} title={t('opsidian.refresh')}>
            <RefreshCw size={13} />
          </button>
          <button className="obs-sb-toggle" onClick={() => onSetSidebarCollapsed(true)}>
            <PanelLeftClose size={14} />
          </button>
        </div>
      </div>

      {/* Panel tabs */}
      <div className="obs-sb-tabs">
        <button className={`obs-sb-tab ${sidebarPanel === 'files' ? 'active' : ''}`} onClick={() => onSetSidebarPanel('files')}>
          <FolderOpen size={12} /> {t('opsidian.files')}
        </button>
        <button className={`obs-sb-tab ${sidebarPanel === 'tags' ? 'active' : ''}`} onClick={() => onSetSidebarPanel('tags')}>
          <Tag size={12} /> {t('opsidian.tags')}
        </button>
        <button className={`obs-sb-tab ${sidebarPanel === 'backlinks' ? 'active' : ''}`} onClick={() => onSetSidebarPanel('backlinks')}>
          <Link2 size={12} /> {t('opsidian.links')}
        </button>
      </div>

      {/* View mode switcher */}
      <div className="obs-sb-view-modes">
        <button className={`obs-sb-view-btn ${viewMode === 'editor' ? 'active' : ''}`} onClick={() => onSetViewMode('editor')}>
          <FileText size={12} /> {t('opsidian.editor')}
        </button>
        <button className={`obs-sb-view-btn ${viewMode === 'inbox' ? 'active' : ''}`} onClick={() => onSetViewMode('inbox')} title="Whiteboard inbox — raw captures">
          <Inbox size={12} /> Inbox
        </button>
        <button className={`obs-sb-view-btn ${viewMode === 'graph' ? 'active' : ''}`} onClick={() => onSetViewMode('graph')}>
          <GitGraph size={12} /> {t('opsidian.graph')}
        </button>
        <button className={`obs-sb-view-btn ${viewMode === 'search' ? 'active' : ''}`} onClick={() => onSetViewMode('search')}>
          <Search size={12} /> {t('opsidian.search')}
        </button>
      </div>

      {/* Body */}
      <div className="obs-sb-body">
        {sidebarPanel === 'files' && (
          <>
            <div className="obs-sb-filter">
              <Search size={12} className="obs-sb-filter-icon" />
              <input
                className="obs-sb-filter-input"
                placeholder={t('opsidian.filterPlaceholder')}
                value={filterText}
                onChange={(e) => setFilterText(e.target.value)}
              />
            </div>
            {selection.selectedIds.size > 0 && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '6px 10px',
                  margin: '6px 8px',
                  background: 'rgba(59,130,246,0.10)',
                  border: '1px solid rgba(59,130,246,0.35)',
                  borderRadius: 6,
                  fontSize: 11,
                }}
              >
                <span style={{ color: 'var(--primary-color, #3b82f6)', fontWeight: 500 }}>
                  {selection.selectedIds.size} selected
                </span>
                <div style={{ marginLeft: 'auto', display: 'inline-flex', gap: 4 }}>
                  <button
                    type="button"
                    onClick={handleBulkDelete}
                    disabled={bulkDeleting}
                    title={`Delete ${selection.selectedIds.size} (Delete key)`}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                      padding: '3px 8px',
                      fontSize: 11,
                      border: '1px solid rgba(239,68,68,0.45)',
                      background: 'rgba(239,68,68,0.10)',
                      color: '#ef4444',
                      borderRadius: 4,
                      cursor: bulkDeleting ? 'not-allowed' : 'pointer',
                      opacity: bulkDeleting ? 0.7 : 1,
                    }}
                  >
                    {bulkDeleting ? <Loader2 size={10} className="spin" /> : <Trash2 size={10} />}
                    <span>Delete</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => selection.clear()}
                    title="Clear selection (Esc)"
                    style={{
                      padding: '3px 6px',
                      fontSize: 11,
                      border: '1px solid var(--obs-border, #2c2c2e)',
                      background: 'transparent',
                      color: 'var(--obs-text-muted, #8e8e93)',
                      borderRadius: 4,
                      cursor: 'pointer',
                    }}
                  >
                    ✕
                  </button>
                </div>
              </div>
            )}
            <div
              className="obs-sb-tree"
              onMouseDown={(e) => {
                // Clear the multi-select when the user clicks the
                // tree background (gaps between category headers /
                // file rows, the bottom blank area, etc.).
                // ``closest('button, a')`` catches every interactive
                // descendant — file rows are <button>, category
                // headers are <button> — so a click on a real row
                // doesn't accidentally trip this.
                const target = e.target as HTMLElement | null;
                if (target?.closest('button, a, input, textarea')) return;
                if (selection.selectedIds.size === 0) return;
                selection.clear();
              }}
            >
              {Object.entries(grouped).map(([cat, catFiles]) => {
                if (catFiles.length === 0) return null;
                const Icon = CATEGORY_ICONS[cat] || FileText;
                const expanded = expandedCategories.has(cat);
                return (
                  <div key={cat} className="obs-sb-category">
                    <button className="obs-sb-cat-header" onClick={() => toggleCategory(cat)}>
                      {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                      <Icon size={12} style={{ color: CATEGORY_COLORS[cat] || '#64748b' }} />
                      <span className="obs-sb-cat-name">{cat}</span>
                      <span className="obs-sb-cat-count">{catFiles.length}</span>
                    </button>
                    {expanded && (
                      <div className="obs-sb-cat-files">
                        {catFiles.map((f) => {
                          const inMulti = selection.isSelected(f.filename);
                          return (
                            <button
                              key={f.filename}
                              className={`obs-sb-file ${selectedFile === f.filename ? 'active' : ''}${inMulti ? ' obs-sb-file-multi' : ''}`}
                              onClick={(e) => handleFileClick(e, f.filename)}
                              aria-pressed={inMulti}
                              style={
                                inMulti
                                  ? {
                                      background: 'rgba(59,130,246,0.18)',
                                      borderLeft: '2px solid var(--primary-color, #3b82f6)',
                                    }
                                  : undefined
                              }
                            >
                              <span
                                className="obs-sb-imp-dot"
                                style={{ color: IMPORTANCE_DOT[f.importance] || '#64748b' }}
                              />
                              <span className="obs-sb-file-title">{f.title || f.filename}</span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
              {Object.values(files).length === 0 && !filterText && (
                <div style={{ padding: '24px 16px', textAlign: 'center', color: 'var(--obs-text-muted)', fontSize: 12 }}>
                  {t('opsidian.emptyVault')}
                </div>
              )}
            </div>
          </>
        )}

        {sidebarPanel === 'tags' && (
          <div className="obs-sb-tags">
            {Object.entries(tagMap).map(([tag, fns]) => (
              <button key={tag} className="obs-sb-tag-item" onClick={() => { /* filter by tag */ }}>
                <Tag size={12} style={{ color: 'var(--obs-purple-bright)' }} />
                <span className="obs-sb-tag-name">{tag}</span>
                <span className="obs-sb-tag-count">{Array.isArray(fns) ? fns.length : 0}</span>
              </button>
            ))}
            {Object.keys(tagMap).length === 0 && (
              <div style={{ padding: '24px 16px', textAlign: 'center', color: 'var(--obs-text-muted)', fontSize: 12 }}>
                {t('opsidian.noTags')}
              </div>
            )}
          </div>
        )}

        {sidebarPanel === 'backlinks' && selectedFile && (
          <div className="obs-sb-backlinks" style={{ padding: '8px' }}>
            {(() => {
              const info = files[selectedFile];
              if (!info) return <div style={{ padding: 16, color: 'var(--obs-text-muted)', fontSize: 12 }}>{t('opsidian.selectNote')}</div>;
              const backlinks = info.linked_from || [];
              const outlinks = info.links_to || [];
              return (
                <>
                  <div style={{ padding: '8px 4px', fontSize: 11, fontWeight: 600, color: 'var(--obs-text-dim)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    {t('opsidian.backlinksLabel')} ({backlinks.length})
                  </div>
                  {backlinks.map((bl) => (
                    <button key={bl} className="obs-sb-tag-item" onClick={() => onSelectFile(bl)}>
                      <Link2 size={12} /> <span className="obs-sb-tag-name">{files[bl]?.title || bl}</span>
                    </button>
                  ))}
                  <div style={{ padding: '8px 4px', fontSize: 11, fontWeight: 600, color: 'var(--obs-text-dim)', textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 12 }}>
                    {t('opsidian.outlinksLabel')} ({outlinks.length})
                  </div>
                  {outlinks.map((ol) => (
                    <button key={ol} className="obs-sb-tag-item" onClick={() => onSelectFile(ol)}>
                      <Link2 size={12} /> <span className="obs-sb-tag-name">{files[ol]?.title || ol}</span>
                    </button>
                  ))}
                </>
              );
            })()}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Tabs ───────────────────────────────────────────────────────
function Tabs({
  openFiles, selectedFile, files, onSelectFile, onCloseFile,
}: {
  openFiles: string[];
  selectedFile: string | null;
  files: Record<string, import('@/types').MemoryFileInfo>;
  onSelectFile: (fn: string) => void;
  onCloseFile: (fn: string) => void;
}) {
  if (openFiles.length === 0) return null;
  return (
    <div style={{
      display: 'flex', gap: 0, borderBottom: '1px solid var(--obs-border-subtle)',
      background: 'var(--obs-bg-panel)', overflowX: 'auto', minHeight: 36,
    }}>
      {openFiles.map((fn) => {
        const isActive = fn === selectedFile;
        const info = files[fn];
        return (
          <div
            key={fn}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '0 12px', fontSize: 12, cursor: 'pointer',
              borderBottom: isActive ? '2px solid var(--obs-purple)' : '2px solid transparent',
              background: isActive ? 'var(--obs-bg-surface)' : 'transparent',
              color: isActive ? 'var(--obs-text)' : 'var(--obs-text-muted)',
              transition: 'all 150ms ease', whiteSpace: 'nowrap',
            }}
            onClick={() => onSelectFile(fn)}
          >
            <span>{info?.title || fn}</span>
            <button
              onClick={(e) => { e.stopPropagation(); onCloseFile(fn); }}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: 16, height: 16, background: 'none', border: 'none',
                color: 'var(--obs-text-muted)', cursor: 'pointer', borderRadius: 3,
                padding: 0,
              }}
              onMouseEnter={(e) => { (e.target as HTMLElement).style.background = 'var(--obs-bg-hover)'; }}
              onMouseLeave={(e) => { (e.target as HTMLElement).style.background = 'none'; }}
            >
              <X size={10} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ─── Note Editor ──────────────────────────────────────────────
function NoteEditor({
  fileDetail, selectedFile, onSelectFile, onRefresh, allFiles,
}: {
  fileDetail: import('@/types').MemoryFileDetail | null;
  selectedFile: string | null;
  onSelectFile: (fn: string) => void;
  onRefresh: () => void;
  allFiles: Record<string, import('@/types').MemoryFileInfo>;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [editCategory, setEditCategory] = useState('');
  const [editImportance, setEditImportance] = useState('');
  const [editTagsList, setEditTagsList] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [showEditorWikilink, setShowEditorWikilink] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Active vtuber session (when user got here from a session). Used
  // by ShareWithVTuberMenu so Spotlight items land in the right
  // bucket and the [USER_SHARED] trigger fires for that session.
  const activeSessionId = useAppStore((s) => s.selectedSessionId);

  // ShareWithVTuberMenu (P2a) owns its own toast — no top-level
  // curate-message state needed here any more.

  // All existing tags for autocomplete
  const allTags = useMemo(() => {
    const tagSet = new Set<string>();
    Object.values(allFiles).forEach(f => f.tags.forEach(t => tagSet.add(t)));
    return Array.from(tagSet).sort();
  }, [allFiles]);

  useEffect(() => {
    if (fileDetail) {
      setEditContent(fileDetail.body ?? '');
      const m = fileDetail.metadata || {};
      setEditCategory(String(m.category || 'topics'));
      setEditImportance(String(m.importance || 'medium'));
      setEditTagsList(Array.isArray(m.tags) ? m.tags.map(String) : []);
    }
    setEditing(false);
  }, [fileDetail]);

  // Markdown editor keyboard handler
  const handleEditorKeyDown = useMarkdownEditorKeys(
    textareaRef,
    (v) => setEditContent(v),
    () => setShowEditorWikilink(true),
  );

  // Insert wikilink at cursor
  const insertWikilink = useCallback((filename: string, alias?: string) => {
    const ta = textareaRef.current;
    if (!ta) return;
    const stem = filename.replace(/\.md$/, '').replace(/^[^/]+\//, '');
    const link = alias ? `[[${stem}|${alias}]]` : `[[${stem}]]`;
    const { selectionStart: start, selectionEnd: end, value } = ta;
    const newValue = value.slice(0, start) + link + value.slice(end);
    setEditContent(newValue);
    requestAnimationFrame(() => { ta.focus(); ta.setSelectionRange(start + link.length, start + link.length); });
  }, []);

  const handleSave = async () => {
    if (!selectedFile || !editContent) return;
    setSaving(true);
    try {
      await userOpsidianApi.updateFile(selectedFile, {
        content: editContent,
        category: editCategory,
        importance: editImportance,
        tags: editTagsList,
      });
      setEditing(false);
      await onRefresh();
      await onSelectFile(selectedFile);
    } catch (e) {
      console.error('Save failed:', e);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedFile) return;
    if (!confirm(t('opsidian.confirmDelete'))) return;
    try {
      await userOpsidianApi.deleteFile(selectedFile);
      onRefresh();
    } catch (e) {
      console.error('Delete failed:', e);
    }
  };

  if (!selectedFile || !fileDetail) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100%', color: 'var(--obs-text-muted)', fontSize: 14,
        flexDirection: 'column', gap: 12,
      }}>
        <Brain size={40} strokeWidth={1.2} style={{ color: 'var(--obs-purple)', opacity: 0.5 }} />
        <span>{t('opsidian.selectOrCreate')}</span>
      </div>
    );
  }

  const meta = fileDetail.metadata || {};
  const body = fileDetail.body ?? '';

  // Pre-process attachment embeds (`![[file.png]]` → markdown image with
  // attachment:// scheme) BEFORE wikilink rewriting so the leading `!`
  // is consumed first and never leaks through as a stray character.
  const bodyWithAttachments = preprocessAttachmentEmbeds(body);
  const processedBody = bodyWithAttachments.replace(
    /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
    (_match: string, target: string, alias: string) => {
      const display = alias || target;
      return `[🔗 ${display}](wikilink://${encodeURIComponent(target)})`;
    },
  );

  const handleStartEdit = () => {
    const m = fileDetail?.metadata || {};
    setEditContent(fileDetail?.body ?? '');
    setEditCategory(String(m.category || 'topics'));
    setEditImportance(String(m.importance || 'medium'));
    setEditTagsList(Array.isArray(m.tags) ? m.tags.map(String) : []);
    setEditing(true);
  };

  if (editing) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        {/* Toolbar — matches DraftEditor */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px',
          borderBottom: '1px solid var(--obs-border-subtle)',
          background: 'var(--obs-bg-panel)',
        }}>
          <select
            value={editCategory}
            onChange={(e) => setEditCategory(e.target.value)}
            style={{
              padding: '4px 8px', fontSize: 11, background: 'var(--obs-bg-surface)',
              border: '1px solid var(--obs-border)', borderRadius: 4,
              color: 'var(--obs-text)', outline: 'none',
            }}
          >
            <option value="topics">Topics</option>
            <option value="daily">Daily</option>
            <option value="projects">Projects</option>
            <option value="insights">Insights</option>
          </select>
          <select
            value={editImportance}
            onChange={(e) => setEditImportance(e.target.value)}
            style={{
              padding: '4px 8px', fontSize: 11, background: 'var(--obs-bg-surface)',
              border: '1px solid var(--obs-border)', borderRadius: 4,
              color: 'var(--obs-text)', outline: 'none',
            }}
          >
            <option value="critical">Critical</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
          <TagInput
            tags={editTagsList}
            onChange={setEditTagsList}
            availableTags={allTags}
            placeholder={t('opsidian.tagsPlaceholder')}
          />
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <button
              onClick={() => { setEditing(false); }}
              style={{
                display: 'flex', alignItems: 'center', gap: 4, padding: '5px 12px',
                fontSize: 12, background: 'var(--obs-bg-hover)', color: 'var(--obs-text-dim)',
                border: '1px solid var(--obs-border)', borderRadius: 5, cursor: 'pointer',
              }}
            >
              <X size={12} /> {t('opsidian.cancel')}
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              style={{
                display: 'flex', alignItems: 'center', gap: 4, padding: '5px 14px',
                fontSize: 12, fontWeight: 600, background: 'var(--obs-purple)',
                color: '#fff', border: 'none', borderRadius: 5, cursor: 'pointer',
              }}
            >
              {saving ? <Loader2 size={12} className="spin" /> : <Save size={12} />}
              {t('opsidian.save')}
            </button>
            <button
              onClick={handleDelete}
              style={{
                display: 'flex', alignItems: 'center', padding: '5px 8px',
                fontSize: 12, background: 'rgba(239,68,68,0.1)', color: '#ef4444',
                border: '1px solid rgba(239,68,68,0.2)', borderRadius: 5, cursor: 'pointer',
              }}
            >
              <Trash2 size={12} />
            </button>
          </div>
        </div>

        {/* Title (read-only) */}
        <div style={{ padding: '16px 32px 0', maxWidth: 900, margin: '0 auto', width: '100%' }}>
          <h1 style={{
            fontSize: 24, fontWeight: 700, margin: 0, paddingBottom: 8,
            borderBottom: '1px solid var(--obs-border-subtle)',
            color: 'var(--obs-text)', marginBottom: 16,
          }}>
            {String(meta.title || selectedFile)}
          </h1>
        </div>

        {/* Markdown toolbar */}
        <div style={{ padding: '0 32px', maxWidth: 900, margin: '0 auto', width: '100%' }}>
          <MarkdownToolbar
            textareaRef={textareaRef}
            onChange={setEditContent}
            onRequestWikilink={() => setShowEditorWikilink(true)}
          />
        </div>

        {/* Content textarea — drop a file here to upload as attachment + insert wikilink */}
        <div
          style={{ flex: 1, padding: '0 32px 16px', maxWidth: 900, margin: '0 auto', width: '100%' }}
          onDragOver={(e) => {
            // Allow drop and show a subtle highlight cue.
            if (e.dataTransfer?.types?.includes('Files')) {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'copy';
            }
          }}
          onDrop={async (e) => {
            const files = Array.from(e.dataTransfer?.files ?? []);
            if (files.length === 0) return;
            e.preventDefault();
            for (const file of files) {
              try {
                const res = await uploadCaptureFile(file, { source: 'file_drop' });
                const leaf = (res.attachment_path ?? '').replace(/^.*\//, '');
                if (leaf) {
                  // Splice the wikilink at the current cursor position.
                  const ta = textareaRef.current;
                  const insertion = `\n![[${leaf}]]\n`;
                  if (ta) {
                    const start = ta.selectionStart ?? editContent.length;
                    const end = ta.selectionEnd ?? editContent.length;
                    const next = editContent.slice(0, start) + insertion + editContent.slice(end);
                    setEditContent(next);
                    requestAnimationFrame(() => {
                      ta.focus();
                      ta.selectionStart = ta.selectionEnd = start + insertion.length;
                    });
                  } else {
                    setEditContent(editContent + insertion);
                  }
                }
              } catch (err) {
                console.error('[whiteboard] drop upload failed', err);
                alert(`Upload failed: ${err instanceof Error ? err.message : String(err)}`);
              }
            }
          }}
        >
          <textarea
            ref={textareaRef}
            value={editContent}
            onChange={(e) => setEditContent(e.target.value)}
            onKeyDown={handleEditorKeyDown}
            autoFocus
            style={{
              width: '100%', height: '100%', minHeight: 300, padding: 0,
              background: 'transparent', color: 'var(--obs-text)',
              border: 'none', fontFamily: 'var(--obs-font-mono)', fontSize: 14,
              lineHeight: 1.8, resize: 'none', outline: 'none',
            }}
          />
        </div>

        {/* Editor-level wikilink picker */}
        {showEditorWikilink && (
          <WikilinkPicker
            files={allFiles}
            onSelect={insertWikilink}
            onClose={() => setShowEditorWikilink(false)}
          />
        )}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Toolbar — view mode */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px',
        borderBottom: '1px solid var(--obs-border-subtle)',
        background: 'var(--obs-bg-panel)',
      }}>
        {!!meta.category && (
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 10px',
            fontSize: 11, borderRadius: 4,
            background: `${CATEGORY_COLORS[String(meta.category)] || '#64748b'}20`,
            color: CATEGORY_COLORS[String(meta.category)] || '#64748b',
          }}>
            {(() => { const I = CATEGORY_ICONS[String(meta.category)] || FileText; return <I size={10} />; })()}
            {String(meta.category)}
          </span>
        )}
        {!!meta.importance && (() => {
          const s = IMPORTANCE_STYLES[String(meta.importance)];
          return s ? (
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 10px',
              fontSize: 11, borderRadius: 4, background: s.bg, color: s.color,
            }}>{s.label}</span>
          ) : null;
        })()}
        {Array.isArray(meta.tags) && meta.tags.map((tag) => (
          <span key={String(tag)} style={{
            display: 'inline-flex', alignItems: 'center', gap: 3, padding: '4px 8px',
            fontSize: 11, borderRadius: 4, background: 'var(--obs-purple-dim)',
            color: 'var(--obs-purple-bright)',
          }}>
            <Tag size={9} /> {String(tag)}
          </span>
        ))}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
          {selectedFile && (
            <ShareWithVTuberMenu
              filename={selectedFile}
              sessionId={activeSessionId}
            />
          )}
          <button
            onClick={handleStartEdit}
            style={{
              display: 'flex', alignItems: 'center', gap: 4, padding: '5px 12px',
              fontSize: 12, fontWeight: 500, background: 'var(--obs-purple-dim)',
              color: 'var(--obs-purple-bright)', border: '1px solid rgba(139,92,246,0.3)',
              borderRadius: 5, cursor: 'pointer',
            }}
          >
            <Edit3 size={12} /> {t('opsidian.edit')}
          </button>
          <button
            onClick={handleDelete}
            style={{
              display: 'flex', alignItems: 'center', padding: '5px 8px',
              fontSize: 12, background: 'rgba(239,68,68,0.1)', color: '#ef4444',
              border: '1px solid rgba(239,68,68,0.2)', borderRadius: 5, cursor: 'pointer',
            }}
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>

      {/* Title + Body */}
      <div style={{ flex: 1, overflow: 'auto', padding: '16px 32px', maxWidth: 900, margin: '0 auto', width: '100%' }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, margin: '0 0 16px', color: 'var(--obs-text)' }}>
          {String(meta.title || selectedFile)}
        </h1>
        <div style={{ fontSize: 14, lineHeight: 1.8, color: 'var(--obs-text)' }}>
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            urlTransform={attachmentUrlTransform}
            components={{
              ...attachmentMarkdownComponents,
              a: ({ href, children, ...props }) => {
                if (href?.startsWith('wikilink://')) {
                  const target = decodeURIComponent(href.replace('wikilink://', ''));
                  return (
                    <a
                      {...props}
                      href="#"
                      style={{ color: 'var(--obs-purple-bright)', textDecoration: 'none', cursor: 'pointer' }}
                      onClick={(e) => { e.preventDefault(); onSelectFile(target); }}
                    >
                      {children}
                    </a>
                  );
                }
                return <a {...props} href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
              },
            }}
          >
            {processedBody}
          </ReactMarkdown>
        </div>
      </div>
    </div>
  );
}

// ─── Search View ──────────────────────────────────────────────
function SearchView({
  query, results, searching, onSetQuery, onSetResults, onSetSearching, onSelectFile,
}: {
  query: string;
  results: Array<Record<string, unknown>>;
  searching: boolean;
  onSetQuery: (q: string) => void;
  onSetResults: (r: Array<Record<string, unknown>>) => void;
  onSetSearching: (v: boolean) => void;
  onSelectFile: (fn: string) => void;
}) {
  const { t } = useI18n();

  const handleSearch = async () => {
    if (!query.trim()) return;
    onSetSearching(true);
    try {
      const res = await userOpsidianApi.search(query.trim());
      onSetResults(res.results);
    } catch (e) {
      console.error('Search failed:', e);
    } finally {
      onSetSearching(false);
    }
  };

  return (
    <div style={{ padding: '24px 32px', maxWidth: 800, margin: '0 auto' }}>
      <h2 style={{ fontSize: 18, fontWeight: 700, color: 'var(--obs-text)', margin: '0 0 16px' }}>
        {t('opsidian.search')}
      </h2>
      <div style={{
        display: 'flex', gap: 8, marginBottom: 24,
      }}>
        <input
          value={query}
          onChange={(e) => onSetQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
          placeholder={t('opsidian.searchPlaceholder')}
          style={{
            flex: 1, padding: '10px 14px', background: 'var(--obs-bg-surface)',
            border: '1px solid var(--obs-border)', borderRadius: 8,
            color: 'var(--obs-text)', fontSize: 13, outline: 'none',
          }}
        />
        <button
          onClick={handleSearch}
          disabled={searching}
          style={{
            padding: '10px 20px', background: 'var(--obs-purple)', color: '#fff',
            border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer',
          }}
        >
          {searching ? <Loader2 size={14} className="spin" /> : <Search size={14} />}
        </button>
      </div>

      {/* Results */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {results.map((r, i) => (
          <button
            key={i}
            onClick={() => r.filename && onSelectFile(String(r.filename))}
            style={{
              display: 'block', width: '100%', textAlign: 'left', padding: '14px 16px',
              background: 'var(--obs-bg-panel)', border: '1px solid var(--obs-border-subtle)',
              borderRadius: 8, cursor: 'pointer', color: 'var(--obs-text)',
              transition: 'all 150ms ease',
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--obs-purple)'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--obs-border-subtle)'; }}
          >
            <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>
              {String(r.title || r.filename || 'Untitled')}
            </div>
            {!!r.snippet && (
              <div style={{ fontSize: 12, color: 'var(--obs-text-dim)', lineHeight: 1.5 }}>
                {String(r.snippet).slice(0, 200)}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, marginTop: 6, fontSize: 11, color: 'var(--obs-text-muted)' }}>
              {!!r.category && <span>{String(r.category)}</span>}
              {!!r.score && <span>score: {(Number(r.score)).toFixed(1)}</span>}
            </div>
          </button>
        ))}
        {results.length === 0 && query && !searching && (
          <div style={{ textAlign: 'center', padding: 24, color: 'var(--obs-text-muted)', fontSize: 13 }}>
            {t('opsidian.noResults')}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Draft Editor (IDE-style inline creation) ────────────────
function DraftEditor({
  draft, onUpdate, onSave, onDiscard, allFiles,
}: {
  draft: { title: string; content: string; category: string; importance: string; tags: string[] };
  onUpdate: (d: typeof draft) => void;
  onSave: (d: typeof draft) => void;
  onDiscard: () => void;
  allFiles: Record<string, import('@/types').MemoryFileInfo>;
}) {
  const { t } = useI18n();
  const [saving, setSaving] = useState(false);

  const allTags = useMemo(() => {
    const tagSet = new Set<string>();
    Object.values(allFiles).forEach(f => f.tags.forEach(t => tagSet.add(t)));
    return Array.from(tagSet).sort();
  }, [allFiles]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(draft);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Toolbar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px',
        borderBottom: '1px solid var(--obs-border-subtle)',
        background: 'var(--obs-bg-panel)',
      }}>
        <select
          value={draft.category}
          onChange={(e) => onUpdate({ ...draft, category: e.target.value })}
          style={{
            padding: '4px 8px', fontSize: 11, background: 'var(--obs-bg-surface)',
            border: '1px solid var(--obs-border)', borderRadius: 4,
            color: 'var(--obs-text)', outline: 'none',
          }}
        >
          <option value="topics">Topics</option>
          <option value="daily">Daily</option>
          <option value="projects">Projects</option>
          <option value="insights">Insights</option>
        </select>
        <select
          value={draft.importance}
          onChange={(e) => onUpdate({ ...draft, importance: e.target.value })}
          style={{
            padding: '4px 8px', fontSize: 11, background: 'var(--obs-bg-surface)',
            border: '1px solid var(--obs-border)', borderRadius: 4,
            color: 'var(--obs-text)', outline: 'none',
          }}
        >
          <option value="critical">Critical</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>
        <TagInput
          tags={draft.tags}
          onChange={(tags) => onUpdate({ ...draft, tags })}
          availableTags={allTags}
          placeholder={t('opsidian.tagsPlaceholder')}
        />
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button
            onClick={onDiscard}
            style={{
              display: 'flex', alignItems: 'center', gap: 4, padding: '5px 12px',
              fontSize: 12, background: 'var(--obs-bg-hover)', color: 'var(--obs-text-dim)',
              border: '1px solid var(--obs-border)', borderRadius: 5, cursor: 'pointer',
            }}
          >
            <X size={12} /> {t('opsidian.cancel')}
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            style={{
              display: 'flex', alignItems: 'center', gap: 4, padding: '5px 14px',
              fontSize: 12, fontWeight: 600, background: 'var(--obs-purple)',
              color: '#fff', border: 'none', borderRadius: 5, cursor: 'pointer',
            }}
          >
            {saving ? <Loader2 size={12} className="spin" /> : <Save size={12} />}
            {t('opsidian.save')}
          </button>
        </div>
      </div>

      {/* Title */}
      <div style={{ padding: '16px 32px 0', maxWidth: 900, margin: '0 auto', width: '100%' }}>
        <input
          value={draft.title}
          onChange={(e) => onUpdate({ ...draft, title: e.target.value })}
          placeholder={t('opsidian.noteTitlePlaceholder')}
          autoFocus
          style={{
            width: '100%', padding: '8px 0', fontSize: 24, fontWeight: 700,
            background: 'transparent', border: 'none', borderBottom: '1px solid var(--obs-border-subtle)',
            color: 'var(--obs-text)', outline: 'none', marginBottom: 16,
          }}
        />
      </div>

      {/* Content textarea */}
      <div style={{ flex: 1, padding: '0 32px 16px', maxWidth: 900, margin: '0 auto', width: '100%' }}>
        <textarea
          value={draft.content}
          onChange={(e) => onUpdate({ ...draft, content: e.target.value })}
          placeholder={t('opsidian.contentPlaceholder')}
          style={{
            width: '100%', height: '100%', minHeight: 300, padding: 0,
            background: 'transparent', color: 'var(--obs-text)',
            border: 'none', fontFamily: 'var(--obs-font-mono)', fontSize: 14,
            lineHeight: 1.8, resize: 'none', outline: 'none',
          }}
        />
      </div>
    </div>
  );
}
