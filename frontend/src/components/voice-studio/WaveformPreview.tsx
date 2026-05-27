'use client';

import { useEffect, useRef, useState } from 'react';
import { Play, Pause, Download } from 'lucide-react';

interface WaveformPreviewProps {
  /** Blob URL of the audio to display. ``null`` shows an empty state. */
  src: string | null;
  /** Short footer label, e.g. ``"0:03.21 / RTF 0.42 · seed 12345"``. */
  footer?: string;
  /** When provided, shows a Download button that uses this filename. */
  downloadName?: string;
}

/**
 * Thin wavesurfer.js wrapper. SSR-safe: the wavesurfer module is loaded
 * via dynamic ``import()`` inside ``useEffect`` so it never touches
 * ``window`` during server render.
 */
export default function WaveformPreview({ src, footer, downloadName }: WaveformPreviewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Wavesurfer's runtime type isn't exposed cleanly across versions; we
  // intentionally keep this as a loose reference.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wsRef = useRef<any>(null);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    if (!src || !containerRef.current) return;
    let disposed = false;
    setReady(false);
    setPlaying(false);

    (async () => {
      const WaveSurfer = (await import('wavesurfer.js')).default;
      if (disposed || !containerRef.current) return;
      const ws = WaveSurfer.create({
        container: containerRef.current,
        height: 56,
        waveColor: 'rgba(148, 163, 184, 0.55)',
        progressColor: 'var(--primary-color)',
        cursorColor: 'var(--primary-color)',
        barWidth: 2,
        barGap: 2,
        barRadius: 1,
        normalize: true,
        url: src,
      });
      wsRef.current = ws;
      ws.on('ready', () => {
        if (!disposed) setReady(true);
      });
      ws.on('play', () => setPlaying(true));
      ws.on('pause', () => setPlaying(false));
      ws.on('finish', () => setPlaying(false));
    })();

    return () => {
      disposed = true;
      try {
        wsRef.current?.destroy();
      } catch {
        /* ignore disposal noise */
      }
      wsRef.current = null;
    };
  }, [src]);

  if (!src) {
    return (
      <div className="rounded-lg border border-dashed border-[var(--border-color)] bg-[var(--bg-tertiary)] px-4 py-6 text-center text-[0.75rem] text-[var(--text-muted)]">
        ▶ Generate 후 여기에 waveform이 표시됩니다.
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-tertiary)] p-3">
      <div ref={containerRef} className="w-full" />
      <div className="flex items-center gap-2 mt-2.5 text-[0.75rem]">
        <button
          onClick={() => wsRef.current?.playPause()}
          disabled={!ready}
          className="flex items-center justify-center w-7 h-7 rounded-md bg-[var(--bg-secondary)] border border-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--primary-color)] hover:border-[var(--primary-color)] cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          title={playing ? 'Pause' : 'Play'}
        >
          {playing ? <Pause size={12} /> : <Play size={12} />}
        </button>
        {downloadName && (
          <a
            href={src}
            download={downloadName}
            className="flex items-center justify-center w-7 h-7 rounded-md bg-[var(--bg-secondary)] border border-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--primary-color)] hover:border-[var(--primary-color)] no-underline cursor-pointer transition-colors"
            title="Download"
          >
            <Download size={12} />
          </a>
        )}
        {footer && <span className="text-[var(--text-muted)] ml-1 font-mono">{footer}</span>}
      </div>
    </div>
  );
}
