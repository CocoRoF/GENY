/**
 * PROBE — "the cloud is the authoritative source" across an offline gap.
 *
 * The chain under test is the one that actually happens to users:
 *
 *    [PC powered off] → [web/agent edits the cloud] → [PC comes back]
 *
 * The engine keeps a per-path merge BASE (`lastSyncedSha`) exactly so it can
 * tell "the server deleted this" from "I created this while away". This probe
 * asks what happens when that base is degraded or absent — which is the
 * normal case after a hard power-off, since the index is written without an
 * fsync and a torn file reads back as "no index at all".
 *
 * Run: npx tsx tests/offline-authority.probe.ts
 */

import { createHash } from 'crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'fs'
import { readFile, writeFile, mkdir as mkdirP, rename } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { ChangesResponse, recoverBaseFromServerRef, SyncIndex, syncOnce, SyncConflictError, Transport } from '../src/main/sync-core'
import { ReplicaFs } from '../src/main/sync-fs'

interface HubEntry { is_dir: boolean; data: Buffer; sha: string; seq: number; deleted: boolean }

/** Fake hub mirroring backend workspace_sync — including TOMBSTONE PRUNING,
 *  which the existing convergence suite does not simulate. */
class Hub {
  entries = new Map<string, HubEntry>()
  seq = 0
  pruneWatermark = 0
  /** Server-side remote-tracking refs, keyed by device. */
  refs = new Map<string, { cursor: number; acked_ts: number }>()

  private bump(): number { return ++this.seq }
  sha(b: Buffer): string { return createHash('sha256').update(b).digest('hex') }

  agentWrite(path: string, content: string): void {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/')
      const e = this.entries.get(dir)
      if (!e || e.deleted) {
        this.entries.set(dir, { is_dir: true, data: Buffer.alloc(0), sha: '', seq: this.bump(), deleted: false })
      }
    }
    const buf = Buffer.from(content)
    this.entries.set(path, { is_dir: false, data: buf, sha: this.sha(buf), seq: this.bump(), deleted: false })
  }

  agentDelete(path: string): void {
    for (const [p, e] of this.entries) {
      if (!e.deleted && (p === path || p.startsWith(path + '/'))) {
        this.entries.set(p, { ...e, deleted: true, seq: this.bump(), data: Buffer.alloc(0) })
      }
    }
  }

  /** Backend `_prune_tombstones`: drop tombstones older than the TTL and
   *  raise the watermark, so cursors from before it are declared stale. */
  pruneTombstones(): void {
    let highest = 0
    for (const [p, e] of [...this.entries]) {
      if (e.deleted) { highest = Math.max(highest, e.seq); this.entries.delete(p) }
    }
    this.pruneWatermark = Math.max(this.pruneWatermark, highest)
  }

  live(): string[] {
    return [...this.entries.entries()].filter(([, e]) => !e.deleted).map(([p]) => p).sort()
  }

  transport(): Transport {
    const hub = this
    return {
      async changes(since: number): Promise<ChangesResponse> {
        const rows = [...hub.entries.entries()]
          .filter(([, e]) => (since <= 0 ? !e.deleted : e.seq > since))
          .sort((a, b) => a[1].seq - b[1].seq)
          .map(([p, e]) => ({
            path: p, is_dir: e.is_dir, size: e.data.length, mtime_ns: e.seq * 1e6,
            sha256: e.sha, seq: e.seq, deleted: e.deleted,
          }))
        return {
          latest_seq: hub.seq,
          stale_cursor: since > 0 && since < hub.pruneWatermark,
          changes: rows,
        }
      },
      async download(path: string, toAbs: string): Promise<void> {
        const e = hub.entries.get(path)
        if (!e || e.deleted) throw new Error('404')
        await mkdirP(dirname(toAbs), { recursive: true })
        const tmp = toAbs + '.part'
        await writeFile(tmp, e.data)
        await rename(tmp, toAbs)
      },
      async put(path: string, fromAbs: string, baseSha: string): Promise<{ sha256: string }> {
        const cur = hub.entries.get(path)
        const curSha = cur && !cur.deleted ? cur.sha : ''
        if ((baseSha || '') !== curSha) throw new SyncConflictError(curSha)
        const data = await readFile(fromAbs)
        const sha = hub.sha(data)
        hub.entries.set(path, { is_dir: false, data, sha, seq: hub.bump(), deleted: false })
        return { sha256: sha }
      },
      async del(path: string): Promise<void> { hub.agentDelete(path) },
      async mkdir(path: string): Promise<void> {
        const e = hub.entries.get(path)
        if (!e || e.deleted) {
          hub.entries.set(path, { is_dir: true, data: Buffer.alloc(0), sha: '', seq: hub.bump(), deleted: false })
        }
      },
    }
  }
}

class PC {
  root: string
  fs: ReplicaFs
  index: SyncIndex = { cursor: 0, entries: {} }
  constructor(public name: string, public hub: Hub) {
    this.root = mkdtempSync(join(tmpdir(), `probe-${name}-`))
    this.fs = new ReplicaFs(this.root)
  }
  write(rel: string, content: string, ageMs = 5_000): void {
    const abs = join(this.root, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
    const t = new Date(Date.now() - ageMs)
    utimesSync(abs, t, t)
  }
  has(rel: string): boolean { return existsSync(join(this.root, rel)) }
  read(rel: string): string { return readFileSync(join(this.root, rel), 'utf-8') }
  tree(dir = ''): string[] {
    const abs = join(this.root, dir)
    if (!existsSync(abs)) return []
    const out: string[] = []
    for (const name of readdirSync(abs)) {
      if (name.startsWith('.geny-sync')) continue
      const rel = dir ? `${dir}/${name}` : name
      out.push(rel)
      if (statSync(join(this.root, rel)).isDirectory()) out.push(...this.tree(rel))
    }
    return out.sort()
  }
  /** Hard power-off: the index write never reached the platter. */
  loseIndex(): void { this.index = { cursor: 0, entries: {} }; this.lost = true }
  private lost = false

  /** Time passes while the PC is off — every local file is settled by the
   *  time it boots. Without this the engine's stability window defers files
   *  that were written microseconds ago, which is a property of the probe's
   *  clock, not of the offline scenario being modelled. */
  timePasses(dir = ''): void {
    const abs = join(this.root, dir)
    if (!existsSync(abs)) return
    const t = new Date(Date.now() - 3_600_000)
    for (const name of readdirSync(abs)) {
      if (name.startsWith('.geny-sync')) continue
      const rel = dir ? `${dir}/${name}` : name
      if (statSync(join(this.root, rel)).isDirectory()) this.timePasses(rel)
      else utimesSync(join(this.root, rel), t, t)
    }
  }
  async sync(opts: Record<string, unknown> = {}) {
    if (this.lost) {
      this.lost = false
      const ref = this.hub.refs.get(this.name)
      if (ref && ref.cursor) {
        const snap = await this.hub.transport().changes(0)
        const serverSha = new Map<string, string>()
        for (const c of snap.changes) if (!c.deleted && !c.is_dir) serverSha.set(c.path, c.sha256)
        this.index = await recoverBaseFromServerRef(this.fs, ref, serverSha)
      }
    }
    const res = await syncOnce(this.hub.transport(), this.fs, this.index, {
      deviceName: this.name, maxFileBytes: 500 * 1024 * 1024, stabilityMs: 500,
      confirmMassDelete: async () => true, ...opts,
    } as never)
    this.index = res.index
    if (!res.stats.errors.length) {
      this.hub.refs.set(this.name, {
        cursor: this.index.cursor,
        acked_ts: Math.floor(Date.now() / 1000),
      })
    }
    return res.stats
  }
}

const results: Array<[string, boolean, string]> = []
function check(name: string, ok: boolean, detail = ''): void {
  results.push([name, ok, detail])
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

async function main(): Promise<void> {
  // ── P1: the plain chain, index intact ───────────────────────────────
  {
    const hub = new Hub(); const pc = new PC('PC', hub)
    hub.agentWrite('doc.txt', 'v1')
    hub.agentWrite('keep.txt', 'keep')
    await pc.sync()

    // PC is off. The web/agent edits the cloud.
    hub.agentWrite('doc.txt', 'v2-web')
    hub.agentWrite('new-from-web.txt', 'made on the web')
    hub.agentDelete('keep.txt')

    pc.timePasses()
    await pc.sync() // PC comes back
    check('P1 web edit lands on the PC', pc.has('doc.txt') && pc.read('doc.txt') === 'v2-web')
    check('P1 web-created file lands', pc.has('new-from-web.txt'))
    check('P1 web deletion lands', !pc.has('keep.txt'), pc.has('keep.txt') ? 'still present' : '')
  }

  // ── P2: same chain, but the index did not survive the power-off ─────
  {
    const hub = new Hub(); const pc = new PC('PC', hub)
    hub.agentWrite('doc.txt', 'v1')
    hub.agentWrite('deleted-on-web.txt', 'should die')
    await pc.sync()

    pc.loseIndex()                       // torn index.json → parsed as none
    hub.agentWrite('doc.txt', 'v2-web')
    hub.agentDelete('deleted-on-web.txt')

    pc.timePasses()
    const st2 = await pc.sync()
    console.log('   [P2 stats]', JSON.stringify(st2))
    console.log('   [P2 hub live]', hub.live().join(', '))
    console.log('   [P2 pc tree]', pc.tree().join(', '))
    check('P2 web edit still lands after index loss',
      pc.read('doc.txt') === 'v2-web', `doc.txt=${pc.has('doc.txt') ? pc.read('doc.txt') : '<missing>'}`)
    check('P2 web DELETION is honoured after index loss',
      !pc.has('deleted-on-web.txt'),
      pc.has('deleted-on-web.txt') ? 'file resurrected locally' : '')
    check('P2 deletion not pushed back to the cloud',
      !hub.live().includes('deleted-on-web.txt'),
      hub.live().includes('deleted-on-web.txt') ? 'RESURRECTED IN THE CLOUD' : '')
  }

  // ── P3: away longer than the tombstone TTL ──────────────────────────
  {
    const hub = new Hub(); const pc = new PC('PC', hub)
    hub.agentWrite('a.txt', 'a'); hub.agentWrite('gone.txt', 'g')
    await pc.sync()

    hub.agentDelete('gone.txt')
    hub.pruneTombstones()                // 30+ days pass
    hub.agentWrite('b.txt', 'b')

    pc.timePasses()
    await pc.sync()
    check('P3 stale cursor still converges (deletion applied)',
      !pc.has('gone.txt'), pc.has('gone.txt') ? 'stale tombstone missed' : '')
    check('P3 later cloud writes land', pc.has('b.txt'))
    check('P3 nothing resurrected in the cloud',
      !hub.live().includes('gone.txt'),
      hub.live().includes('gone.txt') ? 'RESURRECTED' : '')
  }

  // ── P4: real divergence — both sides edited during the gap ──────────
  {
    const hub = new Hub(); const pc = new PC('PC', hub)
    hub.agentWrite('shared.txt', 'base')
    await pc.sync()

    pc.write('shared.txt', 'local edit made offline')
    hub.agentWrite('shared.txt', 'web edit made while PC was off')

    await pc.sync()
    const conflictCopy = pc.tree().find((p) => p.includes('충돌'))
    check('P4 cloud version wins the path',
      pc.read('shared.txt') === 'web edit made while PC was off', `got=${pc.read('shared.txt')}`)
    check('P4 local edit preserved as a conflict copy',
      !!conflictCopy && pc.read(conflictCopy) === 'local edit made offline', conflictCopy ?? 'none')
  }

  // ── P5: divergence AND a lost index (the realistic power-off) ───────
  {
    const hub = new Hub(); const pc = new PC('PC', hub)
    hub.agentWrite('shared.txt', 'base')
    await pc.sync()

    pc.write('shared.txt', 'local edit made offline')
    hub.agentWrite('shared.txt', 'web edit made while PC was off')
    pc.loseIndex()

    await pc.sync()
    const conflictCopy = pc.tree().find((p) => p.includes('충돌'))
    check('P5 cloud version wins the path after index loss',
      pc.read('shared.txt') === 'web edit made while PC was off', `got=${pc.read('shared.txt')}`)
    check('P5 local edit still preserved after index loss',
      !!conflictCopy, conflictCopy ?? 'LOCAL EDIT LOST')
  }

  // ── P6: locally created while offline must still upload ─────────────
  {
    const hub = new Hub(); const pc = new PC('PC', hub)
    hub.agentWrite('a.txt', 'a')
    await pc.sync()
    pc.write('made-offline.txt', 'user made this on the plane')
    await pc.sync()
    check('P6 offline local creation reaches the cloud',
      hub.live().includes('made-offline.txt'))
  }

  const failed = results.filter(([, ok]) => !ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  if (failed.length) {
    console.log('\nFAILING:')
    for (const [n, , d] of failed) console.log(`  · ${n}${d ? ` — ${d}` : ''}`)
  }
  rmSync(join(tmpdir(), 'probe-'), { recursive: true, force: true })
}

main().then(() => blastRadius()).catch((e) => { console.error(e); process.exit(1) })

/** Blast radius: how much damage does one lost index actually do? */
export async function blastRadius(): Promise<void> {
  const hub = new Hub(); const pc = new PC('PC', hub)
  for (let i = 0; i < 50; i++) hub.agentWrite(`f${i}.txt`, `v1-${i}`)
  pc.timePasses(); await pc.sync()

  for (let i = 0; i < 20; i++) hub.agentWrite(`f${i}.txt`, `v2-web-${i}`)   // web edits
  for (let i = 20; i < 30; i++) hub.agentDelete(`f${i}.txt`)                // web deletes

  pc.loseIndex()
  pc.timePasses()
  const st = await pc.sync()

  const junk = pc.tree().filter((p) => p.includes('충돌')).length
  const resurrectedLocal = Array.from({ length: 10 }, (_, k) => `f${20 + k}.txt`)
    .filter((f) => pc.has(f)).length
  const resurrectedCloud = hub.live().filter((p) => /^f2\d\.txt$/.test(p)).length
  const junkInCloud = hub.live().filter((p) => p.includes('충돌')).length

  console.log('\n── blast radius of ONE lost index (50 files, 20 web-edited, 10 web-deleted) ──')
  console.log(`   stats            : ${JSON.stringify(st)}`)
  console.log(`   resurrected local: ${resurrectedLocal}/10 deleted files came back`)
  console.log(`   resurrected cloud: ${resurrectedCloud}/10 pushed back INTO the cloud`)
  console.log(`   junk conflict copies: ${junk} local / ${junkInCloud} in the cloud`)
}
