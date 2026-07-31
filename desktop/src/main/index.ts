import { app, BrowserWindow, clipboard, desktopCapturer, dialog, globalShortcut, ipcMain, Menu, nativeImage, powerMonitor, screen, session, shell, Tray } from 'electron'
import { join, sep } from 'path'
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs'
import { initAutoUpdate, checkForUpdatesManually, triggerBackgroundCheck } from './updater'
import { getMcpManager, type MCPServerConfig } from './mcp-manager'
import { getSyncManager, initSyncManager, type SyncPairConfig } from './sync-manager'
import { randomUUID } from 'crypto'
import { browserCall, getBrowserControl } from './browser-control'
import { getWinAutoHost, disposeWinAutoHost } from './winauto-host'

// Tray icon (32px), embedded so it works regardless of packaging layout.
// Generated from img/Geny_Charactor_small.png (the Geny mascot).
const TRAY_ICON_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAG8UlEQVR4nL1Xe1BU1xn/zrl37967D3aX3UV2EQQWRF5RgZhCUlmmZLQ+gpZiO9VOg1Zt0qk6k3Y6Y2eyS8dpm5l2BifTpGlMqNNM0rhSi1Od6KiAiKAIGiK6vJQ3K49l2WXZ191z+ofS9o+yC9T299eZe8853+985/t+5/sA/itQBBaKAQDAQvE/x/8XVFBmYZh/6APJSrdBK5hPASgCQDT/g/Oyx46iXL/L/aoqjY9XZAd+32tOefg/IvDUKADFgBCBw8NHeModDQRJKp2Y9IFByWo369tjGfFo715128KiaLsu484QzX3j1xpKzRj/2P4m7us/6b/0eeob9DfilcON/M6kYTJzdTrO+2B4vPKzS1t3f3ihFACAUhrxkGxUuxYLhgdWVFb0l0RVvKGsvG5rJ9gf/5TcbyO6BEac1uawvxwqEZ1JakliusBIYzRbZu3d/ZR6R4FShBCK6IUlX8Frp04pY+UJG1p7dSn2uoGPtDEBFI5fi1yBWASpOuCS5VS/lsXpGoDeYd8XRbpHb8XHZ/e/mw5BiEAiCgGKoGZAijvRITI6dQPOFHTAgb5KtrfnY5XCH5ge90lYnRYkchUE00woLkdGJN5giE3V8AplqKbzFW5/BaWMDaHw8gkU17PQWCLCvo4DoNC+B5VJa+QOoPOn71xB965kETEQRopYhvoJgGY1QIwaICaGvrjdQHw+ih/Pyp5sLyM7z6yP6wBK0WJeiB4DSn6GDYY49KH9jnfEiWXiE4Ou/OWwc8gF80Oz1FhegNbmqCFOkIBpDQ/JSXJ8q208bL9MjPfH9FsAoAMagAEAcXkEGkvCABTBJrgoPJmoo098W0MMJw2ODIouZxLRaQVOUHJ0o6wnrHdSXFq5DeSsBK5fbaeuMQJm9ayzIkVz7jAAWBqAVC1iJpIHKFBAYG0QPVzOSdDqvWwyyRS9ebnFXBdXytRea2C/V/STF77Ou2Kw6Bjy44BCpBsCHNKP9XKZik8/N3VKtgKA3QxmXAVA/pORyDqAEK3IBt6y/tbDYv7qUaxkWyE9awok6M9lxq96sqQN79cYjB1fZcQzs3KBDIUYPFGYy6D16e/MdXfdb+8YuQgAYLY2riAIAWAheL5/uilJUAqSP57lnIXF/rQNG40q9fBd9c3OHX+7/uW1P8SlrDqgSNSFtHoy59Ipf7TT4Bp8RFaTc3mojUbRgiXrwJHmvhy1jGb6KV8+SeQmRHxtTT2xgdCM95ju/Hsh/EohrsyfoKF4072mcPZnmezU9vZbN7994c29MyvOAgul+IHNhhKMBTtYKVdKeWHQ5WcZRhLa/cnGhJGCWvfPFfla8rXMXcTY/C6TMR6idv26Ajkv5CAqaVGm5QkAMGOxWlHVIu/C4h54puE/a+1PCyFmR4iPSeRo6KGbcltqb7HDrm7GrQ5Pl2dt1mXpkgWi9/kQN2KnKRmyYAfKEHgy+4s/Fah/FU2IFg1CixUQIEQ9/qA0yPB5DMd5A0jyTbUUpR8sVR7btVP2dpxKmv3Y1kFbLg2iriAHo6pVcPbUbXyzXyTN3XgKAMBmjXzNkX4ioBT219UplCmFljDicqUCpxc9cyMG6rqrWaXb62cU2vbbHmXTpx0wMTGFvE6/COokDtLijoN7rhqgMAi2xU8fjQBY6utZhz9+tRDLygNszPEgwxq8flbOIirIZDITRxHHCCxMjgbR+U9GEBuvCQWIQuoLOH7429cdl89eFqda3yryRbIRMQirSkpEABgorqnns17Kr533wg9EIpS4/Cx4RueJm+VgbCwMeQmUGjbFweQjEYfZIDEkhn2esxdGW8EaaXsAWEJBYrFYcOPr5oCj+u0W6p6LeThCJ+9cd83f+esoeC48oLwYgKY2AhwH4PIhnLVGgr/7on/fDalOA1WYQJSCZMk6UFZTr9almta23JN8o/uRUMVMOSA4MYN5o5r6NQmsJoEJFySw6OUM593BQfuxmm+V3IgmQssisFCPJr0zeWlogH0V5pzBWJZI07PVsHoNHs3LUegR9oyde796R1v1ia5I4vPviP4cP0Ox5RprBjNpMs56JmaVKD2V4sxMhVMjHz+RtAp2eRAW712/eaSt+kRXtNxfEQEzmInVCvTgRXRc+8K8aU6hWX+mxXvyd/tGr/S5TWJg+Mv7Xxx8rf6Z25dkHGAZVXFVFSJ7bDZ8aruqZ9M2z95hNyBewC8NzOLB0LTjHL8ubzNCCKzL7DWW1UrZ9uwJV5yhzO0hZ1+yynPatE7YVtubN9jNZ/x9ygcOSshyG51ld0YLaygGgN3NMxvH5vginUws4ZnwIVuhaubpjOjB9xzwr/ze1Tyx/zstM8lPP0fO++cKi4XitJM9UliZJ58zVnjyfwCpDwefILK43gAAAABJRU5ErkJggg=='

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
  /** UI language for the settings window + native chrome (tray/menu/dialogs).
   *  Unset → resolved from the OS locale (see resolvedLang). */
  lang?: 'ko' | 'en'
  /** Auto-update toggle (default true). When false, updates only notify. */
  autoUpdate?: boolean
  /** Launch the connector automatically when the user logs into the OS
   *  (default false). Applied via app.setLoginItemSettings on win/mac and a
   *  ~/.config/autostart .desktop file on Linux. */
  autoLaunch?: boolean
  /** Global push-to-talk accelerator (Electron format). */
  pttHotkey?: string
  /** Global quick-chat accelerator (Electron format) — pops the floating input
   *  bar that sends a message to the current VTuber (Spotlight-style). */
  quickChatHotkey?: string
  /** Last position of the draggable quick-chat bar (remembered between summons).
   *  Absent → it opens centered near the top of the active display. */
  quickChatBar?: { x: number; y: number }
  /** Allow the agent to capture the screen (Phase 4). Default true.
   *  Legacy — superseded by computerUse.screen when computerUse is present. */
  captureArmed?: boolean
  /** Allow the agent to actuate the desktop — type/click/open (Phase 6). Default false.
   *  Legacy — superseded by computerUse.{input,apps,clipboard} when present. */
  automationEnabled?: boolean
  /** Local Computer Use — per-capability consent (local bridge Phase 1). When
   *  present it supersedes the legacy captureArmed/automationEnabled toggles;
   *  when absent those remain the fallback so existing installs keep working. */
  computerUse?: ComputerUseConfig
  /** Which session the floating overlay renders (chosen in the control panel). */
  overlaySession?: string
  overlay?: WinBounds & { displayId?: number }
  /** Avatar overlay geometry remembered PER MONITOR (key = display signature).
   *  Each monitor keeps its own position + size, so moving the avatar between a
   *  150% and a 100% screen restores that screen's chosen size instead of the
   *  DPI-rescaled one. */
  overlayByDisplay?: Record<string, WinBounds>
  /** Remembered window geometry (position + size) — restored across restarts,
   *  multi-monitor aware (see restoreWinBounds). */
  control?: WinBounds
  settings?: WinBounds
  /** Avatar capability tuning (set in the 음성/앱 settings tabs, applied live to
   *  the overlay's TTS/STT/screen drivers via the config:changed broadcast). */
  overlayTuning?: OverlayTuning
  /** Local MCP servers the connector hosts + proxies to the Geny agent
   *  (local bridge Phase 3). Configured in settings → MCP. */
  mcpServers?: MCPServerConfig[]
  /** Local MCP master switch — off hides every server from the agent without
   *  deleting the configs. Default true. */
  mcpEnabled?: boolean
  /** Workspace sync pairings: agent session ↔ local folder (Drive-style
   *  bidirectional replication). Managed in settings → Workspace. */
  syncPairs?: SyncPairConfig[]
  /** Stable replica identity for the sync protocol — generated once. */
  deviceId?: string
}
interface WinBounds { x: number; y: number; width: number; height: number }
/** Consent posture for an actuation capability group. */
type ConsentMode = 'ask' | 'session' | 'auto'
/** Per-capability local-control consent. Read-only "screen" needs no prompt;
 *  the actuation groups (input/apps/clipboard) obey consentMode. */
interface ComputerUseConfig {
  /** Master — all local control is off unless this is true. Default false. */
  enabled?: boolean
  /** Read-only: screen capture + window list. Default true (when enabled). */
  screen?: boolean
  /** Input synthesis: type / key / click (+ future scroll/drag). Default true. */
  input?: boolean
  /** Open an app / URL / path + structured app control (UIA / Office COM).
   *  Default true. */
  apps?: boolean
  /** Write the clipboard. Default true. */
  clipboard?: boolean
  /** Structured browser control — a dedicated Chrome/Edge automation instance
   *  driven over CDP (browser_* tools). Default true (when enabled). */
  browser?: boolean
  /** Which engine the automation browser uses. Default 'auto' (Chrome → Edge). */
  browserEngine?: 'auto' | 'chrome' | 'edge'
  /** Consent for the actuation groups: ask every time / allow for this run /
   *  auto (no prompt). Default 'ask'. */
  consentMode?: ConsentMode
}
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
  /** TTS output device by LABEL ('' = system default; resolved in the overlay). */
  audioOutputLabel?: string
  /** Mic input device by LABEL ('' = system default). */
  audioInputLabel?: string
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
  const prevLang = loadConfig().lang
  const next = { ...loadConfig(), ...patch }
  writeFileSync(configPath(), JSON.stringify(next, null, 2))
  // Reconcile the live MCP client set when the server list changed.
  if ('mcpServers' in patch) {
    try { getMcpManager().configure(next.mcpServers) } catch { /* SDK missing */ }
  }
  // Re-localize the native chrome (tray + app menu) when the language changed —
  // the renderer persists lang via config:set, so this catches it there too.
  if ('lang' in patch && next.lang !== prevLang) {
    try { rebuildTrayMenu() } catch { /* tray not yet created */ }
    try { buildAppMenu() } catch { /* menu not yet built */ }
    // Native window title is set at creation time — refresh it live too.
    try { settings?.setTitle(nt('window.settingsTitle')) } catch { /* not created */ }
  }
  return next
}

// ── launch-on-login (system startup) ────────────────────────────────────────
// win/mac use the OS login-item API; Linux uses a ~/.config/autostart .desktop
// file (setLoginItemSettings is a no-op on Linux). Best-effort — autostart
// wiring must never crash the app.
function autostartDesktopPath(): string {
  return join(app.getPath('home'), '.config', 'autostart', 'geny-connector.desktop')
}
function applyAutoLaunch(enabled: boolean): void {
  try {
    if (process.platform === 'linux') {
      const p = autostartDesktopPath()
      if (enabled) {
        mkdirSync(join(app.getPath('home'), '.config', 'autostart'), { recursive: true })
        // AppImage relaunches via $APPIMAGE; packaged builds via the exe path.
        const exec = process.env.APPIMAGE || process.execPath
        writeFileSync(
          p,
          `[Desktop Entry]\nType=Application\nName=Geny\nExec="${exec}" --hidden\nX-GNOME-Autostart-enabled=true\nTerminal=false\nNoDisplay=false\n`,
        )
      } else if (existsSync(p)) {
        unlinkSync(p)
      }
    } else {
      // openAsHidden is honored on macOS; args flag the autostart launch.
      app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: enabled, args: ['--hidden'] })
    }
  } catch (e) {
    console.warn('autoLaunch apply failed:', (e as Error).message)
  }
}

// ── native-chrome i18n (tray / app menu / actuation dialogs) ────────────────
// The renderer settings UI has its own catalog (renderer/src/i18n.ts); this is
// the small ko/en map for the strings shown by the OS chrome. resolvedLang()
// reads config.lang, falling back to the OS locale (ko if it starts with "ko").
type Lang = 'ko' | 'en'
function osDefaultLang(): Lang {
  return app.getLocale().toLowerCase().startsWith('ko') ? 'ko' : 'en'
}
function resolvedLang(): Lang {
  return loadConfig().lang ?? osDefaultLang()
}
const NATIVE_MESSAGES: Record<string, { ko: string; en: string }> = {
  // tray menu
  'tray.openControl': { ko: '제어판 / 채팅 열기', en: 'Open control panel / chat' },
  'tray.quickChat': { ko: '빠른 채팅 (VTuber에게 보내기)', en: 'Quick chat (send to VTuber)' },
  'tray.openSettings': { ko: '설정 열기', en: 'Open settings' },
  'tray.hideAvatar': { ko: '아바타 숨기기', en: 'Hide avatar' },
  'tray.showAvatar': { ko: '아바타 보이기', en: 'Show avatar' },
  'tray.allowComputerUse': { ko: '로컬 컴퓨터 제어 허용 (화면·입력 — 세부는 설정에서)', en: 'Allow Local Computer Use (screen · input — details in settings)' },
  'tray.autoUpdate': { ko: '자동 업데이트', en: 'Auto-update' },
  'tray.checkUpdate': { ko: '업데이트 확인', en: 'Check for updates' },
  'tray.version': { ko: '버전 v{version}', en: 'Version v{version}' },
  'tray.logout': { ko: '로그아웃', en: 'Sign out' },
  'tray.restart': { ko: '재시작', en: 'Restart' },
  'tray.quit': { ko: '종료', en: 'Quit' },
  // app menu
  'menu.settings': { ko: '설정', en: 'Settings' },
  'menu.control': { ko: '제어판 / 채팅', en: 'Control panel / chat' },
  'menu.checkUpdate': { ko: '업데이트 확인', en: 'Check for updates' },
  'menu.restart': { ko: '재시작', en: 'Restart' },
  'menu.logout': { ko: '로그아웃', en: 'Sign out' },
  'menu.quit': { ko: '종료', en: 'Quit' },
  'menu.edit': { ko: '편집', en: 'Edit' },
  'menu.undo': { ko: '실행 취소', en: 'Undo' },
  'menu.redo': { ko: '다시 실행', en: 'Redo' },
  'menu.cut': { ko: '잘라내기', en: 'Cut' },
  'menu.copy': { ko: '복사', en: 'Copy' },
  'menu.paste': { ko: '붙여넣기', en: 'Paste' },
  'menu.selectAll': { ko: '전체 선택', en: 'Select All' },
  'menu.view': { ko: '보기', en: 'View' },
  'menu.reload': { ko: '새로고침', en: 'Reload' },
  'menu.devTools': { ko: '개발자 도구', en: 'Developer Tools' },
  'menu.resetZoom': { ko: '기본 배율', en: 'Actual Size' },
  'menu.zoomIn': { ko: '확대', en: 'Zoom In' },
  'menu.zoomOut': { ko: '축소', en: 'Zoom Out' },
  // actuation dialog
  'act.allow': { ko: '허용', en: 'Allow' },
  'act.allowSession': { ko: '이 세션 동안 허용', en: 'Allow for this session' },
  'act.deny': { ko: '거부', en: 'Deny' },
  'act.dialogTitle': { ko: 'Geny 데스크톱 제어', en: 'Geny Desktop Control' },
  'act.dialogMessage': { ko: 'Geny 가 실행하려고 합니다: {label}', en: 'Geny wants to perform: {label}' },
  'act.capOpenApp': { ko: '앱/링크 열기', en: 'Open app/link' },
  'act.capType': { ko: '타이핑', en: 'Type' },
  'act.capKey': { ko: '키 입력', en: 'Press keys' },
  'act.capClick': { ko: '마우스 클릭', en: 'Mouse click' },
  'act.capScroll': { ko: '스크롤', en: 'Scroll' },
  'act.capClipboard': { ko: '클립보드 쓰기', en: 'Write clipboard' },
  'act.detailTarget': { ko: '대상: {target}', en: 'Target: {target}' },
  'act.scrollDown': { ko: '아래', en: 'down' },
  'act.scrollUp': { ko: '위', en: 'up' },
  'act.capBrowser': { ko: '브라우저 조작', en: 'Browser control' },
  'act.capBrowserOpen': { ko: '브라우저에서 페이지 열기', en: 'Open a page in the browser' },
  'act.capBrowserEval': { ko: '브라우저에서 스크립트 실행', en: 'Run a script in the browser' },
  'act.capAppControl': { ko: '프로그램 제어', en: 'Application control' },
  'act.capOfficeControl': { ko: 'Office 문서 조작', en: 'Office document control' },
  'act.deniedByUser': { ko: '사용자가 거부함', en: 'Denied by the user' },
  'act.capDisabled': { ko: '이 동작이 꺼져 있습니다 (설정 → 로컬 컴퓨터 제어)', en: 'This action is disabled (Settings → Local Computer Use)' },
  // quick-chat delivery errors
  'qc.emptyMessage': { ko: '빈 메시지', en: 'Empty message' },
  'qc.loginRequired': { ko: '로그인이 필요합니다', en: 'Sign-in required' },
  // window titles
  'window.settingsTitle': { ko: 'Geny 설정', en: 'Geny Settings' },
}
function nt(key: string, vars?: Record<string, string | number>): string {
  const entry = NATIVE_MESSAGES[key]
  let s = entry ? entry[resolvedLang()] : key
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v))
  return s
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

// While a monitor DPI change is settling, Windows RESCALES the window (WM_DPICHANGED)
// and getBounds() reports transient/rescaled values — persisting those is exactly
// how the position ends up "wrong" after a 150%↔100% move. Suppress saves until
// this timestamp (set on display-metrics-changed) so we only persist SETTLED bounds.
let dpiSettleUntil = 0

// Persist a window's geometry on move/resize (debounced). Skips minimized /
// maximized / fullscreen states, and waits out an in-flight DPI transition so the
// SETTLED bounds are saved, not the mid-rescale ones.
function attachBoundsPersistence(win: BrowserWindow, key: 'overlay' | 'control' | 'settings'): void {
  let timer: ReturnType<typeof setTimeout> | null = null
  const run = () => {
    if (win.isDestroyed() || win.isMinimized() || win.isMaximized() || win.isFullScreen()) return
    const wait = dpiSettleUntil - Date.now()
    if (wait > 0) { timer = setTimeout(run, wait + 100); return } // let the DPI rescale finish first
    const b = win.getBounds()
    saveConfig({ [key]: { x: b.x, y: b.y, width: b.width, height: b.height } } as Partial<ConnectorConfig>)
  }
  const save = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(run, 450)
  }
  win.on('moved', save)
  win.on('resized', save)
  win.on('closed', () => { if (timer) clearTimeout(timer) })
}

// ── avatar overlay geometry, remembered PER MONITOR ─────────────────────────
// Each display keeps its own overlay position + size, keyed by a stable-ish
// display signature. This is what stops the width/height getting distorted by a
// DPI rescale: when the overlay settles on another monitor we re-apply THAT
// monitor's remembered size instead of trusting the WM_DPICHANGED rect.
type Display = ReturnType<typeof screen.getPrimaryDisplay>
function displayKey(d: Display): string {
  return `${d.bounds.x},${d.bounds.y}:${d.size.width}x${d.size.height}@${d.scaleFactor}`
}
function overlayCurrentDisplay(): Display | null {
  if (!overlay || overlay.isDestroyed()) return null
  return screen.getDisplayMatching(overlay.getBounds())
}
let lastOverlayDisplayKey = ''
let overlayGeomTimer: ReturnType<typeof setTimeout> | null = null
function saveOverlayGeometry(): void {
  if (overlayGeomTimer) clearTimeout(overlayGeomTimer)
  const run = () => {
    if (!overlay || overlay.isDestroyed() || overlay.isMinimized()) return
    const wait = dpiSettleUntil - Date.now()
    if (wait > 0) { overlayGeomTimer = setTimeout(run, wait + 100); return }
    const d = overlayCurrentDisplay(); if (!d) return
    const b = overlay.getBounds()
    const bounds: WinBounds = { x: b.x, y: b.y, width: b.width, height: b.height }
    const cfg = loadConfig()
    saveConfig({ overlayByDisplay: { ...(cfg.overlayByDisplay || {}), [displayKey(d)]: bounds }, overlay: bounds })
  }
  overlayGeomTimer = setTimeout(run, 450)
}
// On launch: apply the geometry remembered for whichever display the overlay is on.
function restoreOverlayGeometry(): void {
  if (!overlay || overlay.isDestroyed()) return
  const d = overlayCurrentDisplay(); if (!d) return
  lastOverlayDisplayKey = displayKey(d)
  const saved = loadConfig().overlayByDisplay?.[displayKey(d)] ?? loadConfig().overlay
  if (saved) overlay.setBounds(restoreWinBounds(saved, saved))
}
// After a move settles on a DIFFERENT monitor, snap to that monitor's remembered
// SIZE (keeping the dropped position). Fixes the DPI-move size distortion.
function applyOverlaySizeOnCross(): void {
  if (!overlay || overlay.isDestroyed()) return
  const d = overlayCurrentDisplay(); if (!d) return
  const key = displayKey(d)
  if (key === lastOverlayDisplayKey) return
  lastOverlayDisplayKey = key
  const saved = loadConfig().overlayByDisplay?.[key]
  if (!saved) { saveOverlayGeometry(); return } // first time on this monitor → remember it
  const wa = d.workArea
  const width = Math.min(saved.width, wa.width)
  const height = Math.min(saved.height, wa.height)
  const b = overlay.getBounds()
  const x = Math.round(Math.min(Math.max(b.x, wa.x), wa.x + wa.width - width))
  const y = Math.round(Math.min(Math.max(b.y, wa.y), wa.y + wa.height - height))
  overlay.setBounds({ x, y, width, height })
}
// Authoritative drag rect: during a dock-handle drag we track the overlay's
// intended bounds in JS and re-assert a CONSTANT size each frame, instead of
// reading getBounds() (which drifts + grows the window on fractional DPI). See
// the 'overlay:move-by' handler for the full rationale.
let overlayMoveRect: { x: number; y: number; w: number; h: number } | null = null
let overlayMoveIdle: ReturnType<typeof setTimeout> | null = null
function endOverlayMove(): void {
  if (overlayMoveIdle) { clearTimeout(overlayMoveIdle); overlayMoveIdle = null }
  overlayMoveRect = null
  onOverlayMoved() // reconcile size-on-cross + persist the settled bounds
}

// 'moved' fires during a drag + on the DPI cross; debounce, wait out the DPI
// rescale, THEN reconcile size-on-cross and persist.
let overlayMovedTimer: ReturnType<typeof setTimeout> | null = null
function onOverlayMoved(): void {
  if (overlayMovedTimer) clearTimeout(overlayMovedTimer)
  const run = () => {
    const wait = dpiSettleUntil - Date.now()
    if (wait > 0) { overlayMovedTimer = setTimeout(run, wait + 100); return }
    applyOverlaySizeOnCross()
    saveOverlayGeometry()
  }
  overlayMovedTimer = setTimeout(run, 350)
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

// Reset every window to its default position/size on the primary display, clear
// the remembered geometry, and reset the avatar's in-canvas pan/zoom. The escape
// hatch when a multi-monitor / DPI mess leaves things off-screen or broken.
function resetWindowPositions(): void {
  saveConfig({ overlay: undefined, overlayByDisplay: undefined, control: undefined, settings: undefined, quickChatBar: undefined } as Partial<ConnectorConfig>)
  lastOverlayDisplayKey = ''
  const wa = screen.getPrimaryDisplay().workArea
  const centered = (w: number, h: number) => ({
    x: Math.round(wa.x + (wa.width - w) / 2),
    y: Math.round(wa.y + (wa.height - h) / 2),
    width: w,
    height: h,
  })
  if (overlay && !overlay.isDestroyed()) {
    const w = 420
    const h = Math.round(wa.height * 0.45)
    overlay.setBounds({ x: wa.x + wa.width - w - 24, y: wa.y + wa.height - h, width: w, height: h })
    overlay.show()
    overlay.webContents.send('overlay:reset-view') // reset avatar pan/zoom (localStorage view)
  }
  if (control && !control.isDestroyed()) control.setBounds(centered(640, 760))
  if (settings && !settings.isDestroyed()) settings.setBounds(centered(640, 720))
  // quick-chat re-centers on its next summon now that quickChatBar is cleared.
}

// Keep a window in the 'screen-saver' top band even as OTHER processes churn
// the z-order. A one-shot setAlwaysOnTop decays on Windows — but only through
// OBSERVABLE transitions, so this is purely event-driven (zero idle cost, no
// polling):
//   · An ordinary window — even maximized — can NEVER cover a TOPMOST one, so
//     "opened another app and the avatar sank" always means a fullscreen /
//     borderless transition or a stripped TOPMOST bit was involved.
//   · Fullscreen & borderless toggles hide the taskbar / change the work area
//     → `display-metrics-changed` fires. DPI moves fire it too.
//   · The OS stripping the bit surfaces as `always-on-top-changed(false)`.
//   · Our own focus churn (user clicks our windows then away) → blur/show/
//     restore.
// Each trigger asserts twice: immediately, and once more shortly after via a
// ONE-SHOT timer (transitions finish after the event; the second pass lands
// on the settled z-order). setAlwaysOnTop/moveTop are cheap SetWindowPos
// calls — no-ops when already top, never steal focus, no flicker.
function armAlwaysOnTop(win: BrowserWindow): void {
  let settle: ReturnType<typeof setTimeout> | null = null
  const assertNow = (): void => {
    if (win.isDestroyed() || !win.isVisible() || win.isMinimized()) return
    try {
      win.setAlwaysOnTop(true, 'screen-saver')
      if (process.platform === 'darwin') {
        win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
      }
      win.moveTop() // top of the topmost band — above later-created topmost peers
    } catch {
      /* window mid-teardown */
    }
  }
  const assert = (): void => {
    assertNow()
    if (settle) clearTimeout(settle)
    settle = setTimeout(() => {
      settle = null
      assertNow()
    }, 900)
  }
  assertNow()
  win.on('show', assert)
  win.on('restore', assert)
  // Focus moved elsewhere — exactly when another window may have claimed the
  // top of the topmost band.
  win.on('blur', assert)
  // The OS actively stripped the bit (fullscreen/DPI transitions do this).
  win.on('always-on-top-changed', (_e, isOnTop) => {
    if (!isOnTop) assert()
  })
  // Display topology / fullscreen-driven metric changes (taskbar hide, work-
  // area, DPI) — the signal that fires when another app goes fullscreen.
  const onMetrics = (): void => assert()
  screen.on('display-metrics-changed', onMetrics)
  win.on('closed', () => {
    if (settle) clearTimeout(settle)
    screen.removeListener('display-metrics-changed', onMetrics)
  })
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

  // Float above full-screen apps and STAY there — one-shot always-on-top
  // decays on Windows as other processes churn the z-order (see
  // armAlwaysOnTop); this asserts now and keeps re-asserting for the
  // window's lifetime.
  armAlwaysOnTop(overlay)

  // External links open in the OS browser, never inside the overlay.
  overlay.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // Content depends on login state: the remote transparent /overlay avatar page
  // once a token exists, otherwise a local "log in first" placeholder.
  attachContentResilience(overlay, () => void applyOverlayContent())
  // Per-monitor geometry: restore this display's remembered bounds, and on every
  // move/resize reconcile size-on-cross + persist per display.
  restoreOverlayGeometry()
  overlay.on('moved', onOverlayMoved)
  overlay.on('resized', saveOverlayGeometry)
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
    title: nt('window.settingsTitle'),
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
// Content-driven growth cap (multi-line text + image thumbnails).
const QUICKCHAT_MAX_H = 480
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
  // Float above full-screen apps — same armed recipe as the avatar overlay
  // ('screen-saver' band + lifetime re-assertion; visibleOnFullScreen is
  // macOS-only inside armAlwaysOnTop). One caveat handled there: assert is a
  // no-op while hidden, and the 'show' hook re-asserts on every open.
  armAlwaysOnTop(quickchat)
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
interface QuickChatPayload {
  text: string
  images?: Array<{ name: string; type: string; dataUrl: string }>
}

const QC_MAX_IMAGES = 4
// data URL overhead ≈ 4/3 of raw bytes; 14 MiB string ≈ 10 MiB image.
const QC_MAX_DATAURL_CHARS = 14 * 1024 * 1024

function sanitizeQuickImages(images: unknown): QuickChatPayload['images'] {
  if (!Array.isArray(images)) return undefined
  const out: NonNullable<QuickChatPayload['images']> = []
  for (const img of images.slice(0, QC_MAX_IMAGES)) {
    if (!img || typeof img !== 'object') continue
    const { name, type, dataUrl } = img as Record<string, unknown>
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) continue
    if (dataUrl.length > QC_MAX_DATAURL_CHARS) continue
    out.push({
      name: typeof name === 'string' && name ? name.slice(0, 200) : 'pasted.png',
      type: typeof type === 'string' && type.startsWith('image/') ? type : 'image/png',
      dataUrl,
    })
  }
  return out.length ? out : undefined
}

async function deliverQuickChat(
  payload: string | QuickChatPayload,
): Promise<{ ok: boolean; error?: string }> {
  // Accept both the structured form and the legacy bare string.
  const raw = typeof payload === 'string' ? { text: payload } : payload ?? { text: '' }
  const body = (raw.text ?? '').trim()
  const images = sanitizeQuickImages(raw.images)
  if (!body && !images) return { ok: false, error: nt('qc.emptyMessage') }
  const token = await getStoredToken()
  if (!token || !loadConfig().serverUrl) return { ok: false, error: nt('qc.loginRequired') }
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
  control!.webContents.send('connector:quick-send', { text: body, images })
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
  try { getSyncManager()?.stopAll() } catch { /* ignore */ }
  try { void getMcpManager().closeAll() } catch { /* ignore */ }
  // Structured-control teardown: drop CDP sockets (the visible automation
  // browser stays — it's the user's), kill the PowerShell UIA/COM host.
  try { getBrowserControl().dispose() } catch { /* ignore */ }
  try { disposeWinAutoHost() } catch { /* ignore */ }
  if (authRefreshTimer) clearInterval(authRefreshTimer)
})

// ── system tray: the always-available way to open settings / quit ───────────
let tray: Tray | null = null
// (Re)build the tray context menu. Hoisted so a language change (saveConfig) or
// a state change (avatar hide/show) can re-localize / refresh it in place.
function rebuildTrayMenu(): void {
  if (!tray) return
  const menu = Menu.buildFromTemplate([
    { label: nt('tray.openControl'), click: () => showControl() },
    { label: nt('tray.quickChat'), click: () => void toggleQuickChat() },
    { label: nt('tray.openSettings'), click: () => showSettings() },
    {
      label: overlay?.isVisible() ? nt('tray.hideAvatar') : nt('tray.showAvatar'),
      click: () => {
        if (!overlay) return
        overlay.isVisible() ? overlay.hide() : overlay.show()
        rebuildTrayMenu()
      },
    },
    { type: 'separator' },
    {
      label: nt('tray.allowComputerUse'),
      type: 'checkbox',
      checked: loadConfig().computerUse?.enabled === true,
      click: (item) => patchComputerUse({ enabled: item.checked }),
    },
    { type: 'separator' },
    {
      label: nt('tray.autoUpdate'),
      type: 'checkbox',
      checked: loadConfig().autoUpdate !== false,
      click: (item) => {
        saveConfig({ autoUpdate: item.checked })
        if (item.checked) triggerBackgroundCheck()
      },
    },
    { label: nt('tray.checkUpdate'), click: () => void checkForUpdatesManually() },
    { label: nt('tray.version', { version: app.getVersion() }), enabled: false },
    { type: 'separator' },
    { label: nt('tray.logout'), click: () => void logout() },
    {
      label: nt('tray.restart'),
      click: () => {
        appQuitting = true
        app.relaunch()
        app.quit()
      },
    },
    {
      label: nt('tray.quit'),
      click: () => {
        appQuitting = true
        app.quit()
      },
    },
  ])
  tray.setContextMenu(menu)
}
function createTray(): void {
  const icon = nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_ICON_B64}`)
  tray = new Tray(icon)
  tray.setToolTip('Geny')
  rebuildTrayMenu()
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

// ── Local Computer Use gate: per-capability consent (local bridge Phase 1) ───
// Effective gate = master AND the capability toggle. When `computerUse` is
// absent we fall back to the legacy captureArmed/automationEnabled toggles so
// existing installs behave exactly as before.
type ActuationCap = 'input' | 'apps' | 'clipboard' | 'browser'
interface ComputerUseGate { screen: boolean; input: boolean; apps: boolean; clipboard: boolean; browser: boolean; mode: ConsentMode }
function computerUseGate(): ComputerUseGate {
  const c = loadConfig()
  const cu = c.computerUse
  if (!cu) {
    // Legacy fallback: screen defaults ON, actuation defaults OFF, always ASK.
    const act = c.automationEnabled === true
    return { screen: c.captureArmed !== false, input: act, apps: act, clipboard: act, browser: act, mode: 'ask' }
  }
  const on = cu.enabled === true
  return {
    screen: on && cu.screen !== false,
    input: on && cu.input !== false,
    apps: on && cu.apps !== false,
    clipboard: on && cu.clipboard !== false,
    browser: on && cu.browser !== false,
    mode: cu.consentMode ?? 'ask',
  }
}
function patchComputerUse(patch: Partial<ComputerUseConfig>): void {
  const cur = loadConfig().computerUse ?? {}
  saveConfig({ computerUse: { ...cur, ...patch } })
}

// "이 세션 동안 허용" — per-capability session grants, cleared on app restart.
const sessionAllow = new Set<ActuationCap>()

type ActuationResult = { ok: boolean; result?: unknown; denied?: boolean; error?: string }
async function runActuation(
  cap: ActuationCap,
  label: string,
  detail: string,
  fn: () => Promise<unknown>,
): Promise<ActuationResult> {
  const gate = computerUseGate()
  const allowed =
    cap === 'apps' ? gate.apps : cap === 'clipboard' ? gate.clipboard : cap === 'browser' ? gate.browser : gate.input
  if (!allowed) {
    return { ok: false, denied: true, error: nt('act.capDisabled') }
  }
  // Consent: auto or an active session-grant → run without a prompt; otherwise
  // ask, offering a "이 세션 동안 허용" that promotes to a session-grant.
  if (gate.mode !== 'auto' && !sessionAllow.has(cap)) {
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      buttons: [nt('act.allow'), nt('act.allowSession'), nt('act.deny')],
      defaultId: 2,
      cancelId: 2,
      title: nt('act.dialogTitle'),
      message: nt('act.dialogMessage', { label }),
      detail,
    })
    if (response === 2) return { ok: false, denied: true, error: nt('act.deniedByUser') }
    if (response === 1) sessionAllow.add(cap) // grant for the rest of this run
  }
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
  _nut = { keyboard: m.keyboard, mouse: m.mouse, screen: m.screen, Button: m.Button, Point: m.Point, Key: K, keyMap }
  return _nut
}

// ── Computer-use coordinate mapping ─────────────────────────────────────────
// The model clicks in the SCREENSHOT's pixel space. desktop_screenshot captures
// the PRIMARY display; nut.js mouse/screen operate in the primary's PHYSICAL
// pixels. So we scale image coords → nut coords by the ratio nut.screen / image,
// which is correct at ANY DPI and regardless of how the capture was scaled or
// capped (both spaces cover the same primary screen). Multi-monitor secondary
// displays are out of nut.js's (primary-only) mouse space — best-effort only.
let lastCaptureDims: { w: number; h: number } | null = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function mapImageToScreen(nut: any, x: number, y: number): Promise<{ x: number; y: number }> {
  const dims = lastCaptureDims
  if (!dims || !dims.w || !dims.h) return { x, y } // no screenshot reference → assume 1:1
  try {
    const sw = await nut.screen.width()
    const sh = await nut.screen.height()
    if (!sw || !sh) return { x, y }
    return { x: Math.round((x * sw) / dims.w), y: Math.round((y * sh) / dims.h) }
  } catch {
    return { x, y }
  }
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

  // Move the overlay by a pointer delta (dock-handle drag).
  //
  // The naive `setPosition(getPosition() + delta)` GROWS the window on Windows
  // fractional-DPI monitors (150%): Electron's setPosition internally does
  // `SetBounds(newOrigin, getBounds().size())`, and getBounds() reports the
  // DIP-rounded size — each frame reads a slightly larger rounded size and
  // writes it back, so over a drag's hundreds of frames the window balloons.
  // (setBounds has the exact same read-back-and-grow problem.)
  //
  // Fix: keep an AUTHORITATIVE rect in JS. Capture the real bounds once at the
  // start of a drag, then apply deltas to the tracked position and re-assert a
  // CONSTANT captured size every frame — never reading getBounds() mid-drag. A
  // constant DIP size converts to the same physical size each call, so it can't
  // drift; the DIP size also stays put when crossing to a different-scale
  // monitor (physical size adapts), and the post-drag 'moved' handler snaps to
  // that monitor's remembered size. The drag rect auto-expires shortly after
  // the last delta (or on the explicit move-end below).
  ipcMain.on('overlay:move-by', (_e, dx: number, dy: number) => {
    if (!overlay || overlay.isDestroyed()) return
    if (!overlayMoveRect) {
      const b = overlay.getBounds()
      overlayMoveRect = { x: b.x, y: b.y, w: b.width, h: b.height }
    }
    overlayMoveRect.x += dx
    overlayMoveRect.y += dy
    overlay.setBounds({
      x: Math.round(overlayMoveRect.x),
      y: Math.round(overlayMoveRect.y),
      width: overlayMoveRect.w,
      height: overlayMoveRect.h,
    })
    if (overlayMoveIdle) clearTimeout(overlayMoveIdle)
    overlayMoveIdle = setTimeout(endOverlayMove, 300) // fallback drag-end
  })
  // Explicit drag-end (mouseup) — drop the authoritative rect immediately so the
  // next natural window event reads real bounds again.
  ipcMain.on('overlay:move-end', endOverlayMove)

  // Resize the overlay from an edge/corner handle (unlocked). `edge` is any of
  // n/s/e/w combined (e.g. 'se','n'); dx/dy are pointer deltas. West/north edges
  // move the origin while resizing. Clamped to a sane minimum. The 'resized'
  // event persists the new size for the current monitor.
  ipcMain.on('overlay:resize-by', (_e, edge: string, dx: number, dy: number) => {
    if (!overlay) return
    const MIN = 160
    const b = overlay.getBounds()
    let { x, y, width, height } = b
    if (edge.includes('e')) width = Math.max(MIN, width + Math.round(dx))
    if (edge.includes('s')) height = Math.max(MIN, height + Math.round(dy))
    if (edge.includes('w')) { const nw = Math.max(MIN, width - Math.round(dx)); x += width - nw; width = nw }
    if (edge.includes('n')) { const nh = Math.max(MIN, height - Math.round(dy)); y += height - nh; height = nh }
    overlay.setBounds({ x, y, width, height })
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

  // Reset all window positions/sizes + the avatar view (settings → 위치 초기화).
  ipcMain.on('windows:reset-positions', () => resetWindowPositions())

  // App version (settings window "앱" tab).
  ipcMain.handle('app:version', () => app.getVersion())

  // OS-derived default UI language — the settings window uses this when the
  // config has no explicit `lang` yet.
  ipcMain.handle('i18n:default-lang', () => osDefaultLang())

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
  // Grow/shrink the bar window to fit its content (multi-line text, pasted
  // image thumbnails) so the page NEVER scrolls — Spotlight-style. Top edge
  // stays anchored; only height changes, clamped to a sane band. resizable is
  // false for the USER; programmatic resize toggles it around setBounds
  // (macOS blocks setBounds on non-resizable windows).
  ipcMain.on('quickchat:resize', (_e, contentH: number) => {
    if (!quickchat || quickchat.isDestroyed() || !quickChatOpen) return
    if (!Number.isFinite(contentH)) return
    const h = Math.max(QUICKCHAT_H, Math.min(QUICKCHAT_MAX_H, Math.round(contentH)))
    const b = quickchat.getBounds()
    if (Math.abs(b.height - h) < 2) return
    suppressQuickChatPosSave = true
    quickchat.setResizable(true)
    quickchat.setBounds({ x: b.x, y: b.y, width: QUICKCHAT_W, height: h })
    quickchat.setResizable(false)
    setTimeout(() => { suppressQuickChatPosSave = false }, 120)
  })

  ipcMain.handle('quickchat:submit', async (_e, payload: string | QuickChatPayload) => {
    const r = await deliverQuickChat(payload)
    if (r.ok) dismissQuickChat()
    return r
  })
  // Esc / cancel from the bar.
  ipcMain.on('quickchat:close', () => dismissQuickChat())

  // ── Phase 4: desktop awareness (read-only capture) ──
  ipcMain.handle('capture:list-sources', async () => {
    if (!computerUseGate().screen) return [] // screen capture disabled
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 1, height: 1 },
    })
    return sources.map((s) => ({ id: s.id, name: s.name, display_id: s.display_id }))
  })

  // ── Phase 6: guarded actuation. Master switch (default OFF) + native confirm
  //    are the load-bearing local gate, independent of the server's decision. ──
  ipcMain.handle('actuate:open-app', (_e, target: string) =>
    runActuation('apps', nt('act.capOpenApp'), nt('act.detailTarget', { target }), async () => {
      if (/^https?:\/\//i.test(target)) await shell.openExternal(target)
      else await shell.openPath(target)
      return `opened ${target}`
    }),
  )
  ipcMain.handle('actuate:clipboard-write', (_e, text: string) =>
    runActuation('clipboard', nt('act.capClipboard'), text.slice(0, 80), async () => {
      clipboard.writeText(text)
      return 'clipboard written'
    }),
  )
  ipcMain.handle('actuate:type', (_e, text: string) =>
    runActuation('input', nt('act.capType'), text.slice(0, 80), async () => {
      const nut = await loadNut()
      await nut.keyboard.type(text)
      return `typed ${text.length} chars`
    }),
  )
  ipcMain.handle('actuate:key', (_e, keys: string) =>
    runActuation('input', nt('act.capKey'), keys, async () => {
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
    runActuation('input', nt('act.capClick'), `(${x}, ${y})${lastCaptureDims ? ' [image px]' : ''} ${button ?? 'left'}`, async () => {
      const nut = await loadNut()
      const p = await mapImageToScreen(nut, x, y)
      await nut.mouse.setPosition(new nut.Point(p.x, p.y))
      await nut.mouse.click(nut.Button[(button ?? 'left').toUpperCase() as 'LEFT' | 'RIGHT' | 'MIDDLE'])
      return `clicked image(${x},${y}) → screen(${p.x},${p.y})`
    }),
  )
  // Launch-on-login toggle.
  ipcMain.handle('autostart:get', () => loadConfig().autoLaunch === true)
  ipcMain.handle('autostart:set', (_e, enabled: boolean) => {
    saveConfig({ autoLaunch: !!enabled })
    applyAutoLaunch(!!enabled)
    return !!enabled
  })

  // desktop_screenshot geometry: the primary display id (so the renderer captures
  // the PRIMARY), and the last screenshot's pixel size (so clicks map back).
  ipcMain.handle('capture:primary-display-id', () => String(screen.getPrimaryDisplay().id))
  ipcMain.on('capture:note-dims', (_e, w: number, h: number) => {
    if (w > 0 && h > 0) lastCaptureDims = { w, h }
  })
  ipcMain.handle('actuate:scroll', (_e, amount: number) =>
    runActuation('input', nt('act.capScroll'), `${amount > 0 ? nt('act.scrollDown') : nt('act.scrollUp')} ${Math.abs(amount)}`, async () => {
      const nut = await loadNut()
      if (amount >= 0) await nut.mouse.scrollDown(amount)
      else await nut.mouse.scrollUp(-amount)
      return `scrolled ${amount}`
    }),
  )

  // ── Phase 7: structured local control — browser (CDP) + apps (UIA) + Office
  //    (COM). Read ops need only the capability toggle (like screen capture);
  //    act ops ride the same prompt-once consent as the other actuation groups. ──
  const BROWSER_READ_OPS = new Set(['tabs', 'snapshot', 'read', 'screenshot'])
  const browserOpLabel = (op: string): string =>
    op === 'open' ? nt('act.capBrowserOpen') : op === 'eval' ? nt('act.capBrowserEval') : nt('act.capBrowser')
  ipcMain.handle('browser:call', async (_e, op: string, args: Record<string, unknown>) => {
    const gate = computerUseGate()
    if (!gate.browser) return { ok: false, denied: true, error: nt('act.capDisabled') }
    const a: Record<string, unknown> = { ...(args ?? {}) }
    if (op === 'open' && !a.engine) a.engine = loadConfig().computerUse?.browserEngine ?? 'auto'
    if (BROWSER_READ_OPS.has(op)) {
      try {
        return { ok: true, result: await browserCall(op, a) }
      } catch (e) {
        return { ok: false, error: String((e as Error).message) }
      }
    }
    const detail = op === 'open' ? String(a.url ?? '') : op === 'act' ? `${a.action} ${a.element ?? ''}` : op
    return runActuation('browser', browserOpLabel(op), detail.slice(0, 120), () => browserCall(op, a))
  })

  const WINAUTO_READ_OPS = new Set(['windows', 'win_snapshot', 'win_read', 'office_status', 'office_read'])
  ipcMain.handle('winauto:call', async (_e, op: string, args: Record<string, unknown>) => {
    const gate = computerUseGate()
    if (!gate.apps) return { ok: false, denied: true, error: nt('act.capDisabled') }
    const host = getWinAutoHost()
    const a: Record<string, unknown> = args ?? {}
    if (WINAUTO_READ_OPS.has(op)) {
      try {
        return { ok: true, result: await host.call(op, a, 40000) }
      } catch (e) {
        return { ok: false, error: String((e as Error).message) }
      }
    }
    const label = op.startsWith('office') ? nt('act.capOfficeControl') : nt('act.capAppControl')
    const detail = op === 'el_act' ? `${a.action} ${a.element ?? ''}` : op === 'office_act' ? `${a.app}: ${a.action}` : op
    return runActuation('apps', label, String(detail).slice(0, 120), async () => {
      const r = (await host.call(op, a, 40000)) as Record<string, unknown> | null
      // Pattern-less control → fall back to a REAL click at its UIA center
      // (UIA bounds are physical desktop px — nut.js's coordinate space).
      if (r && r['no_pattern'] && Array.isArray(r['bounds'])) {
        const [bx, by, bw, bh] = r['bounds'] as number[]
        const nut = await loadNut()
        await nut.mouse.setPosition(new nut.Point(Math.round(bx + bw / 2), Math.round(by + bh / 2)))
        await nut.mouse.click(nut.Button.LEFT)
        return { done: `clicked the control center (no automation pattern) at (${Math.round(bx + bw / 2)},${Math.round(by + bh / 2)})`, fallback: 'click' }
      }
      return r
    })
  })

  // ── Local MCP proxy (Phase 3): the connector hosts MCP clients to the user's
  //    local MCP servers; the renderer bridge + server reach them via these. ──
  const broadcastMcpStatus = (): void => {
    let status: unknown = []
    try { status = getMcpManager().status() } catch { /* SDK missing */ }
    for (const w of BrowserWindow.getAllWindows()) {
      try { w.webContents.send('mcp:status-event', status) } catch { /* window gone */ }
    }
  }
  ipcMain.handle('mcp:list-servers', () => loadConfig().mcpServers ?? [])
  ipcMain.handle('mcp:advertise', async () => {
    // Master off → advertise nothing (server unregisters the tools). A total
    // failure is an EMPTY catalog, never a phantom server entry.
    if (loadConfig().mcpEnabled === false) return []
    try { return await getMcpManager().advertise() } catch { return [] }
  })
  ipcMain.handle('mcp:call-tool', async (_e, server: string, tool: string, args: unknown) => {
    if (loadConfig().mcpEnabled === false) return { ok: false, error: 'local MCP is disabled in the connector settings' }
    try { return { ok: true, result: await getMcpManager().callTool(server, tool, args) } }
    catch (e) { return { ok: false, error: String((e as Error).message) } }
  })
  ipcMain.handle('mcp:test-server', async (_e, cfg: MCPServerConfig) => getMcpManager().test(cfg))
  ipcMain.handle('mcp:add-server', (_e, cfg: MCPServerConfig) => {
    const list = (loadConfig().mcpServers ?? []).filter((s) => s.name !== cfg.name)
    return (saveConfig({ mcpServers: [...list, cfg] }).mcpServers) ?? []
  })
  // Edit in place; renaming replaces the original entry (originalName ≠ cfg.name).
  ipcMain.handle('mcp:update-server', (_e, originalName: string, cfg: MCPServerConfig) => {
    const list = (loadConfig().mcpServers ?? []).filter((s) => s.name !== originalName && s.name !== cfg.name)
    return (saveConfig({ mcpServers: [...list, cfg] }).mcpServers) ?? []
  })
  ipcMain.handle('mcp:remove-server', (_e, name: string) => {
    const list = (loadConfig().mcpServers ?? []).filter((s) => s.name !== name)
    return (saveConfig({ mcpServers: list }).mcpServers) ?? []
  })
  ipcMain.handle('mcp:get-enabled', () => loadConfig().mcpEnabled !== false)
  ipcMain.handle('mcp:set-enabled', (_e, enabled: boolean) => {
    saveConfig({ mcpEnabled: !!enabled })
    broadcastMcpStatus() // windows repaint + the bridge re-advertises
    return !!enabled
  })
  ipcMain.handle('mcp:status', () => getMcpManager().status())
  // Status push → every window (settings UI repaints; the overlay's
  // ConnectorBridgeClient re-advertises the catalog to the backend).
  try {
    getMcpManager().onStatusChange(() => broadcastMcpStatus())
  } catch { /* SDK missing */ }

  // ── Workspace sync (Drive-style local↔agent-workspace replication) ──
  const broadcastSyncStatus = (statuses: unknown): void => {
    for (const w of BrowserWindow.getAllWindows()) {
      try { w.webContents.send('sync:status-event', statuses) } catch { /* window gone */ }
    }
  }
  const reconfigureSync = (): void => {
    const cfg = loadConfig()
    getSyncManager()?.configure(cfg.syncPairs ?? [])
  }
  ipcMain.handle('sync:list', () => ({
    pairs: loadConfig().syncPairs ?? [],
    statuses: getSyncManager()?.statuses() ?? [],
  }))
  ipcMain.handle('sync:pick-folder', async () => {
    const res = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: 'Workspace 폴더 선택',
    })
    return res.canceled ? null : res.filePaths[0]
  })
  ipcMain.handle('sync:add-pair', (_e, pair: { sessionId: string; sessionLabel?: string; localPath: string }) => {
    const list = loadConfig().syncPairs ?? []
    // Overlap guard: the same folder (or a nested one) feeding TWO hubs
    // would ping-pong files between agents through the shared disk.
    const norm = (p: string): string => p.replace(/[\\/]+$/, '')
    const newPath = norm(pair.localPath)
    for (const existing of list) {
      if (existing.sessionId === pair.sessionId && norm(existing.localPath) === newPath) continue // replaced below
      const ex = norm(existing.localPath)
      if (ex === newPath || ex.startsWith(newPath + sep) || newPath.startsWith(ex + sep)) {
        return { error: 'overlap', conflictWith: existing.sessionLabel || existing.sessionId }
      }
    }
    // one pairing per (session, path) — replace duplicates
    const filtered = list.filter(
      (p) => !(p.sessionId === pair.sessionId && norm(p.localPath) === newPath),
    )
    const id = `${pair.sessionId.slice(0, 8)}-${Date.now().toString(36)}`
    const next = [...filtered, { id, ...pair }]
    saveConfig({ syncPairs: next })
    reconfigureSync()
    return next
  })
  ipcMain.handle('sync:remove-pair', (_e, id: string) => {
    const next = (loadConfig().syncPairs ?? []).filter((p) => p.id !== id)
    saveConfig({ syncPairs: next })
    reconfigureSync()
    return next
  })
  ipcMain.handle('sync:set-paused', (_e, id: string, paused: boolean) => {
    const next = (loadConfig().syncPairs ?? []).map((p) =>
      p.id === id ? { ...p, paused: !!paused } : p,
    )
    saveConfig({ syncPairs: next })
    reconfigureSync()
    return next
  })
  ipcMain.handle('sync:sync-now', (_e, id: string) => getSyncManager()?.syncNow(id))
  ipcMain.handle('sync:confirm-mass-delete', (_e, id: string, accept: boolean) => {
    getSyncManager()?.confirmMassDelete(id, !!accept)
    if (!accept) {
      // refusal pauses the pair — persist that
      const next = (loadConfig().syncPairs ?? []).map((p) =>
        p.id === id ? { ...p, paused: true } : p,
      )
      saveConfig({ syncPairs: next })
    }
  })
  ipcMain.handle('sync:open-folder', (_e, id: string) => {
    const pair = (loadConfig().syncPairs ?? []).find((p) => p.id === id)
    if (pair) void shell.openPath(pair.localPath)
  })
  // Agent list for the pairing picker (main process owns the token).
  ipcMain.handle('sync:list-agents', async () => {
    const cfg = loadConfig()
    const token = await getStoredToken()
    if (!cfg.serverUrl || !token) return []
    try {
      const res = await fetch(`${cfg.serverUrl.replace(/\/$/, '')}/api/agents`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) return []
      const data = await res.json()
      const sessions = Array.isArray(data) ? data : (data?.sessions ?? data?.agents ?? [])
      return (sessions as Array<Record<string, unknown>>).map((s) => ({
        id: String(s.session_id ?? s.id ?? ''),
        // Geny's SessionInfo carries the human label as `session_name`.
        name: String(s.session_name ?? s.name ?? s.display_name ?? s.session_id ?? s.id ?? ''),
      })).filter((s) => s.id)
    } catch {
      return []
    }
  })

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
        { label: nt('menu.settings'), accelerator: 'CmdOrCtrl+,', click: () => showSettings() },
        { label: nt('menu.control'), click: () => showControl() },
        { label: nt('menu.checkUpdate'), click: () => void checkForUpdatesManually() },
        { type: 'separator' },
        { label: nt('menu.restart'), click: () => { appQuitting = true; app.relaunch(); app.quit() } },
        { label: nt('menu.logout'), click: () => void logout() },
        { role: 'quit', label: nt('menu.quit') },
      ],
    },
    {
      label: nt('menu.edit'),
      submenu: [
        { role: 'undo', label: nt('menu.undo') },
        { role: 'redo', label: nt('menu.redo') },
        { type: 'separator' },
        { role: 'cut', label: nt('menu.cut') },
        { role: 'copy', label: nt('menu.copy') },
        { role: 'paste', label: nt('menu.paste') },
        { role: 'selectAll', label: nt('menu.selectAll') },
      ],
    },
    {
      label: nt('menu.view'),
      submenu: [
        { role: 'reload', label: nt('menu.reload') },
        { role: 'toggleDevTools', label: nt('menu.devTools') },
        { type: 'separator' },
        { role: 'resetZoom', label: nt('menu.resetZoom') },
        { role: 'zoomIn', label: nt('menu.zoomIn') },
        { role: 'zoomOut', label: nt('menu.zoomOut') },
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
  // Load the user's local MCP servers into the manager (lazy-connects on use).
  try { getMcpManager().configure(loadConfig().mcpServers) } catch { /* SDK missing */ }

  // Workspace sync engine: one stable device id per install, engines per
  // configured pairing. Started AFTER auth validation below (engines read
  // the token lazily per request, so early start is also safe).
  try {
    if (!loadConfig().deviceId) saveConfig({ deviceId: randomUUID() })
    const manager = initSyncManager({
      indexDir: join(app.getPath('userData'), 'sync-index'),
      serverUrl: () => loadConfig().serverUrl ?? '',
      token: () => getStoredToken(),
      deviceId: () => loadConfig().deviceId as string,
      onStatus: (statuses) => {
        for (const w of BrowserWindow.getAllWindows()) {
          try { w.webContents.send('sync:status-event', statuses) } catch { /* window gone */ }
        }
      },
      log: (msg) => console.log('[sync]', msg),
      onAutoPause: (id) => {
        // persist the auto-pause AND tear the engine down (watcher/WS
        // must not keep running on an inert pair)
        const next = (loadConfig().syncPairs ?? []).map((p) =>
          p.id === id ? { ...p, paused: true } : p,
        )
        saveConfig({ syncPairs: next })
        setTimeout(() => getSyncManager()?.configure(next), 0)
      },
    })
    manager.configure(loadConfig().syncPairs ?? [])
  } catch (e) {
    console.error('[sync] init failed', e)
  }
  // Reconcile the OS login item with the saved preference (default off) — keeps
  // the autostart entry in sync if the app moved or the setting changed offline.
  applyAutoLaunch(loadConfig().autoLaunch === true)
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
  initAutoUpdate(() => loadConfig().autoUpdate !== false, () => resolvedLang())

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
    // Mark a DPI-settle window so bounds saves hold off on transient rescale
    // values (see attachBoundsPersistence), then rescue off-screen windows.
    dpiSettleUntil = Date.now() + 1800
    if (displayTimer) clearTimeout(displayTimer)
    displayTimer = setTimeout(ensureWindowsOnScreen, 900)
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
