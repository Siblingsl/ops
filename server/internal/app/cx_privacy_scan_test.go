package app

import (
	"encoding/json"
	"strings"
	"testing"

	"ops/internal/cxbuildvalidate"
)

func TestCXPrivacyCanariesCoverPositiveAndNegativeExamples(t *testing.T) {
	if !cxPrivacyRunCanaries() || !cxPrivacyStartupHealthy {
		t.Fatalf("privacy scanner self-test failures: %v", cxPrivacyCanaryFailures())
	}
}

// Q-CX-03 拍板（90 D-165，2026-11-03）：邮箱/手机号 WARN + 本人确认；ERROR 仍一律阻断。
// 报告必须继续遮蔽敏感原文；纯 WARN 构建可以 complete，由下载门禁做本人知悉确认。
func TestCXPrivacyReportMasksFindingsAndWarnRequiresAcknowledgement(t *testing.T) {
	secret := "sk-" + strings.Repeat("a", 28)
	snapshot := map[string]any{"work": map[string]any{"title": "联系 reader@example.invalid", "summary": "密钥 " + secret}}
	sections := []cxbuildvalidate.Section{{ID: "b78bf6bc-24a5-4ec9-a38f-3c833851bc30", Heading: "13812345678", ContentMD: "敏感样例"}}
	artifacts := []cxBuildArtifact{{Kind: "html", Name: "report.html", Data: []byte(`<section><div data-section-id="b78bf6bc-24a5-4ec9-a38f-3c833851bc30"><p>192.168.10.20</p></div></section>`)}}
	result, ready := cxScanBuildArtifacts(snapshot, sections, artifacts)
	if ready {
		t.Fatal("an ERROR finding must keep the build incomplete")
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	serialized := string(encoded)
	for _, raw := range []string{secret, "reader@example.invalid", "13812345678"} {
		if strings.Contains(serialized, raw) {
			t.Fatalf("privacy report leaked sensitive input %q: %s", raw, serialized)
		}
	}
	if !strings.Contains(serialized, `"scanner_ok":true`) || !strings.Contains(serialized, `"policy_ready":true`) || strings.Contains(serialized, "Q-CX-03") {
		t.Fatalf("resolved policy must be reflected in the report: %s", serialized)
	}
	if !strings.Contains(serialized, `"errors":1`) {
		t.Fatalf("credential ERROR must be counted: %s", serialized)
	}

	// 纯 WARN（邮箱/手机号/IP）不再阻断 complete；ready=true，下载侧仍需本人知悉回执。
	warnOnly := map[string]any{"work": map[string]any{"title": "联系 reader@example.invalid", "summary": "普通摘要"}}
	warnResult, warnReady := cxScanBuildArtifacts(warnOnly, sections, artifacts)
	if !warnReady {
		t.Fatal("warn-only findings must not block completion after Q-CX-03 resolution")
	}
	warnEncoded, err := json.Marshal(warnResult)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(warnEncoded), `"level":"warn"`) || !strings.Contains(string(warnEncoded), `"errors":0`) {
		t.Fatalf("warn-only report must stay at warn level: %s", string(warnEncoded))
	}
}
