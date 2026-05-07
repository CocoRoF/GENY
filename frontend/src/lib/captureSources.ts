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

export function registerCaptureSource(source: CaptureSource): () => void {
  if (!source.id) throw new Error('CaptureSource.id is required');
  _registry.set(source.id, source);
  return () => {
    _registry.delete(source.id);
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

// ── Built-in source: file_drop / file_pick ───────────────────────────
// Implementation lives here so it loads with the registry and is
// always available; UI components only import the registry.

let _builtinsRegistered = false;

export function registerBuiltinCaptureSources(): void {
  if (_builtinsRegistered) return;
  _builtinsRegistered = true;

  registerCaptureSource({
    id: 'file_drop',
    label: 'Upload',
    icon: null, // CaptureToolbar provides its own icon when icon is null
    order: 50,
    run: async (ctx) => {
      const file = await pickFile();
      if (!file) return null;
      return uploadCaptureFile(file, { source: 'file_drop', ctx });
    },
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
