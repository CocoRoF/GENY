import { contextBridge, ipcRenderer } from 'electron'

// ─────────────────────────────────────────────────────────────────────────────
// connectorBridge — the ONLY surface the renderer uses to reach native power.
//
// The renderer never imports `electron` directly (PLAN §2.1 hedge): everything
// native goes through this typed bridge, so a future Tauri backend can supply
// the same shape without touching renderer code. Phase 0 implements the subset
// needed for the floating overlay; screenCapture / mic / hotkeys / actuation are
// declared as the surface grows (Phases 3–6) but only wired when implemented.
// ─────────────────────────────────────────────────────────────────────────────

export interface ConnectorConfig {
  serverUrl: string
  overlay?: { x: number; y: number; width: number; height: number; displayId?: number }
}

export interface ConnectorBridge {
  /** Which window this renderer instance is: 'overlay' (avatar) or 'control'. */
  windowKind: 'overlay' | 'control'

  serverConfig: {
    get(): Promise<ConnectorConfig>
    set(patch: Partial<ConnectorConfig>): Promise<ConnectorConfig>
  }

  /** OS keychain (keytar) — stores the account JWT, not the password. */
  secureStore: {
    get(key: string): Promise<string | null>
    set(key: string, value: string): Promise<boolean>
    delete(key: string): Promise<boolean>
  }

  windowControl: {
    /** true = clicks pass through to the app behind; false = overlay captures. */
    setClickThrough(ignore: boolean): void
    /** Move the overlay by a pixel delta (dock-handle drag). */
    moveBy(dx: number, dy: number): void
    /** Show/hide the control (chat/settings) window. */
    toggleControl(): void
  }
}

const api: ConnectorBridge = {
  windowKind: new URLSearchParams(location.search).get('window') === 'control' ? 'control' : 'overlay',
  serverConfig: {
    get: () => ipcRenderer.invoke('config:get'),
    set: (patch) => ipcRenderer.invoke('config:set', patch),
  },
  secureStore: {
    get: (key) => ipcRenderer.invoke('secure:get', key),
    set: (key, value) => ipcRenderer.invoke('secure:set', key, value),
    delete: (key) => ipcRenderer.invoke('secure:delete', key),
  },
  windowControl: {
    setClickThrough: (ignore) => ipcRenderer.send('overlay:set-ignore-mouse', ignore),
    moveBy: (dx, dy) => ipcRenderer.send('overlay:move-by', dx, dy),
    toggleControl: () => ipcRenderer.send('control:toggle'),
  },
}

contextBridge.exposeInMainWorld('connector', api)
