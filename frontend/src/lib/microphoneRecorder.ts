/**
 * Microphone recorder controller — opens `<MicrophoneRecorderModal>`
 * on demand and resolves with the captured Blob (or `null` on cancel).
 *
 * Mounting strategy: dynamic `createRoot` into a fresh `<div>` appended
 * to `document.body`. Keeps the recorder out of the global tree until
 * it's actually used (the modal pulls in `lucide-react` icons + the
 * Web-Audio analyser code path; no reason to ship that on every page).
 *
 * One concurrent recording at a time — a second `recordAudio()` call
 * while the modal is open returns `null` immediately. The capture
 * source in ``captureSources.ts`` is guarded by the toolbar's "running"
 * flag, so this is just belt-and-braces.
 */

import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

let _activeRoot: Root | null = null;
let _activeContainer: HTMLElement | null = null;

export async function recordAudio(): Promise<Blob | null> {
  if (typeof document === 'undefined') {
    return null;
  }
  if (_activeRoot !== null) {
    // A recording is already in progress — refuse to open a second one.
    return null;
  }

  // Lazy-load the modal so SSR builds + non-mic pages don't pay the
  // bundle cost. The dynamic import is intentional.
  const { default: MicrophoneRecorderModal } = await import(
    '@/components/user-opsidian/MicrophoneRecorderModal'
  );

  const container = document.createElement('div');
  container.setAttribute('data-mic-recorder-root', '');
  document.body.appendChild(container);
  const root = createRoot(container);
  _activeRoot = root;
  _activeContainer = container;

  return new Promise<Blob | null>((resolve) => {
    let settled = false;
    const finish = (blob: Blob | null) => {
      if (settled) return;
      settled = true;
      // Defer the unmount one tick so React can flush whatever state
      // the modal queued on its way out (avoids the dev-mode warning
      // about unmounting while a state update is in flight).
      queueMicrotask(() => {
        try {
          root.unmount();
        } catch {
          /* ignored */
        }
        if (container.parentNode) {
          container.parentNode.removeChild(container);
        }
        if (_activeRoot === root) {
          _activeRoot = null;
          _activeContainer = null;
        }
        resolve(blob);
      });
    };
    root.render(createElement(MicrophoneRecorderModal, { onDone: finish }));
  });
}

/** Test hook — force-unmount the active modal (no-op when idle). */
export function _resetMicrophoneRecorderForTests(): void {
  if (_activeRoot) {
    try {
      _activeRoot.unmount();
    } catch {
      /* ignored */
    }
  }
  if (_activeContainer && _activeContainer.parentNode) {
    _activeContainer.parentNode.removeChild(_activeContainer);
  }
  _activeRoot = null;
  _activeContainer = null;
}
