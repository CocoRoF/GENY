// client.go — Geny storage REST client for the drive daemon.
//
// The daemon speaks the SAME API the mirror connector uses (changes feed,
// storage-raw ranged GET, PUT/mkdir/rename/delete), so every write lands in
// the sync journal and reaches mirror replicas and agents identically.
// Auth is a Bearer token read from --token-file on every request batch —
// the connector owns refresh and rewrites the file; the daemon just
// re-reads it after a 401.
package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

type Entry struct {
	Path    string `json:"path"`
	IsDir   bool   `json:"is_dir"`
	Size    int64  `json:"size"`
	MtimeNs int64  `json:"mtime_ns"`
	Sha256  string `json:"sha256"`
	Seq     int64  `json:"seq"`
	Deleted bool   `json:"deleted"`
}

type changesResp struct {
	LatestSeq int64   `json:"latest_seq"`
	Changes   []Entry `json:"changes"`
}

type Client struct {
	server    string
	tokenFile string

	mu    sync.Mutex
	token string
}

func NewClient(server, tokenFile string) *Client {
	return &Client{server: strings.TrimRight(server, "/"), tokenFile: tokenFile}
}

func (c *Client) readToken() string {
	b, err := os.ReadFile(c.tokenFile)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func (c *Client) do(req *http.Request) (*http.Response, error) {
	c.mu.Lock()
	if c.token == "" {
		c.token = c.readToken()
	}
	tok := c.token
	c.mu.Unlock()
	req.Header.Set("Authorization", "Bearer "+tok)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode == 401 {
		// token rotated by the connector — re-read once and retry
		resp.Body.Close()
		c.mu.Lock()
		c.token = c.readToken()
		tok = c.token
		c.mu.Unlock()
		req2 := req.Clone(req.Context())
		if req.GetBody != nil {
			body, err := req.GetBody()
			if err != nil {
				return nil, err
			}
			req2.Body = body
		}
		req2.Header.Set("Authorization", "Bearer "+tok)
		return http.DefaultClient.Do(req2)
	}
	return resp, nil
}

func (c *Client) agentURL(sid, p string, q url.Values) string {
	u := c.server + "/api/agents/" + url.PathEscape(sid) + p
	if len(q) > 0 {
		u += "?" + q.Encode()
	}
	return u
}

// Changes returns the full live snapshot (since=0) for an agent workspace.
func (c *Client) Changes(sid string) ([]Entry, error) {
	q := url.Values{"since": {"0"}}
	req, _ := http.NewRequest("GET", c.agentURL(sid, "/storage/changes", q), nil)
	resp, err := c.do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("changes HTTP %d", resp.StatusCode)
	}
	var cr changesResp
	if err := json.NewDecoder(resp.Body).Decode(&cr); err != nil {
		return nil, err
	}
	live := cr.Changes[:0]
	for _, e := range cr.Changes {
		if !e.Deleted {
			live = append(live, e)
		}
	}
	return live, nil
}

// ReadRange streams [off, off+len) of a workspace file (storage-raw + Range).
func (c *Client) ReadRange(sid, relPath string, off int64, dest []byte) (int, error) {
	segs := strings.Split("workspace/"+relPath, "/")
	for i, s := range segs {
		segs[i] = url.PathEscape(s)
	}
	req, _ := http.NewRequest("GET", c.agentURL(sid, "/storage-raw/"+strings.Join(segs, "/"), nil), nil)
	req.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", off, off+int64(len(dest))-1))
	resp, err := c.do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 206 && resp.StatusCode != 200 {
		return 0, fmt.Errorf("read HTTP %d", resp.StatusCode)
	}
	n, err := io.ReadFull(resp.Body, dest)
	if err == io.ErrUnexpectedEOF || err == io.EOF {
		return n, nil // short read at EOF is normal
	}
	return n, err
}

// Download fetches the whole file into a local spool path.
func (c *Client) Download(sid, relPath, spool string) error {
	segs := strings.Split("workspace/"+relPath, "/")
	for i, s := range segs {
		segs[i] = url.PathEscape(s)
	}
	req, _ := http.NewRequest("GET", c.agentURL(sid, "/storage-raw/"+strings.Join(segs, "/"), nil), nil)
	resp, err := c.do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("download HTTP %d", resp.StatusCode)
	}
	f, err := os.Create(spool)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = io.Copy(f, resp.Body)
	return err
}

// Files at or above this go through the resumable chunk protocol rather
// than one long PUT: a dropped connection mid-upload then costs the
// remaining chunks, not the whole transfer. Matches the connector's own
// threshold so both clients behave alike.
const chunkThreshold = 64 << 20
const chunkSize = 8 << 20

// Put uploads a spool file to a workspace path. Filesystem semantics are
// last-writer-wins: base_sha is sent when known, and a 409 is resolved by
// ONE retry against the server's current sha (the OS client already
// serialized the user's intent — same stance as the WebDAV layer).
//
// The body is STREAMED from disk. Reading the spool into memory first
// would make a 500 MB save cost 500 MB of RSS in a process that is
// supposed to be invisible — and the retry closure would pin a second
// copy.
func (c *Client) Put(sid, relPath, spool, baseSha string) error {
	st, err := os.Stat(spool)
	if err != nil {
		return err
	}
	if st.Size() >= chunkThreshold {
		return c.putChunked(sid, relPath, spool, st.Size(), baseSha)
	}
	put := func(sha string) (*http.Response, error) {
		q := url.Values{"path": {"workspace/" + relPath}, "device": {"drive-daemon"}}
		if sha != "" {
			q.Set("base_sha", sha)
		}
		f, err := os.Open(spool)
		if err != nil {
			return nil, err
		}
		req, _ := http.NewRequest("PUT", c.agentURL(sid, "/storage/file", q), f)
		req.ContentLength = st.Size()
		// Re-open (not re-buffer) for the auth retry inside do().
		req.GetBody = func() (io.ReadCloser, error) { return os.Open(spool) }
		req.Header.Set("Content-Type", "application/octet-stream")
		resp, err := c.do(req)
		f.Close()
		return resp, err
	}
	resp, err := put(baseSha)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == 409 {
		var conflict struct {
			CurrentSha string `json:"current_sha"`
		}
		_ = json.NewDecoder(resp.Body).Decode(&conflict)
		resp2, err := put(conflict.CurrentSha)
		if err != nil {
			return err
		}
		defer resp2.Body.Close()
		if resp2.StatusCode != 200 {
			return fmt.Errorf("put retry HTTP %d", resp2.StatusCode)
		}
		return nil
	}
	if resp.StatusCode != 200 {
		return fmt.Errorf("put HTTP %d", resp.StatusCode)
	}
	return nil
}

// putChunked: start → sequential 8 MiB parts → commit (server verifies the
// whole-file sha and does the same atomic, journal-integrated commit as a
// plain PUT).
func (c *Client) putChunked(sid, relPath, spool string, size int64, baseSha string) error {
	f, err := os.Open(spool)
	if err != nil {
		return err
	}
	defer f.Close()

	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return err
	}
	sum := hex.EncodeToString(h.Sum(nil))
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return err
	}

	q := url.Values{
		"path":   {"workspace/" + relPath},
		"size":   {fmt.Sprint(size)},
		"sha256": {sum},
	}
	req, _ := http.NewRequest("POST", c.agentURL(sid, "/storage/file/chunks/start", q), nil)
	resp, err := c.do(req)
	if err != nil {
		return err
	}
	var started struct {
		UploadID string `json:"upload_id"`
	}
	err = json.NewDecoder(resp.Body).Decode(&started)
	resp.Body.Close()
	if err != nil || started.UploadID == "" {
		return fmt.Errorf("chunk start failed (HTTP %d)", resp.StatusCode)
	}

	buf := make([]byte, chunkSize)
	var off int64
	for off < size {
		n, rerr := io.ReadFull(f, buf)
		if n == 0 && rerr != nil {
			return rerr
		}
		part := buf[:n]
		pq := url.Values{"offset": {fmt.Sprint(off)}}
		preq, _ := http.NewRequest("PUT",
			c.agentURL(sid, "/storage/file/chunks/"+url.PathEscape(started.UploadID), pq),
			bytes.NewReader(part))
		preq.ContentLength = int64(n)
		preq.GetBody = func() (io.ReadCloser, error) { return io.NopCloser(bytes.NewReader(part)), nil }
		presp, err := c.do(preq)
		if err != nil {
			return err
		}
		code := presp.StatusCode
		presp.Body.Close()
		if code != 200 {
			return fmt.Errorf("chunk %d HTTP %d", off, code)
		}
		off += int64(n)
	}

	cq := url.Values{}
	if baseSha != "" {
		cq.Set("base_sha", baseSha)
	}
	creq, _ := http.NewRequest("POST",
		c.agentURL(sid, "/storage/file/chunks/"+url.PathEscape(started.UploadID)+"/commit", cq), nil)
	cresp, err := c.do(creq)
	if err != nil {
		return err
	}
	defer cresp.Body.Close()
	if cresp.StatusCode == 409 {
		// Same last-writer-wins stance as the small path: retry once
		// against the server's current sha.
		var conflict struct {
			CurrentSha string `json:"current_sha"`
		}
		_ = json.NewDecoder(cresp.Body).Decode(&conflict)
		cq2 := url.Values{"base_sha": {conflict.CurrentSha}}
		creq2, _ := http.NewRequest("POST",
			c.agentURL(sid, "/storage/file/chunks/"+url.PathEscape(started.UploadID)+"/commit", cq2), nil)
		cresp2, err := c.do(creq2)
		if err != nil {
			return err
		}
		defer cresp2.Body.Close()
		if cresp2.StatusCode != 200 {
			return fmt.Errorf("chunk commit retry HTTP %d", cresp2.StatusCode)
		}
		return nil
	}
	if cresp.StatusCode != 200 {
		return fmt.Errorf("chunk commit HTTP %d", cresp.StatusCode)
	}
	return nil
}

// Usage reports used/quota bytes for one agent (RFC-ish statfs source).
func (c *Client) Usage(sid string) (used, quota int64, err error) {
	q := url.Values{"since": {"0"}}
	req, _ := http.NewRequest("GET", c.agentURL(sid, "/storage/changes", q), nil)
	resp, err := c.do(req)
	if err != nil {
		return 0, 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return 0, 0, fmt.Errorf("usage HTTP %d", resp.StatusCode)
	}
	var out struct {
		UsedBytes  int64 `json:"used_bytes"`
		QuotaBytes int64 `json:"quota_bytes"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return 0, 0, err
	}
	return out.UsedBytes, out.QuotaBytes, nil
}

func (c *Client) Mkdir(sid, relPath string) error {
	q := url.Values{"path": {"workspace/" + relPath}}
	req, _ := http.NewRequest("POST", c.agentURL(sid, "/storage/mkdir", q), nil)
	resp, err := c.do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 && resp.StatusCode != 409 { // 409 = exists
		return fmt.Errorf("mkdir HTTP %d", resp.StatusCode)
	}
	return nil
}

func (c *Client) Delete(sid, relPath string) error {
	q := url.Values{"path": {"workspace/" + relPath}}
	req, _ := http.NewRequest("DELETE", c.agentURL(sid, "/storage/entry", q), nil)
	resp, err := c.do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 && resp.StatusCode != 404 {
		return fmt.Errorf("delete HTTP %d", resp.StatusCode)
	}
	return nil
}

func (c *Client) Rename(sid, src, dst string) error {
	payload, _ := json.Marshal(map[string]string{
		"src": "workspace/" + src,
		"dst": "workspace/" + dst,
	})
	req, _ := http.NewRequest("POST", c.agentURL(sid, "/storage/rename", nil), bytes.NewReader(payload))
	req.GetBody = func() (io.ReadCloser, error) { return io.NopCloser(bytes.NewReader(payload)), nil }
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("rename HTTP %d", resp.StatusCode)
	}
	return nil
}

type Agent struct {
	SessionID   string `json:"session_id"`
	SessionName string `json:"session_name"`
}

// Agents lists the caller's agents via the storage summary (owner-filtered
// server-side; includes dormant sessions whose files are still on disk).
func (c *Client) Agents() ([]Agent, error) {
	req, _ := http.NewRequest("GET", c.server+"/api/agents/storage/summary", nil)
	resp, err := c.do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("agents HTTP %d", resp.StatusCode)
	}
	var out struct {
		Agents []Agent `json:"agents"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, err
	}
	return out.Agents, nil
}

// snapshotCache: per-agent live-entry map with a short TTL — getattr and
// readdir storms (file managers stat everything) cost one changes call per
// TTL, and the server side throttles its own rescan the same way.
type snapshotCache struct {
	c   *Client
	ttl time.Duration

	mu   sync.Mutex
	data map[string]*snapEntry
	// One refresh per agent at a time: a file manager opening a folder
	// fires dozens of concurrent lookups, and without this every one of
	// them would issue its own full changes request.
	fetching map[string]*sync.Mutex
}

type snapEntry struct {
	at      time.Time
	entries map[string]Entry // rel path → entry
}

func newSnapshotCache(c *Client, ttl time.Duration) *snapshotCache {
	return &snapshotCache{
		c:        c,
		ttl:      ttl,
		data:     map[string]*snapEntry{},
		fetching: map[string]*sync.Mutex{},
	}
}

func (s *snapshotCache) Get(sid string) (map[string]Entry, error) {
	s.mu.Lock()
	cur := s.data[sid]
	if cur != nil && time.Since(cur.at) < s.ttl {
		defer s.mu.Unlock()
		return cur.entries, nil
	}
	gate, ok := s.fetching[sid]
	if !ok {
		gate = &sync.Mutex{}
		s.fetching[sid] = gate
	}
	s.mu.Unlock()

	gate.Lock()
	defer gate.Unlock()
	// Someone may have refreshed while we waited for the gate.
	s.mu.Lock()
	if e := s.data[sid]; e != nil && time.Since(e.at) < s.ttl {
		s.mu.Unlock()
		return e.entries, nil
	}
	s.mu.Unlock()

	live, err := s.c.Changes(sid)
	if err != nil {
		s.mu.Lock()
		defer s.mu.Unlock()
		if cur != nil {
			return cur.entries, nil // serve stale over failing
		}
		return nil, err
	}
	m := make(map[string]Entry, len(live))
	for _, e := range live {
		m[e.Path] = e
	}
	s.mu.Lock()
	s.data[sid] = &snapEntry{at: time.Now(), entries: m}
	s.mu.Unlock()
	return m, nil
}

func (s *snapshotCache) Invalidate(sid string) {
	s.mu.Lock()
	delete(s.data, sid)
	s.mu.Unlock()
}
