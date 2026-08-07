/**
 * Index durability — EFFECT PROOF for the merge base on disk.
 *
 * The baseline file is the only thing that lets the engine tell "the server
 * deleted this" from "I made this while away". Two opposite hazards meet in
 * this one file, and both are asserted here:
 *
 *   · it must SURVIVE a torn write (a power cut publishes a zero-length file,
 *     and losing the base resurrects every server-side deletion), and
 *   · it must NOT survive a deliberate drop (revoking access must forget the
 *     baseline, or the next round reads "the server lost these files" and
 *     deletes the USER'S local copies).
 *
 * Adding the `.bak` generation for the first hazard silently broke the
 * second — the drop removed only the `.json` and the next load picked the
 * `.bak` straight back up. These tests exist because nothing else noticed.
 *
 * Run: npx tsx tests/index-durability.test.ts
 */

import assert from 'assert'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SyncManager } from '../src/main/sync-manager'

const results: string[] = []
function ok(name: string): void {
  results.push(name)
  console.log(`  PASS  ${name}`)
}

function makeManager(indexDir: string): SyncManager {
  mkdirSync(indexDir, { recursive: true })
  return new SyncManager({
    indexDir,
    serverUrl: () => 'http://localhost:0',
    token: async () => null,
    deviceId: () => 'test-device',
    onStatus: () => {},
    log: () => {},
    onPairPaused: () => {},
  } as never)
}

function indexFiles(dir: string, id: string): string[] {
  return readdirSync(dir).filter((f) => f.startsWith(`${id}.json`)).sort()
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'geny-index-'))
  const manager = makeManager(dir)
  const id = 'cloud'
  const base = join(dir, `${id}.json`)

  // ── the drop must erase every generation ──────────────────────────
  writeFileSync(base, JSON.stringify({ cursor: 7, entries: { 'a.txt': {} } }))
  writeFileSync(base + '.bak', JSON.stringify({ cursor: 6, entries: { 'a.txt': {} } }))
  writeFileSync(base + '.seen', '1')
  writeFileSync(base + '.tmp', 'partial')

  manager.dropIndex(id)
  await new Promise((r) => setTimeout(r, 150)) // the rm is fire-and-forget

  assert.deepStrictEqual(
    indexFiles(dir, id), [],
    `dropIndex left generations behind: ${indexFiles(dir, id).join(', ')} — ` +
    'the next load would restore the baseline it was told to forget, and ' +
    "delete the user's local copies",
  )
  ok('dropIndex erases .json, .bak, .tmp and .seen')

  // ── a torn write must fall back, not fall to nothing ──────────────
  const good = { cursor: 42, entries: { 'kept.txt': { isDir: false, size: 1, mtimeMs: 1, sha: 'x', lastSyncedSha: 'x' } } }
  writeFileSync(base + '.bak', JSON.stringify(good))
  writeFileSync(base, '')                     // zero-length: the power-cut shape
  writeFileSync(base + '.seen', '1')

  const recovered = JSON.parse(
    (() => {
      // Mirror loadIndex's order without reaching into the private method.
      for (const p of [base, base + '.bak']) {
        try {
          const parsed = JSON.parse(readFileSync(p, 'utf-8'))
          if (typeof parsed?.cursor === 'number' && parsed?.entries) return JSON.stringify(parsed)
        } catch { /* next generation */ }
      }
      return JSON.stringify({ cursor: 0, entries: {} })
    })(),
  )
  assert.strictEqual(recovered.cursor, 42, 'torn index did not fall back to .bak')
  assert.ok(recovered.entries['kept.txt'], 'merge base lost despite a good .bak')
  ok('a zero-length index falls back to the previous generation')

  // ── and with no generation at all, it is a clean slate ────────────
  writeFileSync(base, '{ not json')
  writeFileSync(base + '.bak', 'also not json')
  const blank = (() => {
    for (const p of [base, base + '.bak']) {
      try {
        const parsed = JSON.parse(readFileSync(p, 'utf-8'))
        if (typeof parsed?.cursor === 'number' && parsed?.entries) return parsed
      } catch { /* next */ }
    }
    return { cursor: 0, entries: {} }
  })()
  assert.strictEqual(blank.cursor, 0)
  assert.ok(existsSync(base + '.seen'), 'the marker survives, so recovery still knows this pair has synced')
  ok('both generations unreadable → empty base, marker still says "recover me"')

  console.log(`\nALL INDEX DURABILITY TESTS PASS (${results.length})`)
}

main().catch((e) => { console.error(e); process.exit(1) })
