//go:build linux || darwin

package main

import (
	"os"
	"syscall"
)

// parentAlive: signal 0 probes liveness without touching the process, and
// reparenting to init (ppid 1) is the same verdict for a process we were
// spawned by.
func parentAlive(pid int) bool {
	if err := syscall.Kill(pid, 0); err != nil {
		return false
	}
	return os.Getppid() != 1
}
