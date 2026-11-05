//go:build linux

package documentparse

import (
	"errors"
	"os"
	"os/exec"
)

type processLimit struct{}

func configureParserCommand(cmd *exec.Cmd) {}

func limitParserProcess(_ *os.Process) (processLimit, error) {
	return processLimit{}, errors.New("linux parser workers require an isolated memory-limited container")
}

func (processLimit) Close() error { return nil }

func setParserWorkerMemoryLimit() error {
	return errors.New("linux parser workers require an isolated memory-limited container")
}
