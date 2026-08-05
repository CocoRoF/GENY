// main_shared.go — CLI entry shared by both native-drive implementations.
//
// The mechanism differs per OS (FUSE on Linux/macOS, Cloud Files API on
// Windows) but the contract does not: same flags, same storage client,
// same lifecycle — mount until the parent connector goes away.
package main

import (
	"context"
	"flag"
	"log"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

var (
	client *Client
	snaps  *snapshotCache
	spoolD string
)

// safeName maps an agent name to something every OS can hold as a folder
// (Windows is the strict one: reserved characters, no trailing dot/space).
func safeName(raw string) string {
	bad := "<>:\"/\\|?*"
	out := strings.Map(func(r rune) rune {
		if strings.ContainsRune(bad, r) || r < 32 {
			return '_'
		}
		return r
	}, strings.TrimSpace(raw))
	out = strings.TrimRight(out, ". ")
	if out == "" {
		return "agent"
	}
	if len(out) > 80 {
		out = out[:80]
	}
	return out
}

func main() {
	server := flag.String("server", "", "Geny server base URL")
	tokenFile := flag.String("token-file", "", "file containing the Bearer token (rewritten by the connector on refresh)")
	mountpoint := flag.String("mountpoint", "", "directory to mount GenyDrive on")
	parentPID := flag.Int("parent-pid", 0, "exit (unmounting) when this process disappears")
	unregister := flag.Bool("unregister", false, "remove the mount/sync root and exit (Windows sync roots outlive the process by design)")
	flag.Parse()
	if *mountpoint == "" {
		log.Fatal("usage: geny-drive-daemon --server URL --token-file PATH --mountpoint DIR")
	}
	if *unregister {
		if err := unregisterNative(*mountpoint); err != nil {
			log.Fatalf("unregister: %v", err)
		}
		return
	}
	if *server == "" || *tokenFile == "" {
		log.Fatal("usage: geny-drive-daemon --server URL --token-file PATH --mountpoint DIR")
	}

	client = NewClient(*server, *tokenFile)
	snaps = newSnapshotCache(client, 2*time.Second)
	var err error
	spoolD, err = os.MkdirTemp("", "geny-drive-spool-")
	if err != nil {
		log.Fatal(err)
	}
	defer os.RemoveAll(spoolD)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sig := make(chan os.Signal, 2)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sig
		cancel()
	}()

	// ORPHAN GUARD. A mount that outlives the connector is worse than no
	// mount: the directory keeps answering with a dead daemon behind it
	// (observed — a child is not signalled when its parent dies). Signal 0
	// probes liveness without touching the process.
	if *parentPID > 0 {
		go func() {
			for {
				select {
				case <-ctx.Done():
					return
				case <-time.After(2 * time.Second):
					if !parentAlive(*parentPID) {
						log.Printf("parent %d gone — unmounting", *parentPID)
						cancel()
						return
					}
				}
			}
		}()
	}

	if err := mountNative(ctx, *mountpoint); err != nil {
		log.Fatalf("mount: %v", err)
	}
}
