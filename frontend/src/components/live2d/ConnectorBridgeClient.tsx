'use client';

/**
 * ConnectorBridgeClient — the connector side of the inverse-MCP capability
 * bridge. Mounted hidden in the overlay window (which owns the server sockets).
 * Opens /ws/connector/{sessionId}, advertises native capabilities via `hello`,
 * and answers `capability_call` frames the server's agent issues, returning a
 * `capability_result`.
 *
 * No-op in a plain browser (no window.connector / no native backend). Phase 4/6
 * extend the dispatch to real native verbs via window.connector; for now `ping`
 * proves the round-trip.
 */

import { useEffect } from 'react';
import { openConnectorBridgeWs } from '@/lib/api';

const CAPABILITIES = ['ping'];

export default function ConnectorBridgeClient({ sessionId }: { sessionId: string }) {
  useEffect(() => {
    if (typeof window === 'undefined' || !window.connector) return; // desktop only
    let ws: WebSocket | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const respond = (payload: Record<string, unknown>) => {
      try {
        ws?.send(JSON.stringify({ type: 'capability_result', data: payload }));
      } catch {
        /* socket gone */
      }
    };

    const handleCall = async (data: { request_id?: string; tool?: string; args?: unknown }) => {
      const request_id = data?.request_id;
      const tool = data?.tool;
      try {
        if (tool === 'ping') {
          respond({ request_id, ok: true, result: `pong @ ${new Date().toISOString()}` });
          return;
        }
        // Phase 4/6: dispatch capture/actuate verbs to window.connector here.
        respond({ request_id, ok: false, error: `unknown capability: ${tool}` });
      } catch (e) {
        respond({ request_id, ok: false, error: String((e as Error).message) });
      }
    };

    const scheduleRetry = () => {
      if (!closed && !retry) retry = setTimeout(() => { retry = null; connect(); }, 4000);
    };

    const connect = () => {
      if (closed) return;
      try {
        ws = openConnectorBridgeWs(sessionId);
      } catch {
        scheduleRetry();
        return;
      }
      ws.onopen = () => {
        try {
          ws?.send(JSON.stringify({ type: 'hello', capabilities: CAPABILITIES }));
        } catch {
          /* ignore */
        }
      };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string);
          if (msg?.type === 'capability_call') void handleCall(msg.data);
        } catch {
          /* ignore */
        }
      };
      ws.onclose = () => {
        if (!closed) scheduleRetry();
      };
      ws.onerror = () => {
        try {
          ws?.close();
        } catch {
          /* ignore */
        }
      };
    };

    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
    };
  }, [sessionId]);

  return null;
}
