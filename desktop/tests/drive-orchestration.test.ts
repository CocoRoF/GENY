/**
 * Geny Drive orchestration — folder allocation, config reconciliation, and
 * root relocation.
 *
 * These are the pure decisions the drive makes on top of the (already
 * convergence-tested) sync engine: WHICH folder an agent gets, WHICH pairs
 * exist for a given toggle state, and what happens to the bytes on disk when
 * the user moves the drive. Run: npx tsx tests/drive-orchestration.test.ts
 */

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, renameSync, cpSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import assert from 'assert'

// ── the pure logic under test (mirrors main/index.ts) ──────────────────────

function allocateDriveFolder(
  label: string,
  agents: Record<string, { folder: string }>,
  sessionId: string,
): string {
  const taken = new Set(
    Object.entries(agents)
      .filter(([sid]) => sid !== sessionId)
      .map(([, a]) => a.folder.toLowerCase()),
  )
  const base =
    (label || sessionId)
      .normalize('NFC')
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[. ]+$/, '')
      .slice(0, 48) || sessionId.slice(0, 8)
  let name = base
  let n = 2
  while (taken.has(name.toLowerCase())) name = `${base}-${n++}`
  return name
}

type Pair = { id: string; sessionId: string; localPath: string; managed?: 'drive'; sessionLabel?: string }
type Agents = Record<string, { enabled: boolean; folder: string; label?: string }>

function reconcilePairs(root: string, agents: Agents, existing: Pair[]): Pair[] {
  const others = existing.filter((p) => p.managed !== 'drive')
  const managed = Object.entries(agents)
    .filter(([, a]) => a.enabled)
    .map(([sessionId, a]) => ({
      id: `drive:${sessionId}`,
      sessionId,
      sessionLabel: a.label,
      localPath: join(root, a.folder),
      managed: 'drive' as const,
    }))
  return [...others, ...managed]
}

function relocate(current: string, target: string, agents: Agents): number {
  mkdirSync(target, { recursive: true })
  let moved = 0
  for (const entry of Object.values(agents)) {
    const from = join(current, entry.folder)
    const to = join(target, entry.folder)
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
const ok = (name: string) => { console.log(`  ok — ${name}`); passed++ }

// 1) folder naming
{
  assert.strictEqual(allocateDriveFolder('ellen_new', {}, 's1'), 'ellen_new')
  assert.strictEqual(allocateDriveFolder('내 에이전트', {}, 's1'), '내 에이전트')
  // Windows-reserved characters and separators are scrubbed.
  assert.strictEqual(allocateDriveFolder('a/b:c*d?', {}, 's1'), 'a b c d')
  // Trailing dot/space is illegal on Windows.
  assert.strictEqual(allocateDriveFolder('report.', {}, 's1'), 'report')
  // Empty-ish labels fall back to the session id prefix.
  assert.strictEqual(allocateDriveFolder('   ', {}, 'abcdef1234'), 'abcdef12')
  ok('folder names are filesystem-safe across platforms')
}

// 2) collisions (multiple agents with the same label)
{
  const agents: Agents = { s1: { enabled: true, folder: 'ellen', label: 'ellen' } }
  const second = allocateDriveFolder('ellen', agents, 's2')
  assert.strictEqual(second, 'ellen-2')
  agents.s2 = { enabled: true, folder: second, label: 'ellen' }
  assert.strictEqual(allocateDriveFolder('ellen', agents, 's3'), 'ellen-3')
  // Case-insensitive collision (macOS/Windows filesystems): 'ELLEN' collides
  // with 'ellen', and 'ELLEN-2' with 'ellen-2', so the first free slot is -3.
  assert.strictEqual(allocateDriveFolder('ELLEN', agents, 's4'), 'ELLEN-3')
  ok('same-name agents get unique folders (case-insensitively)')
}

// 3) reconcile: multiple agents on the drive at once
{
  const root = '/drive'
  const agents: Agents = {
    s1: { enabled: true, folder: 'ellen' },
    s2: { enabled: true, folder: 'worker' },
    s3: { enabled: false, folder: 'archived' },
  }
  const manual: Pair = { id: 'manual-1', sessionId: 's9', localPath: '/custom/place' }
  const pairs = reconcilePairs(root, agents, [manual])
  const managed = pairs.filter((p) => p.managed === 'drive')
  assert.strictEqual(managed.length, 2, 'only enabled agents get pairs')
  assert.deepStrictEqual(
    managed.map((p) => p.localPath).sort(),
    [join(root, 'ellen'), join(root, 'worker')].sort(),
  )
  assert.ok(pairs.some((p) => p.id === 'manual-1'), 'hand-made pairs survive untouched')
  assert.deepStrictEqual(managed.map((p) => p.id).sort(), ['drive:s1', 'drive:s2'])
  ok('multiple agents connect simultaneously; manual pairs coexist')
}

// 4) toggling off removes the pair but not the folder; toggling back on
//    reuses the SAME folder + pair id (so the sync index is preserved)
{
  const root = '/drive'
  const agents: Agents = { s1: { enabled: true, folder: 'ellen' } }
  const on = reconcilePairs(root, agents, [])
  agents.s1.enabled = false
  const off = reconcilePairs(root, agents, on)
  assert.strictEqual(off.filter((p) => p.managed === 'drive').length, 0)
  agents.s1.enabled = true
  const again = reconcilePairs(root, agents, off)
  assert.strictEqual(again[0].id, on[0].id, 'pair id is stable across toggles')
  assert.strictEqual(again[0].localPath, on[0].localPath, 'folder is stable across toggles')
  ok('toggle off/on keeps folder + pair id (index survives)')
}

// 5) relocation actually moves bytes and re-points pairs
{
  const base = mkdtempSync(join(tmpdir(), 'geny-drive-'))
  const oldRoot = join(base, 'old')
  const newRoot = join(base, 'new')
  const agents: Agents = {
    s1: { enabled: true, folder: 'ellen' },
    s2: { enabled: true, folder: 'worker' },
  }
  for (const a of Object.values(agents)) {
    mkdirSync(join(oldRoot, a.folder, 'sub'), { recursive: true })
    writeFileSync(join(oldRoot, a.folder, 'sub', 'file.txt'), `data-${a.folder}`)
  }
  const moved = relocate(oldRoot, newRoot, agents)
  assert.strictEqual(moved, 2)
  for (const a of Object.values(agents)) {
    assert.ok(!existsSync(join(oldRoot, a.folder)), 'source folder is gone')
    assert.strictEqual(
      readFileSync(join(newRoot, a.folder, 'sub', 'file.txt'), 'utf-8'),
      `data-${a.folder}`,
      'file contents survive the move',
    )
  }
  const pairs = reconcilePairs(newRoot, agents, [])
  assert.deepStrictEqual(
    pairs.map((p) => p.localPath).sort(),
    [join(newRoot, 'ellen'), join(newRoot, 'worker')].sort(),
  )
  // Pair ids unchanged → per-pair sync indexes (keyed by id) stay valid,
  // so a relocation costs zero re-download.
  assert.deepStrictEqual(pairs.map((p) => p.id).sort(), ['drive:s1', 'drive:s2'])
  rmSync(base, { recursive: true, force: true })
  ok('relocation moves every folder and re-points pairs without new ids')
}

// 6) relocation is non-destructive when the target already has the folder
{
  const base = mkdtempSync(join(tmpdir(), 'geny-drive-'))
  const oldRoot = join(base, 'old')
  const newRoot = join(base, 'new')
  const agents: Agents = { s1: { enabled: true, folder: 'ellen' } }
  mkdirSync(join(oldRoot, 'ellen'), { recursive: true })
  writeFileSync(join(oldRoot, 'ellen', 'a.txt'), 'source')
  mkdirSync(join(newRoot, 'ellen'), { recursive: true })
  writeFileSync(join(newRoot, 'ellen', 'a.txt'), 'PRE-EXISTING')
  const moved = relocate(oldRoot, newRoot, agents)
  assert.strictEqual(moved, 0, 'occupied target is skipped, never clobbered')
  assert.strictEqual(readFileSync(join(newRoot, 'ellen', 'a.txt'), 'utf-8'), 'PRE-EXISTING')
  assert.ok(existsSync(join(oldRoot, 'ellen', 'a.txt')), 'source is left intact')
  rmSync(base, { recursive: true, force: true })
  ok('relocation never clobbers an occupied destination')
}

console.log(`\nALL DRIVE ORCHESTRATION TESTS PASS (${passed})`)
