package app

import (
	"ops/internal/cxbuildvalidate"
	"ops/internal/domain/privacy"
)

const (
	cxPrivacyScannerVersion = privacy.ScannerVersion
	cxPrivacyCanaryVersion  = privacy.CanaryVersion
	cxPrivacyMaxFindings    = privacy.MaxFindings
)

var cxPrivacyStartupHealthy = privacy.StartupHealthy

type cxPrivacyRule = privacy.Rule
type cxPrivacyFinding = privacy.Finding
type cxPrivacyReport = privacy.Report
type cxPrivacyInput = privacy.Input

func cxScanBuildArtifacts(snapshot map[string]any, sections []cxbuildvalidate.Section, artifacts []cxBuildArtifact) (map[string]any, bool) {
	converted := make([]privacy.Artifact, 0, len(artifacts))
	for _, artifact := range artifacts {
		converted = append(converted, privacy.Artifact{
			Kind: artifact.Kind, Name: artifact.Name, SHA256: artifact.SHA256, Data: artifact.Data,
		})
	}
	return privacy.ScanBuildArtifacts(snapshot, sections, converted)
}

func cxPrivacyHTMLInputs(data []byte, kind string) ([]cxPrivacyInput, bool) {
	return privacy.HTMLInputs(data, kind)
}

func cxPrivacyScanText(input cxPrivacyInput) []cxPrivacyFinding {
	return privacy.ScanText(input)
}

func cxPrivacyFindingIDs(findings []cxPrivacyFinding, inputs []cxPrivacyInput) []string {
	return privacy.FindingIDs(findings, inputs)
}

func cxPrivacyExcerpt(value string, start, end int) string {
	return privacy.Excerpt(value, start, end)
}

func cxPrivacyRunCanaries() bool {
	return privacy.RunCanaries()
}

func cxPrivacyCanaryFailures() []string {
	return privacy.CanaryFailures()
}

func cxPrivacyDecodeCanaries() bool {
	return privacy.DecodeCanaries()
}

func cxPrivacyDecodeText(data []byte) (string, string, error) {
	return privacy.DecodeText(data)
}

func cxPrivacyDecodeUTF16(data []byte, littleEndian bool) (string, error) {
	return privacy.DecodeUTF16(data, littleEndian)
}

func cxPrivacyTextControlsAllowed(text string) bool {
	return privacy.TextControlsAllowed(text)
}
