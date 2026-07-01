import { useEffect, useState, type ReactNode, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import genyIcon from './assets/geny_character.png'
import type { OverlayTuning, ComputerUseConfig, ConsentMode, MCPServerConfig } from '../../preload/index'

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
  { ms: 60_000, label: '1분' },
  { ms: 180_000, label: '3분' },
  { ms: 300_000, label: '5분' },
  { ms: 600_000, label: '10분' },
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
function HotkeyCapture({ value, onCapture }: { value: string; onCapture: (acc: string) => void }) {
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
      {recording ? '키 조합을 누르세요…  (Esc 취소)' : (prettyAccel(value) || '클릭한 뒤 키 조합을 누르세요')}
    </button>
  )
}

export function ControlApp() {
  const [tab, setTab] = useState<Tab>('account')
  const [serverUrl, setServerUrl] = useState('')
  const [status, setStatus] = useState('연결 상태를 확인하세요')
  const [statusKind, setStatusKind] = useState<StatusKind>('idle')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [hasToken, setHasToken] = useState(false)
  const [autoUpdate, setAutoUpdate] = useState(true)
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
    window.connector?.serverConfig.get().then((c) => {
      setServerUrl(c.serverUrl)
      setThemeState(c.theme ?? 'system')
      setTuning(c.overlayTuning ?? {})
      setComputerUse(c.computerUse ?? {})
    })
    window.connector?.secureStore.get(TOKEN_KEY).then((t) => setHasToken(!!t))
    window.connector?.updater.getEnabled().then(setAutoUpdate)
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
    setMcpTest((p) => ({ ...p, [cfg.name]: '테스트 중…' }))
    const r = await window.connector?.mcp?.testServer(cfg)
    setMcpTest((p) => ({
      ...p,
      [cfg.name]: r?.ok ? `연결됨 · 도구 ${r.tools?.length ?? 0}개` : `실패: ${r?.error ?? '알 수 없음'}`,
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

  const changeTheme = (t: ThemeMode) => {
    setThemeState(t)
    window.connector?.serverConfig.set({ theme: t })
    // Reload the chat panel so the remote /connector page picks up ?theme.
    window.connector?.windowControl.reloadPanel()
  }

  const stat = (msg: string, kind: StatusKind) => {
    setStatus(msg)
    setStatusKind(kind)
  }

  const toggleAutoUpdate = async (next: boolean) => {
    setAutoUpdate(next)
    await window.connector?.updater.setEnabled(next)
  }

  const savePtt = async (acc: string) => {
    setPttHotkey(acc)
    const ok = await window.connector?.hotkeys.setPushToTalk(acc)
    setPttMsg(ok ? '✓ 단축키가 등록되었습니다' : '✗ 다른 앱과 충돌 — 다른 조합을 시도하세요')
  }

  const saveQuickChat = async (acc: string) => {
    setQuickChatHotkey(acc)
    const ok = await window.connector?.hotkeys.setQuickChat?.(acc)
    setQuickChatMsg(ok ? '✓ 단축키가 등록되었습니다' : '✗ 다른 앱과 충돌 — 다른 조합을 시도하세요')
  }

  const checkStatus = async () => {
    setBusy(true)
    stat('서버에 연결하는 중…', 'working')
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
      stat(j.is_authenticated ? '연결됨 · 로그인 상태' : j.has_users ? '연결됨 · 로그인 필요' : '연결됨 · 초기 설정 필요', 'ok')
    } catch (e) {
      stat(`연결 실패 — ${(e as Error).message}`, 'err')
    } finally {
      setBusy(false)
    }
  }

  const login = async () => {
    setBusy(true)
    stat('로그인하는 중…', 'working')
    // Normalize the same way as checkStatus — a trailing slash → "//api/..." 404.
    const base = serverUrl.trim().replace(/\/+$/, '')
    try {
      const r = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      if (!r.ok) {
        stat(`로그인 실패 — HTTP ${r.status}`, 'err')
        return
      }
      const j = await r.json()
      await window.connector?.secureStore.set(TOKEN_KEY, j.access_token)
      setHasToken(true)
      setPassword('')
      stat(`${j.username} 님으로 로그인됨 — 아바타를 불러옵니다`, 'ok')
      window.connector?.windowControl.refresh()
    } catch (e) {
      stat(`오류 — ${(e as Error).message}`, 'err')
    } finally {
      setBusy(false)
    }
  }

  const logout = async () => {
    await window.connector?.secureStore.delete(TOKEN_KEY)
    setHasToken(false)
    stat('로그아웃되었습니다', 'idle')
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
            <div className="gy-sub">VTuber 데스크톱 접속기</div>
          </div>
        </header>

        <nav className="gy-tabs" role="tablist">
          <button className={`gy-tab ${tab === 'account' ? 'is-active' : ''}`} onClick={() => setTab('account')}>
            {I.user} 계정
          </button>
          <button className={`gy-tab ${tab === 'voice' ? 'is-active' : ''}`} onClick={() => setTab('voice')}>
            {I.mic} 음성
          </button>
          <button className={`gy-tab ${tab === 'control' ? 'is-active' : ''}`} onClick={() => setTab('control')}>
            {I.monitor} 제어
          </button>
          <button className={`gy-tab ${tab === 'mcp' ? 'is-active' : ''}`} onClick={() => setTab('mcp')}>
            {I.plug} MCP
          </button>
          <button className={`gy-tab ${tab === 'app' ? 'is-active' : ''}`} onClick={() => setTab('app')}>
            {I.sliders} 앱
          </button>
        </nav>

        {/* ─────────────── 계정 ─────────────── */}
        {tab === 'account' && (
          <>
            <section className="gy-card">
              <div className="gy-card-h">{I.link} 서버 연결</div>
              <label className="gy-field-label" htmlFor="gy-url">서버 주소</label>
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
                  <span className="gy-msg">{status}</span>
                </span>
                <button className="gy-btn gy-btn--ghost gy-btn--sm" onClick={checkStatus} disabled={busy}>
                  {I.refresh} 연결 확인
                </button>
              </div>
              {serverUrl.trim() && (
                <>
                  <div className="gy-spacer" />
                  <button
                    className="gy-btn gy-btn--ghost gy-btn--block gy-btn--sm"
                    onClick={() => window.connector?.windowControl.openExternal(serverUrl.trim())}
                  >
                    {I.external} 브라우저에서 Geny 서버 열기
                  </button>
                </>
              )}
            </section>

            <section className="gy-card">
              <div className="gy-card-h">{I.user} 계정</div>
              {hasToken ? (
                <div className="gy-row">
                  <span className="gy-pill grow is-ok">
                    <span className="gy-dot" />
                    <span className="gy-msg">로그인됨 · 토큰이 키체인에 안전하게 저장됨</span>
                  </span>
                  <button className="gy-btn gy-btn--danger gy-btn--sm" onClick={logout}>로그아웃</button>
                </div>
              ) : (
                <>
                  <label className="gy-field-label" htmlFor="gy-id">아이디</label>
                  <input id="gy-id" className="gy-input" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="admin" autoComplete="username" />
                  <div className="gy-spacer" />
                  <label className="gy-field-label" htmlFor="gy-pw">비밀번호</label>
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
                    {host ? `${host} 에 로그인` : '로그인'}
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
              <div className="gy-card-h">{I.mic} 푸시투토크 단축키</div>
              <p className="gy-hint" style={{ margin: '0 0 10px' }}>
                탭하면 마이크가 켜지고, 다시 탭하면 꺼지거나 아바타의 말을 끊습니다.
                아래를 클릭한 뒤 원하는 키 조합을 누르세요.
              </p>
              <HotkeyCapture value={pttHotkey} onCapture={savePtt} />
              {pttMsg && <span className="gy-hint" style={{ margin: '8px 0 0', display: 'block' }}>{pttMsg}</span>}
            </section>

            <section className="gy-card">
              <div className="gy-card-h">{I.mic} TTS · 음성 출력</div>
              <TuneSlider
                label="볼륨" min={0} max={1} step={0.05}
                value={tget('ttsVolume')} display={`${Math.round(tget('ttsVolume') * 100)}%`}
                onChange={(v) => patchTuning({ ttsVolume: v })}
              />
              <p className="gy-hint" style={{ margin: 0 }}>아바타 창의 음성 출력 볼륨입니다.</p>
            </section>

            <section className="gy-card">
              <div className="gy-card-h">{I.chat} 대사창 (자막)</div>
              <ToggleLine
                label="아바타 하단에 대사 표시"
                checked={tget('subtitlesEnabled')}
                onChange={(c) => patchTuning({ subtitlesEnabled: c })}
              />
              <div style={{ height: 12 }} />
              <TuneSlider
                label="글자 출력 속도"
                min={30} max={300} step={10}
                value={tget('subtitleCharMs')}
                display={`${(tget('subtitleCharMs') / 1000).toFixed(2)}초/글자`}
                onChange={(v) => patchTuning({ subtitleCharMs: v })}
              />
              <p className="gy-hint" style={{ margin: '4px 0 0' }}>
                대사가 한 글자씩 흘러나오는 속도입니다(기본 0.10초/글자 — 왼쪽=빠름, 오른쪽=느림). 화면 캡처·자동
                대화 트리거로 한 번에 온 발화도 이 속도로 앞에서부터 타이핑됩니다. 길어지면 위에서부터 잘리고, 다
                흐른 뒤 약 3초 후 사라집니다(음성 켜져 있으면 음성이 끝난 뒤).
              </p>
            </section>

            <section className="gy-card">
              <div className="gy-card-h">{I.mic} STT · 음성 입력</div>
              <TuneSlider
                label="민감도 (낮을수록 더 민감)" min={0.01} max={0.1} step={0.005}
                value={tget('sttSensitivity')} display={tget('sttSensitivity').toFixed(3)}
                onChange={(v) => patchTuning({ sttSensitivity: v })}
              />
              <TuneSlider
                label="발화 종료 대기" min={400} max={3000} step={100}
                value={tget('sttSilenceMs')} display={`${(tget('sttSilenceMs') / 1000).toFixed(1)}s`}
                onChange={(v) => patchTuning({ sttSilenceMs: v })}
              />
              <div className="gy-field-label" style={{ marginTop: 4 }}>사운드 보정</div>
              <ToggleLine label="에코 제거" checked={tget('sttEchoCancellation')} onChange={(c) => patchTuning({ sttEchoCancellation: c })} />
              <ToggleLine label="노이즈 억제" checked={tget('sttNoiseSuppression')} onChange={(c) => patchTuning({ sttNoiseSuppression: c })} />
              <ToggleLine label="자동 게인" checked={tget('sttAutoGain')} onChange={(c) => patchTuning({ sttAutoGain: c })} />
            </section>
          </>
        )}

        {/* ─────────────── 제어 (로컬 컴퓨터 제어) ─────────────── */}
        {tab === 'control' && (
          <>
            <section className="gy-card">
              <div className="gy-card-h">{I.monitor} 로컬 컴퓨터 제어</div>
              <p className="gy-hint" style={{ margin: '0 0 10px' }}>
                이 접속기가 프록시가 되어, 서버에 떠 있는 Geny 에이전트가 내 컴퓨터를 보고 조작할 수
                있게 합니다. 실행은 항상 이 컴퓨터에서 아래 동의에 따라 이뤄집니다(서버는 중계만 함). 접속기가
                꺼지면 안전하게 차단됩니다. 에이전트가 실제로 쓰려면 해당 환경에서도 이 기능을 켜야 합니다.
              </p>
              <ToggleLine
                label="로컬 컴퓨터 제어 허용 (마스터)"
                checked={cuOn}
                onChange={(c) => patchComputerUse({ enabled: c })}
              />
              {cuOn && (
                <>
                  <div style={{ height: 6 }} />
                  <ToggleLine
                    label="화면 보기 (캡처·창 목록, 읽기 전용)"
                    checked={cuCap('screen')}
                    onChange={(c) => patchComputerUse({ screen: c })}
                  />
                  <ToggleLine
                    label="입력 조작 (타이핑·키·클릭)"
                    checked={cuCap('input')}
                    onChange={(c) => patchComputerUse({ input: c })}
                  />
                  <ToggleLine
                    label="앱·URL 열기"
                    checked={cuCap('apps')}
                    onChange={(c) => patchComputerUse({ apps: c })}
                  />
                  <ToggleLine
                    label="클립보드 쓰기"
                    checked={cuCap('clipboard')}
                    onChange={(c) => patchComputerUse({ clipboard: c })}
                  />
                  <div style={{ height: 12 }} />
                  <div className="gy-hint" style={{ margin: '0 0 6px' }}>조작 동의 방식</div>
                  <div className="gy-tabs" role="tablist" style={{ margin: 0 }}>
                    {([
                      ['ask', '항상 확인'],
                      ['session', '이 세션 동안 허용'],
                      ['auto', '자동 허용'],
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
                    화면 보기는 읽기 전용이라 확인 없이 즉시 동작합니다. 타이핑·클릭·앱 열기·클립보드는 위
                    설정을 따릅니다. <b>항상 확인</b>이 가장 안전하며, 확인 창에서 “이 세션 동안 허용”을
                    누르면 그 동작은 접속기를 끌 때까지 다시 묻지 않습니다. <b>자동 허용</b>은 매우 위험하니
                    신뢰하는 작업에만 쓰세요.
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
              <div className="gy-card-h">{I.plug} 로컬 MCP 서버</div>
              <p className="gy-hint" style={{ margin: '0 0 12px' }}>
                내 컴퓨터에서 도는 MCP 서버를 등록하면, 이 접속기가 통로가 되어 서버의 Geny 에이전트가 그
                도구를 사용할 수 있습니다(로컬 파일·앱·DB 등). 등록한 서버는 이 컴퓨터에만 저장되고, 서버에는
                도구 목록만 전달됩니다.
              </p>

              {mcpServers.length === 0 && (
                <p className="gy-hint" style={{ margin: '0 0 12px', opacity: 0.7 }}>등록된 MCP 서버가 없습니다.</p>
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
                      <button className="gy-btn gy-btn--ghost gy-btn--sm" onClick={() => testMcpServer(s)}>테스트</button>
                      <button className="gy-btn gy-btn--danger gy-btn--sm" onClick={() => removeMcpServer(s.name)}>삭제</button>
                    </div>
                  </div>
                </div>
              ))}
            </section>

            <section className="gy-card">
              <div className="gy-card-h">{I.plug} 서버 추가</div>
              <input
                className="gy-input" placeholder="이름 (예: filesystem)" value={mcpForm.name}
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
                  className="gy-input" placeholder="명령 (예: npx -y @modelcontextprotocol/server-filesystem /path)"
                  value={mcpForm.command ?? ''}
                  onChange={(e) => setMcpForm((p) => ({ ...p, command: e.target.value }))}
                />
              ) : (
                <input
                  className="gy-input" placeholder="URL (예: http://localhost:3000/mcp)"
                  value={mcpForm.url ?? ''}
                  onChange={(e) => setMcpForm((p) => ({ ...p, url: e.target.value }))}
                />
              )}
              <div style={{ height: 10 }} />
              <button className="gy-btn gy-btn--primary" onClick={addMcpServer} disabled={!mcpForm.name.trim()}>추가</button>
              <p className="gy-hint" style={{ margin: '10px 0 0' }}>
                stdio는 로컬에서 명령으로 실행되는 MCP 서버, http는 이미 떠 있는 MCP 엔드포인트입니다. 추가 후
                “테스트”로 연결과 도구 목록을 확인하세요. 에이전트는 <code>local_mcp_list</code>로 도구를 찾고
                <code>local_mcp_call</code>로 호출합니다.
              </p>
            </section>
          </>
        )}

        {/* ─────────────── 앱 ─────────────── */}
        {tab === 'app' && (
          <>
            <section className="gy-card">
              <div className="gy-card-h">{I.chat} 빠른 채팅 단축키</div>
              <p className="gy-hint" style={{ margin: '0 0 10px' }}>
                어디서든 이 단축키를 누르면 입력창이 떠오르고, 메시지를 입력해 현재 VTuber에게 바로 보냅니다.
                아래를 클릭한 뒤 원하는 키 조합을 누르세요. 자주 안 쓰는 조합을 권장합니다(기본: Cmd/Ctrl+Shift+Enter).
              </p>
              <HotkeyCapture value={quickChatHotkey} onCapture={saveQuickChat} />
              {quickChatMsg && <span className="gy-hint" style={{ margin: '8px 0 0', display: 'block' }}>{quickChatMsg}</span>}
            </section>

            <section className="gy-card">
              <div className="gy-card-h">{I.monitor} 화면 캡처 관찰</div>
              <label className="gy-field-label" htmlFor="gy-cap-int">캡처 주기</label>
              <select
                id="gy-cap-int" className="gy-input" style={{ appearance: 'auto' }}
                value={String(tget('screenIntervalMs'))}
                onChange={(e) => patchTuning({ screenIntervalMs: Number(e.target.value) })}
              >
                {INTERVAL_OPTIONS.map((o) => (
                  <option key={o.ms} value={String(o.ms)}>{o.label}</option>
                ))}
              </select>
              <div className="gy-spacer" />
              <label className="gy-field-label" htmlFor="gy-cap-src">볼 화면/창</label>
              {sources.length > 0 ? (
                <select
                  id="gy-cap-src" className="gy-input" style={{ appearance: 'auto' }}
                  value={tget('screenSourceId') ?? ''}
                  onChange={(e) => patchTuning({ screenSourceId: e.target.value || null })}
                >
                  <option value="">자동 (첫 번째 화면)</option>
                  {sources.map((s) => (
                    <option key={s.id} value={s.id}>
                      {(s.id.startsWith('screen:') ? '🖥 ' : '🪟 ') + (s.name || s.id)}
                    </option>
                  ))}
                </select>
              ) : (
                <p className="gy-hint" style={{ margin: 0 }}>화면 목록을 불러오는 중…</p>
              )}
              <p className="gy-hint">캡처는 16:9 · 약 1600×900으로 축소되어 업로드됩니다.</p>
            </section>

            <section className="gy-card">
              <div className="gy-card-h">{I.sliders} 화면 테마</div>
              <nav className="gy-tabs" style={{ margin: 0 }} role="tablist">
                <button className={`gy-tab ${theme === 'system' ? 'is-active' : ''}`} onClick={() => changeTheme('system')}>
                  {I.monitor} 시스템
                </button>
                <button className={`gy-tab ${theme === 'dark' ? 'is-active' : ''}`} onClick={() => changeTheme('dark')}>
                  {I.moon} 다크
                </button>
                <button className={`gy-tab ${theme === 'light' ? 'is-active' : ''}`} onClick={() => changeTheme('light')}>
                  {I.sun} 라이트
                </button>
              </nav>
              <p className="gy-hint" style={{ margin: '11px 0 0' }}>
                설정·채팅 창에 함께 적용됩니다. ‘시스템’은 OS 설정을 따릅니다.
              </p>
            </section>

            <section className="gy-card">
              <div className="gy-card-h">{I.download} 자동 업데이트</div>
              <div className="gy-toggle-line">
                <span className="label">자동 업데이트</span>
                <label className="gy-switch">
                  <input type="checkbox" checked={autoUpdate} onChange={(e) => toggleAutoUpdate(e.target.checked)} />
                  <span className="track" />
                  <span className="thumb" />
                </label>
              </div>
              <p className="gy-hint">
                {autoUpdate
                  ? '새 버전을 자동으로 내려받아 재시작 시 설치합니다.'
                  : '자동 설치는 끄고, 새 버전이 있으면 알림만 띄웁니다.'}
              </p>
              <button className="gy-btn gy-btn--ghost gy-btn--sm" onClick={() => window.connector?.updater.check()}>
                {I.refresh} 지금 업데이트 확인
              </button>
            </section>

            <section className="gy-card">
              <div className="gy-card-h">{I.monitor} 창 · 아바타 위치</div>
              <p className="gy-hint" style={{ margin: '0 0 10px' }}>
                아바타·채팅·설정 창의 위치/크기와 아바타 확대·이동을 기본값으로 되돌립니다.
                멀티모니터나 배율(100%/150%) 변경으로 창이 화면 밖으로 나가거나 깨졌을 때 사용하세요.
              </p>
              <button
                className="gy-btn gy-btn--ghost gy-btn--block gy-btn--sm"
                onClick={() => {
                  window.connector?.windowControl.resetPositions?.()
                  setResetDone(true)
                  setTimeout(() => setResetDone(false), 2200)
                }}
              >
                {I.refresh} 창 · 아바타 위치 초기화
              </button>
              {resetDone && (
                <p className="gy-hint" style={{ margin: '8px 0 0' }}>✓ 기본 위치로 되돌렸습니다</p>
              )}
            </section>

            <section className="gy-card">
              <div className="gy-card-h">{I.sliders} 정보</div>
              <div className="gy-kv">
                <span className="k">버전</span>
                <span className="v">{version ? `v${version}` : '—'}</span>
              </div>
              <div className="gy-kv">
                <span className="k">서버</span>
                <span className="v">{host || '—'}</span>
              </div>
              <div className="gy-spacer" />
              <button className="gy-btn gy-btn--ghost gy-btn--block" onClick={() => window.connector?.windowControl.restart()}>
                {I.power} 접속기 재시작
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
