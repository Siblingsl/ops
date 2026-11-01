package cxrendercontract

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestRegistryMatchesSharedRendererThemeFixture(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "testdata", "cx02-render-contract.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		RendererContractVersion string `json:"renderer_contract_version"`
		Themes                  []struct {
			ID          string `json:"id"`
			Version     int    `json:"version"`
			TokenDigest string `json:"token_digest"`
		} `json:"themes"`
	}
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.RendererContractVersion != WechatHTMLV1 || !SupportsWechatHTML(fixture.RendererContractVersion) {
		t.Fatalf("renderer contract %q is not registered", fixture.RendererContractVersion)
	}
	if SupportsWechatHTML("unknown") {
		t.Fatal("unknown renderer contract must not be accepted")
	}
	seen := make(map[string]bool, len(fixture.Themes))
	for _, want := range fixture.Themes {
		got, ok := BuiltinTheme(want.ID)
		if !ok || got.Version != want.Version || got.TokenDigest != want.TokenDigest {
			t.Errorf("theme %s resource=(%+v,%v), want (%d,%s)", want.ID, got, ok, want.Version, want.TokenDigest)
		}
		seen[want.ID] = true
	}
	if len(seen) != len(builtinThemes) {
		t.Fatalf("fixture lists %d themes but server registers %d", len(seen), len(builtinThemes))
	}
	if _, ok := BuiltinTheme("custom"); ok {
		t.Fatal("account custom themes are snapshots of inputs, not built-in resources")
	}
}
