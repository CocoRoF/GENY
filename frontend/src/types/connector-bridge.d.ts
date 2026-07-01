/**
 * Ambient type for the desktop connector's preload bridge.
 *
 * When a page is loaded inside the Geny desktop connector (Electron), the
 * preload exposes `window.connector`. In a normal browser it is undefined, so
 * every access is optional-chained. This declaration only covers what the web
 * routes (e.g. /connector) call; the full surface lives in desktop/src/preload.
 */
interface OverlayTuning {
  ttsVolume?: number
  sttSensitivity?: number
  sttSilenceMs?: number
  sttEchoCancellation?: boolean
  sttNoiseSuppression?: boolean
  sttAutoGain?: boolean
  screenIntervalMs?: number
  screenSourceId?: string | null
}
interface ConnectorConfig {
  serverUrl: string
  theme?: 'system' | 'dark' | 'light'
  overlayTuning?: OverlayTuning
}

declare global {
  interface Window {
    connector?: {
      serverConfig: {
        get(): Promise<ConnectorConfig>
        set(patch: Partial<ConnectorConfig>): Promise<ConnectorConfig>
        onChange(cb: (cfg: ConnectorConfig) => void): () => void
      }
      /** OS keychain — used to drop the stale JWT on token expiry. */
      secureStore?: {
        get(key: string): Promise<string | null>
        set(key: string, value: string): Promise<boolean>
        delete(key: string): Promise<boolean>
      }
      windowControl: {
        setOverlaySession(sessionId: string): void
        refresh(): void
        openSettings(): void
        toggleControl(): void
        openControl(): void
        setClickThrough(ignore: boolean): void
        moveBy(dx: number, dy: number): void
        resizeOverlayBy?(edge: string, dx: number, dy: number): void
        restart(): void
        openExternal(url: string): void
        resetPositions?(): void
        onResetView?(cb: () => void): () => void
      }
      hotkeys?: {
        getPushToTalk(): Promise<string | null>
        setPushToTalk(accelerator: string): Promise<boolean>
        /** Subscribe to global push-to-talk presses; returns a disposer. */
        onPushToTalk(cb: () => void): () => void
        getQuickChat?(): Promise<string | null>
        setQuickChat?(accelerator: string): Promise<boolean>
      }
      /** Quick-chat relay: the floating bar's message arrives here so the
       *  /connector chat can reuse its own send path. */
      messaging?: {
        onQuickSend(cb: (text: string) => void): () => void
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
        scroll(amount: number): Promise<{ ok: boolean; result?: string; denied?: boolean; error?: string }>
      }
      /** Local MCP proxy (Phase 3) — present only in the desktop connector. */
      mcp?: {
        advertise(): Promise<Array<{ name: string; connected: boolean; error?: string; tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> }>>
        callTool(server: string, tool: string, args: unknown): Promise<{ ok: boolean; result?: unknown; error?: string }>
      }
    }
  }
}

export {}
