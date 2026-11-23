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

// New 构造公众号出站客户端。Transport 显式 Proxy: nil（NFR-02 固定出口 IP 依赖直连，
// 出站 IP 必须与 OPS_PUBLIC_IP / 公众号 IP 白名单一致；继承 HTTP(S)_PROXY 会让出口
// 静默漂移到代理地址，见 docs/41 Q-24。与 crawl.Client 的既有约定对齐）。
func New(base string) *Client {
	return &Client{base: base, http: &http.Client{
		Timeout:   60 * time.Second,
		Transport: &http.Transport{Proxy: nil},
	}}
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

type ImageListItem struct {
	ImageMediaID string `json:"image_media_id"`
}

type ImageInfo struct {
	ImageList []ImageListItem `json:"image_list"`
}

type Article struct {
	ArticleType        string     `json:"article_type,omitempty"`
	Title              string     `json:"title"`
	Author             string     `json:"author,omitempty"`
	Digest             string     `json:"digest,omitempty"`
	Content            string     `json:"content"`
	ContentSourceURL   string     `json:"content_source_url,omitempty"`
	ThumbMediaID       string     `json:"thumb_media_id,omitempty"`
	NeedOpenComment    int        `json:"need_open_comment"`
	OnlyFansCanComment int        `json:"only_fans_can_comment"`
	ImageInfo          *ImageInfo `json:"image_info,omitempty"`
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

// DraftSummary 是 draft/batchget 的一条草稿摘要（Q-26，docs/41）。
type DraftSummary struct {
	MediaID    string `json:"media_id"`
	UpdateTime int64  `json:"update_time"`
	Title      string `json:"title"`
}

// DraftBatchGet 分页列出草稿（Q-26）。offset 从 0 开始，官方单页上限 20；
// noContent=1 时不返回正文，只回 media_id/update_time/标题，适合“草稿是否仍在”的状态巡检。
func (c *Client) DraftBatchGet(ctx context.Context, token string, offset, count int, noContent bool) (int, []DraftSummary, error) {
	if offset < 0 {
		offset = 0
	}
	if count <= 0 {
		count = 1
	}
	if count > 20 {
		count = 20
	}
	body := map[string]any{"offset": offset, "count": count, "no_content": 0}
	if noContent {
		body["no_content"] = 1
	}
	var out struct {
		TotalCount int `json:"total_count"`
		Item       []struct {
			MediaID    string `json:"media_id"`
			UpdateTime int64  `json:"update_time"`
			Content    struct {
				NewsItem []DraftItem `json:"news_item"`
			} `json:"content"`
		} `json:"item"`
	}
	if err := c.postJSON(ctx, "/cgi-bin/draft/batchget", token, body, &out); err != nil {
		return 0, nil, err
	}
	items := make([]DraftSummary, 0, len(out.Item))
	for _, item := range out.Item {
		title := ""
		if len(item.Content.NewsItem) > 0 {
			title = item.Content.NewsItem[0].Title
		}
		items = append(items, DraftSummary{MediaID: item.MediaID, UpdateTime: item.UpdateTime, Title: title})
	}
	return out.TotalCount, items, nil
}

// DraftCount 返回公众号草稿箱总数（Q-26）。
func (c *Client) DraftCount(ctx context.Context, token string) (int, error) {
	var out struct {
		TotalCount int `json:"total_count"`
	}
	if err := c.postJSON(ctx, "/cgi-bin/draft/count", token, map[string]any{}, &out); err != nil {
		return 0, err
	}
	return out.TotalCount, nil
}

// DraftDelete 删除一条草稿（Q-26）。产品路由未接入；仅按用户逐张确认后的调用方使用，
// 不得用于批量清理（红线：逐张执行）。
func (c *Client) DraftDelete(ctx context.Context, token, mediaID string) error {
	return c.postJSON(ctx, "/cgi-bin/draft/delete", token, map[string]any{"media_id": mediaID}, nil)
}

// ArticleTotalDetail is one day of cumulative stats for an article (datacube/getarticletotal).
type ArticleTotalDetail struct {
	StatDate         string `json:"stat_date"`
	TargetUser       int    `json:"target_user"`
	IntPageReadUser  int    `json:"int_page_read_user"`
	IntPageReadCount int    `json:"int_page_read_count"`
	ShareUser        int    `json:"share_user"`
	ShareCount       int    `json:"share_count"`
	AddToFavUser     int    `json:"add_to_fav_user"`
	AddToFavCount    int    `json:"add_to_fav_count"`
}

// ArticleTotal is one article sent on ref_date with up to 7 days of cumulative details.
// MsgID is "{msg_data_id}_{index}" (FR-M11-05；通常需企业认证，F-008、V-020).
type ArticleTotal struct {
	RefDate string               `json:"ref_date"`
	MsgID   string               `json:"msgid"`
	Title   string               `json:"title"`
	Details []ArticleTotalDetail `json:"details"`
}

// DatacubeArticleTotal pulls articles sent on one day (the API allows a 1-day span).
func (c *Client) DatacubeArticleTotal(ctx context.Context, token, day string) ([]ArticleTotal, error) {
	var out struct {
		List []ArticleTotal `json:"list"`
	}
	if err := c.postJSON(ctx, "/datacube/getarticletotal", token, map[string]string{
		"begin_date": day, "end_date": day,
	}, &out); err != nil {
		return nil, err
	}
	return out.List, nil
}

// UserSummary is one day × one follow source of datacube/getusersummary; a day may have several rows.
type UserSummary struct {
	RefDate    string `json:"ref_date"`
	UserSource int    `json:"user_source"`
	NewUser    int    `json:"new_user"`
	CancelUser int    `json:"cancel_user"`
}

// UserCumulate is the follower total at the end of ref_date (datacube/getusercumulate).
type UserCumulate struct {
	RefDate      string `json:"ref_date"`
	CumulateUser int    `json:"cumulate_user"`
}

// DatacubeUserSummary pulls daily follows and unfollows (span at most 7 days, DEV-DR09).
func (c *Client) DatacubeUserSummary(ctx context.Context, token, begin, end string) ([]UserSummary, error) {
	var out struct {
		List []UserSummary `json:"list"`
	}
	if err := c.postJSON(ctx, "/datacube/getusersummary", token, map[string]string{"begin_date": begin, "end_date": end}, &out); err != nil {
		return nil, err
	}
	return out.List, nil
}

// DatacubeUserCumulate pulls the daily follower totals (span at most 7 days, DEV-DR09).
func (c *Client) DatacubeUserCumulate(ctx context.Context, token, begin, end string) ([]UserCumulate, error) {
	var out struct {
		List []UserCumulate `json:"list"`
	}
	if err := c.postJSON(ctx, "/datacube/getusercumulate", token, map[string]string{"begin_date": begin, "end_date": end}, &out); err != nil {
		return nil, err
	}
	return out.List, nil
}
