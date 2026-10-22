package ai

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestGenerateImageUsesConstrainedURLFetcher(t *testing.T) {
	imageURL := "https://cdn.example.test/generated.png?signature=token"
	model := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/images/generations" {
			t.Fatalf("unexpected request path: %s", r.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []any{map[string]string{"url": imageURL}}})
	}))
	defer model.Close()
	var fetched string
	result, err := GenerateImage(context.Background(), model.Client(), ImageRequest{
		BaseURL: model.URL + "/v1", Model: "test", Prompt: "draw", FetchURL: func(_ context.Context, got string) (ImageResult, error) {
			fetched = got
			return ImageResult{Bytes: []byte("checked image"), MIME: "image/png"}, nil
		},
	})
	if err != nil {
		t.Fatalf("custom image fetch should complete: %v", err)
	}
	if fetched != imageURL || string(result.Bytes) != "checked image" {
		t.Fatalf("custom fetch did not receive the original URL/result: %q %+v", fetched, result)
	}
}

func TestGenerateImageURLDownloadRejectsRedirect(t *testing.T) {
	var destinationCalls int
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		destinationCalls++
	}))
	defer destination.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, destination.URL, http.StatusFound)
	}))
	defer redirect.Close()
	model := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []any{map[string]string{"url": redirect.URL}}})
	}))
	defer model.Close()

	_, err := GenerateImage(context.Background(), model.Client(), ImageRequest{
		BaseURL: model.URL, Model: "test", Prompt: "draw",
	})
	if err == nil || !strings.Contains(err.Error(), "HTTP 302") {
		t.Fatalf("redirect should return an explicit error, got %v", err)
	}
	if destinationCalls != 0 {
		t.Fatalf("redirect destination must not be requested, calls=%d", destinationCalls)
	}
}
