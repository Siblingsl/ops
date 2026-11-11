package cxbuildvalidate

import (
	"bytes"
	"fmt"

	xhtml "golang.org/x/net/html"

	"ops/internal/cxcanonicaljson"
)

// ArtifactFingerprintSchema identifies the canonical payload hashed into
// artifact_fingerprint (docs/24 §4.6 / DEEP-02). Bump when fields change.
const ArtifactFingerprintSchema = "ops.artifact-fingerprint/v1"

// FingerprintSection is one validated HTML section's identity plus whitespace-
// normalized visible text used for cross-client render comparison.
type FingerprintSection struct {
	ID   string `json:"id"`
	Text string `json:"text"`
}

// ArtifactFingerprint hashes the normalized HTML section texts together with
// the already-verified image evidence into a lowercase hex SHA-256. Same
// fixture bytes must yield the same digest; unused_asset_ids are excluded
// because map iteration order is not stable.
func ArtifactFingerprint(rawHTML []byte, evidence []ImageEvidence) (string, error) {
	sections, err := NormalizedHTMLSections(rawHTML)
	if err != nil {
		return "", err
	}
	if evidence == nil {
		evidence = []ImageEvidence{}
	}
	payload := map[string]any{
		"schema":            ArtifactFingerprintSchema,
		"validator_version": ValidatorVersion,
		"sections":          sections,
		"image_evidence":    evidence,
	}
	return cxcanonicaljson.Hash(payload)
}

// NormalizedHTMLSections walks the validated wechat HTML envelope and returns
// section wrappers in document order with normalizeText(textContent).
func NormalizedHTMLSections(rawHTML []byte) ([]FingerprintSection, error) {
	if len(rawHTML) == 0 {
		return nil, fmt.Errorf("HTML is empty")
	}
	doc, err := xhtml.Parse(bytes.NewReader(rawHTML))
	if err != nil {
		return nil, fmt.Errorf("HTML DOM cannot be parsed")
	}
	body := firstElement(doc, "body")
	if body == nil {
		return nil, fmt.Errorf("HTML body is missing")
	}
	root, err := onlyElementChild(body)
	if err != nil || root.Data != "section" {
		return nil, fmt.Errorf("HTML must contain one section root")
	}
	out := make([]FingerprintSection, 0)
	for child := root.FirstChild; child != nil; child = child.NextSibling {
		if isBlankText(child) {
			continue
		}
		if child.Type != xhtml.ElementNode || child.Data != "div" {
			return nil, fmt.Errorf("section root may contain only identified section wrappers")
		}
		id := attr(child, "data-section-id")
		if id == "" {
			return nil, fmt.Errorf("section wrapper missing data-section-id")
		}
		out = append(out, FingerprintSection{
			ID:   id,
			Text: normalizeText(textContent([]*xhtml.Node{child})),
		})
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("HTML contains no section wrappers")
	}
	return out, nil
}
