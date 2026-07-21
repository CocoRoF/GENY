// ─────────────────────────────────────────────────────────────────────────────
// BrowserControl — structured local-browser automation over the Chrome DevTools
// Protocol (CDP). Drives a DEDICATED automation instance of the user's own
// installed Chrome/Edge (separate --user-data-dir profile):
//
//   · Chrome ≥136 refuses --remote-debugging-port on the DEFAULT profile, so a
//     dedicated persistent profile is the only reliable attach path. The user
//     logs into sites there once; sessions persist across runs.
//   · The window is HEADED — the user watches the agent browse, can intervene,
//     and can close it at any time.
//
// The agent loop is element-addressed, not coordinate-blind:
//   snapshot → outline of interactive elements as e1,e2,… (registry kept
//   in-page) → act(element, click|type|…) resolves the element and dispatches
//   TRUSTED CDP input events at its center. No pixel-mapping fragility.
//
// Lives in the Electron main process (only main may spawn processes). The
// renderer bridge reaches it via the single `browser:call` IPC; consent gating
// happens in index.ts (read ops: toggle-only; act ops: prompt-once).
// ─────────────────────────────────────────────────────────────────────────────
import { spawn, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { mkdir } from 'fs/promises'
import http from 'http'
import { join } from 'path'
import { app } from 'electron'
import WebSocket from 'ws'

export type BrowserEngine = 'chrome' | 'edge'

// ── Executable discovery ─────────────────────────────────────────────────────
function candidates(engine: BrowserEngine): string[] {
  const env = process.env
  if (process.platform === 'win32') {
    const roots = [env['PROGRAMFILES'], env['PROGRAMFILES(X86)'], env['LOCALAPPDATA']].filter(Boolean) as string[]
    const sub =
      engine === 'chrome' ? join('Google', 'Chrome', 'Application', 'chrome.exe') : join('Microsoft', 'Edge', 'Application', 'msedge.exe')
    return roots.map((r) => join(r, sub))
  }
  if (process.platform === 'darwin') {
    return engine === 'chrome'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
  }
  // linux — resolved via PATH by spawn; report the bare names that exist is
  // hard without `which`, so just try them in order at launch.
  return engine === 'chrome'
    ? ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']
    : ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable']
}

function findExecutable(engine: BrowserEngine): string | null {
  for (const p of candidates(engine)) if (existsSync(p)) return p
  return null
}

export function detectBrowsers(): { chrome: string | null; edge: string | null } {
  return { chrome: findExecutable('chrome'), edge: findExecutable('edge') }
}

// ── Tiny HTTP JSON helpers against the DevTools endpoint ─────────────────────
function devtoolsJson<T>(port: number, path: string, method: 'GET' | 'PUT' = 'GET', timeoutMs = 4000): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        if ((res.statusCode ?? 500) >= 400) return reject(new Error(`devtools ${path}: HTTP ${res.statusCode} ${body.slice(0, 120)}`))
        try {
          resolve(body ? (JSON.parse(body) as T) : (undefined as T))
        } catch {
          resolve(body as unknown as T) // /json/activate returns plain text
        }
      })
    })
    req.on('timeout', () => { req.destroy(new Error('devtools request timeout')) })
    req.on('error', reject)
    req.end()
  })
}

interface TabInfo {
  id: string
  type: string
  title: string
  url: string
  webSocketDebuggerUrl?: string
}

// ── Per-tab CDP session ──────────────────────────────────────────────────────
class TabSession {
  private ws: WebSocket
  private nextId = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
  /** Main-frame navigation happened since the last snapshot → registry stale. */
  navigated = false
  closed = false

  constructor(wsUrl: string, private onGone: () => void) {
    this.ws = new WebSocket(wsUrl, { maxPayload: 64 * 1024 * 1024 })
    this.ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw))
        if (msg.id && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!
          this.pending.delete(msg.id)
          clearTimeout(p.timer)
          if (msg.error) p.reject(new Error(msg.error.message || 'CDP error'))
          else p.resolve(msg.result)
        } else if (msg.method === 'Page.frameNavigated' && !msg.params?.frame?.parentId) {
          this.navigated = true
        }
      } catch {
        /* ignore malformed frames */
      }
    })
    const gone = (): void => {
      this.closed = true
      for (const [, p] of this.pending) {
        clearTimeout(p.timer)
        p.reject(new Error('browser tab connection closed'))
      }
      this.pending.clear()
      this.onGone()
    }
    this.ws.on('close', gone)
    this.ws.on('error', gone)
  }

  ready(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('browser tab connect timeout')), 8000)
      this.ws.once('open', () => { clearTimeout(t); resolve() })
      this.ws.once('error', (e) => { clearTimeout(t); reject(e as Error) })
    })
  }

  send<T = unknown>(method: string, params?: Record<string, unknown>, timeoutMs = 15000): Promise<T> {
    if (this.closed) return Promise.reject(new Error('browser tab connection closed'))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP ${method} timeout`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      this.ws.send(JSON.stringify({ id, method, params: params ?? {} }), (err) => {
        if (err) {
          this.pending.delete(id)
          clearTimeout(timer)
          reject(err)
        }
      })
    })
  }

  /** Evaluate JS in the page and return the by-value result. */
  async eval<T = unknown>(expression: string, timeoutMs = 15000): Promise<T> {
    const r = await this.send<{ result: { value?: T; type: string; description?: string }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true, userGesture: true },
      timeoutMs,
    )
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description?.slice(0, 300) || r.exceptionDetails.text || 'page JS error')
    }
    return r.result?.value as T
  }

  close(): void {
    try { this.ws.close() } catch { /* already gone */ }
  }
}

// ── The in-page snapshot/registry script ─────────────────────────────────────
// Walks the DOM in reading order, collects VISIBLE interactive elements into
// window.__geny_els (the act() registry) and returns a compact outline. Also
// includes headings + a text gist so the model gets page context in one call.
const SNAPSHOT_FN = `(() => {
  const MAXE = 250;
  const reg = [];
  const lines = [];
  const seen = new Set();
  const vp = { w: innerWidth, h: innerHeight };
  const label = (el) => {
    const a = el.getAttribute('aria-label') || '';
    if (a) return a;
    const lb = el.labels && el.labels[0] ? el.labels[0].innerText : '';
    if (lb) return lb;
    const t = (el.innerText || el.value || el.placeholder || el.alt || el.title || '').trim();
    return t;
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || s.opacity === '0') return false;
    return true;
  };
  const roleOf = (el) => {
    const r = el.getAttribute('role');
    if (r) return r;
    const t = el.tagName.toLowerCase();
    if (t === 'a') return 'link';
    if (t === 'button') return 'button';
    if (t === 'select') return 'select';
    if (t === 'textarea') return 'textbox';
    if (t === 'input') return (el.type === 'checkbox' || el.type === 'radio' || el.type === 'submit' || el.type === 'button') ? el.type : 'textbox';
    if (el.isContentEditable) return 'editor';
    return t;
  };
  const sel = 'a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=link], [role=checkbox], [role=radio], [role=tab], [role=menuitem], [role=combobox], [role=option], [role=switch], [role=searchbox], [role=textbox], [contenteditable=true], summary';
  const els = document.querySelectorAll(sel);
  for (const el of els) {
    if (reg.length >= MAXE) break;
    if (seen.has(el) || !visible(el)) continue;
    seen.add(el);
    const i = reg.length; reg.push(el);
    const r = el.getBoundingClientRect();
    const inVp = r.bottom > 0 && r.top < vp.h;
    let s = 'e' + i + ' ' + roleOf(el) + ' "' + label(el).replace(/\\s+/g, ' ').slice(0, 80) + '"';
    if (el.disabled) s += ' (disabled)';
    if (el.type === 'checkbox' || el.type === 'radio') s += el.checked ? ' (checked)' : ' (unchecked)';
    if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.value) s += ' value="' + String(el.value).slice(0, 40) + '"';
    if (el.tagName === 'SELECT' && el.selectedOptions[0]) s += ' selected="' + el.selectedOptions[0].text.slice(0, 40) + '"';
    if (!inVp) s += ' (offscreen)';
    lines.push(s);
  }
  window.__geny_els = reg;
  window.__geny_ver = (window.__geny_ver || 0) + 1;
  const heads = Array.from(document.querySelectorAll('h1,h2,h3')).filter(visible).slice(0, 20)
    .map((h) => h.tagName.toLowerCase() + ': ' + h.innerText.trim().replace(/\\s+/g, ' ').slice(0, 90));
  return {
    url: location.href,
    title: document.title,
    scroll: { y: Math.round(scrollY), max: Math.max(0, Math.round((document.documentElement.scrollHeight || 0) - vp.h)) },
    headings: heads,
    elements: lines,
    truncated: els.length > MAXE,
  };
})()`

// Resolve a registry element and return its viewport-center point + meta,
// scrolling it into view first. Used by act() to aim trusted input events.
const RESOLVE_FN = (idx: number): string => `(() => {
  const reg = window.__geny_els;
  if (!reg || !reg[${idx}]) return { err: 'stale' };
  const el = reg[${idx}];
  if (!el.isConnected) return { err: 'stale' };
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const r = el.getBoundingClientRect();
  return {
    x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
    tag: el.tagName.toLowerCase(), type: el.type || '', editable: !!(el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA'),
  };
})()`

const READ_FN = (maxChars: number): string => `(() => {
  const pick = document.querySelector('main, [role=main], article') || document.body;
  const t = (pick.innerText || '').replace(/\\n{3,}/g, '\\n\\n');
  return { url: location.href, title: document.title, text: t.slice(0, ${maxChars}), truncated: t.length > ${maxChars}, total_chars: t.length };
})()`

// ── Key chords for act(press) / typing helpers ───────────────────────────────
const KEY_DEFS: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  up: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  down: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
}
const MODS: Record<string, number> = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, shift: 8 }

// ── BrowserControl singleton ─────────────────────────────────────────────────
class BrowserControl {
  private proc: ChildProcess | null = null
  private port = 0
  private engine: BrowserEngine | null = null
  private sessions = new Map<string, TabSession>()
  /** The tab the agent last opened/acted on — the default target. */
  private currentTabId: string | null = null

  private async alive(): Promise<boolean> {
    if (!this.port) return false
    try {
      await devtoolsJson(this.port, '/json/version')
      return true
    } catch {
      return false
    }
  }

  /** Launch (or reuse) the dedicated automation browser. */
  async ensure(preferred?: BrowserEngine | 'auto'): Promise<{ engine: BrowserEngine; launched: boolean }> {
    if (await this.alive()) return { engine: this.engine!, launched: false }
    this.sessions.forEach((s) => s.close())
    this.sessions.clear()
    this.currentTabId = null

    const found = detectBrowsers()
    let engine: BrowserEngine | null = null
    if (preferred === 'chrome' || preferred === 'edge') engine = found[preferred] ? preferred : null
    if (!engine) engine = found.chrome ? 'chrome' : found.edge ? 'edge' : null
    if (!engine) throw new Error('no Chrome or Edge installation found on this machine')
    const exe = found[engine]!

    const port = 9300 + Math.floor(Math.random() * 400)
    const profile = join(app.getPath('userData'), 'agent-browser', engine)
    await mkdir(profile, { recursive: true })
    const proc = spawn(
      exe,
      [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-features=MediaRouter',
        '--new-window',
        'about:blank',
      ],
      { detached: false, stdio: 'ignore' },
    )
    proc.on('exit', () => {
      if (this.proc === proc) {
        this.proc = null
        this.sessions.forEach((s) => s.close())
        this.sessions.clear()
      }
    })
    this.proc = proc
    this.port = port
    this.engine = engine
    // Wait for the DevTools endpoint to come up.
    const deadline = Date.now() + 20000
    for (;;) {
      if (await this.alive()) break
      if (Date.now() > deadline) throw new Error(`${engine} did not expose DevTools within 20s`)
      await new Promise((r) => setTimeout(r, 250))
    }
    return { engine, launched: true }
  }

  async listTabs(): Promise<{ running: boolean; engine: BrowserEngine | null; tabs: Array<{ tab_id: string; title: string; url: string; current: boolean }> }> {
    if (!(await this.alive())) {
      const found = detectBrowsers()
      return {
        running: false,
        engine: null,
        tabs: [],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...( { note: `automation browser not running — browser_open launches it (installed: ${[found.chrome && 'chrome', found.edge && 'edge'].filter(Boolean).join(', ') || 'none'})` } as any),
      }
    }
    const raw = await devtoolsJson<TabInfo[]>(this.port, '/json/list')
    const pages = raw.filter((t) => t.type === 'page' && !t.url.startsWith('devtools:'))
    if (this.currentTabId && !pages.some((p) => p.id === this.currentTabId)) this.currentTabId = null
    if (!this.currentTabId && pages[0]) this.currentTabId = pages[0].id
    return {
      running: true,
      engine: this.engine,
      tabs: pages.map((t) => ({ tab_id: t.id, title: t.title, url: t.url, current: t.id === this.currentTabId })),
    }
  }

  private async attach(tabId?: string): Promise<{ id: string; s: TabSession }> {
    if (!(await this.alive())) throw new Error('automation browser is not running — call browser_open first')
    const raw = await devtoolsJson<TabInfo[]>(this.port, '/json/list')
    const pages = raw.filter((t) => t.type === 'page' && !t.url.startsWith('devtools:'))
    const id = tabId || this.currentTabId || pages[0]?.id
    const info = pages.find((t) => t.id === id)
    if (!info) throw new Error(tabId ? `tab '${tabId}' not found — call browser_tabs` : 'no open tabs')
    let s = this.sessions.get(info.id)
    if (!s || s.closed) {
      if (!info.webSocketDebuggerUrl) throw new Error('tab has no debugger endpoint (another client attached?)')
      s = new TabSession(info.webSocketDebuggerUrl, () => this.sessions.delete(info.id))
      this.sessions.set(info.id, s)
      await s.ready()
      await s.send('Page.enable').catch(() => undefined) // navigation events → registry invalidation
    }
    this.currentTabId = info.id
    return { id: info.id, s }
  }

  private async waitLoaded(s: TabSession, timeoutMs = 15000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      try {
        const st = await s.eval<string>('document.readyState', 4000)
        if (st === 'complete' || st === 'interactive') return
      } catch {
        /* mid-navigation — keep polling */
      }
      if (Date.now() > deadline) return // best-effort; agent can still snapshot
      await new Promise((r) => setTimeout(r, 300))
    }
  }

  async open(args: { url: string; tab_id?: string; engine?: BrowserEngine | 'auto' }): Promise<unknown> {
    const url = /^[a-z][a-z0-9+.-]*:/i.test(args.url) ? args.url : `https://${args.url}`
    const { launched, engine } = await this.ensure(args.engine)
    if (args.tab_id) {
      const { s, id } = await this.attach(args.tab_id)
      await s.send('Page.navigate', { url }, 20000)
      await this.waitLoaded(s)
      s.navigated = false
      const info = await s.eval<{ t: string; u: string }>('({t: document.title, u: location.href})').catch(() => ({ t: '', u: url }))
      return { tab_id: id, title: info.t, url: info.u, launched }
    }
    // New tab. Chrome 111+ requires PUT; older accepts GET.
    let tab: TabInfo
    try {
      tab = await devtoolsJson<TabInfo>(this.port, `/json/new?${encodeURIComponent(url)}`, 'PUT')
    } catch {
      tab = await devtoolsJson<TabInfo>(this.port, `/json/new?${encodeURIComponent(url)}`, 'GET')
    }
    this.currentTabId = tab.id
    const { s } = await this.attach(tab.id)
    await this.waitLoaded(s)
    s.navigated = false
    const info = await s.eval<{ t: string; u: string }>('({t: document.title, u: location.href})').catch(() => ({ t: tab.title, u: url }))
    return { tab_id: tab.id, title: info.t, url: info.u, launched, engine }
  }

  async snapshot(args: { tab_id?: string }): Promise<unknown> {
    const { s, id } = await this.attach(args.tab_id)
    const snap = await s.eval<Record<string, unknown>>(SNAPSHOT_FN, 20000)
    s.navigated = false
    return { tab_id: id, ...snap, hint: 'act on an element with browser_act {element:"e12", action:"click"|"type"…}. Re-snapshot after navigation.' }
  }

  async read(args: { tab_id?: string; max_chars?: number }): Promise<unknown> {
    const { s, id } = await this.attach(args.tab_id)
    const max = Math.min(Math.max(args.max_chars ?? 18000, 500), 60000)
    const r = await s.eval<Record<string, unknown>>(READ_FN(max), 20000)
    return { tab_id: id, ...r }
  }

  async screenshot(args: { tab_id?: string }): Promise<unknown> {
    const { s, id } = await this.attach(args.tab_id)
    // Bring the tab to front — background tabs don't render frames.
    await devtoolsJson(this.port, `/json/activate/${id}`).catch(() => undefined)
    await new Promise((r) => setTimeout(r, 150))
    const vw = await s.eval<number>('innerWidth', 4000).catch(() => 1280)
    const scale = Math.min(1, 1400 / Math.max(vw, 1))
    const shot = await s.send<{ data: string }>(
      'Page.captureScreenshot',
      { format: 'jpeg', quality: 72, clip: undefined, optimizeForSpeed: true, ...(scale < 1 ? {} : {}) },
      20000,
    )
    const meta = await s.eval<{ t: string; u: string; w: number; h: number }>(
      '({t: document.title, u: location.href, w: innerWidth, h: innerHeight})',
      4000,
    ).catch(() => ({ t: '', u: '', w: 0, h: 0 }))
    return { tab_id: id, image_b64: shot.data, mime: 'image/jpeg', title: meta.t, url: meta.u, width: meta.w, height: meta.h }
  }

  private async pressChord(s: TabSession, chord: string): Promise<void> {
    const parts = chord.toLowerCase().split('+').map((p) => p.trim()).filter(Boolean)
    let modifiers = 0
    let main: string | null = null
    for (const p of parts) {
      if (MODS[p] !== undefined) modifiers |= MODS[p]
      else main = p
    }
    if (!main) throw new Error(`no key in chord '${chord}'`)
    const def = KEY_DEFS[main] || (main.length === 1
      ? { key: main, code: `Key${main.toUpperCase()}`, keyCode: main.toUpperCase().charCodeAt(0), text: modifiers ? undefined : main }
      : null)
    if (!def) throw new Error(`unknown key '${main}'`)
    await s.send('Input.dispatchKeyEvent', {
      type: 'keyDown', modifiers, key: def.key, code: def.code,
      windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode, text: def.text,
    })
    await s.send('Input.dispatchKeyEvent', {
      type: 'keyUp', modifiers, key: def.key, code: def.code,
      windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode,
    })
  }

  async act(args: {
    tab_id?: string
    element?: string
    action: string
    text?: string
    value?: string
    keys?: string
    amount?: number
  }): Promise<unknown> {
    const { s, id } = await this.attach(args.tab_id)
    const action = args.action
    const finish = async (note: string): Promise<unknown> => {
      await new Promise((r) => setTimeout(r, 250))
      const nav = s.navigated
      const meta = await s.eval<{ t: string; u: string }>('({t: document.title, u: location.href})', 4000).catch(() => null)
      return {
        tab_id: id, done: note,
        ...(meta ? { title: meta.t, url: meta.u } : {}),
        ...(nav ? { navigated: true, hint: 'the page navigated — element ids are stale, call browser_snapshot again' } : {}),
      }
    }

    // Whole-page actions (no element).
    if (action === 'press') {
      if (!args.keys) throw new Error("action 'press' needs keys, e.g. 'enter' or 'ctrl+a'")
      await this.pressChord(s, args.keys)
      return finish(`pressed ${args.keys}`)
    }
    if (action === 'scroll') {
      const amount = args.amount ?? 600
      await s.eval(`window.scrollBy({ top: ${Number(amount)}, behavior: 'instant' })`)
      return finish(`scrolled ${amount}px`)
    }
    if (action === 'back') { await s.eval('history.back()'); return finish('went back') }
    if (action === 'forward') { await s.eval('history.forward()'); return finish('went forward') }
    if (action === 'reload') { await s.send('Page.reload', {}); await this.waitLoaded(s); return finish('reloaded') }

    // Element actions.
    if (!args.element) throw new Error(`action '${action}' needs an element id from browser_snapshot (e.g. "e12")`)
    const idx = parseInt(String(args.element).replace(/^e/i, ''), 10)
    if (Number.isNaN(idx)) throw new Error(`bad element id '${args.element}' — use the eN ids from browser_snapshot`)
    const resolve = async (): Promise<{ x: number; y: number; tag: string; type: string; editable: boolean }> => {
      const r = await s.eval<{ err?: string; x: number; y: number; tag: string; type: string; editable: boolean }>(RESOLVE_FN(idx))
      if (!r || r.err) throw new Error('element is stale (page changed) — call browser_snapshot again')
      return r
    }

    switch (action) {
      case 'click':
      case 'check':
      case 'uncheck': {
        const p = await resolve()
        if (action !== 'click') {
          const cur = await s.eval<boolean>(`(() => { const el = window.__geny_els[${idx}]; return !!(el && el.checked); })()`)
          if ((action === 'check') === cur) return finish(`already ${action}ed`)
        }
        await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y })
        await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 })
        await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 })
        return finish(`clicked e${idx}`)
      }
      case 'type': {
        if (args.text === undefined) throw new Error("action 'type' needs text")
        const p = await resolve()
        if (!p.editable) throw new Error(`e${idx} (<${p.tag}>) is not editable — 'type' targets inputs/textareas/contenteditable`)
        // Focus with a real click, clear, then insert (fires proper input events).
        await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 })
        await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 })
        await s.eval(`(() => { const el = window.__geny_els[${idx}]; if (el && el.select) el.select(); else if (el && el.isContentEditable) { const r = document.createRange(); r.selectNodeContents(el); const sl = getSelection(); sl.removeAllRanges(); sl.addRange(r); } })()`)
        await s.send('Input.insertText', { text: args.text })
        if (args.keys === 'enter' || (args as { submit?: boolean }).submit) await this.pressChord(s, 'enter')
        return finish(`typed ${args.text.length} chars into e${idx}`)
      }
      case 'select': {
        if (args.value === undefined && args.text === undefined) throw new Error("action 'select' needs value (option value or visible text)")
        const want = JSON.stringify(args.value ?? args.text)
        const ok = await s.eval<boolean>(`(() => {
          const el = window.__geny_els[${idx}];
          if (!el || el.tagName !== 'SELECT') return false;
          const w = ${want};
          for (const o of el.options) {
            if (o.value === w || o.text.trim() === w) {
              el.value = o.value;
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              return true;
            }
          }
          return false;
        })()`)
        if (!ok) throw new Error(`option ${want} not found in e${idx} (or it is not a <select>)`)
        return finish(`selected ${want} in e${idx}`)
      }
      case 'hover': {
        const p = await resolve()
        await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y })
        return finish(`hovered e${idx}`)
      }
      case 'scroll_to': {
        await resolve() // resolve() already scrollIntoView-centers it
        return finish(`scrolled e${idx} into view`)
      }
      default:
        throw new Error(`unknown action '${action}' — use click|type|select|check|uncheck|press|scroll|scroll_to|hover|back|forward|reload`)
    }
  }

  async evalJs(args: { tab_id?: string; expression: string }): Promise<unknown> {
    const { s, id } = await this.attach(args.tab_id)
    const v = await s.eval<unknown>(`(async () => (${args.expression}))()`, 20000)
    let out: string
    try {
      out = typeof v === 'string' ? v : JSON.stringify(v)
    } catch {
      out = String(v)
    }
    if (out && out.length > 8000) out = out.slice(0, 8000) + `… (truncated, ${out.length} chars)`
    return { tab_id: id, result: out ?? 'undefined' }
  }

  async closeTab(args: { tab_id?: string; all?: boolean }): Promise<unknown> {
    if (args.all) {
      const p = this.proc
      this.sessions.forEach((s) => s.close())
      this.sessions.clear()
      this.currentTabId = null
      if (p) { try { p.kill() } catch { /* already gone */ } }
      this.proc = null
      this.port = 0
      return { done: 'automation browser closed' }
    }
    const { id } = await this.attach(args.tab_id)
    await devtoolsJson(this.port, `/json/close/${id}`)
    this.sessions.get(id)?.close()
    this.sessions.delete(id)
    if (this.currentTabId === id) this.currentTabId = null
    return { done: `closed tab ${id}` }
  }

  /** App shutdown — leave the (user-visible) browser running, drop sockets. */
  dispose(): void {
    this.sessions.forEach((s) => s.close())
    this.sessions.clear()
  }
}

let _control: BrowserControl | null = null
export function getBrowserControl(): BrowserControl {
  if (!_control) _control = new BrowserControl()
  return _control
}

/** Route one browser op. Ops: tabs|open|snapshot|act|read|screenshot|eval|close. */
export async function browserCall(op: string, args: Record<string, unknown>): Promise<unknown> {
  const c = getBrowserControl()
  switch (op) {
    case 'tabs': return c.listTabs()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    case 'open': return c.open(args as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    case 'snapshot': return c.snapshot(args as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    case 'act': return c.act(args as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    case 'read': return c.read(args as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    case 'screenshot': return c.screenshot(args as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    case 'eval': return c.evalJs(args as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    case 'close': return c.closeTab(args as any)
    default: throw new Error(`unknown browser op '${op}'`)
  }
}
