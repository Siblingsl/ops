//go:build linux

package documentparse

import (
	"os"
	"os/exec"
	"syscall"
)

type processLimit struct{}

func configureParserCommand(cmd *exec.Cmd) {}

func limitParserProcess(process *os.Process) (processLimit, error) {
	return processLimit{}, nil
}

func (processLimit) Close() error { return nil }

func setParserWorkerMemoryLimit() error {
	limit := &syscall.Rlimit{Cur: 256 << 20, Max: 256 << 20}
	return syscall.Setrlimit(syscall.RLIMIT_DATA, limit)
}
