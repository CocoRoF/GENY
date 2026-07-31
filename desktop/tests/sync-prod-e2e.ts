/**
 * PROD E2E — the real sync engine (sync-core + ReplicaFs +
 * HttpSyncTransport) against the LIVE backend, two temp dirs acting as
 * two PCs. Proves the wire protocol end-to-end, including agent-style
 * server-side writes landing locally.
 *
 * Env: GENY_URL, GENY_TOKEN, GENY_SESSION
 * Run: GENY_URL=... GENY_TOKEN=... GENY_SESSION=... npx tsx tests/sync-prod-e2e.ts
 */

import assert from 'assert'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { SyncIndex, syncOnce } from '../src/main/sync-core'
import { ReplicaFs } from '../src/main/sync-fs'
import { HttpSyncTransport } from '../src/main/sync-transport'

const URL_ = process.env.GENY_URL!
const TOKEN = process.env.GENY_TOKEN!
const SID = process.env.GENY_SESSION!
assert.ok(URL_ && TOKEN && SID, 'GENY_URL/GENY_TOKEN/GENY_SESSION required')

const PREFIX = `e2e-sync-${Date.now().toString(36)}`

class Device {
  root: string
  fs: ReplicaFs
  transport: HttpSyncTransport
  index: SyncIndex = { cursor: 0, entries: {} }

  constructor(public name: string, opts: { chunkThresholdBytes?: number } = {}) {
    this.root = mkdtempSync(join(tmpdir(), `geny-prod-${name}-`))
    this.fs = new ReplicaFs(this.root)
    this.transport = new HttpSyncTransport(
      { baseUrl: URL_, token: async () => TOKEN, sessionId: SID, deviceId: `e2e-${name}` },
      join(this.root, '.geny-sync-tmp'),
      opts,
    )
  }

  write(rel: string, content: string): void {
    const abs = join(this.root, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
    const t = new Date(Date.now() - 5000)
    utimesSync(abs, t, t)
  }

  read(rel: string): string {
    return readFileSync(join(this.root, rel), 'utf-8')
  }

  has(rel: string): boolean {
    return existsSync(join(this.root, rel))
  }

  delete(rel: string): void {
    rmSync(join(this.root, rel), { recursive: true, force: true })
  }

  async sync() {
    const res = await syncOnce(this.transport, this.fs, this.index, {
      deviceName: this.name, maxFileBytes: 500 * 1024 * 1024, stabilityMs: 500,
    })
    this.index = res.index
    return res.stats
  }
}

async function main(): Promise<void> {
  // A uses a tiny chunk threshold so the chunked/resumable path is
  // exercised against the real server with a modest file.
  const A = new Device('PC-A', { chunkThresholdBytes: 1024 * 1024 })
  const B = new Device('PC-B')

  // 0) both bootstrap against the real workspace
  let sa = await A.sync()
  await B.sync()
  console.log(`0) bootstrap OK (A downloaded ${sa.downloaded} existing entries)`)

  // 1) A creates → server → B
  A.write(`${PREFIX}/보고서.md`, '# 실서버 E2E v1')
  A.write(`${PREFIX}/데이터/수치.csv`, 'a,b\n1,2')
  sa = await A.sync()
  assert.strictEqual(sa.uploaded, 2, `A upload (${JSON.stringify(sa)})`)
  const sb = await B.sync()
  assert.ok(sb.downloaded >= 2, `B download (${JSON.stringify(sb)})`)
  assert.strictEqual(B.read(`${PREFIX}/보고서.md`), '# 실서버 E2E v1')
  console.log('1) A→server→B propagation OK')

  // 2) B modifies → A
  B.write(`${PREFIX}/보고서.md`, '# B가 고침 v2')
  await B.sync()
  await A.sync()
  assert.strictEqual(A.read(`${PREFIX}/보고서.md`), '# B가 고침 v2')
  console.log('2) modify propagation OK')

  // 3) concurrent edit conflict on the REAL server
  A.write(`${PREFIX}/보고서.md`, '# A의 동시수정')
  B.write(`${PREFIX}/보고서.md`, '# B의 동시수정')
  await A.sync()
  const sc = await B.sync()
  assert.strictEqual(sc.conflicts, 1, `conflict detected (${JSON.stringify(sc)})`)
  assert.strictEqual(B.read(`${PREFIX}/보고서.md`), '# A의 동시수정')
  await A.sync()
  console.log('3) real-server conflict OK (path kept, copy preserved)')

  // 4) delete propagation
  B.delete(`${PREFIX}/데이터/수치.csv`)
  await B.sync()
  await A.sync()
  assert.ok(!A.has(`${PREFIX}/데이터/수치.csv`))
  console.log('4) delete propagation OK')

  // 5) SERVER-SIDE (agent-style) write via the plain upload endpoint —
  //    lands in workspace without touching PUT; replicas must pick it up
  //    through the changes rescan.
  const fd = new FormData()
  fd.append('file', new Blob([`에이전트가 만든 산출물`]), 'agent-made.txt')
  const up = await fetch(
    `${URL_}/api/agents/${SID}/storage/upload?subdir=${encodeURIComponent(PREFIX)}`,
    { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: fd },
  )
  assert.ok(up.ok, `agent-style upload HTTP ${up.status}`)
  const sd = await A.sync()
  assert.ok(A.has(`${PREFIX}/agent-made.txt`), `agent file arrived (${JSON.stringify(sd)})`)
  assert.strictEqual(A.read(`${PREFIX}/agent-made.txt`), '에이전트가 만든 산출물')
  console.log('5) server-side write → local arrival OK')

  // 5.5) chunked/resumable path: 3MiB file goes up in 8MiB-capped parts
  //      (threshold 1MiB on A) and B pulls it back byte-identical.
  const bigPayload = Buffer.alloc(3 * 1024 * 1024)
  for (let i = 0; i < bigPayload.length; i++) bigPayload[i] = i % 251
  const bigAbs = join(A.root, `${PREFIX}/큰파일.bin`)
  mkdirSync(dirname(bigAbs), { recursive: true })
  writeFileSync(bigAbs, bigPayload)
  {
    const t = new Date(Date.now() - 5000)
    utimesSync(bigAbs, t, t)
  }
  const se = await A.sync()
  assert.strictEqual(se.uploaded, 1, `chunked upload (${JSON.stringify(se)})`)
  await B.sync()
  const roundtrip = readFileSync(join(B.root, `${PREFIX}/큰파일.bin`))
  assert.ok(roundtrip.equals(bigPayload), 'chunked file byte-identical after roundtrip')
  console.log('5.5) chunked upload → download roundtrip OK (3MiB, byte-identical)')

  // 6) cleanup: delete the E2E tree, verify both converge empty
  A.delete(PREFIX)
  await A.sync()
  await B.sync()
  assert.ok(!B.has(PREFIX), 'cleanup converged')
  const check = await fetch(
    `${URL_}/api/agents/${SID}/storage/changes?since=0`,
    { headers: { Authorization: `Bearer ${TOKEN}` } },
  ).then((r) => r.json())
  const leftover = (check.changes as Array<{ path: string }>).filter((c) => c.path.startsWith(PREFIX))
  assert.strictEqual(leftover.length, 0, 'server clean')
  console.log('6) cleanup converged, server clean')

  console.log('PROD E2E ALL PASS')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
