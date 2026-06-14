/**
 * screenFrameAccess — a tiny in-process bridge so a conversation turn can
 * attach the CURRENT screen frame (OLV's "see what's on screen when you
 * talk to me" model), reusing the live MediaStream the screen-observation
 * toggle already opened.
 *
 * Why a module singleton instead of React context: the screen stream is
 * owned by ``useScreenObservation`` (mounted via ScreenObservationControls
 * in the avatar overlay) while the consumer (PushToTalkDriver, also in the
 * overlay) is a sibling — both live in the SAME renderer process. The hook
 * registers a frame-grabber here while its stream is live and clears it on
 * teardown; consumers call ``grabCurrentScreenAttachment`` and get either a
 * fresh frame or ``null`` (toggle off / no stream / not this window).
 *
 * Note: only works in the window that owns the stream (the overlay). The
 * separate /connector chat window has no stream — its screen awareness
 * comes from the ambient observation + memory recall path instead.
 */

import type { ChatAttachment } from '@/types';

/** Returns a JPEG data URL of the current screen frame, or null. */
export type ScreenFrameGrabber = () => Promise<{ data: string; mime_type: string } | null>;

let _grabber: ScreenFrameGrabber | null = null;

/** Called by useScreenObservation: pass a grabber while the stream is live,
 *  or ``null`` on teardown. Last writer wins. */
export function registerScreenGrabber(grabber: ScreenFrameGrabber | null): void {
  _grabber = grabber;
}

/** True when a live screen stream is available in this window. */
export function isScreenFrameAvailable(): boolean {
  return _grabber !== null;
}

/** Grab the current screen frame as RAW base64 (no dedup), or null when no
 *  stream is live / capture fails. Never throws. Used by the connector
 *  bridge's ``screen_capture`` so a backend-orchestrated turn capture reuses
 *  the already-open live stream (instant) instead of opening a new one. */
export async function grabCurrentScreenRaw(): Promise<{ data: string; mime_type: string } | null> {
  const g = _grabber;
  if (!g) return null;
  try {
    const r = await g();
    if (!r || !r.data) return null;
    // The grabber returns a full data URL ("data:image/jpeg;base64,<b64>");
    // strip the header to RAW base64 (the executor MultimodalNormalizer +
    // BroadcastAttachment.data expect raw base64, not a data: URL).
    const comma = r.data.indexOf(',');
    const raw = comma >= 0 ? r.data.slice(comma + 1) : r.data;
    if (!raw) return null;
    return { data: raw, mime_type: r.mime_type };
  } catch {
    return null;
  }
}

/** Grab the current screen frame as a chat attachment, or null when no
 *  stream is live / capture fails. Never throws.
 *
 *  No change-dedup: every turn attaches the CURRENT frame so the persona
 *  always judges what's literally on screen now. (The executor dehydrates
 *  image base64 out of history after the turn, so a prior turn's frame is
 *  gone — skipping an "unchanged" frame would leave the persona blind for
 *  that turn rather than save it from re-reading.) */
export async function grabCurrentScreenAttachment(): Promise<ChatAttachment | null> {
  const r = await grabCurrentScreenRaw();
  if (!r) return null;
  return {
    kind: 'image',
    mime_type: r.mime_type,
    data: r.data,
    name: 'screen.jpg',
    // Provenance: lets the backend keep this out of persisted chat history
    // and honour the screen-image kill-switch (it's ambient context).
    source: 'screen_observation',
  };
}
