/**
 * ShareWithVTuberMenu — Library / Spotlight / Both share affordance.
 *
 * Spotlight / Both go through a VTuber-session picker: the user
 * picks WHICH VTuber gets the spotlight item. Required because
 * Opsidian doesn't necessarily have an active session in scope
 * (the inbox / notes pages drop the global selection), and silently
 * falling back to "user-wide" means the [USER_SHARED] trigger has
 * no session to fire on.
 *
 * Only `role === 'vtuber'` sessions are listed — sub-workers /
 * developer sessions don't have a VTuber-style chat surface to
 * react to spotlight items.
 */

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  agentApi,
  whiteboardApi,
} from '@/lib/api';
import type { SessionInfo } from '@/types';

type ShareMode = 'library' | 'spotlight' | 'both';

interface ShareResult {
  type: 'success' | 'error';
  text: string;
}

const MODE_LABEL: Record<ShareMode, string> = {
  library: 'Library',
  spotlight: 'Spotlight',
  both: 'Both',
};

const MODE_HINT: Record<ShareMode, string> = {
  library: 'Promote to Curated Knowledge — VTuber can search it later.',
  spotlight: 'Pin for ~30 min on a chosen VTuber session.',
  both: 'Promote to Library AND pin on a chosen VTuber session.',
};

export interface ShareWithVTuberMenuProps {
  filename: string;
  /** Pre-selected VTuber session id (when the page knows it). */
  sessionId?: string | null;
  onShared?: (mode: ShareMode) => void;
  disabled?: boolean;
}

export default function ShareWithVTuberMenu({
  filename,
  sessionId,
  onShared,
  disabled,
}: ShareWithVTuberMenuProps) {
  const [open, setOpen] = useState(false);
  const [pickerForMode, setPickerForMode] = useState<ShareMode | null>(null);
  const [busy, setBusy] = useState<ShareMode | null>(null);
  const [message, setMessage] = useState<ShareResult | null>(null);
  const [vtuberSessions, setVtuberSessions] = useState<SessionInfo[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const closeAll = useCallback(() => {
    setOpen(false);
    setPickerForMode(null);
  }, []);

  useEffect(() => {
    if (!open && !pickerForMode) return;
    const onClick = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) closeAll();
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, [open, pickerForMode, closeAll]);

  useEffect(() => {
    if (!message) return;
    const id = window.setTimeout(() => setMessage(null), 5000);
    return () => window.clearTimeout(id);
  }, [message]);

  // Fetch VTuber sessions lazily — only when a picker is opened, so
  // we don't hit the agents API every time the page mounts.
  const loadVtuberSessions = useCallback(async () => {
    setSessionsLoading(true);
    setSessionsError(null);
    try {
      const all = await agentApi.list();
      const vtubers = (all ?? []).filter(
        (s) => s.role === 'vtuber' && !s.is_deleted,
      );
      setVtuberSessions(vtubers);
    } catch (e) {
      setSessionsError(e instanceof Error ? e.message : String(e));
    } finally {
      setSessionsLoading(false);
    }
  }, []);

  // ── Action runners ───────────────────────────────────────────

  const runLibrary = useCallback(async (): Promise<string | null> => {
    try {
      await whiteboardApi.shareToLibrary({ source_filename: filename });
      return null;
    } catch (e) {
      return `Library: ${e instanceof Error ? e.message : String(e)}`;
    }
  }, [filename]);

  const runSpotlight = useCallback(
    async (targetSessionId: string): Promise<string | null> => {
      try {
        await whiteboardApi.shareToSpotlight({
          source_filename: filename,
          session_id: targetSessionId,
        });
        return null;
      } catch (e) {
        return `Spotlight: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
    [filename],
  );

  const finishShare = useCallback(
    (mode: ShareMode, failures: string[]) => {
      setBusy(null);
      if (failures.length > 0) {
        setMessage({ type: 'error', text: failures.join(' · ') });
      } else {
        setMessage({ type: 'success', text: `Shared as ${MODE_LABEL[mode]}` });
        onShared?.(mode);
      }
    },
    [onShared],
  );

  // ── Mode entry points ────────────────────────────────────────

  const onSelectMode = useCallback(
    async (mode: ShareMode) => {
      if (busy || !filename) return;
      setMessage(null);

      if (mode === 'library') {
        // No VTuber required — fire and done.
        setOpen(false);
        setBusy('library');
        const err = await runLibrary();
        finishShare('library', err ? [err] : []);
        return;
      }

      // Spotlight / Both need a target VTuber session.
      setOpen(false);
      setPickerForMode(mode);
      loadVtuberSessions();
    },
    [busy, filename, runLibrary, finishShare, loadVtuberSessions],
  );

  const onSelectVtuberSession = useCallback(
    async (targetSessionId: string) => {
      const mode = pickerForMode;
      if (!mode || busy) return;
      setPickerForMode(null);
      setBusy(mode);
      const failures: string[] = [];
      if (mode === 'both') {
        const e = await runLibrary();
        if (e) failures.push(e);
      }
      const e2 = await runSpotlight(targetSessionId);
      if (e2) failures.push(e2);
      finishShare(mode, failures);
    },
    [pickerForMode, busy, runLibrary, runSpotlight, finishShare],
  );

  const isBusy = busy !== null;
  const showPicker = pickerForMode !== null;

  // VTuber session list — pre-selected first (if it appears), then
  // sorted by recency.
  const sortedSessions = useMemo(() => {
    if (!vtuberSessions.length) return [];
    const list = [...vtuberSessions];
    list.sort((a, b) => {
      if (a.session_id === sessionId) return -1;
      if (b.session_id === sessionId) return 1;
      return (b.created_at ?? '').localeCompare(a.created_at ?? '');
    });
    return list;
  }, [vtuberSessions, sessionId]);

  return (
    <div
      ref={containerRef}
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
      }}
    >
      {message && (
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            padding: '4px 10px',
            fontSize: 11,
            borderRadius: 4,
            background:
              message.type === 'success'
                ? 'var(--obs-success-bg, rgba(16,185,129,0.12))'
                : 'var(--obs-error-bg, rgba(239,68,68,0.12))',
            color:
              message.type === 'success'
                ? 'var(--obs-success, #10b981)'
                : 'var(--obs-error, #ef4444)',
            border: `1px solid ${
              message.type === 'success'
                ? 'var(--obs-success-border, rgba(16,185,129,0.3))'
                : 'var(--obs-error-border, rgba(239,68,68,0.3))'
            }`,
          }}
        >
          {message.text}
        </span>
      )}
      <button
        type="button"
        onClick={() => {
          if (showPicker) {
            setPickerForMode(null);
            return;
          }
          setOpen((o) => !o);
        }}
        disabled={disabled || isBusy}
        title="Share with VTuber"
        style={{
          padding: '5px 12px',
          fontSize: 12,
          fontWeight: 500,
          background: 'var(--obs-button-bg, rgba(127,127,127,0.08))',
          color: 'var(--obs-text, inherit)',
          border: '1px solid var(--obs-border, rgba(127,127,127,0.25))',
          borderRadius: 5,
          cursor: isBusy ? 'not-allowed' : 'pointer',
          opacity: isBusy ? 0.7 : 1,
        }}
      >
        {isBusy ? `Sharing as ${MODE_LABEL[busy!]}…` : 'Share with VTuber'}
      </button>

      {/* Mode selection popover */}
      {open && !showPicker && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            top: '100%',
            right: 0,
            marginTop: 4,
            minWidth: 280,
            padding: 6,
            borderRadius: 8,
            background: 'var(--obs-popover-bg, var(--obs-bg, #ffffff))',
            color: 'var(--obs-text, inherit)',
            border: '1px solid var(--obs-border, rgba(127,127,127,0.25))',
            boxShadow: '0 6px 18px rgba(0,0,0,0.18)',
            zIndex: 20,
          }}
        >
          {(['library', 'spotlight', 'both'] as ShareMode[]).map((mode) => (
            <button
              key={mode}
              role="menuitem"
              onClick={() => onSelectMode(mode)}
              disabled={isBusy}
              style={{
                display: 'flex',
                width: '100%',
                flexDirection: 'column',
                alignItems: 'flex-start',
                gap: 2,
                padding: '8px 10px',
                background: 'transparent',
                border: 'none',
                color: 'inherit',
                textAlign: 'left',
                fontSize: 12,
                cursor: 'pointer',
                borderRadius: 6,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background =
                  'var(--obs-hover, rgba(127,127,127,0.10))';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent';
              }}
            >
              <span style={{ fontWeight: 600 }}>{MODE_LABEL[mode]}</span>
              <span
                style={{
                  color: 'var(--obs-text-muted, rgba(127,127,127,0.8))',
                  fontSize: 11,
                  lineHeight: 1.4,
                }}
              >
                {MODE_HINT[mode]}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* VTuber session picker (Spotlight / Both only) */}
      {showPicker && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            top: '100%',
            right: 0,
            marginTop: 4,
            minWidth: 320,
            maxHeight: 360,
            overflowY: 'auto',
            padding: 6,
            borderRadius: 8,
            background: 'var(--obs-popover-bg, var(--obs-bg, #ffffff))',
            color: 'var(--obs-text, inherit)',
            border: '1px solid var(--obs-border, rgba(127,127,127,0.25))',
            boxShadow: '0 6px 18px rgba(0,0,0,0.18)',
            zIndex: 20,
          }}
        >
          <div
            style={{
              padding: '6px 10px 8px',
              borderBottom: '1px solid var(--obs-border, rgba(127,127,127,0.18))',
              marginBottom: 4,
            }}
          >
            <div style={{ fontSize: 12, fontWeight: 600 }}>
              Pick a VTuber session
            </div>
            <div
              style={{
                fontSize: 11,
                color: 'var(--obs-text-muted, rgba(127,127,127,0.8))',
                marginTop: 2,
              }}
            >
              Mode: {MODE_LABEL[pickerForMode]}
            </div>
          </div>

          {sessionsLoading && (
            <div
              style={{
                padding: '12px 10px',
                fontSize: 12,
                color: 'var(--obs-text-muted)',
              }}
            >
              Loading sessions…
            </div>
          )}
          {sessionsError && (
            <div
              style={{
                padding: '12px 10px',
                fontSize: 12,
                color: 'var(--obs-error, #ef4444)',
              }}
            >
              {sessionsError}
            </div>
          )}
          {!sessionsLoading && !sessionsError && sortedSessions.length === 0 && (
            <div
              style={{
                padding: '12px 10px',
                fontSize: 12,
                color: 'var(--obs-text-muted)',
              }}
            >
              No active VTuber sessions. Open one in the VTuber panel
              first, then try again.
            </div>
          )}
          {sortedSessions.map((s) => {
            const isPreSelected = s.session_id === sessionId;
            const status = s.status ?? 'unknown';
            return (
              <button
                key={s.session_id}
                role="menuitem"
                onClick={() => onSelectVtuberSession(s.session_id)}
                disabled={isBusy}
                style={{
                  display: 'flex',
                  width: '100%',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  gap: 2,
                  padding: '8px 10px',
                  background: 'transparent',
                  border: 'none',
                  color: 'inherit',
                  textAlign: 'left',
                  fontSize: 12,
                  cursor: 'pointer',
                  borderRadius: 6,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background =
                    'var(--obs-hover, rgba(127,127,127,0.10))';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent';
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    width: '100%',
                  }}
                >
                  <span style={{ fontWeight: 600 }}>
                    {s.session_name || s.session_id.slice(0, 8)}
                  </span>
                  {isPreSelected && (
                    <span
                      style={{
                        fontSize: 10,
                        padding: '0 5px',
                        borderRadius: 4,
                        background: 'var(--obs-hover, rgba(16,185,129,0.15))',
                        color: 'var(--obs-success, #10b981)',
                      }}
                    >
                      current
                    </span>
                  )}
                  <span
                    style={{
                      marginLeft: 'auto',
                      fontSize: 10,
                      color: 'var(--obs-text-muted, rgba(127,127,127,0.8))',
                    }}
                  >
                    {status}
                  </span>
                </div>
                <span
                  style={{
                    fontSize: 11,
                    color: 'var(--obs-text-muted, rgba(127,127,127,0.8))',
                    fontFamily: 'var(--obs-font-mono, monospace)',
                  }}
                >
                  {s.session_id.slice(0, 12)}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
