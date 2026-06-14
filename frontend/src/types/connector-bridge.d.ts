/**
 * Ambient type for the desktop connector's preload bridge.
 *
 * When a page is loaded inside the Geny desktop connector (Electron), the
 * preload exposes `window.connector`. In a normal browser it is undefined, so
 * every access is optional-chained. This declaration only covers what the web
 * routes (e.g. /connector) call; the full surface lives in desktop/src/preload.
 */
declare global {
  interface Window {
    connector?: {
      windowControl: {
        setOverlaySession(sessionId: string): void
        refresh(): void
      }
    }
  }
}

export {}
