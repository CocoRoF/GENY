/**
 * drive-preflight — per-OS readiness for Geny Drive.
 *
 * Mirror mode (today) needs nothing but a writable folder. The streaming
 * modes on the roadmap each need something the OS either has or doesn't:
 *
 *   Linux   → FUSE 3 (fusermount3 present + /dev/fuse usable)
 *   Windows → Cloud Files API (Windows 10 1709 / build 16299+) — built in,
 *             nothing to install, but older builds can't do it
 *   macOS   → built-in WebDAV client (mount_webdav) — always present
 *
 * The installer provisions what it can (deb Recommends: fuse3; the NSIS
 * "Geny Cloud" option records consent), and THIS module is the runtime
 * truth: it never guesses from the platform alone, it probes. Findings are
 * surfaced in the Drive card so a missing prerequisite reads as one
 * actionable sentence instead of a mysterious failure later.
 */

import { accessSync, constants, existsSync } from 'fs'
import { release } from 'os'
import { delimiter, join } from 'path'

export interface DriveCapabilities {
  /** Mirror mode (the shipped Drive): always available. */
  mirror: true
  /** Streaming/virtual mount is possible on this machine right now. */
  streaming: boolean
  /** Mechanism that streaming would use here. */
  mechanism: 'fuse' | 'cfapi' | 'webdav' | 'none'
  /** Empty when ready; otherwise a single actionable sentence (ko). */
  missing: string
  /** Machine-readable hint for the UI/log (e.g. 'fuse3', 'win-build'). */
  code: string
}

/** Linux: FUSE 3 userspace helper + the kernel device. */
function probeFuse(): DriveCapabilities {
  // Fixed prefixes cover FHS distros; the PATH scan covers everything else
  // (NixOS, Guix, /opt installs) — a machine with a working fusermount3 must
  // never be told to install it.
  const helper =
    ['/usr/bin/fusermount3', '/bin/fusermount3', '/usr/local/bin/fusermount3'].some((p) =>
      existsSync(p),
    ) ||
    (process.env.PATH ?? '')
      .split(delimiter)
      .filter(Boolean)
      .some((dir) => existsSync(join(dir, 'fusermount3')))
  const dev = existsSync('/dev/fuse')
  if (helper && dev) {
    // Readable/writable /dev/fuse is what actually gates a user mount;
    // containers and hardened kernels can have the node but deny access.
    try {
      accessSync('/dev/fuse', constants.R_OK | constants.W_OK)
      return { mirror: true, streaming: true, mechanism: 'fuse', missing: '', code: 'ok' }
    } catch {
      return {
        mirror: true,
        streaming: false,
        mechanism: 'fuse',
        code: 'fuse-perm',
        missing:
          '/dev/fuse 에 접근할 수 없습니다. 컨테이너라면 --device /dev/fuse 를 부여하고, 일반 데스크톱이라면 관리자가 /dev/fuse 권한을 제한하지 않았는지 확인하세요. 미러 모드(폴더 동기화)는 정상 동작합니다.',
      }
    }
  }
  return {
    mirror: true,
    streaming: false,
    mechanism: 'fuse',
    code: 'fuse3',
    missing:
      'FUSE 3 이 없습니다. `sudo apt install fuse3` (또는 배포판의 fuse3 패키지)를 설치하면 가상 드라이브를 쓸 수 있어요. 지금도 미러 모드(폴더 동기화)는 정상 동작합니다.',
  }
}

/** Windows: Cloud Files API ships with Windows 10 1709 (build 16299)+. */
function probeCfApi(): DriveCapabilities {
  // os.release() on win32 is the NT version, e.g. '10.0.19045'.
  const build = Number(release().split('.')[2] ?? 0)
  if (build >= 16299) {
    return { mirror: true, streaming: true, mechanism: 'cfapi', missing: '', code: 'ok' }
  }
  return {
    mirror: true,
    streaming: false,
    mechanism: 'cfapi',
    code: 'win-build',
    missing:
      'Windows 10 1709(빌드 16299) 이상에서만 가상 드라이브를 지원합니다. 지금도 미러 모드(폴더 동기화)는 정상 동작합니다.',
  }
}

/** macOS: mount_webdav is part of the OS — nothing to install. */
function probeWebdav(): DriveCapabilities {
  const ok = existsSync('/sbin/mount_webdav') || existsSync('/usr/sbin/mount_webdav')
  return ok
    ? { mirror: true, streaming: true, mechanism: 'webdav', missing: '', code: 'ok' }
    : {
        mirror: true,
        streaming: false,
        mechanism: 'webdav',
        code: 'webdav',
        missing:
          '이 macOS에서 내장 WebDAV 클라이언트를 찾지 못했습니다. 미러 모드(폴더 동기화)는 정상 동작합니다.',
      }
}

export function driveCapabilities(): DriveCapabilities {
  switch (process.platform) {
    case 'linux':
      return probeFuse()
    case 'win32':
      return probeCfApi()
    case 'darwin':
      return probeWebdav()
    default:
      return {
        mirror: true,
        streaming: false,
        mechanism: 'none',
        code: 'unsupported-os',
        missing: '이 운영체제에서는 미러 모드(폴더 동기화)만 지원합니다.',
      }
  }
}
