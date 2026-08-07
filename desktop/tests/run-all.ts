/**
 * The connector's test runner.
 *
 * Every file here passed when it was written and was then only ever run by
 * hand, one `npx tsx` at a time — which is the same as not running them. A
 * suite nothing invokes reports nothing when it breaks.
 *
 * `sync-prod-e2e.ts` is deliberately absent: it talks to the production
 * server and needs credentials, so it stays a manual tool.
 *
 * Run: npm test
 */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const MANUAL = new Set(['sync-prod-e2e.ts', 'run-all.ts'])

const files = readdirSync(here)
  .filter((f) => (f.endsWith('.test.ts') || f.endsWith('.probe.ts')) && !MANUAL.has(f))
  .sort()

if (files.length === 0) {
  console.error('no test files found — the glob or the directory moved')
  process.exit(1)
}

let failed = 0
for (const f of files) {
  const r = spawnSync('npx', ['tsx', join(here, f)], { stdio: 'inherit' })
  if (r.status !== 0) {
    failed++
    console.error(`\n✗ ${f} exited ${r.status}`)
  }
}

console.log(`\n${files.length - failed}/${files.length} suites passed`)
process.exit(failed === 0 ? 0 : 1)
