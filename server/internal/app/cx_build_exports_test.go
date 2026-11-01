package app

import (
	"bytes"
	"encoding/csv"
	"strings"
	"testing"

	"ops/internal/cxbuildvalidate"
)

func TestCXBuildEvidenceCSVUsesBOMQuotingAndFormulaProtection(t *testing.T) {
	data, err := cxBuildEvidenceCSV([]cxbuildvalidate.ImageEvidence{{
		Index: 1, Role: "body", SectionID: "section-id", Heading: "标题,含逗号",
		AssetID: "asset-id", DisplayName: "素材.png", MIME: "image/png", Width: 780, Height: 420,
		Bytes: 1024, SHA256: strings.Repeat("a", 64), OutputSHA256: strings.Repeat("a", 64),
		Caption: "  =HYPERLINK(\"https://invalid.example\")\n第二行", MappingStatus: "verified",
	}})
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.HasPrefix(data, []byte{0xef, 0xbb, 0xbf}) {
		t.Fatal("CSV is missing its UTF-8 BOM")
	}
	records, err := csv.NewReader(bytes.NewReader(bytes.TrimPrefix(data, []byte{0xef, 0xbb, 0xbf}))).ReadAll()
	if err != nil {
		t.Fatalf("CSV is not parseable with quoted newlines: %v", err)
	}
	if len(records) != 2 || len(records[1]) != len(cxEvidenceCSVHeader) || records[1][3] != "标题,含逗号" {
		t.Fatalf("CSV field structure or newline quoting is invalid: %#v", records)
	}
	if !strings.HasPrefix(records[1][12], "'  =") {
		t.Fatalf("formula prefix with whitespace bypass was not neutralized: %q", records[1][12])
	}
}
