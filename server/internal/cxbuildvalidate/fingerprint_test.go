package cxbuildvalidate

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"testing"
)

func TestArtifactFingerprintStableForSameFixture(t *testing.T) {
	assetBytes := []byte("fixture-png-bytes")
	digest := sha256.Sum256(assetBytes)
	assetID := "4f9c5897-1bf9-4812-981f-4d675ef4ad61"
	sectionID := "b78bf6bc-24a5-4ec9-a38f-3c833851bc30"
	assets := map[string]Asset{
		assetID: {
			ID: assetID, SHA256: hex.EncodeToString(digest[:]), MIME: "image/png",
			Width: 2, Height: 2, Bytes: int64(len(assetBytes)), Data: assetBytes, AltText: "示例图",
		},
	}
	sections := []Section{{
		ID: sectionID, Heading: "第一段",
		ContentMD: "正文![示例](/api/v1/assets/" + assetID + "/file)",
	}}
	htmlA := fmt.Sprintf(
		`<section><div data-section-id="%s"><h2>第一段</h2><p>正文<img src="/api/v1/assets/%s/file" alt="示例图" data-asset="%s"></p></div></section>`,
		sectionID, assetID, assetID,
	)
	// NBSP before the image collapses under normalizeText into the same digest.
	htmlB := fmt.Sprintf(
		"<section><div data-section-id=\"%s\"><h2>第一段</h2><p>正文\u00a0<img src=\"/api/v1/assets/%s/file\" alt=\"示例图\" data-asset=\"%s\"></p></div></section>",
		sectionID, assetID, assetID,
	)
	report, err := ValidateWechatHTML([]byte(htmlA), sections, assets, false)
	if err != nil {
		t.Fatalf("fixture HTML rejected: %v", err)
	}
	first, err := ArtifactFingerprint([]byte(htmlA), report.ImageEvidence)
	if err != nil {
		t.Fatal(err)
	}
	second, err := ArtifactFingerprint([]byte(htmlA), report.ImageEvidence)
	if err != nil {
		t.Fatal(err)
	}
	if first == "" || first != second {
		t.Fatalf("same fixture must yield identical fingerprint: %q vs %q", first, second)
	}
	if len(first) != 64 {
		t.Fatalf("fingerprint must be hex SHA-256: %q", first)
	}
	nbsp, err := ArtifactFingerprint([]byte(htmlB), report.ImageEvidence)
	if err != nil {
		t.Fatal(err)
	}
	if nbsp != first {
		t.Fatalf("whitespace-normalized HTML must share fingerprint: %q vs %q", first, nbsp)
	}
}
