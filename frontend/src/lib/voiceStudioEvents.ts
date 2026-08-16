/**
 * Thin EventSource wrapper for the Voice Studio SSE channel
 * (``GET /api/voice-studio/events``).
 *
 * Single-process pub/sub on the backend; the client just JSON-parses
 * each ``message`` event and calls the handler. ``hello`` and
 * keep-alive comments are ignored.
 */

import { getToken } from '@/lib/authApi';

export interface StudioEvent {
  kind: string;
  payload: Record<string, unknown>;
}

export type StudioEventHandler = (e: StudioEvent) => void;

const EVENTS_URL = '/api/voice-studio/events';

/**
 * Open an SSE connection. Returns an unsubscribe function the caller
 * should invoke (typically from a ``useEffect`` cleanup). Robust to
 * double-close.
 */
export function subscribeEvents(
  handler: StudioEventHandler,
  opts?: { signal?: AbortSignal; onError?: (ev: Event) => void },
): () => void {
  if (typeof window === 'undefined' || typeof EventSource === 'undefined') {
    return () => {};
  }
  // EventSource cannot set an Authorization header; the backend's
  // secure-by-default gate accepts ?token= for exactly this case.
  // Known limitation: the token is snapshotted once — if it expires
  // during a very long-lived page (30d), the stream dies until reload.
  const token = getToken();
  const es = new EventSource(
    token ? `${EVENTS_URL}?token=${encodeURIComponent(token)}` : EVENTS_URL,
  );
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      es.close();
    } catch {
      // ignore
    }
  };

  es.addEventListener('message', (ev: MessageEvent) => {
    try {
      const data = JSON.parse(ev.data) as StudioEvent;
      handler(data);
    } catch {
      // Non-JSON keepalive or malformed payload — ignore.
    }
  });
  es.addEventListener('error', (ev) => {
    if (opts?.onError) opts.onError(ev);
    // Let the browser auto-reconnect — EventSource handles that itself.
  });

  opts?.signal?.addEventListener('abort', close);
  return close;
}
