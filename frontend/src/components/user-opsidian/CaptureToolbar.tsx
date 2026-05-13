/**
 * CaptureToolbar — renders one button per registered CaptureSource.
 *
 * Phase 1 ships only the `file_drop` built-in.  Phases 3+ register
 * `screen_capture`, `clipboard_paste`, etc. via
 * `registerCaptureSource(...)` at module-load time and the toolbar
 * automatically picks them up; no edits here.
 */

'use client';

import React, { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Camera, Clipboard, Loader2, Mic, Pencil, Upload } from 'lucide-react';
import {
  listCaptureSources,
  onCaptureSourcesChange,
  registerBuiltinCaptureSources,
  type CaptureContext,
  type CaptureSource,
} from '@/lib/captureSources';
import type { WhiteboardCaptureCreatedResponse } from '@/lib/api';

const FALLBACK_ICONS: Record<string, ReactNode> = {
  file_drop: <Upload size={14} />,
  screen_capture: <Camera size={14} />,
  clipboard_paste: <Clipboard size={14} />,
  microphone_record: <Mic size={14} />,
  drawing: <Pencil size={14} />,
};

export interface CaptureToolbarProps {
  sessionId?: string | null;
  /** Called whenever a capture source completes successfully. */
  onCaptured?: (response: WhiteboardCaptureCreatedResponse) => void;
  className?: string;
  /** When true, render a slim inline cluster suitable for headers
   *  (no border, no eyebrow, no padding). When false / undefined,
   *  render the standalone toolbar block (legacy). */
  inline?: boolean;
}

export default function CaptureToolbar({
  sessionId,
  onCaptured,
  className,
  inline = false,
}: CaptureToolbarProps) {
  // Built-ins are registered on first render (idempotent).
  useEffect(() => {
    registerBuiltinCaptureSources();
  }, []);

  const [tick, setTick] = useState(0);
  // The registry is mutable — re-list whenever a (un)registration
  // fires the `onCaptureSourcesChange` emitter. This replaces the
  // previous "single setTimeout 50ms after mount" hack which only
  // caught sources registered within that one window.
  const sources = useMemo(() => listCaptureSources(), [tick]);
  useEffect(() => {
    return onCaptureSourcesChange(() => setTick((n) => n + 1));
  }, []);

  const ctx: CaptureContext = useMemo(
    () => ({ sessionId: sessionId ?? null }),
    [sessionId],
  );

  if (sources.length === 0) {
    return null;
  }

  const containerStyle: React.CSSProperties = inline
    ? {
        display: 'inline-flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 6,
      }
    : {
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 8,
        padding: '10px 20px',
        borderBottom: '1px solid var(--obs-border, #2c2c2e)',
        background: 'var(--obs-bg-secondary, rgba(255,255,255,0.02))',
      };

  return (
    <div
      className={className}
      style={containerStyle}
      data-whiteboard-slot="capture-toolbar"
    >
      {sources.map((source) => (
        <CaptureButton
          key={source.id}
          source={source}
          ctx={ctx}
          onCaptured={onCaptured}
        />
      ))}
    </div>
  );
}

function CaptureButton({
  source,
  ctx,
  onCaptured,
}: {
  source: CaptureSource;
  ctx: CaptureContext;
  onCaptured?: (response: WhiteboardCaptureCreatedResponse) => void;
}) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleClick = async () => {
    if (running) return;
    setError(null);
    setRunning(true);
    try {
      const result = await source.run(ctx);
      if (result) onCaptured?.(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  const icon = source.icon ?? FALLBACK_ICONS[source.id] ?? <Upload size={15} />;

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={running}
      title={error ?? source.label}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 7,
        padding: '6px 12px',
        fontSize: 13,
        fontWeight: 500,
        borderRadius: 7,
        border: error
          ? '1px solid #ef4444'
          : '1px solid var(--obs-border, #2c2c2e)',
        background: error
          ? 'rgba(239,68,68,0.1)'
          : 'var(--obs-bg, rgba(255,255,255,0.04))',
        color: error ? '#ef4444' : 'var(--obs-text, #d1d1d6)',
        cursor: running ? 'not-allowed' : 'pointer',
        opacity: running ? 0.7 : 1,
      }}
    >
      {running ? <Loader2 size={15} className="spin" /> : icon}
      <span>{source.label}</span>
    </button>
  );
}
