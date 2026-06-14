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
  /** Which window this renderer is: 'overlay' (avatar) or 'settings'/'control'. */
  windowKind: 'overlay' | 'control' | 'settings'

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
    /** Re-load BOTH windows after login/logout (token changed in keychain). */
    refresh(): void
    /** Set which session the floating overlay renders, and reload it. */
    setOverlaySession(sessionId: string): void
    /** Open the settings window (server URL / account / auto-update). */
    openSettings(): void
  }

  /** Global push-to-talk hotkey. */
  hotkeys: {
    getPushToTalk(): Promise<string | null>
    setPushToTalk(accelerator: string): Promise<boolean>
    /** Subscribe to global push-to-talk presses; returns a disposer. */
    onPushToTalk(cb: () => void): () => void
  }

  /** GitHub Releases auto-update controls. */
  updater: {
    /** Is auto-update enabled? (default true) */
    getEnabled(): Promise<boolean>
    /** Toggle auto-update; when re-enabled, an immediate check runs. */
    setEnabled(enabled: boolean): Promise<boolean>
    /** Manually check now (downloads + prompts if an update exists). */
    check(): void
  }
}

const _wk = new URLSearchParams(location.search).get('window')

const api: ConnectorBridge = {
  windowKind: _wk === 'settings' ? 'settings' : _wk === 'control' ? 'control' : 'overlay',
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
    refresh: () => ipcRenderer.send('app:refresh'),
    setOverlaySession: (sessionId) => ipcRenderer.send('overlay:set-session', sessionId),
    openSettings: () => ipcRenderer.send('settings:open'),
  },
  updater: {
    getEnabled: () => ipcRenderer.invoke('updater:get-enabled'),
    setEnabled: (enabled) => ipcRenderer.invoke('updater:set-enabled', enabled),
    check: () => ipcRenderer.send('updater:check'),
  },
  hotkeys: {
    getPushToTalk: () => ipcRenderer.invoke('hotkey:get-ptt'),
    setPushToTalk: (acc) => ipcRenderer.invoke('hotkey:set-ptt', acc),
    onPushToTalk: (cb) => {
      const h = () => cb()
      ipcRenderer.on('connector:ptt-toggle', h)
      return () => ipcRenderer.removeListener('connector:ptt-toggle', h)
    },
  },
}

contextBridge.exposeInMainWorld('connector', api)
