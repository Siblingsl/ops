package app

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"html/template"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const previewLinkTTL = 24 * time.Hour

var errPreviewExpired = errors.New("preview link expired")

type previewClaims struct {
	WorkspaceID   uuid.UUID `json:"workspace_id"`
	WorkID        uuid.UUID `json:"work_id"`
	ExpiresAt     int64     `json:"expires_at"`
	BasisRevision int       `json:"basis_revision,omitempty"`
}

type previewSection struct {
	Heading   string `json:"heading"`
	ContentMD string `json:"content_md"`
}

type previewAsset struct {
	ID      uuid.UUID `json:"id"`
	AltText string    `json:"alt_text"`
}

// previewImage 是公开预览页的图片引用；JSON 接口沿用 url/alt_text/ai_generated 三字段。
type previewImage struct {
	URL         string `json:"url"`
	AltText     string `json:"alt_text"`
	AIGenerated bool   `json:"ai_generated"`
}

// publicPreviewData 是 JSON 预览接口与 HTML 扫码预览页共用的只读视图。
// 头条分支由 toutiaoPreviewPack 填充；公众号分支由 work/work_section/asset 查询填充。
type publicPreviewData struct {
	Platform      string
	ContentFormat string
	Title         string
	AccountName   string
	Theme         string
	CustomTheme   *CustomTheme
	Sections      []previewSection
	Assets        []previewAsset
	BodyText      string
	ArticleHTML   string
	Topics        []string
	Images        []previewImage
}

func (s *Server) previewSigningKey() []byte {
	mac := hmac.New(sha256.New, s.cfg.MasterKey)
	// BE-02 C 类：hash.Hash.Write 契约永不返回错误（见 hash.Hash 文档）。
	mac.Write([]byte("ops:public-preview:v1"))
	return mac.Sum(nil)
}

func (s *Server) signPreview(claims previewClaims) (string, error) {
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	encoded := base64.RawURLEncoding.EncodeToString(payload)
	mac := hmac.New(sha256.New, s.previewSigningKey())
	// BE-02 C 类：hash.Hash.Write 契约永不返回错误。
	mac.Write([]byte(encoded))
	signature := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return encoded + "." + signature, nil
}

func (s *Server) verifyPreview(token string) (previewClaims, error) {
	var claims previewClaims
	payloadPart, signaturePart, ok := strings.Cut(token, ".")
	if !ok || payloadPart == "" || signaturePart == "" || strings.Contains(signaturePart, ".") {
		return claims, errNotFound
	}
	signature, err := base64.RawURLEncoding.DecodeString(signaturePart)
	if err != nil {
		return claims, errNotFound
	}
	mac := hmac.New(sha256.New, s.previewSigningKey())
	// BE-02 C 类：hash.Hash.Write 契约永不返回错误。
	mac.Write([]byte(payloadPart))
	if !hmac.Equal(signature, mac.Sum(nil)) {
		return claims, errNotFound
	}
	payload, err := base64.RawURLEncoding.DecodeString(payloadPart)
	if err != nil || json.Unmarshal(payload, &claims) != nil || claims.WorkspaceID == uuid.Nil || claims.WorkID == uuid.Nil || claims.ExpiresAt <= 0 {
		return previewClaims{}, errNotFound
	}
	if !s.now().Before(time.Unix(claims.ExpiresAt, 0)) {
		return claims, errPreviewExpired
	}
	return claims, nil
}

func (s *Server) createPreviewLink(w http.ResponseWriter, r *http.Request) error {
	m, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	if m.Account.Platform != "wechat_mp" && m.Account.Platform != "toutiao" {
		return validation("分享预览仅支持公众号和今日头条作品")
	}
	basis := 0
	if m.Account.Platform == "toutiao" {
		var in struct {
			BasisRevision *int `json:"basis_revision"`
		}
		if err := decodeOptional(r, &in); err != nil {
			return err
		}
		if in.BasisRevision == nil || *in.BasisRevision < 1 {
			return validation("必须提供有效的作品修订号 basis_revision")
		}
		basis = *in.BasisRevision
		_, source, err := s.buildToutiaoPack(r.Context(), m.ID, basis, false)
		if err != nil {
			return err
		}
		if err := s.verifyToutiaoPackBasis(r.Context(), m.ID, basis, source.Status); err != nil {
			return err
		}
	}
	expires := s.now().Add(previewLinkTTL).UTC().Truncate(time.Second)
	token, err := s.signPreview(previewClaims{
		WorkspaceID:   ident(r.Context()).WorkspaceID,
		WorkID:        m.ID,
		ExpiresAt:     expires.Unix(),
		BasisRevision: basis,
	})
	if err != nil {
		return err
	}
	return ok(w, map[string]any{"token": token, "expires_at": expires})
}

func (s *Server) publicPreviewClaims(w http.ResponseWriter, r *http.Request) (previewClaims, error) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	claims, err := s.verifyPreview(chi.URLParam(r, "token"))
	if errors.Is(err, errPreviewExpired) {
		return previewClaims{}, apiErr(http.StatusGone, "preview_expired", "此手机预览链接已过期，请重新生成")
	}
	if err != nil {
		return previewClaims{}, errNotFound
	}
	return claims, nil
}

func (s *Server) getPublicPreview(w http.ResponseWriter, r *http.Request) error {
	claims, err := s.publicPreviewClaims(w, r)
	if err != nil {
		return err
	}
	data, err := s.loadPublicPreview(r.Context(), chi.URLParam(r, "token"), claims)
	if err != nil {
		return err
	}
	if data.Platform == "toutiao" {
		images := make([]map[string]any, 0, len(data.Images))
		for _, image := range data.Images {
			images = append(images, map[string]any{"url": image.URL, "alt_text": image.AltText, "ai_generated": image.AIGenerated})
		}
		return ok(w, map[string]any{
			"platform": "toutiao", "content_format": data.ContentFormat, "title": data.Title, "account_name": data.AccountName,
			"body_text": data.BodyText, "article_html": data.ArticleHTML, "topics": data.Topics, "images": images,
		})
	}
	return ok(w, map[string]any{
		"title": data.Title, "account_name": data.AccountName, "theme": data.Theme,
		"custom_theme": data.CustomTheme, "sections": data.Sections, "assets": data.Assets,
	})
}

func (s *Server) getPublicPreviewAsset(w http.ResponseWriter, r *http.Request) error {
	claims, err := s.publicPreviewClaims(w, r)
	if err != nil {
		return err
	}
	assetID, err := uuid.Parse(chi.URLParam(r, "assetId"))
	if err != nil {
		return errNotFound
	}
	var platform string
	if err := s.db.QueryRow(r.Context(), `SELECT a.platform FROM work w JOIN platform_account a ON a.id=w.account_id
		WHERE w.id=$1 AND a.workspace_id=$2 AND w.deleted_at IS NULL`, claims.WorkID, claims.WorkspaceID).Scan(&platform); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return errNotFound
		}
		return err
	}
	if platform == "toutiao" {
		return s.getToutiaoPublicPreviewAsset(w, r, claims, assetID)
	}
	var a assetRow
	err = s.db.QueryRow(r.Context(), `SELECT x.id, x.work_id, x.storage_path, x.mime, x.sha256
		FROM asset x JOIN work w ON w.id=x.work_id JOIN platform_account pa ON pa.id=w.account_id
		WHERE x.id=$1 AND x.work_id=$2 AND pa.workspace_id=$3 AND pa.platform='wechat_mp' AND w.deleted_at IS NULL`,
		assetID, claims.WorkID, claims.WorkspaceID).Scan(&a.ID, &a.WorkID, &a.StoragePath, &a.Mime, &a.SHA256)
	if errors.Is(err, pgx.ErrNoRows) {
		return errNotFound
	}
	if err != nil {
		return err
	}
	var data []byte
	switch r.URL.Query().Get("variant") {
	case "", "original":
		data, err = s.assetBytes(&a)
	case "256":
		data, err = s.assetThumbnail(&a, 256)
	case "512":
		data, err = s.assetThumbnail(&a, 512)
	default:
		return validation("图片缩略图规格无效")
	}
	if err != nil {
		return errNotFound
	}
	w.Header().Set("Content-Type", a.Mime)
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	// BE-02：与 preview_toutiao / artifact 下载同口径——写出失败上抛，不得静默成功。
	_, err = w.Write(data)
	return err
}

// loadPublicPreview 读取公开预览所需的元数据与正文；JSON 接口与 HTML 页面共用同一套查询。
// 头条分支复用 toutiaoPreviewPack 的既有校验与快照，不新增 SQL。
func (s *Server) loadPublicPreview(ctx context.Context, token string, claims previewClaims) (*publicPreviewData, error) {
	var title, accountName, theme, platform string
	var accountID uuid.UUID
	err := s.db.QueryRow(ctx, `SELECT w.title, a.name, w.theme, a.id, a.platform
		FROM work w JOIN platform_account a ON a.id=w.account_id
		WHERE w.id=$1 AND a.workspace_id=$2 AND a.platform IN ('wechat_mp','toutiao') AND w.deleted_at IS NULL`,
		claims.WorkID, claims.WorkspaceID).Scan(&title, &accountName, &theme, &accountID, &platform)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errNotFound
	}
	if err != nil {
		return nil, err
	}
	data := &publicPreviewData{Platform: platform, Title: title, AccountName: accountName, Theme: theme}
	if platform == "toutiao" {
		return s.loadToutiaoPublicPreview(ctx, token, claims, data)
	}
	rows, err := s.db.Query(ctx, `SELECT heading, content_md FROM work_section
		WHERE work_id=$1 AND deleted_at IS NULL ORDER BY position, created_at`, claims.WorkID)
	if err != nil {
		return nil, err
	}
	sections := []previewSection{}
	for rows.Next() {
		var section previewSection
		if err := rows.Scan(&section.Heading, &section.ContentMD); err != nil {
			rows.Close()
			return nil, err
		}
		sections = append(sections, section)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	data.Sections = sections

	assetRows, err := s.db.Query(ctx, `SELECT id, alt_text FROM asset WHERE work_id=$1 ORDER BY position, created_at`, claims.WorkID)
	if err != nil {
		return nil, err
	}
	assets := []previewAsset{}
	for assetRows.Next() {
		var asset previewAsset
		if err := assetRows.Scan(&asset.ID, &asset.AltText); err != nil {
			assetRows.Close()
			return nil, err
		}
		assets = append(assets, asset)
	}
	if err := assetRows.Err(); err != nil {
		assetRows.Close()
		return nil, err
	}
	assetRows.Close()
	data.Assets = assets

	var customTheme *CustomTheme
	var raw []byte
	if err := s.db.QueryRow(ctx, `SELECT custom_theme FROM account_profile WHERE account_id=$1`, accountID).Scan(&raw); err != nil {
		return nil, err
	}
	if len(raw) > 0 {
		var t CustomTheme
		if json.Unmarshal(raw, &t) == nil {
			customTheme = &t
		}
	}
	data.CustomTheme = customTheme
	return data, nil
}

// loadToutiaoPublicPreview 复用头条快照构建：标题以 publish_title 为准，缺失时为空串，
// 与原 JSON 契约保持完全一致；正文与话题直接取快照视图，不向页面注入未清洗 HTML。
func (s *Server) loadToutiaoPublicPreview(ctx context.Context, token string, claims previewClaims, data *publicPreviewData) (*publicPreviewData, error) {
	pack, err := s.toutiaoPreviewPack(ctx, claims)
	if err != nil {
		return nil, err
	}
	data.ContentFormat = pack.View.ContentFormat
	data.Title = ""
	if pack.View.PublishTitle != nil {
		data.Title = *pack.View.PublishTitle
	}
	data.BodyText = pack.View.BodyText
	data.Topics = pack.View.Topics

	images := make([]previewImage, 0, len(pack.View.Images))
	articleHTML := string(pack.Files["article.html"])
	if articleHTML != "" {
		// C-class：strings.Cut 第三返回值是 found bool，不是 error；缺标签时保留原文。
		_, articleHTML, _ = strings.Cut(articleHTML, "<body>")
		articleHTML, _, _ = strings.Cut(articleHTML, "</body>")
	}
	for _, image := range pack.View.Images {
		url := "/api/v1/public-previews/" + token + "/assets/" + image.AssetID.String()
		alt := image.AltText
		if len(image.Uses) > 0 {
			alt = image.Uses[0].Alt
		}
		images = append(images, previewImage{URL: url, AltText: alt, AIGenerated: image.AIGenerated})
		articleHTML = strings.ReplaceAll(articleHTML, `src="`+image.File+`"`, `src="`+url+`"`)
	}
	data.ArticleHTML = articleHTML
	data.Images = images
	return data, nil
}

type previewPageBlock struct {
	IsImage  bool
	Text     string
	ImageURL string
	ImageAlt string
}

type previewPageSection struct {
	Heading string
	Blocks  []previewPageBlock
}

type previewPageView struct {
	IsToutiao   bool
	IsMicroPost bool
	Title       string
	AccountName string
	Sections    []previewPageSection
	Paragraphs  []string
	Topics      []string
	Images      []previewImage
}

type previewMessageView struct {
	Title   string
	Message string
}

var previewMarkdownImageRe = regexp.MustCompile(`!\[([^\]]*)\]\(([^)\s]+)\)`)

func buildPublicPreviewPageView(data *publicPreviewData, token string) previewPageView {
	view := previewPageView{
		IsToutiao:   data.Platform == "toutiao",
		Title:       strings.TrimSpace(data.Title),
		AccountName: data.AccountName,
	}
	if view.Title == "" {
		view.Title = "（未填写标题）"
	}
	if view.IsToutiao {
		view.IsMicroPost = data.ContentFormat == "micro_post"
		view.Paragraphs = previewTextParagraphs(data.BodyText)
		view.Images = data.Images
		for _, topic := range data.Topics {
			if label := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(topic), "#")); label != "" {
				view.Topics = append(view.Topics, label)
			}
		}
		return view
	}
	assets := make(map[uuid.UUID]previewAsset, len(data.Assets))
	for _, asset := range data.Assets {
		assets[asset.ID] = asset
	}
	sections := make([]previewPageSection, 0, len(data.Sections))
	for _, section := range data.Sections {
		sections = append(sections, previewPageSection{
			Heading: strings.TrimSpace(section.Heading),
			Blocks:  previewSectionBlocks(section.ContentMD, token, assets),
		})
	}
	view.Sections = sections
	return view
}

func previewTextParagraphs(text string) []string {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")
	chunks := strings.Split(text, "\n\n")
	out := make([]string, 0, len(chunks))
	for _, chunk := range chunks {
		if trimmed := strings.TrimSpace(chunk); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}

func previewSectionBlocks(content, token string, assets map[uuid.UUID]previewAsset) []previewPageBlock {
	content = strings.ReplaceAll(content, "\r\n", "\n")
	content = strings.ReplaceAll(content, "\r", "\n")
	chunks := strings.Split(content, "\n\n")
	blocks := make([]previewPageBlock, 0, len(chunks))
	for _, chunk := range chunks {
		chunk = strings.TrimSpace(chunk)
		if chunk == "" {
			continue
		}
		blocks = append(blocks, previewChunkBlocks(chunk, token, assets)...)
	}
	return blocks
}

// previewChunkBlocks 只把本作品资产库内的 /api/v1/assets/{id}/file 图片转为预览图片地址；
// 其余文本一律交给 html/template 自动转义，绝不把用户提供的 URL 直接写入 img src。
func previewChunkBlocks(chunk, token string, assets map[uuid.UUID]previewAsset) []previewPageBlock {
	matches := previewMarkdownImageRe.FindAllStringSubmatchIndex(chunk, -1)
	if len(matches) == 0 {
		return []previewPageBlock{{Text: chunk}}
	}
	blocks := make([]previewPageBlock, 0, len(matches)*2+1)
	cursor := 0
	for _, match := range matches {
		if text := strings.TrimSpace(chunk[cursor:match[0]]); text != "" {
			blocks = append(blocks, previewPageBlock{Text: text})
		}
		assetID, ok := previewAssetIDFromURL(chunk[match[4]:match[5]])
		if _, allowed := assets[assetID]; ok && allowed {
			blocks = append(blocks, previewPageBlock{
				IsImage:  true,
				ImageURL: "/api/v1/public-previews/" + url.PathEscape(token) + "/assets/" + assetID.String(),
				ImageAlt: strings.TrimSpace(chunk[match[2]:match[3]]),
			})
		} else {
			blocks = append(blocks, previewPageBlock{Text: strings.TrimSpace(chunk[match[0]:match[1]])})
		}
		cursor = match[1]
	}
	if tail := strings.TrimSpace(chunk[cursor:]); tail != "" {
		blocks = append(blocks, previewPageBlock{Text: tail})
	}
	return blocks
}

func previewAssetIDFromURL(raw string) (uuid.UUID, bool) {
	u, err := url.Parse(raw)
	if err != nil {
		return uuid.Nil, false
	}
	const prefix, suffix = "/api/v1/assets/", "/file"
	path := u.Path
	if !strings.HasPrefix(path, prefix) || !strings.HasSuffix(path, suffix) {
		return uuid.Nil, false
	}
	id, err := uuid.Parse(strings.TrimSuffix(strings.TrimPrefix(path, prefix), suffix))
	if err != nil {
		return uuid.Nil, false
	}
	return id, true
}

// renderPublicPreviewPage 是根路由 /preview/{token} 的只读 HTML 落地页。
// 错误直接渲染中文 HTML 提示页，不能走 s.h 的 JSON 错误包装。
func (s *Server) renderPublicPreviewPage(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'")
	claims, err := s.publicPreviewClaims(w, r)
	if err != nil {
		status, title, message := publicPreviewPageError(err)
		s.writePublicPreviewHTML(w, status, publicPreviewMessageTemplate, previewMessageView{Title: title, Message: message})
		return
	}
	data, err := s.loadPublicPreview(r.Context(), chi.URLParam(r, "token"), claims)
	if err != nil {
		status, title, message := publicPreviewPageError(err)
		s.writePublicPreviewHTML(w, status, publicPreviewMessageTemplate, previewMessageView{Title: title, Message: message})
		return
	}
	s.writePublicPreviewHTML(w, http.StatusOK, publicPreviewPageTemplate, buildPublicPreviewPageView(data, chi.URLParam(r, "token")))
}

func (s *Server) writePublicPreviewHTML(w http.ResponseWriter, status int, tmpl *template.Template, view any) {
	var buf bytes.Buffer
	if err := tmpl.Execute(&buf, view); err != nil {
		slog.Error("预览页面渲染失败", "error_code", "preview_page_render_failed", "err", err)
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte("预览页面渲染失败，请稍后重试。"))
		return
	}
	w.WriteHeader(status)
	if _, err := w.Write(buf.Bytes()); err != nil {
		slog.Warn("预览页面写出失败", "error_code", "preview_page_write_failed", "err", err)
	}
}

func publicPreviewPageError(err error) (int, string, string) {
	var apiError *APIError
	if errors.As(err, &apiError) {
		switch {
		case apiError.Status == http.StatusGone:
			return http.StatusGone, "预览链接已过期", "此预览链接已过期，请在 OPS 桌面端重新生成。"
		case apiError.Status == http.StatusNotFound:
			return http.StatusNotFound, "预览链接无效", "预览链接无效或作品已不存在，请确认链接完整或联系作者重新生成。"
		case apiError.Status >= http.StatusInternalServerError:
			return http.StatusInternalServerError, "预览暂时无法打开", "服务暂时不可用，请稍后重试。"
		default:
			return apiError.Status, "预览无法打开", apiError.Message
		}
	}
	if errors.Is(err, errNotFound) {
		return http.StatusNotFound, "预览链接无效", "预览链接无效或作品已不存在，请确认链接完整或联系作者重新生成。"
	}
	return http.StatusInternalServerError, "预览暂时无法打开", "服务暂时不可用，请稍后重试。"
}

var publicPreviewPageTemplate = template.Must(template.New("public-preview-page").Parse(`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>{{.Title}} · 内部审阅预览</title>
<style>
:root { color-scheme: light; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { background: #f2f3f5; color: #1f2329; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif; font-size: 16px; line-height: 1.75; -webkit-text-size-adjust: 100%; }
.notice { position: sticky; top: 0; z-index: 3; padding: 8px 14px; background: #e9edf0; border-bottom: 1px solid #d8dee3; color: #5c6770; font-size: 12px; letter-spacing: .02em; text-align: center; }
.page { max-width: 680px; min-height: 100vh; margin: 0 auto; padding: 30px 22px 40px; background: #fff; box-shadow: 0 0 0 1px rgba(15, 23, 42, .04); }
.kicker { margin: 0 0 8px; color: #c9161d; font-size: 14px; font-weight: 600; }
h1 { margin: 0 0 10px; font-size: 26px; line-height: 1.4; font-weight: 700; word-break: break-word; }
.account { margin: 0 0 26px; color: #576b95; font-size: 14px; word-break: break-all; }
h2 { margin: 30px 0 12px; font-size: 19px; line-height: 1.5; font-weight: 600; word-break: break-word; }
section:first-of-type h2 { margin-top: 0; }
p.body { margin: 0 0 16px; white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere; }
.topics { display: flex; flex-wrap: wrap; gap: 8px; margin: 20px 0 0; color: #315c62; font-size: 14px; }
.gallery { display: grid; grid-template-columns: 1fr; gap: 14px; margin-top: 22px; }
figure { margin: 20px 0; }
figure img { display: block; max-width: 100%; height: auto; border-radius: 8px; background: #f5f5f5; }
figcaption { margin-top: 6px; color: #7a828a; font-size: 12px; text-align: center; }
.footer { max-width: 680px; margin: 0 auto; padding: 18px 22px 38px; color: #8a939b; font-size: 12px; text-align: center; }
@media (min-width: 560px) { .gallery { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 480px) { .page { padding: 22px 16px 32px; } h1 { font-size: 22px; } h2 { font-size: 18px; } .footer { padding: 16px; } }
</style>
</head>
<body>
<div class="notice">内部审阅预览 · 禁止直接当作已发表</div>
<main class="page">
{{if .IsToutiao}}<p class="kicker">今日头条 · {{if .IsMicroPost}}微头条{{else}}文章{{end}}</p>
<h1>{{.Title}}</h1>
<p class="account">{{.AccountName}}</p>
{{range .Paragraphs}}<p class="body">{{.}}</p>
{{end}}{{if .Topics}}<p class="topics">{{range .Topics}}<span>#{{.}}</span>{{end}}</p>
{{end}}{{if .Images}}<div class="gallery">{{range .Images}}<figure><img src="{{.URL}}" alt="{{.AltText}}" loading="lazy">{{if .AltText}}<figcaption>{{.AltText}}</figcaption>{{end}}</figure>{{end}}</div>
{{end}}{{else}}<h1>{{.Title}}</h1>
<p class="account">{{.AccountName}}</p>
{{range .Sections}}<section>{{if .Heading}}<h2>{{.Heading}}</h2>{{end}}
{{range .Blocks}}{{if .IsImage}}<figure><img src="{{.ImageURL}}" alt="{{.ImageAlt}}" loading="lazy">{{if .ImageAlt}}<figcaption>{{.ImageAlt}}</figcaption>{{end}}</figure>{{else}}<p class="body">{{.Text}}</p>{{end}}
{{end}}</section>
{{end}}{{end}}</main>
<footer class="footer">本页面仅供内部审阅，链接失效后请让作者在 OPS 桌面端重新生成。</footer>
</body>
</html>
`))

var publicPreviewMessageTemplate = template.Must(template.New("public-preview-message").Parse(`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>{{.Title}} · 内部审阅预览</title>
<style>
:root { color-scheme: light; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { background: #f2f3f5; color: #1f2329; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif; font-size: 16px; line-height: 1.75; }
.notice { padding: 8px 14px; background: #e9edf0; border-bottom: 1px solid #d8dee3; color: #5c6770; font-size: 12px; text-align: center; }
.page { max-width: 680px; min-height: 60vh; margin: 0 auto; padding: 48px 22px; background: #fff; text-align: center; }
.title { margin: 0 0 12px; font-size: 22px; font-weight: 600; }
.message { margin: 0; color: #5c6770; font-size: 15px; }
@media (max-width: 480px) { .page { padding: 36px 16px; } .title { font-size: 20px; } }
</style>
</head>
<body>
<div class="notice">内部审阅预览 · 禁止直接当作已发表</div>
<main class="page">
<p class="title">{{.Title}}</p>
<p class="message">{{.Message}}</p>
</main>
</body>
</html>
`))
