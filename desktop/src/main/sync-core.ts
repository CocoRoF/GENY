/**
 * sync-core — the pure reconcile engine of the workspace sync.
 *
 * Google-Drive model, star topology: the server workspace is the
 * authoritative hub, this replica converges toward it while pushing its
 * own edits. Everything here is dependency-injected (transport + local
 * fs + index store) so the whole convergence logic is unit-testable in
 * plain Node with fake replicas.
 *
 * Invariants:
 *  - `index.entries[path].lastSyncedSha` is the 3-way merge BASE: the
 *    content this replica and the server last agreed on.
 *  - Conflicts NEVER lose data: the server version keeps the path, the
 *    local version is preserved as "name (충돌-<device> <ts>).ext" and
 *    uploaded too.
 *  - Edit beats delete, in both directions.
 *  - A mass local deletion (server-side wipe propagating down) trips a
 *    safety valve and pauses the pair until the user confirms.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface RemoteChange {
  path: string
  is_dir: boolean
  size: number
  mtime_ns: number
  sha256: string
  seq: number
  deleted: boolean
}

export interface ChangesResponse {
  latest_seq: number
  changes: RemoteChange[]
  max_file_bytes?: number
}

export interface Transport {
  changes(since: number): Promise<ChangesResponse>
  /** Download workspace-relative path into the local absolute file. */
  download(path: string, toAbs: string): Promise<void>
  /** PUT exact path. Returns new sha; throws SyncConflictError on 409. */
  put(path: string, fromAbs: string, baseSha: string): Promise<{ sha256: string }>
  del(path: string, baseSha?: string): Promise<void>
  mkdir(path: string): Promise<void>
}

export class SyncConflictError extends Error {
  currentSha?: string
  constructor(currentSha?: string) {
    super('sync conflict')
    this.currentSha = currentSha
  }
}

export interface LocalStat {
  isDir: boolean
  size: number
  mtimeMs: number
}

export interface LocalFs {
  /** Full scan of the replica root → workspace-relative path map.
   *  Must already exclude ignored paths and symlinks. */
  scan(): Promise<Map<string, LocalStat>>
  hash(path: string): Promise<string>
  absPath(path: string): string
  /** Atomic apply: caller downloads to temp inside, then rename. */
  removeFile(path: string): Promise<void>
  removeDirIfEmpty(path: string): Promise<boolean>
  mkdir(path: string): Promise<void>
  /** Rename `path` to a conflict-preserving sibling; returns its rel path. */
  renameToConflict(path: string, deviceName: string): Promise<string>
  stat(path: string): Promise<LocalStat | null>
}

export interface IndexEntry {
  isDir: boolean
  size: number
  mtimeMs: number
  sha: string // local content sha at last sync
  lastSyncedSha: string // merge base ('' for dirs)
}

export interface SyncIndex {
  cursor: number
  entries: Record<string, IndexEntry>
}

export interface SyncStats {
  downloaded: number
  uploaded: number
  deletedLocal: number
  deletedRemote: number
  conflicts: number
  skippedLarge: number
  errors: string[]
}

export interface SyncOptions {
  deviceName: string
  maxFileBytes: number
  /** Files modified more recently than this are left for the next round
   *  (they may still be mid-write). */
  stabilityMs: number
  now?: () => number
  /** Mass-delete valve: called when the plan wants to delete this many
   *  local entries at once; return false to abort the whole round. */
  confirmMassDelete?: (count: number, total: number) => Promise<boolean>
}

export class MassDeletePending extends Error {
  count: number
  total: number
  constructor(count: number, total: number) {
    super('mass delete requires confirmation')
    this.count = count
    this.total = total
  }
}

const MASS_DELETE_MIN = 50
const MASS_DELETE_RATIO = 0.3

/** One full convergence round. Mutates and returns `index`. */
export async function syncOnce(
  transport: Transport,
  fs: LocalFs,
  index: SyncIndex,
  opts: SyncOptions,
): Promise<{ index: SyncIndex; stats: SyncStats }> {
  const stats: SyncStats = {
    downloaded: 0, uploaded: 0, deletedLocal: 0, deletedRemote: 0,
    conflicts: 0, skippedLarge: 0, errors: [],
  }
  const now = opts.now ?? (() => Date.now())

  // ── 1. gather both sides ────────────────────────────────────────────
  const remote = await transport.changes(index.cursor)
  const maxBytes = remote.max_file_bytes && remote.max_file_bytes > 0
    ? Math.min(remote.max_file_bytes, opts.maxFileBytes)
    : opts.maxFileBytes
  const remoteByPath = new Map<string, RemoteChange>()
  for (const c of remote.changes) remoteByPath.set(c.path, c) // later seq wins (ordered)

  const local = await fs.scan()

  // Local content shas: hash only entries whose (size, mtimeMs) moved
  // vs the index — same shortcut the server uses.
  const localSha = new Map<string, string>()
  for (const [p, st] of local) {
    if (st.isDir) continue
    const known = index.entries[p]
    if (known && !known.isDir && known.size === st.size && known.mtimeMs === st.mtimeMs) {
      // Unchanged since last sync — sha known, no deferral needed (a
      // just-downloaded file has a fresh mtime but IS stable).
      localSha.set(p, known.sha)
    } else if (now() - st.mtimeMs < opts.stabilityMs) {
      continue // genuinely fresh unknown write — may be mid-write, defer
    } else {
      try {
        localSha.set(p, await fs.hash(p))
      } catch {
        /* vanished mid-scan — treat as absent */
      }
    }
  }

  // ── 2. build the union of paths that may need action ────────────────
  const paths = new Set<string>([
    ...remoteByPath.keys(),
    ...local.keys(),
    ...Object.keys(index.entries),
  ])

  type Action =
    | { kind: 'download'; path: string; sha: string; isDir: boolean }
    | { kind: 'deleteLocal'; path: string; isDir: boolean }
    | { kind: 'upload'; path: string; baseSha: string }
    | { kind: 'deleteRemote'; path: string; baseSha: string; isDir: boolean }
    | { kind: 'mkdirRemote'; path: string }
    | { kind: 'conflict'; path: string; serverSha: string }
    | { kind: 'settle'; path: string; sha: string } // both ended up identical

  const plan: Action[] = []

  for (const p of paths) {
    const rc = remoteByPath.get(p)
    const st = local.get(p) ?? null
    const idx = index.entries[p]
    const base = idx?.lastSyncedSha ?? ''

    // Deferred unstable file: pretend we didn't look at it this round.
    if (st && !st.isDir && !localSha.has(p)) continue

    const localExists = st !== null
    const lsha = st && !st.isDir ? (localSha.get(p) as string) : ''

    // What does the server say? (only for paths in the delta)
    const serverChanged = rc !== undefined && (
      rc.deleted ? idx !== undefined || localExists
                 : rc.sha256 !== base || rc.is_dir !== (idx?.isDir ?? rc.is_dir) || idx === undefined
    )
    const serverDeleted = rc?.deleted === true

    // What changed locally since the base?
    const localNew = localExists && idx === undefined
    const localDeleted = !localExists && idx !== undefined
    const localModified = localExists && idx !== undefined && !st!.isDir && lsha !== base
    const localChanged = localNew || localDeleted || localModified

    if (!serverChanged && !localChanged) continue

    // ── directories ───────────────────────────────────────────────────
    if ((rc?.is_dir ?? st?.isDir ?? idx?.isDir) === true) {
      if (serverChanged && !serverDeleted && !localExists) {
        plan.push({ kind: 'download', path: p, sha: '', isDir: true }) // mkdir local
      } else if (serverDeleted && localExists && !localChanged) {
        plan.push({ kind: 'deleteLocal', path: p, isDir: true })
      } else if (localNew && rc === undefined) {
        plan.push({ kind: 'mkdirRemote', path: p })
      } else if (localDeleted && !serverChanged) {
        plan.push({ kind: 'deleteRemote', path: p, baseSha: '', isDir: true })
      } else if (serverDeleted && localDeleted) {
        delete index.entries[p]
      } else if (localExists && rc && !serverDeleted) {
        // both have the dir — just settle the index
        plan.push({ kind: 'settle', path: p, sha: '' })
      }
      continue
    }

    // ── files ─────────────────────────────────────────────────────────
    const tooLarge = (st && st.size > maxBytes) || (rc && !rc.deleted && rc.size > maxBytes)
    if (tooLarge) {
      stats.skippedLarge += 1
      continue
    }

    if (serverChanged && !localChanged) {
      if (serverDeleted) {
        if (localExists) plan.push({ kind: 'deleteLocal', path: p, isDir: false })
        else delete index.entries[p]
      } else if (rc!.sha256 === lsha && localExists) {
        plan.push({ kind: 'settle', path: p, sha: lsha }) // converged already
      } else {
        plan.push({ kind: 'download', path: p, sha: rc!.sha256, isDir: false })
      }
      continue
    }

    if (localChanged && !serverChanged) {
      if (localDeleted) {
        plan.push({ kind: 'deleteRemote', path: p, baseSha: base, isDir: false })
      } else {
        plan.push({ kind: 'upload', path: p, baseSha: localNew ? '' : base })
      }
      continue
    }

    // both changed
    if (serverDeleted && localDeleted) {
      delete index.entries[p]
    } else if (serverDeleted && localExists) {
      // edit wins over delete → resurrect our version
      plan.push({ kind: 'upload', path: p, baseSha: base })
    } else if (localDeleted && !serverDeleted) {
      // server edited what we deleted → edit wins, bring it back
      plan.push({ kind: 'download', path: p, sha: rc!.sha256, isDir: false })
    } else if (rc!.sha256 === lsha) {
      plan.push({ kind: 'settle', path: p, sha: lsha }) // identical edits
    } else {
      plan.push({ kind: 'conflict', path: p, serverSha: rc!.sha256 })
    }
  }

  // ── 3. mass-delete safety valve ─────────────────────────────────────
  const localDeletions = plan.filter((a) => a.kind === 'deleteLocal').length
  const tracked = Object.keys(index.entries).length
  if (
    tracked > 20 &&
    localDeletions >= Math.max(MASS_DELETE_MIN, Math.ceil(tracked * MASS_DELETE_RATIO))
  ) {
    const ok = opts.confirmMassDelete
      ? await opts.confirmMassDelete(localDeletions, tracked)
      : false
    if (!ok) throw new MassDeletePending(localDeletions, tracked)
  }

  // ── 4. execute — creates parent-first, deletes child-first ──────────
  const depth = (p: string): number => p.split('/').length
  const creations = plan.filter((a) => a.kind !== 'deleteLocal' && a.kind !== 'deleteRemote')
    .sort((a, b) => depth((a as any).path) - depth((b as any).path))
  const deletions = plan.filter((a) => a.kind === 'deleteLocal' || a.kind === 'deleteRemote')
    .sort((a, b) => depth((b as any).path) - depth((a as any).path))

  for (const action of [...creations, ...deletions]) {
    try {
      await applyAction(action, transport, fs, index, stats, opts)
    } catch (e: any) {
      stats.errors.push(`${(action as any).kind} ${(action as any).path}: ${e?.message ?? e}`)
    }
  }

  index.cursor = remote.latest_seq
  return { index, stats }
}

async function applyAction(
  action: any,
  transport: Transport,
  fs: LocalFs,
  index: SyncIndex,
  stats: SyncStats,
  opts: SyncOptions,
): Promise<void> {
  const p: string = action.path
  switch (action.kind) {
    case 'settle': {
      const st = await fs.stat(p)
      index.entries[p] = {
        isDir: action.sha === '' && (st?.isDir ?? false),
        size: st?.size ?? 0,
        mtimeMs: st?.mtimeMs ?? 0,
        sha: action.sha,
        lastSyncedSha: action.sha,
      }
      break
    }
    case 'download': {
      if (action.isDir) {
        await fs.mkdir(p)
        index.entries[p] = { isDir: true, size: 0, mtimeMs: 0, sha: '', lastSyncedSha: '' }
      } else {
        await transport.download(p, fs.absPath(p))
        const st = await fs.stat(p)
        index.entries[p] = {
          isDir: false, size: st?.size ?? 0, mtimeMs: st?.mtimeMs ?? 0,
          sha: action.sha, lastSyncedSha: action.sha,
        }
        stats.downloaded += 1
      }
      break
    }
    case 'deleteLocal': {
      if (action.isDir) {
        await fs.removeDirIfEmpty(p)
      } else {
        await fs.removeFile(p)
        stats.deletedLocal += 1
      }
      delete index.entries[p]
      break
    }
    case 'mkdirRemote': {
      try {
        await transport.mkdir(p)
      } catch {
        /* 409 already-exists is fine */
      }
      index.entries[p] = { isDir: true, size: 0, mtimeMs: 0, sha: '', lastSyncedSha: '' }
      break
    }
    case 'deleteRemote': {
      try {
        await transport.del(p, action.baseSha || undefined)
        stats.deletedRemote += 1
        delete index.entries[p]
      } catch (e) {
        if (e instanceof SyncConflictError) {
          // server changed it since → edit wins: pull the server version
          await transport.download(p, fs.absPath(p))
          const st = await fs.stat(p)
          const sha = e.currentSha ?? (await fs.hash(p))
          index.entries[p] = {
            isDir: false, size: st?.size ?? 0, mtimeMs: st?.mtimeMs ?? 0,
            sha, lastSyncedSha: sha,
          }
          stats.downloaded += 1
        } else if ((e as any)?.status === 404) {
          delete index.entries[p] // already gone server-side
        } else {
          throw e
        }
      }
      break
    }
    case 'upload': {
      try {
        const res = await transport.put(p, fs.absPath(p), action.baseSha)
        const st = await fs.stat(p)
        index.entries[p] = {
          isDir: false, size: st?.size ?? 0, mtimeMs: st?.mtimeMs ?? 0,
          sha: res.sha256, lastSyncedSha: res.sha256,
        }
        stats.uploaded += 1
      } catch (e) {
        if (e instanceof SyncConflictError) {
          // raced with another replica → full conflict flow
          await resolveConflict(p, e.currentSha ?? '', transport, fs, index, stats, opts)
        } else {
          throw e
        }
      }
      break
    }
    case 'conflict': {
      await resolveConflict(p, action.serverSha, transport, fs, index, stats, opts)
      break
    }
  }
}

/** Both sides edited: server keeps the path; the local version survives
 *  as a conflict-named sibling and is uploaded as a new file. */
async function resolveConflict(
  p: string,
  serverSha: string,
  transport: Transport,
  fs: LocalFs,
  index: SyncIndex,
  stats: SyncStats,
  opts: SyncOptions,
): Promise<void> {
  const conflictPath = await fs.renameToConflict(p, opts.deviceName)
  await transport.download(p, fs.absPath(p))
  const st = await fs.stat(p)
  const sha = serverSha || (await fs.hash(p))
  index.entries[p] = {
    isDir: false, size: st?.size ?? 0, mtimeMs: st?.mtimeMs ?? 0,
    sha, lastSyncedSha: sha,
  }
  stats.downloaded += 1
  try {
    const res = await transport.put(conflictPath, fs.absPath(conflictPath), '')
    const cst = await fs.stat(conflictPath)
    index.entries[conflictPath] = {
      isDir: false, size: cst?.size ?? 0, mtimeMs: cst?.mtimeMs ?? 0,
      sha: res.sha256, lastSyncedSha: res.sha256,
    }
    stats.uploaded += 1
  } catch (e: any) {
    stats.errors.push(`conflict-copy upload ${conflictPath}: ${e?.message ?? e}`)
  }
  stats.conflicts += 1
}

/** Conflict sibling name: "report (충돌-PC-A 2026-07-30 14:22).md" */
export function conflictName(name: string, deviceName: string, when: Date): string {
  const ts = `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}-${String(when.getDate()).padStart(2, '0')} ${String(when.getHours()).padStart(2, '0')}${String(when.getMinutes()).padStart(2, '0')}`
  const i = name.lastIndexOf('.')
  const stem = i > 0 ? name.slice(0, i) : name
  const ext = i > 0 ? name.slice(i) : ''
  const dev = deviceName.replace(/[\\/:*?"<>|]/g, '_').slice(0, 24) || 'device'
  return `${stem} (충돌-${dev} ${ts})${ext}`
}
