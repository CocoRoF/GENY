import { useCallback, useEffect, useRef, useState } from 'react'
import { makeT, type Lang } from './i18n'

// ─────────────────────────────────────────────────────────────────────────────
// Quick-chat bar — the floating, Spotlight-style input summoned by the global
// hotkey (default Cmd/Ctrl+Shift+Enter). Type a message, hit Enter, and it's
// relayed to the CURRENT VTuber's chat (the overlaySession) through the
// /connector page's own send path — so the avatar answers via the usual TTS.
//
// The window itself is PERMANENT: main keeps a transparent, top-most, on-screen
// window alive at all times (like the avatar overlay, so it layers above a
// full-screen game). What appears/disappears is the CARD — this component only
// paints it while `visible`, toggled by main's opened/dismissed events. Dismiss
// on Esc or focus-loss (main detects blur). Re-themes via the shared `.gy` tokens.
// ─────────────────────────────────────────────────────────────────────────────

type Phase = 'idle' | 'sending' | 'sent' | 'error'

/** A pasted image, carried as a data URL through the relay chain. The web
 *  side converts it back to a File and runs the SAME resize+upload path as
 *  the in-app composer, so caps/formats stay in one place. */
export interface QuickImage {
  name: string
  type: string
  dataUrl: string
}

const MAX_IMAGES = 4
const MAX_IMAGE_BYTES = 10 * 1024 * 1024

const sendIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 2 11 13" />
    <path d="M22 2 15 22l-4-9-9-4z" />
  </svg>
)

export function QuickChatApp() {
  const [visible, setVisible] = useState(false)
  const [text, setText] = useState('')
  const [images, setImages] = useState<QuickImage[]>([])
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState('')
  const [dark, setDark] = useState(true)
  const [lang, setLang] = useState<Lang>('ko')
  const t = makeT(lang)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const sentTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Resolve the bar's theme + language from the connector config (theme falls
  // back to OS; language falls back to the OS-derived default from main).
  const resolveTheme = useCallback(() => {
    const sysDark = window.matchMedia('(prefers-color-scheme: dark)').matches
    window.connector?.serverConfig
      .get()
      .then(async (c) => {
        const mode = c.theme ?? 'system'
        setDark(mode === 'system' ? sysDark : mode === 'dark')
        const osLang = (await window.connector?.appDefaultLang?.().catch(() => 'ko' as Lang)) ?? 'ko'
        setLang(c.lang ?? osLang)
      })
      .catch(() => setDark(sysDark))
  }, [])

  const focusInput = useCallback(() => {
    const el = inputRef.current
    if (!el) return
    el.focus()
    el.select()
  }, [])

  // Paint the card on summon (reset + focus), erase it on dismiss. The window
  // stays alive either way — only the card mounts/unmounts.
  useEffect(() => {
    resolveTheme()
    const offOpen = window.connector?.quickChat?.onOpened?.(() => {
      if (sentTimer.current) clearTimeout(sentTimer.current)
      setText('')
      setImages([])
      setPhase('idle')
      setError('')
      setVisible(true)
      resolveTheme()
      setTimeout(focusInput, 20)
    })
    const offDismiss = window.connector?.quickChat?.onDismissed?.(() => {
      setVisible(false)
    })
    return () => { offOpen?.(); offDismiss?.() }
  }, [resolveTheme, focusInput])

  // When the window gains OS keyboard focus (main grabs it a tick after summon),
  // re-focus the input so the user can type immediately — no click needed.
  useEffect(() => {
    const onWinFocus = () => { if (visible) focusInput() }
    window.addEventListener('focus', onWinFocus)
    return () => window.removeEventListener('focus', onWinFocus)
  }, [visible, focusInput])

  // Auto-grow the textarea up to a few lines.
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 84)}px`
  }, [text])

  // Pasted images: capture image items from the clipboard into thumbnails.
  // Text-only pastes fall through to the textarea untouched.
  const onPaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items
    if (!items) return
    const files: File[] = []
    for (let i = 0; i < items.length; i++) {
      const it = items[i]
      if (it.kind === 'file') {
        const f = it.getAsFile()
        if (f && f.type.startsWith('image/')) files.push(f)
      }
    }
    if (!files.length) return
    e.preventDefault()
    setError('')
    const room = MAX_IMAGES - images.length
    if (room <= 0) {
      setPhase('error')
      setError(t('qc.tooManyImages'))
      return
    }
    for (const f of files.slice(0, room)) {
      if (f.size > MAX_IMAGE_BYTES) {
        setPhase('error')
        setError(t('qc.imageTooLarge'))
        continue
      }
      const reader = new FileReader()
      reader.onload = () => {
        const dataUrl = String(reader.result || '')
        if (!dataUrl.startsWith('data:')) return
        setImages((prev) =>
          prev.length >= MAX_IMAGES
            ? prev
            : [...prev, { name: f.name || `pasted-${Date.now()}.png`, type: f.type, dataUrl }],
        )
      }
      reader.readAsDataURL(f)
    }
  }, [images.length, t])

  const removeImage = useCallback((idx: number) => {
    setImages((prev) => prev.filter((_, i) => i !== idx))
    setTimeout(focusInput, 0)
  }, [focusInput])

  const submit = useCallback(async () => {
    const body = text.trim()
    if ((!body && images.length === 0) || phase === 'sending') return
    setPhase('sending')
    setError('')
    const r = await window.connector?.quickChat?.submit({ text: body, images })
    if (r?.ok) {
      setPhase('sent')
      setText('')
      setImages([])
      // Main hides the bar on success; show a brief confirmation in case it lingers.
      if (sentTimer.current) clearTimeout(sentTimer.current)
      sentTimer.current = setTimeout(() => setPhase('idle'), 1400)
    } else {
      setPhase('error')
      setError(r?.error || t('qc.sendFailed'))
      setTimeout(focusInput, 0)
    }
  }, [text, images, phase, focusInput, t])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      setVisible(false)
      window.connector?.quickChat?.close()
    } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      // isComposing guard: don't send while an IME candidate is being confirmed.
      e.preventDefault()
      void submit()
    }
  }

  const canSend = (!!text.trim() || images.length > 0) && phase !== 'sending'

  // Window stays alive always; paint the card only while summoned so the rest of
  // the time the window is fully transparent (and click-through, set by main).
  if (!visible) return <div className="qc-root" />

  return (
    <div className={`qc-root gy ${dark ? '' : 'gy--light'}`}>
      <div className="qc-card">
        {images.length > 0 && (
          <div className="qc-thumbs">
            {images.map((img, i) => (
              <div key={`${img.name}-${i}`} className="qc-thumb">
                <img src={img.dataUrl} alt={img.name} />
                <button
                  className="qc-thumb-x"
                  onClick={() => removeImage(i)}
                  aria-label={t('qc.removeImage')}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="qc-bar">
          <textarea
            ref={inputRef}
            className="qc-input"
            value={text}
            rows={1}
            placeholder={t('qc.placeholder')}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            spellCheck={false}
            autoFocus
          />
          <button className="qc-send" onClick={() => void submit()} disabled={!canSend} aria-label={t('qc.sendAria')}>
            {sendIcon}
          </button>
        </div>
        <div className="qc-foot">
          {phase === 'error' ? (
            <span className="qc-hint qc-err">⚠ {error}</span>
          ) : phase === 'sent' ? (
            <span className="qc-hint qc-ok">{t('qc.sent')}</span>
          ) : phase === 'sending' ? (
            <span className="qc-hint">{t('qc.sending')}</span>
          ) : (
            <span className="qc-hint">
              <kbd>Enter</kbd> {t('qc.footSend')} · <kbd>Shift</kbd>+<kbd>Enter</kbd> {t('qc.footNewline')} · <kbd>Esc</kbd> {t('qc.footClose')} · {t('qc.footPaste')}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
