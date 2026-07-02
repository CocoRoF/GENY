import { useEffect, useState, type ReactNode, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import genyIcon from './assets/geny_character.png'
import type { OverlayTuning, ComputerUseConfig, ConsentMode, MCPServerConfig } from '../../preload/index'
import { makeT, type Lang } from './i18n'

// Sentinels marking spans that should render as <b> inside an interpolated i18n
// string (the consent-mode hint bolds the "always ask" / "auto-allow" labels).
// The i18n value carries plain text; we wrap the interpolated label vars in
// these private-use markers, then boldTokens() splits + wraps them in <b>.
const BOLD0 = '\uE000'
const BOLD1 = '\uE001'
// Sentinels for inline <code> spans (the MCP hint marks the two tool names).
const CODE0 = '\uE002'
const CODE1 = '\uE003'
// Split `s` on the BOLD/CODE sentinel pairs, wrapping the enclosed text in the
// matching element. Both marker kinds are handled in one pass.
function markTokens(s: string): ReactNode[] {
  const out: ReactNode[] = []
  const re = new RegExp(`${BOLD0}([^${BOLD1}]*)${BOLD1}|${CODE0}([^${CODE1}]*)${CODE1}`, 'g')
  let last = 0
  let key = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) out.push(s.slice(last, m.index))
    if (m[1] !== undefined) out.push(<b key={key++}>{m[1]}</b>)
    else out.push(<code key={key++}>{m[2]}</code>)
    last = m.index + m[0].length
  }
  if (last < s.length) out.push(s.slice(last))
  return out
}
const boldTokens = markTokens

// Defaults mirror the web store (useVTuberStore) so the sliders show sensible
// positions before the user has changed anything.
const TUNING_DEFAULTS = {
  ttsVolume: 0.7,
  sttSensitivity: 0.04,
  sttSilenceMs: 1200,
  sttEchoCancellation: true,
  sttNoiseSuppression: true,
  sttAutoGain: true,
  screenIntervalMs: 180_000,
  screenSourceId: null as string | null,
  subtitlesEnabled: true,
  subtitleCharMs: 100,
}
const INTERVAL_OPTIONS = [
  { ms: 60_000, key: 'app.interval1m' },
  { ms: 180_000, key: 'app.interval3m' },
  { ms: 300_000, key: 'app.interval5m' },
  { ms: 600_000, key: 'app.interval10m' },
]
type CaptureSource = { id: string; name: string; display_id: string }

// ─────────────────────────────────────────────────────────────────────────────
// Settings window — a tabbed control surface (계정 · 음성 · 앱). Cohesive with
// the web app's zinc-dark + blue accent (see .gy tokens in styles.css).
// ─────────────────────────────────────────────────────────────────────────────

const TOKEN_KEY = 'geny_auth_token'

type StatusKind = 'idle' | 'working' | 'ok' | 'err'
type Tab = 'account' | 'voice' | 'control' | 'mcp' | 'app'

// ── inline icons — sized by CSS (.control-root svg{16px}); ALWAYS pass viewBox ──
const Svg = (props: { children: ReactNode }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    {props.children}
  </svg>
)
const I = {
  link: <Svg><path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></Svg>,
  user: <Svg><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></Svg>,
  download: <Svg><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></Svg>,
  mic: <Svg><rect x="9" y="2" width="6" height="11" rx="3" /><path d="M5 10a7 7 0 0 0 14 0M12 17v4" /></Svg>,
  refresh: <Svg><path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5" /></Svg>,
  sliders: <Svg><line x1="4" y1="21" x2="4" y2="14" /><line x1="4" y1="10" x2="4" y2="3" /><line x1="12" y1="21" x2="12" y2="12" /><line x1="12" y1="8" x2="12" y2="3" /><line x1="20" y1="21" x2="20" y2="16" /><line x1="20" y1="12" x2="20" y2="3" /><line x1="1" y1="14" x2="7" y2="14" /><line x1="9" y1="8" x2="15" y2="8" /><line x1="17" y1="16" x2="23" y2="16" /></Svg>,
  power: <Svg><path d="M12 2v10M18.4 6.6a9 9 0 1 1-12.77.04" /></Svg>,
  external: <Svg><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" /></Svg>,
  sun: <Svg><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></Svg>,
  moon: <Svg><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></Svg>,
  monitor: <Svg><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" /></Svg>,
  plug: <Svg><path d="M12 22v-5M9 8V2M15 8V2M6 8h12v4a6 6 0 0 1-12 0z" /></Svg>,
  chat: <Svg><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" /></Svg>,
}

type ThemeMode = 'system' | 'dark' | 'light'

// ── hotkey recorder: click → press a combo → Electron accelerator string ──────
function keyName(e: KeyboardEvent): string | null {
  const code = e.code
  if (code.startsWith('Key')) return code.slice(3)        // KeyA → A
  if (code.startsWith('Digit')) return code.slice(5)      // Digit1 → 1
  if (/^F\d{1,2}$/.test(code)) return code                // F1..F24
  if (code.startsWith('Numpad')) {
    const n = code.slice(6)
    if (/^\d$/.test(n)) return 'num' + n
    const m: Record<string, string> = { Enter: 'Enter', Add: 'numadd', Subtract: 'numsub', Multiply: 'nummult', Divide: 'numdiv', Decimal: 'numdec' }
    return m[n] ?? null
  }
  const named: Record<string, string> = {
    Enter: 'Enter', Space: 'Space', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert',
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
    Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
    Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`',
  }
  if (code in named) return named[code]
  if (e.key && e.key.length === 1) return e.key.toUpperCase()
  return null
}
function keyEventToAccelerator(e: KeyboardEvent): string | null {
  const mods: string[] = []
  if (e.ctrlKey || e.metaKey) mods.push('CommandOrControl')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  const key = keyName(e)
  if (!key) return null               // modifier-only so far → keep waiting
  if (mods.length === 0) return null  // a global hotkey needs at least one modifier
  return [...mods, key].join('+')
}
function prettyAccel(acc: string): string {
  if (!acc) return ''
  const mac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform)
  return acc
    .replace(/CommandOrControl/g, mac ? '⌘' : 'Ctrl')
    .replace(/Command/g, '⌘')
    .replace(/Control/g, 'Ctrl')
    .replace(/Alt/g, mac ? '⌥' : 'Alt')
    .replace(/Shift/g, mac ? '⇧' : 'Shift')
    .split('+').join(' + ')
}
function HotkeyCapture({ value, onCapture, t }: { value: string; onCapture: (acc: string) => void; t: (key: string, vars?: Record<string, string | number>) => string }) {
  const [recording, setRecording] = useState(false)
  const start = () => {
    if (recording) return
    setRecording(true)
    window.connector?.hotkeys.pause?.()  // free up registered combos for re-capture
  }
  const stop = () => {
    setRecording(false)
    window.connector?.hotkeys.resume?.()
  }
  const onKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!recording) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); start() }
      return
    }
    e.preventDefault()
    e.stopPropagation()
    if (e.key === 'Escape') { stop(); return }
    const acc = keyEventToAccelerator(e.nativeEvent)
    if (acc) { onCapture(acc); stop() }
  }
  return (
    <button
      type="button"
      className={`gy-hotkey ${recording ? 'is-recording' : ''}`}
      onClick={start}
      onKeyDown={onKeyDown}
      onBlur={stop}
    >
      {recording ? t('hotkey.recording') : (prettyAccel(value) || t('hotkey.idle'))}
    </button>
  )
}

export function ControlApp() {
  const [lang, setLang] = useState<Lang>('ko')
  const t = makeT(lang)
  const [tab, setTab] = useState<Tab>('account')
  const [serverUrl, setServerUrl] = useState('')
  // Empty until the first status check; rendered fallback shows the "check
  // connection" prompt in the active language (see the status pill below).
  const [status, setStatus] = useState('')
  const [statusKind, setStatusKind] = useState<StatusKind>('idle')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [hasToken, setHasToken] = useState(false)
  const [autoUpdate, setAutoUpdate] = useState(true)
  const [autoStart, setAutoStart] = useState(false)
  const [pttHotkey, setPttHotkey] = useState('CommandOrControl+Shift+Space')
  const [pttMsg, setPttMsg] = useState('')
  const [quickChatHotkey, setQuickChatHotkey] = useState('CommandOrControl+Shift+Enter')
  const [quickChatMsg, setQuickChatMsg] = useState('')
  const [resetDone, setResetDone] = useState(false)
  const [busy, setBusy] = useState(false)
  const [version, setVersion] = useState('')
  const [theme, setThemeState] = useState<ThemeMode>('system')
  const [sysDark, setSysDark] = useState(true)
  // Avatar capability tuning (TTS/STT/screen) — persisted in the connector
  // config + pushed live to the overlay's drivers via the config:changed event.
  const [tuning, setTuning] = useState<OverlayTuning>({})
  const [sources, setSources] = useState<CaptureSource[]>([])
  // Local Computer Use consent (local bridge Phase 1) — persisted top-level in
  // the connector config, enforced natively in main (runActuation/capture gate).
  const [computerUse, setComputerUse] = useState<ComputerUseConfig>({})

  useEffect(() => {
    window.connector?.serverConfig.get().then(async (c) => {
      setServerUrl(c.serverUrl)
      setThemeState(c.theme ?? 'system')
      setTuning(c.overlayTuning ?? {})
      setComputerUse(c.computerUse ?? {})
      // Language: the saved choice, else the OS default (fetched from main).
      const osLang = (await window.connector?.appDefaultLang?.().catch(() => 'ko' as Lang)) ?? 'ko'
      setLang(c.lang ?? osLang)
    })
    window.connector?.secureStore.get(TOKEN_KEY).then((t) => setHasToken(!!t))
    window.connector?.updater.getEnabled().then(setAutoUpdate)
    window.connector?.autostart?.get().then(setAutoStart).catch(() => undefined)
    window.connector?.hotkeys.getPushToTalk().then((h) => h && setPttHotkey(h))
    window.connector?.hotkeys.getQuickChat?.().then((h) => h && setQuickChatHotkey(h))
    window.connector?.appVersion?.().then(setVersion).catch(() => undefined)
    window.connector?.capture?.listSources?.().then(setSources).catch(() => undefined)
    // Re-read the keychain whenever this window regains focus — the main process
    // may have dropped an expired token on startup/refresh, so this avoids a
    // stale "로그인됨" after the session actually lapsed.
    const recheck = () => window.connector?.secureStore.get(TOKEN_KEY).then((t) => setHasToken(!!t))
    window.addEventListener('focus', recheck)
    return () => window.removeEventListener('focus', recheck)
  }, [])

  // Merge + persist a tuning change; sends the FULL object so main's shallow
  // config merge replaces overlayTuning cleanly.
  const patchTuning = (p: Partial<OverlayTuning>) => {
    setTuning((prev) => {
      const next = { ...TUNING_DEFAULTS, ...prev, ...p }
      window.connector?.serverConfig.set({ overlayTuning: next })
      return next
    })
  }
  const tget = <K extends keyof typeof TUNING_DEFAULTS>(k: K): (typeof TUNING_DEFAULTS)[K] =>
    (tuning[k] ?? TUNING_DEFAULTS[k]) as (typeof TUNING_DEFAULTS)[K]

  // Local Computer Use: merge + persist the whole object (main shallow-merges).
  const patchComputerUse = (p: Partial<ComputerUseConfig>) => {
    setComputerUse((prev) => {
      const next = { ...prev, ...p }
      window.connector?.serverConfig.set({ computerUse: next })
      return next
    })
  }
  const cuOn = computerUse.enabled === true
  // Effective per-capability state for the UI — mirrors main's computerUseGate
  // (a capability is on only when the master is on and it isn't explicitly off).
  const cuCap = (k: 'screen' | 'input' | 'apps' | 'clipboard') => cuOn && computerUse[k] !== false

  // ── Local MCP servers (Phase 3) ──
  const [mcpServers, setMcpServers] = useState<MCPServerConfig[]>([])
  const [mcpForm, setMcpForm] = useState<MCPServerConfig>({ name: '', transport: 'stdio', command: '' })
  const [mcpTest, setMcpTest] = useState<Record<string, string>>({})
  useEffect(() => {
    window.connector?.mcp?.listServers?.().then(setMcpServers).catch(() => setMcpServers([]))
  }, [])
  const addMcpServer = async () => {
    const name = mcpForm.name.trim()
    if (!name) return
    const cfg: MCPServerConfig = { ...mcpForm, name, enabled: true }
    const list = (await window.connector?.mcp?.addServer(cfg)) ?? []
    setMcpServers(list)
    setMcpForm({ name: '', transport: 'stdio', command: '' })
  }
  const removeMcpServer = async (name: string) => {
    const list = (await window.connector?.mcp?.removeServer(name)) ?? []
    setMcpServers(list)
  }
  const testMcpServer = async (cfg: MCPServerConfig) => {
    setMcpTest((p) => ({ ...p, [cfg.name]: t('mcp.testing') }))
    const r = await window.connector?.mcp?.testServer(cfg)
    setMcpTest((p) => ({
      ...p,
      [cfg.name]: r?.ok
        ? t('mcp.testOk', { count: r.tools?.length ?? 0 })
        : t('mcp.testFail', { error: r?.error ?? t('mcp.testFailUnknown') }),
    }))
  }

  // Track the OS theme so 'system' resolves live.
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    setSysDark(mq.matches)
    const onChange = (e: MediaQueryListEvent) => setSysDark(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  const resolvedDark = theme === 'system' ? sysDark : theme === 'dark'

  const changeTheme = (mode: ThemeMode) => {
    setThemeState(mode)
    window.connector?.serverConfig.set({ theme: mode })
    // Reload the chat panel so the remote /connector page picks up ?theme.
    window.connector?.windowControl.reloadPanel()
  }

  const changeLang = (v: Lang) => {
    setLang(v)
    // Persisting lang triggers main to re-localize the tray + app menu.
    window.connector?.serverConfig.set({ lang: v })
  }

  const stat = (msg: string, kind: StatusKind) => {
    setStatus(msg)
    setStatusKind(kind)
  }

  const toggleAutoUpdate = async (next: boolean) => {
    setAutoUpdate(next)
    await window.connector?.updater.setEnabled(next)
  }

  const toggleAutoStart = async (next: boolean) => {
    setAutoStart(next)
    await window.connector?.autostart?.set(next)
  }

  const savePtt = async (acc: string) => {
    setPttHotkey(acc)
    const ok = await window.connector?.hotkeys.setPushToTalk(acc)
    setPttMsg(ok ? t('hotkey.registered') : t('hotkey.conflict'))
  }

  const saveQuickChat = async (acc: string) => {
    setQuickChatHotkey(acc)
    const ok = await window.connector?.hotkeys.setQuickChat?.(acc)
    setQuickChatMsg(ok ? t('hotkey.registered') : t('hotkey.conflict'))
  }

  const checkStatus = async () => {
    setBusy(true)
    stat(t('status.connecting'), 'working')
    // Strip trailing slash(es): the server (Caddy) doesn't collapse `//`, so a
    // serverUrl like "https://host/" would build "//api/auth/..." → HTTP 404.
    const base = serverUrl.trim().replace(/\/+$/, '')
    await window.connector?.serverConfig.set({ serverUrl: base })
    try {
      // Send the stored JWT so the status reflects THIS connector's session — an
      // unauthenticated /status always reads "로그인 필요" even when we're logged in.
      const token = await window.connector?.secureStore.get(TOKEN_KEY)
      const r = await fetch(`${base}/api/auth/status`, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined)
      const j = await r.json()
      if (token && !j.is_authenticated) {
        // Stored token is dead — drop it so the UI shows a clean login prompt
        // instead of the confusing "토큰이 저장됨" + "로그인 필요" combination.
        await window.connector?.secureStore.delete(TOKEN_KEY)
        setHasToken(false)
      } else {
        setHasToken(j.is_authenticated)
      }
      stat(j.is_authenticated ? t('status.connectedAuthed') : j.has_users ? t('status.connectedLoginNeeded') : t('status.connectedSetupNeeded'), 'ok')
    } catch (e) {
      stat(t('status.connectFailed', { msg: (e as Error).message }), 'err')
    } finally {
      setBusy(false)
    }
  }

  const login = async () => {
    setBusy(true)
    stat(t('status.loggingIn'), 'working')
    // Normalize the same way as checkStatus — a trailing slash → "//api/..." 404.
    const base = serverUrl.trim().replace(/\/+$/, '')
    try {
      const r = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      if (!r.ok) {
        stat(t('status.loginFailedHttp', { code: r.status }), 'err')
        return
      }
      const j = await r.json()
      await window.connector?.secureStore.set(TOKEN_KEY, j.access_token)
      setHasToken(true)
      setPassword('')
      stat(t('status.loginOk', { username: j.username }), 'ok')
      window.connector?.windowControl.refresh()
    } catch (e) {
      stat(t('status.loginError', { msg: (e as Error).message }), 'err')
    } finally {
      setBusy(false)
    }
  }

  const logout = async () => {
    await window.connector?.secureStore.delete(TOKEN_KEY)
    setHasToken(false)
    stat(t('status.loggedOut'), 'idle')
    window.connector?.windowControl.refresh()
  }

  const host = (() => {
    try {
      return new URL(serverUrl).host
    } catch {
      return serverUrl
    }
  })()

  const pillCls =
    statusKind === 'ok' ? 'is-ok' : statusKind === 'err' ? 'is-err' : statusKind === 'working' ? 'is-working' : ''

  return (
    <div className={`control-root gy ${resolvedDark ? '' : 'gy--light'}`}>
      <div className="gy-wrap">
        <header className="gy-head">
          <img className="gy-logo" src={genyIcon} alt="Geny" draggable={false} />
          <div>
            <h1>Geny</h1>
            <div className="gy-sub">{t('app.subtitle')}</div>
          </div>
        </header>

        <nav className="gy-tabs" role="tablist">
          <button className={`gy-tab ${tab === 'account' ? 'is-active' : ''}`} onClick={() => setTab('account')}>
            {I.user} {t('tab.account')}
          </button>
          <button className={`gy-tab ${tab === 'voice' ? 'is-active' : ''}`} onClick={() => setTab('voice')}>
            {I.mic} {t('tab.voice')}
          </button>
          <button className={`gy-tab ${tab === 'control' ? 'is-active' : ''}`} onClick={() => setTab('control')}>
            {I.monitor} {t('tab.control')}
          </button>
          <button className={`gy-tab ${tab === 'mcp' ? 'is-active' : ''}`} onClick={() => setTab('mcp')}>
            {I.plug} {t('tab.mcp')}
          </button>
          <button className={`gy-tab ${tab === 'app' ? 'is-active' : ''}`} onClick={() => setTab('app')}>
            {I.sliders} {t('tab.app')}
          </button>
        </nav>

        {/* ─────────────── 계정 ─────────────── */}
        {tab === 'account' && (
          <>
            <section className="gy-card">
              <div className="gy-card-h">{I.link} {t('account.serverCard')}</div>
              <label className="gy-field-label" htmlFor="gy-url">{t('account.serverUrlLabel')}</label>
              <input
                id="gy-url"
                className="gy-input"
                value={serverUrl}
                onChange={(e) => setServerUrl(e.target.value)}
                placeholder="https://your-geny-server.com"
                spellCheck={false}
              />
              <div className="gy-spacer" />
              <div className="gy-row">
                <span className={`gy-pill grow ${pillCls}`}>
                  <span className="gy-dot" />
                  <span className="gy-msg">{status || t('status.initial')}</span>
                </span>
                <button className="gy-btn gy-btn--ghost gy-btn--sm" onClick={checkStatus} disabled={busy}>
                  {I.refresh} {t('account.checkConnection')}
                </button>
              </div>
              {serverUrl.trim() && (
                <>
                  <div className="gy-spacer" />
                  <button
                    className="gy-btn gy-btn--ghost gy-btn--block gy-btn--sm"
                    onClick={() => window.connector?.windowControl.openExternal(serverUrl.trim())}
                  >
                    {I.external} {t('account.openInBrowser')}
                  </button>
                </>
              )}
            </section>

            <section className="gy-card">
              <div className="gy-card-h">{I.user} {t('account.accountCard')}</div>
              {hasToken ? (
                <div className="gy-row">
                  <span className="gy-pill grow is-ok">
                    <span className="gy-dot" />
                    <span className="gy-msg">{t('account.loggedIn')}</span>
                  </span>
                  <button className="gy-btn gy-btn--danger gy-btn--sm" onClick={logout}>{t('account.logout')}</button>
                </div>
              ) : (
                <>
                  <label className="gy-field-label" htmlFor="gy-id">{t('account.idLabel')}</label>
                  <input id="gy-id" className="gy-input" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="admin" autoComplete="username" />
                  <div className="gy-spacer" />
                  <label className="gy-field-label" htmlFor="gy-pw">{t('account.passwordLabel')}</label>
                  <input
                    id="gy-pw"
                    className="gy-input"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && !busy && login()}
                    autoComplete="current-password"
                  />
                  <div className="gy-spacer" />
                  <button className="gy-btn gy-btn--primary gy-btn--block" onClick={login} disabled={busy || !username || !password || !serverUrl.trim()}>
                    {host ? t('account.loginToHost', { host }) : t('account.login')}
                  </button>
                </>
              )}
            </section>
          </>
        )}

        {/* ─────────────── 음성 ─────────────── */}
        {tab === 'voice' && (
          <>
            <section className="gy-card">
              <div className="gy-card-h">{I.mic} {t('voice.pttCard')}</div>
              <p className="gy-hint" style={{ margin: '0 0 10px' }}>
                {t('voice.pttHint')}
              </p>
              <HotkeyCapture value={pttHotkey} onCapture={savePtt} t={t} />
              {pttMsg && <span className="gy-hint" style={{ margin: '8px 0 0', display: 'block' }}>{pttMsg}</span>}
            </section>

            <section className="gy-card">
              <div className="gy-card-h">{I.mic} {t('voice.ttsCard')}</div>
              <TuneSlider
                label={t('voice.volume')} min={0} max={1} step={0.05}
                value={tget('ttsVolume')} display={`${Math.round(tget('ttsVolume') * 100)}%`}
                onChange={(v) => patchTuning({ ttsVolume: v })}
              />
              <p className="gy-hint" style={{ margin: 0 }}>{t('voice.volumeHint')}</p>
            </section>

            <section className="gy-card">
              <div className="gy-card-h">{I.chat} {t('voice.subtitlesCard')}</div>
              <ToggleLine
                label={t('voice.subtitlesToggle')}
                checked={tget('subtitlesEnabled')}
                onChange={(c) => patchTuning({ subtitlesEnabled: c })}
              />
              <div style={{ height: 12 }} />
              <TuneSlider
                label={t('voice.subtitleSpeed')}
                min={30} max={300} step={10}
                value={tget('subtitleCharMs')}
                display={t('voice.subtitleSpeedDisplay', { sec: (tget('subtitleCharMs') / 1000).toFixed(2) })}
                onChange={(v) => patchTuning({ subtitleCharMs: v })}
              />
              <p className="gy-hint" style={{ margin: '4px 0 0' }}>
                {t('voice.subtitleHint')}
              </p>
            </section>

            <section className="gy-card">
              <div className="gy-card-h">{I.mic} {t('voice.sttCard')}</div>
              <TuneSlider
                label={t('voice.sttSensitivity')} min={0.01} max={0.1} step={0.005}
                value={tget('sttSensitivity')} display={tget('sttSensitivity').toFixed(3)}
                onChange={(v) => patchTuning({ sttSensitivity: v })}
              />
              <TuneSlider
                label={t('voice.sttSilence')} min={400} max={3000} step={100}
                value={tget('sttSilenceMs')} display={`${(tget('sttSilenceMs') / 1000).toFixed(1)}s`}
                onChange={(v) => patchTuning({ sttSilenceMs: v })}
              />
              <div className="gy-field-label" style={{ marginTop: 4 }}>{t('voice.soundCorrection')}</div>
              <ToggleLine label={t('voice.echoCancellation')} checked={tget('sttEchoCancellation')} onChange={(c) => patchTuning({ sttEchoCancellation: c })} />
              <ToggleLine label={t('voice.noiseSuppression')} checked={tget('sttNoiseSuppression')} onChange={(c) => patchTuning({ sttNoiseSuppression: c })} />
              <ToggleLine label={t('voice.autoGain')} checked={tget('sttAutoGain')} onChange={(c) => patchTuning({ sttAutoGain: c })} />
            </section>
          </>
        )}

        {/* ─────────────── 제어 (로컬 컴퓨터 제어) ─────────────── */}
        {tab === 'control' && (
          <>
            <section className="gy-card">
              <div className="gy-card-h">{I.monitor} {t('control.card')}</div>
              <p className="gy-hint" style={{ margin: '0 0 10px' }}>
                {t('control.hint')}
              </p>
              <ToggleLine
                label={t('control.masterToggle')}
                checked={cuOn}
                onChange={(c) => patchComputerUse({ enabled: c })}
              />
              {cuOn && (
                <>
                  <div style={{ height: 6 }} />
                  <ToggleLine
                    label={t('control.capScreen')}
                    checked={cuCap('screen')}
                    onChange={(c) => patchComputerUse({ screen: c })}
                  />
                  <ToggleLine
                    label={t('control.capInput')}
                    checked={cuCap('input')}
                    onChange={(c) => patchComputerUse({ input: c })}
                  />
                  <ToggleLine
                    label={t('control.capApps')}
                    checked={cuCap('apps')}
                    onChange={(c) => patchComputerUse({ apps: c })}
                  />
                  <ToggleLine
                    label={t('control.capClipboard')}
                    checked={cuCap('clipboard')}
                    onChange={(c) => patchComputerUse({ clipboard: c })}
                  />
                  <div style={{ height: 12 }} />
                  <div className="gy-hint" style={{ margin: '0 0 6px' }}>{t('control.consentTitle')}</div>
                  <div className="gy-tabs" role="tablist" style={{ margin: 0 }}>
                    {([
                      ['ask', t('control.consentAsk')],
                      ['session', t('control.consentSession')],
                      ['auto', t('control.consentAuto')],
                    ] as [ConsentMode, string][]).map(([mode, label]) => (
                      <button
                        key={mode}
                        className={`gy-tab ${(computerUse.consentMode ?? 'ask') === mode ? 'is-active' : ''}`}
                        onClick={() => patchComputerUse({ consentMode: mode })}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <p className="gy-hint" style={{ margin: '8px 0 0' }}>
                    {boldTokens(t('control.consentHint', {
                      ask: BOLD0 + t('control.consentHint.ask') + BOLD1,
                      auto: BOLD0 + t('control.consentHint.auto') + BOLD1,
                    }))}
                  </p>
                </>
              )}
            </section>
          </>
        )}

        {/* ─────────────── MCP (로컬 MCP 서버) ─────────────── */}
        {tab === 'mcp' && (
          <>
            <section className="gy-card">
              <div className="gy-card-h">{I.plug} {t('mcp.serversCard')}</div>
              <p className="gy-hint" style={{ margin: '0 0 12px' }}>
                {t('mcp.serversHint')}
              </p>

              {mcpServers.length === 0 && (
                <p className="gy-hint" style={{ margin: '0 0 12px', opacity: 0.7 }}>{t('mcp.empty')}</p>
              )}
              {mcpServers.map((s) => (
                <div key={s.name} className="gy-card" style={{ marginBottom: 8, padding: '10px 12px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600 }}>{s.name} <span className="gy-hint">· {s.transport}</span></div>
                      <div className="gy-hint" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {s.transport === 'stdio' ? s.command : s.url}
                      </div>
                      {mcpTest[s.name] && <div className="gy-hint" style={{ marginTop: 4 }}>{mcpTest[s.name]}</div>}
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                      <button className="gy-btn gy-btn--ghost gy-btn--sm" onClick={() => testMcpServer(s)}>{t('mcp.test')}</button>
                      <button className="gy-btn gy-btn--danger gy-btn--sm" onClick={() => removeMcpServer(s.name)}>{t('mcp.remove')}</button>
                    </div>
                  </div>
                </div>
              ))}
            </section>

            <section className="gy-card">
              <div className="gy-card-h">{I.plug} {t('mcp.addCard')}</div>
              <input
                className="gy-input" placeholder={t('mcp.namePlaceholder')} value={mcpForm.name}
                onChange={(e) => setMcpForm((p) => ({ ...p, name: e.target.value }))}
              />
              <div style={{ height: 8 }} />
              <div className="gy-tabs" role="tablist" style={{ margin: 0 }}>
                {(['stdio', 'http'] as const).map((tr) => (
                  <button key={tr} className={`gy-tab ${mcpForm.transport === tr ? 'is-active' : ''}`}
                    onClick={() => setMcpForm((p) => ({ ...p, transport: tr }))}>{tr}</button>
                ))}
              </div>
              <div style={{ height: 8 }} />
              {mcpForm.transport === 'stdio' ? (
                <input
                  className="gy-input" placeholder={t('mcp.commandPlaceholder')}
                  value={mcpForm.command ?? ''}
                  onChange={(e) => setMcpForm((p) => ({ ...p, command: e.target.value }))}
                />
              ) : (
                <input
                  className="gy-input" placeholder={t('mcp.urlPlaceholder')}
                  value={mcpForm.url ?? ''}
                  onChange={(e) => setMcpForm((p) => ({ ...p, url: e.target.value }))}
                />
              )}
              <div style={{ height: 10 }} />
              <button className="gy-btn gy-btn--primary" onClick={addMcpServer} disabled={!mcpForm.name.trim()}>{t('mcp.add')}</button>
              <p className="gy-hint" style={{ margin: '10px 0 0' }}>
                {markTokens(t('mcp.addHint', {
                  list: `${CODE0}local_mcp_list${CODE1}`,
                  call: `${CODE0}local_mcp_call${CODE1}`,
                }))}
              </p>
            </section>
          </>
        )}

        {/* ─────────────── 앱 ─────────────── */}
        {tab === 'app' && (
          <>
            <section className="gy-card">
              <div className="gy-card-h">{I.chat} {t('app.quickChatCard')}</div>
              <p className="gy-hint" style={{ margin: '0 0 10px' }}>
                {t('app.quickChatHint')}
              </p>
              <HotkeyCapture value={quickChatHotkey} onCapture={saveQuickChat} t={t} />
              {quickChatMsg && <span className="gy-hint" style={{ margin: '8px 0 0', display: 'block' }}>{quickChatMsg}</span>}
            </section>

            <section className="gy-card">
              <div className="gy-card-h">{I.monitor} {t('app.captureCard')}</div>
              <label className="gy-field-label" htmlFor="gy-cap-int">{t('app.captureInterval')}</label>
              <select
                id="gy-cap-int" className="gy-input" style={{ appearance: 'auto' }}
                value={String(tget('screenIntervalMs'))}
                onChange={(e) => patchTuning({ screenIntervalMs: Number(e.target.value) })}
              >
                {INTERVAL_OPTIONS.map((o) => (
                  <option key={o.ms} value={String(o.ms)}>{t(o.key)}</option>
                ))}
              </select>
              <div className="gy-spacer" />
              <label className="gy-field-label" htmlFor="gy-cap-src">{t('app.captureSource')}</label>
              {sources.length > 0 ? (
                <select
                  id="gy-cap-src" className="gy-input" style={{ appearance: 'auto' }}
                  value={tget('screenSourceId') ?? ''}
                  onChange={(e) => patchTuning({ screenSourceId: e.target.value || null })}
                >
                  <option value="">{t('app.captureAuto')}</option>
                  {sources.map((s) => (
                    <option key={s.id} value={s.id}>
                      {(s.id.startsWith('screen:') ? '🖥 ' : '🪟 ') + (s.name || s.id)}
                    </option>
                  ))}
                </select>
              ) : (
                <p className="gy-hint" style={{ margin: 0 }}>{t('app.captureLoading')}</p>
              )}
              <p className="gy-hint">{t('app.captureHint')}</p>
            </section>

            <section className="gy-card">
              <div className="gy-card-h">{I.sliders} {t('app.themeCard')}</div>
              <nav className="gy-tabs" style={{ margin: 0 }} role="tablist">
                <button className={`gy-tab ${theme === 'system' ? 'is-active' : ''}`} onClick={() => changeTheme('system')}>
                  {I.monitor} {t('app.themeSystem')}
                </button>
                <button className={`gy-tab ${theme === 'dark' ? 'is-active' : ''}`} onClick={() => changeTheme('dark')}>
                  {I.moon} {t('app.themeDark')}
                </button>
                <button className={`gy-tab ${theme === 'light' ? 'is-active' : ''}`} onClick={() => changeTheme('light')}>
                  {I.sun} {t('app.themeLight')}
                </button>
              </nav>
              <p className="gy-hint" style={{ margin: '11px 0 0' }}>
                {t('app.themeHint')}
              </p>
            </section>

            <section className="gy-card">
              <div className="gy-card-h">{I.link} {t('app.langCard')}</div>
              <nav className="gy-tabs" style={{ margin: 0 }} role="tablist">
                <button className={`gy-tab ${lang === 'ko' ? 'is-active' : ''}`} onClick={() => changeLang('ko')}>
                  {t('app.langKo')}
                </button>
                <button className={`gy-tab ${lang === 'en' ? 'is-active' : ''}`} onClick={() => changeLang('en')}>
                  {t('app.langEn')}
                </button>
              </nav>
              <p className="gy-hint" style={{ margin: '11px 0 0' }}>
                {t('app.langHint')}
              </p>
            </section>

            <section className="gy-card">
              <div className="gy-card-h">{I.download} {t('app.updateCard')}</div>
              <div className="gy-toggle-line">
                <span className="label">{t('app.updateToggle')}</span>
                <label className="gy-switch">
                  <input type="checkbox" checked={autoUpdate} onChange={(e) => toggleAutoUpdate(e.target.checked)} />
                  <span className="track" />
                  <span className="thumb" />
                </label>
              </div>
              <p className="gy-hint">
                {autoUpdate ? t('app.updateHintOn') : t('app.updateHintOff')}
              </p>
              <button className="gy-btn gy-btn--ghost gy-btn--sm" onClick={() => window.connector?.updater.check()}>
                {I.refresh} {t('app.updateCheckNow')}
              </button>
            </section>

            <section className="gy-card">
              <div className="gy-card-h">{I.power} {t('app.autostartCard')}</div>
              <ToggleLine label={t('app.autostartToggle')} checked={autoStart} onChange={toggleAutoStart} />
              <p className="gy-hint" style={{ margin: '8px 0 0' }}>{t('app.autostartHint')}</p>
            </section>

            <section className="gy-card">
              <div className="gy-card-h">{I.monitor} {t('app.positionsCard')}</div>
              <p className="gy-hint" style={{ margin: '0 0 10px' }}>
                {t('app.positionsHint')}
              </p>
              <button
                className="gy-btn gy-btn--ghost gy-btn--block gy-btn--sm"
                onClick={() => {
                  window.connector?.windowControl.resetPositions?.()
                  setResetDone(true)
                  setTimeout(() => setResetDone(false), 2200)
                }}
              >
                {I.refresh} {t('app.positionsReset')}
              </button>
              {resetDone && (
                <p className="gy-hint" style={{ margin: '8px 0 0' }}>{t('app.positionsResetDone')}</p>
              )}
            </section>

            <section className="gy-card">
              <div className="gy-card-h">{I.sliders} {t('app.aboutCard')}</div>
              <div className="gy-kv">
                <span className="k">{t('app.version')}</span>
                <span className="v">{version ? `v${version}` : '—'}</span>
              </div>
              <div className="gy-kv">
                <span className="k">{t('app.server')}</span>
                <span className="v">{host || '—'}</span>
              </div>
              <div className="gy-spacer" />
              <button className="gy-btn gy-btn--ghost gy-btn--block" onClick={() => window.connector?.windowControl.restart()}>
                {I.power} {t('app.restart')}
              </button>
            </section>
          </>
        )}
      </div>
    </div>
  )
}

// ── tuning sub-components ─────────────────────────────────────────────────────
function TuneSlider({ label, value, min, max, step, display, onChange }: {
  label: string; value: number; min: number; max: number; step: number; display: string;
  onChange: (v: number) => void;
}) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
        <span className="gy-field-label" style={{ margin: 0 }}>{label}</span>
        <span className="gy-hint" style={{ margin: 0, fontVariantNumeric: 'tabular-nums' }}>{display}</span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ width: '100%', accentColor: 'var(--gy-accent, #4f7cff)', cursor: 'pointer' }}
      />
    </div>
  )
}

function ToggleLine({ label, checked, onChange }: {
  label: string; checked: boolean; onChange: (c: boolean) => void;
}) {
  return (
    <div className="gy-toggle-line">
      <span className="label">{label}</span>
      <label className="gy-switch">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span className="track" />
        <span className="thumb" />
      </label>
    </div>
  )
}
