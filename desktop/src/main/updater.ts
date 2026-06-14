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

let initialized = false
let getEnabled: () => boolean = () => true
let lastNotifiedVersion: string | null = null

function canSelfUpdate(): boolean {
  return app.isPackaged && process.platform !== 'darwin'
}

export function initAutoUpdate(enabledGetter: () => boolean): void {
  getEnabled = enabledGetter
  if (initialized) return
  initialized = true
  if (!canSelfUpdate()) return

  // We download explicitly (per the toggle), not automatically.
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-downloaded', async (info) => {
    const { response } = await dialog.showMessageBox({
      type: 'info',
      buttons: ['지금 재시작', '나중에'],
      defaultId: 0,
      cancelId: 1,
      title: '업데이트 준비됨',
      message: `Geny ${info.version} 가 다운로드됐어요.`,
      detail: '지금 재시작하면 새 버전으로 설치됩니다.',
    })
    if (response === 0) autoUpdater.quitAndInstall()
  })

  autoUpdater.on('error', (err) => console.error('[updater]', err?.message ?? err))

  setTimeout(() => void runCheck({ manual: false }), 8000)
  setInterval(() => void runCheck({ manual: false }), 6 * 60 * 60 * 1000)
}

async function runCheck(opts: { manual: boolean }): Promise<void> {
  if (!canSelfUpdate()) {
    if (opts.manual) {
      if (process.platform === 'darwin') await shell.openExternal(RELEASES_URL)
      else await dialog.showMessageBox({ message: '개발 모드에서는 업데이트를 확인하지 않습니다.' })
    }
    return
  }

  let latest: string | undefined
  try {
    const result = await autoUpdater.checkForUpdates()
    latest = result?.updateInfo?.version
  } catch (e) {
    if (opts.manual) {
      await dialog.showMessageBox({ type: 'error', message: '업데이트 확인 실패', detail: String((e as Error).message) })
    }
    return
  }

  if (!latest || latest === app.getVersion()) {
    if (opts.manual) {
      await dialog.showMessageBox({ type: 'info', message: '최신 버전입니다.', detail: `현재 v${app.getVersion()}` })
    }
    return
  }

  // An update is available.
  if (opts.manual || getEnabled()) {
    // Auto-update ON, or the user explicitly asked → download now.
    if (opts.manual) {
      await dialog.showMessageBox({
        type: 'info',
        message: `새 버전 v${latest} 내려받는 중…`,
        detail: '완료되면 재시작 여부를 물어볼게요.',
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
      title: 'Geny 업데이트 있음',
      body: `새 버전 v${version} — 클릭하면 지금 업데이트합니다. (또는 트레이 → 업데이트 확인)`,
    })
    n.on('click', () => void autoUpdater.downloadUpdate().catch(() => undefined))
    n.show()
  } else {
    void dialog
      .showMessageBox({
        type: 'info',
        buttons: ['지금 업데이트', '나중에'],
        defaultId: 0,
        cancelId: 1,
        title: '업데이트 있음',
        message: `새 버전 v${version} 가 있습니다.`,
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
