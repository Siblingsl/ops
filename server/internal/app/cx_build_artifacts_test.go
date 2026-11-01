package app

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"testing"
	"time"
)

func TestCX04LongImageRendererReceiptBindsSnapshotAndSegments(t *testing.T) {
	capturedAt := time.Date(2026, 10, 31, 2, 0, 0, 0, time.UTC)
	valid := &cxBuildLongImageReceipt{
		SourceHash:    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		CaptureEngine: "chromium-cdp", CaptureEngineVersion: "140.0.0.0", HeightCSS: 8_001, DPR: 2, Segments: 3,
		ViewportWidth: 390, ViewportHeight: 844,
		CheckScope: "font_ready,image_decode,layout_stable_2_frames,segment_png_decode,final_png_dimensions,non_uniform_pixels",
		CapturedAt: capturedAt, FontFamily: "Arial, sans-serif",
	}
	if !cxValidBuildLongImageReceipt(valid, valid.SourceHash) {
		t.Fatal("valid long-image receipt was rejected")
	}

	badSource := *valid
	badSource.SourceHash = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
	badSegments := *valid
	badSegments.Segments = 1
	badDPR := *valid
	badDPR.DPR = 1
	badViewport := *valid
	badViewport.ViewportWidth = 1440
	badTime := *valid
	badTime.CapturedAt = time.Time{}
	for name, value := range map[string]*cxBuildLongImageReceipt{
		"source": &badSource, "segments": &badSegments, "dpr": &badDPR, "viewport": &badViewport, "time": &badTime,
	} {
		t.Run(name, func(t *testing.T) {
			if cxValidBuildLongImageReceipt(value, valid.SourceHash) {
				t.Fatalf("invalid %s receipt was accepted", name)
			}
		})
	}
}

func encodeBuildPNG(t *testing.T, fill color.RGBA, mark bool) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 780, 2))
	for y := 0; y < 2; y++ {
		for x := 0; x < 780; x++ {
			img.SetRGBA(x, y, fill)
		}
	}
	if mark {
		img.SetRGBA(390, 1, color.RGBA{R: 0, G: 0, B: 0, A: 255})
	}
	var output bytes.Buffer
	if err := png.Encode(&output, img); err != nil {
		t.Fatal(err)
	}
	return output.Bytes()
}

func TestCX04LongImagePNGDecodeRejectsEmptyAndPreservesAlpha(t *testing.T) {
	solid := encodeBuildPNG(t, color.RGBA{R: 255, G: 255, B: 255, A: 255}, false)
	if _, _, _, err := cxInspectBuildArtifact("png", "long.png", solid); err == nil {
		t.Fatal("solid-color PNG with no visible content was accepted")
	}
	text := encodeBuildPNG(t, color.RGBA{R: 255, G: 255, B: 255, A: 255}, true)
	if mime, width, height, err := cxInspectBuildArtifact("png", "long.png", text); err != nil || mime != "image/png" || width != 780 || height != 2 {
		t.Fatalf("valid 780px PNG failed decode checks: mime=%q width=%d height=%d err=%v", mime, width, height, err)
	}
	transparent := encodeBuildPNG(t, color.RGBA{}, true)
	if _, _, _, err := cxInspectBuildArtifact("png", "long.png", transparent); err != nil {
		t.Fatalf("transparent PNG with visible content should be preserved: %v", err)
	}
	corrupt := append([]byte(nil), text...)
	corrupt[len(corrupt)-1] ^= 0xff
	if _, _, _, err := cxInspectBuildArtifact("png", "long.png", corrupt); err == nil {
		t.Fatal("PNG with corrupt compressed data or CRC was accepted")
	}
}
