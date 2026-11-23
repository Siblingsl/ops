package app

// REF41 P8-N3：公众号 API 发布执行器。只调用 DraftAdd/DraftGet，把内容写进
// 公众号草稿箱；不调用群发、发布或 mass-send 接口（H-06/P4-A5）。

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"strings"
	"sync"

	"github.com/google/uuid"
	"github.com/yuin/goldmark"
	"ops/internal/wechat"
)

type wechatDraftState struct {
	mediaID     string
	title       string
	contentHash string
	readbackOK  bool
}

type wechatMPAPIExecutor struct {
	wx *wechat.Client

	mu     sync.Mutex
	drafts map[uuid.UUID]*wechatDraftState
}

func newWechatMPAPIExecutor(wx *wechat.Client) *wechatMPAPIExecutor {
	return &wechatMPAPIExecutor{wx: wx, drafts: make(map[uuid.UUID]*wechatDraftState)}
}

func (e *wechatMPAPIExecutor) Name() string    { return "wechat-mp-api" }
func (e *wechatMPAPIExecutor) Version() string { return "wechat-mp-api-v1" }

func wechatAPIErr(err error) error {
	if err == nil {
		return nil
	}
	var we *wechat.Error
	if errors.As(err, &we) {
		return NewPublishExecutorError(fmt.Sprintf("wechat_%d", we.Code), we.Readable())
	}
	return NewPublishExecutorError("wechat_api_failed", err.Error())
}

func (e *wechatMPAPIExecutor) ensureClient(req PublishFillRequest) error {
	if e == nil || e.wx == nil {
		return NewPublishExecutorError("executor_not_configured", "发布执行器尚未配置")
	}
	if strings.TrimSpace(req.WechatToken) == "" {
		return NewPublishExecutorError("wechat_token_missing", "公众号 access_token 未准备，不能写入草稿箱")
	}
	if len(req.WechatCover) == 0 {
		return NewPublishExecutorError("wechat_cover_missing", "公众号草稿必须有封面图")
	}
	return nil
}

func parseWechatManifest(req PublishFillRequest) (PublishManifestPayload, error) {
	var payload PublishManifestPayload
	if err := json.Unmarshal(req.Manifest, &payload); err != nil {
		return payload, NewPublishExecutorError("manifest_invalid", "发布清单无法解析")
	}
	if payload.Platform != "wechat_mp" {
		return payload, NewPublishExecutorError("manifest_platform_mismatch", "发布清单平台不是公众号")
	}
	if strings.TrimSpace(payload.Fields.Title) == "" {
		return payload, NewPublishExecutorError("manifest_invalid", "公众号草稿缺少标题")
	}
	if strings.TrimSpace(payload.Fields.BodyMD) == "" && strings.TrimSpace(payload.Fields.BodyText) == "" {
		return payload, NewPublishExecutorError("manifest_invalid", "公众号草稿缺少正文")
	}
	return payload, nil
}

func wechatArticleContent(payload PublishManifestPayload) string {
	body := strings.TrimSpace(payload.Fields.BodyMD)
	if body != "" {
		var buf bytes.Buffer
		if err := goldmark.New().Convert([]byte(body), &buf); err == nil {
			if content := strings.TrimSpace(htmlPolicy.Sanitize(buf.String())); content != "" {
				return content
			}
		}
	}
	text := strings.TrimSpace(payload.Fields.BodyText)
	if text == "" {
		text = strings.TrimSpace(payload.Fields.BodyMD)
	}
	parts := strings.Split(text, "\n")
	paragraphs := make([]string, 0, len(parts))
	for _, line := range parts {
		if line = strings.TrimSpace(line); line != "" {
			paragraphs = append(paragraphs, "<p>"+html.EscapeString(line)+"</p>")
		}
	}
	return strings.Join(paragraphs, "\n")
}

func wechatArticle(payload PublishManifestPayload, thumbMediaID, content string) wechat.Article {
	text := strings.TrimSpace(payload.Fields.BodyText)
	if text == "" {
		text = strings.TrimSpace(payload.Fields.BodyMD)
	}
	runes := []rune(text)
	digest := string(runes)
	if len(runes) > 120 {
		digest = string(runes[:120])
	}
	author, sourceURL := "", ""
	if payload.Fields.PlatformFields != nil {
		if v, ok := payload.Fields.PlatformFields["author"].(string); ok {
			author = strings.TrimSpace(v)
		}
		if v, ok := payload.Fields.PlatformFields["source_url"].(string); ok {
			sourceURL = strings.TrimSpace(v)
		}
	}
	return wechat.Article{
		ArticleType: "news", Title: strings.TrimSpace(payload.Fields.Title), Author: author,
		Digest: digest, Content: content, ContentSourceURL: sourceURL, ThumbMediaID: thumbMediaID,
	}
}

func contentDigest(content string) string {
	sum := sha256.Sum256([]byte(content))
	return hex.EncodeToString(sum[:])
}

func (e *wechatMPAPIExecutor) Preflight(_ context.Context, req PublishFillRequest) (map[string]any, error) {
	if err := e.ensureClient(req); err != nil {
		return nil, err
	}
	payload, err := parseWechatManifest(req)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"mode": "api", "platform": "wechat_mp", "title": payload.Fields.Title,
		"cover_bytes": len(req.WechatCover), "adapter_version": e.Version(),
	}, nil
}

func (e *wechatMPAPIExecutor) Fill(ctx context.Context, req PublishFillRequest) (PublishFillResult, error) {
	if err := e.ensureClient(req); err != nil {
		return PublishFillResult{}, err
	}
	payload, err := parseWechatManifest(req)
	if err != nil {
		return PublishFillResult{}, err
	}
	content := wechatArticleContent(payload)
	if content == "" {
		return PublishFillResult{}, NewPublishExecutorError("manifest_invalid", "公众号正文渲染为空")
	}
	contentHash := contentDigest(content)

	e.mu.Lock()
	state := e.drafts[req.TaskID]
	if state != nil && state.mediaID != "" && state.contentHash == contentHash {
		e.mu.Unlock()
		return PublishFillResult{
			State: "filled",
			Evidence: map[string]any{
				"executor": e.Name(), "adapter_version": e.Version(), "draft_media_id": state.mediaID,
				"idempotent_reuse": true,
			},
		}, nil
	}
	e.mu.Unlock()

	coverName := strings.TrimSpace(req.WechatCoverName)
	if coverName == "" {
		coverName = "cover.png"
	}
	thumbID, _, err := e.wx.AddImageMaterial(ctx, req.WechatToken, coverName, req.WechatCover)
	if err != nil {
		return PublishFillResult{}, wechatAPIErr(err)
	}
	mediaID, err := e.wx.DraftAdd(ctx, req.WechatToken, wechatArticle(payload, thumbID, content))
	if err != nil {
		return PublishFillResult{}, wechatAPIErr(err)
	}
	if strings.TrimSpace(mediaID) == "" {
		return PublishFillResult{}, NewPublishExecutorError("wechat_draft_empty", "公众号接口未返回草稿编号")
	}

	e.mu.Lock()
	e.drafts[req.TaskID] = &wechatDraftState{
		mediaID: mediaID, title: strings.TrimSpace(payload.Fields.Title), contentHash: contentHash,
	}
	e.mu.Unlock()

	return PublishFillResult{
		State: "filled",
		Evidence: map[string]any{
			"executor": e.Name(), "adapter_version": e.Version(), "draft_media_id": mediaID,
			"thumb_media_id": thumbID, "content_hash": contentHash,
		},
	}, nil
}

func (e *wechatMPAPIExecutor) Readback(ctx context.Context, req PublishFillRequest) (PublishFillResult, error) {
	if e == nil || e.wx == nil {
		return PublishFillResult{}, NewPublishExecutorError("executor_not_configured", "发布执行器尚未配置")
	}
	e.mu.Lock()
	state := e.drafts[req.TaskID]
	if state == nil || state.mediaID == "" {
		e.mu.Unlock()
		return PublishFillResult{
			State: "failed", ErrorCode: "wechat_draft_missing", ErrorMessage: "没有可回读的公众号草稿",
		}, nil
	}
	mediaID, title, contentHash := state.mediaID, state.title, state.contentHash
	e.mu.Unlock()

	item, err := e.wx.DraftGet(ctx, req.WechatToken, mediaID)
	if err != nil {
		return PublishFillResult{}, wechatAPIErr(err)
	}
	titleOK := strings.TrimSpace(item.Title) == title
	contentOK := contentDigest(item.Content) == contentHash
	ok := titleOK && contentOK
	e.mu.Lock()
	if state := e.drafts[req.TaskID]; state != nil {
		state.readbackOK = ok
	}
	e.mu.Unlock()
	return PublishFillResult{
		State: "filled",
		Readback: map[string]any{
			"ok": ok, "media_id": mediaID, "title_match": titleOK, "content_match": contentOK,
			"platform": "wechat_mp",
		},
		Evidence: map[string]any{"executor": e.Name(), "adapter_version": e.Version(), "draft_media_id": mediaID},
	}, nil
}

func (e *wechatMPAPIExecutor) Submit(_ context.Context, req PublishFillRequest) (PublishFillResult, error) {
	e.mu.Lock()
	state := e.drafts[req.TaskID]
	if state == nil || state.mediaID == "" {
		e.mu.Unlock()
		return PublishFillResult{}, NewPublishExecutorError("wechat_draft_missing", "没有可提交的公众号草稿")
	}
	if !state.readbackOK {
		e.mu.Unlock()
		return PublishFillResult{}, NewPublishExecutorError("wechat_readback_missing", "公众号草稿未通过回读，不能登记已提交")
	}
	mediaID := state.mediaID
	e.mu.Unlock()
	return PublishFillResult{
		State: "submitted",
		Evidence: map[string]any{
			"executor": e.Name(), "adapter_version": e.Version(), "draft_media_id": mediaID,
			"publish_mode": "draft", "auto_publish": false, "mass_send": false,
		},
	}, nil
}
