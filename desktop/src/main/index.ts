import { app, BrowserWindow, clipboard, desktopCapturer, dialog, globalShortcut, ipcMain, Menu, nativeImage, screen, session, shell, Tray } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { initAutoUpdate, checkForUpdatesManually, triggerBackgroundCheck } from './updater'

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
  /** Auto-update toggle (default true). When false, updates only notify. */
  autoUpdate?: boolean
  /** Global push-to-talk accelerator (Electron format). */
  pttHotkey?: string
  /** Allow the agent to capture the screen (Phase 4). Default true. */
  captureArmed?: boolean
  /** Allow the agent to actuate the desktop — type/click/open (Phase 6). Default false. */
  automationEnabled?: boolean
  /** Which session the floating overlay renders (chosen in the control panel). */
  overlaySession?: string
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
    // No personal default — the user enters their own Geny server on first run.
    // GENY_SERVER_URL lets a deployment pre-seed it without editing code.
    return { serverUrl: process.env.GENY_SERVER_URL || '' }
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
  control.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  applyControlContent()
  control.on('close', (e) => {
    // Hide instead of destroy so the single renderer process persists.
    if (!appQuitting) {
      e.preventDefault()
      control?.hide()
    }
  })
}

// Control window content: the server's /connector panel (session + chat +
// TTS/STT + model) once logged in, else the local login screen.
async function applyControlContent(): Promise<void> {
  if (!control) return
  const token = await getStoredToken()
  const { serverUrl, overlaySession } = loadConfig()
  if (token && serverUrl) {
    const base = serverUrl.replace(/\/+$/, '')
    const sessQ = overlaySession ? `&session=${encodeURIComponent(overlaySession)}` : ''
    await control.loadURL(`${base}/connector?token=${encodeURIComponent(token)}${sessQ}`)
  }
  // No token → the panel stays hidden; the Settings window handles login.
}

// ── settings window: server URL / account / auto-update (local, always open) ─
let settings: BrowserWindow | null = null
function createSettings(): void {
  settings = new BrowserWindow({
    width: 640,
    height: 720,
    minWidth: 560,
    minHeight: 600,
    show: false,
    title: 'Geny 설정',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  loadRoute(settings, 'settings')
  settings.on('close', (e) => {
    if (!appQuitting) {
      e.preventDefault()
      settings?.hide()
    }
  })
}
function showSettings(): void {
  if (!settings) createSettings()
  settings?.show()
  settings?.focus()
}

// Re-evaluate everything after login/logout/url-change: window content + which
// window is visible.
async function refreshAll(): Promise<void> {
  await applyOverlayContent()
  await applyControlContent()
  const token = await getStoredToken()
  if (token) {
    settings?.hide()
    control?.show()
  } else {
    control?.hide()
    showSettings()
  }
}

function loadRoute(win: BrowserWindow, route: 'overlay' | 'control' | 'settings'): void {
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
    const base = serverUrl.replace(/\/+$/, '')
    const sess = loadConfig().overlaySession
    const sessQ = sess ? `&session=${encodeURIComponent(sess)}` : ''
    await overlay.loadURL(`${base}/overlay?token=${encodeURIComponent(token)}${sessQ}`)
    overlay.webContents.insertCSS('html,body{background:transparent !important;}')
    // Locked by default: the avatar is click-through (clicks reach the desktop),
    // and only the /overlay control bar re-enables input on hover via
    // windowControl.setClickThrough. The page owns -webkit-app-region (drag).
    overlay.setIgnoreMouseEvents(true, { forward: true })
  } else {
    // Logged-out placeholder needs its dock handle clickable.
    overlay.setIgnoreMouseEvents(false)
    loadRoute(overlay, 'overlay')
  }
}

let appQuitting = false
app.on('before-quit', () => {
  appQuitting = true
})
app.on('will-quit', () => globalShortcut.unregisterAll())

// ── system tray: the always-available way to open settings / quit ───────────
let tray: Tray | null = null
function createTray(): void {
  const icon = nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_ICON_B64}`)
  tray = new Tray(icon)
  tray.setToolTip('Geny')
  const rebuildMenu = () => {
    const menu = Menu.buildFromTemplate([
      { label: '제어판 / 채팅 열기', click: () => showControl() },
      { label: '설정 열기', click: () => showSettings() },
      {
        label: overlay?.isVisible() ? '아바타 숨기기' : '아바타 보이기',
        click: () => {
          if (!overlay) return
          overlay.isVisible() ? overlay.hide() : overlay.show()
          rebuildMenu()
        },
      },
      { type: 'separator' },
      {
        label: '화면 캡처 허용 (에이전트가 화면 보기)',
        type: 'checkbox',
        checked: loadConfig().captureArmed !== false,
        click: (item) => saveConfig({ captureArmed: item.checked }),
      },
      {
        label: '데스크톱 제어 허용 (자동화 — 타이핑/클릭/앱 열기)',
        type: 'checkbox',
        checked: loadConfig().automationEnabled === true,
        click: (item) => saveConfig({ automationEnabled: item.checked }),
      },
      { type: 'separator' },
      {
        label: '자동 업데이트',
        type: 'checkbox',
        checked: loadConfig().autoUpdate !== false,
        click: (item) => {
          saveConfig({ autoUpdate: item.checked })
          if (item.checked) triggerBackgroundCheck()
        },
      },
      { label: '업데이트 확인', click: () => void checkForUpdatesManually() },
      { label: `버전 v${app.getVersion()}`, enabled: false },
      { type: 'separator' },
      { label: '로그아웃', click: () => void logout() },
      {
        label: '재시작',
        click: () => {
          appQuitting = true
          app.relaunch()
          app.quit()
        },
      },
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

// Clear the stored JWT and send both windows back to their logged-out state.
async function logout(): Promise<void> {
  try {
    const keytar = await import('keytar')
    await keytar.default.deletePassword('geny-connector', 'geny_auth_token')
  } catch {
    /* ignore */
  }
  await refreshAll() // logged out → hides panel, shows settings/login
}

// ── global push-to-talk hotkey ──────────────────────────────────────────────
const DEFAULT_PTT = 'CommandOrControl+Shift+Space'
function registerPtt(acc?: string | null): boolean {
  globalShortcut.unregisterAll()
  const hk = acc ?? loadConfig().pttHotkey ?? DEFAULT_PTT
  if (!hk) return true
  try {
    // press-only (globalShortcut has no key-up) → the overlay treats it as a
    // tap-to-toggle for the mic. Target the overlay: it owns the WS + audio.
    return globalShortcut.register(hk, () => overlay?.webContents.send('connector:ptt-toggle'))
  } catch {
    return false
  }
}

// ── Phase 6 actuation gate: master switch (default OFF) + native confirm ─────
type ActuationResult = { ok: boolean; result?: string; denied?: boolean; error?: string }
async function runActuation(label: string, detail: string, fn: () => Promise<string>): Promise<ActuationResult> {
  if (loadConfig().automationEnabled !== true) {
    return { ok: false, denied: true, error: '자동화가 꺼져 있습니다 (트레이 → 데스크톱 제어 허용)' }
  }
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    buttons: ['허용', '거부'],
    defaultId: 1,
    cancelId: 1,
    title: 'Geny 데스크톱 제어',
    message: `Geny 가 실행하려고 합니다: ${label}`,
    detail,
  })
  if (response !== 0) return { ok: false, denied: true, error: '사용자가 거부함' }
  try {
    return { ok: true, result: await fn() }
  } catch (e) {
    return { ok: false, error: String((e as Error).message) }
  }
}

// Native input synthesis (nut.js) — lazy + graceful: if the addon is missing
// on this build/platform, the import throws and runActuation reports it cleanly.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _nut: any = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadNut(): Promise<any> {
  if (_nut) return _nut
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m: any = await import('@nut-tree-fork/nut-js')
  const K = m.Key
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const keyMap: Record<string, any> = {
    ctrl: K.LeftControl, control: K.LeftControl, alt: K.LeftAlt, shift: K.LeftShift,
    cmd: K.LeftCmd, meta: K.LeftSuper, win: K.LeftSuper, super: K.LeftSuper,
    enter: K.Enter, return: K.Return, tab: K.Tab, esc: K.Escape, escape: K.Escape,
    space: K.Space, backspace: K.Backspace, delete: K.Delete, del: K.Delete,
    up: K.Up, down: K.Down, left: K.Left, right: K.Right, home: K.Home, end: K.End,
    a: K.A, b: K.B, c: K.C, d: K.D, e: K.E, f: K.F, g: K.G, h: K.H, i: K.I, j: K.J, k: K.K, l: K.L, m: K.M,
    n: K.N, o: K.O, p: K.P, q: K.Q, r: K.R, s: K.S, t: K.T, u: K.U, v: K.V, w: K.W, x: K.X, y: K.Y, z: K.Z,
    '0': K.Num0, '1': K.Num1, '2': K.Num2, '3': K.Num3, '4': K.Num4,
    '5': K.Num5, '6': K.Num6, '7': K.Num7, '8': K.Num8, '9': K.Num9,
  }
  _nut = { keyboard: m.keyboard, mouse: m.mouse, Button: m.Button, Point: m.Point, Key: K, keyMap }
  return _nut
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

  // Re-evaluate everything after login/logout (token changed in keychain).
  ipcMain.on('app:refresh', () => void refreshAll())

  // Open the settings window (from the panel's gear button or app menu).
  ipcMain.on('settings:open', () => showSettings())

  // App version (settings window "앱" tab).
  ipcMain.handle('app:version', () => app.getVersion())

  // Restart the whole connector (reloads the remote overlay/panel + native code).
  ipcMain.on('app:restart', () => {
    appQuitting = true
    app.relaunch()
    app.quit()
  })

  // Global push-to-talk hotkey config.
  ipcMain.handle('hotkey:get-ptt', () => loadConfig().pttHotkey ?? DEFAULT_PTT)
  ipcMain.handle('hotkey:set-ptt', (_e, acc: string) => {
    const ok = registerPtt(acc)
    if (ok) saveConfig({ pttHotkey: acc })
    return ok
  })

  // ── Phase 4: desktop awareness (read-only capture) ──
  ipcMain.handle('capture:list-sources', async () => {
    if (loadConfig().captureArmed === false) return [] // user paused capture
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 1, height: 1 },
    })
    return sources.map((s) => ({ id: s.id, name: s.name, display_id: s.display_id }))
  })

  // ── Phase 6: guarded actuation. Master switch (default OFF) + native confirm
  //    are the load-bearing local gate, independent of the server's decision. ──
  ipcMain.handle('actuate:open-app', (_e, target: string) =>
    runActuation('앱/링크 열기', `대상: ${target}`, async () => {
      if (/^https?:\/\//i.test(target)) await shell.openExternal(target)
      else await shell.openPath(target)
      return `opened ${target}`
    }),
  )
  ipcMain.handle('actuate:clipboard-write', (_e, text: string) =>
    runActuation('클립보드 쓰기', text.slice(0, 80), async () => {
      clipboard.writeText(text)
      return 'clipboard written'
    }),
  )
  ipcMain.handle('actuate:type', (_e, text: string) =>
    runActuation('타이핑', text.slice(0, 80), async () => {
      const nut = await loadNut()
      await nut.keyboard.type(text)
      return `typed ${text.length} chars`
    }),
  )
  ipcMain.handle('actuate:key', (_e, keys: string) =>
    runActuation('키 입력', keys, async () => {
      const nut = await loadNut()
      const parts = keys.toLowerCase().split('+').map((p) => p.trim())
      const mapped = parts.map((p) => nut.keyMap[p]).filter((k: unknown) => k !== undefined)
      if (mapped.length === 0) throw new Error(`unknown keys: ${keys}`)
      await nut.keyboard.pressKey(...mapped)
      await nut.keyboard.releaseKey(...mapped)
      return `pressed ${keys}`
    }),
  )
  ipcMain.handle('actuate:click', (_e, x: number, y: number, button?: string) =>
    runActuation('마우스 클릭', `(${x}, ${y}) ${button ?? 'left'}`, async () => {
      const nut = await loadNut()
      await nut.mouse.setPosition(new nut.Point(x, y))
      await nut.mouse.click(nut.Button[(button ?? 'left').toUpperCase() as 'LEFT' | 'RIGHT' | 'MIDDLE'])
      return `clicked (${x},${y})`
    }),
  )

  // Control panel picked a session → point the overlay at it.
  ipcMain.on('overlay:set-session', (_e, sessionId: string) => {
    saveConfig({ overlaySession: sessionId })
    applyOverlayContent()
  })

  // Auto-update toggle (default ON) + manual check.
  ipcMain.handle('updater:get-enabled', () => loadConfig().autoUpdate !== false)
  ipcMain.handle('updater:set-enabled', (_e, enabled: boolean) => {
    saveConfig({ autoUpdate: enabled })
    if (enabled) triggerBackgroundCheck() // re-enabled → check right away
    return enabled
  })
  ipcMain.on('updater:check', () => checkForUpdatesManually())

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

// Native application menu — keeps copy/paste accelerators (chat input) and
// surfaces 설정 / 업데이트 / 로그아웃 so options are always reachable.
function buildAppMenu(): void {
  const menu = Menu.buildFromTemplate([
    {
      label: 'Geny',
      submenu: [
        { label: '설정', accelerator: 'CmdOrCtrl+,', click: () => showSettings() },
        { label: '제어판 / 채팅', click: () => showControl() },
        { label: '업데이트 확인', click: () => void checkForUpdatesManually() },
        { type: 'separator' },
        { label: '재시작', click: () => { appQuitting = true; app.relaunch(); app.quit() } },
        { label: '로그아웃', click: () => void logout() },
        { role: 'quit', label: '종료' },
      ],
    },
    {
      label: '편집',
      submenu: [
        { role: 'undo', label: '실행 취소' },
        { role: 'redo', label: '다시 실행' },
        { type: 'separator' },
        { role: 'cut', label: '잘라내기' },
        { role: 'copy', label: '복사' },
        { role: 'paste', label: '붙여넣기' },
        { role: 'selectAll', label: '전체 선택' },
      ],
    },
    {
      label: '보기',
      submenu: [
        { role: 'reload', label: '새로고침' },
        { role: 'toggleDevTools', label: '개발자 도구' },
        { type: 'separator' },
        { role: 'resetZoom', label: '기본 배율' },
        { role: 'zoomIn', label: '확대' },
        { role: 'zoomOut', label: '축소' },
      ],
    },
  ])
  Menu.setApplicationMenu(menu)
}

app.whenReady().then(() => {
  // Screen-observation uses getDisplayMedia, which in Electron needs the app to
  // satisfy the display-media request (unlike a browser's built-in picker).
  // Prefer the OS picker where available; fall back to the primary screen.
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer
        .getSources({ types: ['screen', 'window'] })
        .then((sources) => callback(sources[0] ? { video: sources[0] } : {}))
        .catch(() => callback({}))
    },
    { useSystemPicker: true },
  )

  // Grant mic (STT) + screen (observation) + clipboard to our own pages.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(['media', 'display-capture', 'clipboard-read', 'clipboard-sanitized-write'].includes(permission))
  })

  registerIpc()
  buildAppMenu()
  createOverlay()
  createControl()
  createSettings()
  createTray()

  // Show the right window for the current state: logged in → the /connector
  // panel; logged out → the settings/login window. (Avatar overlay always runs.)
  void refreshAll()

  // GitHub Releases auto-update. Default ON; the toggle is read fresh on every
  // check, so changes take effect immediately.
  initAutoUpdate(() => loadConfig().autoUpdate !== false)

  // Register the global push-to-talk hotkey.
  registerPtt(loadConfig().pttHotkey ?? DEFAULT_PTT)

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
