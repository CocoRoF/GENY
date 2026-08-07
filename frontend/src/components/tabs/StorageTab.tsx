'use client';

// 세션 스토리지 — Finder-style file explorer over the agent workspace.
//
// Model: navigate INTO directories (breadcrumb + double-click), not a static
// tree. Single click selects (right-hand preview); double click opens
// (folder → enter, file → full overlay viewer). Write operations (new
// folder / rename / delete / upload / drag-drop) exist ONLY in the
// workspace scope — the '전체' scope is a read-only operator view of the
// whole session dir, and the backend enforces the same boundary.

import { useState, useEffect, useCallback, useMemo, useRef, type ReactNode } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { agentApi } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import {
  ChevronRight, Download, RefreshCw, FolderPlus, Upload, HardDrive,
  Folder, FileJson, FileText, FileCode, Globe, Palette, ScrollText,
  Settings, File as FileIcon, Image as ImageIcon, FileSpreadsheet,
  Presentation, X, ArrowUp, Music, Link2, Home,
} from 'lucide-react';
import type { StorageFile } from '@/types';
import { FileViewer } from '@/components/file-viewer';
import { TabShell, IconButton, EmptyState, SegmentedControl } from '@/components/common/layout';

type Scope = 'workspace' | 'all';
type SortKey = 'name' | 'size' | 'modified';

interface Entry {
  name: string;
  path: string;        // scope-relative path
  isDir: boolean;
  size: number;
  modified: string | null;
}

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico']);
const OFFICE_EXT = new Set(['docx', 'xlsx', 'pptx', 'pdf']);
const AUDIO_EXT = new Set(['wav', 'mp3', 'm4a', 'ogg', 'oga', 'webm', 'flac']);
const TEXT_MAX_PREVIEW = 512 * 1024;

function ext(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

function formatSize(bytes: number): string {
  if (!bytes) return '—';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
      ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function fileIcon(name: string, isDir: boolean, size = 15): React.ReactNode {
  if (isDir) return <Folder size={size} className="text-[#4f9cf7] fill-[#4f9cf7]/25" />;
  const e = ext(name);
  if (IMAGE_EXT.has(e)) return <ImageIcon size={size} className="text-[#a855f7]" />;
  if (AUDIO_EXT.has(e)) return <Music size={size} className="text-[#ec4899]" />;
  const map: Record<string, React.ReactNode> = {
    json: <FileJson size={size} className="text-[#f59e0b]" />,
    md: <FileText size={size} className="text-[#60a5fa]" />,
    txt: <FileText size={size} className="text-[var(--text-muted)]" />,
    py: <FileCode size={size} className="text-[#22c55e]" />,
    js: <FileCode size={size} className="text-[#facc15]" />,
    ts: <FileCode size={size} className="text-[#3b82f6]" />,
    tsx: <FileCode size={size} className="text-[#3b82f6]" />,
    html: <Globe size={size} className="text-[#f97316]" />,
    css: <Palette size={size} className="text-[#a855f7]" />,
    log: <ScrollText size={size} className="text-[var(--text-muted)]" />,
    yaml: <Settings size={size} className="text-[#6b7280]" />,
    yml: <Settings size={size} className="text-[#6b7280]" />,
    xlsx: <FileSpreadsheet size={size} className="text-[#22c55e]" />,
    csv: <FileSpreadsheet size={size} className="text-[#22c55e]" />,
    pptx: <Presentation size={size} className="text-[#f97316]" />,
    docx: <FileText size={size} className="text-[#3b82f6]" />,
    pdf: <FileText size={size} className="text-[#ef4444]" />,
  };
  return map[e] || <FileIcon size={size} className="text-[var(--text-muted)]" />;
}

/** Authed image that resolves through storage-raw (plain <img> can't send
 *  the Authorization header). */
function AuthedImage({ sessionId, path, className, alt }: {
  sessionId: string; path: string; className?: string; alt?: string;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let revoked: string | null = null;
    let alive = true;
    setUrl(null); setFailed(false);
    agentApi.fetchStorageBlobUrl(sessionId, path)
      .then((u) => { if (alive) { revoked = u; setUrl(u); } else URL.revokeObjectURL(u); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; if (revoked) URL.revokeObjectURL(revoked); };
  }, [sessionId, path]);
  if (failed) return <div className="text-[12px] text-[var(--text-muted)] p-4">⚠ image load failed</div>;
  if (!url) return <div className="animate-pulse bg-[var(--bg-tertiary)] rounded w-full h-40" />;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} className={className} alt={alt || path} />;
}

/** Authed audio player — storage-raw needs the Authorization header,
 *  so the bytes come through a blob URL like images do. */
function AuthedAudio({ sessionId, path }: { sessionId: string; path: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let revoked: string | null = null;
    let alive = true;
    setUrl(null); setFailed(false);
    agentApi.fetchStorageBlobUrl(sessionId, path)
      .then((u) => { if (alive) { revoked = u; setUrl(u); } else URL.revokeObjectURL(u); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; if (revoked) URL.revokeObjectURL(revoked); };
  }, [sessionId, path]);
  if (failed) return <div className="text-[12px] text-[var(--text-muted)] p-4">⚠ audio load failed</div>;
  if (!url) return <div className="animate-pulse bg-[var(--bg-tertiary)] rounded h-12 w-full" />;
  return <audio src={url} controls className="w-full" />;
}

interface StorageTabProps {
  // All optional: the session tab renders it bare, the cloud view drives it.
  /** Storage SCOPE to browse. Defaults to the selected session; the cloud
   *  view passes `_cloud` or a connected agent's id, so one explorer
   *  serves every surface instead of a second one drifting from it. */
  scopeId?: string;
  /** Start inside a subdirectory (the cloud view opens linked folders). */
  initialPath?: string;
  /** The cloud view supplies its own header and source picker. */
  embedded?: boolean;
  /** Description for the header's left slot, so an embedded host does not
   *  need a separate row for it above the toolbar. */
  hint?: ReactNode;
  /** Extra work for the refresh button. The cloud view has state of its own
   *  (connected agents, linked folders) that its removed header button used
   *  to refresh; this keeps that reachable from the merged bar. */
  onRefresh?: () => void;
}

export default function StorageTab(props: StorageTabProps) {
  const { scopeId, initialPath, embedded, hint, onRefresh } = props;
  const { selectedSessionId: storeSessionId } = useAppStore();
  const selectedSessionId = scopeId ?? storeSessionId;
  const { t } = useI18n();

  const [files, setFiles] = useState<StorageFile[]>([]);
  const [scope, setScope] = useState<Scope>('workspace');
  const [cwd, setCwd] = useState(initialPath ?? '');
  const [selected, setSelected] = useState<Entry | null>(null);
  const [listError, setListError] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortAsc, setSortAsc] = useState(true);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [menu, setMenu] = useState<{ x: number; y: number; target: Entry | null } | null>(null);
  const [viewer, setViewer] = useState<Entry | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [previewWidth, setPreviewWidth] = useState(340);
  const [resizing, setResizing] = useState(false);
  const [syncDevices, setSyncDevices] = useState<Array<{ device_id: string; device_name: string }>>([]);
  // Linked folders: workspace subdirectories that are really folders on a
  // user's computer, shared in through GenyDrive. Without this the
  // explorer would present someone's laptop folder as the agent's own.
  const [links, setLinks] = useState<Array<{ name: string; device: string }>>([]);
  const listRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const splitRef = useRef<HTMLDivElement>(null);

  const canWrite = scope === 'workspace';
  /** A linked folder is a TOP-LEVEL workspace directory whose name the
   *  connector published — nested folders of the same name are ordinary. */
  const linkOf = useCallback(
    (entry: Entry) =>
      entry.isDir && scope === 'workspace' && !cwd
        ? links.find((l) => l.name === entry.name)
        : undefined,
    [links, scope, cwd],
  );
  /** scope-relative → storage-root-relative (what the backend APIs expect). */
  const rootPath = useCallback(
    (p: string) => (scope === 'workspace' ? (p ? `workspace/${p}` : 'workspace') : p),
    [scope],
  );

  const fetchFiles = useCallback(async () => {
    if (!selectedSessionId) return;
    try {
      const res = await agentApi.listStorage(selectedSessionId, scope);
      setFiles(res.files || []);
      setListError(false);
    } catch {
      setFiles([]);
      setListError(true);
    }
  }, [selectedSessionId, scope]);

  useEffect(() => {
    fetchFiles();
    setCwd('');
    setSelected(null);
    setViewer(null);
  }, [fetchFiles]);

  // Session-still-resuming race: one delayed retry instead of a false empty.
  useEffect(() => {
    if (!listError) return;
    const timer = setTimeout(() => { void fetchFiles(); }, 1500);
    return () => clearTimeout(timer);
  }, [listError, fetchFiles]);

  // Connector replicas syncing this workspace (chip in the breadcrumb bar).
  useEffect(() => {
    if (!selectedSessionId) return;
    let alive = true;
    const load = () => {
      agentApi.syncDevices(selectedSessionId)
        .then((r) => { if (alive) setSyncDevices(r.devices || []); })
        .catch(() => { if (alive) setSyncDevices([]); });
      agentApi.storageLinks(selectedSessionId)
        .then((r) => { if (alive) setLinks(r.links || []); })
        .catch(() => { if (alive) setLinks([]); });
    };
    load();
    const timer = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(timer); };
  }, [selectedSessionId]);

  // Close the context menu on any click / Esc.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null); };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('click', close); window.removeEventListener('keydown', onKey); };
  }, [menu]);

  useEffect(() => {
    if (renaming) setTimeout(() => renameInputRef.current?.focus(), 30);
  }, [renaming]);

  // Restore the user's preferred preview width once on mount.
  useEffect(() => {
    const saved = Number(localStorage.getItem('geny.storage.previewWidth'));
    if (saved >= 240) setPreviewWidth(saved);
  }, []);

  // Splitter drag: preview width = distance from cursor to the split
  // container's right edge, clamped so neither pane can collapse.
  useEffect(() => {
    if (!resizing) return;
    const onMove = (e: MouseEvent) => {
      const box = splitRef.current?.getBoundingClientRect();
      if (!box) return;
      const max = Math.max(260, box.width * 0.7);
      const w = Math.min(max, Math.max(240, box.right - e.clientX - 6));
      setPreviewWidth(w);
      e.preventDefault();
    };
    const onUp = () => setResizing(false);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [resizing]);

  useEffect(() => {
    if (!resizing) localStorage.setItem('geny.storage.previewWidth', String(Math.round(previewWidth)));
  }, [resizing, previewWidth]);

  // ── Directory model: derive the current dir's entries from the flat list.
  const entries = useMemo<Entry[]>(() => {
    const prefix = cwd ? cwd + '/' : '';
    const dirs = new Map<string, Entry>();
    const out: Entry[] = [];
    for (const f of files) {
      const p = f.path;
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      if (!rest) continue;
      const slash = rest.indexOf('/');
      const isDirEntry = f.is_dir ?? f.is_directory ?? false;
      if (slash === -1) {
        if (isDirEntry) {
          if (!dirs.has(rest)) {
            dirs.set(rest, { name: rest, path: p, isDir: true, size: 0, modified: f.modified_at ?? null });
          }
        } else {
          out.push({
            name: rest, path: p, isDir: false,
            size: f.size || 0, modified: f.modified_at ?? null,
          });
        }
      } else {
        // deeper entry → implies a (possibly unlisted) child dir
        const dirName = rest.slice(0, slash);
        const existing = dirs.get(dirName);
        if (!existing) {
          dirs.set(dirName, { name: dirName, path: prefix + dirName, isDir: true, size: 0, modified: null });
        }
        if (!isDirEntry) {
          const d = dirs.get(dirName)!;
          d.size += f.size || 0;
        }
      }
    }
    const cmp = (a: Entry, b: Entry) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1; // folders first
      let r = 0;
      if (sortKey === 'name') r = a.name.localeCompare(b.name, undefined, { numeric: true });
      else if (sortKey === 'size') r = a.size - b.size;
      else r = (a.modified || '').localeCompare(b.modified || '');
      return sortAsc ? r : -r;
    };
    return [...dirs.values(), ...out].sort(cmp);
  }, [files, cwd, sortKey, sortAsc]);

  const crumbs = useMemo(() => (cwd ? cwd.split('/') : []), [cwd]);

  // ── Actions ─────────────────────────────────────────────────────────
  const openEntry = useCallback((entry: Entry) => {
    if (entry.isDir) {
      setCwd(entry.path);
      setSelected(null);
    } else {
      setViewer(entry);
    }
  }, []);

  const startRename = useCallback((entry: Entry) => {
    if (!canWrite) return;
    setRenaming(entry.path);
    setRenameValue(entry.name);
  }, [canWrite]);

  const commitRename = useCallback(async () => {
    if (!renaming || !selectedSessionId) { setRenaming(null); return; }
    const entry = entries.find((e) => e.path === renaming);
    const newName = renameValue.trim();
    setRenaming(null);
    if (!entry || !newName || newName === entry.name || newName.includes('/')) return;
    const dst = (cwd ? cwd + '/' : '') + newName;
    try {
      await agentApi.renameStorage(selectedSessionId, rootPath(entry.path), rootPath(dst));
      await fetchFiles();
      setSelected(null);
    } catch (e) {
      alert(t('storageTab.renameError', { message: e instanceof Error ? e.message : String(e) }));
    }
  }, [renaming, renameValue, entries, cwd, selectedSessionId, rootPath, fetchFiles, t]);

  const deleteEntry = useCallback(async (entry: Entry) => {
    if (!canWrite || !selectedSessionId) return;
    if (!window.confirm(t('storageTab.confirmDelete', { name: entry.name }))) return;
    try {
      await agentApi.deleteStorageEntry(selectedSessionId, rootPath(entry.path));
      if (selected?.path === entry.path) setSelected(null);
      await fetchFiles();
    } catch (e) {
      alert(t('storageTab.deleteError', { message: e instanceof Error ? e.message : String(e) }));
    }
  }, [canWrite, selectedSessionId, rootPath, fetchFiles, selected, t]);

  const newFolder = useCallback(async () => {
    if (!canWrite || !selectedSessionId) return;
    const base = t('storageTab.newFolderName');
    const names = new Set(entries.map((e) => e.name));
    let name = base;
    for (let i = 2; names.has(name); i++) name = `${base} ${i}`;
    const p = (cwd ? cwd + '/' : '') + name;
    try {
      await agentApi.mkdirStorage(selectedSessionId, rootPath(p));
      await fetchFiles();
      setRenaming(p);
      setRenameValue(name);
    } catch (e) {
      alert(t('storageTab.mkdirError', { message: e instanceof Error ? e.message : String(e) }));
    }
  }, [canWrite, selectedSessionId, entries, cwd, rootPath, fetchFiles, t]);

  const uploadFiles = useCallback(async (fileList: FileList | File[] | null) => {
    if (!canWrite || !selectedSessionId || !fileList?.length) return;
    setUploading(true);
    try {
      // Upload lands in the CURRENT directory (root → uploads/ bucket).
      const subdir = cwd || 'uploads';
      for (const f of Array.from(fileList)) {
        await agentApi.uploadToWorkspace(selectedSessionId, f, subdir);
      }
      await fetchFiles();
    } catch {
      alert(t('storageTab.uploadError'));
    } finally {
      setUploading(false);
    }
  }, [canWrite, selectedSessionId, cwd, fetchFiles, t]);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (renaming) return;
    if (e.key === 'Enter' && selected) { e.preventDefault(); openEntry(selected); }
    else if (e.key === 'F2' && selected) { e.preventDefault(); startRename(selected); }
    else if (e.key === 'Delete' && selected) { e.preventDefault(); void deleteEntry(selected); }
    else if (e.key === 'Backspace' && cwd) {
      e.preventDefault();
      setCwd(crumbs.slice(0, -1).join('/'));
      setSelected(null);
    }
  }, [renaming, selected, openEntry, startRename, deleteEntry, cwd, crumbs]);

  // ── Early returns ───────────────────────────────────────────────────
  if (!selectedSessionId) {
    return (
      <TabShell title={t('storageTab.title')} icon={HardDrive}>
        <EmptyState title={t('storageTab.selectSession')} description={t('storageTab.selectSessionDesc')} />
      </TabShell>
    );
  }

  // ── Render ──────────────────────────────────────────────────────────
  return (
    <TabShell
      title={
        embedded
          ? (hint ? (
              <span className="text-[12px] font-normal text-[var(--text-muted)]">{hint}</span>
            ) : '')
          : t('storageTab.title')
      }
      icon={embedded ? undefined : HardDrive}
      titleExtra={
        // The operator-only "everything" scope is a session concept; the
        // cloud has no internal state to reveal, so the picker is hidden
        // when embedded.
        embedded ? undefined : (
        <SegmentedControl
          ariaLabel={t('storageTab.title')}
          items={[
            { id: 'workspace', label: t('storageTab.scopeWorkspace') },
            { id: 'all', label: t('storageTab.scopeAll') },
          ]}
          value={scope}
          onChange={(s) => setScope(s as Scope)}
        />
        )
      }
      actions={
        <>
          {canWrite && (
            <>
              <IconButton icon={FolderPlus} title={t('storageTab.newFolder')} onClick={() => void newFolder()} />
              <input
                ref={uploadInputRef}
                type="file" multiple className="hidden"
                onChange={(e) => { void uploadFiles(e.target.files); if (e.target) e.target.value = ''; }}
              />
              <IconButton
                icon={Upload}
                title={t('storageTab.upload')}
                spin={uploading}
                disabled={uploading}
                onClick={() => uploadInputRef.current?.click()}
              />
            </>
          )}
          <IconButton
            icon={Download}
            title={t('storageTab.downloadFolder')}
            onClick={() => void agentApi.downloadFolder(selectedSessionId, rootPath(cwd)).catch(() => alert(t('storageTab.downloadFolderError')))}
          />
          <IconButton
            icon={RefreshCw}
            title={t('common.refresh')}
            onClick={() => { fetchFiles(); onRefresh?.(); }}
          />
        </>
      }
    >
      <div className="h-full flex flex-col p-3 md:p-4 gap-2 min-h-0">
        {/* Breadcrumb bar. Embedded at the root it would hold nothing but the
            root crumb itself, so it is dropped and the listing starts directly
            under the toolbar. It comes back the moment it carries something:
            a path, the read-only badge, or a sync indicator. */}
        {(!embedded || cwd || !canWrite || syncDevices.length > 0) && (
        <div className="flex items-center gap-0.5 text-[13px] px-1 shrink-0 select-none">
          {cwd && (
            <button
              className="p-1 mr-1 rounded hover:bg-[var(--bg-hover)] text-[var(--text-secondary)]"
              onClick={() => { setCwd(crumbs.slice(0, -1).join('/')); setSelected(null); }}
              title={t('storageTab.goUp')}
            >
              <ArrowUp size={14} />
            </button>
          )}
          <button
            className={`px-2 py-1 rounded-md hover:bg-[var(--bg-hover)] ${cwd ? 'text-[var(--text-secondary)]' : 'font-semibold text-[var(--text-primary)]'}`}
            onClick={() => { setCwd(''); setSelected(null); }}
            title={embedded ? t('storageTab.goToRoot') : undefined}
          >
            {/* Embedded, the scope name is noise: the host already says which
                source is open, and "워크스페이스" is simply wrong for the
                cloud. An icon keeps the click target for going back to root. */}
            {embedded
              ? <Home size={14} />
              : (scope === 'workspace' ? t('storageTab.scopeWorkspace') : t('storageTab.scopeAll'))}
          </button>
          {crumbs.map((c, i) => (
            <span key={i} className="flex items-center gap-0.5">
              <ChevronRight size={13} className="text-[var(--text-muted)]" />
              <button
                className={`px-2 py-1 rounded-md hover:bg-[var(--bg-hover)] ${i === crumbs.length - 1 ? 'font-semibold text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'}`}
                onClick={() => { setCwd(crumbs.slice(0, i + 1).join('/')); setSelected(null); }}
              >
                {c}
              </button>
            </span>
          ))}
          {!canWrite && (
            <span className="ml-2 text-[11px] px-2 py-0.5 rounded-full bg-[var(--bg-tertiary)] text-[var(--text-muted)]">
              {t('storageTab.readOnly')}
            </span>
          )}
          {syncDevices.length > 0 && (
            <span
              className="ml-2 inline-flex items-center gap-1.5 text-[11px] px-2 py-0.5 rounded-full bg-[var(--accent-color)]/10 text-[var(--accent-color)]"
              title={syncDevices.map((d) => d.device_name || d.device_id.slice(0, 8)).join(', ')}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent-color)] animate-pulse" />
              {t('storageTab.syncDevices', { count: syncDevices.length })}
            </span>
          )}
        </div>
        )}

        <div ref={splitRef} className="flex-1 flex min-h-0">
          {/* File list */}
          <div
            ref={listRef}
            tabIndex={0}
            onKeyDown={onKeyDown}
            className={`flex-1 min-w-0 flex flex-col bg-[var(--bg-secondary)] border rounded-[var(--border-radius)] overflow-hidden outline-none ${dragOver ? 'border-[var(--accent-color)] ring-2 ring-[var(--accent-color)]/30' : 'border-[var(--border-color)]'}`}
            onDragOver={(e) => { if (canWrite && e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragOver(true); } }}
            onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false); }}
            onDrop={(e) => {
              if (!canWrite) return;
              e.preventDefault(); setDragOver(false);
              void uploadFiles(e.dataTransfer.files);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY, target: null });
            }}
          >
            {/* Column header */}
            <div className="flex items-center px-3 py-1.5 border-b border-[var(--border-color)] text-[11px] font-medium text-[var(--text-muted)] uppercase tracking-wide select-none shrink-0">
              {([['name', t('storageTab.colName'), 'flex-1'], ['size', t('storageTab.colSize'), 'w-[84px] text-right'], ['modified', t('storageTab.colModified'), 'w-[130px] text-right pr-1']] as [SortKey, string, string][]).map(([key, label, cls]) => (
                <button
                  key={key}
                  className={`${cls} hover:text-[var(--text-primary)] text-left ${key !== 'name' ? 'text-right' : ''}`}
                  onClick={() => {
                    if (sortKey === key) setSortAsc(!sortAsc);
                    else { setSortKey(key); setSortAsc(true); }
                  }}
                >
                  {label}{sortKey === key ? (sortAsc ? ' ↑' : ' ↓') : ''}
                </button>
              ))}
            </div>

            {/* Rows */}
            <div className="flex-1 overflow-y-auto py-1">
              {entries.length === 0 ? (
                <p className="text-[var(--text-muted)] text-[13px] text-center py-10">
                  {listError ? t('storageTab.loadRetrying')
                    : dragOver ? t('storageTab.dropToUpload')
                    : t('storageTab.emptyDir')}
                </p>
              ) : entries.map((entry) => (
                <div
                  key={entry.path}
                  className={`flex items-center gap-2.5 mx-1.5 px-2 py-[7px] rounded-lg cursor-default text-[13px] transition-colors ${selected?.path === entry.path ? 'bg-[var(--accent-color)]/12 text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'}`}
                  onClick={() => setSelected(entry)}
                  onDoubleClick={() => openEntry(entry)}
                  onContextMenu={(e) => {
                    e.preventDefault(); e.stopPropagation();
                    setSelected(entry);
                    setMenu({ x: e.clientX, y: e.clientY, target: entry });
                  }}
                >
                  <span className="shrink-0">
                    {linkOf(entry) ? (
                      <Link2 size={15} className="text-[#8b5cf6]" />
                    ) : (
                      fileIcon(entry.name, entry.isDir)
                    )}
                  </span>
                  {renaming === entry.path ? (
                    <input
                      ref={renameInputRef}
                      className="flex-1 min-w-0 bg-[var(--bg-primary)] border border-[var(--accent-color)] rounded px-1.5 py-0.5 text-[13px] outline-none"
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === 'Enter') void commitRename();
                        else if (e.key === 'Escape') setRenaming(null);
                      }}
                      onBlur={() => void commitRename()}
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <span className="flex-1 min-w-0 truncate">
                      {entry.name}
                      {linkOf(entry) && (
                        <span
                          className="ml-2 text-[10.5px] px-1.5 py-[1px] rounded-full bg-[#8b5cf6]/12 text-[#8b5cf6] align-middle"
                          title={t('storageTab.linkedFolderHint', { device: linkOf(entry)?.device || '' })}
                        >
                          {t('storageTab.linkedFolder')}
                        </span>
                      )}
                    </span>
                  )}
                  <span className="w-[84px] text-right text-[12px] text-[var(--text-muted)] tabular-nums shrink-0">
                    {entry.isDir ? '—' : formatSize(entry.size)}
                  </span>
                  <span className="w-[130px] text-right text-[12px] text-[var(--text-muted)] tabular-nums shrink-0 pr-1">
                    {formatDate(entry.modified)}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Splitter — the gap between the panes doubles as a resize
              handle: invisible at rest, a soft accent bar on hover, solid
              while dragging. Double-click resets to the default width. */}
          {selected && !selected.isDir && (
            <div
              className="hidden lg:flex w-3 shrink-0 items-stretch justify-center cursor-col-resize select-none group"
              onMouseDown={(e) => { e.preventDefault(); setResizing(true); }}
              onDoubleClick={() => setPreviewWidth(340)}
              role="separator"
              aria-orientation="vertical"
              title={t('storageTab.resizeHint')}
            >
              <div
                className={`w-[3px] my-3 rounded-full transition-colors duration-150 ${resizing ? 'bg-[var(--accent-color)]' : 'bg-transparent group-hover:bg-[var(--accent-color)]/45'}`}
              />
            </div>
          )}

          {/* Preview panel */}
          {selected && !selected.isDir && (
            <div
              className="hidden lg:flex shrink-0 flex-col bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-[var(--border-radius)] overflow-hidden"
              style={{ width: previewWidth }}
            >
              <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border-color)] shrink-0">
                {fileIcon(selected.name, false, 14)}
                <span className="flex-1 truncate text-[13px] font-medium">{selected.name}</span>
                <button className="p-1 rounded hover:bg-[var(--bg-hover)]" onClick={() => setSelected(null)}>
                  <X size={13} />
                </button>
              </div>
              <div className="flex-1 overflow-auto p-3">
                <QuickPreview sessionId={selectedSessionId} entry={selected} rootPath={rootPath} t={t} />
              </div>
              <div className="border-t border-[var(--border-color)] px-3 py-2 text-[11px] text-[var(--text-muted)] flex justify-between shrink-0">
                <span>{formatSize(selected.size)}</span>
                <span>{formatDate(selected.modified)}</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Context menu */}
      {menu && (
        <div
          className="fixed z-[300] min-w-[170px] py-1 rounded-xl border border-[var(--border-color)] bg-[var(--bg-primary)] shadow-2xl text-[13px]"
          style={{ left: Math.min(menu.x, window.innerWidth - 190), top: Math.min(menu.y, window.innerHeight - 220) }}
          onClick={(e) => e.stopPropagation()}
        >
          {menu.target ? (
            <>
              <MenuItem label={t('storageTab.open')} onClick={() => { openEntry(menu.target!); setMenu(null); }} />
              {!menu.target.isDir && (
                <MenuItem
                  label={t('storageTab.download')}
                  onClick={() => {
                    void agentApi.downloadStorageFile(selectedSessionId, rootPath(menu.target!.path), menu.target!.name);
                    setMenu(null);
                  }}
                />
              )}
              {menu.target.isDir && (
                <MenuItem
                  label={t('storageTab.downloadZip')}
                  onClick={() => {
                    void agentApi.downloadFolder(selectedSessionId, rootPath(menu.target!.path)).catch(() => alert(t('storageTab.downloadFolderError')));
                    setMenu(null);
                  }}
                />
              )}
              {canWrite && (
                <>
                  <div className="h-px my-1 bg-[var(--border-color)]" />
                  <MenuItem label={t('storageTab.rename')} onClick={() => { startRename(menu.target!); setMenu(null); }} />
                  <MenuItem danger label={t('storageTab.delete')} onClick={() => { void deleteEntry(menu.target!); setMenu(null); }} />
                </>
              )}
            </>
          ) : (
            <>
              {canWrite && <MenuItem label={t('storageTab.newFolder')} onClick={() => { void newFolder(); setMenu(null); }} />}
              <MenuItem label={t('common.refresh')} onClick={() => { void fetchFiles(); setMenu(null); }} />
            </>
          )}
        </div>
      )}

      {/* Full overlay viewer (double-click open) */}
      {viewer && (
        <div
          className="fixed inset-0 z-[280] bg-black/60 backdrop-blur-sm flex items-center justify-center p-6"
          onClick={() => setViewer(null)}
        >
          <div
            className="w-full max-w-5xl max-h-[88vh] flex flex-col bg-[var(--bg-primary)] rounded-2xl border border-[var(--border-color)] shadow-2xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2.5 px-4 py-3 border-b border-[var(--border-color)] shrink-0">
              {fileIcon(viewer.name, false, 16)}
              <span className="flex-1 truncate text-[14px] font-semibold">{viewer.name}</span>
              <button
                className="px-2.5 py-1 rounded-lg border border-[var(--border-color)] text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                onClick={() => void agentApi.downloadStorageFile(selectedSessionId, rootPath(viewer.path), viewer.name)}
              >
                {t('storageTab.download')}
              </button>
              <button className="p-1.5 rounded-lg hover:bg-[var(--bg-hover)]" onClick={() => setViewer(null)}>
                <X size={16} />
              </button>
            </div>
            <div className="flex-1 overflow-auto min-h-[300px]">
              <FullPreview sessionId={selectedSessionId} entry={viewer} rootPath={rootPath} t={t} />
            </div>
          </div>
        </div>
      )}
    </TabShell>
  );
}

function MenuItem({ label, onClick, danger }: { label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      className={`w-full text-left px-3.5 py-1.5 hover:bg-[var(--bg-hover)] ${danger ? 'text-[var(--danger-color,#ef4444)]' : 'text-[var(--text-primary)]'}`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

/** Small right-panel preview: image thumbnail / text head / office hint. */
function QuickPreview({ sessionId, entry, rootPath, t }: {
  sessionId: string; entry: Entry; rootPath: (p: string) => string;
  t: (k: string, v?: Record<string, string | number>) => string;
}) {
  const e = ext(entry.name);
  if (IMAGE_EXT.has(e)) {
    return <AuthedImage sessionId={sessionId} path={rootPath(entry.path)} className="max-w-full rounded-lg" alt={entry.name} />;
  }
  if (AUDIO_EXT.has(e)) {
    return <AudioPreview sessionId={sessionId} entry={entry} rootPath={rootPath} t={t} />;
  }
  if (OFFICE_EXT.has(e)) {
    return <OfficePreview sessionId={sessionId} entry={entry} rootPath={rootPath} t={t} compact />;
  }
  return <TextPreview sessionId={sessionId} entry={entry} rootPath={rootPath} t={t} compact />;
}

function FullPreview({ sessionId, entry, rootPath, t }: {
  sessionId: string; entry: Entry; rootPath: (p: string) => string;
  t: (k: string, v?: Record<string, string | number>) => string;
}) {
  const e = ext(entry.name);
  if (IMAGE_EXT.has(e)) {
    return (
      <div className="flex items-center justify-center p-6 h-full">
        <AuthedImage sessionId={sessionId} path={rootPath(entry.path)} className="max-w-full max-h-[74vh] rounded-lg object-contain" alt={entry.name} />
      </div>
    );
  }
  if (AUDIO_EXT.has(e)) {
    return (
      <div className="p-6">
        <AudioPreview sessionId={sessionId} entry={entry} rootPath={rootPath} t={t} />
      </div>
    );
  }
  if (OFFICE_EXT.has(e)) {
    return <OfficePreview sessionId={sessionId} entry={entry} rootPath={rootPath} t={t} />;
  }
  return <TextPreview sessionId={sessionId} entry={entry} rootPath={rootPath} t={t} />;
}

function TextPreview({ sessionId, entry, rootPath, t, compact }: {
  sessionId: string; entry: Entry; rootPath: (p: string) => string;
  t: (k: string, v?: Record<string, string | number>) => string; compact?: boolean;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setContent(null); setError(null);
    if (entry.size > TEXT_MAX_PREVIEW) {
      setError(t('storageTab.tooLargePreview'));
      return;
    }
    agentApi.getStorageFile(sessionId, rootPath(entry.path))
      .then((r) => { if (alive) setContent(r.content ?? ''); })
      .catch((err) => { if (alive) setError(err instanceof Error ? err.message : String(err)); });
    return () => { alive = false; };
  }, [sessionId, entry.path, entry.size, rootPath, t]);

  if (error) return <p className="text-[12px] text-[var(--text-muted)] p-4">{error}</p>;
  if (content === null) return <div className="animate-pulse bg-[var(--bg-tertiary)] rounded h-32 m-4" />;
  if (!content) return <p className="text-[12px] text-[var(--text-muted)] p-4">{t('storageTab.emptyFile')}</p>;
  return (
    <FileViewer
      content={compact ? content.slice(0, 4000) : content}
      fileName={entry.name}
      showHeader={!compact}
      className={compact ? 'text-[11px]' : ''}
    />
  );
}

/** Office/PDF preview via the doc-preview render cache (SVG/PNG pages). */
function OfficePreview({ sessionId, entry, rootPath, t, compact }: {
  sessionId: string; entry: Entry; rootPath: (p: string) => string;
  t: (k: string, v?: Record<string, string | number>) => string; compact?: boolean;
}) {
  const [pages, setPages] = useState<string[] | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let alive = true;
    setPages(null); setError(false);
    agentApi.docPreview(sessionId, rootPath(entry.path))
      .then((r: { pages?: string[] }) => { if (alive) setPages(r.pages || []); })
      .catch(() => { if (alive) setError(true); });
    return () => { alive = false; };
  }, [sessionId, entry.path, rootPath]);

  if (error) return <p className="text-[12px] text-[var(--text-muted)] p-4">{t('storageTab.previewUnavailable')}</p>;
  if (pages === null) return <div className="animate-pulse bg-[var(--bg-tertiary)] rounded h-40 m-4" />;
  if (!pages.length) return <p className="text-[12px] text-[var(--text-muted)] p-4">{t('storageTab.previewUnavailable')}</p>;
  const shown = compact ? pages.slice(0, 1) : pages;
  return (
    <div className="flex flex-col gap-3 p-3 items-center">
      {shown.map((p) => (
        <AuthedImage key={p} sessionId={sessionId} path={p} className="max-w-full rounded shadow" alt={entry.name} />
      ))}
      {compact && pages.length > 1 && (
        <p className="text-[11px] text-[var(--text-muted)]">+{pages.length - 1} pages</p>
      )}
    </div>
  );
}

/** Audio preview: native player + the STT transcript sidecar when the
 *  agent has already transcribed this file (framework contract). */
function AudioPreview({ sessionId, entry, rootPath, t }: {
  sessionId: string; entry: Entry; rootPath: (p: string) => string;
  t: (k: string, v?: Record<string, string | number>) => string;
}) {
  const [transcript, setTranscript] = useState<{ text?: string; language?: string } | null>(null);
  useEffect(() => {
    let alive = true;
    setTranscript(null);
    agentApi.getStorageFile(sessionId, rootPath(entry.path) + '.transcript.json')
      .then((r) => {
        if (!alive) return;
        try { setTranscript(JSON.parse(r.content ?? '')); } catch { /* not json */ }
      })
      .catch(() => { /* no transcript yet — fine */ });
    return () => { alive = false; };
  }, [sessionId, entry.path, rootPath]);
  return (
    <div className="flex flex-col gap-3">
      <AuthedAudio sessionId={sessionId} path={rootPath(entry.path)} />
      {transcript?.text && (
        <div className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-tertiary)]/50 p-3">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)] mb-1.5">
            {t('storageTab.transcript')}{transcript.language ? ` · ${transcript.language}` : ''}
          </div>
          <p className="text-[12.5px] leading-relaxed whitespace-pre-wrap">{transcript.text}</p>
        </div>
      )}
    </div>
  );
}
