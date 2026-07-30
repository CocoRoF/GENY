/**
 * sync-fs — real LocalFs implementation over the user's paired folder.
 *
 * Safety posture mirrors the server's: everything resolves under the
 * replica root (no `..`, no symlink following), ignored trees are never
 * entered, and destructive ops touch only tracked paths.
 */

import { createHash } from 'crypto'
import { createReadStream } from 'fs'
import { lstat, mkdir, readdir, rename, rm, rmdir, stat } from 'fs/promises'
import { join, resolve, sep } from 'path'
import picomatch from 'picomatch'
import { conflictName, LocalFs, LocalStat } from './sync-core'

/** Mirror of the server DEFAULT_IGNORE heavy-library set + junk. Keep in
 *  rough parity with backend/service/utils/file_storage.py. */
export const DEFAULT_IGNORES = [
  'node_modules', '.npm', '.yarn', '.pnpm-store', 'bower_components',
  '.venv', 'venv', 'env', '__pycache__', '.tox', '.nox',
  '.pytest_cache', '.mypy_cache', '.ruff_cache',
  'build', 'dist', 'out', 'target', '.eggs',
  '.git', '.hg', '.svn',
  '.idea', '.vscode',
  '.gradle', '.next', '.nuxt', '.cache', '.parcel-cache', '.turbo',
  '.geny-sync', '.geny-sync-tmp', '.canvas-preview',
]

export const DEFAULT_IGNORE_GLOBS = [
  '**/*.pyc', '**/*.pyo', '**/*.pyd', '**/*.class', '**/*.o',
  '**/.DS_Store', '**/Thumbs.db', '**/desktop.ini',
  '**/*.crdownload', '**/*.partial', '**/*.tmp', '**/~$*', '**/.~lock.*#',
  '**/*.egg-info/**',
]

export class ReplicaFs implements LocalFs {
  private root: string
  private isIgnoredGlob: (p: string) => boolean

  constructor(root: string, extraGlobs: string[] = []) {
    this.root = resolve(root)
    this.isIgnoredGlob = picomatch([...DEFAULT_IGNORE_GLOBS, ...extraGlobs], { dot: true })
  }

  absPath(rel: string): string {
    const abs = resolve(this.root, rel)
    if (abs !== this.root && !abs.startsWith(this.root + sep)) {
      throw new Error(`path escapes replica root: ${rel}`)
    }
    return abs
  }

  private ignoredName(name: string): boolean {
    return DEFAULT_IGNORES.includes(name)
  }

  async scan(): Promise<Map<string, LocalStat>> {
    const out = new Map<string, LocalStat>()
    const walk = async (dirAbs: string, relPrefix: string): Promise<void> => {
      let entries
      try {
        entries = await readdir(dirAbs, { withFileTypes: true })
      } catch {
        return
      }
      for (const ent of entries) {
        const rel = relPrefix ? `${relPrefix}/${ent.name}` : ent.name
        if (this.ignoredName(ent.name) || this.isIgnoredGlob(rel)) continue
        if (ent.isSymbolicLink()) continue
        const abs = join(dirAbs, ent.name)
        if (ent.isDirectory()) {
          try {
            const st = await stat(abs)
            out.set(rel, { isDir: true, size: 0, mtimeMs: st.mtimeMs })
          } catch {
            continue
          }
          await walk(abs, rel)
        } else if (ent.isFile()) {
          try {
            const st = await stat(abs)
            out.set(rel, { isDir: false, size: st.size, mtimeMs: st.mtimeMs })
          } catch {
            continue
          }
        }
      }
    }
    await mkdir(this.root, { recursive: true })
    await walk(this.root, '')
    return out
  }

  async hash(rel: string): Promise<string> {
    const abs = this.absPath(rel)
    return new Promise((res, rej) => {
      const h = createHash('sha256')
      createReadStream(abs)
        .on('data', (c) => h.update(c))
        .on('end', () => res(h.digest('hex')))
        .on('error', rej)
    })
  }

  async stat(rel: string): Promise<LocalStat | null> {
    try {
      const st = await lstat(this.absPath(rel))
      if (st.isSymbolicLink()) return null
      return { isDir: st.isDirectory(), size: st.isDirectory() ? 0 : st.size, mtimeMs: st.mtimeMs }
    } catch {
      return null
    }
  }

  async removeFile(rel: string): Promise<void> {
    await rm(this.absPath(rel), { force: true })
  }

  async removeDirIfEmpty(rel: string): Promise<boolean> {
    try {
      await rmdir(this.absPath(rel))
      return true
    } catch {
      return false
    }
  }

  async mkdir(rel: string): Promise<void> {
    await mkdir(this.absPath(rel), { recursive: true })
  }

  async renameToConflict(rel: string, deviceName: string): Promise<string> {
    const parts = rel.split('/')
    const name = parts.pop() as string
    let candidate = conflictName(name, deviceName, new Date())
    let candidateRel = [...parts, candidate].join('/')
    for (let i = 2; i < 100; i++) {
      try {
        await lstat(this.absPath(candidateRel))
        candidate = conflictName(name.replace(/(\.[^.]*)?$/, ` ${i}$1`), deviceName, new Date())
        candidateRel = [...parts, candidate].join('/')
      } catch {
        break
      }
    }
    await rename(this.absPath(rel), this.absPath(candidateRel))
    return candidateRel
  }
}
