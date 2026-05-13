/**
 * Capture Source Registry — extension hook for the whiteboard (Phase 1+).
 *
 * A capture source is a small client-side adapter that produces a
 * `WhiteboardCaptureCreatedResponse` from a user gesture (button
 * click, drag-drop, paste, microphone recording, etc.). The
 * `<CaptureToolbar>` component renders one button per registered
 * source; new sources slot in by calling `registerCaptureSource(...)`
 * once at module load — no edits to the toolbar itself.
 *
 * Phase 1 ships only the registry + a `file_drop` source so the
 * toolbar has something to render. Phases 3+ add screen capture,
 * clipboard, audio, drawing, and any external plugins.
 */

import type { ReactNode } from 'react';
import {
  whiteboardApi,
  type WhiteboardCaptureCreatedResponse,
  type WhiteboardCaptureType,
} from '@/lib/api';

export interface CaptureContext {
  /** Optional active session for the capture (for spotlight scoping later). */
  sessionId?: string | null;
  /** Caller-supplied hint shown in the capture preview / toast. */
  hint?: string | null;
}

export interface CaptureSource {
  /** Unique id (e.g. "screen_capture", "clipboard_paste", "file_drop"). */
  id: string;
  /** Short label rendered on the toolbar button. */
  label: string;
  /** Lucide icon (or any ReactNode). */
  icon: ReactNode;
  /** Optional pre-flight check — returning false hides the button. */
  isAvailable?: () => boolean;
  /** Trigger the capture flow. Resolves with the created capture, or
   *  null when the user cancelled (don't throw on cancel). */
  run: (ctx: CaptureContext) => Promise<WhiteboardCaptureCreatedResponse | null>;
  /** Sort weight for toolbar ordering — lower = earlier. */
  order?: number;
}

const _registry = new Map<string, CaptureSource>();

// Tiny pub-sub so consumers (CaptureToolbar) can re-render when
// a source registers AFTER mount — the previous "single setTimeout
// after mount" hack only caught sources registered within ~50 ms.
type RegistryListener = () => void;
const _listeners = new Set<RegistryListener>();

function _emit(): void {
  for (const fn of Array.from(_listeners)) {
    try {
      fn();
    } catch {
      /* listener errors are not our problem */
    }
  }
}

export function onCaptureSourcesChange(listener: RegistryListener): () => void {
  _listeners.add(listener);
  return () => {
    _listeners.delete(listener);
  };
}

export function registerCaptureSource(source: CaptureSource): () => void {
  if (!source.id) throw new Error('CaptureSource.id is required');
  _registry.set(source.id, source);
  _emit();
  return () => {
    _registry.delete(source.id);
    _emit();
  };
}

export function getCaptureSource(id: string): CaptureSource | undefined {
  return _registry.get(id);
}

export function listCaptureSources(): CaptureSource[] {
  const all = Array.from(_registry.values());
  const filtered = all.filter((s) => (s.isAvailable ? safeAvailable(s) : true));
  filtered.sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
  return filtered;
}

function safeAvailable(source: CaptureSource): boolean {
  try {
    return source.isAvailable?.() ?? true;
  } catch {
    return false;
  }
}

// ── Helpers reusable by sources ──────────────────────────────────────

export interface UploadCaptureFileOptions {
  type?: WhiteboardCaptureType;
  source: string;
  ctx?: CaptureContext;
}

export async function uploadCaptureFile(
  file: File,
  opts: UploadCaptureFileOptions,
): Promise<WhiteboardCaptureCreatedResponse> {
  const { type, source, ctx } = opts;
  const inferred: WhiteboardCaptureType =
    type ??
    (file.type.startsWith('image/')
      ? 'image'
      : file.type.startsWith('audio/')
        ? 'audio'
        : 'file');
  return whiteboardApi.uploadCapture({
    file,
    type: inferred,
    source,
    sessionId: ctx?.sessionId ?? null,
    metadata: {
      content_type: file.type,
      size_bytes: file.size,
      hint: ctx?.hint ?? null,
    },
    filename: file.name,
  });
}

// ── Built-in sources (Phase 1 + Phase 3) ─────────────────────────────
// Implementations live here so they load with the registry and are
// always available; UI components only import the registry. New
// sources register one block here — the toolbar picks them up.

let _builtinsRegistered = false;

export function registerBuiltinCaptureSources(): void {
  if (_builtinsRegistered) return;
  _builtinsRegistered = true;

  // P1 — file picker / drag-drop fallback.
  registerCaptureSource({
    id: 'file_drop',
    label: 'Upload',
    icon: null,
    order: 50,
    run: async (ctx) => {
      const file = await pickFile();
      if (!file) return null;
      return uploadCaptureFile(file, { source: 'file_drop', ctx });
    },
  });

  // P3 — clipboard paste (image OR text).
  registerCaptureSource({
    id: 'clipboard_paste',
    label: 'Paste',
    icon: null,
    order: 60,
    isAvailable: () =>
      typeof navigator !== 'undefined' &&
      typeof navigator.clipboard?.read === 'function',
    run: async (ctx) => grabClipboard(ctx),
  });

  // P3 — screen capture via getDisplayMedia.
  registerCaptureSource({
    id: 'screen_capture',
    label: 'Screen',
    icon: null,
    order: 70,
    isAvailable: () =>
      typeof navigator !== 'undefined' &&
      typeof navigator.mediaDevices?.getDisplayMedia === 'function',
    run: async (ctx) => grabScreen(ctx),
  });

  // W3 (voice-notes) — microphone recording via MediaRecorder. The
  // modal + Web-Audio analyser code is lazy-loaded by `recordAudio()`
  // so we don't pay the bundle cost on pages that never record.
  registerCaptureSource({
    id: 'microphone_record',
    label: 'Record',
    icon: null,
    order: 65,
    isAvailable: () =>
      typeof navigator !== 'undefined' &&
      typeof navigator.mediaDevices?.getUserMedia === 'function' &&
      typeof MediaRecorder !== 'undefined',
    run: async (ctx) => grabMicrophone(ctx),
  });
}

async function pickFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = false;
    input.style.position = 'fixed';
    input.style.opacity = '0';
    input.style.pointerEvents = 'none';
    input.addEventListener('change', () => {
      const file = input.files?.[0] ?? null;
      document.body.removeChild(input);
      resolve(file);
    });
    input.addEventListener('cancel', () => {
      document.body.removeChild(input);
      resolve(null);
    });
    document.body.appendChild(input);
    input.click();
  });
}

// ── clipboard_paste ──────────────────────────────────────────────────


async function grabClipboard(
  ctx: CaptureContext,
): Promise<WhiteboardCaptureCreatedResponse | null> {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.read) {
    throw new Error('Clipboard read not supported in this browser');
  }
  const items = await navigator.clipboard.read();
  for (const item of items) {
    // Image variant first — most useful.
    const imageType = item.types.find((t) => t.startsWith('image/'));
    if (imageType) {
      const blob = await item.getType(imageType);
      const ext = imageType.split('/')[1] ?? 'png';
      const file = new File([blob], `clipboard.${ext}`, { type: imageType });
      return uploadCaptureFile(file, {
        type: 'image',
        source: 'clipboard_paste',
        ctx,
      });
    }
  }
  // Fallback: plain text via the JSON capture endpoint.
  for (const item of items) {
    const textType = item.types.find((t) => t === 'text/plain');
    if (textType) {
      const blob = await item.getType(textType);
      const text = await blob.text();
      if (!text.trim()) continue;
      return whiteboardApi.createCapture({
        type: 'text',
        source: 'clipboard_paste',
        payload: { inline_text: text },
        session_id: ctx.sessionId ?? null,
        metadata: { hint: ctx.hint ?? null },
      });
    }
  }
  // Reaching here means the clipboard exists but has nothing we can
  // capture — neither an image nor non-empty text. Throw so the
  // toolbar surfaces an explicit error instead of silently swallowing
  // the click (the previous null-return path looked like success).
  throw new Error(
    'Clipboard is empty (no image or text to capture)',
  );
}

// ── screen_capture ──────────────────────────────────────────────────


async function grabScreen(
  ctx: CaptureContext,
): Promise<WhiteboardCaptureCreatedResponse | null> {
  if (
    typeof navigator === 'undefined' ||
    !navigator.mediaDevices?.getDisplayMedia
  ) {
    throw new Error('Screen capture not supported in this browser');
  }
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: 'monitor' } as MediaTrackConstraints,
    audio: false,
  });
  try {
    const blob = await captureFirstFrame(stream);
    if (!blob) return null;
    const file = new File([blob], 'screen.png', { type: 'image/png' });
    return uploadCaptureFile(file, {
      type: 'screenshot',
      source: 'screen_capture',
      ctx,
    });
  } finally {
    // Always release the screen-share track immediately — leaving
    // the indicator on after we've grabbed one frame is creepy UX.
    stream.getTracks().forEach((t) => t.stop());
  }
}

async function captureFirstFrame(stream: MediaStream): Promise<Blob | null> {
  const track = stream.getVideoTracks()[0];
  if (!track) return null;

  const video = document.createElement('video');
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await video.play();

  // One animation frame is enough to ensure the first frame is
  // composited; ``HTMLVideoElement`` is ready to draw immediately
  // after ``play()`` resolves but the canvas would otherwise see
  // a black frame on some browsers.
  await new Promise((r) => requestAnimationFrame(r));

  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth || 1280;
  canvas.height = video.videoHeight || 720;
  const ctx2d = canvas.getContext('2d');
  if (!ctx2d) return null;
  ctx2d.drawImage(video, 0, 0, canvas.width, canvas.height);

  return new Promise<Blob | null>((resolve) =>
    canvas.toBlob((blob) => resolve(blob), 'image/png', 0.95),
  );
}

// ── microphone_record ────────────────────────────────────────────────


async function grabMicrophone(
  ctx: CaptureContext,
): Promise<WhiteboardCaptureCreatedResponse | null> {
  if (
    typeof navigator === 'undefined' ||
    !navigator.mediaDevices?.getUserMedia ||
    typeof MediaRecorder === 'undefined'
  ) {
    throw new Error('Microphone capture not supported in this browser');
  }
  // Lazy-imported so the modal + Web-Audio analyser don't load until
  // the user actually clicks Record. The promise resolves with the
  // recorded `Blob`, or `null` when the user cancelled.
  const { recordAudio } = await import('@/lib/microphoneRecorder');
  const blob = await recordAudio();
  if (!blob) return null;

  const mime = blob.type || 'audio/webm';
  // `audio/webm;codecs=opus` → strip the codec suffix for the filename
  // extension; backend uses the suffix only for MIME hinting anyway.
  const baseMime = mime.split(';', 1)[0] || 'audio/webm';
  const ext = baseMime.split('/')[1] || 'webm';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = new File([blob], `voice-${stamp}.${ext}`, { type: mime });
  return uploadCaptureFile(file, {
    type: 'audio',
    source: 'microphone_record',
    ctx,
  });
}
