//go:build windows

package main

import "golang.org/x/sys/windows"

// parentAlive: Windows has no signal 0, and PPID is not tracked after the
// parent exits (PIDs are recycled). Opening the process and asking for its
// exit code is the reliable probe — STILL_ACTIVE means it is running.
func parentAlive(pid int) bool {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return false
	}
	defer windows.CloseHandle(h)
	var code uint32
	if err := windows.GetExitCodeProcess(h, &code); err != nil {
		return false
	}
	const stillActive = 259
	return code == stillActive
}
