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
import { grabCurrentScreenRaw } from '@/lib/screenFrameAccess';

const CAPABILITIES = [
  'ping', 'window_list', 'screen_capture', 'open_app', 'clipboard_write', 'type', 'key', 'click', 'scroll',
  // Local MCP proxy (Phase 3): the connector hosts MCP clients to the user's
  // local servers; the agent lists + calls them through these two capabilities.
  'mcp_list', 'mcp_call',
];

// Capture spec — match the screen-observation cap (16:9, ≤1600×900, JPEG).
const CAP_W = 1600;
const CAP_H = 900;
const CAP_QUALITY = 0.85;

// Capture a single frame of a desktop source via Electron's desktop getUserMedia.
// Used (a) by the desktop_glance agent tool and (b) as the fallback when no live
// screen-observation stream is open. Opens a one-shot stream, grabs, releases.
async function grabFrame(
  sourceId?: string,
  fullRes?: boolean,
): Promise<{ image_b64: string; mime: string; source_name: string; width: number; height: number }> {
  const conn = window.connector!;
  const sources = await conn.capture.listSources();
  const src =
    (sourceId && sources.find((s) => s.id === sourceId)) ||
    sources.find((s) => s.id.startsWith('screen:')) ||
    sources[0];
  if (!src) throw new Error('no capture source available (capture may be paused)');
  // full_res (desktop_screenshot for computer use): capture at native resolution
  // so the image's pixel coords match the screen (desktop_click targets them).
  // Otherwise cap at 1080p + downscale to the observation size (glance/caption).
  const maxW = fullRes ? 3840 : 1920;
  const maxH = fullRes ? 2160 : 1080;
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    // Electron desktop-capture constraint (legacy mandatory form).
    video: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: src.id, maxWidth: maxW, maxHeight: maxH },
    } as unknown as MediaTrackConstraints,
  });
  try {
    const video = document.createElement('video');
    video.srcObject = stream;
    await video.play();
    await new Promise((r) => setTimeout(r, 180)); // let a frame paint
    const vw = video.videoWidth || 1280;
    const vh = video.videoHeight || 720;
    const scale = fullRes ? 1 : Math.min(CAP_W / vw, CAP_H / vh, 1);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(vw * scale);
    canvas.height = Math.round(vh * scale);
    canvas.getContext('2d')!.drawImage(video, 0, 0, canvas.width, canvas.height);
    return {
      image_b64: canvas.toDataURL('image/jpeg', CAP_QUALITY),
      mime: 'image/jpeg',
      source_name: src.name,
      width: canvas.width,
      height: canvas.height,
    };
  } finally {
    stream.getTracks().forEach((t) => t.stop());
  }
}

// Resolve a screen frame for the ``screen_capture`` capability.
//  - Prefer the already-open live screen-observation stream (instant, no new
//    prompt/stream) — makes a backend per-turn capture real-time-fast.
//  - ``liveOnly`` (per-turn capture): NEVER open a fresh stream. If the live
//    stream is gone (observation toggle is OFF right now) we refuse — so a
//    turn never captures the screen after the user turned observation off,
//    regardless of any residual server-side "active" window. Privacy gate.
//  - Otherwise (the explicit desktop_glance tool): fall back to a one-shot
//    grabFrame so the agent can glance even with the toggle off.
async function captureScreen(
  sourceId?: string,
  liveOnly?: boolean,
  fullRes?: boolean,
): Promise<{ image_b64: string; mime: string; source_name: string; width?: number; height?: number }> {
  // liveOnly is the privacy gate: take the current frame from the open
  // observation stream, and REFUSE if it's gone — never open a fresh stream,
  // regardless of any source_id. Checked first so a source_id can't bypass it.
  if (liveOnly) {
    const live = await grabCurrentScreenRaw();
    if (live) return { image_b64: live.data, mime: live.mime_type, source_name: 'screen (live)' };
    throw new Error('screen observation is not active');
  }
  // full_res (computer-use screenshot) always takes a FRESH native-resolution
  // frame — the live observation stream is downscaled, which would break the
  // image↔screen coordinate mapping desktop_click relies on.
  if (fullRes) return grabFrame(sourceId, true);
  if (!sourceId) {
    const live = await grabCurrentScreenRaw();
    if (live) return { image_b64: live.data, mime: live.mime_type, source_name: 'screen (live)' };
  }
  return grabFrame(sourceId);
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
            payload = { ok: true, result: await captureScreen(a.source_id, a.live_only, a.full_res) };
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
          case 'scroll':
            payload = await conn.actuate.scroll(a.amount);
            break;
          case 'mcp_list':
            // Connect all enabled local MCP servers + return their tool catalogs.
            payload = conn.mcp
              ? { ok: true, result: await conn.mcp.advertise() }
              : { ok: false, error: 'MCP not supported by this connector' };
            break;
          case 'mcp_call':
            // Proxy a tool call to a local MCP server (a.server, a.tool, a.args).
            payload = conn.mcp
              ? await conn.mcp.callTool(a.server, a.tool, a.args)
              : { ok: false, error: 'MCP not supported by this connector' };
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
