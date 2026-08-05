/**
 * ChipApp — the locked avatar's controls, in their own tiny window.
 *
 * A locked avatar must let clicks reach the desktop on every platform,
 * so the avatar window is input-transparent — and an input-transparent
 * window cannot host its own unlock button. The chip therefore lives in
 * a separate always-interactive window that follows the avatar.
 *
 * It is rendered by the CONNECTOR, not by the server's overlay page.
 * Loading that page here crashed the app outright (measured: creating the
 * window is harmless, loading the overlay bundle into it is fatal — a
 * second copy of the avatar runtime, WebGL context and drivers in a
 * 104×40 window). Three buttons do not need any of that, and a local
 * chip also works before login and costs no network.
 */
import { useEffect, useRef } from 'react'

const BAR: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 2,
  padding: '4px 6px',
  borderRadius: 999,
  background: 'rgba(18,18,22,0.82)',
  border: '1px solid rgba(255,255,255,0.10)',
  backdropFilter: 'blur(8px)',
  WebkitBackdropFilter: 'blur(8px)',
  cursor: 'move',
  userSelect: 'none',
}

const BTN: React.CSSProperties = {
  display: 'grid',
  placeItems: 'center',
  width: 28,
  height: 28,
  borderRadius: 999,
  border: 'none',
  background: 'transparent',
  color: 'rgba(255,255,255,0.86)',
  cursor: 'pointer',
  padding: 0,
}

function Svg({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  )
}

export function ChipApp(): React.ReactElement {
  const ref = useRef<HTMLDivElement | null>(null)

  // Main sizes and positions the window around whatever this renders, so
  // it has to be told the size — including when the theme/zoom changes it.
  useEffect(() => {
    const report = (): void => {
      const r = ref.current?.getBoundingClientRect()
      if (r && r.width > 0) {
        window.connector?.windowControl.chipSize(Math.ceil(r.width) + 2, Math.ceil(r.height) + 2)
      }
    }
    report()
    const t = setInterval(report, 1500)
    window.addEventListener('resize', report)
    return () => {
      clearInterval(t)
      window.removeEventListener('resize', report)
    }
  }, [])

  // Dragging the chip moves the AVATAR (main moves both) — the chip is the
  // avatar's handle while the avatar itself is passing clicks through.
  const onDrag = (e: React.MouseEvent): void => {
    if ((e.target as HTMLElement).closest('button')) return
    e.preventDefault()
    const onMove = (ev: MouseEvent): void =>
      window.connector?.windowControl.moveBy(ev.movementX, ev.movementY)
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      window.connector?.windowControl.moveEnd()
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <div
      style={{ display: 'grid', placeItems: 'center', width: '100vw', height: '100vh', background: 'transparent' }}
    >
      <div ref={ref} style={BAR} onMouseDown={onDrag}>
        <button style={BTN} title="채팅 창 열기"
          onClick={() => window.connector?.windowControl.openControl()}>
          <Svg><path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" /></Svg>
        </button>
        <button style={BTN} title="설정 창 열기"
          onClick={() => window.connector?.windowControl.openSettings()}>
          <Svg>
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </Svg>
        </button>
        <button style={BTN} title="잠금 해제 — 아바타를 옮기거나 크기를 바꿉니다"
          onClick={() => window.connector?.windowControl.setLocked(false)}>
          <Svg>
            <rect x="4" y="11" width="16" height="10" rx="2" />
            <path d="M8 11V7a4 4 0 0 1 8 0" />
          </Svg>
        </button>
      </div>
    </div>
  )
}
