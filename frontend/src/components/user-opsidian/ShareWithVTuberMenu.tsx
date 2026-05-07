/**
 * ShareWithVTuberMenu — replaces the old "Curate" button.
 *
 * Two distinct lifecycles, picked from a dropdown:
 *   - Library  (long-term, searchable via knowledge_search)
 *   - Spotlight (immediate, ephemeral focus for the next ~30 min)
 *   - Both
 *
 * The Library path keeps using the existing `/api/curated/curate`
 * endpoint; Spotlight uses the new `/api/opsidian/spotlight` endpoint
 * landed in Phase 2a.  This component owns its own pending / message
 * state so it can drop into any toolbar without prop changes.
 */

'use client';

import { useEffect, useRef, useState } from 'react';
import {
  CheckCircle,
  ChevronDown,
  Library,
  Loader2,
  Send,
  Sparkles,
  Target,
} from 'lucide-react';
import { curatedKnowledgeApi } from '@/lib/api';

type ShareMode = 'library' | 'spotlight' | 'both';

interface ShareResult {
  type: 'success' | 'error';
  text: string;
}

const MODE_LABEL: Record<ShareMode, string> = {
  library: '📚 Library',
  spotlight: '🎯 Spotlight',
  both: '🌟 Both',
};

const MODE_HINT: Record<ShareMode, string> = {
  library: 'Promote to Curated Knowledge — VTuber can search it later.',
  spotlight: 'Pin for ~30 min — VTuber sees it on the next turn.',
  both: 'Promote to Library AND pin as Spotlight.',
};

async function shareSpotlight(payload: {
  source_filename: string;
  session_id?: string | null;
}): Promise<{ item_id: string }> {
  const token = (await import('@/lib/authApi')).getToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch('/api/opsidian/spotlight', {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(body || `HTTP ${res.status}`);
  }
  const json = (await res.json()) as { item: { item_id: string } };
  return { item_id: json.item.item_id };
}

export interface ShareWithVTuberMenuProps {
  filename: string;
  sessionId?: string | null;
  /** Optional callback after a successful share (e.g. to refresh a panel). */
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

  // Click-outside dismiss for the dropdown.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, [open]);

  // Auto-clear flash messages.
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
        const result = await curatedKnowledgeApi.curateNote({
          source_filename: filename,
          use_llm: true,
        });
        if (!result.success) {
          failures.push(`Library: ${result.reason || 'failed'}`);
        }
      } catch (e) {
        failures.push(`Library: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    if (mode === 'spotlight' || mode === 'both') {
      try {
        await shareSpotlight({ source_filename: filename, session_id: sessionId });
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
    <div ref={containerRef} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      {message && (
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            padding: '4px 10px',
            fontSize: 11,
            borderRadius: 4,
            background:
              message.type === 'success' ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)',
            color: message.type === 'success' ? '#10b981' : '#ef4444',
          }}
        >
          {message.type === 'success' && <CheckCircle size={11} />}
          {message.text}
        </span>
      )}
      <button
        onClick={() => setOpen((o) => !o)}
        disabled={disabled || isBusy}
        title="Share with VTuber"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          padding: '5px 12px',
          fontSize: 12,
          fontWeight: 500,
          background: 'rgba(139,92,246,0.1)',
          color: '#8b5cf6',
          border: '1px solid rgba(139,92,246,0.3)',
          borderRadius: 5,
          cursor: isBusy ? 'not-allowed' : 'pointer',
          opacity: isBusy ? 0.7 : 1,
        }}
      >
        {isBusy ? <Loader2 size={12} className="spin" /> : <Send size={12} />}
        {isBusy ? `Sharing as ${MODE_LABEL[busy!]}` : 'Share with VTuber'}
        <ChevronDown size={11} />
      </button>
      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            top: '100%',
            right: 0,
            marginTop: 4,
            minWidth: 240,
            padding: 6,
            borderRadius: 8,
            background: 'var(--obs-bg, #1a1a1c)',
            border: '1px solid var(--obs-border, #2c2c2e)',
            boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
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
                alignItems: 'flex-start',
                gap: 8,
                padding: '8px 10px',
                background: 'transparent',
                border: 'none',
                color: 'var(--obs-text, #d1d1d6)',
                textAlign: 'left',
                fontSize: 12,
                cursor: 'pointer',
                borderRadius: 6,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'rgba(139,92,246,0.1)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent';
              }}
            >
              <span style={{ marginTop: 1 }}>
                {mode === 'library' ? <Library size={14} /> : mode === 'spotlight' ? <Target size={14} /> : <Sparkles size={14} />}
              </span>
              <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ fontWeight: 600 }}>{MODE_LABEL[mode]}</span>
                <span style={{ color: 'var(--obs-text-muted, #8e8e93)', fontSize: 11 }}>
                  {MODE_HINT[mode]}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
