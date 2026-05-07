/**
 * InboxPanel — card grid for raw captures sitting in the user's
 * Inbox category, awaiting refinement.
 *
 * Reads the per-user capture audit log via `whiteboardApi.listRecentCaptures`
 * for the thumbnail / source-type metadata, and lets the user click
 * through to the regular note editor for full editing.
 *
 * Phase 1 deliverable. Phases 3+ will add bulk select / share /
 * inline action buttons on each card.
 */

'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Clock, Image as ImageIcon, Trash2, Type, Upload } from 'lucide-react';
import {
  whiteboardApi,
  type WhiteboardCaptureLogEntry,
} from '@/lib/api';
import SuggestionsBar from './SuggestionsBar';
import CaptureToolbar from './CaptureToolbar';

export interface InboxPanelProps {
  /** Called when the user clicks a card — typically opens the editor. */
  onSelectFile: (filename: string) => void;
  /** Bumped whenever a sibling (e.g. CaptureToolbar drop) ingests a new capture. */
  refreshTick?: number;
  sessionId?: string | null;
}

const TYPE_ICON: Record<string, JSX.Element> = {
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

  const sortedItems = useMemo(() => {
    // Server already returns newest-first, but defend against
    // partially-populated logs by re-sorting locally.
    return [...items].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  }, [items]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '12px 16px',
          borderBottom: '1px solid var(--obs-border, #2c2c2e)',
        }}
      >
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: 'var(--obs-text, #d1d1d6)' }}>
          📥 Inbox
        </h2>
        <span style={{ fontSize: 12, color: 'var(--obs-text-muted, #8e8e93)' }}>
          {sortedItems.length} {sortedItems.length === 1 ? 'capture' : 'captures'}
        </span>
      </div>
      <CaptureToolbar sessionId={sessionId} onCaptured={onCaptured} />
      <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
        <SuggestionsBar />
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
        {!loading && sortedItems.length === 0 && !error && (
          <div
            style={{
              padding: '24px 12px',
              textAlign: 'center',
              color: 'var(--obs-text-muted, #8e8e93)',
              fontSize: 13,
              border: '1px dashed var(--obs-border, #2c2c2e)',
              borderRadius: 8,
            }}
          >
            <div style={{ marginBottom: 8 }}>
              <Upload size={28} />
            </div>
            No captures yet. Drop a file, paste an image, or use the
            <strong> Capture </strong> buttons above.
          </div>
        )}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
            gap: 12,
          }}
        >
          {sortedItems.map((item) => {
            const thumbUrl = item.attachment_path
              ? whiteboardApi.attachmentUrl(item.attachment_path)
              : null;
            const isImage = item.type === 'image' || item.type === 'screenshot' || item.type === 'drawing';
            return (
              <div
                key={item.capture_id}
                role="button"
                tabIndex={0}
                onClick={() => onSelectFile(item.draft_note)}
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
                  border: '1px solid var(--obs-border, #2c2c2e)',
                  background: 'var(--obs-bg-secondary, rgba(255,255,255,0.03))',
                  cursor: 'pointer',
                  transition: 'border-color 120ms',
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
        </div>
      </div>
    </div>
  );
}
