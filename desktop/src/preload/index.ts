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

export interface OverlayTuning {
  ttsVolume?: number
  sttSensitivity?: number
  sttSilenceMs?: number
  sttEchoCancellation?: boolean
  sttNoiseSuppression?: boolean
  sttAutoGain?: boolean
  screenIntervalMs?: number
  screenSourceId?: string | null
  /** Show the bottom dialogue-box subtitle on the avatar overlay (default true). */
  subtitlesEnabled?: boolean
  /** Subtitle typewriter pace — ms per character (default 100 = 0.1s/char). */
  subtitleCharMs?: number
}

/** Consent posture for an actuation capability group. */
export type ConsentMode = 'ask' | 'session' | 'auto'
/** Local Computer Use — per-capability consent (local bridge). */
export interface ComputerUseConfig {
  enabled?: boolean
  screen?: boolean
  input?: boolean
  apps?: boolean
  clipboard?: boolean
  consentMode?: ConsentMode
}

/** A local MCP server the connector hosts + proxies to the Geny agent. */
export interface MCPServerConfig {
  name: string
  transport: 'stdio' | 'http'
  command?: string
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  enabled?: boolean
}
export interface MCPToolSchema {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}
export interface MCPServerAdvert {
  name: string
  connected: boolean
  error?: string
  tools: MCPToolSchema[]
}

export interface ConnectorConfig {
  serverUrl: string
  theme?: 'system' | 'dark' | 'light'
  /** UI language for the settings window. Unset → resolved from the OS locale. */
  lang?: 'ko' | 'en'
  overlay?: { x: number; y: number; width: number; height: number; displayId?: number }
  overlayTuning?: OverlayTuning
  computerUse?: ComputerUseConfig
  mcpServers?: MCPServerConfig[]
}

export interface ConnectorBridge {
  /** Which window this renderer is: 'overlay' (avatar), 'settings'/'control', or
   *  'quickchat' (the floating Spotlight-style input bar). */
  windowKind: 'overlay' | 'control' | 'settings' | 'quickchat'

  /** Connector app version (package.json), for the settings window. */
  appVersion(): Promise<string>

  /** OS-derived default UI language ('ko' if the OS locale starts with "ko",
   *  else 'en'). The settings window uses this when config.lang is unset. */
  appDefaultLang(): Promise<'ko' | 'en'>

  serverConfig: {
    get(): Promise<ConnectorConfig>
    set(patch: Partial<ConnectorConfig>): Promise<ConnectorConfig>
    /** Subscribe to live config changes (main broadcasts after every set);
     *  used by the overlay to apply overlayTuning without a reload. */
    onChange(cb: (cfg: ConnectorConfig) => void): () => void
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
    /** Resize the overlay from an edge/corner handle by a pixel delta (unlocked).
     *  `edge` is a combo of n/s/e/w (e.g. 'se', 'n'). */
    resizeOverlayBy(edge: string, dx: number, dy: number): void
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
    /** Reset every window's position/size + the avatar view to defaults. */
    resetPositions(): void
    /** Overlay page only: fired when the user resets positions — clear the saved
     *  pan/zoom + reload so the avatar returns to its default framing. */
    onResetView(cb: () => void): () => void
  }

  /** Global hotkeys (push-to-talk + quick-chat). */
  hotkeys: {
    getPushToTalk(): Promise<string | null>
    setPushToTalk(accelerator: string): Promise<boolean>
    /** Subscribe to global push-to-talk presses; returns a disposer. */
    onPushToTalk(cb: () => void): () => void
    /** Global quick-chat accelerator (summons the floating input bar). */
    getQuickChat(): Promise<string | null>
    setQuickChat(accelerator: string): Promise<boolean>
    /** Suspend / restore all global shortcuts while a settings field records a
     *  new combo (so a registered key isn't intercepted during capture). */
    pause(): void
    resume(): void
  }

  /** Quick-chat input bar (the 'quickchat' window) → relay to the VTuber chat. */
  quickChat: {
    /** Send the typed text to the current VTuber; main closes the bar on ok. */
    submit(text: string): Promise<{ ok: boolean; error?: string }>
    /** Dismiss the bar (Esc / blur). */
    close(): void
    /** Fired each time the bar is summoned (paint the card, reset + focus). */
    onOpened(cb: () => void): () => void
    /** Fired when main dismisses the bar (blur/submit/Esc) — stop painting. */
    onDismissed(cb: () => void): () => void
  }

  /** Inbound messaging from the connector → the /connector chat page reuses its
   *  own send path when a quick-chat message arrives. */
  messaging: {
    /** Subscribe to quick-chat relays; returns a disposer. */
    onQuickSend(cb: (text: string) => void): () => void
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

  /** Launch-on-login (start when the user signs into the OS). */
  autostart: {
    get(): Promise<boolean>
    set(enabled: boolean): Promise<boolean>
  }

  /** Phase 4 — desktop awareness (read-only). */
  capture: {
    listSources(): Promise<Array<{ id: string; name: string; display_id: string }>>
    /** The primary display's id (string) — so desktop_screenshot captures the
     *  PRIMARY, whose pixel space matches nut.js mouse coordinates. */
    primaryDisplayId(): Promise<string>
    /** Report the last full-res screenshot's pixel size so main can map the
     *  model's image-space click coords back to screen coords. */
    noteCaptureDims(w: number, h: number): void
  }

  /** Phase 6 — guarded actuation. Each call is gated by the master switch + a
   *  native confirm in main; returns {ok, result?, denied?, error?}. */
  actuate: {
    openApp(target: string): Promise<ActuationResult>
    clipboardWrite(text: string): Promise<ActuationResult>
    type(text: string): Promise<ActuationResult>
    key(keys: string): Promise<ActuationResult>
    click(x: number, y: number, button?: string): Promise<ActuationResult>
    /** Scroll the wheel: positive = down, negative = up (wheel steps). */
    scroll(amount: number): Promise<ActuationResult>
  }

  /** Local MCP proxy (Phase 3) — hosts MCP clients to the user's local servers. */
  mcp: {
    /** Configured servers (from config; no connection). */
    listServers(): Promise<MCPServerConfig[]>
    /** Connect all enabled servers + return their tool catalogs. */
    advertise(): Promise<MCPServerAdvert[]>
    /** Call a tool on a server. Returns the raw MCP CallToolResult (or error). */
    callTool(server: string, tool: string, args: unknown): Promise<{ ok: boolean; result?: unknown; error?: string }>
    /** One-shot connect → list tools → disconnect (settings "테스트"). */
    testServer(cfg: MCPServerConfig): Promise<{ ok: boolean; tools?: MCPToolSchema[]; error?: string }>
    /** Add/replace a server (persisted). Returns the new list. */
    addServer(cfg: MCPServerConfig): Promise<MCPServerConfig[]>
    /** Remove a server by name (persisted). Returns the new list. */
    removeServer(name: string): Promise<MCPServerConfig[]>
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
  windowKind:
    _wk === 'settings' ? 'settings'
    : _wk === 'control' ? 'control'
    : _wk === 'quickchat' ? 'quickchat'
    : 'overlay',
  appVersion: () => ipcRenderer.invoke('app:version'),
  appDefaultLang: () => ipcRenderer.invoke('i18n:default-lang'),
  serverConfig: {
    get: () => ipcRenderer.invoke('config:get'),
    set: (patch) => ipcRenderer.invoke('config:set', patch),
    onChange: (cb) => {
      const h = (_e: unknown, cfg: ConnectorConfig) => cb(cfg)
      ipcRenderer.on('config:changed', h)
      return () => ipcRenderer.removeListener('config:changed', h)
    },
  },
  secureStore: {
    get: (key) => ipcRenderer.invoke('secure:get', key),
    set: (key, value) => ipcRenderer.invoke('secure:set', key, value),
    delete: (key) => ipcRenderer.invoke('secure:delete', key),
  },
  windowControl: {
    setClickThrough: (ignore) => ipcRenderer.send('overlay:set-ignore-mouse', ignore),
    moveBy: (dx, dy) => ipcRenderer.send('overlay:move-by', dx, dy),
    resizeOverlayBy: (edge, dx, dy) => ipcRenderer.send('overlay:resize-by', edge, dx, dy),
    toggleControl: () => ipcRenderer.send('control:toggle'),
    openControl: () => ipcRenderer.send('control:open'),
    refresh: () => ipcRenderer.send('app:refresh'),
    setOverlaySession: (sessionId) => ipcRenderer.send('overlay:set-session', sessionId),
    openSettings: () => ipcRenderer.send('settings:open'),
    restart: () => ipcRenderer.send('app:restart'),
    openExternal: (url) => ipcRenderer.send('app:open-external', url),
    reloadPanel: () => ipcRenderer.send('app:reload-control'),
    resetPositions: () => ipcRenderer.send('windows:reset-positions'),
    onResetView: (cb) => {
      const h = () => cb()
      ipcRenderer.on('overlay:reset-view', h)
      return () => ipcRenderer.removeListener('overlay:reset-view', h)
    },
  },
  updater: {
    getEnabled: () => ipcRenderer.invoke('updater:get-enabled'),
    setEnabled: (enabled) => ipcRenderer.invoke('updater:set-enabled', enabled),
    check: () => ipcRenderer.send('updater:check'),
  },
  autostart: {
    get: () => ipcRenderer.invoke('autostart:get'),
    set: (enabled) => ipcRenderer.invoke('autostart:set', enabled),
  },
  capture: {
    listSources: () => ipcRenderer.invoke('capture:list-sources'),
    primaryDisplayId: () => ipcRenderer.invoke('capture:primary-display-id'),
    noteCaptureDims: (w, h) => ipcRenderer.send('capture:note-dims', w, h),
  },
  actuate: {
    openApp: (target) => ipcRenderer.invoke('actuate:open-app', target),
    clipboardWrite: (text) => ipcRenderer.invoke('actuate:clipboard-write', text),
    type: (text) => ipcRenderer.invoke('actuate:type', text),
    key: (keys) => ipcRenderer.invoke('actuate:key', keys),
    click: (x, y, button) => ipcRenderer.invoke('actuate:click', x, y, button),
    scroll: (amount) => ipcRenderer.invoke('actuate:scroll', amount),
  },
  mcp: {
    listServers: () => ipcRenderer.invoke('mcp:list-servers'),
    advertise: () => ipcRenderer.invoke('mcp:advertise'),
    callTool: (server, tool, args) => ipcRenderer.invoke('mcp:call-tool', server, tool, args),
    testServer: (cfg) => ipcRenderer.invoke('mcp:test-server', cfg),
    addServer: (cfg) => ipcRenderer.invoke('mcp:add-server', cfg),
    removeServer: (name) => ipcRenderer.invoke('mcp:remove-server', name),
  },
  hotkeys: {
    getPushToTalk: () => ipcRenderer.invoke('hotkey:get-ptt'),
    setPushToTalk: (acc) => ipcRenderer.invoke('hotkey:set-ptt', acc),
    onPushToTalk: (cb) => {
      const h = () => cb()
      ipcRenderer.on('connector:ptt-toggle', h)
      return () => ipcRenderer.removeListener('connector:ptt-toggle', h)
    },
    getQuickChat: () => ipcRenderer.invoke('hotkey:get-quickchat'),
    setQuickChat: (acc) => ipcRenderer.invoke('hotkey:set-quickchat', acc),
    pause: () => ipcRenderer.send('hotkey:pause'),
    resume: () => ipcRenderer.send('hotkey:resume'),
  },
  quickChat: {
    submit: (text) => ipcRenderer.invoke('quickchat:submit', text),
    close: () => ipcRenderer.send('quickchat:close'),
    onOpened: (cb) => {
      const h = () => cb()
      ipcRenderer.on('quickchat:opened', h)
      return () => ipcRenderer.removeListener('quickchat:opened', h)
    },
    onDismissed: (cb) => {
      const h = () => cb()
      ipcRenderer.on('quickchat:dismissed', h)
      return () => ipcRenderer.removeListener('quickchat:dismissed', h)
    },
  },
  messaging: {
    onQuickSend: (cb) => {
      const h = (_e: unknown, text: string) => cb(text)
      ipcRenderer.on('connector:quick-send', h)
      return () => ipcRenderer.removeListener('connector:quick-send', h)
    },
  },
}

contextBridge.exposeInMainWorld('connector', api)
