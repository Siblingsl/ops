// Package wechat wraps the WeChat Official Account APIs available to personal accounts
// (F-002, F-006, F-007, F-013). Publish and mass-send APIs are intentionally absent (H-06).
package wechat

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"time"
)

type Client struct {
	base string
	http *http.Client
}

func New(base string) *Client {
	return &Client{base: base, http: &http.Client{Timeout: 60 * time.Second}}
}

type Error struct {
	Code int    `json:"errcode"`
	Msg  string `json:"errmsg"`
}

func (e *Error) Error() string { return fmt.Sprintf("微信接口错误 %d：%s", e.Code, e.Msg) }

// Readable maps common error codes to plain-language guidance.
func (e *Error) Readable() string {
	switch e.Code {
	case 40164:
		return "服务器 IP 不在公众号白名单中。请到公众号后台「设置与开发 → 基本配置 → IP 白名单」添加服务器出口 IP。"
	case 40001, 42001, 40014:
		return "access_token 无效或已过期，系统会自动重新获取，请重试。"
	case 40125:
		return "AppSecret 不正确，请到平台账号页检查凭证。"
	case 40013:
		return "AppID 不正确，请到平台账号页检查凭证。"
	case 48001:
		return "该公众号没有此接口权限。"
	case 45009:
		return "接口当日调用次数已用完，请明天再试，或先用「复制 HTML」手动粘贴。"
	case 40007:
		return "素材 ID 无效（草稿或封面可能已被删除）。"
	case 45002:
		return "正文内容超出长度限制（需少于 2 万字符、小于 1MB）。"
	case 45003:
		return "标题超出长度限制（不超过 32 字）。"
	case 45004:
		return "摘要超出长度限制（不超过 120 字）。"
	case 40005, 40009, 40113:
		return "图片格式或大小不符合要求。"
	case 53404, 53405, 53406:
		return "商品信息相关错误。"
	default:
		return e.Msg
	}
}

func (e *Error) TokenExpired() bool { return e.Code == 40001 || e.Code == 42001 || e.Code == 40014 }

type envelope struct {
	Error
}

func (c *Client) do(ctx context.Context, req *http.Request, out any) error {
	resp, err := c.http.Do(req.WithContext(ctx))
	if err != nil {
		return fmt.Errorf("无法连接微信接口：%w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	if err != nil {
		return err
	}
	var env envelope
	_ = json.Unmarshal(body, &env)
	if env.Code != 0 {
		return &env.Error
	}
	if resp.StatusCode >= 400 {
		return fmt.Errorf("微信接口返回 HTTP %d", resp.StatusCode)
	}
	if out != nil {
		return json.Unmarshal(body, out)
	}
	return nil
}

type Token struct {
	AccessToken string `json:"access_token"`
	ExpiresIn   int    `json:"expires_in"`
}

func (c *Client) GetToken(ctx context.Context, appID, secret string) (*Token, error) {
	q := url.Values{"grant_type": {"client_credential"}, "appid": {appID}, "secret": {secret}}
	req, _ := http.NewRequest(http.MethodGet, c.base+"/cgi-bin/token?"+q.Encode(), nil)
	var t Token
	if err := c.do(ctx, req, &t); err != nil {
		return nil, err
	}
	return &t, nil
}

func (c *Client) upload(ctx context.Context, endpoint, filename string, data []byte, out any) error {
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, err := mw.CreateFormFile("media", filename)
	if err != nil {
		return err
	}
	if _, err := fw.Write(data); err != nil {
		return err
	}
	if err := mw.Close(); err != nil {
		return err
	}
	req, _ := http.NewRequest(http.MethodPost, c.base+endpoint, &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	return c.do(ctx, req, out)
}

// UploadImg uploads an in-article image (≤1MB jpg/png) and returns its URL (F-007).
func (c *Client) UploadImg(ctx context.Context, token, filename string, data []byte) (string, error) {
	var out struct {
		URL string `json:"url"`
	}
	if err := c.upload(ctx, "/cgi-bin/media/uploadimg?access_token="+url.QueryEscape(token), filename, data, &out); err != nil {
		return "", err
	}
	return out.URL, nil
}

// AddImageMaterial uploads a permanent image material and returns its media_id.
func (c *Client) AddImageMaterial(ctx context.Context, token, filename string, data []byte) (string, string, error) {
	var out struct {
		MediaID string `json:"media_id"`
		URL     string `json:"url"`
	}
	if err := c.upload(ctx, "/cgi-bin/material/add_material?type=image&access_token="+url.QueryEscape(token), filename, data, &out); err != nil {
		return "", "", err
	}
	return out.MediaID, out.URL, nil
}

type Crop struct {
	Ratio string `json:"ratio"`
	X1    string `json:"x1"`
	Y1    string `json:"y1"`
	X2    string `json:"x2"`
	Y2    string `json:"y2"`
}

type Article struct {
	ArticleType        string `json:"article_type,omitempty"`
	Title              string `json:"title"`
	Author             string `json:"author,omitempty"`
	Digest             string `json:"digest,omitempty"`
	Content            string `json:"content"`
	ContentSourceURL   string `json:"content_source_url,omitempty"`
	ThumbMediaID       string `json:"thumb_media_id,omitempty"`
	NeedOpenComment    int    `json:"need_open_comment"`
	OnlyFansCanComment int    `json:"only_fans_can_comment"`
	CoverInfo          *struct {
		CropPercentList []Crop `json:"crop_percent_list"`
	} `json:"cover_info,omitempty"`
}

func (c *Client) postJSON(ctx context.Context, endpoint, token string, in, out any) error {
	b, err := json.Marshal(in)
	if err != nil {
		return err
	}
	req, _ := http.NewRequest(http.MethodPost, c.base+endpoint+"?access_token="+url.QueryEscape(token), bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	return c.do(ctx, req, out)
}

func (c *Client) DraftAdd(ctx context.Context, token string, a Article) (string, error) {
	var out struct {
		MediaID string `json:"media_id"`
	}
	if err := c.postJSON(ctx, "/cgi-bin/draft/add", token, map[string]any{"articles": []Article{a}}, &out); err != nil {
		return "", err
	}
	return out.MediaID, nil
}

func (c *Client) DraftUpdate(ctx context.Context, token, mediaID string, a Article) error {
	return c.postJSON(ctx, "/cgi-bin/draft/update", token, map[string]any{"media_id": mediaID, "index": 0, "articles": a}, nil)
}

type DraftItem struct {
	Title   string `json:"title"`
	Content string `json:"content"`
}

func (c *Client) DraftGet(ctx context.Context, token, mediaID string) (*DraftItem, error) {
	var out struct {
		NewsItem []DraftItem `json:"news_item"`
	}
	if err := c.postJSON(ctx, "/cgi-bin/draft/get", token, map[string]any{"media_id": mediaID}, &out); err != nil {
		return nil, err
	}
	if len(out.NewsItem) == 0 {
		return nil, &Error{Code: 40007, Msg: "draft empty"}
	}
	return &out.NewsItem[0], nil
}
