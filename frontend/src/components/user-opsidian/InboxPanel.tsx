/**
 * InboxPanel — card grid for raw captures sitting in the user's
 * Inbox category, awaiting refinement.
 *
 * Reads the per-user capture audit log via `whiteboardApi.listRecentCaptures`
 * for the thumbnail / source-type metadata, and lets the user click
 * through to the regular note editor for full editing.
 *
 * Multi-select / bulk-delete:
 *   • Plain click          → open the capture in the editor.
 *   • Ctrl/Cmd + click     → toggle the card into the selection.
 *   • Shift + click        → range-select from the previous anchor.
 *   • Drag on empty area   → rubber-band marquee selection.
 *   • Ctrl + drag          → marquee ADDS to existing selection.
 *   • Esc                  → clear selection.
 *   • Ctrl + A             → select every visible card.
 *   • "Delete N" button    → bulk-discard via batchDeleteCaptures.
 */

'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { Clock, Image as ImageIcon, Loader2, Trash2, Type, Upload } from 'lucide-react';
import {
  whiteboardApi,
  type WhiteboardCaptureLogEntry,
} from '@/lib/api';
import { uploadCaptureFile } from '@/lib/captureSources';
import { useMultiSelection } from '@/lib/useMultiSelection';
import { useMarqueeSelection } from '@/lib/useMarqueeSelection';
import SuggestionsBar from './SuggestionsBar';
import CaptureToolbar from './CaptureToolbar';

export interface InboxPanelProps {
  /** Called when the user clicks a card — typically opens the editor. */
  onSelectFile: (filename: string) => void;
  /** Bumped whenever a sibling (e.g. CaptureToolbar drop) ingests a new capture. */
  refreshTick?: number;
  sessionId?: string | null;
}

const TYPE_ICON: Record<string, ReactNode> = {
  screenshot: <ImageIcon size={12} />,
  image: <ImageIcon size={12} />,
  text: <Type size={12} />,
};

function timeAgo(isoTs: string): string {
  const ts = Date.parse(isoTs);
  if (!Number.isFinite(ts)) return '';
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h`;
  return `${Math.round(diff / 86_400_000)}d`;
}

export default function InboxPanel({ onSelectFile, refreshTick = 0, sessionId }: InboxPanelProps) {
  const [items, setItems] = useState<WhiteboardCaptureLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [internalTick, setInternalTick] = useState(0);
  const [bulkDeleting, setBulkDeleting] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await whiteboardApi.listRecentCaptures(50);
      setItems(res.captures);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload, refreshTick, internalTick]);

  const onCaptured = useCallback(() => {
    setInternalTick((n) => n + 1);
  }, []);

  const sortedItems = useMemo(() => {
    // Server already returns newest-first, but defend against
    // partially-populated logs by re-sorting locally.
    return [...items].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  }, [items]);

  // ── Selection — keyboard + marquee ───────────────────────────────
  const captureIds = useMemo(
    () => sortedItems.map((it) => it.capture_id),
    [sortedItems],
  );
  const selection = useMultiSelection({ ids: captureIds });
  const marquee = useMarqueeSelection({
    onCommit: (ids, mode) => {
      // Replace mode → ``select(ids)`` even when ids is empty: that
      // path is how the hook signals "user clicked empty area /
      // dragged a marquee over nothing → drop the existing
      // selection." Add mode only mutates when there's something to
      // add — a Ctrl+click on empty area is a no-op.
      if (mode === 'replace') {
        selection.select(ids);
      } else if (ids.size > 0) {
        selection.add(ids);
      }
    },
  });

  const handleCardClick = useCallback(
    (event: React.MouseEvent, item: WhiteboardCaptureLogEntry) => {
      const openIntent = selection.isOpenIntent(event);
      selection.handleItemClick(event, item.capture_id);
      // Plain click also opens the note (single-select + open behaves
      // like a normal click). Ctrl/Shift clicks only mutate the
      // selection — they NEVER open.
      if (openIntent) {
        onSelectFile(item.draft_note);
      }
    },
    [onSelectFile, selection],
  );

  const handleDelete = useCallback(
    async (captureId: string) => {
      if (!confirm('Discard this capture? The draft note and attachment will be removed.')) {
        return;
      }
      try {
        await whiteboardApi.deleteCapture(captureId);
        setInternalTick((n) => n + 1);
      } catch (e) {
        alert(`Delete failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [],
  );

  const handleBulkDelete = useCallback(async () => {
    const ids = Array.from(selection.selectedIds);
    if (ids.length === 0) return;
    if (
      !confirm(
        `Discard ${ids.length} ${ids.length === 1 ? 'capture' : 'captures'}? ` +
          'Their draft notes and attachments will be removed.',
      )
    ) {
      return;
    }
    setBulkDeleting(true);
    try {
      await whiteboardApi.batchDeleteCaptures(ids);
      selection.clear();
      setInternalTick((n) => n + 1);
    } catch (e) {
      alert(`Bulk delete failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBulkDeleting(false);
    }
  }, [selection]);

  // Delete key shortcut while selection is non-empty (and the user
  // isn't typing in an input).
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

  const [dragActive, setDragActive] = useState(false);

  const handleDrop = useCallback(
    async (e: React.DragEvent<HTMLDivElement>) => {
      const files = Array.from(e.dataTransfer?.files ?? []);
      e.preventDefault();
      setDragActive(false);
      if (files.length === 0) return;
      for (const file of files) {
        try {
          await uploadCaptureFile(file, { source: 'file_drop' });
        } catch (err) {
          console.error('[whiteboard] inbox drop upload failed', err);
          setError(err instanceof Error ? err.message : String(err));
        }
      }
      setInternalTick((n) => n + 1);
    },
    [],
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (e.dataTransfer?.types?.includes('Files')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        if (!dragActive) setDragActive(true);
      }
    },
    [dragActive],
  );

  const handleDragLeave = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      // Only clear when the cursor exits the panel itself, not just
      // a child node. relatedTarget === null when dropping outside.
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
        setDragActive(false);
      }
    },
    [],
  );

  // ── Organize-now trigger (was inside SuggestionsBar empty state) ──

  const [organizing, setOrganizing] = useState(false);
  const [organizeError, setOrganizeError] = useState<string | null>(null);
  const [suggestionsTick, setSuggestionsTick] = useState(0);

  const handleOrganizeClick = useCallback(async () => {
    if (organizing) return;
    setOrganizing(true);
    setOrganizeError(null);
    try {
      await whiteboardApi.organizerRun();
      setSuggestionsTick((n) => n + 1);
    } catch (e) {
      setOrganizeError(e instanceof Error ? e.message : String(e));
    } finally {
      setOrganizing(false);
    }
  }, [organizing]);

  // Click-to-browse — same code path as the toolbar's `file_drop`
  // capture source, but invoked directly from the empty-state hero.
  const handleBrowseClick = useCallback(async () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = false;
    input.style.position = 'fixed';
    input.style.opacity = '0';
    input.style.pointerEvents = 'none';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      document.body.removeChild(input);
      if (!file) return;
      try {
        await uploadCaptureFile(file, { source: 'file_drop' });
        setInternalTick((n) => n + 1);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
    document.body.appendChild(input);
    input.click();
  }, []);

  const isEmpty = !loading && sortedItems.length === 0 && !error;
  const selectionCount = selection.selectedIds.size;

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '12px 20px',
          borderBottom: '1px solid var(--obs-border, #2c2c2e)',
        }}
      >
        <h2
          style={{
            margin: 0,
            fontSize: 17,
            fontWeight: 600,
            color: 'var(--obs-text, #d1d1d6)',
          }}
        >
          Inbox
        </h2>
        <span
          style={{
            fontSize: 12,
            color: 'var(--obs-text-muted, #8e8e93)',
          }}
        >
          {sortedItems.length} {sortedItems.length === 1 ? 'capture' : 'captures'}
        </span>

        {selectionCount > 0 && (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              padding: '4px 10px',
              fontSize: 12,
              fontWeight: 500,
              borderRadius: 6,
              background: 'rgba(59,130,246,0.12)',
              color: 'var(--primary-color, #3b82f6)',
              border: '1px solid rgba(59,130,246,0.35)',
            }}
          >
            {selectionCount} selected
            <button
              type="button"
              onClick={() => selection.clear()}
              title="Clear selection (Esc)"
              style={{
                background: 'transparent',
                border: 'none',
                color: 'inherit',
                cursor: 'pointer',
                fontSize: 11,
                padding: '0 4px',
                opacity: 0.7,
              }}
            >
              ✕
            </button>
          </span>
        )}

        {/* Right cluster: bulk-delete (when selection) + Organize + capture sources. */}
        <div
          style={{
            marginLeft: 'auto',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          {selectionCount > 0 && (
            <button
              type="button"
              onClick={handleBulkDelete}
              disabled={bulkDeleting}
              title={`Discard ${selectionCount} selected (Delete)`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '6px 12px',
                fontSize: 13,
                fontWeight: 500,
                borderRadius: 7,
                border: '1px solid rgba(239,68,68,0.45)',
                background: 'rgba(239,68,68,0.10)',
                color: '#ef4444',
                cursor: bulkDeleting ? 'not-allowed' : 'pointer',
                opacity: bulkDeleting ? 0.7 : 1,
              }}
            >
              {bulkDeleting ? (
                <Loader2 size={14} className="spin" />
              ) : (
                <Trash2 size={14} />
              )}
              <span>
                {bulkDeleting ? 'Deleting…' : `Delete ${selectionCount}`}
              </span>
            </button>
          )}
          <button
            type="button"
            onClick={handleOrganizeClick}
            disabled={organizing}
            title={organizeError ?? 'Re-scan whiteboard for groupings, dupes, promotions'}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '6px 12px',
              fontSize: 13,
              fontWeight: 500,
              borderRadius: 7,
              border: organizeError
                ? '1px solid #ef4444'
                : '1px solid var(--obs-border, #2c2c2e)',
              background: organizeError
                ? 'rgba(239,68,68,0.08)'
                : 'var(--obs-bg, rgba(255,255,255,0.04))',
              color: organizeError ? '#ef4444' : 'var(--obs-text, #d1d1d6)',
              cursor: organizing ? 'not-allowed' : 'pointer',
              opacity: organizing ? 0.7 : 1,
            }}
          >
            {organizing ? <Loader2 size={14} className="spin" /> : null}
            <span>{organizing ? 'Organizing…' : 'Organize'}</span>
          </button>
          <CaptureToolbar inline sessionId={sessionId} onCaptured={onCaptured} />
        </div>
      </div>
      <div
        style={{
          flex: 1,
          overflow: 'auto',
          padding: 20,
          position: 'relative',
          // Only show a panel-wide outline while dragging AND there
          // is already content. The empty state hero below is its
          // own full-size dropzone and renders its own dragActive
          // visual — a panel-wide outline on top would look stacked.
          outline:
            dragActive && !isEmpty ? '2px dashed #10b981' : 'none',
          outlineOffset: -8,
          background:
            dragActive && !isEmpty ? 'rgba(16,185,129,0.04)' : undefined,
          transition: 'background 120ms',
        }}
      >
        <SuggestionsBar refreshTick={suggestionsTick} />
        {loading && (
          <div style={{ color: 'var(--obs-text-muted, #8e8e93)', fontSize: 13 }}>Loading…</div>
        )}
        {error && (
          <div
            style={{
              color: '#ef4444',
              background: 'rgba(239,68,68,0.1)',
              border: '1px solid rgba(239,68,68,0.4)',
              padding: 8,
              borderRadius: 6,
              fontSize: 13,
              marginBottom: 12,
            }}
          >
            {error}
          </div>
        )}
        {isEmpty && (
          <button
            type="button"
            onClick={handleBrowseClick}
            style={{
              // Take the entire remaining panel height so the
              // dropzone affordance is the primary call-to-action.
              minHeight: 'min(calc(100vh - 240px), 520px)',
              width: '100%',
              padding: 32,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 18,
              textAlign: 'center',
              borderRadius: 14,
              border: dragActive
                ? '2px dashed #10b981'
                : '2px dashed rgba(16,185,129,0.45)',
              background: dragActive
                ? 'rgba(16,185,129,0.10)'
                : 'rgba(16,185,129,0.025)',
              color: 'var(--obs-text, #d1d1d6)',
              cursor: 'pointer',
              transition:
                'background 120ms, border-color 120ms, transform 80ms',
              fontFamily: 'inherit',
            }}
          >
            <div
              style={{
                width: 88,
                height: 88,
                borderRadius: '50%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'rgba(16,185,129,0.12)',
                color: '#10b981',
                transform: dragActive ? 'scale(1.08)' : 'scale(1)',
                transition: 'transform 120ms',
              }}
            >
              <Upload size={42} />
            </div>
            <div
              style={{
                fontSize: 18,
                fontWeight: 600,
                color: 'var(--obs-text, #d1d1d6)',
              }}
            >
              {dragActive ? 'Drop to upload' : 'Drop a file here'}
            </div>
            <div
              style={{
                fontSize: 13,
                lineHeight: 1.6,
                color: 'var(--obs-text-muted, #8e8e93)',
                maxWidth: 460,
              }}
            >
              or click anywhere in this area to pick one. You can also
              paste an image, or use the <strong>Upload</strong> button
              above.
            </div>
          </button>
        )}
        <div
          {...marquee.containerProps}
          data-marquee-empty
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
            gap: 12,
            ...marquee.containerProps.style,
          }}
        >
          {sortedItems.map((item) => {
            const thumbUrl = item.attachment_path
              ? whiteboardApi.attachmentUrl(item.attachment_path)
              : null;
            const isImage = item.type === 'image' || item.type === 'screenshot' || item.type === 'drawing';
            const isSelected =
              selection.isSelected(item.capture_id) ||
              (marquee.isDragging && marquee.draftIds.has(item.capture_id));

            return (
              <div
                key={item.capture_id}
                data-marquee-item
                ref={(el) => marquee.register(item.capture_id, el)}
                role="button"
                tabIndex={0}
                aria-pressed={isSelected}
                onClick={(e) => handleCardClick(e, item)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelectFile(item.draft_note);
                  }
                }}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  borderRadius: 10,
                  overflow: 'hidden',
                  border: isSelected
                    ? '1px solid var(--primary-color, #3b82f6)'
                    : '1px solid var(--obs-border, #2c2c2e)',
                  outline: isSelected
                    ? '1px solid var(--primary-color, #3b82f6)'
                    : 'none',
                  outlineOffset: -1,
                  background: isSelected
                    ? 'rgba(59,130,246,0.10)'
                    : 'var(--obs-bg-secondary, rgba(255,255,255,0.03))',
                  cursor: 'pointer',
                  transition: 'border-color 120ms, background 120ms',
                }}
              >
                <div
                  style={{
                    aspectRatio: '4 / 3',
                    background: 'rgba(0,0,0,0.2)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    overflow: 'hidden',
                  }}
                >
                  {thumbUrl && isImage ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={thumbUrl}
                      alt={item.draft_note}
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                      loading="lazy"
                    />
                  ) : (
                    <span style={{ fontSize: 28, color: 'var(--obs-text-muted, #8e8e93)' }}>
                      {item.type === 'audio' ? '🎙️' : item.type === 'link' ? '🔗' : '📄'}
                    </span>
                  )}
                </div>
                <div style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--obs-text-muted, #8e8e93)' }}>
                    {TYPE_ICON[item.type] ?? <Type size={12} />}
                    <span>{item.type}</span>
                    <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                      <Clock size={10} />
                      {timeAgo(item.ts)}
                    </span>
                  </div>
                  <div
                    style={{
                      fontSize: 13,
                      color: 'var(--obs-text, #d1d1d6)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={item.draft_note}
                  >
                    {item.draft_note.replace(/^inbox\//, '')}
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDelete(item.capture_id);
                      }}
                      title="Discard capture"
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: 'var(--obs-text-muted, #8e8e93)',
                        cursor: 'pointer',
                        padding: 4,
                        borderRadius: 4,
                      }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}

          {marquee.isDragging && marquee.rect && (
            <_MarqueeOverlay rect={marquee.rect} />
          )}
        </div>
      </div>
    </div>
  );
}


function _MarqueeOverlay({
  rect,
}: { rect: { left: number; top: number; width: number; height: number } }) {
  const style: CSSProperties = {
    position: 'absolute',
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    border: '1px dashed rgba(59,130,246,0.85)',
    background: 'rgba(59,130,246,0.10)',
    pointerEvents: 'none',
    zIndex: 5,
    borderRadius: 4,
  };
  return <div style={style} />;
}
