import { app, dialog, shell, Notification } from 'electron'
import electronUpdater from 'electron-updater'

// ─────────────────────────────────────────────────────────────────────────────
// Auto-update via GitHub Releases (electron-updater).
//
// Feed = the `publish: github CocoRoF/Geny` block in electron-builder.yml
// (embedded as app-update.yml). electron-updater reads latest*.yml from the
// newest release, downloads the matching installer, and prompts to restart.
//
// Toggle (default ON, persisted in connector.json, editable in the control
// window):
//   • ON  → on launch + every 6h: check, download, prompt to restart.
//   • OFF → still CHECK; if an update exists, show a NOTIFICATION (alarm) so the
//           user knows. Clicking it (or tray → 업데이트 확인) updates on demand.
//
// Platform support (unsigned, Phase 0):
//   Windows (NSIS) + Linux (AppImage) work; macOS needs signing (Squirrel.Mac),
//   so there "check" just opens the Releases page. Effective FROM this version on.
// ─────────────────────────────────────────────────────────────────────────────

const { autoUpdater } = electronUpdater
const RELEASES_URL = 'https://github.com/CocoRoF/Geny/releases/latest'

// ── ko/en for the updater's native dialogs + notifications ──────────────────
// Self-contained (no import cycle with index.ts); the active language is
// supplied by a getter wired in initAutoUpdate (falls back to the OS locale).
type Lang = 'ko' | 'en'
let getLang: () => Lang = () => (app.getLocale().toLowerCase().startsWith('ko') ? 'ko' : 'en')
const U_MESSAGES: Record<string, { ko: string; en: string }> = {
  'restartNow': { ko: '지금 재시작', en: 'Restart now' },
  'later': { ko: '나중에', en: 'Later' },
  'readyTitle': { ko: '업데이트 준비됨', en: 'Update ready' },
  'readyMessage': { ko: 'Geny {version} 가 다운로드됐어요.', en: 'Geny {version} has been downloaded.' },
  'readyDetail': { ko: '지금 재시작하면 새 버전으로 설치됩니다.', en: 'Restart now to install the new version.' },
  'devMode': { ko: '개발 모드에서는 업데이트를 확인하지 않습니다.', en: 'Updates are not checked in development mode.' },
  'checkFailed': { ko: '업데이트 확인 실패', en: 'Update check failed' },
  'upToDate': { ko: '최신 버전입니다.', en: 'You are on the latest version.' },
  'upToDateDetail': { ko: '현재 v{version}', en: 'Currently v{version}' },
  'downloading': { ko: '새 버전 v{version} 내려받는 중…', en: 'Downloading new version v{version}…' },
  'downloadingDetail': { ko: '완료되면 재시작 여부를 물어볼게요.', en: 'You will be asked to restart when it finishes.' },
  'notifyTitle': { ko: 'Geny 업데이트 있음', en: 'Geny update available' },
  'notifyBody': { ko: '새 버전 v{version} — 클릭하면 지금 업데이트합니다. (또는 트레이 → 업데이트 확인)', en: 'New version v{version} — click to update now. (or tray → Check for updates)' },
  'updateNow': { ko: '지금 업데이트', en: 'Update now' },
  'availableTitle': { ko: '업데이트 있음', en: 'Update available' },
  'availableMessage': { ko: '새 버전 v{version} 가 있습니다.', en: 'A new version v{version} is available.' },
}
function ut(key: string, vars?: Record<string, string | number>): string {
  const entry = U_MESSAGES[key]
  let s = entry ? entry[getLang()] : key
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v))
  return s
}

let initialized = false
let getEnabled: () => boolean = () => true
let lastNotifiedVersion: string | null = null

function canSelfUpdate(): boolean {
  return app.isPackaged && process.platform !== 'darwin'
}

export function initAutoUpdate(enabledGetter: () => boolean, langGetter?: () => Lang): void {
  getEnabled = enabledGetter
  if (langGetter) getLang = langGetter
  if (initialized) return
  initialized = true
  if (!canSelfUpdate()) return

  // We download explicitly (per the toggle), not automatically.
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-downloaded', async (info) => {
    const { response } = await dialog.showMessageBox({
      type: 'info',
      buttons: [ut('restartNow'), ut('later')],
      defaultId: 0,
      cancelId: 1,
      title: ut('readyTitle'),
      message: ut('readyMessage', { version: info.version }),
      detail: ut('readyDetail'),
    })
    // isForceRunAfter=true → guarantee the app relaunches after install, so the
    // user doesn't have to start it manually post-update.
    if (response === 0) autoUpdater.quitAndInstall(false, true)
  })

  autoUpdater.on('error', (err) => console.error('[updater]', err?.message ?? err))

  setTimeout(() => void runCheck({ manual: false }), 8000)
  setInterval(() => void runCheck({ manual: false }), 6 * 60 * 60 * 1000)
}

async function runCheck(opts: { manual: boolean }): Promise<void> {
  if (!canSelfUpdate()) {
    if (opts.manual) {
      if (process.platform === 'darwin') await shell.openExternal(RELEASES_URL)
      else await dialog.showMessageBox({ message: ut('devMode') })
    }
    return
  }

  let latest: string | undefined
  try {
    const result = await autoUpdater.checkForUpdates()
    latest = result?.updateInfo?.version
  } catch (e) {
    if (opts.manual) {
      await dialog.showMessageBox({ type: 'error', message: ut('checkFailed'), detail: String((e as Error).message) })
    }
    return
  }

  if (!latest || latest === app.getVersion()) {
    if (opts.manual) {
      await dialog.showMessageBox({ type: 'info', message: ut('upToDate'), detail: ut('upToDateDetail', { version: app.getVersion() }) })
    }
    return
  }

  // An update is available.
  if (opts.manual || getEnabled()) {
    // Auto-update ON, or the user explicitly asked → download now.
    if (opts.manual) {
      await dialog.showMessageBox({
        type: 'info',
        message: ut('downloading', { version: latest }),
        detail: ut('downloadingDetail'),
      })
    }
    try {
      await autoUpdater.downloadUpdate()
    } catch (e) {
      console.error('[updater] download', e)
    }
  } else {
    // Auto-update OFF → alarm only; the user updates on demand.
    notifyUpdateAvailable(latest)
  }
}

function notifyUpdateAvailable(version: string): void {
  if (lastNotifiedVersion === version) return // don't re-nag for the same version
  lastNotifiedVersion = version
  if (Notification.isSupported()) {
    const n = new Notification({
      title: ut('notifyTitle'),
      body: ut('notifyBody', { version }),
    })
    n.on('click', () => void autoUpdater.downloadUpdate().catch(() => undefined))
    n.show()
  } else {
    void dialog
      .showMessageBox({
        type: 'info',
        buttons: [ut('updateNow'), ut('later')],
        defaultId: 0,
        cancelId: 1,
        title: ut('availableTitle'),
        message: ut('availableMessage', { version }),
      })
      .then((r) => {
        if (r.response === 0) void autoUpdater.downloadUpdate().catch(() => undefined)
      })
  }
}

/** Tray "업데이트 확인" — always proceeds to update if one exists. */
export function checkForUpdatesManually(): void {
  void runCheck({ manual: true })
}

/** Background check (e.g. right after the user re-enables auto-update). */
export function triggerBackgroundCheck(): void {
  void runCheck({ manual: false })
}
