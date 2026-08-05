// geny-drive-daemon — the native GenyDrive mount (Linux/FUSE leg of D4).
//
// A sidecar by necessity, not preference: FUSE cannot live inside the
// Electron connector (V8 memory cage copies external buffers — reads come
// back corrupted; proven by spike 2026-08-04). The connector spawns this
// binary, hands it --server and --token-file, and unmounts on quit.
//
// Layout:   <mountpoint>/<agent-name>/…  ← each agent's workspace/
//
// Semantics (v1, deliberately matching the WebDAV layer):
//   - attrs/dirs from the sync journal snapshot (2 s TTL cache)
//   - reads stream via storage-raw ranged GETs with a 1 MiB readahead
//     window per handle — opening a 300 MB file costs one small request,
//     not a download
//   - writes spool locally and upload atomically on close
//     (last-writer-wins with one 409 retry — filesystem semantics)
//   - mkdir/rename/unlink map to the storage REST verbs, so every
//     mutation lands in the journal and reaches mirrors and agents
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/hanwen/go-fuse/v2/fs"
	"github.com/hanwen/go-fuse/v2/fuse"
)

const readAhead = 1 << 20 // 1 MiB fetch granularity per handle

var (
	client *Client
	snaps  *snapshotCache
	spoolD string
)

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

// ── root: agents as folders ─────────────────────────────────────────────

type rootNode struct {
	fs.Inode
	mu     sync.Mutex
	at     time.Time
	agents map[string]string // safe name → session id
}

func (r *rootNode) resolveAgents() map[string]string {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.agents != nil && time.Since(r.at) < 15*time.Second {
		return r.agents
	}
	list, err := client.Agents()
	if err != nil {
		if r.agents != nil {
			return r.agents // stale over empty
		}
		return map[string]string{}
	}
	m := map[string]string{}
	for _, a := range list {
		name := safeName(a.SessionName)
		if name == "agent" || name == "" {
			name = safeName(a.SessionID[:8])
		}
		base, i := name, 2
		for {
			if _, taken := m[name]; !taken {
				break
			}
			name = fmt.Sprintf("%s-%d", base, i)
			i++
		}
		m[name] = a.SessionID
	}
	r.agents, r.at = m, time.Now()
	return m
}

func (r *rootNode) Readdir(ctx context.Context) (fs.DirStream, syscall.Errno) {
	var out []fuse.DirEntry
	for name := range r.resolveAgents() {
		out = append(out, fuse.DirEntry{Name: name, Mode: fuse.S_IFDIR})
	}
	return fs.NewListDirStream(out), 0
}

func (r *rootNode) Lookup(ctx context.Context, name string, out *fuse.EntryOut) (*fs.Inode, syscall.Errno) {
	sid, ok := r.resolveAgents()[name]
	if !ok {
		return nil, syscall.ENOENT
	}
	node := &pathNode{sid: sid, rel: ""}
	out.Mode = fuse.S_IFDIR | 0o755
	return r.NewInode(ctx, node, fs.StableAttr{Mode: fuse.S_IFDIR}), 0
}

var _ = (fs.NodeReaddirer)((*rootNode)(nil))
var _ = (fs.NodeLookuper)((*rootNode)(nil))

// ── agent workspace nodes ───────────────────────────────────────────────

type pathNode struct {
	fs.Inode
	sid string
	rel string // '' = workspace root of this agent
}

func (n *pathNode) child(name string) string {
	if n.rel == "" {
		return name
	}
	return n.rel + "/" + name
}

func (n *pathNode) entry() (Entry, bool) {
	if n.rel == "" {
		return Entry{Path: "", IsDir: true}, true
	}
	m, err := snaps.Get(n.sid)
	if err != nil {
		return Entry{}, false
	}
	e, ok := m[n.rel]
	return e, ok
}

func fillAttr(e Entry, a *fuse.AttrOut) {
	if e.IsDir {
		a.Mode = fuse.S_IFDIR | 0o755
	} else {
		a.Mode = fuse.S_IFREG | 0o644
		a.Size = uint64(e.Size)
	}
	sec := uint64(e.MtimeNs / 1e9)
	a.Mtime, a.Ctime, a.Atime = sec, sec, sec
	a.Uid = uint32(os.Getuid())
	a.Gid = uint32(os.Getgid())
}

func (n *pathNode) Getattr(ctx context.Context, fh fs.FileHandle, out *fuse.AttrOut) syscall.Errno {
	if h, ok := fh.(*writeHandle); ok && h != nil {
		if st, err := os.Stat(h.spool); err == nil {
			out.Mode = fuse.S_IFREG | 0o644
			out.Size = uint64(st.Size())
			return 0
		}
	}
	e, ok := n.entry()
	if !ok {
		return syscall.ENOENT
	}
	fillAttr(e, out)
	return 0
}

func (n *pathNode) Readdir(ctx context.Context) (fs.DirStream, syscall.Errno) {
	m, err := snaps.Get(n.sid)
	if err != nil {
		return nil, syscall.EIO
	}
	prefix := ""
	if n.rel != "" {
		prefix = n.rel + "/"
	}
	seen := map[string]bool{}
	var out []fuse.DirEntry
	for p, e := range m {
		if !strings.HasPrefix(p, prefix) || p == n.rel {
			continue
		}
		rest := p[len(prefix):]
		name := rest
		if i := strings.IndexByte(rest, '/'); i >= 0 {
			name = rest[:i]
		}
		if seen[name] {
			continue
		}
		seen[name] = true
		mode := uint32(fuse.S_IFREG)
		if e.IsDir || strings.ContainsRune(rest, '/') {
			mode = fuse.S_IFDIR
		}
		out = append(out, fuse.DirEntry{Name: name, Mode: mode})
	}
	return fs.NewListDirStream(out), 0
}

func (n *pathNode) Lookup(ctx context.Context, name string, out *fuse.EntryOut) (*fs.Inode, syscall.Errno) {
	rel := n.child(name)
	m, err := snaps.Get(n.sid)
	if err != nil {
		return nil, syscall.EIO
	}
	e, ok := m[rel]
	if !ok {
		// implicit parent dirs (journal may lack a bare dir row)
		prefix := rel + "/"
		for p := range m {
			if strings.HasPrefix(p, prefix) {
				e, ok = Entry{Path: rel, IsDir: true}, true
				break
			}
		}
	}
	if !ok {
		return nil, syscall.ENOENT
	}
	node := &pathNode{sid: n.sid, rel: rel}
	mode := uint32(fuse.S_IFREG)
	if e.IsDir {
		mode = fuse.S_IFDIR
	}
	out.Attr.Mode = mode | 0o644
	if e.IsDir {
		out.Attr.Mode = mode | 0o755
	} else {
		out.Attr.Size = uint64(e.Size)
	}
	return n.NewInode(ctx, node, fs.StableAttr{Mode: mode}), 0
}

// ── read path: ranged streaming with per-handle readahead ───────────────

type readHandle struct {
	n   *pathNode
	mu  sync.Mutex
	buf []byte
	off int64 // buffer start offset
}

func (n *pathNode) Open(ctx context.Context, flags uint32) (fs.FileHandle, uint32, syscall.Errno) {
	if flags&(syscall.O_WRONLY|syscall.O_RDWR) != 0 {
		return n.openForWrite(flags)
	}
	return &readHandle{n: n}, fuse.FOPEN_KEEP_CACHE, 0
}

func (h *readHandle) Read(ctx context.Context, dest []byte, off int64) (fuse.ReadResult, syscall.Errno) {
	h.mu.Lock()
	defer h.mu.Unlock()
	end := off + int64(len(dest))
	if h.buf == nil || off < h.off || end > h.off+int64(len(h.buf)) {
		want := int64(len(dest))
		if want < readAhead {
			want = readAhead
		}
		buf := make([]byte, want)
		n, err := client.ReadRange(h.n.sid, h.n.rel, off, buf)
		if err != nil {
			return nil, syscall.EIO
		}
		h.buf, h.off = buf[:n], off
	}
	lo := off - h.off
	hi := lo + int64(len(dest))
	if hi > int64(len(h.buf)) {
		hi = int64(len(h.buf))
	}
	if lo > hi {
		lo = hi
	}
	return fuse.ReadResultData(h.buf[lo:hi]), 0
}

var _ = (fs.FileReader)((*readHandle)(nil))

// ── write path: spool + atomic upload on close ──────────────────────────

type writeHandle struct {
	n       *pathNode
	spool   string
	f       *os.File
	baseSha string
	mu      sync.Mutex
	dirty   bool
}

func (n *pathNode) openForWrite(flags uint32) (fs.FileHandle, uint32, syscall.Errno) {
	spool := filepath.Join(spoolD, fmt.Sprintf("w-%d-%s", time.Now().UnixNano(), strings.ReplaceAll(n.rel, "/", "_")))
	baseSha := ""
	if e, ok := n.entry(); ok && !e.IsDir {
		baseSha = e.Sha256
		if flags&syscall.O_TRUNC == 0 {
			// preserve existing content for appends / partial rewrites
			if err := client.Download(n.sid, n.rel, spool); err != nil {
				return nil, 0, syscall.EIO
			}
		}
	}
	f, err := os.OpenFile(spool, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, 0, syscall.EIO
	}
	return &writeHandle{n: n, spool: spool, f: f, baseSha: baseSha}, 0, 0
}

func (h *writeHandle) Write(ctx context.Context, data []byte, off int64) (uint32, syscall.Errno) {
	h.mu.Lock()
	defer h.mu.Unlock()
	nw, err := h.f.WriteAt(data, off)
	if err != nil {
		return 0, syscall.EIO
	}
	h.dirty = true
	return uint32(nw), 0
}

func (h *writeHandle) Read(ctx context.Context, dest []byte, off int64) (fuse.ReadResult, syscall.Errno) {
	h.mu.Lock()
	defer h.mu.Unlock()
	n, err := h.f.ReadAt(dest, off)
	if err != nil && n == 0 {
		return fuse.ReadResultData(nil), 0
	}
	return fuse.ReadResultData(dest[:n]), 0
}

func (h *writeHandle) Flush(ctx context.Context) syscall.Errno {
	return h.upload()
}

func (h *writeHandle) Release(ctx context.Context) syscall.Errno {
	errno := h.upload()
	h.f.Close()
	os.Remove(h.spool)
	return errno
}

func (h *writeHandle) upload() syscall.Errno {
	h.mu.Lock()
	defer h.mu.Unlock()
	if !h.dirty {
		return 0
	}
	h.f.Sync()
	if err := client.Put(h.n.sid, h.n.rel, h.spool, h.baseSha); err != nil {
		log.Printf("upload %s: %v", h.n.rel, err)
		return syscall.EIO
	}
	h.dirty = false
	snaps.Invalidate(h.n.sid)
	if e, ok := h.n.entry(); ok {
		h.baseSha = e.Sha256
	}
	return 0
}

var _ = (fs.FileWriter)((*writeHandle)(nil))
var _ = (fs.FileFlusher)((*writeHandle)(nil))
var _ = (fs.FileReleaser)((*writeHandle)(nil))

// ── mutations ───────────────────────────────────────────────────────────

func (n *pathNode) Create(ctx context.Context, name string, flags uint32, mode uint32, out *fuse.EntryOut) (*fs.Inode, fs.FileHandle, uint32, syscall.Errno) {
	child := &pathNode{sid: n.sid, rel: n.child(name)}
	fh, _, errno := child.openForWrite(flags | syscall.O_TRUNC)
	if errno != 0 {
		return nil, nil, 0, errno
	}
	// materialize immediately so a create-then-stat sequence works
	if h, ok := fh.(*writeHandle); ok {
		h.dirty = true
		if errno := h.upload(); errno != 0 {
			return nil, nil, 0, errno
		}
	}
	out.Attr.Mode = fuse.S_IFREG | 0o644
	inode := n.NewInode(ctx, child, fs.StableAttr{Mode: fuse.S_IFREG})
	return inode, fh, 0, 0
}

func (n *pathNode) Mkdir(ctx context.Context, name string, mode uint32, out *fuse.EntryOut) (*fs.Inode, syscall.Errno) {
	rel := n.child(name)
	if err := client.Mkdir(n.sid, rel); err != nil {
		return nil, syscall.EIO
	}
	snaps.Invalidate(n.sid)
	out.Attr.Mode = fuse.S_IFDIR | 0o755
	return n.NewInode(ctx, &pathNode{sid: n.sid, rel: rel}, fs.StableAttr{Mode: fuse.S_IFDIR}), 0
}

func (n *pathNode) Unlink(ctx context.Context, name string) syscall.Errno {
	if err := client.Delete(n.sid, n.child(name)); err != nil {
		return syscall.EIO
	}
	snaps.Invalidate(n.sid)
	return 0
}

func (n *pathNode) Rmdir(ctx context.Context, name string) syscall.Errno {
	return n.Unlink(ctx, name)
}

func (n *pathNode) Rename(ctx context.Context, name string, newParent fs.InodeEmbedder, newName string, flags uint32) syscall.Errno {
	np, ok := newParent.(*pathNode)
	if !ok {
		return syscall.EXDEV // cross-agent moves are not one filesystem
	}
	if np.sid != n.sid {
		return syscall.EXDEV
	}
	if err := client.Rename(n.sid, n.child(name), np.child(newName)); err != nil {
		return syscall.EIO
	}
	snaps.Invalidate(n.sid)
	return 0
}

func (n *pathNode) Setattr(ctx context.Context, fh fs.FileHandle, in *fuse.SetAttrIn, out *fuse.AttrOut) syscall.Errno {
	// truncate on an open write handle happens in the spool; other attrs
	// (times/modes) have no server representation — accept silently.
	if sz, ok := in.GetSize(); ok {
		if h, hok := fh.(*writeHandle); hok {
			h.mu.Lock()
			h.f.Truncate(int64(sz))
			h.dirty = true
			h.mu.Unlock()
		}
	}
	return n.Getattr(ctx, fh, out)
}

// Statfs makes the agent's quota visible where users actually look —
// the file manager's free-space bar and `df`. Without it a mount reports
// zeros and every "not enough space?" question becomes a support ticket.
func (n *pathNode) Statfs(ctx context.Context, out *fuse.StatfsOut) syscall.Errno {
	used, quota, err := client.Usage(n.sid)
	if err != nil || quota <= 0 {
		return 0 // leave the kernel defaults rather than lie
	}
	const bs = 4096
	out.Bsize, out.Frsize = bs, bs
	out.Blocks = uint64(quota / bs)
	free := quota - used
	if free < 0 {
		free = 0
	}
	out.Bfree, out.Bavail = uint64(free/bs), uint64(free/bs)
	out.NameLen = 255
	return 0
}

var _ = (fs.NodeStatfser)((*pathNode)(nil))
var _ = (fs.NodeGetattrer)((*pathNode)(nil))
var _ = (fs.NodeReaddirer)((*pathNode)(nil))
var _ = (fs.NodeLookuper)((*pathNode)(nil))
var _ = (fs.NodeOpener)((*pathNode)(nil))
var _ = (fs.NodeCreater)((*pathNode)(nil))
var _ = (fs.NodeMkdirer)((*pathNode)(nil))
var _ = (fs.NodeUnlinker)((*pathNode)(nil))
var _ = (fs.NodeRmdirer)((*pathNode)(nil))
var _ = (fs.NodeRenamer)((*pathNode)(nil))
var _ = (fs.NodeSetattrer)((*pathNode)(nil))

// ── main ────────────────────────────────────────────────────────────────

func main() {
	server := flag.String("server", "", "Geny server base URL")
	tokenFile := flag.String("token-file", "", "file containing the Bearer token (rewritten by the connector on refresh)")
	mountpoint := flag.String("mountpoint", "", "empty directory to mount GenyDrive on")
	parentPID := flag.Int("parent-pid", 0, "exit (unmounting) when this process disappears")
	flag.Parse()
	if *server == "" || *tokenFile == "" || *mountpoint == "" {
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

	opts := &fs.Options{
		MountOptions: fuse.MountOptions{
			FsName: "genydrive",
			Name:   "genydrive",
		},
	}
	to := 2 * time.Second
	opts.AttrTimeout, opts.EntryTimeout = &to, &to

	srv, err := fs.Mount(*mountpoint, &rootNode{}, opts)
	if err != nil {
		log.Fatalf("mount: %v", err)
	}
	log.Printf("genydrive mounted at %s", *mountpoint)

	sig := make(chan os.Signal, 2)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sig
		srv.Unmount()
	}()

	// ORPHAN GUARD. A mount that outlives the connector is worse than no
	// mount: the directory keeps answering with a dead daemon behind it
	// (observed — SIGKILL'ing the app left the mount up, since a child is
	// not signalled when its parent dies on Linux). Signal 0 probes
	// liveness without touching the process; reparenting to init (ppid 1)
	// is the same verdict for a process we were spawned by.
	if *parentPID > 0 {
		go func() {
			for range time.Tick(2 * time.Second) {
				if err := syscall.Kill(*parentPID, 0); err != nil || os.Getppid() == 1 {
					log.Printf("parent %d gone — unmounting", *parentPID)
					srv.Unmount()
					return
				}
			}
		}()
	}
	srv.Wait()
}
