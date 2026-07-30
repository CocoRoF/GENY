/**
 * sync-transport — real HTTP implementation of the sync-core Transport
 * against the Geny backend storage API, plus the thin change-notify
 * WebSocket client (/ws/workspace/{sid}).
 *
 * Paths: sync-core speaks WORKSPACE-relative paths; the REST API speaks
 * storage-root-relative ("workspace/<p>") — mapped here and nowhere else.
 */

import { createReadStream, createWriteStream } from 'fs'
import { mkdir, rename, rm, stat } from 'fs/promises'
import { dirname, join } from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import WebSocket from 'ws'
import { ChangesResponse, SyncConflictError, Transport } from './sync-core'

export interface TransportAuth {
  baseUrl: string // e.g. https://geny.example.com (no trailing slash)
  token: () => string | Promise<string>
  sessionId: string
  deviceId: string
}

function wsPath(p: string): string {
  return `workspace/${p}`
}

function encPath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/')
}

async function authHeaders(auth: TransportAuth): Promise<Record<string, string>> {
  return { Authorization: `Bearer ${await auth.token()}` }
}

export class HttpSyncTransport implements Transport {
  constructor(
    private auth: TransportAuth,
    private tmpDir: string,
  ) {}

  private url(path: string, qs: Record<string, string | number | undefined> = {}): string {
    const u = new URL(
      `${this.auth.baseUrl}/api/agents/${encodeURIComponent(this.auth.sessionId)}${path}`,
    )
    for (const [k, v] of Object.entries(qs)) {
      if (v !== undefined) u.searchParams.set(k, String(v))
    }
    return u.toString()
  }

  async changes(since: number): Promise<ChangesResponse> {
    const res = await fetch(this.url('/storage/changes', { since }), {
      headers: await authHeaders(this.auth),
    })
    if (!res.ok) throw Object.assign(new Error(`changes HTTP ${res.status}`), { status: res.status })
    return (await res.json()) as ChangesResponse
  }

  async download(path: string, toAbs: string): Promise<void> {
    const res = await fetch(this.url(`/storage-raw/${encPath(wsPath(path))}`), {
      headers: await authHeaders(this.auth),
    })
    if (!res.ok || !res.body) {
      throw Object.assign(new Error(`download HTTP ${res.status}`), { status: res.status })
    }
    await mkdir(this.tmpDir, { recursive: true })
    const tmp = join(this.tmpDir, `dl-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    try {
      await pipeline(Readable.fromWeb(res.body as any), createWriteStream(tmp))
      await mkdir(dirname(toAbs), { recursive: true })
      await rename(tmp, toAbs)
    } catch (e) {
      await rm(tmp, { force: true })
      throw e
    }
  }

  async put(path: string, fromAbs: string, baseSha: string): Promise<{ sha256: string }> {
    const size = (await stat(fromAbs)).size
    const res = await fetch(
      this.url('/storage/file', {
        path: wsPath(path),
        base_sha: baseSha,
        device: this.auth.deviceId,
      }),
      {
        method: 'PUT',
        headers: {
          ...(await authHeaders(this.auth)),
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(size),
        },
        body: Readable.toWeb(createReadStream(fromAbs)) as any,
        // node fetch requires duplex for streaming bodies
        // @ts-expect-error node-only option
        duplex: 'half',
      },
    )
    if (res.status === 409) {
      const body = await res.json().catch(() => ({}) as any)
      throw new SyncConflictError(body?.detail?.current_sha)
    }
    if (!res.ok) throw Object.assign(new Error(`put HTTP ${res.status}`), { status: res.status })
    const data = (await res.json()) as { sha256: string }
    return { sha256: data.sha256 }
  }

  async del(path: string, baseSha?: string): Promise<void> {
    const res = await fetch(
      this.url('/storage/entry', { path: wsPath(path), base_sha: baseSha }),
      { method: 'DELETE', headers: await authHeaders(this.auth) },
    )
    if (res.status === 409) {
      const body = await res.json().catch(() => ({}) as any)
      throw new SyncConflictError(body?.detail?.current_sha)
    }
    if (res.status === 404) throw Object.assign(new Error('not found'), { status: 404 })
    if (!res.ok) throw Object.assign(new Error(`delete HTTP ${res.status}`), { status: res.status })
  }

  async mkdir(path: string): Promise<void> {
    const res = await fetch(this.url('/storage/mkdir', { path: wsPath(path) }), {
      method: 'POST',
      headers: await authHeaders(this.auth),
    })
    if (res.status === 409) return // already exists — fine
    if (!res.ok) throw Object.assign(new Error(`mkdir HTTP ${res.status}`), { status: res.status })
  }
}

/** Thin change-notification listener with auto-reconnect. Fires
 *  `onChanged(latestSeq)` whenever the server says the workspace moved,
 *  `onState(connected)` on connection transitions. */
export class WorkspaceWsClient {
  private ws: WebSocket | null = null
  private closed = false
  private retryMs = 2000
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null

  constructor(
    private auth: TransportAuth,
    private deviceName: string,
    private onChanged: (latestSeq: number) => void,
    private onState: (connected: boolean) => void,
  ) {}

  async start(): Promise<void> {
    this.closed = false
    await this.connect()
  }

  stop(): void {
    this.closed = true
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.ws?.close()
    this.ws = null
  }

  private async connect(): Promise<void> {
    if (this.closed) return
    const base = this.auth.baseUrl.replace(/^http/, 'ws')
    const token = await this.auth.token()
    const url = `${base}/ws/workspace/${encodeURIComponent(this.auth.sessionId)}`
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } })
    this.ws = ws

    ws.on('open', () => {
      this.retryMs = 2000
      this.onState(true)
      ws.send(
        JSON.stringify({
          type: 'hello',
          data: { device_id: this.auth.deviceId, device_name: this.deviceName },
        }),
      )
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'heartbeat', ts: Date.now() }))
        }
      }, 25_000)
    })
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw))
        if (msg?.type === 'changed' || msg?.type === 'state') {
          const seq = Number(msg?.data?.latest_seq ?? 0)
          this.onChanged(seq)
        }
      } catch {
        /* ignore malformed frames */
      }
    })
    const scheduleRetry = () => {
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
      this.onState(false)
      if (this.closed) return
      const delay = this.retryMs
      this.retryMs = Math.min(this.retryMs * 2, 60_000)
      setTimeout(() => void this.connect(), delay)
    }
    ws.on('close', scheduleRetry)
    ws.on('error', () => ws.close())
  }
}
