//go:build windows

package documentparse

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

func TestQA26ProbeThirtyTwoMiBWorkerJobPeak(t *testing.T) {
	compressed, ratio := compressedDocumentEntryDOCXFixture(t, 32<<20)
	payload, err := json.Marshal(Request{Name: "large-document-entry-32mib.docx", Data: compressed})
	if err != nil {
		t.Fatal(err)
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(executable, workerArg)
	cmd.Stdin = bytes.NewReader(payload)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	limit, err := limitParserProcess(cmd.Process)
	if err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		t.Fatalf("assign existing 256 MiB worker Job limit: %v", err)
	}
	defer limit.Close()
	started := time.Now()
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	var waitErr error
	select {
	case waitErr = <-done:
	case <-time.After(45 * time.Second):
		_ = cmd.Process.Kill()
		waitErr = <-done
	}
	var usage windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION
	queryErr := windows.QueryInformationJobObject(limit.job, 9, uintptr(unsafe.Pointer(&usage)), uint32(unsafe.Sizeof(usage)), nil)
	t.Logf("DEV-QA26_32MIB_JOB_PROBE elapsed=%s compressed_bytes=%d ratio=%.1f wait_error=%v output_bytes=%d stderr_bytes=%d peak_job_bytes=%d peak_query_error=%v", time.Since(started), len(compressed), ratio, waitErr, stdout.Len(), stderr.Len(), usage.PeakProcessMemoryUsed, queryErr)
}
