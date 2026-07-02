import { useEffect, useRef, useState } from 'react'
import { makeT, type Lang } from './i18n'

// ─────────────────────────────────────────────────────────────────────────────
// Overlay (Phase 0 parity shell).
//
// Proves the hard part end-to-end: a transparent, frameless, always-on-top,
// click-through window where ONLY the dock handle is interactive, the handle
// drags the window, and the renderer reads the server URL from the native
// bridge. The real <AvatarCanvas> mounts into #avatar-stage next (the Phase 0
// parity spike — see README §"Reusing the browser renderer").
//
// Click-through model: the whole window is mouse-ignoring by default; entering
// an interactive region (the handle, later the avatar silhouette) flips
// setClickThrough(false), leaving flips it back. Hysteresis avoids edge flicker.
// ─────────────────────────────────────────────────────────────────────────────

export function OverlayApp() {
  const [serverUrl, setServerUrl] = useState<string>('')
  const [lang, setLang] = useState<Lang>('ko')
  const t = makeT(lang)
  const handleRef = useRef<HTMLButtonElement | null>(null)
  const dragging = useRef<{ x: number; y: number } | null>(null)

  useEffect(() => {
    let osLang: Lang = 'ko'
    window.connector?.serverConfig.get().then(async (c) => {
      setServerUrl(c.serverUrl)
      osLang = (await window.connector?.appDefaultLang?.().catch(() => 'ko' as Lang)) ?? 'ko'
      setLang(c.lang ?? osLang)
    })
    // Re-localize live when the language (or server URL) changes in settings.
    const off = window.connector?.serverConfig.onChange?.((c) => {
      setServerUrl(c.serverUrl)
      setLang(c.lang ?? osLang)
    })
    return () => { off?.() }
  }, [])

  // Interactive-region hit testing: enable input over the handle, pass through
  // everywhere else.
  const enterInteractive = () => window.connector?.windowControl.setClickThrough(false)
  const leaveInteractive = () => {
    if (!dragging.current) window.connector?.windowControl.setClickThrough(true)
  }

  // Dock-handle drag → move the OS window via the bridge.
  const onHandleDown = (e: React.MouseEvent) => {
    dragging.current = { x: e.screenX, y: e.screenY }
    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return
      const dx = ev.screenX - dragging.current.x
      const dy = ev.screenY - dragging.current.y
      dragging.current = { x: ev.screenX, y: ev.screenY }
      window.connector?.windowControl.moveBy(dx, dy)
    }
    const onUp = () => {
      dragging.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      leaveInteractive()
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <div className="overlay-root">
      {/* Avatar stage — <AvatarCanvas backgroundAlpha={0}> mounts here next. */}
      <div id="avatar-stage" className="avatar-stage" onMouseEnter={enterInteractive} onMouseLeave={leaveInteractive}>
        <div className="parity-card">
          <div className="parity-title">Geny</div>
          <div className="parity-sub">{serverUrl || '…'}</div>
          <div className="parity-hint">{t('overlay.loginHint')}</div>
        </div>
      </div>

      {/* Dock handle: always interactive; drag to move, click toggles control. */}
      <button
        ref={handleRef}
        className="dock-handle"
        onMouseEnter={enterInteractive}
        onMouseLeave={leaveInteractive}
        onMouseDown={onHandleDown}
        onDoubleClick={() => window.connector?.windowControl.openSettings()}
        title={t('overlay.handleTitle')}
      >
        <span className="dock-dot" />
      </button>
    </div>
  )
}
