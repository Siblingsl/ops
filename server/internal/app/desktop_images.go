package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"strings"

	"ops/internal/ai"
)

func fetchDesktopGeneratedImage(ctx context.Context, client *http.Client, imageURL string) (ai.ImageResult, error) {
	parsed, err := url.Parse(imageURL)
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.Fragment != "" || len(imageURL) > 4096 {
		return ai.ImageResult{}, fmt.Errorf("文生图返回了无效图片地址")
	}
	if parsed.Scheme != "https" {
		ip := net.ParseIP(parsed.Hostname())
		if parsed.Scheme != "http" || (ip == nil || !ip.IsLoopback()) && !strings.EqualFold(parsed.Hostname(), "localhost") {
			return ai.ImageResult{}, fmt.Errorf("桌面图片地址必须使用 HTTPS 或本机回环地址")
		}
	}
	body, err := json.Marshal(struct {
		URL string `json:"url"`
	}{URL: imageURL})
	if err != nil {
		return ai.ImageResult{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "ops-desktop://local/generated_image_fetch", bytes.NewReader(body))
	if err != nil {
		return ai.ImageResult{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return ai.ImageResult{}, fmt.Errorf("桌面图片下载失败：%w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return ai.ImageResult{}, fmt.Errorf("桌面图片下载返回 HTTP %d", resp.StatusCode)
	}
	declared, _, err := mime.ParseMediaType(resp.Header.Get("Content-Type"))
	if err != nil || !strings.HasPrefix(strings.ToLower(declared), "image/") {
		return ai.ImageResult{}, fmt.Errorf("桌面图片下载返回了非图片类型")
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, (12<<20)+1))
	if err != nil {
		return ai.ImageResult{}, fmt.Errorf("读取桌面图片失败：%w", err)
	}
	if len(raw) == 0 || len(raw) > 12<<20 {
		return ai.ImageResult{}, fmt.Errorf("桌面图片超过大小限制或为空")
	}
	config, _, err := image.DecodeConfig(bytes.NewReader(raw))
	if err != nil || config.Width <= 0 || config.Height <= 0 || int64(config.Width)*int64(config.Height) > maxImagePixels {
		return ai.ImageResult{}, fmt.Errorf("桌面图片格式或尺寸不符合限制")
	}
	mimeType := http.DetectContentType(raw)
	if !strings.HasPrefix(mimeType, "image/") {
		return ai.ImageResult{}, fmt.Errorf("桌面图片数据格式无效")
	}
	return ai.ImageResult{Bytes: raw, MIME: mimeType}, nil
}
