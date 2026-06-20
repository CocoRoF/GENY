import { useCallback, useEffect, useRef, useState } from 'react'
import genyIcon from './assets/geny_character.png'

// ─────────────────────────────────────────────────────────────────────────────
// Quick-chat bar — the floating, Spotlight-style input summoned by the global
// hotkey (default Cmd/Ctrl+Shift+Enter). Type a message, hit Enter, and it's
// relayed to the CURRENT VTuber's chat (the overlaySession) through the
// /connector page's own send path — so the avatar answers via the usual TTS.
//
// This window is frameless + transparent; the card paints itself. Dismiss on
// Esc or focus-loss (main hides on blur). It re-themes with the connector's
// dark/light choice via the shared `.gy` tokens.
// ─────────────────────────────────────────────────────────────────────────────

type Phase = 'idle' | 'sending' | 'sent' | 'error'

const sendIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 2 11 13" />
    <path d="M22 2 15 22l-4-9-9-4z" />
  </svg>
)

export function QuickChatApp() {
  const [text, setText] = useState('')
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState('')
  const [dark, setDark] = useState(true)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const sentTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Resolve the bar's theme from the connector config (falls back to OS).
  const resolveTheme = useCallback(() => {
    const sysDark = window.matchMedia('(prefers-color-scheme: dark)').matches
    window.connector?.serverConfig
      .get()
      .then((c) => {
        const t = c.theme ?? 'system'
        setDark(t === 'system' ? sysDark : t === 'dark')
      })
      .catch(() => setDark(sysDark))
  }, [])

  const focusInput = useCallback(() => {
    const el = inputRef.current
    if (!el) return
    el.focus()
    el.select()
  }, [])

  // Summoned: reset + refocus each time the hotkey fires (the window is reused).
  useEffect(() => {
    resolveTheme()
    focusInput()
    const off = window.connector?.quickChat?.onOpened?.(() => {
      if (sentTimer.current) clearTimeout(sentTimer.current)
      setText('')
      setPhase('idle')
      setError('')
      resolveTheme()
      setTimeout(focusInput, 20)
    })
    return () => off?.()
  }, [resolveTheme, focusInput])

  // Auto-grow the textarea up to a few lines.
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 84)}px`
  }, [text])

  const submit = useCallback(async () => {
    const body = text.trim()
    if (!body || phase === 'sending') return
    setPhase('sending')
    setError('')
    const r = await window.connector?.quickChat?.submit(body)
    if (r?.ok) {
      setPhase('sent')
      setText('')
      // Main hides the bar on success; show a brief confirmation in case it lingers.
      if (sentTimer.current) clearTimeout(sentTimer.current)
      sentTimer.current = setTimeout(() => setPhase('idle'), 1400)
    } else {
      setPhase('error')
      setError(r?.error || '전송 실패')
      setTimeout(focusInput, 0)
    }
  }, [text, phase, focusInput])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      window.connector?.quickChat?.close()
    } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      // isComposing guard: don't send while an IME candidate is being confirmed.
      e.preventDefault()
      void submit()
    }
  }

  const canSend = !!text.trim() && phase !== 'sending'

  return (
    <div className={`qc-root gy ${dark ? '' : 'gy--light'}`}>
      <div className="qc-card">
        <div className="qc-bar">
          <img className="qc-logo" src={genyIcon} alt="" draggable={false} />
          <textarea
            ref={inputRef}
            className="qc-input"
            value={text}
            rows={1}
            placeholder="현재 VTuber에게 보낼 메시지…"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            spellCheck={false}
            autoFocus
          />
          <button className="qc-send" onClick={() => void submit()} disabled={!canSend} aria-label="전송">
            {sendIcon}
          </button>
        </div>
        <div className="qc-foot">
          {phase === 'error' ? (
            <span className="qc-hint qc-err">⚠ {error}</span>
          ) : phase === 'sent' ? (
            <span className="qc-hint qc-ok">✓ 전송됨 — VTuber가 답합니다</span>
          ) : phase === 'sending' ? (
            <span className="qc-hint">전송 중…</span>
          ) : (
            <span className="qc-hint">
              <kbd>Enter</kbd> 전송 · <kbd>Shift</kbd>+<kbd>Enter</kbd> 줄바꿈 · <kbd>Esc</kbd> 닫기
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
