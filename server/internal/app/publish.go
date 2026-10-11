package app

import (
	"archive/zip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/microcosm-cc/bluemonday"

	"ops/internal/secure"
	"ops/internal/wechat"
)

// Default 后台待办 checklists stored on first push / pack (EX-I-01).
const wechatTodos = `[{"key":"preview","label":"在后台预览，检查排版是否正常","done":false},{"key":"original","label":"按需设置原创声明（接口不支持，只能在后台设置）","done":false},{"key":"ai","label":"内容使用了 AI 辅助时，按平台要求做 AI 内容声明","done":false},{"key":"backfill","label":"发表后回到这里回填链接","done":false}]`
const xhsTodos = `[{"key":"images","label":"按顺序上传图片","done":false},{"key":"ai","label":"在「笔记内容声明」中勾选 AI 合成内容（如适用）","done":false},{"key":"backfill","label":"发布后回到这里回填链接","done":false}]`

func (s *Server) todayPushCount(ctx context.Context, accountID uuid.UUID) (int, error) {
	var n int
	err := s.db.QueryRow(ctx, `SELECT count(*) FROM push_record WHERE account_id=$1 AND status='ok' AND created_at >= $2`, accountID, s.today()).Scan(&n)
	return n, err
}

func (s *Server) pushPreview(w http.ResponseWriter, r *http.Request) error {
	m, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	if m.Account.Platform != "wechat_mp" {
		return validation("只有公众号作品可以写入草稿")
	}
	ctx := r.Context()
	wk, err := s.loadWork(ctx, m.ID)
	if err != nil {
		return err
	}
	count, err := s.todayPushCount(ctx, m.Account.ID)
	if err != nil {
		return err
	}
	mode := "new"
	if wk.WechatDraftMediaID != nil {
		mode = "overwrite"
	}
	panelCount := 0
	if wk.ContentFormat == "card_post" {
		for _, c := range wk.Cards {
			if c.ImageAssetID != nil {
				panelCount++
			}
		}
	} else {
		for _, p := range wk.Panels {
			if p.AssetID != nil {
				panelCount++
			}
		}
	}
	return ok(w, map[string]any{
		"mode":           mode,
		"today_count":    count,
		"daily_limit":    m.Account.DailyPushLimit,
		"fields":         wk.WechatFields,
		"credential":     m.Account.Credential,
		"status":         wk.Status,
		"revision":       wk.Revision,
		"backend_url":    s.backendURL(),
		"can_push":       wk.Status == "ready" || wk.Status == "pushed",
		"asset_count":    len(wk.Assets),
		"cover_asset":    wk.CoverAssetID,
		"cover_crops":    wk.CoverCrops,
		"title":          wk.Title,
		"summary":        wk.Summary,
		"content_format": wk.ContentFormat,
		"panel_images":   panelCount,
	})
}

func (s *Server) backendURL() string {
	if s.cfg.Dev {
		return "http://" + s.cfg.MockListen + "/mock/drafts"
	}
	return "https://mp.weixin.qq.com/"
}

var htmlPolicy = func() *bluemonday.Policy {
	p := bluemonday.UGCPolicy()
	p.AllowAttrs("style").Globally()
	p.AllowStyles("color", "background-color", "font-size", "font-weight", "font-style", "line-height", "letter-spacing",
		"text-align", "text-decoration", "margin", "margin-top", "margin-bottom", "margin-left", "margin-right",
		"padding", "padding-top", "padding-bottom", "padding-left", "padding-right", "border", "border-left", "border-bottom",
		"border-top", "border-radius", "display", "width", "max-width", "height", "word-break", "white-space", "font-family",
		"box-sizing", "overflow-wrap", "list-style-type", "background").Globally()
	p.AllowElements("section", "span")
	p.AllowAttrs("src", "alt", "data-asset").OnElements("img")
	p.AllowURLSchemes("http", "https")
	p.AllowRelativeURLs(true)
	return p
}()

var imgSrcRe = regexp.MustCompile(`(<img[^>]*?\ssrc=")([^"]+)(")`)

type pushInput struct {
	HTML             string         `json:"html"`
	Revision         int            `json:"revision"`
	Fields           WechatDefaults `json:"fields"`
	OverwriteChoice  string         `json:"overwrite_choice"`
	ConfirmOverLimit bool           `json:"confirm_over_limit"`
}

type pushFail struct {
	step string
	err  error
}

func draftHash(content string) string { return secure.SHA256Hex([]byte(strings.TrimSpace(content))) }

// pushWechat writes exactly one work into the draft box (H-05). There is no publish call (H-06).
func (s *Server) pushWechat(w http.ResponseWriter, r *http.Request) error {
	m, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	if m.Account.Platform != "wechat_mp" {
		return validation("只有公众号作品可以写入草稿")
	}
	var in pushInput
	if err := decode(r, &in); err != nil {
		return err
	}
	ctx := r.Context()
	wk, err := s.loadWork(ctx, m.ID)
	if err != nil {
		return err
	}
	if wk.Status == "reviewing" {
		return humanStep("H-09", "这篇作品需要审阅，审阅通过后才能写入草稿")
	}
	if wk.Status != "ready" && wk.Status != "pushed" {
		return humanStep("H-04", "发布前检查还没有全部确认，不能写入草稿")
	}
	if in.Revision != wk.Revision {
		return stateInvalid("内容在检查后又修改过，请重新检查")
	}
	if m.Account.Credential == nil || m.Account.Credential.State == "not_configured" {
		return apiErr(409, "wechat_error", "公众号凭证未配置，请到「设置 → 平台账号」填写 AppID 和 AppSecret")
	}
	if wk.ContentFormat == "comic" || wk.ContentFormat == "card_post" {
		return s.pushNewspic(w, r, m, wk, in)
	}
	if wk.CoverAssetID == nil || len(wk.CoverCrops) == 0 {
		return validation("请先设置封面")
	}
	switch {
	case strings.TrimSpace(wk.Title) == "" || runeLen(wk.Title) > 32:
		return validation("标题需要 1 到 32 字")
	case runeLen(in.Fields.Author) > 16:
		return validation("作者不能超过 16 个字")
	case runeLen(wk.Summary) > 120:
		return validation("摘要不能超过 120 字")
	case len(in.Fields.SourceURL) > 1024:
		return validation("阅读原文链接不能超过 1KB")
	}
	content := htmlPolicy.Sanitize(in.HTML)
	if runeLen(content) >= 20000 || len(content) >= 1<<20 {
		return validation("排版后的正文超出公众号限制（需少于 2 万字符、小于 1MB）")
	}
	count, err := s.todayPushCount(ctx, m.Account.ID)
	if err != nil {
		return err
	}
	overLimit := count >= m.Account.DailyPushLimit
	if overLimit && !in.ConfirmOverLimit {
		return apiErr(409, "push_limit_reached", fmt.Sprintf("今天已写入草稿 %d 次，达到上限 %d 次。频繁写入可能被平台视为批量发布（3.27.2），确认仍要继续吗？", count, m.Account.DailyPushLimit)).
			With(map[string]int{"today_count": count, "daily_limit": m.Account.DailyPushLimit})
	}

	sse := newSSE(w)
	step := func(name, status string, cur, total int) {
		sse.send("step", map[string]any{"name": name, "status": status, "current": cur, "total": total})
	}
	action := "add"
	var recordID uuid.UUID
	if err := s.db.QueryRow(ctx, `INSERT INTO push_record (work_id, account_id, action, status, over_limit) VALUES ($1,$2,'add','running',$3) RETURNING id`,
		m.ID, m.Account.ID, overLimit).Scan(&recordID); err != nil {
		sse.fail(err)
		return nil
	}
	fail := func(f pushFail) {
		code, msg := "", f.err.Error()
		var we *wechat.Error
		if errors.As(f.err, &we) {
			code, msg = fmt.Sprint(we.Code), we.Readable()
			if we.Code == 40164 {
				msg += "（需要添加的 IP：" + s.egressHint() + "）"
			}
		}
		var ae *APIError
		if errors.As(f.err, &ae) {
			msg = ae.Message
		}
		_, _ = s.db.Exec(context.WithoutCancel(ctx), `UPDATE push_record SET status='failed', action=$2, failed_step=$3, error_code=$4, error_message=$5 WHERE id=$1`,
			recordID, action, f.step, code, truncate(msg, 500))
		s.audit(ctx, "wechat_push", "work", m.ID.String(), "failed", map[string]any{"step": f.step, "code": code})
		sse.send("error", map[string]any{"code": "wechat_error", "message": msg, "detail": map[string]string{"step": f.step, "errcode": code}})
	}

	token, err := s.accessToken(ctx, m.Account.ID, false)
	if err != nil {
		fail(pushFail{"token", err})
		return nil
	}
	call := func(fn func(tok string) error) error {
		err := fn(token)
		var we *wechat.Error
		if errors.As(err, &we) && we.TokenExpired() {
			if token, err = s.accessToken(ctx, m.Account.ID, true); err != nil {
				return err
			}
			return fn(token)
		}
		return err
	}

	// 后台修改检测（D-033、E-18）
	draftID := ""
	if wk.WechatDraftMediaID != nil {
		draftID = *wk.WechatDraftMediaID
	}
	if draftID != "" && in.OverwriteChoice != "new" {
		step("check_backend", "running", 0, 0)
		var stored *string
		_ = s.db.QueryRow(ctx, `SELECT wechat_draft_hash FROM work WHERE id=$1`, m.ID).Scan(&stored)
		var item *wechat.DraftItem
		getErr := call(func(tok string) error {
			var e error
			item, e = s.wx.DraftGet(ctx, tok, draftID)
			return e
		})
		var we *wechat.Error
		if errors.As(getErr, &we) && we.Code == 40007 {
			_, _ = s.db.Exec(ctx, `DELETE FROM push_record WHERE id=$1`, recordID)
			sse.send("need_choice", map[string]any{"reason": "missing", "message": "原草稿已不在草稿箱，可能已经发表或被删除。可以回填已发布，或新建一篇草稿（计入当日次数）。"})
			return nil
		}
		changed := getErr != nil || stored == nil || draftHash(item.Content) != *stored
		if changed && in.OverwriteChoice != "overwrite" {
			_, _ = s.db.Exec(ctx, `DELETE FROM push_record WHERE id=$1`, recordID)
			sse.send("need_choice", map[string]any{"reason": "modified", "message": "这篇草稿在公众号后台被修改过（或无法确认是否修改过），覆盖会丢失后台的修改。"})
			return nil
		}
		step("check_backend", "done", 0, 0)
	}
	if draftID != "" && in.OverwriteChoice == "new" {
		draftID = ""
	}

	// 正文图片：uploadimg 并替换链接，按 sha256 复用缓存（E-04）。
	matches := imgSrcRe.FindAllStringSubmatch(content, -1)
	total := len(matches)
	replaced := map[string]string{}
	for i, mm := range matches {
		src := mm[2]
		step("upload_images", "running", i+1, total)
		if _, done := replaced[src]; done {
			continue
		}
		aid, isAsset := assetIDFromURL(src)
		if !isAsset {
			fail(pushFail{"upload_images", validation("正文中有外部图片链接，微信会过滤外部图片，请改为上传图片")})
			return nil
		}
		ar, err := s.assetRow(ctx, aid)
		if err != nil {
			fail(pushFail{"upload_images", validation("正文引用的图片已被删除")})
			return nil
		}
		url, err := s.cachedMedia(ctx, m.Account.ID, ar, "content_image", call)
		if err != nil {
			fail(pushFail{"upload_images", err})
			return nil
		}
		replaced[src] = url
	}
	content = imgSrcRe.ReplaceAllStringFunc(content, func(tag string) string {
		mm := imgSrcRe.FindStringSubmatch(tag)
		if u, ok := replaced[mm[2]]; ok {
			return strings.Replace(tag, mm[2], u, 1)
		}
		return tag
	})
	step("upload_images", "done", total, total)

	// 封面：永久素材 + cover_info 裁剪坐标（F-013）。
	step("upload_cover", "running", 0, 0)
	coverRow, err := s.assetRow(ctx, *wk.CoverAssetID)
	if err != nil {
		fail(pushFail{"upload_cover", validation("封面图片已被删除，请重新设置封面")})
		return nil
	}
	thumbID, err := s.cachedMedia(ctx, m.Account.ID, coverRow, "image", call)
	if err != nil {
		fail(pushFail{"upload_cover", err})
		return nil
	}
	step("upload_cover", "done", 0, 0)

	var crops map[string]cropBox
	_ = json.Unmarshal(wk.CoverCrops, &crops)
	article := wechat.Article{
		ArticleType: "news", Title: wk.Title, Author: in.Fields.Author, Digest: wk.Summary, Content: content,
		ContentSourceURL: in.Fields.SourceURL, ThumbMediaID: thumbID,
		NeedOpenComment: b2i(in.Fields.OpenComment), OnlyFansCanComment: b2i(in.Fields.FansOnlyComment),
	}
	article.CoverInfo = &struct {
		CropPercentList []wechat.Crop `json:"crop_percent_list"`
	}{}
	for _, ratio := range []string{"2.35_1", "1_1"} {
		if c, ok := crops[ratio]; ok {
			article.CoverInfo.CropPercentList = append(article.CoverInfo.CropPercentList, wechat.Crop{Ratio: ratio,
				X1: fmt.Sprintf("%.4f", c.X1), Y1: fmt.Sprintf("%.4f", c.Y1), X2: fmt.Sprintf("%.4f", c.X2), Y2: fmt.Sprintf("%.4f", c.Y2)})
		}
	}

	step("write_draft", "running", 0, 0)
	if draftID == "" {
		err = call(func(tok string) error {
			var e error
			draftID, e = s.wx.DraftAdd(ctx, tok, article)
			return e
		})
	} else {
		action = "update"
		err = call(func(tok string) error { return s.wx.DraftUpdate(ctx, tok, draftID, article) })
	}
	if err != nil {
		fail(pushFail{"write_draft", err})
		return nil
	}
	step("write_draft", "done", 0, 0)

	var hash *string
	_ = call(func(tok string) error {
		item, e := s.wx.DraftGet(ctx, tok, draftID)
		if e == nil {
			h := draftHash(item.Content)
			hash = &h
		}
		return e
	})
	fieldsJSON, _ := json.Marshal(in.Fields)
	if _, err := s.db.Exec(context.WithoutCancel(ctx), `UPDATE work SET status='pushed', wechat_draft_media_id=$2, wechat_draft_hash=$3, wechat_fields=$4, updated_at=now(), post_push_todos=CASE WHEN post_push_todos='[]'::jsonb THEN '`+wechatTodos+`'::jsonb ELSE post_push_todos END WHERE id=$1`,
		m.ID, draftID, hash, fieldsJSON); err != nil {
		sse.fail(err)
		return nil
	}
	_, _ = s.db.Exec(context.WithoutCancel(ctx), `UPDATE push_record SET status='ok', action=$2, draft_media_id=$3 WHERE id=$1`, recordID, action, draftID)
	s.audit(ctx, "wechat_push", "work", m.ID.String(), "ok", map[string]any{"action": action, "over_limit": overLimit})
	sse.send("done", map[string]any{"action": action, "draft_media_id": draftID, "backend_url": s.backendURL(), "today_count": count + 1})
	return nil
}

func b2i(b bool) int {
	if b {
		return 1
	}
	return 0
}

// pushNewspic writes a comic (or image-set) work as a WeChat newspic draft (FR-M10-03, F-012/F-013).
func (s *Server) pushNewspic(w http.ResponseWriter, r *http.Request, m *workMeta, wk *Work, in pushInput) error {
	ctx := r.Context()
	// 漫画与图文卡片都走图片消息草稿：图片分别来自分格回传图与卡片配图。
	var imageAssets []*assetRow
	var content string
	if wk.ContentFormat == "comic" {
		for _, p := range wk.Panels {
			if p.AssetID == nil {
				return validation("每一格都需要回传图片后才能写入图片消息草稿")
			}
			ar, err := s.assetRow(ctx, *p.AssetID)
			if err != nil {
				return validation("分格图片已被删除，请重新上传")
			}
			imageAssets = append(imageAssets, ar)
		}
		content = comicPlainText(wk.Panels)
	} else {
		for _, c := range wk.Cards {
			if c.ImageAssetID == nil {
				return validation("每张卡片都需要生成配图后才能写入图片消息草稿")
			}
			ar, err := s.assetRow(ctx, *c.ImageAssetID)
			if err != nil {
				return validation("卡片配图已被删除，请重新生成")
			}
			imageAssets = append(imageAssets, ar)
		}
		content = cardPlainText(wk.Cards)
	}
	if n := len(imageAssets); n < 1 || n > 20 {
		return validation("图片消息需要 1 到 20 张图")
	}
	switch {
	case strings.TrimSpace(wk.Title) == "" || runeLen(wk.Title) > 32:
		return validation("标题需要 1 到 32 字")
	case runeLen(in.Fields.Author) > 16:
		return validation("作者不能超过 16 个字")
	case len(in.Fields.SourceURL) > 1024:
		return validation("阅读原文链接不能超过 1KB")
	}
	if content == "" {
		content = wk.Title
	}
	if runeLen(content) >= 20000 || len(content) >= 1<<20 {
		return validation("图片消息正文超出公众号限制（需少于 2 万字符、小于 1MB）")
	}
	count, err := s.todayPushCount(ctx, m.Account.ID)
	if err != nil {
		return err
	}
	overLimit := count >= m.Account.DailyPushLimit
	if overLimit && !in.ConfirmOverLimit {
		return apiErr(409, "push_limit_reached", fmt.Sprintf("今天已写入草稿 %d 次，达到上限 %d 次。频繁写入可能被平台视为批量发布（3.27.2），确认仍要继续吗？", count, m.Account.DailyPushLimit)).
			With(map[string]int{"today_count": count, "daily_limit": m.Account.DailyPushLimit})
	}

	sse := newSSE(w)
	step := func(name, status string, cur, total int) {
		sse.send("step", map[string]any{"name": name, "status": status, "current": cur, "total": total})
	}
	action := "newspic"
	var recordID uuid.UUID
	if err := s.db.QueryRow(ctx, `INSERT INTO push_record (work_id, account_id, action, status, over_limit) VALUES ($1,$2,'newspic','running',$3) RETURNING id`,
		m.ID, m.Account.ID, overLimit).Scan(&recordID); err != nil {
		sse.fail(err)
		return nil
	}
	fail := func(f pushFail) {
		code, msg := "", f.err.Error()
		var we *wechat.Error
		if errors.As(f.err, &we) {
			code, msg = fmt.Sprint(we.Code), we.Readable()
			if we.Code == 40164 {
				msg += "（需要添加的 IP：" + s.egressHint() + "）"
			}
		}
		var ae *APIError
		if errors.As(f.err, &ae) {
			msg = ae.Message
		}
		_, _ = s.db.Exec(context.WithoutCancel(ctx), `UPDATE push_record SET status='failed', action=$2, failed_step=$3, error_code=$4, error_message=$5 WHERE id=$1`,
			recordID, action, f.step, code, truncate(msg, 500))
		s.audit(ctx, "wechat_push", "work", m.ID.String(), "failed", map[string]any{"step": f.step, "code": code, "kind": "newspic"})
		sse.send("error", map[string]any{"code": "wechat_error", "message": msg, "detail": map[string]string{"step": f.step, "errcode": code}})
	}

	token, err := s.accessToken(ctx, m.Account.ID, false)
	if err != nil {
		fail(pushFail{"token", err})
		return nil
	}
	call := func(fn func(tok string) error) error {
		err := fn(token)
		var we *wechat.Error
		if errors.As(err, &we) && we.TokenExpired() {
			if token, err = s.accessToken(ctx, m.Account.ID, true); err != nil {
				return err
			}
			return fn(token)
		}
		return err
	}

	draftID := ""
	if wk.WechatDraftMediaID != nil {
		draftID = *wk.WechatDraftMediaID
	}
	if draftID != "" && in.OverwriteChoice != "new" {
		step("check_backend", "running", 0, 0)
		var stored *string
		_ = s.db.QueryRow(ctx, `SELECT wechat_draft_hash FROM work WHERE id=$1`, m.ID).Scan(&stored)
		var item *wechat.DraftItem
		getErr := call(func(tok string) error {
			var e error
			item, e = s.wx.DraftGet(ctx, tok, draftID)
			return e
		})
		var we *wechat.Error
		if errors.As(getErr, &we) && we.Code == 40007 {
			_, _ = s.db.Exec(ctx, `DELETE FROM push_record WHERE id=$1`, recordID)
			sse.send("need_choice", map[string]any{"reason": "missing", "message": "原草稿已不在草稿箱，可能已经发表或被删除。可以回填已发布，或新建一篇草稿（计入当日次数）。"})
			return nil
		}
		changed := getErr != nil || stored == nil || draftHash(item.Content) != *stored
		if changed && in.OverwriteChoice != "overwrite" {
			_, _ = s.db.Exec(ctx, `DELETE FROM push_record WHERE id=$1`, recordID)
			sse.send("need_choice", map[string]any{"reason": "modified", "message": "这篇草稿在公众号后台被修改过（或无法确认是否修改过），覆盖会丢失后台的修改。"})
			return nil
		}
		step("check_backend", "done", 0, 0)
	}
	if draftID != "" && in.OverwriteChoice == "new" {
		draftID = ""
	}

	imageList := make([]wechat.ImageListItem, 0, len(imageAssets))
	for i, ar := range imageAssets {
		step("upload_images", "running", i+1, len(imageAssets))
		mediaID, err := s.cachedMedia(ctx, m.Account.ID, ar, "image", call)
		if err != nil {
			fail(pushFail{"upload_images", err})
			return nil
		}
		imageList = append(imageList, wechat.ImageListItem{ImageMediaID: mediaID})
	}
	step("upload_images", "done", len(imageAssets), len(imageAssets))

	article := wechat.Article{
		ArticleType: "newspic", Title: wk.Title, Author: in.Fields.Author, Content: content,
		ContentSourceURL: in.Fields.SourceURL,
		NeedOpenComment:  b2i(in.Fields.OpenComment), OnlyFansCanComment: b2i(in.Fields.FansOnlyComment),
		ImageInfo: &wechat.ImageInfo{ImageList: imageList},
	}
	// First image is the cover; optional 1:1 crop from first panel if cover_crops present.
	if len(wk.CoverCrops) > 0 {
		var crops map[string]cropBox
		_ = json.Unmarshal(wk.CoverCrops, &crops)
		article.CoverInfo = &struct {
			CropPercentList []wechat.Crop `json:"crop_percent_list"`
		}{}
		for _, ratio := range []string{"1_1", "16_9", "2.35_1"} {
			if c, ok := crops[ratio]; ok {
				article.CoverInfo.CropPercentList = append(article.CoverInfo.CropPercentList, wechat.Crop{Ratio: ratio,
					X1: fmt.Sprintf("%.4f", c.X1), Y1: fmt.Sprintf("%.4f", c.Y1), X2: fmt.Sprintf("%.4f", c.X2), Y2: fmt.Sprintf("%.4f", c.Y2)})
			}
		}
	}

	step("write_draft", "running", 0, 0)
	if draftID == "" {
		err = call(func(tok string) error {
			var e error
			draftID, e = s.wx.DraftAdd(ctx, tok, article)
			return e
		})
	} else {
		action = "update"
		err = call(func(tok string) error { return s.wx.DraftUpdate(ctx, tok, draftID, article) })
	}
	if err != nil {
		fail(pushFail{"write_draft", err})
		return nil
	}
	step("write_draft", "done", 0, 0)

	var hash *string
	_ = call(func(tok string) error {
		item, e := s.wx.DraftGet(ctx, tok, draftID)
		if e == nil {
			h := draftHash(item.Content)
			hash = &h
		}
		return e
	})
	fieldsJSON, _ := json.Marshal(in.Fields)
	if _, err := s.db.Exec(context.WithoutCancel(ctx), `UPDATE work SET status='pushed', wechat_draft_media_id=$2, wechat_draft_hash=$3, wechat_fields=$4, updated_at=now(), post_push_todos=CASE WHEN post_push_todos='[]'::jsonb THEN '`+wechatTodos+`'::jsonb ELSE post_push_todos END WHERE id=$1`,
		m.ID, draftID, hash, fieldsJSON); err != nil {
		sse.fail(err)
		return nil
	}
	_, _ = s.db.Exec(context.WithoutCancel(ctx), `UPDATE push_record SET status='ok', action=$2, draft_media_id=$3 WHERE id=$1`, recordID, action, draftID)
	s.audit(ctx, "wechat_push", "work", m.ID.String(), "ok", map[string]any{"action": action, "kind": "newspic", "images": len(imageList)})
	sse.send("done", map[string]any{"action": action, "draft_media_id": draftID, "backend_url": s.backendURL(), "today_count": count + 1})
	return nil
}

func (s *Server) cachedMedia(ctx context.Context, accountID uuid.UUID, a *assetRow, kind string, call func(func(string) error) error) (string, error) {
	var url, mediaID string
	err := s.db.QueryRow(ctx, `SELECT wechat_url, media_id FROM wechat_media_cache WHERE account_id=$1 AND sha256=$2 AND kind=$3`, accountID, a.SHA256, kind).Scan(&url, &mediaID)
	if err == nil {
		if kind == "content_image" {
			return url, nil
		}
		return mediaID, nil
	}
	data, err := s.assetBytes(a)
	if err != nil {
		return "", validation("读取图片文件失败")
	}
	name := a.ID.String() + ".jpg"
	if a.Mime == "image/png" {
		name = a.ID.String() + ".png"
	}
	err = call(func(tok string) error {
		var e error
		if kind == "content_image" {
			url, e = s.wx.UploadImg(ctx, tok, name, data)
		} else {
			mediaID, url, e = s.wx.AddImageMaterial(ctx, tok, name, data)
		}
		return e
	})
	if err != nil {
		return "", err
	}
	_, _ = s.db.Exec(ctx, `INSERT INTO wechat_media_cache (account_id, sha256, kind, wechat_url, media_id) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
		accountID, a.SHA256, kind, url, mediaID)
	if kind == "content_image" {
		return url, nil
	}
	return mediaID, nil
}

// ---------- 小红书发布包 ----------

func (s *Server) createPack(w http.ResponseWriter, r *http.Request) error {
	m, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	if m.Account.Platform != "xhs" {
		return validation("只有小红书作品生成发布包")
	}
	if m.Status == "reviewing" {
		return humanStep("H-09", "这篇作品需要审阅，审阅通过后才能生成发布包")
	}
	if m.Status != "ready" && m.Status != "packed" {
		return humanStep("H-04", "发布前检查还没有全部确认，不能生成发布包")
	}
	if _, err := s.db.Exec(r.Context(), `UPDATE work SET status='packed', updated_at=now(),
		post_push_todos = CASE WHEN post_push_todos='[]'::jsonb THEN '`+xhsTodos+`'::jsonb ELSE post_push_todos END WHERE id=$1 AND status='ready'`, m.ID); err != nil {
		return err
	}
	s.audit(r.Context(), "xhs_pack", "work", m.ID.String(), "ok", nil)
	return s.writeWork(w, r, m.ID)
}

func (s *Server) getPack(w http.ResponseWriter, r *http.Request) error {
	m, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	if m.Status != "packed" && m.Status != "published" {
		return stateInvalid("发布包还没有生成")
	}
	return s.writeWork(w, r, m.ID)
}

func (s *Server) packZip(w http.ResponseWriter, r *http.Request) error {
	m, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	if m.Status != "packed" && m.Status != "published" {
		return stateInvalid("发布包还没有生成")
	}
	ctx := r.Context()
	sql := `SELECT id, work_id, storage_path, mime, sha256 FROM asset WHERE work_id=$1 ORDER BY position, created_at`
	cardText := false
	switch m.ContentFormat {
	case "comic":
		sql = `SELECT a.id, a.work_id, a.storage_path, a.mime, a.sha256 FROM comic_panel p
			JOIN asset a ON a.id=p.asset_id WHERE p.work_id=$1 AND p.asset_id IS NOT NULL ORDER BY p.position`
	case "card_post":
		// D-048：图文卡片打包 = 卡片配图（按卡片顺序）+ 文案.txt（卡片标题与正文）。
		sql = `SELECT a.id, a.work_id, a.storage_path, a.mime, a.sha256 FROM work_card c
			JOIN asset a ON a.id=c.image_asset_id WHERE c.work_id=$1 AND c.image_asset_id IS NOT NULL ORDER BY c.position`
		cardText = true
	}
	rows, err := s.db.Query(ctx, sql, m.ID)
	if err != nil {
		return err
	}
	var list []assetRow
	for rows.Next() {
		var a assetRow
		if err := rows.Scan(&a.ID, &a.WorkID, &a.StoragePath, &a.Mime, &a.SHA256); err == nil {
			list = append(list, a)
		}
	}
	rows.Close()
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="xhs-%s.zip"`, time.Now().Format("20060102-1504")))
	zw := zip.NewWriter(w)
	for i := range list {
		data, err := s.assetBytes(&list[i])
		if err != nil {
			continue
		}
		ext := ".jpg"
		if list[i].Mime == "image/png" {
			ext = ".png"
		}
		f, err := zw.Create(fmt.Sprintf("%02d%s", i+1, ext))
		if err != nil {
			return err
		}
		_, _ = f.Write(data)
	}
	if cardText {
		var b strings.Builder
		rows, err := s.db.Query(ctx, `SELECT heading, content_md FROM work_section WHERE work_id=$1 AND deleted_at IS NULL ORDER BY position, created_at`, m.ID)
		if err != nil {
			return err
		}
		defer rows.Close()
		first := true
		for rows.Next() {
			var h, body string
			if err := rows.Scan(&h, &body); err != nil {
				return err
			}
			if !first {
				b.WriteString("\n\n")
			}
			first = false
			if t := strings.TrimSpace(h); t != "" {
				b.WriteString(t + "\n")
			}
			b.WriteString(strings.TrimSpace(body))
		}
		if err := rows.Err(); err != nil {
			return err
		}
		f, err := zw.Create("文案.txt")
		if err != nil {
			return err
		}
		if _, err := f.Write([]byte(b.String())); err != nil {
			return err
		}
	}
	return zw.Close()
}

// markPublished is the only way a work becomes 已发布 (H-07, HC-07).
func (s *Server) markPublished(w http.ResponseWriter, r *http.Request) error {
	m, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	if m.Status != "pushed" && m.Status != "packed" && m.Status != "published" {
		return stateInvalid("作品还没有进入草稿箱或生成发布包")
	}
	var in struct {
		URL         string     `json:"url"`
		PublishedAt *time.Time `json:"published_at"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	at := s.now()
	if in.PublishedAt != nil {
		at = *in.PublishedAt
	}
	url := strings.TrimSpace(in.URL)
	if url != "" && !strings.HasPrefix(url, "http") {
		return validation("链接需要以 http 开头")
	}
	if _, err := s.db.Exec(r.Context(), `UPDATE work SET status='published', published_url=nullif($2,''), published_at=$3, locked=true, updated_at=now(),
		wechat_msgid=coalesce(nullif($4,''), wechat_msgid) WHERE id=$1`,
		m.ID, url, at, parseWechatMsgID(url)); err != nil {
		return err
	}
	s.recomputeMetricOffsets(r.Context(), m.ID)
	s.audit(r.Context(), "mark_published", "work", m.ID.String(), "ok", map[string]any{"url": url})
	return s.writeWork(w, r, m.ID)
}
