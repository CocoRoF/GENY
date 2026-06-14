import { useEffect, useState } from 'react'

// ─────────────────────────────────────────────────────────────────────────────
// Control window (Phase 0 stub).
//
// First-run flow per PLAN §3.2: enter server URL → GET /api/auth/status →
// setup (first run) or login → JWT to the OS keychain via the bridge. The full
// chat panel / model selector / TTS-STT toggles (ported from frontend/src)
// arrive in Phase 2; this stub wires server-URL + login so the overlay can
// authenticate against the now-gated WS/REST API.
// ─────────────────────────────────────────────────────────────────────────────

const TOKEN_KEY = 'geny_auth_token'

export function ControlApp() {
  const [serverUrl, setServerUrl] = useState('https://geny-x.hrletsgo.me')
  const [status, setStatus] = useState<string>('idle')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [hasToken, setHasToken] = useState(false)

  useEffect(() => {
    window.connector?.serverConfig.get().then((c) => setServerUrl(c.serverUrl))
    window.connector?.secureStore.get(TOKEN_KEY).then((t) => setHasToken(!!t))
  }, [])

  const checkStatus = async () => {
    setStatus('checking…')
    await window.connector?.serverConfig.set({ serverUrl })
    try {
      const r = await fetch(`${serverUrl}/api/auth/status`)
      const j = await r.json()
      setStatus(`has_users=${j.has_users} authenticated=${j.authenticated}`)
    } catch (e) {
      setStatus(`unreachable: ${(e as Error).message}`)
    }
  }

  const login = async () => {
    setStatus('logging in…')
    try {
      const r = await fetch(`${serverUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      if (!r.ok) {
        setStatus(`login failed: HTTP ${r.status}`)
        return
      }
      const j = await r.json()
      // Desktop stores the account JWT in the OS keychain (not the password).
      await window.connector?.secureStore.set(TOKEN_KEY, j.access_token)
      setHasToken(true)
      setStatus(`logged in as ${j.username}`)
    } catch (e) {
      setStatus(`error: ${(e as Error).message}`)
    }
  }

  const logout = async () => {
    await window.connector?.secureStore.delete(TOKEN_KEY)
    setHasToken(false)
    setStatus('logged out')
  }

  return (
    <div className="control-root">
      <h1>Geny</h1>
      <label className="row">
        <span>서버 URL</span>
        <input value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} placeholder="http://host:8000" />
      </label>
      <button onClick={checkStatus}>연결 확인</button>

      <hr />
      {hasToken ? (
        <>
          <p className="ok">토큰 저장됨 (keychain)</p>
          <button onClick={logout}>로그아웃</button>
        </>
      ) : (
        <>
          <label className="row">
            <span>아이디</span>
            <input value={username} onChange={(e) => setUsername(e.target.value)} />
          </label>
          <label className="row">
            <span>비밀번호</span>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          <button onClick={login}>로그인</button>
        </>
      )}
      <p className="status">{status}</p>
    </div>
  )
}
