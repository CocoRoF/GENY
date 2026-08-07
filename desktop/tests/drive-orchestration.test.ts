/**
 * Geny Drive orchestration — the pure decisions the drive makes on top of the
 * (already convergence-tested) sync engine: WHICH engines exist for a given
 * config, what a linked folder is called, and what happens to the bytes on
 * disk when the user moves the drive.
 *
 * THE MODEL THIS TESTS
 *
 *     [folder] ── [computer] ── [CLOUD] ── [agent]
 *
 * One machine, one edge: <root>/Cloud mirrors the server cloud, and each
 * linked folder gets its own engine into a subtree of that same cloud. There
 * are no per-agent mirrors and no hand-made pairs — an agent reaches shared
 * files through its own connection to the cloud, made on the web.
 *
 * This file used to assert the opposite model, against local copies of
 * functions that had already been deleted from the product. It passed the
 * whole time, describing a structure the app no longer had.
 *
 * Run: npx tsx tests/drive-orchestration.test.ts
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import assert from 'assert'

// ── the pure logic under test (mirrors main/index.ts) ──────────────────────

type Link = { name: string; localPath: string; paused?: boolean }
type Pair = {
  id: string
  sessionId: string
  sessionLabel?: string
  localPath: string
  managed?: 'drive' | 'link'
  remotePrefix?: string
  excludePrefixes?: string[]
  paused?: boolean
}

const CLOUD_SCOPE = '_cloud'
const cloudFolder = (root: string): string => join(root, 'Cloud')

/** Safe subtree name for a linked folder, unique within the drive. */
function allocateLinkName(desired: string, taken: Set<string>): string {
  let name = (desired || 'folder').normalize('NFC').trim()
  name = name.replace(/[<>:"/\\|?*]/g, '_').replace(/[. ]+$/g, '')
  name = name.slice(0, 80) || 'folder'
  let candidate = name
  let i = 2
  const lower = new Set([...taken].map((t) => t.toLowerCase()))
  while (lower.has(candidate.toLowerCase())) candidate = `${name}-${i++}`
  return candidate
}

/** The DERIVED pair set: nothing is stored, everything follows the config. */
function derivePairs(root: string, links: Link[], cloudOn: boolean): Pair[] {
  if (!cloudOn) return []
  const cloudPair: Pair = {
    id: 'cloud',
    sessionId: CLOUD_SCOPE,
    sessionLabel: 'GenyCloud',
    localPath: cloudFolder(root),
    managed: 'drive',
    excludePrefixes: links.map((l) => l.name),
  }
  const linkPairs: Pair[] = links.map((l) => ({
    id: `link:${l.name}`,
    sessionId: CLOUD_SCOPE,
    sessionLabel: l.name,
    localPath: l.localPath,
    managed: 'link',
    remotePrefix: l.name,
    paused: l.paused,
  }))
  return [cloudPair, ...linkPairs]
}

/** Relocating the drive moves the ONE folder the drive owns. */
function relocate(current: string, target: string): number {
  mkdirSync(target, { recursive: true })
  let moved = 0
  for (const folder of ['Cloud']) {
    const from = join(current, folder)
    const to = join(target, folder)
    if (!existsSync(from) || existsSync(to)) continue
    try {
      renameSync(from, to)
    } catch {
      cpSync(from, to, { recursive: true })
      rmSync(from, { recursive: true, force: true })
    }
    moved++
  }
  return moved
}

// ── tests ──────────────────────────────────────────────────────────────────

let passed = 0
const ok = (name: string): void => { console.log(`  ok — ${name}`); passed++ }

function testLinkNames(): void {
  assert.strictEqual(allocateLinkName('myproject', new Set()), 'myproject')
  assert.strictEqual(allocateLinkName('내 자료', new Set()), '내 자료')
  ok('a plain name is kept as typed, including non-ASCII')

  assert.strictEqual(allocateLinkName('a/b:c*d?', new Set()), 'a_b_c_d_')
  assert.strictEqual(allocateLinkName('report.', new Set()), 'report')
  ok('characters no filesystem accepts are folded, trailing dots dropped')

  assert.strictEqual(allocateLinkName('', new Set()), 'folder')
  ok('an empty name still yields something openable')

  const taken = new Set(['docs'])
  assert.strictEqual(allocateLinkName('docs', taken), 'docs-2')
  assert.strictEqual(allocateLinkName('DOCS', taken), 'DOCS-2')
  ok('collisions are suffixed, case-insensitively — one path, one owner')
}

function testDerivedPairs(root: string): void {
  const links: Link[] = [
    { name: 'myproject', localPath: '/home/u/myproject' },
    { name: 'notes', localPath: '/home/u/notes', paused: true },
  ]

  const pairs = derivePairs(root, links, true)
  assert.strictEqual(pairs.length, 3, 'one cloud engine plus one per link')
  assert.deepStrictEqual(pairs.map((p) => p.id), ['cloud', 'link:myproject', 'link:notes'])
  ok('the engine set is the cloud mirror plus one engine per linked folder')

  assert.ok(pairs.every((p) => p.sessionId === CLOUD_SCOPE),
    'every engine addresses the cloud — no computer→agent edge exists')
  ok('every engine points at the cloud, never at an agent')

  const cloud = pairs[0]
  assert.strictEqual(cloud.localPath, join(root, 'Cloud'))
  assert.deepStrictEqual(cloud.excludePrefixes, ['myproject', 'notes'],
    'linked subtrees belong to their own engines')
  ok('the cloud mirror excludes every linked subtree — exactly one owner per path')

  assert.strictEqual(pairs[2].paused, true, 'a paused link stays paused')
  ok('pause state rides on the link, which is what survives a restart')

  assert.deepStrictEqual(derivePairs(root, links, false), [],
    'opting out of the cloud parks every engine')
  ok('cloud off → no engines at all')

  // Ids must be stable, or every toggle throws away a sync baseline.
  const again = derivePairs(root, links, true)
  assert.deepStrictEqual(again.map((p) => p.id), pairs.map((p) => p.id))
  assert.deepStrictEqual(again.map((p) => p.localPath), pairs.map((p) => p.localPath))
  ok('ids and paths are stable across a toggle, so baselines survive')
}

function testRelocation(): void {
  const a = mkdtempSync(join(tmpdir(), 'geny-root-a-'))
  const b = join(mkdtempSync(join(tmpdir(), 'geny-root-b-')), 'moved')

  mkdirSync(join(a, 'Cloud', 'docs'), { recursive: true })
  writeFileSync(join(a, 'Cloud', 'docs', 'file.txt'), 'payload')

  const moved = relocate(a, b)
  assert.strictEqual(moved, 1, 'relocation moved nothing — the cloud stayed behind')
  assert.strictEqual(readFileSync(join(b, 'Cloud', 'docs', 'file.txt'), 'utf-8'), 'payload')
  assert.ok(!existsSync(join(a, 'Cloud')), 'source left behind')
  ok('moving the drive takes the cloud mirror and its contents with it')

  // The old model iterated per-agent folders; once those were gone it moved
  // nothing at all, silently stranding the mirror at the old path.
  const c = mkdtempSync(join(tmpdir(), 'geny-root-c-'))
  assert.strictEqual(relocate(c, join(c, 'sub')), 0, 'nothing to move is not an error')
  ok('an empty drive relocates cleanly')

  // Never clobber: a destination that already holds data is left alone.
  const d = mkdtempSync(join(tmpdir(), 'geny-root-d-'))
  const e = mkdtempSync(join(tmpdir(), 'geny-root-e-'))
  mkdirSync(join(d, 'Cloud'), { recursive: true })
  writeFileSync(join(d, 'Cloud', 'src.txt'), 'source')
  mkdirSync(join(e, 'Cloud'), { recursive: true })
  writeFileSync(join(e, 'Cloud', 'dst.txt'), 'destination')

  assert.strictEqual(relocate(d, e), 0)
  assert.strictEqual(readFileSync(join(e, 'Cloud', 'dst.txt'), 'utf-8'), 'destination')
  assert.ok(existsSync(join(d, 'Cloud', 'src.txt')), 'source destroyed on a refused move')
  ok('relocation never clobbers an occupied destination')
}

function main(): void {
  const root = mkdtempSync(join(tmpdir(), 'geny-drive-'))
  testLinkNames()
  testDerivedPairs(root)
  testRelocation()
  console.log(`\nALL DRIVE ORCHESTRATION TESTS PASS (${passed})`)
}

main()
