//go:build windows

// cfapi_windows.go — Windows Cloud Files API bindings.
//
// CfAPI is what OneDrive's "Files On-Demand" is built on: the sync root is
// a REAL directory in the user's profile whose entries are PLACEHOLDERS —
// they show name/size/date in Explorer while occupying no disk, and the
// filesystem filter driver calls back into this process the moment
// something reads one. That is the Windows equivalent of the FUSE mount,
// and unlike WebDAV it has no 47 MB cap, no deprecated service, and no
// registry surgery.
//
// Everything here is plain Win32 in cldapi.dll, called through LazyDLL —
// no cgo, so this cross-compiles from any host. The cost is that struct
// layouts and callback signatures are hand-mirrored from the SDK headers
// and must match exactly; each one below cites what it mirrors.
package main

import (
	"fmt"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	cldapi = windows.NewLazySystemDLL("cldapi.dll")

	procCfRegisterSyncRoot   = cldapi.NewProc("CfRegisterSyncRoot")
	procCfUnregisterSyncRoot = cldapi.NewProc("CfUnregisterSyncRoot")
	procCfConnectSyncRoot    = cldapi.NewProc("CfConnectSyncRoot")
	procCfDisconnectSyncRoot = cldapi.NewProc("CfDisconnectSyncRoot")
	procCfCreatePlaceholders = cldapi.NewProc("CfCreatePlaceholders")
	procCfExecute            = cldapi.NewProc("CfExecute")
)

// ── constants (cfapi.h) ─────────────────────────────────────────────────

const (
	CF_REGISTER_FLAG_NONE                  = 0x00000000
	CF_REGISTER_FLAG_UPDATE                = 0x00000001
	CF_CONNECT_FLAG_REQUIRE_PROCESS_INFO   = 0x00000002
	CF_CONNECT_FLAG_REQUIRE_FULL_FILE_PATH = 0x00000004

	CF_CALLBACK_TYPE_FETCH_DATA        = 0
	CF_CALLBACK_TYPE_VALIDATE_DATA     = 1
	CF_CALLBACK_TYPE_CANCEL_FETCH_DATA = 2
	CF_CALLBACK_TYPE_FETCH_PLACEHOLDERS = 3
	CF_CALLBACK_TYPE_NONE              = 0xFFFFFFFF

	CF_OPERATION_TYPE_TRANSFER_DATA         = 0
	CF_OPERATION_TYPE_TRANSFER_PLACEHOLDERS = 2

	CF_PLACEHOLDER_CREATE_FLAG_NONE           = 0x00
	CF_PLACEHOLDER_CREATE_FLAG_DISABLE_ON_DEMAND_POPULATION = 0x01
	CF_PLACEHOLDER_CREATE_FLAG_MARK_IN_SYNC   = 0x02

	CF_HYDRATION_POLICY_PARTIAL  = 0
	CF_POPULATION_POLICY_FULL    = 2
	CF_POPULATION_POLICY_ALWAYS_FULL = 3

	CF_SYNC_PROVIDER_STATUS_IDLE = 0

	// FILE_ATTRIBUTE_DIRECTORY
	fileAttrDirectory = 0x10
)

// ── structs (cfapi.h) ───────────────────────────────────────────────────

// CF_SYNC_REGISTRATION. Trailing pointer fields are optional and left nil.
type cfSyncRegistration struct {
	StructSize          uint32
	_                   uint32 // alignment
	ProviderName        *uint16
	ProviderVersion     *uint16
	SyncRootIdentity    unsafe.Pointer
	SyncRootIdentityLen uint32
	_                   uint32
	FileIdentity        unsafe.Pointer
	FileIdentityLength  uint32
	_                   uint32
	ProviderID          windows.GUID
}

// CF_SYNC_POLICIES
type cfSyncPolicies struct {
	StructSize     uint32
	Hydration      cfHydrationPolicy
	Population     cfPopulationPolicy
	InSync         uint32
	HardLink       uint32
	PlaceholderMgmt uint32
}

type cfHydrationPolicy struct {
	Primary  uint16
	Modifier uint16
}

type cfPopulationPolicy struct {
	Primary  uint16
	Modifier uint16
}

// CF_CALLBACK_REGISTRATION — array terminated by {CF_CALLBACK_TYPE_NONE, nil}
type cfCallbackRegistration struct {
	Type     uint32
	_        uint32
	Callback uintptr
}

// CF_CALLBACK_INFO — only the fields we consume are named; the rest are
// padded so the layout matches the SDK exactly.
type cfCallbackInfo struct {
	StructSize                 uint32
	_                          uint32
	ConnectionKey              int64
	CallbackContext            uintptr
	VolumeGuidName             *uint16
	VolumeDosName              *uint16
	VolumeSerialNumber         uint32
	_                          uint32
	SyncRootFileID             int64
	SyncRootIdentity           unsafe.Pointer
	SyncRootIdentityLength     uint32
	_                          uint32
	FileID                     int64
	FileSize                   int64
	FileIdentity               unsafe.Pointer
	FileIdentityLength         uint32
	_                          uint32
	NormalizedPath             *uint16
	TransferKey                int64
	PriorityHint               uint8
	_                          [7]byte
	CorrelationVector          uintptr
	ProcessInfo                uintptr
	RequestKey                 int64
}

// CF_CALLBACK_PARAMETERS is a union; FetchData is the arm we serve.
type cfCallbackParametersFetchData struct {
	ParamSize        uint32
	_                uint32
	Flags            uint32
	_                uint32
	RequiredFileOffset  int64
	RequiredLength      int64
	OptionalFileOffset  int64
	OptionalLength      int64
	LastDehydrationTime int64
	LastDehydrationReason uint32
	_                uint32
}

// CF_OPERATION_INFO
type cfOperationInfo struct {
	StructSize        uint32
	Type              uint32
	ConnectionKey     int64
	TransferKey       int64
	CorrelationVector uintptr
	SyncStatus        uintptr
	RequestKey        int64
}

// CF_OPERATION_PARAMETERS (TransferData arm)
type cfOperationParametersTransferData struct {
	ParamSize      uint32
	_              uint32
	Flags          uint32
	_              uint32
	CompletionStatus int32 // NTSTATUS
	_              uint32
	Buffer         uintptr
	Offset         int64
	Length         int64
}

// CF_PLACEHOLDER_CREATE_INFO
type cfPlaceholderCreateInfo struct {
	RelativeFileName   *uint16
	FsMetadata         cfFsMetadata
	FileIdentity       unsafe.Pointer
	FileIdentityLength uint32
	_                  uint32
	Flags              uint32
	_                  uint32
	Result             int32
	_                  uint32
	CreateUsn          int64
}

type cfFsMetadata struct {
	BasicInfo cfFileBasicInfo
	FileSize  int64
}

// FILE_BASIC_INFO
type cfFileBasicInfo struct {
	CreationTime   int64
	LastAccessTime int64
	LastWriteTime  int64
	ChangeTime     int64
	FileAttributes uint32
	_              uint32
}

// ── thin wrappers ───────────────────────────────────────────────────────

func hresult(r uintptr) error {
	if int32(r) >= 0 {
		return nil
	}
	return fmt.Errorf("HRESULT 0x%08X", uint32(r))
}

func cfRegisterSyncRoot(path string, reg *cfSyncRegistration, pol *cfSyncPolicies, update bool) error {
	p, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	flags := uintptr(CF_REGISTER_FLAG_NONE)
	if update {
		flags = CF_REGISTER_FLAG_UPDATE
	}
	r, _, _ := procCfRegisterSyncRoot.Call(
		uintptr(unsafe.Pointer(p)),
		uintptr(unsafe.Pointer(reg)),
		uintptr(unsafe.Pointer(pol)),
		flags,
	)
	return hresult(r)
}

func cfUnregisterSyncRoot(path string) error {
	p, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	r, _, _ := procCfUnregisterSyncRoot.Call(uintptr(unsafe.Pointer(p)))
	return hresult(r)
}

func cfConnectSyncRoot(path string, cbs []cfCallbackRegistration) (int64, error) {
	p, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return 0, err
	}
	var key int64
	r, _, _ := procCfConnectSyncRoot.Call(
		uintptr(unsafe.Pointer(p)),
		uintptr(unsafe.Pointer(&cbs[0])),
		0, // callback context
		uintptr(CF_CONNECT_FLAG_REQUIRE_FULL_FILE_PATH),
		uintptr(unsafe.Pointer(&key)),
	)
	if err := hresult(r); err != nil {
		return 0, err
	}
	return key, nil
}

func cfDisconnectSyncRoot(key int64) error {
	r, _, _ := procCfDisconnectSyncRoot.Call(uintptr(key))
	return hresult(r)
}

func cfCreatePlaceholders(parent string, infos []cfPlaceholderCreateInfo) error {
	if len(infos) == 0 {
		return nil
	}
	p, err := syscall.UTF16PtrFromString(parent)
	if err != nil {
		return err
	}
	var processed uint32
	r, _, _ := procCfCreatePlaceholders.Call(
		uintptr(unsafe.Pointer(p)),
		uintptr(unsafe.Pointer(&infos[0])),
		uintptr(len(infos)),
		uintptr(CF_PLACEHOLDER_CREATE_FLAG_MARK_IN_SYNC),
		uintptr(unsafe.Pointer(&processed)),
	)
	return hresult(r)
}

func cfExecute(info *cfOperationInfo, params unsafe.Pointer) error {
	r, _, _ := procCfExecute.Call(
		uintptr(unsafe.Pointer(info)),
		uintptr(params),
	)
	return hresult(r)
}
