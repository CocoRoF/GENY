/**
 * SuggestionsBar — surfaces the Phase 5 organizer's recommendations
 * inside InboxPanel.
 *
 * Each card represents one ``OrganizationSuggestion`` from the
 * backend. The user can:
 *   * Accept   — mark the suggestion as decided so it stops re-appearing.
 *   * Snooze   — push it 30 days into the future (still "active",
 *                just hidden until cooldown expires).
 *   * Reject   — strong "don't suggest this again" — backend records
 *                a 90-day cooldown.
 *
 * The bar fetches its own list and exposes a "✨ Organize now" button
 * that runs the strategies on demand. Empty state hides the entire
 * bar so the Inbox stays uncluttered when there are no suggestions.
 */

'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Check,
  ChevronRight,
  Library,
  Loader2,
  Sparkles,
  Trash2,
  Wand2,
  X,
} from 'lucide-react';
import {
  whiteboardApi,
  type WhiteboardOrganizerSuggestion,
} from '@/lib/api';

const ACTION_ICONS: Record<string, ReactNode> = {
  group: <Sparkles size={14} />,
  merge: <Sparkles size={14} />,
  promote_to_library: <Library size={14} />,
  archive: <Trash2 size={14} />,
  tag: <Sparkles size={14} />,
};

const ACTION_LABEL: Record<string, string> = {
  group: 'Group',
  merge: 'Merge',
  promote_to_library: 'Promote to Library',
  archive: 'Archive',
  tag: 'Tag',
};

export interface SuggestionsBarProps {
  /** Bumped externally (e.g. after a capture upload) to force a refetch. */
  refreshTick?: number;
}

export default function SuggestionsBar({ refreshTick = 0 }: SuggestionsBarProps) {
  const [items, setItems] = useState<WhiteboardOrganizerSuggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [internalTick, setInternalTick] = useState(0);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await whiteboardApi.organizerList();
      setItems(res.suggestions ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload, refreshTick, internalTick]);

  const handleRun = useCallback(async () => {
    if (running) return;
    setRunning(true);
    setError(null);
    try {
      const res = await whiteboardApi.organizerRun();
      setItems(res.suggestions ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }, [running]);

  const handleAccept = useCallback(async (id: string) => {
    try {
      await whiteboardApi.organizerAccept(id);
      setInternalTick((n) => n + 1);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const handleReject = useCallback(async (id: string) => {
    try {
      await whiteboardApi.organizerReject(id, 90);
      setInternalTick((n) => n + 1);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const visible = useMemo(() => items.slice(0, 3), [items]);

  // Empty + idle: render nothing. The "Organize now" trigger lives
  // in the InboxPanel header now (single-row chrome), so a separate
  // affordance here would just duplicate it.
  if (!loading && visible.length === 0 && !error) {
    return <div data-whiteboard-slot="suggestions-bar" hidden />;
  }

  return (
    <div
      data-whiteboard-slot="suggestions-bar"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: '12px 14px',
        margin: '0 0 16px',
        borderRadius: 10,
        background: 'rgba(16,185,129,0.06)',
        border: '1px solid rgba(16,185,129,0.3)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Wand2 size={14} color="#10b981" />
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--obs-text)' }}>
          Suggestions
        </span>
        <span
          style={{
            fontSize: 11,
            color: 'var(--obs-text-muted, #8e8e93)',
            padding: '2px 6px',
            borderRadius: 8,
            background: 'rgba(255,255,255,0.04)',
          }}
        >
          {items.length} active
        </span>
        <button
          type="button"
          onClick={handleRun}
          disabled={running}
          style={{
            marginLeft: 'auto',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '3px 9px',
            fontSize: 11,
            border: '1px solid rgba(16,185,129,0.5)',
            borderRadius: 5,
            background: 'rgba(16,185,129,0.08)',
            color: '#10b981',
            cursor: running ? 'not-allowed' : 'pointer',
            opacity: running ? 0.7 : 1,
          }}
        >
          {running ? <Loader2 size={11} className="spin" /> : <Wand2 size={11} />}
          {running ? 'Analysing…' : 'Re-scan'}
        </button>
      </div>
      {error && (
        <div style={{ fontSize: 12, color: '#ef4444' }}>{error}</div>
      )}
      {visible.map((s) => (
        <SuggestionCard
          key={s.suggestion_id}
          suggestion={s}
          onAccept={handleAccept}
          onReject={handleReject}
        />
      ))}
      {items.length > visible.length && (
        <div
          style={{
            fontSize: 11,
            color: 'var(--obs-text-muted, #8e8e93)',
            textAlign: 'center',
            paddingTop: 4,
          }}
        >
          + {items.length - visible.length} more — accept or reject the
          ones above to surface the rest.
        </div>
      )}
    </div>
  );
}


function SuggestionCard({
  suggestion,
  onAccept,
  onReject,
}: {
  suggestion: WhiteboardOrganizerSuggestion;
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
}) {
  const icon = ACTION_ICONS[suggestion.proposed_action] ?? <Sparkles size={14} />;
  const label = ACTION_LABEL[suggestion.proposed_action] ?? suggestion.proposed_action;
  return (
    <div
      style={{
        display: 'flex',
        gap: 10,
        padding: '10px 12px',
        borderRadius: 8,
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid var(--obs-border, #2c2c2e)',
      }}
    >
      <div
        style={{
          width: 28,
          height: 28,
          borderRadius: 6,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'rgba(16,185,129,0.12)',
          color: '#10b981',
        }}
      >
        {icon}
      </div>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--obs-text)' }}>
            {label}: {suggestion.proposed_label}
          </span>
          <span
            style={{
              fontSize: 10,
              color: 'var(--obs-text-muted, #8e8e93)',
              padding: '1px 6px',
              borderRadius: 4,
              background: 'rgba(255,255,255,0.04)',
            }}
          >
            {suggestion.note_filenames.length} note
            {suggestion.note_filenames.length === 1 ? '' : 's'}
          </span>
          <span
            style={{
              fontSize: 10,
              color: 'var(--obs-text-muted, #8e8e93)',
              padding: '1px 6px',
              borderRadius: 4,
              background: 'rgba(255,255,255,0.04)',
            }}
          >
            {Math.round(suggestion.confidence * 100)}%
          </span>
          <span
            style={{
              fontSize: 10,
              color: 'var(--obs-text-muted, #8e8e93)',
              padding: '1px 6px',
              borderRadius: 4,
              background: 'rgba(255,255,255,0.04)',
            }}
          >
            {suggestion.strategy_name}
          </span>
        </div>
        <div style={{ fontSize: 11, color: 'var(--obs-text-muted, #8e8e93)', lineHeight: 1.5 }}>
          {suggestion.rationale}
        </div>
        {suggestion.note_filenames.length <= 6 && (
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 4,
              marginTop: 2,
            }}
          >
            {suggestion.note_filenames.map((fn) => (
              <span
                key={fn}
                style={{
                  fontSize: 10,
                  fontFamily: 'var(--obs-font-mono)',
                  color: 'var(--obs-text-muted, #8e8e93)',
                  padding: '1px 6px',
                  borderRadius: 4,
                  background: 'rgba(255,255,255,0.03)',
                }}
              >
                <ChevronRight size={9} style={{ marginRight: 2 }} />
                {fn}
              </span>
            ))}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 4, alignItems: 'flex-start' }}>
        <button
          type="button"
          onClick={() => onAccept(suggestion.suggestion_id)}
          title="Accept — won't be re-suggested"
          style={{
            border: '1px solid rgba(16,185,129,0.4)',
            background: 'rgba(16,185,129,0.1)',
            color: '#10b981',
            borderRadius: 5,
            padding: '4px 8px',
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 11,
          }}
        >
          <Check size={11} /> Accept
        </button>
        <button
          type="button"
          onClick={() => onReject(suggestion.suggestion_id)}
          title="Reject — won't be re-suggested for 90 days"
          style={{
            border: '1px solid var(--obs-border, #2c2c2e)',
            background: 'transparent',
            color: 'var(--obs-text-muted, #8e8e93)',
            borderRadius: 5,
            padding: '4px 8px',
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 11,
          }}
        >
          <X size={11} /> Reject
        </button>
      </div>
    </div>
  );
}
