import { app, dialog, shell, Notification } from 'electron'
import { spawn } from 'child_process'
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
//           user knows. Clicking it (or tray → 최신버전 다운로드) takes the app
//           all the way to the new version: download, install, restart.
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
  'downloadingDetail': { ko: '다 받으면 자동으로 재시작하며 설치합니다. 잠시만 기다려 주세요.', en: 'Geny will restart and install automatically when the download finishes.' },
  'installingTitle': { ko: '업데이트 설치 중', en: 'Installing update' },
  'installingBody': { ko: 'v{version} 설치를 위해 지금 재시작합니다.', en: 'Restarting now to install v{version}.' },
  'downloadFailed': { ko: '다운로드 실패', en: 'Download failed' },
  'notifyTitle': { ko: 'Geny 업데이트 있음', en: 'Geny update available' },
  'notifyBody': { ko: '새 버전 v{version} — 클릭하면 설치 후 자동 재시작합니다. (또는 트레이 → 최신버전 다운로드)', en: 'New version v{version} — click to install and restart automatically. (or tray → Download latest version)' },
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
//: Set when the user pressed "최신버전 다운로드" — the download that follows
//: installs and restarts on its own.
let installWhenReady = false

/** Quit and install, then come back up. */
function installNow(): void {
  if (process.platform === 'linux' && !process.env.APPIMAGE) {
    // deb: DebUpdater's isForceRunAfter uses app.relaunch(), whose Linux
    // '--type=relauncher' helper passes NoNewPrivs down to the new main —
    // the SUID chrome-sandbox then can't elevate and the app SIGTRAPs on
    // userns-restricted kernels (Ubuntu 24.04). Install WITHOUT force-run
    // and respawn through the launcher shim ourselves (this process has
    // NNP=0). Hooked on before-quit-for-update so a FAILED install (no
    // quit) never spawns a duplicate instance. The AppImage updater is
    // fine: it spawns the new AppImage directly.
    app.once('before-quit-for-update' as 'before-quit', () => {
      const shim = process.execPath.replace(/\.bin$/, '')
      spawn('/bin/sh', ['-c', 'sleep 3; exec "$0"', shim], {
        detached: true,
        stdio: 'ignore',
      }).unref()
    })
    autoUpdater.quitAndInstall(false, false)
  } else {
    // Silent: the Windows installer is ASSISTED (custom Geny Cloud page),
    // and a non-silent update would replay the whole wizard on every
    // release — worse, its default-checked page would override a user's
    // in-app opt-out. Silent mode skips all pages, and customInstall
    // writes no flag when the page never ran, so the app's current
    // setting survives updates untouched.
    autoUpdater.quitAndInstall(true, true)
  }
}

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
    // ONE PRESS = UPDATED.
    //
    // "최신버전 다운로드" is a promise about the end state, not the start of
    // a negotiation: the user already said yes by pressing it, so asking
    // again just leaves them on the old version if they miss the dialog.
    // A background download still asks, because nobody asked for it then.
    if (!installWhenReady) {
      const { response } = await dialog.showMessageBox({
        type: 'info',
        buttons: [ut('restartNow'), ut('later')],
        defaultId: 0,
        cancelId: 1,
        title: ut('readyTitle'),
        message: ut('readyMessage', { version: info.version }),
        detail: ut('readyDetail'),
      })
      if (response !== 0) return
    } else {
      // Say what is about to happen — the window vanishing unannounced is
      // indistinguishable from a crash.
      if (Notification.isSupported()) {
        new Notification({
          title: ut('installingTitle'),
          body: ut('installingBody', { version: info.version }),
        }).show()
      }
      await new Promise((r) => setTimeout(r, 1200))
    }
    installWhenReady = false
    installNow()
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
    if (opts.manual) {
      // The press already carried the decision: download, install and
      // restart without asking again. Told up front, because the app is
      // going to disappear and come back on its own.
      installWhenReady = true
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
      installWhenReady = false
      if (opts.manual) {
        // Silence here would look exactly like a successful update that
        // never restarted.
        await dialog.showMessageBox({
          type: 'error',
          message: ut('downloadFailed'),
          detail: String((e as Error)?.message ?? e),
        })
      }
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
    // Clicking the alarm is the same promise as pressing the tray item:
    // it finishes the job rather than leaving a download to be confirmed.
    n.on('click', () => {
      installWhenReady = true
      void autoUpdater.downloadUpdate().catch(() => {
        installWhenReady = false
      })
    })
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
        if (r.response === 0) {
          installWhenReady = true
          void autoUpdater.downloadUpdate().catch(() => {
            installWhenReady = false
          })
        }
      })
  }
}

/** Tray "최신버전 다운로드" — one press takes the app all the way to the
 *  newest version: check, download, install, restart. */
export function checkForUpdatesManually(): void {
  void runCheck({ manual: true })
}

/** Background check (e.g. right after the user re-enables auto-update). */
export function triggerBackgroundCheck(): void {
  void runCheck({ manual: false })
}
