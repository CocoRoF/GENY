'use client';

/**
 * ChunkReloadGuard — self-heal stale tabs after a frontend deploy.
 *
 * When the frontend is rebuilt, chunk file hashes change. A browser tab opened
 * before the deploy holds a page referencing the OLD hashes; navigating to a
 * lazily-loaded route then 404s the old chunk → `ChunkLoadError` (and often a
 * downstream hydration error). This guard listens for that specific failure and
 * does a one-time hard reload to pull the fresh build, instead of leaving the
 * user on a broken screen.
 *
 * A sessionStorage timestamp prevents a reload loop if the build is genuinely
 * broken (only reloads once per 30s window).
 */

import { useEffect } from 'react';

const KEY = '__geny_chunk_reload_ts';
const WINDOW_MS = 30_000;

function isChunkError(msg?: unknown): boolean {
  if (!msg) return false;
  const s = String(msg);
  return (
    s.includes('ChunkLoadError') ||
    s.includes('Loading chunk') ||
    s.includes('Failed to load chunk') ||
    s.includes('Loading CSS chunk') ||
    s.includes('error loading dynamically imported module') ||
    s.includes('Importing a module script failed')
  );
}

export default function ChunkReloadGuard() {
  useEffect(() => {
    const reloadOnce = () => {
      try {
        const last = Number(sessionStorage.getItem(KEY) || '0');
        if (Date.now() - last < WINDOW_MS) return; // already tried recently — avoid loop
        sessionStorage.setItem(KEY, String(Date.now()));
      } catch {
        /* private mode — best-effort, fall through to a single reload attempt */
      }
      // Reload from the network so the fresh index + chunk hashes are fetched.
      window.location.reload();
    };

    const onError = (e: ErrorEvent) => {
      const err = e?.error as { name?: string; message?: string } | undefined;
      if (isChunkError(e?.message) || isChunkError(err?.name) || isChunkError(err?.message)) {
        reloadOnce();
      }
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      const r = e?.reason as { name?: string; message?: string } | undefined;
      if (isChunkError(r?.name) || isChunkError(r?.message) || isChunkError(r)) {
        reloadOnce();
      }
    };

    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);

  return null;
}
