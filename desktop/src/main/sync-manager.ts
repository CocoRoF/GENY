/**
 * sync-manager — orchestration of workspace sync pairs.
 *
 * One PairEngine per (agent session ↔ local folder) pairing:
 *   chokidar watcher + server WS notify + 60s safety timer → all funnel
 *   into ONE debounced reconcile loop (sync-core.syncOnce). The engine
 *   never trusts events; every round is a full 3-way comparison, so a
 *   missed event only delays convergence, never corrupts it.
 *
 * Modeled on mcp-manager.ts: singleton, configure() reconciles config,
 * deduped status pushes to the renderer.
 */

import { watch, type FSWatcher } from 'chokidar'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { hostname } from 'os'
import { join } from 'path'
import { MassDeletePending, SyncIndex, syncOnce } from './sync-core'
import { ReplicaFs, DEFAULT_IGNORES } from './sync-fs'
import { HttpSyncTransport, WorkspaceWsClient } from './sync-transport'

export interface SyncPairConfig {
  id: string
  sessionId: string
  sessionLabel?: string
  localPath: string
  paused?: boolean
}

export type SyncState =
  | 'idle'
  | 'syncing'
  | 'paused'
  | 'offline'
  | 'error'
  | 'awaiting_confirmation'

export interface SyncPairStatus {
  id: string
  sessionId: string
  sessionLabel?: string
  localPath: string
  state: SyncState
  connected: boolean
  lastSyncAt: number | null
  lastError: string | null
  counts: { downloaded: number; uploaded: number; conflicts: number; skippedLarge: number }
  pendingMassDelete: { count: number; total: number } | null
}

interface ManagerDeps {
  indexDir: string
  serverUrl: () => string
  token: () => Promise<string | null>
  deviceId: () => string
  onStatus: (statuses: SyncPairStatus[]) => void
  log: (msg: string) => void
  /** The engine auto-paused a pair (e.g. quota storm) — persist paused
   *  in the config so it survives restarts. */
  onAutoPause?: (id: string, reason: string) => void
  /** Patched by SyncManager: engines bubble single-status changes up. */
  onStatusOne?: () => void
}

const DEBOUNCE_MS = 1500
const PERIODIC_MS = 60_000
const STABILITY_MS = 1200
const MAX_FILE_BYTES_DEFAULT = 500 * 1024 * 1024

class PairEngine {
  status: SyncPairStatus
  private fs: ReplicaFs
  private transport: HttpSyncTransport
  private ws: WorkspaceWsClient | null = null
  private watcher: FSWatcher | null = null
  private index: SyncIndex
  private timer: ReturnType<typeof setInterval> | null = null
  private debounce: ReturnType<typeof setTimeout> | null = null
  private running = false
  private rerun = false
  private stopped = false
  private confirmedMassDelete = false

  constructor(
    public cfg: SyncPairConfig,
    private deps: ManagerDeps,
  ) {
    this.status = {
      id: cfg.id,
      sessionId: cfg.sessionId,
      sessionLabel: cfg.sessionLabel,
      localPath: cfg.localPath,
      state: cfg.paused ? 'paused' : 'idle',
      connected: false,
      lastSyncAt: null,
      lastError: null,
      counts: { downloaded: 0, uploaded: 0, conflicts: 0, skippedLarge: 0 },
      pendingMassDelete: null,
    }
    this.fs = new ReplicaFs(cfg.localPath)
    this.index = this.loadIndex()
    this.transport = new HttpSyncTransport(
      {
        baseUrl: this.deps.serverUrl().replace(/\/$/, ''),
        token: async () => (await this.deps.token()) ?? '',
        sessionId: cfg.sessionId,
        deviceId: this.deps.deviceId(),
      },
      join(cfg.localPath, '.geny-sync-tmp'),
    )
  }

  private indexPath(): string {
    return join(this.deps.indexDir, `${this.cfg.id}.json`)
  }

  private loadIndex(): SyncIndex {
    try {
      const parsed = JSON.parse(readFileSync(this.indexPath(), 'utf-8'))
      if (typeof parsed?.cursor === 'number' && parsed?.entries) return parsed
    } catch {
      /* fresh pair */
    }
    return { cursor: 0, entries: {} }
  }

  private saveIndex(): void {
    try {
      mkdirSync(this.deps.indexDir, { recursive: true })
      const tmp = this.indexPath() + '.tmp'
      writeFileSync(tmp, JSON.stringify(this.index))
      renameSync(tmp, this.indexPath())
    } catch (e) {
      this.deps.log(`sync[${this.cfg.id}] index save failed: ${e}`)
    }
  }

  start(): void {
    if (this.cfg.paused) return
    this.stopped = false
    // Crash hygiene: drop orphaned download temps from prior runs.
    void import('fs/promises').then(({ readdir, rm }) => {
      const tmp = join(this.cfg.localPath, '.geny-sync-tmp')
      readdir(tmp).then((names) => {
        for (const n of names) {
          if (n.startsWith('apply-') || n.startsWith('dl-')) {
            void rm(join(tmp, n), { force: true })
          }
        }
      }).catch(() => {})
    })
    // 1) file watcher — trigger only; the loop re-derives truth
    const rootAbs = this.cfg.localPath
    this.watcher = watch(rootAbs, {
      ignoreInitial: true,
      ignored: (p: string) => {
        // segment-match RELATIVE to the root: a replica living under a
        // folder named 'build'/'out' must not disable the whole watcher
        const rel = p.startsWith(rootAbs) ? p.slice(rootAbs.length) : p
        const parts = rel.split(/[\\/]/).filter(Boolean)
        return parts.some((seg) => DEFAULT_IGNORES.includes(seg))
      },
      awaitWriteFinish: { stabilityThreshold: 800, pollInterval: 200 },
    })
    this.watcher.on('all', () => this.schedule())
    this.watcher.on('error', () => {/* watcher hiccups are non-fatal */})

    // 2) server change notify
    this.ws = new WorkspaceWsClient(
      {
        baseUrl: this.deps.serverUrl().replace(/\/$/, ''),
        token: async () => (await this.deps.token()) ?? '',
        sessionId: this.cfg.sessionId,
        deviceId: this.deps.deviceId(),
      },
      hostname(),
      (latestSeq) => {
        if (latestSeq > this.index.cursor) this.schedule()
      },
      (connected) => {
        this.status.connected = connected
        if (!connected && this.status.state === 'idle') this.status.state = 'offline'
        if (connected && this.status.state === 'offline') this.status.state = 'idle'
        this.pushStatus()
        if (connected) this.schedule() // reconnect → catch-up round
      },
    )
    void this.ws.start()

    // 3) safety net
    // Safety net runs DIRECTLY: sustained watcher churn resets the
    // debounce forever; run() has its own mutex so this is always safe.
    this.timer = setInterval(() => void this.run(), PERIODIC_MS)
    this.schedule()
  }

  stop(): void {
    this.stopped = true
    this.watcher?.close().catch(() => {})
    this.watcher = null
    this.ws?.stop()
    this.ws = null
    if (this.timer) clearInterval(this.timer)
    if (this.debounce) clearTimeout(this.debounce)
    this.saveIndex()
  }

  schedule(): void {
    if (this.stopped || this.cfg.paused) return
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = setTimeout(() => void this.run(), DEBOUNCE_MS)
  }

  syncNow(): void {
    if (this.debounce) clearTimeout(this.debounce)
    void this.run()
  }

  confirmMassDelete(accept: boolean): void {
    this.status.pendingMassDelete = null
    if (accept) {
      this.confirmedMassDelete = true
      this.status.state = 'idle'
      this.syncNow()
    } else {
      // refusing a mass delete pauses the pair — the user must decide
      this.cfg.paused = true
      this.status.state = 'paused'
      this.pushStatus()
    }
  }

  private async run(): Promise<void> {
    if (this.stopped || this.cfg.paused) return
    if (this.running) {
      this.rerun = true
      return
    }
    this.running = true
    this.status.state = 'syncing'
    this.pushStatus()
    try {
      const confirmed = this.confirmedMassDelete
      this.confirmedMassDelete = false
      const { stats } = await syncOnce(this.transport, this.fs, this.index, {
        deviceName: hostname(),
        maxFileBytes: MAX_FILE_BYTES_DEFAULT,
        stabilityMs: STABILITY_MS,
        confirmMassDelete: confirmed ? async () => true : undefined,
      })
      this.saveIndex()
      this.status.counts.downloaded += stats.downloaded
      this.status.counts.uploaded += stats.uploaded
      this.status.counts.conflicts += stats.conflicts
      this.status.counts.skippedLarge = stats.skippedLarge
      this.status.lastSyncAt = Date.now()
      this.status.lastError = stats.errors.length ? stats.errors[0] : null
      this.status.state = this.status.connected ? 'idle' : 'offline'
      // Quota storm guard: every retry would fail the same way each
      // round (watcher + 60s timer) — pause instead of hammering.
      const quotaErrors = stats.errors.filter((e) => e.includes('[507]')).length
      if (quotaErrors > 0 && quotaErrors >= Math.max(1, Math.floor(stats.errors.length / 2))) {
        this.cfg.paused = true
        this.status.state = 'paused'
        this.status.lastError = 'workspace quota exceeded — sync paused'
        this.deps.onAutoPause?.(this.cfg.id, 'quota')
      }
      if (stats.downloaded || stats.uploaded || stats.deletedLocal || stats.deletedRemote) {
        this.deps.log(
          `sync[${this.cfg.sessionId.slice(0, 8)}] ↓${stats.downloaded} ↑${stats.uploaded} ` +
          `−L${stats.deletedLocal} −R${stats.deletedRemote} !${stats.conflicts}`,
        )
      }
    } catch (e) {
      if (e instanceof MassDeletePending) {
        this.status.state = 'awaiting_confirmation'
        this.status.pendingMassDelete = { count: e.count, total: e.total }
      } else {
        this.status.state = 'error'
        this.status.lastError = (e as Error)?.message ?? String(e)
      }
    } finally {
      this.running = false
      this.pushStatus()
      if (this.rerun) {
        this.rerun = false
        this.schedule()
      }
    }
  }

  private pushStatus(): void {
    this.deps.onStatusOne?.()
  }
}

export class SyncManager {
  private engines = new Map<string, PairEngine>()

  constructor(private deps: ManagerDeps) {
    this.deps.onStatusOne = () => this.broadcast()
  }

  configure(pairs: SyncPairConfig[]): void {
    const wanted = new Map(pairs.map((p) => [p.id, p]))
    // drop removed / changed pairs
    for (const [id, engine] of this.engines) {
      const next = wanted.get(id)
      const changed =
        !next ||
        next.sessionId !== engine.cfg.sessionId ||
        next.localPath !== engine.cfg.localPath ||
        Boolean(next.paused) !== Boolean(engine.cfg.paused)
      if (changed) {
        engine.stop()
        this.engines.delete(id)
        if (!next) {
          // pairing removed → its index file is dead weight (ids are
          // minted fresh on re-pair, so this can never be reused)
          void import('fs/promises').then(({ rm }) =>
            rm(join(this.deps.indexDir, `${id}.json`), { force: true }).catch(() => {}),
          )
        }
      }
    }
    // start new ones
    for (const p of pairs) {
      if (this.engines.has(p.id)) continue
      try {
        const engine = new PairEngine({ ...p }, this.deps)
        this.engines.set(p.id, engine)
        engine.start()
      } catch (e) {
        this.deps.log(`sync pair ${p.id} failed to start: ${e}`)
      }
    }
    this.broadcast()
  }

  statuses(): SyncPairStatus[] {
    return [...this.engines.values()].map((e) => ({ ...e.status, counts: { ...e.status.counts } }))
  }

  syncNow(id: string): void {
    this.engines.get(id)?.syncNow()
  }

  confirmMassDelete(id: string, accept: boolean): void {
    this.engines.get(id)?.confirmMassDelete(accept)
  }

  stopAll(): void {
    for (const e of this.engines.values()) e.stop()
    this.engines.clear()
  }

  private broadcast(): void {
    this.deps.onStatus(this.statuses())
  }
}

let _manager: SyncManager | null = null

export function initSyncManager(deps: ManagerDeps): SyncManager {
  _manager?.stopAll()
  _manager = new SyncManager(deps)
  return _manager
}

export function getSyncManager(): SyncManager | null {
  return _manager
}
