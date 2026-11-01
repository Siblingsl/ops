package app

import (
	"bytes"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"

	"ops/internal/cxbuildvalidate"
)

var cxEvidenceCSVHeader = []string{
	"index", "role", "section_id", "heading", "asset_id", "file_name", "mime", "width", "height", "bytes",
	"sha256", "output_sha256", "caption", "mapping_status",
}

func cxBuildEvidenceCSV(evidence []cxbuildvalidate.ImageEvidence) ([]byte, error) {
	var records bytes.Buffer
	writer := csv.NewWriter(&records)
	if err := writer.Write(cxEvidenceCSVHeader); err != nil {
		return nil, err
	}
	for _, item := range evidence {
		row := []string{
			fmt.Sprint(item.Index), item.Role, item.SectionID, item.Heading, item.AssetID, item.DisplayName, item.MIME,
			fmt.Sprint(item.Width), fmt.Sprint(item.Height), fmt.Sprint(item.Bytes), item.SHA256, item.OutputSHA256, item.Caption, item.MappingStatus,
		}
		for i := range row {
			row[i] = cxNeutralizeCSVFormula(row[i])
		}
		if err := writer.Write(row); err != nil {
			return nil, err
		}
	}
	writer.Flush()
	if err := writer.Error(); err != nil {
		return nil, err
	}
	return append([]byte{0xef, 0xbb, 0xbf}, records.Bytes()...), nil
}

func cxNeutralizeCSVFormula(value string) string {
	trimmed := strings.TrimLeftFunc(value, unicode.IsSpace)
	if trimmed == "" {
		return value
	}
	first, _ := utf8.DecodeRuneInString(trimmed)
	if strings.ContainsRune("=+-@−", first) {
		return "'" + value
	}
	return value
}
func cxManifestEvidence(raw json.RawMessage) ([]cxbuildvalidate.ImageEvidence, error) {
	var manifest struct {
		ImageEvidence []cxbuildvalidate.ImageEvidence `json:"image_evidence"`
	}
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return nil, err
	}
	if manifest.ImageEvidence == nil {
		manifest.ImageEvidence = []cxbuildvalidate.ImageEvidence{}
	}
	return manifest.ImageEvidence, nil
}
