/**
 * Convergence simulation — EFFECT PROOF for the sync engine.
 *
 * A fake in-memory hub (mirroring the backend's seq/tombstone/base_sha
 * semantics exactly) + two ReplicaFs replicas on real temp dirs. Every
 * scenario asserts the MEASURED end state: identical trees, preserved
 * conflict copies, resurrections.
 *
 * Run: npx tsx tests/sync-convergence.test.ts
 */

import assert from 'assert'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync, statSync, utimesSync } from 'fs'
import { readFile, writeFile, mkdir as mkdirP, rename } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { createHash } from 'crypto'
import {
  ChangesResponse, MassDeletePending, SyncConflictError, SyncIndex, syncOnce, Transport,
} from '../src/main/sync-core'
import { ReplicaFs } from '../src/main/sync-fs'

// ── fake hub (mirrors backend workspace_sync + PUT semantics) ─────────

interface HubEntry {
  is_dir: boolean
  data: Buffer
  sha: string
  seq: number
  deleted: boolean
}

class FakeHub {
  entries = new Map<string, HubEntry>()
  seq = 0

  private bump(): number {
    return ++this.seq
  }

  sha(b: Buffer): string {
    return createHash('sha256').update(b).digest('hex')
  }

  /** direct server-side write (simulates the AGENT writing a file) */
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
        this.entries.set(p, { ...e, data: Buffer.alloc(0), sha: '', seq: this.bump(), deleted: true })
      }
    }
  }

  transport(): Transport {
    const hub = this
    return {
      async changes(since: number): Promise<ChangesResponse> {
        const rows = [...hub.entries.entries()]
          .map(([path, e]) => ({
            path, is_dir: e.is_dir, size: e.data.length, mtime_ns: 0,
            sha256: e.sha, seq: e.seq, deleted: e.deleted,
          }))
          .filter((r) => (since <= 0 ? !r.deleted : r.seq > since))
          .sort((a, b) => a.seq - b.seq)
        return { latest_seq: hub.seq, changes: rows, max_file_bytes: 500 * 1024 * 1024 }
      },
      async download(path: string, toAbs: string): Promise<void> {
        const e = hub.entries.get(path)
        if (!e || e.deleted) throw Object.assign(new Error('404'), { status: 404 })
        await mkdirP(dirname(toAbs), { recursive: true })
        const tmp = toAbs + '.part'
        await writeFile(tmp, e.data)
        await rename(tmp, toAbs)
      },
      async put(path: string, fromAbs: string, baseSha: string): Promise<{ sha256: string }> {
        const cur = hub.entries.get(path)
        if (cur && !cur.deleted) {
          if (cur.sha !== baseSha) throw new SyncConflictError(cur.sha)
        }
        // edit-wins resurrect: deleted or missing + any base accepted
        const data = await readFile(fromAbs)
        const sha = hub.sha(data)
        // implicit parent dirs (server PUT does mkdir(parents))
        const parts = path.split('/')
        for (let i = 1; i < parts.length; i++) {
          const dir = parts.slice(0, i).join('/')
          const d = hub.entries.get(dir)
          if (!d || d.deleted) {
            hub.entries.set(dir, { is_dir: true, data: Buffer.alloc(0), sha: '', seq: hub.bump(), deleted: false })
          }
        }
        hub.entries.set(path, { is_dir: false, data, sha, seq: hub.bump(), deleted: false })
        return { sha256: sha }
      },
      async del(path: string, baseSha?: string): Promise<void> {
        const cur = hub.entries.get(path)
        if (!cur || cur.deleted) throw Object.assign(new Error('404'), { status: 404 })
        if (baseSha && !cur.is_dir && cur.sha !== baseSha) throw new SyncConflictError(cur.sha)
        hub.agentDelete(path)
      },
      async mkdir(path: string): Promise<void> {
        const cur = hub.entries.get(path)
        if (cur && !cur.deleted) return
        hub.entries.set(path, { is_dir: true, data: Buffer.alloc(0), sha: '', seq: hub.bump(), deleted: false })
      },
    }
  }
}

// ── device harness ────────────────────────────────────────────────────

class Device {
  root: string
  fs: ReplicaFs
  index: SyncIndex = { cursor: 0, entries: {} }

  constructor(public name: string, private hub: FakeHub) {
    this.root = mkdtempSync(join(tmpdir(), `geny-sync-${name}-`))
    this.fs = new ReplicaFs(this.root)
  }

  write(rel: string, content: string, ageMs = 5_000): void {
    const abs = join(this.root, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
    // age the mtime so the stability window doesn't defer it
    const t = new Date(Date.now() - ageMs)
    utimesSync(abs, t, t)
  }

  delete(rel: string): void {
    rmSync(join(this.root, rel), { recursive: true, force: true })
  }

  read(rel: string): string {
    return readFileSync(join(this.root, rel), 'utf-8')
  }

  has(rel: string): boolean {
    return existsSync(join(this.root, rel))
  }

  tree(dir = ''): string[] {
    const abs = join(this.root, dir)
    if (!existsSync(abs)) return []
    const out: string[] = []
    for (const name of readdirSync(abs)) {
      // ignored trees stay device-local by design — exclude from equality
      if (name.startsWith('.geny-sync') || name === 'node_modules' || name === '__pycache__') continue
      const rel = dir ? `${dir}/${name}` : name
      out.push(rel)
      if (statSync(join(this.root, rel)).isDirectory()) out.push(...this.tree(rel))
    }
    return out.sort()
  }

  async sync(opts: Partial<Parameters<typeof syncOnce>[3]> = {}) {
    const res = await syncOnce(this.hub.transport(), this.fs, this.index, {
      deviceName: this.name,
      maxFileBytes: 500 * 1024 * 1024,
      stabilityMs: 500,
      ...opts,
    })
    this.index = res.index
    return res.stats
  }
}

// ── scenarios ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const hub = new FakeHub()
  const A = new Device('PC-A', hub)
  const B = new Device('PC-B', hub)

  // 1) bootstrap: agent already produced files server-side
  hub.agentWrite('outputs/report.md', '# 보고서 v1')
  hub.agentWrite('uploads/data.csv', 'a,b,c')
  await hub.transport().mkdir('빈폴더')
  let s = await A.sync()
  assert.strictEqual(s.downloaded, 2, 'bootstrap downloads')
  assert.strictEqual(A.read('outputs/report.md'), '# 보고서 v1')
  assert.ok(A.has('빈폴더'), 'empty dir materialised')
  console.log('1) bootstrap OK')

  // 2) A creates → B receives
  A.write('메모.txt', '로컬에서 작성')
  A.write('proj/코드.py', 'print(1)')
  s = await A.sync()
  assert.strictEqual(s.uploaded, 2)
  s = await B.sync()
  assert.strictEqual(B.read('메모.txt'), '로컬에서 작성')
  assert.strictEqual(B.read('proj/코드.py'), 'print(1)')
  console.log('2) A→hub→B propagation OK')

  // 3) modify on B → A
  B.write('메모.txt', 'B가 수정함')
  await B.sync()
  await A.sync()
  assert.strictEqual(A.read('메모.txt'), 'B가 수정함')
  console.log('3) modify propagation OK')

  // 4) delete on A → B
  A.delete('uploads/data.csv')
  s = await A.sync()
  assert.strictEqual(s.deletedRemote, 1)
  s = await B.sync()
  assert.strictEqual(s.deletedLocal, 1)
  assert.ok(!B.has('uploads/data.csv'))
  console.log('4) delete propagation OK')

  // 5) TRUE CONFLICT: both edit the same file before either syncs
  A.write('proj/코드.py', 'print("A의 버전")')
  B.write('proj/코드.py', 'print("B의 버전")')
  await A.sync() // A wins the race — server now has A's version
  s = await B.sync()
  assert.strictEqual(s.conflicts, 1, 'B detects the conflict')
  assert.strictEqual(B.read('proj/코드.py'), 'print("A의 버전")', 'server version keeps the path')
  const conflictFile = B.tree('proj').find((p) => p.includes('충돌-PC-B'))
  assert.ok(conflictFile, 'local version preserved as conflict copy')
  assert.strictEqual(B.read(conflictFile!), 'print("B의 버전")', 'no data lost')
  await A.sync() // A pulls the conflict copy
  assert.deepStrictEqual(A.tree(), B.tree(), 'trees identical after conflict')
  console.log('5) concurrent-edit conflict OK (server keeps path, local preserved, trees converge)')

  // 6) edit-vs-delete: A deletes, B edits (A syncs first) → edit wins
  A.delete('메모.txt')
  B.write('메모.txt', '삭제됐지만 B가 살림')
  await A.sync()
  await B.sync() // B uploads (resurrect)
  await A.sync() // A gets it back
  assert.strictEqual(A.read('메모.txt'), '삭제됐지만 B가 살림', 'edit wins over delete')
  console.log('6) edit-vs-delete resurrection OK')

  // 7) offline catch-up: B "offline" while agent + A churn
  hub.agentWrite('outputs/agent-산출물.md', '에이전트가 만든 파일')
  A.write('신규/깊은/경로/파일.txt', '깊은 파일')
  await A.sync()
  hub.agentDelete('outputs/report.md')
  s = await B.sync() // single catch-up round
  assert.strictEqual(B.read('outputs/agent-산출물.md'), '에이전트가 만든 파일')
  assert.strictEqual(B.read('신규/깊은/경로/파일.txt'), '깊은 파일')
  assert.ok(!B.has('outputs/report.md'), 'offline delete converged')
  await A.sync()
  assert.deepStrictEqual(A.tree(), B.tree(), 'trees identical after catch-up')
  console.log('7) offline catch-up OK')

  // 8) ignore rules: junk never uploaded
  A.write('node_modules/lodash/index.js', 'lib')
  A.write('작업물/__pycache__/x.pyc', 'bin')
  A.write('작업물/유효.txt', '유효')
  s = await A.sync()
  assert.strictEqual(s.uploaded, 1, 'only the real file uploads')
  await B.sync()
  assert.ok(!B.has('node_modules'), 'library storm blocked')
  assert.ok(B.has('작업물/유효.txt'))
  console.log('8) ignore rules OK')

  // 9) stability window: a file modified "just now" is deferred
  A.write('방금씀.txt', '아직 쓰는 중', 0 /* fresh mtime */)
  s = await A.sync()
  assert.strictEqual(s.uploaded, 0, 'unstable file deferred')
  A.write('방금씀.txt', '이제 안정됨') // default ages 5s
  s = await A.sync()
  assert.strictEqual(s.uploaded, 1)
  console.log('9) stability window OK')

  // 10) large file skip
  A.write('큰파일.bin', 'x'.repeat(1000))
  s = await A.sync({ maxFileBytes: 100 })
  assert.strictEqual(s.skippedLarge, 1)
  assert.strictEqual(s.uploaded, 0)
  console.log('10) large-file skip OK')
  await A.sync() // sync it for real so trees match later

  // 11) mass-delete valve
  for (let i = 0; i < 60; i++) A.write(`bulk/f${i}.txt`, String(i))
  await A.sync()
  await B.sync()
  for (const [p, e] of hub.entries) {
    if (!e.deleted && p.startsWith('bulk/') && !e.is_dir) hub.agentDelete(p)
  }
  let valveTripped = false
  try {
    await B.sync()
  } catch (e) {
    valveTripped = e instanceof MassDeletePending
  }
  assert.ok(valveTripped, 'mass delete pauses for confirmation')
  assert.ok(B.has('bulk/f0.txt'), 'nothing deleted before confirmation')
  s = await B.sync({ confirmMassDelete: async () => true })
  assert.ok(s.deletedLocal >= 60, 'confirmed mass delete applies')
  console.log('11) mass-delete safety valve OK')

  // final: full convergence
  await A.sync({ confirmMassDelete: async () => true })
  await B.sync()
  assert.deepStrictEqual(A.tree(), B.tree(), 'FINAL: A and B trees identical')
  console.log(`FINAL trees identical (${A.tree().length} entries)`) // proof of convergence

  console.log('ALL CONVERGENCE SCENARIOS PASS')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
