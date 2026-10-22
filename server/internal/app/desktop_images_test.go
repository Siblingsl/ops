package app

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"io"
	"net/http"
	"strings"
	"testing"
)

type desktopImageRoundTripper func(*http.Request) (*http.Response, error)

func (f desktopImageRoundTripper) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestFetchDesktopGeneratedImageUsesParentBoundOperationWithoutCredentials(t *testing.T) {
	var pngBytes bytes.Buffer
	img := image.NewRGBA(image.Rect(0, 0, 2, 2))
	img.Set(0, 0, color.RGBA{R: 255, A: 255})
	if err := png.Encode(&pngBytes, img); err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Transport: desktopImageRoundTripper(func(r *http.Request) (*http.Response, error) {
		if r.Method != http.MethodPost || r.URL.Scheme != "ops-desktop" || r.URL.Host != "local" || r.URL.Path != "/generated_image_fetch" {
			t.Fatalf("unexpected generated-image request: %s %s", r.Method, r.URL)
		}
		if r.Header.Get("Authorization") != "" {
			t.Fatal("generated-image URL download must not include model credentials")
		}
		var body struct {
			URL string `json:"url"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.URL != "https://cdn.example.test/image.png?signature=one-time" {
			t.Fatalf("fetch body must carry exact URL metadata, body=%+v err=%v", body, err)
		}
		return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": []string{"image/png"}}, Body: io.NopCloser(bytes.NewReader(pngBytes.Bytes())), Request: r}, nil
	})}
	got, err := fetchDesktopGeneratedImage(context.Background(), client, "https://cdn.example.test/image.png?signature=one-time")
	if err != nil {
		t.Fatalf("fetch valid image failed: %v", err)
	}
	if len(got.Bytes) == 0 || got.MIME != "image/png" {
		t.Fatalf("expected PNG result, got %s/%d bytes", got.MIME, len(got.Bytes))
	}
}

func TestFetchDesktopGeneratedImageRejectsUnapprovedHTTPURLBeforeDispatch(t *testing.T) {
	var dispatched bool
	client := &http.Client{Transport: desktopImageRoundTripper(func(r *http.Request) (*http.Response, error) {
		dispatched = true
		return nil, nil
	})}
	_, err := fetchDesktopGeneratedImage(context.Background(), client, "http://192.168.1.2/image.png")
	if err == nil || !strings.Contains(err.Error(), "HTTPS 或本机回环") {
		t.Fatalf("non-loopback HTTP image URL should be rejected, got %v", err)
	}
	if dispatched {
		t.Fatal("invalid URL must be rejected before transport dispatch")
	}
}
