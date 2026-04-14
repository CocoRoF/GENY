/**
 * WebSocket hook for chat room event streaming.
 *
 * Replaces the SSE-based subscribeToRoom pattern with a persistent
 * WebSocket connection that receives real-time room events.
 *
 * Protocol:
 *   Client -> {"type": "subscribe", "after": "last_msg_id"}
 *   Server -> {"type": "message"|"broadcast_status"|"agent_progress"|"broadcast_done"|"heartbeat", "data": {...}}
 */

import { useRef, useCallback } from 'react';

export interface ChatWsEvent {
  type: string;
  data: Record<string, unknown>;
}

/**
 * Build the WebSocket URL for a chat room.
 */
function getChatWsUrl(roomId: string): string {
  const envUrl = process.env.NEXT_PUBLIC_API_URL;
  if (envUrl !== undefined && envUrl !== '') {
    const wsBase = envUrl.replace(/^http/, 'ws');
    return `${wsBase}/ws/chat/rooms/${roomId}`;
  }

  if (typeof window !== 'undefined') {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';

    const backendPort = process.env.NEXT_PUBLIC_BACKEND_PORT;
    if (backendPort) {
      return `${proto}//${window.location.hostname}:${backendPort}/ws/chat/rooms/${roomId}`;
    }

    return `${proto}//${window.location.host}/ws/chat/rooms/${roomId}`;
  }

  return `ws://localhost:8000/ws/chat/rooms/${roomId}`;
}

export function useChatWebSocket() {
  const wsRef = useRef<WebSocket | null>(null);

  /**
   * Subscribe to a chat room's events.
   *
   * @param roomId      Chat room to subscribe to
   * @param afterId     Last seen message ID (null for fresh start)
   * @param onEvent     Callback for each event from the server
   * @param getLatestMsgId  Optional function returning the latest message ID for reconnection
   * @returns Object with close() method
   */
  const subscribe = useCallback(
    (
      roomId: string,
      afterId: string | null,
      onEvent: (eventType: string, eventData: Record<string, unknown>) => void,
      getLatestMsgId?: () => string | null,
    ): { close: () => void } => {
      const _tag = `[useChatWS:${roomId.slice(0, 8)}]`;

      // Close existing connection
      if (wsRef.current) {
        console.debug(`${_tag} closing existing connection before re-subscribe`);
        wsRef.current.close();
        wsRef.current = null;
      }

      let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
      let closed = false;
      let attempts = 0;
      const maxAttempts = 30;

      console.debug(`${_tag} subscribe called, afterId=${afterId}`);

      const connect = () => {
        if (closed) return;

        const delay = attempts === 0 ? 0 : Math.min(500 * Math.pow(2, attempts - 1), 10000);
        if (delay > 0) {
          console.debug(`${_tag} reconnecting in ${delay}ms (attempt=${attempts}/${maxAttempts})`);
          reconnectTimer = setTimeout(_doConnect, delay);
        } else {
          _doConnect();
        }
      };

      const _doConnect = () => {
        if (closed) return;
        reconnectTimer = null;

        const wsUrl = getChatWsUrl(roomId);
        console.debug(`${_tag} connecting (attempt=${attempts})`);
        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.onopen = () => {
          attempts = 0;
          const currentAfter = getLatestMsgId ? getLatestMsgId() : afterId;
          console.debug(`${_tag} connected, sending subscribe after=${currentAfter}`);
          ws.send(
            JSON.stringify({
              type: 'subscribe',
              after: currentAfter,
            }),
          );
        };

        ws.onmessage = (ev) => {
          try {
            const event: ChatWsEvent = JSON.parse(ev.data);
            if (event.type !== 'heartbeat') {
              console.debug(`${_tag} event: ${event.type}`, event.data);
            }
            onEvent(event.type, event.data);
          } catch (err) {
            console.warn(`${_tag} failed to parse WS message:`, ev.data, err);
          }
        };

        ws.onerror = () => {
          wsRef.current = null;
        };

        ws.onclose = (ev) => {
          console.debug(`${_tag} closed (code=${ev.code}, clean=${ev.wasClean})`);
          wsRef.current = null;
          if (!closed && attempts < maxAttempts) {
            attempts++;
            connect();
          } else if (!closed) {
            console.error(`${_tag} max reconnect attempts reached`);
          }
        };
      };

      connect();

      return {
        close: () => {
          console.debug(`${_tag} close() called`);
          closed = true;
          if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
          }
          if (wsRef.current) {
            wsRef.current.close();
            wsRef.current = null;
          }
        },
      };
    },
    [],
  );

  return { subscribe };
}
