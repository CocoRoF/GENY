#!/usr/bin/env bash
# Cross-build the drive daemon.
#
# One binary, two mechanisms, selected by build tags:
#   linux/darwin → FUSE (go-fuse, pure Go)
#   windows      → Cloud Files API placeholders (cldapi.dll via LazyDLL)
# Neither needs cgo, so every target cross-compiles from any host.
#
# macOS builds but needs macFUSE (a kext install) at runtime, so it is not
# offered in the UI — macOS keeps the mirror drive plus WebDAV (see
# geny-webdav-review.md).
set -euo pipefail
cd "$(dirname "$0")"
build() {
  local goos=$1 goarch=$2 out=$3 ext=${4:-}
  echo "→ $out"
  mkdir -p "dist/$out"
  CGO_ENABLED=0 GOOS=$goos GOARCH=$goarch go build -trimpath -ldflags="-s -w" \
    -o "dist/$out/geny-drive-daemon$ext" .
}
case "${1:-all}" in
  linux)  build linux amd64 linux-x64 ;;
  mac)    build darwin arm64 mac-arm64; build darwin amd64 mac-x64 ;;
  win)    build windows amd64 win-x64 .exe ;;
  all)    build linux amd64 linux-x64
          build darwin arm64 mac-arm64
          build darwin amd64 mac-x64
          build windows amd64 win-x64 .exe ;;
esac
