package ai

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

type ImageRequest struct {
	BaseURL string
	APIKey  string
	Model   string
	Prompt  string
	Size    string // e.g. 1024x1024
	N       int
}

type ImageResult struct {
	Bytes []byte
	MIME  string
}

// GenerateImage calls OpenAI-compatible /images/generations and returns the first image bytes.
func GenerateImage(ctx context.Context, hc *http.Client, req ImageRequest) (ImageResult, error) {
	if req.N <= 0 {
		req.N = 1
	}
	if req.Size == "" {
		req.Size = "1024x1024"
	}
	body := map[string]any{
		"model":           req.Model,
		"prompt":          req.Prompt,
		"n":               req.N,
		"size":            req.Size,
		"response_format": "b64_json",
	}
	b, _ := json.Marshal(body)
	url := strings.TrimRight(req.BaseURL, "/") + "/images/generations"
	hreq, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(b))
	if err != nil {
		return ImageResult{}, err
	}
	hreq.Header.Set("Content-Type", "application/json")
	hreq.Header.Set("Authorization", "Bearer "+req.APIKey)
	resp, err := hc.Do(hreq)
	if err != nil {
		return ImageResult{}, fmt.Errorf("无法连接文生图服务：%w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 12<<20))
	if resp.StatusCode != 200 {
		return ImageResult{}, &UpstreamError{Status: resp.StatusCode, Body: strings.TrimSpace(string(raw))}
	}
	var out struct {
		Data []struct {
			B64JSON string `json:"b64_json"`
			URL     string `json:"url"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return ImageResult{}, fmt.Errorf("文生图响应无法解析：%w", err)
	}
	if len(out.Data) == 0 {
		return ImageResult{}, fmt.Errorf("文生图未返回图片")
	}
	if out.Data[0].B64JSON != "" {
		bin, err := base64.StdEncoding.DecodeString(out.Data[0].B64JSON)
		if err != nil {
			return ImageResult{}, err
		}
		mime := http.DetectContentType(bin)
		return ImageResult{Bytes: bin, MIME: mime}, nil
	}
	if out.Data[0].URL == "" {
		return ImageResult{}, fmt.Errorf("文生图未返回图片数据")
	}
	ireq, err := http.NewRequestWithContext(ctx, http.MethodGet, out.Data[0].URL, nil)
	if err != nil {
		return ImageResult{}, err
	}
	iresp, err := hc.Do(ireq)
	if err != nil {
		return ImageResult{}, err
	}
	defer iresp.Body.Close()
	bin, err := io.ReadAll(io.LimitReader(iresp.Body, 12<<20))
	if err != nil {
		return ImageResult{}, err
	}
	return ImageResult{Bytes: bin, MIME: http.DetectContentType(bin)}, nil
}
