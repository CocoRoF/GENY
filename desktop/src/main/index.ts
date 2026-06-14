import { app, BrowserWindow, ipcMain, Menu, nativeImage, screen, shell, Tray } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { initAutoUpdate, checkForUpdatesManually } from './updater'

// Tray icon (32px), embedded so it works regardless of packaging layout.
const TRAY_ICON_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAqUlEQVR4nO2XQQ5AQAxF24kjuB07jmV23M4dWE1CUzM6aCPpX/7Q/6ZoFIFRN2wb5z/VEhGpdzK+Cs6BBO1wmhW0wylEKF34tdDi9EeZd8ABHKCpvXGeYKVeP0IrrVPVAS48578KUAqRQogA7haXQJi/hA7wL4C737lkHog7UCouHUZVj+AqpGYS+g+JA9gDcOuSlpaIaN+BRKIdnDIDNTTDAch2nKS5nu+UHjk+m3zZzgAAAABJRU5ErkJggg=='

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
    return { serverUrl: process.env.GENY_SERVER_URL || 'https://geny-x.hrletsgo.me' }
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
      preload: join(__dirname, '../preload/index.cjs'),
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

  // External links open in the OS browser, never inside the overlay.
  overlay.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // Content depends on login state: the remote transparent /overlay avatar page
  // once a token exists, otherwise a local "log in first" placeholder.
  applyOverlayContent()

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
      preload: join(__dirname, '../preload/index.cjs'),
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

// Read the account JWT the control window stored in the OS keychain.
async function getStoredToken(): Promise<string | null> {
  try {
    const keytar = await import('keytar')
    return await keytar.default.getPassword('geny-connector', 'geny_auth_token')
  } catch {
    return null
  }
}

// Point the overlay at the server's transparent /overlay avatar page when logged
// in (reusing the proven browser Live2D+TTS+WS stack), else a local placeholder.
// Called on launch and again after login/logout (overlay:refresh).
async function applyOverlayContent(): Promise<void> {
  if (!overlay) return
  const token = await getStoredToken()
  const { serverUrl } = loadConfig()
  if (token && serverUrl) {
    overlay.setIgnoreMouseEvents(false)
    const base = serverUrl.replace(/\/+$/, '')
    await overlay.loadURL(`${base}/overlay?token=${encodeURIComponent(token)}`)
    // Drag the floating avatar to reposition the OS window; keep interactive
    // elements clickable. (Pixel-accurate click-through is a later phase.)
    overlay.webContents.insertCSS(
      'html,body{-webkit-app-region:drag !important;background:transparent !important;}' +
        'canvas,button,a,input,select,textarea{-webkit-app-region:no-drag;}',
    )
  } else {
    overlay.setIgnoreMouseEvents(false)
    loadRoute(overlay, 'overlay')
  }
}

let appQuitting = false
app.on('before-quit', () => {
  appQuitting = true
})

// ── system tray: the always-available way to open settings / quit ───────────
let tray: Tray | null = null
function createTray(): void {
  const icon = nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_ICON_B64}`)
  tray = new Tray(icon)
  tray.setToolTip('Geny')
  const rebuildMenu = () => {
    const menu = Menu.buildFromTemplate([
      { label: 'Geny 설정 / 채팅 열기', click: () => showControl() },
      {
        label: overlay?.isVisible() ? '아바타 숨기기' : '아바타 보이기',
        click: () => {
          if (!overlay) return
          overlay.isVisible() ? overlay.hide() : overlay.show()
          rebuildMenu()
        },
      },
      { type: 'separator' },
      { label: '업데이트 확인', click: () => void checkForUpdatesManually() },
      { label: `버전 v${app.getVersion()}`, enabled: false },
      { type: 'separator' },
      {
        label: '종료',
        click: () => {
          appQuitting = true
          app.quit()
        },
      },
    ])
    tray?.setContextMenu(menu)
  }
  rebuildMenu()
  // Left-click the tray toggles the control window (Windows/Linux convention).
  tray.on('click', () => showControl())
}

function showControl(): void {
  if (!control) createControl()
  control?.show()
  control?.focus()
}

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

  // Re-evaluate overlay content after login/logout (token changed in keychain).
  ipcMain.on('overlay:refresh', () => {
    applyOverlayContent()
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
  createTray()

  // Phase 0: show the control window on launch so settings/login are immediately
  // visible (no more "where do I configure it?"). It hides to the tray on close.
  control?.show()

  // GitHub Releases auto-update (Windows/Linux; macOS once signed).
  initAutoUpdate()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createOverlay()
  })
})

// The overlay is always-on-top with no taskbar entry; closing the control window
// must NOT quit the app (it hides to tray). Quit is via the tray menu. So we do
// NOT auto-quit on window-all-closed except as a safety net when the tray is gone.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
