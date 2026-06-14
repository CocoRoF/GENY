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
        openSettings(): void
        setClickThrough(ignore: boolean): void
        moveBy(dx: number, dy: number): void
      }
      hotkeys?: {
        getPushToTalk(): Promise<string | null>
        setPushToTalk(accelerator: string): Promise<boolean>
        /** Subscribe to global push-to-talk presses; returns a disposer. */
        onPushToTalk(cb: () => void): () => void
      }
      capture: {
        listSources(): Promise<Array<{ id: string; name: string; display_id: string }>>
      }
      actuate: {
        openApp(target: string): Promise<{ ok: boolean; result?: string; denied?: boolean; error?: string }>
        clipboardWrite(text: string): Promise<{ ok: boolean; result?: string; denied?: boolean; error?: string }>
        type(text: string): Promise<{ ok: boolean; result?: string; denied?: boolean; error?: string }>
        key(keys: string): Promise<{ ok: boolean; result?: string; denied?: boolean; error?: string }>
        click(x: number, y: number, button?: string): Promise<{ ok: boolean; result?: string; denied?: boolean; error?: string }>
      }
    }
  }
}

export {}
