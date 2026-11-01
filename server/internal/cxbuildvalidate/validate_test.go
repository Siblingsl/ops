package cxbuildvalidate

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"testing"
)

func TestValidateWechatHTMLChecksSectionTextAndImageOccurrenceOrder(t *testing.T) {
	assetBytes := []byte("fake-png-bytes")
	digest := sha256.Sum256(assetBytes)
	assetID := "4f9c5897-1bf9-4812-981f-4d675ef4ad61"
	assets := map[string]Asset{
		assetID: {ID: assetID, SHA256: hex.EncodeToString(digest[:]), MIME: "image/png", Width: 2, Height: 2, Bytes: int64(len(assetBytes)), Data: assetBytes, AltText: "示例图"},
	}
	sections := []Section{
		{ID: "b78bf6bc-24a5-4ec9-a38f-3c833851bc30", Heading: "第一段", ContentMD: "正文![示例](/api/v1/assets/" + assetID + "/file)"},
		{ID: "dfad2f35-8b1c-41a1-8d20-78e8f9ebd501", Heading: "第二段", ContentMD: "再次![示例](/api/v1/assets/" + assetID + "/file)"},
	}
	html := fmt.Sprintf(`<section style="font-size:16px;color:#333;line-height:1.8"><div data-section-id="%s"><h2>第一段</h2><p>正文<img src="/api/v1/assets/%s/file" alt="示例图" data-asset="%s"></p></div><div data-section-id="%s"><h2>第二段</h2><p>再次<img src="/api/v1/assets/%s/file" alt="示例图" data-asset="%s"></p></div></section>`, sections[0].ID, assetID, assetID, sections[1].ID, assetID, assetID)
	report, err := ValidateWechatHTML([]byte(html), sections, assets, false)
	if err != nil {
		t.Fatalf("valid HTML rejected: %v", err)
	}
	if len(report.ImageEvidence) != 2 || report.ImageEvidence[0].Index != 1 || report.ImageEvidence[1].Index != 2 {
		t.Fatalf("image occurrences were not preserved: %+v", report.ImageEvidence)
	}
}

func TestValidateWechatHTMLRejectsSameCountImageSwapAndExternalResource(t *testing.T) {
	assetA := []byte("asset-a")
	assetB := []byte("asset-b")
	assets := map[string]Asset{}
	for _, item := range []struct {
		id   string
		data []byte
	}{
		{"4f9c5897-1bf9-4812-981f-4d675ef4ad61", assetA},
		{"e40166d6-291f-43ef-8f0d-d3e1898a1467", assetB},
	} {
		digest := sha256.Sum256(item.data)
		assets[item.id] = Asset{ID: item.id, SHA256: hex.EncodeToString(digest[:]), MIME: "image/png", Width: 2, Height: 2, Bytes: int64(len(item.data)), Data: item.data}
	}
	section := Section{ID: "b78bf6bc-24a5-4ec9-a38f-3c833851bc30", ContentMD: "![A](/api/v1/assets/4f9c5897-1bf9-4812-981f-4d675ef4ad61/file) ![B](/api/v1/assets/e40166d6-291f-43ef-8f0d-d3e1898a1467/file)"}
	swapped := []byte(`<section><div data-section-id="b78bf6bc-24a5-4ec9-a38f-3c833851bc30"><p><img src="/api/v1/assets/e40166d6-291f-43ef-8f0d-d3e1898a1467/file"><img src="/api/v1/assets/4f9c5897-1bf9-4812-981f-4d675ef4ad61/file"></p></div></section>`)
	if _, err := ValidateWechatHTML(swapped, []Section{section}, assets, false); err == nil {
		t.Fatal("same-count image swap was accepted")
	}
	external := []byte(`<section><div data-section-id="b78bf6bc-24a5-4ec9-a38f-3c833851bc30"><p><img src="https://attacker.example/a.png"></p></div></section>`)
	if _, err := ValidateWechatHTML(external, []Section{section}, assets, false); err == nil {
		t.Fatal("external image resource was accepted")
	}
}

func TestValidateWechatHTMLRejectsDOMAndCSSResourceEscape(t *testing.T) {
	section := Section{ID: "b78bf6bc-24a5-4ec9-a38f-3c833851bc30", ContentMD: "安全正文"}
	for _, document := range []string{
		`<!doctype html><html><head><link rel="stylesheet" href="https://attacker.example/x"></head><body><section><div data-section-id="b78bf6bc-24a5-4ec9-a38f-3c833851bc30">安全正文</div></section></body></html>`,
		`<section><div data-section-id="b78bf6bc-24a5-4ec9-a38f-3c833851bc30"><script>alert(1)</script>安全正文</div></section>`,
		`<section><div data-section-id="b78bf6bc-24a5-4ec9-a38f-3c833851bc30" onclick="alert(1)">安全正文</div></section>`,
		`<section><div data-section-id="b78bf6bc-24a5-4ec9-a38f-3c833851bc30"><div data-section-id="b78bf6bc-24a5-4ec9-a38f-3c833851bc30">安全正文</div></div></section>`,
		`<section style="background:url(https://attacker.example/x)"><div data-section-id="b78bf6bc-24a5-4ec9-a38f-3c833851bc30">安全正文</div></section>`,
		`<section><div data-section-id="b78bf6bc-24a5-4ec9-a38f-3c833851bc30"><link rel="stylesheet" href="https://attacker.example/x">安全正文</div></section>`,
	} {
		if _, err := ValidateWechatHTML([]byte(document), []Section{section}, nil, false); err == nil {
			t.Fatalf("unsafe HTML was accepted: %s", document)
		}
	}
}

func TestValidateWechatHTMLMatchesMarkdownTextAndAllowsNavigationLinks(t *testing.T) {
	section := Section{ID: "b78bf6bc-24a5-4ec9-a38f-3c833851bc30", Heading: "标题", ContentMD: "- [x] 完成\n- [ ] 待办\n\n链接 [阅读](https://example.com/article)。"}
	valid := []byte(`<section><div data-section-id="b78bf6bc-24a5-4ec9-a38f-3c833851bc30"><h2>标题</h2><ul><li><p>☑ 完成</p></li><li><p>☐ 待办</p></li></ul><p>链接 <a href="https://example.com/article">阅读</a>。</p></div></section>`)
	if _, err := ValidateWechatHTML(valid, []Section{section}, nil, false); err != nil {
		t.Fatalf("valid markdown rendering rejected: %v", err)
	}
	changed := []byte(`<section><div data-section-id="b78bf6bc-24a5-4ec9-a38f-3c833851bc30"><h2>标题</h2><ul><li><p>☑ 完成</p></li><li><p>☐ 待办</p></li></ul><p>链接 <a href="https://example.com/article">替换正文</a>。</p></div></section>`)
	if _, err := ValidateWechatHTML(changed, []Section{section}, nil, false); err == nil {
		t.Fatal("changed section text was accepted")
	}
}

func TestValidateWechatHTMLAllowsSafeThemeBorderBottom(t *testing.T) {
	section := Section{ID: "b78bf6bc-24a5-4ec9-a38f-3c833851bc30", Heading: "标题", ContentMD: "正文"}
	document := []byte(`<section><div data-section-id="b78bf6bc-24a5-4ec9-a38f-3c833851bc30"><h2 style="border-bottom:2px solid #2F5D62">标题</h2><p>正文</p></div></section>`)
	if _, err := ValidateWechatHTML(document, []Section{section}, nil, false); err != nil {
		t.Fatalf("safe built-in theme border style rejected: %v", err)
	}
}

func TestValidateStableHTMLRequiresExactFrozenImageBytes(t *testing.T) {
	assetID := "4f9c5897-1bf9-4812-981f-4d675ef4ad61"
	assetBytes := []byte("image bytes")
	digest := sha256.Sum256(assetBytes)
	asset := Asset{ID: assetID, SHA256: hex.EncodeToString(digest[:]), MIME: "image/png", Width: 2, Height: 2, Bytes: int64(len(assetBytes)), Data: assetBytes}
	section := Section{ID: "b78bf6bc-24a5-4ec9-a38f-3c833851bc30", ContentMD: "![示例](/api/v1/assets/" + assetID + "/file)"}
	wrong := []byte(`<section><div data-section-id="b78bf6bc-24a5-4ec9-a38f-3c833851bc30"><p><img data-asset="` + assetID + `" src="data:image/png;base64,` + "b3RoZXI=" + `"></p></div></section>`)
	if _, err := ValidateWechatHTML(wrong, []Section{section}, map[string]Asset{assetID: asset}, true); err == nil {
		t.Fatal("stable HTML with different bytes was accepted")
	}
}

func TestValidateStableHTMLAcceptsExactDataURIsAndFrozenImageDecodeChecks(t *testing.T) {
	assetID := "4f9c5897-1bf9-4812-981f-4d675ef4ad61"
	assetBytes := []byte("fixture image payload")
	digest := sha256.Sum256(assetBytes)
	asset := Asset{ID: assetID, SHA256: hex.EncodeToString(digest[:]), MIME: "image/png", Width: 2, Height: 2, Bytes: int64(len(assetBytes)), Data: assetBytes}
	section := Section{ID: "b78bf6bc-24a5-4ec9-a38f-3c833851bc30", ContentMD: "![示例](/api/v1/assets/" + assetID + "/file)"}
	document := fmt.Sprintf(`<html><head><meta charset="utf-8"></head><body><section><div data-section-id="%s"><p><img data-asset="%s" src="data:image/png;base64,%s"></p></div></section></body></html>`, section.ID, assetID, base64.StdEncoding.EncodeToString(assetBytes))
	report, err := ValidateWechatHTML([]byte(document), []Section{section}, map[string]Asset{assetID: asset}, true)
	if err != nil {
		t.Fatalf("exact frozen data URI rejected: %v", err)
	}
	if len(report.ImageEvidence) != 1 || report.ImageEvidence[0].OutputSHA256 != asset.SHA256 {
		t.Fatalf("stable output evidence did not preserve frozen bytes: %+v", report.ImageEvidence)
	}

	var pngBytes bytes.Buffer
	img := image.NewRGBA(image.Rect(0, 0, 2, 2))
	img.Set(0, 0, color.RGBA{R: 20, G: 30, B: 40, A: 255})
	if err := png.Encode(&pngBytes, img); err != nil {
		t.Fatal(err)
	}
	validDigest := sha256.Sum256(pngBytes.Bytes())
	decoded := Asset{ID: assetID, SHA256: hex.EncodeToString(validDigest[:]), MIME: "image/png", Width: 2, Height: 2, Bytes: int64(pngBytes.Len()), Data: pngBytes.Bytes()}
	if err := ValidateFrozenAsset(decoded); err != nil {
		t.Fatalf("valid original PNG failed frozen checks: %v", err)
	}
	decoded.Width = 3
	if err := ValidateFrozenAsset(decoded); err == nil {
		t.Fatal("stored dimensions that disagree with the original PNG were accepted")
	}
}
