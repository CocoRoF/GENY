'use client';

/**
 * ConnectorBridgeClient — connector side of the inverse-MCP capability bridge.
 * Mounted hidden in the overlay window. Opens /ws/connector/{sessionId},
 * advertises native capabilities, and answers `capability_call` frames by
 * dispatching to window.connector native verbs, returning `capability_result`.
 *
 * Read-only (Phase 4): window_list, screen_capture (capture + return a frame).
 * Guarded (Phase 6): open_app / clipboard_write / type / key / click — each
 * self-gated in main by the master switch + a native confirm.
 *
 * No-op in a plain browser (no window.connector). Capture/actuate native gates
 * live in the connector main process, not here.
 */

import { useEffect } from 'react';
import { openConnectorBridgeWs } from '@/lib/api';

const CAPABILITIES = ['ping', 'window_list', 'screen_capture', 'open_app', 'clipboard_write', 'type', 'key', 'click'];

// Capture a single frame of a desktop source via Electron's desktop getUserMedia.
async function grabFrame(sourceId?: string): Promise<{ image_b64: string; mime: string; source_name: string }> {
  const conn = window.connector!;
  const sources = await conn.capture.listSources();
  const src =
    (sourceId && sources.find((s) => s.id === sourceId)) ||
    sources.find((s) => s.id.startsWith('screen:')) ||
    sources[0];
  if (!src) throw new Error('no capture source available (capture may be paused)');
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    // Electron desktop-capture constraint (legacy mandatory form).
    video: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: src.id, maxWidth: 1920, maxHeight: 1080 },
    } as unknown as MediaTrackConstraints,
  });
  try {
    const video = document.createElement('video');
    video.srcObject = stream;
    await video.play();
    await new Promise((r) => setTimeout(r, 180)); // let a frame paint
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;
    canvas.getContext('2d')!.drawImage(video, 0, 0, canvas.width, canvas.height);
    return { image_b64: canvas.toDataURL('image/png'), mime: 'image/png', source_name: src.name };
  } finally {
    stream.getTracks().forEach((t) => t.stop());
  }
}

export default function ConnectorBridgeClient({ sessionId }: { sessionId: string }) {
  useEffect(() => {
    if (typeof window === 'undefined' || !window.connector) return; // desktop only
    const conn = window.connector;
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

    const handleCall = async (data: { request_id?: string; tool?: string; args?: any }) => {
      const request_id = data?.request_id;
      const tool = data?.tool;
      const a = data?.args || {};
      try {
        let payload: Record<string, unknown>;
        switch (tool) {
          case 'ping':
            payload = { ok: true, result: `pong @ ${new Date().toISOString()}` };
            break;
          case 'window_list':
            payload = { ok: true, result: await conn.capture.listSources() };
            break;
          case 'screen_capture':
            payload = { ok: true, result: await grabFrame(a.source_id) };
            break;
          case 'open_app':
            payload = await conn.actuate.openApp(a.target);
            break;
          case 'clipboard_write':
            payload = await conn.actuate.clipboardWrite(a.text);
            break;
          case 'type':
            payload = await conn.actuate.type(a.text);
            break;
          case 'key':
            payload = await conn.actuate.key(a.keys);
            break;
          case 'click':
            payload = await conn.actuate.click(a.x, a.y, a.button);
            break;
          default:
            payload = { ok: false, error: `unknown capability: ${tool}` };
        }
        respond({ request_id, ...payload });
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
