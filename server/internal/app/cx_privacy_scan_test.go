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

func TestCXPrivacyReportMasksFindingsAndBlocksUnresolvedContactPolicy(t *testing.T) {
	secret := "sk-" + strings.Repeat("a", 28)
	snapshot := map[string]any{"work": map[string]any{"title": "联系 reader@example.invalid", "summary": "密钥 " + secret}}
	sections := []cxbuildvalidate.Section{{ID: "b78bf6bc-24a5-4ec9-a38f-3c833851bc30", Heading: "13812345678", ContentMD: "敏感样例"}}
	artifacts := []cxBuildArtifact{{Kind: "html", Name: "report.html", Data: []byte(`<section><div data-section-id="b78bf6bc-24a5-4ec9-a38f-3c833851bc30"><p>192.168.10.20</p></div></section>`)}}
	result, ready := cxScanBuildArtifacts(snapshot, sections, artifacts)
	if ready {
		t.Fatal("unresolved Q-CX-03 must keep the privacy release gate closed")
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
	if !strings.Contains(serialized, `"scanner_ok":true`) || !strings.Contains(serialized, `"policy_ready":false`) || !strings.Contains(serialized, `"Q-CX-03"`) || !strings.Contains(serialized, `"level":"block"`) {
		t.Fatalf("privacy report did not expose its safe blocked state: %s", serialized)
	}
}
