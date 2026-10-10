package app

import (
	"bytes"
	"image"
	"image/jpeg"
	"strings"
	"testing"
)

func TestProcessImage(t *testing.T) {
	heic := append([]byte{0, 0, 0, 24}, []byte("ftypheic0000")...)
	if _, _, _, _, err := processImage(heic); err == nil || !strings.Contains(err.Error(), "HEIC") {
		t.Fatalf("HEIC should be rejected with a readable message, got %v", err)
	}
	big := testPNG(3200, 1800)
	data, mime, w, h, err := processImage(big)
	if err != nil {
		t.Fatal(err)
	}
	if mime != "image/jpeg" || w != 2560 || h != 1440 || len(data) > maxStoredBytes {
		t.Fatalf("got %s %dx%d %d bytes", mime, w, h, len(data))
	}
	if _, err := jpeg.Decode(bytes.NewReader(data)); err != nil {
		t.Fatal(err)
	}
	if _, _, _, _, err := processImage([]byte("not an image")); err == nil {
		t.Fatal("garbage accepted")
	}
	_ = image.Rect
}

func TestSentenceAround(t *testing.T) {
	text := "第一句话。这里有稳赚的说法！最后一句"
	i := strings.Index(text, "稳赚")
	if got := sentenceAround(text, i, len("稳赚")); got != "这里有稳赚的说法！" {
		t.Fatalf("got %q", got)
	}
	if fingerprint("sensitive", "稳赚", "a") == fingerprint("sensitive", "稳赚", "b") {
		t.Fatal("fingerprint ignores sentence")
	}
}

func TestDeriveAllowed(t *testing.T) {
	wx := &Account{Platform: "wechat_mp", ContentFormat: "long_article"}
	xhs := &Account{Platform: "xhs", ContentFormat: "image_note"}
	xhsComic := &Account{Platform: "xhs", ContentFormat: "comic"}
	if deriveAllowed(wx, xhs, "long_article") != nil {
		t.Fatal("long_article -> image_note should be allowed")
	}
	if deriveAllowed(wx, &Account{Platform: "wechat_mp", ContentFormat: "long_article"}, "long_article") == nil {
		t.Fatal("same platform allowed")
	}
	if deriveAllowed(wx, xhsComic, "long_article") == nil {
		t.Fatal("text -> comic allowed")
	}
	wxComic := &Account{Platform: "wechat_mp", ContentFormat: "comic"}
	if deriveAllowed(wxComic, xhsComic, "comic") != nil {
		t.Fatal("comic -> comic cross-platform should be allowed")
	}
	// D-048 第 5.9 节：新类型没有已实现的转换路径，源或目标是新类型一律拒绝。
	for _, f := range []string{"qa_article", "briefing", "list_note", "card_post", "script"} {
		if deriveAllowed(wx, xhs, f) == nil {
			t.Fatalf("new source format %s should not be derivable", f)
		}
		dst := &Account{Platform: "xhs", ContentFormat: f}
		if deriveAllowed(wx, dst, "long_article") == nil {
			t.Fatalf("new target format %s should not be derivable", f)
		}
	}
}

func TestAssetIDFromURL(t *testing.T) {
	id, ok := assetIDFromURL("/api/v1/assets/0b7c6f0e-3a51-4c35-9f0e-1f2a3b4c5d6e/file")
	if !ok || id.String() != "0b7c6f0e-3a51-4c35-9f0e-1f2a3b4c5d6e" {
		t.Fatal("asset url not parsed")
	}
	if _, ok := assetIDFromURL("https://example.com/a.png"); ok {
		t.Fatal("external url parsed as asset")
	}
}

func TestHTMLPolicyStripsScripts(t *testing.T) {
	out := htmlPolicy.Sanitize(`<section style="color:red"><script>alert(1)</script><img src="/api/v1/assets/x/file" onerror="x"><p onclick="y">hi</p></section>`)
	if strings.Contains(out, "script") || strings.Contains(out, "onerror") || strings.Contains(out, "onclick") || !strings.Contains(out, "color: red") && !strings.Contains(out, "color:red") {
		t.Fatalf("sanitized: %s", out)
	}
}
