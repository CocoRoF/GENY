import { app, dialog, shell } from 'electron'
import electronUpdater from 'electron-updater'

// ─────────────────────────────────────────────────────────────────────────────
// Auto-update via GitHub Releases (electron-updater).
//
// The repo + feed come from the `publish: github CocoRoF/Geny` block in
// electron-builder.yml, which electron-builder embeds as app-update.yml in the
// packaged app. electron-updater reads `latest.yml` / `latest-linux.yml` from the
// newest release's assets, downloads the matching installer, and installs it.
//
// Platform support (unsigned, Phase 0):
//   • Windows (NSIS)     — works. Downloads + runs the new installer.
//   • Linux (AppImage)   — works. (.deb is apt-managed; not auto-updated.)
//   • macOS              — Squirrel.Mac REQUIRES a signed app, so auto-update is
//                          skipped until signing lands; "check" opens Releases.
// Auto-update takes effect FROM this version forward: a user installs this build
// once, then future releases update themselves.
// ─────────────────────────────────────────────────────────────────────────────

const { autoUpdater } = electronUpdater
const RELEASES_URL = 'https://github.com/CocoRoF/Geny/releases/latest'

let initialized = false

export function initAutoUpdate(): void {
  if (initialized) return
  initialized = true
  if (!app.isPackaged) return // dev build: nothing to update
  if (process.platform === 'darwin') return // unsigned mac can't auto-update

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-downloaded', async (info) => {
    const { response } = await dialog.showMessageBox({
      type: 'info',
      buttons: ['지금 재시작', '나중에'],
      defaultId: 0,
      cancelId: 1,
      title: '업데이트 준비됨',
      message: `Geny ${info.version} 가 다운로드됐어요.`,
      detail: '지금 재시작하면 새 버전으로 설치됩니다. (다음 실행 시 자동 적용도 가능)',
    })
    if (response === 0) autoUpdater.quitAndInstall()
  })

  autoUpdater.on('error', (err) => {
    console.error('[updater]', err?.message ?? err)
  })

  // Check shortly after launch, then every 6 hours.
  setTimeout(() => void autoUpdater.checkForUpdates().catch(() => undefined), 8000)
  setInterval(() => void autoUpdater.checkForUpdates().catch(() => undefined), 6 * 60 * 60 * 1000)
}

/** Tray "업데이트 확인" — manual check with user feedback. */
export async function checkForUpdatesManually(): Promise<void> {
  if (!app.isPackaged) {
    await dialog.showMessageBox({ message: '개발 모드에서는 업데이트를 확인하지 않습니다.' })
    return
  }
  if (process.platform === 'darwin') {
    // Unsigned macOS can't self-update; send the user to the download page.
    await shell.openExternal(RELEASES_URL)
    return
  }
  try {
    const result = await autoUpdater.checkForUpdates()
    const latest = result?.updateInfo?.version
    if (!latest || latest === app.getVersion()) {
      await dialog.showMessageBox({
        type: 'info',
        message: '최신 버전입니다.',
        detail: `현재 v${app.getVersion()}`,
      })
    } else {
      await dialog.showMessageBox({
        type: 'info',
        message: `새 버전 v${latest} 를 내려받는 중…`,
        detail: '완료되면 재시작 여부를 물어볼게요.',
      })
    }
  } catch (e) {
    await dialog.showMessageBox({
      type: 'error',
      message: '업데이트 확인 실패',
      detail: String((e as Error).message),
    })
  }
}
