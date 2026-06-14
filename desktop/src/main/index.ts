import { app, BrowserWindow, ipcMain, screen, shell } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'

// ─────────────────────────────────────────────────────────────────────────────
// Geny connector — main process.
//
// Two windows, one renderer process (so the zustand module-scope TTS-turn state
// is shared — see PLAN §4.1):
//   (A) overlay  — transparent, frameless, always-on-top, click-through. The
//                  floating avatar that sits at the bottom of the desktop.
//   (B) control  — a normal framed window (chat / settings / login), hidden by
//                  default, toggled from the tray (tray lands in Phase 2).
//
// The renderer talks to a running Geny server over the existing WS + REST
// contract ("Connector API v1"); this process only owns native concerns:
// window placement, click-through, secure token storage, server-URL config.
// ─────────────────────────────────────────────────────────────────────────────

const isDev = !app.isPackaged

let overlay: BrowserWindow | null = null
let control: BrowserWindow | null = null

// ── tiny JSON config (server URL, last geometry) in userData ────────────────
interface ConnectorConfig {
  serverUrl: string
  overlay?: { x: number; y: number; width: number; height: number; displayId?: number }
}
function configPath(): string {
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'connector.json')
}
function loadConfig(): ConnectorConfig {
  try {
    return JSON.parse(readFileSync(configPath(), 'utf-8'))
  } catch {
    return { serverUrl: process.env.GENY_SERVER_URL || 'http://localhost:8000' }
  }
}
function saveConfig(patch: Partial<ConnectorConfig>): ConnectorConfig {
  const next = { ...loadConfig(), ...patch }
  writeFileSync(configPath(), JSON.stringify(next, null, 2))
  return next
}

// ── overlay window: the floating avatar ─────────────────────────────────────
function createOverlay(): void {
  const primary = screen.getPrimaryDisplay()
  const wa = primary.workArea
  const cfg = loadConfig()
  const width = cfg.overlay?.width ?? 420
  const height = cfg.overlay?.height ?? Math.round(wa.height * 0.45)

  overlay = new BrowserWindow({
    width,
    height,
    // Anchor at the bottom of the work area by default (feet at the taskbar edge).
    x: cfg.overlay?.x ?? wa.x + wa.width - width - 24,
    y: cfg.overlay?.y ?? wa.y + wa.height - height,
    transparent: true,
    frame: false,
    resizable: true,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Keep the avatar ticking at full FPS even when occluded/unfocused —
      // presence (blink/idle/saccade) must not stutter. RAM is bounded by the
      // renderer's own FPS cap.
      backgroundThrottling: false,
    },
  })

  // Float above full-screen apps too (macOS).
  overlay.setAlwaysOnTop(true, 'screen-saver')
  if (process.platform === 'darwin') {
    overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  }

  // Start fully click-through; the renderer re-enables hit-testing over the
  // avatar silhouette + dock handle via the 'overlay:set-ignore-mouse' channel
  // (pixel-accurate hotspots land in Phase 2).
  overlay.setIgnoreMouseEvents(true, { forward: true })

  loadRoute(overlay, 'overlay')

  overlay.on('moved', persistOverlayBounds)
  overlay.on('resized', persistOverlayBounds)
  overlay.on('closed', () => {
    overlay = null
  })
}

function persistOverlayBounds(): void {
  if (!overlay) return
  const b = overlay.getBounds()
  saveConfig({ overlay: { x: b.x, y: b.y, width: b.width, height: b.height } })
}

// ── control window: chat / settings / login (hidden until toggled) ──────────
function createControl(): void {
  control = new BrowserWindow({
    width: 480,
    height: 720,
    show: false,
    title: 'Geny',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  loadRoute(control, 'control')
  control.on('close', (e) => {
    // Hide instead of destroy so the single renderer process persists.
    if (!appQuitting) {
      e.preventDefault()
      control?.hide()
    }
  })
}

function loadRoute(win: BrowserWindow, route: 'overlay' | 'control'): void {
  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/index.html?window=${route}`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { query: { window: route } })
  }
  // External links open in the OS browser, never inside the overlay.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
}

let appQuitting = false
app.on('before-quit', () => {
  appQuitting = true
})

// ── IPC: the connectorBridge surface (preload calls these) ──────────────────
function registerIpc(): void {
  ipcMain.handle('config:get', () => loadConfig())
  ipcMain.handle('config:set', (_e, patch: Partial<ConnectorConfig>) => saveConfig(patch))

  // Click-through toggle from the renderer's hit-test loop.
  ipcMain.on('overlay:set-ignore-mouse', (_e, ignore: boolean) => {
    overlay?.setIgnoreMouseEvents(ignore, { forward: true })
  })

  // Move the overlay by a delta (dock-handle drag).
  ipcMain.on('overlay:move-by', (_e, dx: number, dy: number) => {
    if (!overlay) return
    const b = overlay.getBounds()
    overlay.setBounds({ ...b, x: b.x + dx, y: b.y + dy })
  })

  ipcMain.on('control:toggle', () => {
    if (!control) return
    control.isVisible() ? control.hide() : control.show()
  })

  // Secure token storage via the OS keychain (keytar). Falls back to the JSON
  // config only if keytar is unavailable (logged), so dev still works.
  ipcMain.handle('secure:get', async (_e, key: string) => {
    try {
      const keytar = await import('keytar')
      return await keytar.default.getPassword('geny-connector', key)
    } catch {
      return null
    }
  })
  ipcMain.handle('secure:set', async (_e, key: string, value: string) => {
    try {
      const keytar = await import('keytar')
      await keytar.default.setPassword('geny-connector', key, value)
      return true
    } catch {
      return false
    }
  })
  ipcMain.handle('secure:delete', async (_e, key: string) => {
    try {
      const keytar = await import('keytar')
      return await keytar.default.deletePassword('geny-connector', key)
    } catch {
      return false
    }
  })
}

app.whenReady().then(() => {
  registerIpc()
  createOverlay()
  createControl()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createOverlay()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
