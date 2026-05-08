/**
 * ShareWithVTuberMenu — Library / Spotlight / Both share affordance.
 *
 * Reworked to:
 *   * Theme-token only (no hardcoded dark colours), so light mode
 *     reads correctly.
 *   * Plain text labels only — no emoji, no lucide icons. The
 *     Opsidian header already carries enough chrome.
 *   * Use the dedicated `whiteboardApi.shareToLibrary` endpoint
 *     instead of the auto-curation pipeline so a user-driven share
 *     never trips the quality threshold.
 *   * Forward `sessionId` so Spotlight items land in the right
 *     bucket (otherwise the [USER_SHARED] trigger no-ops and the
 *     SpotlightContextBlock can't find the items).
 */

'use client';

import { useEffect, useRef, useState } from 'react';
import { whiteboardApi } from '@/lib/api';

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
  spotlight: 'Pin for ~30 min — VTuber sees it on the next turn.',
  both: 'Promote to Library AND pin as Spotlight.',
};

export interface ShareWithVTuberMenuProps {
  filename: string;
  /** Optional active VTuber session id. Required for Spotlight to
   *  land in the per-session bucket; absent → the item lands user-wide
   *  (still works, but no [USER_SHARED] trigger fires). */
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
  const [busy, setBusy] = useState<ShareMode | null>(null);
  const [message, setMessage] = useState<ShareResult | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, [open]);

  useEffect(() => {
    if (!message) return;
    const id = window.setTimeout(() => setMessage(null), 5000);
    return () => window.clearTimeout(id);
  }, [message]);

  const runShare = async (mode: ShareMode) => {
    if (busy || !filename) return;
    setBusy(mode);
    setMessage(null);
    setOpen(false);
    const failures: string[] = [];

    if (mode === 'library' || mode === 'both') {
      try {
        await whiteboardApi.shareToLibrary({
          source_filename: filename,
        });
      } catch (e) {
        failures.push(`Library: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    if (mode === 'spotlight' || mode === 'both') {
      try {
        await whiteboardApi.shareToSpotlight({
          source_filename: filename,
          session_id: sessionId ?? null,
        });
      } catch (e) {
        failures.push(`Spotlight: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    setBusy(null);
    if (failures.length > 0) {
      setMessage({ type: 'error', text: failures.join(' · ') });
    } else {
      setMessage({ type: 'success', text: `Shared as ${MODE_LABEL[mode]}` });
      onShared?.(mode);
    }
  };

  const isBusy = busy !== null;

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
        onClick={() => setOpen((o) => !o)}
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
      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            top: '100%',
            right: 0,
            marginTop: 4,
            minWidth: 260,
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
              onClick={() => runShare(mode)}
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
                  color: 'var(--obs-text-muted, rgba(0,0,0,0.5))',
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
    </div>
  );
}
