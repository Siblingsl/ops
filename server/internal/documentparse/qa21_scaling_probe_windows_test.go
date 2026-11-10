//go:build windows

package documentparse

// DEV-A21 基线探针：32MiB DOCX 成功 SLA（30s / 256MiB）的输入规模曲线。
// 只测量、不断言，输出形如：
//   DEV-A21_BASELINE expanded_mib=4 elapsed=... peak_job_bytes=... status=ok|timeout
// 与 qa26 两个探针一起构成 A21 的可复现基线；优化前后的数字都从这里取。

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

func TestA21BaselineScalingProbe(t *testing.T) {
	if os.Getenv("A21_BASELINE") == "" {
		t.Skip("set A21_BASELINE=1 to run the 32MiB scaling baseline (slow)")
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	for _, mib := range []int{1, 4, 8, 16, 24, 32} {
		compressed, ratio := compressedDocumentEntryDOCXFixture(t, mib<<20)
		payload, err := json.Marshal(Request{Name: fmt.Sprintf("baseline-%dmib.docx", mib), Data: compressed})
		if err != nil {
			t.Fatal(err)
		}
		cmd := exec.Command(executable, workerArg)
		cmd.Stdin = bytes.NewReader(payload)
		var stdout, stderr bytes.Buffer
		cmd.Stdout = &stdout
		cmd.Stderr = &stderr
		started := time.Now()
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		limit, err := limitParserProcess(cmd.Process)
		if err != nil {
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
			t.Fatalf("%dMiB: assign 256 MiB job limit: %v", mib, err)
		}
		done := make(chan error, 1)
		go func() { done <- cmd.Wait() }()
		status := "ok"
		var waitErr error
		select {
		case waitErr = <-done:
		case <-time.After(35 * time.Second):
			_ = cmd.Process.Kill()
			waitErr = <-done
			status = "timeout"
		}
		var usage windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION
		queryErr := windows.QueryInformationJobObject(limit.job, 9, uintptr(unsafe.Pointer(&usage)), uint32(unsafe.Sizeof(usage)), nil)
		limit.Close()
		if waitErr != nil && status == "ok" {
			status = "error:" + waitErr.Error()
		}
		t.Logf("DEV-A21_BASELINE expanded_mib=%d elapsed=%s compressed_bytes=%d ratio=%.1f peak_job_bytes=%d peak_mib=%.1f status=%s output_bytes=%d stderr=%q query_error=%v",
			mib, time.Since(started).Round(time.Millisecond), len(compressed), ratio,
			usage.PeakProcessMemoryUsed, float64(usage.PeakProcessMemoryUsed)/(1<<20), status, stdout.Len(),
			truncateProbe(stderr.String()), queryErr)
	}
}

func truncateProbe(value string) string {
	if len(value) > 200 {
		return value[:200]
	}
	return value
}

// TestA21CostAttributionProbe 区分"DOCX/XML 解析"与"通用文本处理"的成本：
// 同样 32MiB 的纯文本走同一条 worker 链路（无 inflate、无 XML），
// 差值即 DOCX 解压 + XML 文本抽取的耗时。
func TestA21CostAttributionProbe(t *testing.T) {
	if os.Getenv("A21_BASELINE") == "" {
		t.Skip("set A21_BASELINE=1 to run the cost attribution probe")
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	plain := bytes.Repeat([]byte("a"), 16<<20)
	payload, err := json.Marshal(Request{Name: "baseline-16mib.txt", Data: plain})
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(executable, workerArg)
	cmd.Stdin = bytes.NewReader(payload)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	started := time.Now()
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	limit, err := limitParserProcess(cmd.Process)
	if err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		t.Fatalf("assign 256 MiB job limit: %v", err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	status := "ok"
	var waitErr error
	select {
	case waitErr = <-done:
	case <-time.After(35 * time.Second):
		_ = cmd.Process.Kill()
		waitErr = <-done
		status = "timeout"
	}
	var usage windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION
	queryErr := windows.QueryInformationJobObject(limit.job, 9, uintptr(unsafe.Pointer(&usage)), uint32(unsafe.Sizeof(usage)), nil)
	limit.Close()
	if waitErr != nil && status == "ok" {
		status = "error:" + waitErr.Error()
	}
	t.Logf("DEV-A21_ATTRIBUTION kind=plain-text expanded_mib=16 elapsed=%s peak_job_bytes=%d peak_mib=%.1f status=%s output_bytes=%d stderr=%q query_error=%v",
		time.Since(started).Round(time.Millisecond), usage.PeakProcessMemoryUsed,
		float64(usage.PeakProcessMemoryUsed)/(1<<20), status, stdout.Len(), truncateProbe(stderr.String()), queryErr)
}

// TestA21InflateAttributionProbe 用 zip.Store（不压缩）的 16MiB 条目对比 deflate 版本：
// 若两者耗时接近，说明瓶颈不在 inflate 而在 XML/文本管线；若 Store 明显更快，
// 说明流式解压是首要优化点。
func TestA21InflateAttributionProbe(t *testing.T) {
	if os.Getenv("A21_BASELINE") == "" {
		t.Skip("set A21_BASELINE=1 to run the inflate attribution probe")
	}
	const mib = 8
	archiveBytes := storedDocumentEntryDOCXFixture(t, mib<<20)
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	payload, err := json.Marshal(Request{Name: "baseline-stored-8mib.docx", Data: archiveBytes})
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(executable, workerArg)
	cmd.Stdin = bytes.NewReader(payload)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	started := time.Now()
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	limit, err := limitParserProcess(cmd.Process)
	if err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		t.Fatalf("assign 256 MiB job limit: %v", err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	status := "ok"
	var waitErr error
	select {
	case waitErr = <-done:
	case <-time.After(35 * time.Second):
		_ = cmd.Process.Kill()
		waitErr = <-done
		status = "timeout"
	}
	var usage windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION
	queryErr := windows.QueryInformationJobObject(limit.job, 9, uintptr(unsafe.Pointer(&usage)), uint32(unsafe.Sizeof(usage)), nil)
	limit.Close()
	if waitErr != nil && status == "ok" {
		status = "error:" + waitErr.Error()
	}
	t.Logf("DEV-A21_ATTRIBUTION kind=docx-stored expanded_mib=%d archive_bytes=%d elapsed=%s peak_job_bytes=%d peak_mib=%.1f status=%s output_bytes=%d output=%q stderr=%q query_error=%v",
		mib, len(archiveBytes), time.Since(started).Round(time.Millisecond), usage.PeakProcessMemoryUsed,
		float64(usage.PeakProcessMemoryUsed)/(1<<20), status, stdout.Len(), truncateProbe(stdout.String()), truncateProbe(stderr.String()), queryErr)
}

func storedDocumentEntryDOCXFixture(t *testing.T, expandedDocumentEntry int) []byte {
	t.Helper()
	prefix := []byte(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>`)
	suffix := []byte(`</w:t></w:r></w:p></w:body></w:document>`)
	var compressed bytes.Buffer
	archive := zip.NewWriter(&compressed)
	for _, name := range []string{"[Content_Types].xml", "_rels/.rels"} {
		entry, err := archive.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := entry.Write([]byte(minimalOPCDOCXFiles(false)[name])); err != nil {
			t.Fatal(err)
		}
	}
	header := &zip.FileHeader{Name: "word/document.xml", Method: zip.Store}
	document, err := archive.CreateHeader(header)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := document.Write(prefix); err != nil {
		t.Fatal(err)
	}
	chunk := bytes.Repeat([]byte("a"), 1<<20)
	remaining := expandedDocumentEntry - len(prefix) - len(suffix)
	for remaining > 0 {
		count := min(remaining, len(chunk))
		if _, err := document.Write(chunk[:count]); err != nil {
			t.Fatal(err)
		}
		remaining -= count
	}
	if _, err := document.Write(suffix); err != nil {
		t.Fatal(err)
	}
	app, err := archive.Create("docProps/app.xml")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := app.Write([]byte("<Properties xmlns=\"http://schemas.openxmlformats.org/officeDocument/2006/extended-properties\"><Pages>1</Pages></Properties>")); err != nil {
		t.Fatal(err)
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	return compressed.Bytes()
}
