# Geny Connector (desktop)

The desktop **접속기** for Geny: a thin, always-on-top, click-through overlay that
renders the live VTuber avatar at the bottom of your desktop. The Geny **server**
stays the brain (agent pipeline, memory, TTS/STT synthesis, avatar-state); this
app is just the face + native I/O (rendering, audio, screen, hotkeys).

> Status: **Phase 0** — runnable transparent-overlay shell + native bridge +
> server login. The avatar renderer (ported from the browser app) mounts next.
> See [`../dev_docs/vtuber-desktop/PLAN.md`](../dev_docs/vtuber-desktop/PLAN.md).

## Download & run (git-clonable)

```bash
git clone https://github.com/CocoRoF/Geny.git
cd Geny/desktop
npm install            # pulls electron + electron-vite + react
npm run dev            # launches the overlay + (hidden) control window
```

The overlay floats at the bottom-right; **drag the glowing handle** to move it,
**double-click** it to toggle the control window. In the control window enter
your Geny **server URL**, click **연결 확인**, then **로그인** — the account JWT is
stored in the OS keychain (Keychain / Credential Manager / libsecret) and used as
`Authorization: Bearer` for the (now-authenticated) server API.

Set a default server without the UI:

```bash
GENY_SERVER_URL=https://gapt.example.com npm run dev
```

## Build installers

```bash
npm run dist:linux     # AppImage + deb
npm run dist:win       # NSIS
npm run dist:mac       # dmg   (ad-hoc signed — see build/afterPack.cjs)
```

### macOS Gatekeeper

The mac build is **ad-hoc signed** (`build/afterPack.cjs`), not notarized — so it
runs on Apple Silicon (no "손상됨 / damaged" hard block) but the first launch shows
the "확인되지 않은 개발자" prompt: **right-click → Open**, or System Settings →
Privacy & Security → **Open Anyway**. If a download is still blocked as *damaged*
(e.g. an older unsigned build), strip the quarantine flag (always works):

```bash
xattr -dr com.apple.quarantine "/Applications/Geny.app"
```

To ship with **no** prompt, set an Apple Developer ID (`CSC_LINK` +
`CSC_KEY_PASSWORD`) and notarization secrets (`APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`) in CI — the afterPack ad-hoc pass
then no-ops and electron-builder signs + notarizes for real.

## Architecture

```
src/main/index.ts      Electron main: overlay (transparent/frameless/always-on-top/
                       click-through) + control window, single renderer process,
                       config JSON, keychain IPC.
src/preload/index.ts   contextBridge → window.connector (serverConfig, secureStore,
                       windowControl). The renderer NEVER imports electron directly,
                       so a Tauri backend could swap in behind the same shape.
src/renderer/          React 19 app; ?window=overlay|control selects the tree.
```

### Reusing the browser renderer

`electron.vite.config.ts` aliases `@geny → ../frontend/src`, so the overlay can
import the existing `Live2DCanvas` / `SpineCanvas` / `AvatarCanvas`, the audio
engine (`audioManager`, `ttsChunkStream`), the WS transport (`api.ts`,
`chatWsManager`), and the zustand stores directly — they are pure React + Pixi
with only `'use client'` / `next/dynamic` SSR guards. The Phase 0 parity spike
(next) mounts `<AvatarCanvas backgroundAlpha={0}>` into `#avatar-stage` and
shims the handful of Next-specific imports (`next/dynamic`, `next/image`).

## Connector API v1 (server contract)

The connector speaks the **existing** Geny endpoints (no new protocol):

- WS `/ws/execute/{id}`, `/ws/vtuber/agents/{id}/state`, `/ws/chat/rooms/{id}`
  — JWT carried via the `Sec-WebSocket-Protocol: geny-auth,<jwt>` subprotocol
  (browsers) or the `Authorization` header (desktop).
- REST `POST /api/chat/rooms/{room}/broadcast`, `POST /api/tts/.../speak/chunks`,
  `POST /api/vtuber/screen-observation/upload`.

All of these were authenticated in **Phase 1a** (PR #875). The desktop sends the
keychain JWT as a Bearer header.
