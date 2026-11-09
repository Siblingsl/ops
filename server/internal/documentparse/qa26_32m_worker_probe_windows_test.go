//go:build windows

package documentparse

import (
	"context"
	"testing"
	"time"
)

func TestQA26ProbeThirtyTwoMiBDocumentEntryWindowsWorker(t *testing.T) {
	const expandedDocumentEntry = 32 << 20
	compressed, ratio := compressedDocumentEntryDOCXFixture(t, expandedDocumentEntry)
	started := time.Now()
	result, err := Parse(context.Background(), "large-document-entry-32mib.docx", compressed)
	elapsed := time.Since(started)
	if err != nil {
		t.Logf("DEV-QA26_METRIC_DOCX_32MIB_WINDOWS_WORKER elapsed=%s ratio=%.1f error=%v", elapsed, ratio, err)
		return
	}
	t.Logf("DEV-QA26_METRIC_DOCX_32MIB_WINDOWS_WORKER elapsed=%s ratio=%.1f pages=%v extracted=%d injected=%d", elapsed, ratio, result.Pages, result.ExtractedChars, result.InjectedChars)
}
