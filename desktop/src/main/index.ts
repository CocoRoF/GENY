import { app, BrowserWindow, clipboard, desktopCapturer, dialog, globalShortcut, ipcMain, Menu, nativeImage, powerMonitor, screen, session, shell, Tray } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { initAutoUpdate, checkForUpdatesManually, triggerBackgroundCheck } from './updater'

// Tray icon (32px), embedded so it works regardless of packaging layout.
// Generated from img/Geny_Charactor_small.png (the Geny mascot).
const TRAY_ICON_B64 =
  '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'

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

// ── Windows screen-capture fix ───────────────────────────────────────────────
// The legacy desktop capturer (DXGI/GDI) renders hardware-accelerated app
// windows — Chrome, Edge, VS Code, Teams, video players, … — as BLACK,
// especially on hybrid-GPU laptops where DXGI duplication runs on a different
// adapter than the desktop and silently falls back to GDI. The agent then
// "sees" only the wallpaper + taskbar (reported: 바탕화면만 캡처됨). Forcing the
// Windows Graphics Capture (WGC) backend captures the fully-composited desktop
// — including GPU windows — on Windows 10 2004+ (build 19041) and Windows 11.
// Command-line switches must be set at module load, before app `ready`.
// (Zero-Hz WGC is intentionally NOT enabled: it suppresses frames when the
// screen is static, which would starve our on-demand single-frame grabs.)
if (process.platform === 'win32') {
  app.commandLine.appendSwitch(
    'enable-features',
    'AllowWgcScreenCapturer,AllowWgcWindowCapturer',
  )
}

let overlay: BrowserWindow | null = null
let control: BrowserWindow | null = null
let quickchat: BrowserWindow | null = null

// ── tiny JSON config (server URL, last geometry) in userData ────────────────
interface ConnectorConfig {
  serverUrl: string
  /** UI theme for the settings + chat windows. 'system' follows the OS. */
  theme?: 'system' | 'dark' | 'light'
  /** Auto-update toggle (default true). When false, updates only notify. */
  autoUpdate?: boolean
  /** Global push-to-talk accelerator (Electron format). */
  pttHotkey?: string
  /** Global quick-chat accelerator (Electron format) — pops the floating input
   *  bar that sends a message to the current VTuber (Spotlight-style). */
  quickChatHotkey?: string
  /** Last position of the draggable quick-chat bar (remembered between summons).
   *  Absent → it opens centered near the top of the active display. */
  quickChatBar?: { x: number; y: number }
  /** Allow the agent to capture the screen (Phase 4). Default true. */
  captureArmed?: boolean
  /** Allow the agent to actuate the desktop — type/click/open (Phase 6). Default false. */
  automationEnabled?: boolean
  /** Which session the floating overlay renders (chosen in the control panel). */
  overlaySession?: string
  overlay?: WinBounds & { displayId?: number }
  /** Remembered window geometry (position + size) — restored across restarts,
   *  multi-monitor aware (see restoreWinBounds). */
  control?: WinBounds
  settings?: WinBounds
  /** Avatar capability tuning (set in the 음성/앱 settings tabs, applied live to
   *  the overlay's TTS/STT/screen drivers via the config:changed broadcast). */
  overlayTuning?: OverlayTuning
}
interface WinBounds { x: number; y: number; width: number; height: number }
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

// ── window geometry persistence (multi-monitor aware) ───────────────────────
// Resolve saved bounds onto a CONNECTED display. getDisplayMatching returns the
// display the saved rect overlaps most (else the nearest), so a window saved on a
// secondary monitor restores THERE — not snapped back to the primary — and a
// window whose monitor was unplugged lands visibly on the nearest one instead of
// off-screen. The rect is clamped to fit that display's work area.
function restoreWinBounds(saved: WinBounds | undefined, defaults: WinBounds): WinBounds {
  if (!saved || ![saved.x, saved.y, saved.width, saved.height].every(Number.isFinite)) return defaults
  const wa = screen.getDisplayMatching(saved).workArea
  const width = Math.max(200, Math.min(Math.round(saved.width), wa.width))
  const height = Math.max(150, Math.min(Math.round(saved.height), wa.height))
  const x = Math.round(Math.min(Math.max(saved.x, wa.x), wa.x + wa.width - width))
  const y = Math.round(Math.min(Math.max(saved.y, wa.y), wa.y + wa.height - height))
  return { x, y, width, height }
}

// Persist a window's geometry on move/resize (debounced). Skips minimized /
// maximized / fullscreen states — those aren't the geometry we want to restore.
function attachBoundsPersistence(win: BrowserWindow, key: 'overlay' | 'control' | 'settings'): void {
  let timer: ReturnType<typeof setTimeout> | null = null
  const save = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      if (win.isDestroyed() || win.isMinimized() || win.isMaximized() || win.isFullScreen()) return
      const b = win.getBounds()
      saveConfig({ [key]: { x: b.x, y: b.y, width: b.width, height: b.height } } as Partial<ConnectorConfig>)
    }, 400)
  }
  win.on('moved', save)
  win.on('resized', save)
  win.on('closed', () => { if (timer) clearTimeout(timer) })
}

// Any overlap with a work area = still (at least partly) visible.
function isVisibleOnSomeDisplay(b: WinBounds): boolean {
  return screen.getAllDisplays().some((d) => {
    const wa = d.workArea
    const ix = Math.min(b.x + b.width, wa.x + wa.width) - Math.max(b.x, wa.x)
    const iy = Math.min(b.y + b.height, wa.y + wa.height) - Math.max(b.y, wa.y)
    return ix > 0 && iy > 0
  })
}

// When a monitor is unplugged / rearranged, a window that was on it can end up
// entirely off-screen (invisible, "lost"). Pull only those windows back onto the
// nearest display — leave still-visible windows exactly where the user put them.
function ensureWindowsOnScreen(): void {
  for (const win of [overlay, control, settings, quickchat]) {
    if (!win || win.isDestroyed()) continue
    const b = win.getBounds()
    if (isVisibleOnSomeDisplay(b)) continue
    win.setBounds(restoreWinBounds(b, b))
  }
}

// ── overlay window: the floating avatar ─────────────────────────────────────
function createOverlay(): void {
  const wa = screen.getPrimaryDisplay().workArea
  const defW = 420
  const defH = Math.round(wa.height * 0.45)
  // Restore the remembered geometry onto whichever monitor it was on (multi-
  // monitor aware); default to the bottom-right of the primary work area.
  const b = restoreWinBounds(loadConfig().overlay, {
    width: defW,
    height: defH,
    x: wa.x + wa.width - defW - 24,
    y: wa.y + wa.height - defH,
  })

  overlay = new BrowserWindow({
    width: b.width,
    height: b.height,
    x: b.x,
    y: b.y,
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
  attachContentResilience(overlay, () => void applyOverlayContent())
  attachBoundsPersistence(overlay, 'overlay')
  applyOverlayContent()

  overlay.on('closed', () => {
    overlay = null
  })
}

// ── control window: chat / settings / login (hidden until toggled) ──────────
function createControl(): void {
  const wa = screen.getPrimaryDisplay().workArea
  const b = restoreWinBounds(loadConfig().control, {
    width: 640, height: 760,
    x: Math.round(wa.x + (wa.width - 640) / 2),
    y: Math.round(wa.y + (wa.height - 760) / 2),
  })
  control = new BrowserWindow({
    width: b.width,
    height: b.height,
    x: b.x,
    y: b.y,
    minWidth: 460,
    minHeight: 560,
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
  attachContentResilience(control, () => void applyControlContent())
  attachBoundsPersistence(control, 'control')
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
  const { serverUrl, overlaySession, theme } = loadConfig()
  if (token && serverUrl) {
    const base = serverUrl.replace(/\/+$/, '')
    const sessQ = overlaySession ? `&session=${encodeURIComponent(overlaySession)}` : ''
    const themeQ = `&theme=${encodeURIComponent(theme || 'system')}`
    // Swallow the rejection — a failed load is recovered by the did-fail-load
    // resilience handler (attachContentResilience), which retries with backoff.
    await control.loadURL(`${base}/connector?token=${encodeURIComponent(token)}${sessQ}${themeQ}`).catch(() => undefined)
  }
  // No token → the panel stays hidden; the Settings window handles login.
}

// ── settings window: server URL / account / auto-update (local, always open) ─
let settings: BrowserWindow | null = null
function createSettings(): void {
  const wa = screen.getPrimaryDisplay().workArea
  const b = restoreWinBounds(loadConfig().settings, {
    width: 640, height: 720,
    x: Math.round(wa.x + (wa.width - 640) / 2),
    y: Math.round(wa.y + (wa.height - 720) / 2),
  })
  settings = new BrowserWindow({
    width: b.width,
    height: b.height,
    x: b.x,
    y: b.y,
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
  attachContentResilience(settings, () => settings && loadRoute(settings, 'settings'))
  attachBoundsPersistence(settings, 'settings')
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

// ── quick-chat window: Spotlight-style floating input ───────────────────────
// A small, frameless, transparent, always-on-top input bar summoned by a global
// hotkey from anywhere. Typing + Enter sends the message to the CURRENT VTuber
// (the overlaySession) by relaying it to the already-loaded /connector chat —
// reusing its proven send/auth/TTS pipeline (no duplicate transport).
const QUICKCHAT_W = 640
const QUICKCHAT_H = 188
// When the bar was last summoned — used to swallow the spurious `blur` that a
// focused full-screen game fires immediately after we show (so the bar doesn't
// vanish before the user can type).
let quickChatShownAt = 0
// The bar is a PERMANENTLY-shown top-most window (like the avatar overlay) — we
// only toggle its visibility via opacity + click-through, never hide()/show().
// This is the load-bearing fix for surfacing over a borderless full-screen game:
// re-showing a hidden window won't place it above a game that's already full-
// screen, but a window that claimed the top band BEFORE the game did stays above
// it. `quickChatOpen` tracks the summoned/dismissed state (isVisible() is always
// true now).
let quickChatOpen = false
function createQuickChat(): void {
  quickchat = new BrowserWindow({
    width: QUICKCHAT_W,
    height: QUICKCHAT_H,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // Match the avatar overlay exactly (it surfaces over Skyrim): keep the
      // renderer ticking even while unfocused/occluded.
      backgroundThrottling: false,
    },
  })
  // Float above full-screen apps — mirror the avatar overlay's proven recipe
  // (it surfaces over borderless / windowed-fullscreen games): the 'screen-saver'
  // top band, and visibleOnFullScreen ONLY on macOS. On Windows that call is a
  // macOS-only feature that misbehaves, so it's guarded like the overlay.
  quickchat.setAlwaysOnTop(true, 'screen-saver')
  if (process.platform === 'darwin') {
    quickchat.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  }
  attachContentResilience(quickchat, () => quickchat && loadRoute(quickchat, 'quickchat'))
  loadRoute(quickchat, 'quickchat')
  // Dismiss on focus loss (click elsewhere) — Spotlight behaviour. But ignore the
  // spurious blur a focused full-screen game fires right after we show (we may
  // not win focus on the first frame); real click-away dismissal still works
  // once the short grace window elapses.
  quickchat.on('blur', () => {
    if (!quickChatOpen) return
    if (Date.now() - quickChatShownAt < 450) return
    dismissQuickChat()
  })
  // Remember where the user drags the bar. 'move' streams during the drag
  // (Win/Linux) and 'moved' lands once it settles (macOS); debounce both so we
  // persist the final spot without hammering the config file mid-drag.
  quickchat.on('move', persistQuickChatPos)
  quickchat.on('moved', persistQuickChatPos)
  quickchat.on('close', (e) => {
    if (!appQuitting) {
      e.preventDefault()
      dismissQuickChat()
    }
  })
  // Establish the window ON-SCREEN, shown, top-most and click-through at launch —
  // exactly like the avatar overlay (which surfaces over borderless full-screen
  // games). It claims the 'screen-saver' top band BEFORE any game goes full-screen
  // and then stays put; the renderer paints nothing until summoned. showInactive()
  // so we don't steal focus from whatever the user is doing at launch.
  positionQuickChat()
  quickchat.setIgnoreMouseEvents(true, { forward: true })
  quickchat.showInactive()
}

// Hide the bar WITHOUT touching the window: the window stays shown, on-screen and
// top-most (so it keeps its z-order above a full-screen game); the RENDERER just
// stops painting the card, and we make the window click-through. This mirrors the
// avatar overlay exactly — a persistent transparent top-most window whose content
// is what appears/disappears, never the window itself. (Hiding / moving off-screen
// / opacity all failed to layer above a game that went full-screen after launch.)
function dismissQuickChat(): void {
  if (!quickchat) return
  quickChatOpen = false
  quickchat.setIgnoreMouseEvents(true, { forward: true })
  quickchat.webContents.send('quickchat:dismissed')
}

let quickChatPosTimer: ReturnType<typeof setTimeout> | null = null
let suppressQuickChatPosSave = false
function persistQuickChatPos(): void {
  // Ignore the programmatic setBounds in positionQuickChat — only user drags.
  if (suppressQuickChatPosSave) return
  if (quickChatPosTimer) clearTimeout(quickChatPosTimer)
  quickChatPosTimer = setTimeout(() => {
    if (!quickchat || !quickChatOpen) return
    const b = quickchat.getBounds()
    saveConfig({ quickChatBar: { x: b.x, y: b.y } })
  }, 350)
}

// Place the bar: restore the user's remembered spot (clamped onto a visible
// display in case monitors changed), else center it near the top of the display
// under the cursor (classic launcher placement).
function positionQuickChat(): void {
  if (!quickchat) return
  suppressQuickChatPosSave = true
  const saved = loadConfig().quickChatBar
  if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    // Multi-monitor aware: restore onto whichever display the bar was on, clamped
    // to fit (guards a closed/moved monitor). Size is fixed (QUICKCHAT_W/H).
    const rect = { x: saved.x, y: saved.y, width: QUICKCHAT_W, height: QUICKCHAT_H }
    const b = restoreWinBounds(rect, rect)
    quickchat.setBounds({ x: b.x, y: b.y, width: QUICKCHAT_W, height: QUICKCHAT_H })
  } else {
    const pt = screen.getCursorScreenPoint()
    const wa = screen.getDisplayNearestPoint(pt).workArea
    const x = Math.round(wa.x + (wa.width - QUICKCHAT_W) / 2)
    const y = Math.round(wa.y + wa.height * 0.22)
    quickchat.setBounds({ x, y, width: QUICKCHAT_W, height: QUICKCHAT_H })
  }
  // Re-arm persistence after the programmatic move settles.
  setTimeout(() => { suppressQuickChatPosSave = false }, 120)
}

// Summon the bar: the window is ALREADY shown + top-most on-screen, so we only
// re-assert the top band, make it interactive, raise + focus it, and tell the
// renderer to paint the card. No hide()/show(), no move, no opacity — the window
// claimed the top band at launch (before any game went full-screen) and never
// left, exactly like the avatar overlay, so it stays above the game. Focus works
// because we're triggered by a global hotkey (user input). (True EXCLUSIVE-
// fullscreen DirectX bypasses the compositor and needs injection; borderless /
// windowed-fullscreen works.)
function showQuickChatOnTop(): void {
  if (!quickchat) return
  quickChatOpen = true
  quickChatShownAt = Date.now()
  quickchat.setAlwaysOnTop(true, 'screen-saver')
  if (process.platform === 'darwin') {
    quickchat.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  }
  quickchat.setIgnoreMouseEvents(false)
  quickchat.moveTop()
  // Paint the bar FIRST so it's visible immediately (grabbing OS focus up-front
  // makes a borderless game reclaim the foreground and repaint over us — that's
  // what kept the bar from showing in earlier builds).
  quickchat.webContents.send('quickchat:opened')
  // THEN, a tick later, take keyboard focus so the user can type without clicking,
  // and re-raise right after in case the focus transfer let the game repaint for a
  // frame. The bar is already established/visible by now, so this no longer hides
  // it. The renderer re-focuses its input on the window 'focus' event.
  setTimeout(() => {
    if (!quickchat || !quickChatOpen) return
    quickchat.focus()
    quickchat.moveTop()
  }, 110)
}

async function toggleQuickChat(): Promise<void> {
  if (!quickchat) createQuickChat()
  if (quickChatOpen) {
    dismissQuickChat()
    return
  }
  // Logged-out → there's no VTuber to message; route the user to login instead.
  const token = await getStoredToken()
  if (!token || !loadConfig().serverUrl) {
    showSettings()
    return
  }
  positionQuickChat()
  showQuickChatOnTop()
}

// Relay a quick-chat message to the current VTuber via the /connector page's
// existing chat send. Returns whether it was delivered (false → not logged in /
// panel not ready, so the bar can surface a hint).
async function deliverQuickChat(text: string): Promise<{ ok: boolean; error?: string }> {
  const body = (text ?? '').trim()
  if (!body) return { ok: false, error: '빈 메시지' }
  const token = await getStoredToken()
  if (!token || !loadConfig().serverUrl) return { ok: false, error: '로그인이 필요합니다' }
  if (!control) createControl()
  // Make sure the /connector chat page is loaded (it mounts the listener that
  // relays the message into the chat). Normally it's already up from startup.
  let justLoaded = false
  if (!control!.webContents.getURL().includes('/connector')) {
    await applyControlContent()
    justLoaded = true
  }
  // If we had to (re)load, give React a beat to mount its onQuickSend listener
  // before the event arrives (an early send would be dropped).
  if (justLoaded) await new Promise((r) => setTimeout(r, 450))
  control!.webContents.send('connector:quick-send', body)
  return { ok: true }
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

function loadRoute(win: BrowserWindow, route: 'overlay' | 'control' | 'settings' | 'quickchat'): void {
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

// ── Self-healing window content ─────────────────────────────────────────────
// A window must NEVER be left dead requiring a manual app restart. This recovers
// a window's content from the two ways it can break without us noticing:
//   • did-fail-load — the server/page was unreachable (server restart, network
//     blip, sleep/wake, the brief window right after an auto-update relaunch).
//     Retry `reload` with capped exponential backoff until it loads (a transient
//     outage self-heals the moment the server returns — no restart needed).
//   • render-process-gone — the renderer crashed / was OOM-killed. Rebuild it.
// `reload` rebuilds the RIGHT content (applyOverlayContent / applyControlContent
// re-evaluate login state; loadRoute reloads a local route).
function attachContentResilience(win: BrowserWindow, reload: () => void): void {
  const wc = win.webContents
  let retries = 0
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  const clearRetry = () => {
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null }
  }
  wc.on('did-finish-load', () => { retries = 0; clearRetry() })
  wc.on('did-fail-load', (_e, errorCode, errorDesc, _url, isMainFrame) => {
    if (!isMainFrame) return        // ignore subresource failures
    if (errorCode === -3) return    // ERR_ABORTED — a superseding navigation, not a failure
    clearRetry()
    const delay = Math.min(2000 * Math.pow(1.6, retries), 20000) // 2s → cap 20s
    retries = Math.min(retries + 1, 10)
    console.warn(`[connector] content load failed (${errorCode} ${errorDesc}); retry in ${Math.round(delay)}ms`)
    retryTimer = setTimeout(() => { if (!win.isDestroyed()) reload() }, delay)
  })
  wc.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit') return
    console.warn(`[connector] renderer gone (${details.reason}); reloading`)
    clearRetry()
    retries = 0
    if (!win.isDestroyed()) reload()
  })
  wc.on('destroyed', clearRetry)
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
async function storeToken(token: string): Promise<void> {
  try {
    const keytar = await import('keytar')
    await keytar.default.setPassword('geny-connector', 'geny_auth_token', token)
  } catch {
    /* keychain unavailable — ignore */
  }
}
async function clearStoredToken(): Promise<void> {
  try {
    const keytar = await import('keytar')
    await keytar.default.deletePassword('geny-connector', 'geny_auth_token')
  } catch {
    /* ignore */
  }
}

// Keep the connector logged in across restarts. The stored JWT is reused on
// every launch; this validates it and — crucially — mints a FRESH-expiry token
// (so the clock resets each launch and a regularly-used connector never logs
// out). /api/auth/refresh requires a still-valid token, so:
//   • 200 → token was valid; persist the new one (extended expiry).
//   • 401 → token genuinely expired/revoked; drop it so the UI shows a clean
//           "login needed" instead of the confusing "saved but not working".
//   • network/other → keep the token (don't nuke a good token over a blip).
// Returns true if we end up with a usable token.
async function validateAndRefreshAuth(): Promise<boolean> {
  const token = await getStoredToken()
  const { serverUrl } = loadConfig()
  if (!token || !serverUrl) return false
  const base = serverUrl.replace(/\/+$/, '')
  try {
    const r = await fetch(`${base}/api/auth/refresh`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    })
    if (r.ok) {
      const j = await r.json().catch(() => null)
      if (j?.access_token) await storeToken(j.access_token)
      return true
    }
    if (r.status === 401 || r.status === 403) {
      await clearStoredToken()
      return false
    }
    return true // transient server error — assume still logged in
  } catch {
    return true // offline / unreachable — keep the token, retry later
  }
}

let authRefreshTimer: ReturnType<typeof setInterval> | null = null

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
    // Locked by default: the avatar is click-through (clicks reach the desktop),
    // and only the /overlay control bar re-enables input on hover via
    // windowControl.setClickThrough. The page owns -webkit-app-region (drag).
    overlay.setIgnoreMouseEvents(true, { forward: true })
    try {
      await overlay.loadURL(`${base}/overlay?token=${encodeURIComponent(token)}${sessQ}`)
      overlay.webContents.insertCSS('html,body{background:transparent !important;}')
    } catch {
      // Load failed (server/network) — attachContentResilience retries with backoff.
    }
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
app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  if (authRefreshTimer) clearInterval(authRefreshTimer)
})

// ── system tray: the always-available way to open settings / quit ───────────
let tray: Tray | null = null
function createTray(): void {
  const icon = nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_ICON_B64}`)
  tray = new Tray(icon)
  tray.setToolTip('Geny')
  const rebuildMenu = () => {
    const menu = Menu.buildFromTemplate([
      { label: '제어판 / 채팅 열기', click: () => showControl() },
      { label: '빠른 채팅 (VTuber에게 보내기)', click: () => void toggleQuickChat() },
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

// ── global hotkeys (push-to-talk + quick-chat) ──────────────────────────────
const DEFAULT_PTT = 'CommandOrControl+Shift+Space'
// A deliberately uncommon default (rarely claimed system-wide) yet mnemonic —
// Enter = "send". Reconfigurable in the settings window.
const DEFAULT_QUICKCHAT = 'CommandOrControl+Shift+Enter'

// Both global accelerators are (re)registered together: globalShortcut has no
// race-free per-accelerator rebind, so we unregister all and re-add each from
// the current config. Returns which ones actually bound (false → conflict).
function registerHotkeys(): { ptt: boolean; quickChat: boolean } {
  globalShortcut.unregisterAll()
  const cfg = loadConfig()
  const result = { ptt: true, quickChat: true }

  const ptt = cfg.pttHotkey ?? DEFAULT_PTT
  if (ptt) {
    try {
      // press-only (globalShortcut has no key-up) → the overlay treats it as a
      // tap-to-toggle for the mic. Target the overlay: it owns the WS + audio.
      result.ptt = globalShortcut.register(ptt, () =>
        overlay?.webContents.send('connector:ptt-toggle'),
      )
    } catch {
      result.ptt = false
    }
  }

  const qc = cfg.quickChatHotkey ?? DEFAULT_QUICKCHAT
  if (qc) {
    try {
      result.quickChat = globalShortcut.register(qc, () => void toggleQuickChat())
    } catch {
      result.quickChat = false
    }
  }
  return result
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
  ipcMain.handle('config:set', (_e, patch: Partial<ConnectorConfig>) => {
    const next = saveConfig(patch)
    // Push the merged config to the avatar overlay so its capability drivers
    // (TTS/STT/screen) apply overlayTuning changes live — no reload.
    overlay?.webContents.send('config:changed', next)
    return next
  })

  // Click-through toggle from the renderer's hit-test loop.
  ipcMain.on('overlay:set-ignore-mouse', (_e, ignore: boolean) => {
    overlay?.setIgnoreMouseEvents(ignore, { forward: true })
  })

  // Move the overlay by a delta (dock-handle drag). Use setPosition — NOT
  // setBounds — so we only change x/y and never re-send width/height. On
  // Windows multi-DPI, round-tripping the size through getBounds()/setBounds()
  // while dragging across (or along) monitors with different scale factors
  // drifts the size via DIP↔physical rounding, so the window (and the avatar
  // fit to it) slowly GROWS with every move. setPosition leaves the size alone.
  ipcMain.on('overlay:move-by', (_e, dx: number, dy: number) => {
    if (!overlay) return
    const [x, y] = overlay.getPosition()
    overlay.setPosition(Math.round(x + dx), Math.round(y + dy))
  })

  ipcMain.on('control:toggle', () => {
    if (!control) return
    control.isVisible() ? control.hide() : control.show()
  })

  // Always show + focus the control window (never hides). The overlay's
  // chat/options buttons use this; the desired view (chat|settings) is
  // signalled via same-origin localStorage so the panel switches tabs.
  ipcMain.on('control:open', () => {
    if (!control) createControl()
    control?.show()
    control?.focus()
  })

  // Re-evaluate everything after login/logout (token changed in keychain).
  ipcMain.on('app:refresh', () => void refreshAll())

  // Open the settings window (from the panel's gear button or app menu).
  ipcMain.on('settings:open', () => showSettings())

  // App version (settings window "앱" tab).
  ipcMain.handle('app:version', () => app.getVersion())

  // Open a URL in the user's default browser (e.g. "Geny 서버 열기").
  ipcMain.on('app:open-external', (_e, url: string) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url)
  })

  // Reload ONLY the chat/control panel (e.g. after a theme change) — leaves the
  // avatar overlay untouched so it doesn't flicker.
  ipcMain.on('app:reload-control', () => { void applyControlContent() })

  // Restart the whole connector (reloads the remote overlay/panel + native code).
  ipcMain.on('app:restart', () => {
    appQuitting = true
    app.relaunch()
    app.quit()
  })

  // Global push-to-talk hotkey config. Persist the candidate, re-bind both
  // hotkeys, and roll back if it failed to register (conflict with another app).
  ipcMain.handle('hotkey:get-ptt', () => loadConfig().pttHotkey ?? DEFAULT_PTT)
  ipcMain.handle('hotkey:set-ptt', (_e, acc: string) => {
    const prev = loadConfig().pttHotkey
    saveConfig({ pttHotkey: acc })
    const ok = registerHotkeys().ptt
    if (!ok) {
      saveConfig({ pttHotkey: prev ?? DEFAULT_PTT })
      registerHotkeys()
    }
    return ok
  })

  // Global quick-chat hotkey config (same rollback contract as PTT).
  ipcMain.handle('hotkey:get-quickchat', () => loadConfig().quickChatHotkey ?? DEFAULT_QUICKCHAT)
  ipcMain.handle('hotkey:set-quickchat', (_e, acc: string) => {
    const prev = loadConfig().quickChatHotkey
    saveConfig({ quickChatHotkey: acc })
    const ok = registerHotkeys().quickChat
    if (!ok) {
      saveConfig({ quickChatHotkey: prev ?? DEFAULT_QUICKCHAT })
      registerHotkeys()
    }
    return ok
  })

  // While a settings field is RECORDING a new hotkey, suspend the global
  // shortcuts so an already-registered combo (e.g. the current PTT key) isn't
  // swallowed system-wide and can be re-captured by the renderer's keydown.
  ipcMain.on('hotkey:pause', () => globalShortcut.unregisterAll())
  ipcMain.on('hotkey:resume', () => registerHotkeys())

  // Quick-chat bar → send to the current VTuber, then close. Returns {ok,error}
  // so the bar can show a brief result (전송됨 / 로그인 필요).
  ipcMain.handle('quickchat:submit', async (_e, text: string) => {
    const r = await deliverQuickChat(text)
    if (r.ok) dismissQuickChat()
    return r
  })
  // Esc / cancel from the bar.
  ipcMain.on('quickchat:close', () => dismissQuickChat())

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
  createQuickChat()
  createTray()

  // Re-establish the session BEFORE deciding which window to show: validate the
  // stored JWT and mint a fresh-expiry one (or drop it if truly dead), so a
  // restart re-logs-in cleanly instead of showing "saved but not working". Then
  // show the right window: logged in → the /connector panel; logged out → the
  // settings/login window. (The avatar overlay always runs.)
  void (async () => {
    await validateAndRefreshAuth()
    await refreshAll()
  })()

  // Keep a long-running connector authenticated: re-mint the token well within
  // its lifetime so it never silently expires mid-session, and fall back to the
  // login window if it ever becomes invalid.
  authRefreshTimer = setInterval(() => {
    void validateAndRefreshAuth().then((ok) => { if (!ok) void refreshAll() })
  }, 12 * 60 * 60 * 1000)

  // GitHub Releases auto-update. Default ON; the toggle is read fresh on every
  // check, so changes take effect immediately.
  initAutoUpdate(() => loadConfig().autoUpdate !== false)

  // Register the global hotkeys (push-to-talk + quick-chat).
  registerHotkeys()

  // After the machine wakes from sleep, the loaded pages' WS / network state can
  // be stale (the avatar freezes, chat stops) and previously needed an app
  // restart. Reload the remote pages so they reconnect cleanly. Debounced — some
  // platforms fire resume more than once.
  let resumeTimer: ReturnType<typeof setTimeout> | null = null
  powerMonitor.on('resume', () => {
    if (resumeTimer) clearTimeout(resumeTimer)
    resumeTimer = setTimeout(() => {
      void applyOverlayContent()
      void applyControlContent()
    }, 1500)
  })

  // Monitor plug/unplug/rearrange → rescue any window that ended up off-screen
  // (so windows are never lost on the disconnected monitor). Debounced.
  let displayTimer: ReturnType<typeof setTimeout> | null = null
  const onDisplayChange = () => {
    if (displayTimer) clearTimeout(displayTimer)
    displayTimer = setTimeout(ensureWindowsOnScreen, 600)
  }
  screen.on('display-removed', onDisplayChange)
  screen.on('display-added', onDisplayChange)
  screen.on('display-metrics-changed', onDisplayChange)

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
