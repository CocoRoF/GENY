//go:build windows

// mount_windows.go — the Windows leg of the native GenyDrive.
//
// Same contract as the FUSE leg, different mechanism: instead of a
// filesystem this registers a CfAPI SYNC ROOT — a real folder whose
// entries are placeholders. Explorer shows names, sizes and dates with
// nothing on disk; the moment something reads a file, the filter driver
// raises FETCH_DATA and we stream the bytes in from the same ranged GET
// the FUSE leg uses.
//
// Division of labour, and why:
//   - Directory structure is materialised as placeholders from the
//     journal snapshot. It is cheap (metadata only) and makes Explorer
//     instant, which is the entire point of the native drive.
//   - File CONTENT is never pre-fetched; it arrives per FETCH_DATA in
//     chunks the driver asks for.
//   - Local edits are picked up by the existing mirror engine — CfAPI's
//     write-back callbacks are a separate surface and the mirror already
//     converges correctly. This leg is read-through today; that is stated
//     in the UI rather than implied.
package main

import (
	"context"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// providerGUID identifies this sync provider to Windows. Stable by
// definition: changing it would orphan every registered root.
var providerGUID = windows.GUID{
	Data1: 0x8f2a1c34,
	Data2: 0x7b5e,
	Data3: 0x4d91,
	Data4: [8]byte{0xa6, 0x3c, 0x47, 0x1e, 0x9d, 0x02, 0xb8, 0x55},
}

type winMount struct {
	root string

	mu            sync.Mutex
	connectionKey int64
	// placeholder path (windows, lowercased) → (agent, workspace-relative)
	files map[string]fileRef
}

type fileRef struct {
	sid string
	rel string
}

var activeMount *winMount

func (m *winMount) lookup(fullPath string) (fileRef, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	f, ok := m.files[strings.ToLower(fullPath)]
	return f, ok
}

// fetchDataCallback serves CF_CALLBACK_TYPE_FETCH_DATA: the driver wants
// [offset, length) of a placeholder. We stream it from the server in 1 MiB
// pieces and hand each piece back with CfExecute(TRANSFER_DATA) — the same
// readahead granularity as the FUSE leg, for the same reason: a media
// player seeking in a 4 GB file must not drag the whole file across.
func fetchDataCallback(info *cfCallbackInfo, params *cfCallbackParametersFetchData) uintptr {
	m := activeMount
	if m == nil || info == nil || params == nil {
		return 0
	}
	full := windows.UTF16PtrToString(info.NormalizedPath)
	ref, ok := m.lookup(full)
	if !ok {
		// Path unknown (placeholder from a previous run): report failure
		// so Explorer shows an error instead of hanging forever.
		transferFailure(info, params.RequiredFileOffset, params.RequiredLength)
		return 0
	}

	off := params.RequiredFileOffset
	end := off + params.RequiredLength
	// Serve the optional (readahead) window too when the driver offers it —
	// it is free bandwidth-wise and halves the callback count on a
	// sequential read.
	if params.OptionalLength > 0 && params.OptionalFileOffset+params.OptionalLength > end {
		end = params.OptionalFileOffset + params.OptionalLength
	}

	buf := make([]byte, 1<<20)
	for off < end {
		want := int64(len(buf))
		if end-off < want {
			want = end - off
		}
		n, err := client.ReadRange(ref.sid, ref.rel, off, buf[:want])
		if err != nil || n == 0 {
			transferFailure(info, off, end-off)
			return 0
		}
		opInfo := cfOperationInfo{
			StructSize:    uint32(unsafe.Sizeof(cfOperationInfo{})),
			Type:          CF_OPERATION_TYPE_TRANSFER_DATA,
			ConnectionKey: info.ConnectionKey,
			TransferKey:   info.TransferKey,
			RequestKey:    info.RequestKey,
		}
		opParams := cfOperationParametersTransferData{
			ParamSize:        uint32(unsafe.Sizeof(cfOperationParametersTransferData{})),
			CompletionStatus: 0, // STATUS_SUCCESS
			Buffer:           uintptr(unsafe.Pointer(&buf[0])),
			Offset:           off,
			Length:           int64(n),
		}
		if err := cfExecute(&opInfo, unsafe.Pointer(&opParams)); err != nil {
			log.Printf("cfExecute transfer: %v", err)
			return 0
		}
		off += int64(n)
	}
	return 0
}

// transferFailure completes a fetch with STATUS_UNSUCCESSFUL so the
// requesting app gets an error rather than an indefinite hang — a hung
// Explorer is the worst failure mode a virtual drive can have.
func transferFailure(info *cfCallbackInfo, off, length int64) {
	opInfo := cfOperationInfo{
		StructSize:    uint32(unsafe.Sizeof(cfOperationInfo{})),
		Type:          CF_OPERATION_TYPE_TRANSFER_DATA,
		ConnectionKey: info.ConnectionKey,
		TransferKey:   info.TransferKey,
		RequestKey:    info.RequestKey,
	}
	opParams := cfOperationParametersTransferData{
		ParamSize:        uint32(unsafe.Sizeof(cfOperationParametersTransferData{})),
		CompletionStatus: int32(-1073741823), // STATUS_UNSUCCESSFUL
		Offset:           off,
		Length:           length,
	}
	_ = cfExecute(&opInfo, unsafe.Pointer(&opParams))
}

func fileTimeFromUnixNano(ns int64) int64 {
	if ns <= 0 {
		return 0
	}
	// FILETIME: 100 ns ticks since 1601-01-01; Unix epoch offset in ticks.
	return ns/100 + 116444736000000000
}

// syncPlaceholders walks the journal snapshot and materialises the tree as
// placeholders. Directories become real directories (Explorer needs to
// enumerate them); files become zero-disk placeholders carrying the real
// size and timestamps.
func (m *winMount) syncPlaceholders() error {
	agents, err := client.Agents()
	if err != nil {
		return err
	}
	files := map[string]fileRef{}
	for _, a := range agents {
		name := safeName(a.SessionName)
		if name == "agent" {
			name = safeName(a.SessionID[:8])
		}
		agentDir := filepath.Join(m.root, name)
		if err := os.MkdirAll(agentDir, 0o755); err != nil {
			continue
		}
		entries, err := client.Changes(a.SessionID)
		if err != nil {
			continue
		}
		// Directories first so placeholder parents exist.
		byParent := map[string][]cfPlaceholderCreateInfo{}
		for _, e := range entries {
			winRel := filepath.FromSlash(e.Path)
			abs := filepath.Join(agentDir, winRel)
			if e.IsDir {
				_ = os.MkdirAll(abs, 0o755)
				continue
			}
			parent := filepath.Dir(abs)
			_ = os.MkdirAll(parent, 0o755)
			base := filepath.Base(abs)
			namePtr, err := syscall.UTF16PtrFromString(base)
			if err != nil {
				continue
			}
			ft := fileTimeFromUnixNano(e.MtimeNs)
			byParent[parent] = append(byParent[parent], cfPlaceholderCreateInfo{
				RelativeFileName: namePtr,
				FsMetadata: cfFsMetadata{
					BasicInfo: cfFileBasicInfo{
						CreationTime:   ft,
						LastAccessTime: ft,
						LastWriteTime:  ft,
						ChangeTime:     ft,
						FileAttributes: 0x80, // FILE_ATTRIBUTE_NORMAL
					},
					FileSize: e.Size,
				},
				Flags: CF_PLACEHOLDER_CREATE_FLAG_MARK_IN_SYNC,
			})
			files[strings.ToLower(abs)] = fileRef{sid: a.SessionID, rel: e.Path}
		}
		for parent, infos := range byParent {
			if err := cfCreatePlaceholders(parent, infos); err != nil {
				// Existing placeholders come back as failures per item;
				// that is expected on refresh and not worth escalating.
				log.Printf("placeholders in %s: %v", parent, err)
			}
		}
	}
	m.mu.Lock()
	m.files = files
	m.mu.Unlock()
	return nil
}

// mountNative registers, connects and populates the sync root, then keeps
// the placeholder tree fresh until ctx ends.
func mountNative(ctx context.Context, root string) error {
	if err := os.MkdirAll(root, 0o755); err != nil {
		return err
	}
	providerName, _ := syscall.UTF16PtrFromString("Geny Drive")
	providerVersion, _ := syscall.UTF16PtrFromString("1.0")
	identity := []byte("geny-drive")

	reg := cfSyncRegistration{
		StructSize:          uint32(unsafe.Sizeof(cfSyncRegistration{})),
		ProviderName:        providerName,
		ProviderVersion:     providerVersion,
		SyncRootIdentity:    unsafe.Pointer(&identity[0]),
		SyncRootIdentityLen: uint32(len(identity)),
		ProviderID:          providerGUID,
	}
	pol := cfSyncPolicies{
		StructSize: uint32(unsafe.Sizeof(cfSyncPolicies{})),
		Hydration:  cfHydrationPolicy{Primary: CF_HYDRATION_POLICY_PARTIAL},
		Population: cfPopulationPolicy{Primary: CF_POPULATION_POLICY_FULL},
		InSync:     0,
	}
	// UPDATE so re-running over an existing root refreshes rather than
	// failing — the connector restarts this daemon on every login.
	if err := cfRegisterSyncRoot(root, &reg, &pol, true); err != nil {
		return err
	}

	m := &winMount{root: root, files: map[string]fileRef{}}
	activeMount = m

	fetchCb := syscall.NewCallback(func(info *cfCallbackInfo, params *cfCallbackParametersFetchData) uintptr {
		return fetchDataCallback(info, params)
	})
	cbs := []cfCallbackRegistration{
		{Type: CF_CALLBACK_TYPE_FETCH_DATA, Callback: fetchCb},
		{Type: CF_CALLBACK_TYPE_NONE, Callback: 0},
	}
	key, err := cfConnectSyncRoot(root, cbs)
	if err != nil {
		_ = cfUnregisterSyncRoot(root)
		return err
	}
	m.connectionKey = key
	log.Printf("genydrive sync root connected at %s", root)

	if err := m.syncPlaceholders(); err != nil {
		log.Printf("initial placeholder sync: %v", err)
	}

	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			_ = cfDisconnectSyncRoot(key)
			// The root stays REGISTERED on purpose: unregistering would
			// dehydrate the tree and make Explorer forget the drive every
			// time the app closes. It is cleaned up on explicit unmount.
			return nil
		case <-ticker.C:
			if err := m.syncPlaceholders(); err != nil {
				log.Printf("placeholder refresh: %v", err)
			}
		}
	}
}

// unregisterNative removes the sync root entirely (user turned the drive
// off) — placeholders disappear with it.
func unregisterNative(root string) error {
	return cfUnregisterSyncRoot(root)
}
