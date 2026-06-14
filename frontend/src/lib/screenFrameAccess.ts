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

/** Grab the current screen frame as a chat attachment, or null when no
 *  stream is live / capture fails. Never throws. */
export async function grabCurrentScreenAttachment(): Promise<ChatAttachment | null> {
  const g = _grabber;
  if (!g) return null;
  try {
    const r = await g();
    if (!r || !r.data) return null;
    // The grabber returns a full data URL ("data:image/jpeg;base64,<b64>")
    // but the backend BroadcastAttachment.data / executor MultimodalNormalizer
    // expect RAW base64 in the ``data`` field (it builds an Anthropic
    // {type:base64,...,data:<b64>} block verbatim). Strip the data-URL
    // header so we don't double-prefix and get rejected by the vendor SDK.
    const comma = r.data.indexOf(',');
    const raw = comma >= 0 ? r.data.slice(comma + 1) : r.data;
    if (!raw) return null;
    return {
      kind: 'image',
      mime_type: r.mime_type,
      data: raw,
      name: 'screen.jpg',
    };
  } catch {
    return null;
  }
}
