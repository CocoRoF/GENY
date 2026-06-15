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
  theme?: 'system' | 'dark' | 'light'
  overlay?: { x: number; y: number; width: number; height: number; displayId?: number }
}

export interface ConnectorBridge {
  /** Which window this renderer is: 'overlay' (avatar) or 'settings'/'control'. */
  windowKind: 'overlay' | 'control' | 'settings'

  /** Connector app version (package.json), for the settings window. */
  appVersion(): Promise<string>

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
    /** Always show + focus the control window (chat/settings); never hides. */
    openControl(): void
    /** Re-load BOTH windows after login/logout (token changed in keychain). */
    refresh(): void
    /** Set which session the floating overlay renders, and reload it. */
    setOverlaySession(sessionId: string): void
    /** Open the settings window (server URL / account / auto-update). */
    openSettings(): void
    /** Restart the whole connector app (reloads overlay/panel + native code). */
    restart(): void
    /** Open a URL in the user's default browser (e.g. the Geny web app). */
    openExternal(url: string): void
    /** Reload only the chat/control panel (e.g. after a theme change). */
    reloadPanel(): void
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

  /** Phase 4 — desktop awareness (read-only). */
  capture: {
    listSources(): Promise<Array<{ id: string; name: string; display_id: string }>>
  }

  /** Phase 6 — guarded actuation. Each call is gated by the master switch + a
   *  native confirm in main; returns {ok, result?, denied?, error?}. */
  actuate: {
    openApp(target: string): Promise<ActuationResult>
    clipboardWrite(text: string): Promise<ActuationResult>
    type(text: string): Promise<ActuationResult>
    key(keys: string): Promise<ActuationResult>
    click(x: number, y: number, button?: string): Promise<ActuationResult>
  }
}

export interface ActuationResult {
  ok: boolean
  result?: string
  denied?: boolean
  error?: string
}

const _wk = new URLSearchParams(location.search).get('window')

const api: ConnectorBridge = {
  windowKind: _wk === 'settings' ? 'settings' : _wk === 'control' ? 'control' : 'overlay',
  appVersion: () => ipcRenderer.invoke('app:version'),
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
    openControl: () => ipcRenderer.send('control:open'),
    refresh: () => ipcRenderer.send('app:refresh'),
    setOverlaySession: (sessionId) => ipcRenderer.send('overlay:set-session', sessionId),
    openSettings: () => ipcRenderer.send('settings:open'),
    restart: () => ipcRenderer.send('app:restart'),
    openExternal: (url) => ipcRenderer.send('app:open-external', url),
    reloadPanel: () => ipcRenderer.send('app:reload-control'),
  },
  updater: {
    getEnabled: () => ipcRenderer.invoke('updater:get-enabled'),
    setEnabled: (enabled) => ipcRenderer.invoke('updater:set-enabled', enabled),
    check: () => ipcRenderer.send('updater:check'),
  },
  capture: {
    listSources: () => ipcRenderer.invoke('capture:list-sources'),
  },
  actuate: {
    openApp: (target) => ipcRenderer.invoke('actuate:open-app', target),
    clipboardWrite: (text) => ipcRenderer.invoke('actuate:clipboard-write', text),
    type: (text) => ipcRenderer.invoke('actuate:type', text),
    key: (keys) => ipcRenderer.invoke('actuate:key', keys),
    click: (x, y, button) => ipcRenderer.invoke('actuate:click', x, y, button),
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
