package ai

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"net/http"
	neturl "net/url"
	"strings"

	_ "golang.org/x/image/webp"
)

const (
	maxGeneratedImageBytes    = 12 << 20
	maxGeneratedImageResponse = 18 << 20
	maxGeneratedImagePixels   = 16_000_000
)

type ImageRequest struct {
	BaseURL string
	APIKey  string
	Model   string
	Prompt  string
	Size    string // e.g. 1024x1024
	N       int
	// FetchURL overrides the URL-download path for constrained transports such as desktop AI.
	FetchURL func(context.Context, string) (ImageResult, error)
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
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxGeneratedImageResponse+1))
	if err != nil {
		return ImageResult{}, fmt.Errorf("读取文生图响应失败：%w", err)
	}
	if len(raw) > maxGeneratedImageResponse {
		return ImageResult{}, fmt.Errorf("文生图响应超过大小限制")
	}
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
		if len(out.Data[0].B64JSON) > base64.StdEncoding.EncodedLen(maxGeneratedImageBytes)+4 {
			return ImageResult{}, fmt.Errorf("文生图图片超过大小限制")
		}
		bin, err := base64.StdEncoding.DecodeString(out.Data[0].B64JSON)
		if err != nil {
			return ImageResult{}, err
		}
		if err := validateGeneratedImage(bin); err != nil {
			return ImageResult{}, err
		}
		mime := http.DetectContentType(bin)
		return ImageResult{Bytes: bin, MIME: mime}, nil
	}
	if out.Data[0].URL == "" {
		return ImageResult{}, fmt.Errorf("文生图未返回图片数据")
	}
	if req.FetchURL != nil {
		return req.FetchURL(ctx, out.Data[0].URL)
	}
	parsedURL, err := neturl.ParseRequestURI(out.Data[0].URL)
	if err != nil || (parsedURL.Scheme != "https" && parsedURL.Scheme != "http") || parsedURL.Host == "" || parsedURL.User != nil {
		return ImageResult{}, fmt.Errorf("文生图返回了无效图片地址")
	}
	ireq, err := http.NewRequestWithContext(ctx, http.MethodGet, out.Data[0].URL, nil)
	if err != nil {
		return ImageResult{}, err
	}
	imageClient := *hc
	imageClient.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	iresp, err := imageClient.Do(ireq)
	if err != nil {
		return ImageResult{}, err
	}
	defer iresp.Body.Close()
	if iresp.StatusCode != http.StatusOK {
		return ImageResult{}, fmt.Errorf("图片下载返回 HTTP %d", iresp.StatusCode)
	}
	bin, err := io.ReadAll(io.LimitReader(iresp.Body, maxGeneratedImageBytes+1))
	if err != nil {
		return ImageResult{}, err
	}
	if err := validateGeneratedImage(bin); err != nil {
		return ImageResult{}, err
	}
	mime := http.DetectContentType(bin)
	declaredMIME := strings.ToLower(strings.TrimSpace(strings.SplitN(iresp.Header.Get("Content-Type"), ";", 2)[0]))
	if declaredMIME != "" && declaredMIME != "application/octet-stream" && !strings.HasPrefix(declaredMIME, "image/") {
		return ImageResult{}, fmt.Errorf("图片下载返回了非图片类型")
	}
	if !strings.HasPrefix(mime, "image/") {
		return ImageResult{}, fmt.Errorf("下载内容不是有效图片")
	}
	return ImageResult{Bytes: bin, MIME: mime}, nil
}

func validateGeneratedImage(raw []byte) error {
	if len(raw) == 0 || len(raw) > maxGeneratedImageBytes {
		return fmt.Errorf("文生图图片超过大小限制或为空")
	}
	config, _, err := image.DecodeConfig(bytes.NewReader(raw))
	if err != nil || config.Width <= 0 || config.Height <= 0 || int64(config.Width)*int64(config.Height) > maxGeneratedImagePixels {
		return fmt.Errorf("文生图图片格式或尺寸不符合限制")
	}
	return nil
}
