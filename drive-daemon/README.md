# geny-drive-daemon

The native GenyDrive mount: a FUSE filesystem that streams an agent's
workspace instead of mirroring it.

## Why a separate binary

FUSE cannot run inside the Electron connector. Electron 21+ runs V8 with a
memory cage that copies external ArrayBuffers, so a native module writing
into a FUSE read buffer writes into a copy — reads come back as garbage.
Verified by spike (2026-08-04): identical code returns correct bytes under
plain Node and corrupt bytes under `ELECTRON_RUN_AS_NODE`. rclone and
RaiDrive are separate processes for the same class of reason.

## What it does

```
<mountpoint>/<agent-name>/…     ← that agent's workspace/
```

- **Attributes and listings** come from the sync journal snapshot
  (`/storage/changes`), cached 2 s — a file manager statting a directory
  costs one request, not one per file.
- **Reads** are ranged GETs against `storage-raw` with a 1 MiB readahead
  window per handle. Opening a 300 MB file costs one small request; the
  tail of a 100 MB file arrives in ~2 s over the public endpoint.
- **Writes** spool to a temp file and upload atomically on flush/close,
  last-writer-wins with one 409 retry — a mounted filesystem has
  filesystem semantics, and the OS already serialized the user's intent.
- **mkdir / rename / unlink** map to the storage REST verbs, so every
  mutation lands in the journal and propagates to mirror replicas and to
  the agent itself.

## Lifecycle

The connector spawns it with `--server`, `--token-file`, `--mountpoint`
and `--parent-pid`, and kills it on quit. The token file is rewritten by
the connector on refresh; the daemon re-reads it after a 401. If the
connector dies without cleaning up (SIGKILL, crash), the parent probe
unmounts within ~2 s — a mount that outlives its owner is worse than no
mount.

## Platforms

`./build.sh all` builds linux-x64, mac-arm64, mac-x64. **Windows is
excluded**: FUSE doesn't exist there and the native drive belongs to the
Cloud Files API, a separate implementation. macOS builds but is not
offered in the UI — it needs macFUSE installed; macOS keeps the mirror
drive plus the WebDAV endpoint.
