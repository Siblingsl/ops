//go:build !windows && !linux

package documentparse

import (
	"errors"
	"os"
	"os/exec"
)

type processLimit struct{}

func configureParserCommand(cmd *exec.Cmd) {}

func limitParserProcess(process *os.Process) (processLimit, error) {
	return processLimit{}, errors.New("unsupported process sandbox")
}

func (processLimit) Close() error { return nil }

func setParserWorkerMemoryLimit() error { return errors.New("unsupported process sandbox") }
