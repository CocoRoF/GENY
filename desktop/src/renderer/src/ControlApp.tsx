import { useEffect, useState } from 'react'

// ─────────────────────────────────────────────────────────────────────────────
// Settings window — server connection, account (keychain JWT), auto-update,
// and the global push-to-talk hotkey. Polished card-based UI; cohesive with the
// web app's zinc-dark + blue accent (see .gy tokens in styles.css).
// ─────────────────────────────────────────────────────────────────────────────

const TOKEN_KEY = 'geny_auth_token'

type StatusKind = 'idle' | 'working' | 'ok' | 'err'

// ── tiny inline icons (currentColor) ─────────────────────────────────────────
const I = {
  link: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  ),
  user: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  ),
  download: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  ),
  mic: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="2" width="6" height="11" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0M12 17v4" />
    </svg>
  ),
  refresh: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5" />
    </svg>
  ),
}

export function ControlApp() {
  const [serverUrl, setServerUrl] = useState('https://geny-x.hrletsgo.me')
  const [status, setStatus] = useState('연결 상태를 확인하세요')
  const [statusKind, setStatusKind] = useState<StatusKind>('idle')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [hasToken, setHasToken] = useState(false)
  const [autoUpdate, setAutoUpdate] = useState(true)
  const [pttHotkey, setPttHotkey] = useState('CommandOrControl+Shift+Space')
  const [pttMsg, setPttMsg] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    window.connector?.serverConfig.get().then((c) => setServerUrl(c.serverUrl))
    window.connector?.secureStore.get(TOKEN_KEY).then((t) => setHasToken(!!t))
    window.connector?.updater.getEnabled().then(setAutoUpdate)
    window.connector?.hotkeys.getPushToTalk().then((h) => h && setPttHotkey(h))
  }, [])

  const stat = (msg: string, kind: StatusKind) => {
    setStatus(msg)
    setStatusKind(kind)
  }

  const toggleAutoUpdate = async (next: boolean) => {
    setAutoUpdate(next)
    await window.connector?.updater.setEnabled(next)
  }

  const savePtt = async () => {
    const ok = await window.connector?.hotkeys.setPushToTalk(pttHotkey)
    setPttMsg(ok ? '✓ 단축키가 등록되었습니다' : '✗ 다른 앱과 충돌 — 다른 조합을 시도하세요')
  }

  const checkStatus = async () => {
    setBusy(true)
    stat('서버에 연결하는 중…', 'working')
    await window.connector?.serverConfig.set({ serverUrl })
    try {
      const r = await fetch(`${serverUrl}/api/auth/status`)
      const j = await r.json()
      stat(
        j.is_authenticated ? '연결됨 · 로그인 상태' : j.has_users ? '연결됨 · 로그인 필요' : '연결됨 · 초기 설정 필요',
        'ok',
      )
    } catch (e) {
      stat(`연결 실패 — ${(e as Error).message}`, 'err')
    } finally {
      setBusy(false)
    }
  }

  const login = async () => {
    setBusy(true)
    stat('로그인하는 중…', 'working')
    try {
      const r = await fetch(`${serverUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      if (!r.ok) {
        stat(`로그인 실패 — HTTP ${r.status}`, 'err')
        return
      }
      const j = await r.json()
      // Desktop stores the account JWT in the OS keychain (not the password).
      await window.connector?.secureStore.set(TOKEN_KEY, j.access_token)
      setHasToken(true)
      setPassword('')
      stat(`${j.username} 님으로 로그인됨 — 아바타를 불러옵니다`, 'ok')
      // Reload the overlay so it loads the server's avatar page with the token.
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

  return (
    <div className="control-root gy">
      <header className="gy-head">
        <div className="gy-logo">G</div>
        <div>
          <h1>Geny</h1>
          <div className="gy-sub">VTuber 데스크톱 접속기</div>
        </div>
      </header>

      {/* ── 서버 연결 ── */}
      <section className="gy-card">
        <div className="gy-card-h">{I.link} 서버 연결</div>
        <label className="gy-field-label" htmlFor="gy-url">서버 주소</label>
        <input
          id="gy-url"
          className="gy-input"
          value={serverUrl}
          onChange={(e) => setServerUrl(e.target.value)}
          placeholder="https://your-geny-server"
          spellCheck={false}
        />
        <div className="gy-spacer" />
        <div className="gy-row">
          <span className={`gy-pill grow ${statusKind === 'ok' ? 'is-ok' : statusKind === 'err' ? 'is-err' : statusKind === 'working' ? 'is-working' : ''}`}>
            <span className="gy-dot" />
            <span className="gy-msg">{status}</span>
          </span>
          <button className="gy-btn gy-btn--ghost gy-btn--sm" onClick={checkStatus} disabled={busy}>
            {I.refresh} 연결 확인
          </button>
        </div>
      </section>

      {/* ── 계정 ── */}
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
            <button className="gy-btn gy-btn--primary gy-btn--block" onClick={login} disabled={busy || !username || !password}>
              {host} 에 로그인
            </button>
          </>
        )}
      </section>

      {/* ── 자동 업데이트 ── */}
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

      {/* ── 푸시투토크 ── */}
      <section className="gy-card">
        <div className="gy-card-h">{I.mic} 푸시투토크 단축키</div>
        <p className="gy-hint" style={{ margin: '0 0 9px' }}>
          탭하면 마이크가 켜지고, 다시 탭하면 꺼지거나 아바타의 말을 끊습니다.
        </p>
        <input
          className="gy-input mono"
          value={pttHotkey}
          onChange={(e) => setPttHotkey(e.target.value)}
          placeholder="CommandOrControl+Shift+Space"
          spellCheck={false}
        />
        <div className="gy-spacer" />
        <div className="gy-row">
          <button className="gy-btn gy-btn--ghost gy-btn--sm" onClick={savePtt}>단축키 저장</button>
          {pttMsg && <span className="gy-hint" style={{ margin: 0 }}>{pttMsg}</span>}
        </div>
      </section>

      <button className="gy-btn gy-btn--ghost gy-btn--block" onClick={() => window.connector?.windowControl.restart()}>
        {I.refresh} 접속기 재시작
      </button>
    </div>
  )
}
