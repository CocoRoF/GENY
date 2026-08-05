#!/usr/bin/env bash
# Cross-build the drive daemon.
#
# go-fuse is pure Go, so this is a plain GOOS/GOARCH matrix with CGO off —
# but only for UNIX: FUSE does not exist on Windows and the package does
# not compile there (undefined syscall.Iovec, dirent, …). Windows gets its
# native drive through the Cloud Files API instead, which is a separate
# implementation, not this binary.
#
# macOS builds cleanly but needs macFUSE (a kexts install) at runtime, so
# it is built for completeness and NOT offered in the UI — macOS users get
# the mirror drive plus the WebDAV endpoint (see geny-webdav-review.md).
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
  all)    build linux amd64 linux-x64
          build darwin arm64 mac-arm64
          build darwin amd64 mac-x64 ;;
esac
