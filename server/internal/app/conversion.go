package app

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

const (
	conversionSignatureHeader = "X-Ops-Signature"
	conversionTokenHeader     = "X-Ops-Token"
	conversionTimeWindow      = 7 * 24 * time.Hour
	conversionRateLimit       = 60
	conversionManualDailyMax  = 100
)

var conversionPlatforms = map[string]bool{
	"wechat_mp": true,
	"site":      true,
	"youtube":   true,
	"bilibili":  true,
	"x":         true,
	"other":     true,
}

// conversionLink is the API projection. account_id is deliberately not returned:
// conversion URLs must not expose internal account identifiers.
type conversionLink struct {
	ID          uuid.UUID `json:"id"`
	WorkID      uuid.UUID `json:"work_id"`
	Platform    string    `json:"platform"`
	TargetURL   string    `json:"target_url"`
	UTMSource   string    `json:"utm_source"`
	UTMMedium   string    `json:"utm_medium"`
	UTMCampaign string    `json:"utm_campaign"`
	Code        string    `json:"code"`
	Status      string    `json:"status"`
	URL         string    `json:"url"`
	CreatedAt   time.Time `json:"created_at"`
}

type conversionIngestToken struct {
	ID         uuid.UUID  `json:"id"`
	Name       string     `json:"name"`
	Status     string     `json:"status"`
	CreatedAt  time.Time  `json:"created_at"`
	LastUsedAt *time.Time `json:"last_used_at,omitempty"`
	Token      string     `json:"token,omitempty"`
}

type conversionEventInput struct {
	Event      string            `json:"event"`
	ExternalID string            `json:"external_id"`
	OccurredAt *time.Time        `json:"occurred_at"`
	ValueCents *int              `json:"value_cents"`
	Currency   string            `json:"currency"`
	Payload    map[string]string `json:"payload"`
	Note       string            `json:"note,omitempty"`
}

type conversionWorkSummary struct {
	WorkID         uuid.UUID `json:"work_id"`
	WorkTitle      string    `json:"work_title"`
	Platform       string    `json:"platform"`
	Links          int       `json:"links"`
	Events         int       `json:"events"`
	Register       int       `json:"register"`
	Paid           int       `json:"paid"`
	Lead           int       `json:"lead"`
	Download       int       `json:"download"`
	Other          int       `json:"other"`
	AmountCents    int64     `json:"amount_cents"`
	Currency       string    `json:"currency"`
	Reads          *int64    `json:"reads"`
	ConversionRate *float64  `json:"conversion_rate"`
	Connected      bool      `json:"connected"`
}

type conversionSummary struct {
	AccountID uuid.UUID               `json:"account_id"`
	Connected bool                    `json:"connected"`
	Works     []conversionWorkSummary `json:"works"`
}

func (s *Server) listConversionLinks(w http.ResponseWriter, r *http.Request) error {
	meta, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	rows, err := s.db.Query(r.Context(), `SELECT id, work_id, platform, target_url, utm_source,
		utm_medium, utm_campaign, code, status, created_at
		FROM conversion_link WHERE workspace_id=$1 AND work_id=$2 ORDER BY created_at DESC`,
		ident(r.Context()).WorkspaceID, meta.ID)
	if err != nil {
		return err
	}
	defer rows.Close()
	links := []conversionLink{}
	for rows.Next() {
		var link conversionLink
		if err := rows.Scan(&link.ID, &link.WorkID, &link.Platform, &link.TargetURL, &link.UTMSource,
			&link.UTMMedium, &link.UTMCampaign, &link.Code, &link.Status, &link.CreatedAt); err != nil {
			return err
		}
		link.URL = conversionURL(link)
		links = append(links, link)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	return ok(w, map[string]any{"links": links})
}

func (s *Server) createConversionLink(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireEditor(r.Context()); err != nil {
		return err
	}
	meta, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	var in struct {
		Platform  string `json:"platform"`
		TargetURL string `json:"target_url"`
		Campaign  string `json:"campaign"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	in.Platform = strings.TrimSpace(in.Platform)
	in.TargetURL = strings.TrimSpace(in.TargetURL)
	in.Campaign = strings.TrimSpace(in.Campaign)
	if err := validateConversionPlacement(meta, in.Platform); err != nil {
		return err
	}
	if err := validateConversionTarget(in.TargetURL); err != nil {
		return err
	}
	medium := conversionMedium(meta.ContentFormat)
	campaign := in.Campaign
	if campaign == "" {
		campaign = conversionCampaign(meta)
	}
	if len([]rune(campaign)) < 1 || len([]rune(campaign)) > 64 {
		return validationFields("推广链接参数不完整", map[string]string{"campaign": "campaign 需为 1–64 个字符"})
	}

	// 同 work+platform 已有 active 链接时返回原链接；目标变化必须走 PUT，避免静默换目标。
	var existing conversionLink
	err = s.db.QueryRow(r.Context(), `SELECT id, work_id, platform, target_url, utm_source,
		utm_medium, utm_campaign, code, status, created_at
		FROM conversion_link WHERE workspace_id=$1 AND work_id=$2 AND platform=$3 AND status='active'`,
		ident(r.Context()).WorkspaceID, meta.ID, in.Platform).Scan(
		&existing.ID, &existing.WorkID, &existing.Platform, &existing.TargetURL, &existing.UTMSource,
		&existing.UTMMedium, &existing.UTMCampaign, &existing.Code, &existing.Status, &existing.CreatedAt)
	if err == nil {
		if existing.TargetURL != in.TargetURL {
			return apiErr(http.StatusConflict, "conversion_link_exists", "该作品与平台已有推广链接；修改目标 URL 请使用 PUT，旧链接会保留并禁用")
		}
		existing.URL = conversionURL(existing)
		return ok(w, existing)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}

	for attempt := 0; attempt < 6; attempt++ {
		code, err := newConversionCode()
		if err != nil {
			return err
		}
		link, err := s.insertConversionLink(r.Context(), nil, meta, in.Platform, in.TargetURL, medium, campaign, code)
		if err == nil {
			link.URL = conversionURL(*link)
			return ok(w, link)
		}
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			// code 碰撞继续重试；work+platform active 唯一冲突说明另一请求已抢先插入。
			if strings.Contains(pgErr.ConstraintName, "conversion_link_work_platform_active") {
				var raced conversionLink
				if qerr := s.db.QueryRow(r.Context(), `SELECT id, work_id, platform, target_url, utm_source,
					utm_medium, utm_campaign, code, status, created_at
					FROM conversion_link WHERE workspace_id=$1 AND work_id=$2 AND platform=$3 AND status='active'`,
					ident(r.Context()).WorkspaceID, meta.ID, in.Platform).Scan(
					&raced.ID, &raced.WorkID, &raced.Platform, &raced.TargetURL, &raced.UTMSource,
					&raced.UTMMedium, &raced.UTMCampaign, &raced.Code, &raced.Status, &raced.CreatedAt); qerr == nil {
					if raced.TargetURL != in.TargetURL {
						return apiErr(http.StatusConflict, "conversion_link_exists", "该作品与平台已有推广链接；修改目标 URL 请使用 PUT")
					}
					raced.URL = conversionURL(raced)
					return ok(w, raced)
				}
			}
			continue
		}
		return err
	}
	return apiErr(http.StatusConflict, "conversion_code_exhausted", "生成推广链接失败，请重试")
}

func (s *Server) updateConversionLink(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireEditor(r.Context()); err != nil {
		return err
	}
	meta, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	linkID, err := pathID(r, "linkId")
	if err != nil {
		return err
	}
	var in struct {
		TargetURL string `json:"target_url"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	in.TargetURL = strings.TrimSpace(in.TargetURL)
	if err := validateConversionTarget(in.TargetURL); err != nil {
		return err
	}
	ctx := r.Context()
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var old conversionLink
	err = tx.QueryRow(ctx, `SELECT id, work_id, platform, target_url, utm_source, utm_medium,
		utm_campaign, code, status, created_at FROM conversion_link
		WHERE id=$1 AND workspace_id=$2 AND work_id=$3`,
		linkID, ident(ctx).WorkspaceID, meta.ID).Scan(
		&old.ID, &old.WorkID, &old.Platform, &old.TargetURL, &old.UTMSource,
		&old.UTMMedium, &old.UTMCampaign, &old.Code, &old.Status, &old.CreatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return notFound("推广链接不存在")
		}
		return err
	}
	if old.TargetURL == in.TargetURL {
		old.URL = conversionURL(old)
		return ok(w, old)
	}
	if _, err := tx.Exec(ctx, `UPDATE conversion_link SET status='disabled' WHERE id=$1`, old.ID); err != nil {
		return err
	}
	code, err := newConversionCode()
	if err != nil {
		return err
	}
	link, err := s.insertConversionLink(ctx, tx, meta, old.Platform, in.TargetURL,
		old.UTMMedium, old.UTMCampaign, code)
	if err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	link.URL = conversionURL(*link)
	return ok(w, link)
}

func (s *Server) insertConversionLink(ctx context.Context, tx pgx.Tx, meta *workMeta, platform, target, medium, campaign, code string) (*conversionLink, error) {
	var q interface {
		QueryRow(context.Context, string, ...any) pgx.Row
	} = s.db
	if tx != nil {
		q = tx
	}
	var link conversionLink
	err := q.QueryRow(ctx, `INSERT INTO conversion_link
		(workspace_id, account_id, work_id, platform, target_url, utm_source, utm_medium, utm_campaign, code, created_by)
		VALUES ($1,$2,$3,$4,$5,$4,$6,$7,$8,$9)
		RETURNING id, work_id, platform, target_url, utm_source, utm_medium, utm_campaign, code, status, created_at`,
		ident(ctx).WorkspaceID, meta.Account.ID, meta.ID, platform, target, medium, campaign, code, ident(ctx).UserID).Scan(
		&link.ID, &link.WorkID, &link.Platform, &link.TargetURL, &link.UTMSource,
		&link.UTMMedium, &link.UTMCampaign, &link.Code, &link.Status, &link.CreatedAt)
	if err != nil {
		return nil, err
	}
	return &link, nil
}

func validateConversionPlacement(meta *workMeta, platform string) error {
	if !conversionPlatforms[platform] {
		return apiErr(http.StatusUnprocessableEntity, "conversion_platform_forbidden", "该平台不支持生成外链；只允许公众号、自有站点、YouTube、B站、X 或其他站点")
	}
	// 作品所在账号必须是允许外链的平台。小红书/抖音/头条等正文平台不放外链。
	if meta.Account == nil || meta.Account.Platform != "wechat_mp" {
		return apiErr(http.StatusUnprocessableEntity, "conversion_platform_forbidden", "小红书、抖音、头条等平台默认不生成外链；只允许公众号“阅读原文”与自有站点")
	}
	return nil
}

func validateConversionTarget(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme == "" || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return validationFields("推广链接参数不完整", map[string]string{"target_url": "请填写 http(s) 完整地址"})
	}
	if u.User != nil {
		return validationFields("推广链接参数不完整", map[string]string{"target_url": "目标 URL 不能包含账号密码"})
	}
	return nil
}

func conversionURL(link conversionLink) string {
	u, err := url.Parse(link.TargetURL)
	if err != nil {
		return link.TargetURL
	}
	q := u.Query()
	q.Set("utm_source", link.UTMSource)
	q.Set("utm_medium", link.UTMMedium)
	q.Set("utm_campaign", link.UTMCampaign)
	q.Set("ops_code", link.Code)
	u.RawQuery = q.Encode()
	return u.String()
}

func conversionMedium(format string) string {
	switch format {
	case "long_article", "qa_article", "briefing":
		return "article"
	default:
		return "video"
	}
}

func conversionCampaign(meta *workMeta) string {
	id := meta.ID.String()
	short := strings.ReplaceAll(id[:8], "-", "")
	if short == "" {
		short = "work"
	}
	slug := slugForCampaign(meta.Title)
	if slug == "" {
		slug = "work"
	}
	campaign := "w-" + short + "-" + slug
	if len([]rune(campaign)) > 64 {
		campaign = string([]rune(campaign)[:64])
	}
	return campaign
}

func slugForCampaign(title string) string {
	var b strings.Builder
	dash := false
	for _, r := range strings.ToLower(strings.TrimSpace(title)) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
			dash = false
		case unicode.IsSpace(r) || r == '-' || r == '_' || r == '/' || r == '.':
			if b.Len() > 0 && !dash {
				b.WriteByte('-')
				dash = true
			}
		}
		if b.Len() >= 40 {
			break
		}
	}
	return strings.Trim(b.String(), "-")
}

func newConversionCode() (string, error) {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
	buf := make([]byte, 12)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	for i := range buf {
		buf[i] = alphabet[int(buf[i])%len(alphabet)]
	}
	return string(buf), nil
}

func (s *Server) listConversionTokens(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireOwner(r.Context()); err != nil {
		return err
	}
	rows, err := s.db.Query(r.Context(), `SELECT id, name, status, created_at, last_used_at
		FROM conversion_ingest_token WHERE workspace_id=$1 ORDER BY created_at DESC`,
		ident(r.Context()).WorkspaceID)
	if err != nil {
		return err
	}
	defer rows.Close()
	list := []conversionIngestToken{}
	for rows.Next() {
		var t conversionIngestToken
		if err := rows.Scan(&t.ID, &t.Name, &t.Status, &t.CreatedAt, &t.LastUsedAt); err != nil {
			return err
		}
		list = append(list, t)
	}
	return ok(w, map[string]any{"tokens": list})
}

func (s *Server) createConversionToken(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireOwner(r.Context()); err != nil {
		return err
	}
	var in struct {
		Name string `json:"name"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	in.Name = strings.TrimSpace(in.Name)
	if len([]rune(in.Name)) < 1 || len([]rune(in.Name)) > 60 {
		return validationFields("回传 token 参数不完整", map[string]string{"name": "名称需为 1–60 个字符"})
	}
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return err
	}
	token := base64.RawURLEncoding.EncodeToString(raw)
	hash := conversionSHA256Hex(token)
	var t conversionIngestToken
	err := s.db.QueryRow(r.Context(), `INSERT INTO conversion_ingest_token
		(workspace_id, name, token_hash, created_by) VALUES ($1,$2,$3,$4)
		RETURNING id, name, status, created_at, last_used_at`,
		ident(r.Context()).WorkspaceID, in.Name, hash, ident(r.Context()).UserID).Scan(
		&t.ID, &t.Name, &t.Status, &t.CreatedAt, &t.LastUsedAt)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return apiErr(http.StatusConflict, "conversion_token_exists", "同名回传 token 已存在")
		}
		return err
	}
	t.Token = token
	return ok(w, t)
}

func (s *Server) revokeConversionToken(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireOwner(r.Context()); err != nil {
		return err
	}
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	cmd, err := s.db.Exec(r.Context(), `UPDATE conversion_ingest_token SET status='revoked'
		WHERE id=$1 AND workspace_id=$2`, id, ident(r.Context()).WorkspaceID)
	if err != nil {
		return err
	}
	if cmd.RowsAffected() == 0 {
		return notFound("回传 token 不存在")
	}
	return ok(w, map[string]any{"ok": true})
}

func conversionSHA256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

func (s *Server) allowConversionRate(tokenID uuid.UUID) bool {
	now := s.now()
	s.conversionRateMu.Lock()
	defer s.conversionRateMu.Unlock()
	cutoff := now.Add(-time.Minute)
	kept := s.conversionRate[tokenID][:0]
	for _, at := range s.conversionRate[tokenID] {
		if at.After(cutoff) {
			kept = append(kept, at)
		}
	}
	if len(kept) >= conversionRateLimit {
		s.conversionRate[tokenID] = kept
		return false
	}
	s.conversionRate[tokenID] = append(kept, now)
	return true
}

func (s *Server) publicConversion(w http.ResponseWriter, r *http.Request) error {
	code := strings.TrimSpace(r.PathValue("code"))
	if len(code) < 8 || len(code) > 32 {
		return notFound("推广链接不存在")
	}
	rawBody, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		return validation("请求体读取失败")
	}
	rawToken := strings.TrimSpace(r.Header.Get(conversionTokenHeader))
	if rawToken == "" {
		auth := strings.TrimSpace(r.Header.Get("Authorization"))
		if strings.HasPrefix(auth, "Bearer ") {
			rawToken = strings.TrimSpace(strings.TrimPrefix(auth, "Bearer "))
		}
	}
	if rawToken == "" {
		return apiErr(http.StatusUnauthorized, "conversion_auth_required", "缺少回传 token")
	}
	var tokenID uuid.UUID
	var tokenWorkspace uuid.UUID
	var tokenStatus string
	if err := s.db.QueryRow(r.Context(), `SELECT id, workspace_id, status FROM conversion_ingest_token
		WHERE token_hash=$1`, conversionSHA256Hex(rawToken)).Scan(&tokenID, &tokenWorkspace, &tokenStatus); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return apiErr(http.StatusUnauthorized, "conversion_signature_invalid", "回传 token 或签名无效")
		}
		return err
	}
	if tokenStatus != "active" {
		return apiErr(http.StatusUnauthorized, "conversion_token_revoked", "回传 token 已撤销")
	}
	if !s.allowConversionRate(tokenID) {
		return apiErr(http.StatusTooManyRequests, "conversion_rate_limited", "回传频率超过 60 次/分钟，请稍后重试")
	}
	sig := strings.TrimSpace(r.Header.Get(conversionSignatureHeader))
	if !strings.HasPrefix(sig, "sha256=") {
		return apiErr(http.StatusUnauthorized, "conversion_signature_invalid", "签名格式应为 sha256=...")
	}
	expected := hmacSignature(rawToken, rawBody)
	if !hmac.Equal([]byte(strings.TrimPrefix(sig, "sha256=")), []byte(expected)) {
		return apiErr(http.StatusUnauthorized, "conversion_signature_invalid", "签名校验失败")
	}

	var in conversionEventInput
	dec := json.NewDecoder(strings.NewReader(string(rawBody)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&in); err != nil {
		return validation("回传 JSON 格式不正确或包含未知字段")
	}
	if err := s.validateConversionEvent(&in, false); err != nil {
		return err
	}

	var linkID, linkWorkspace uuid.UUID
	var linkStatus string
	if err := s.db.QueryRow(r.Context(), `SELECT id, workspace_id, status FROM conversion_link WHERE code=$1`, code).Scan(&linkID, &linkWorkspace, &linkStatus); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return notFound("推广链接不存在")
		}
		return err
	}
	if linkStatus != "active" || linkWorkspace != tokenWorkspace {
		// 跨工作区 code 不暴露存在性，统一 404。
		return notFound("推广链接不存在")
	}

	payload, _ := json.Marshal(in.Payload)
	var eventID uuid.UUID
	err = s.db.QueryRow(r.Context(), `INSERT INTO conversion_event
		(workspace_id, link_id, event_name, external_id, occurred_at, value_cents, currency, payload)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
		ON CONFLICT (link_id, external_id) DO NOTHING
		RETURNING id`,
		linkWorkspace, linkID, in.Event, in.ExternalID, in.OccurredAt, in.ValueCents, strings.ToUpper(in.Currency), payload).Scan(&eventID)
	duplicate := false
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			duplicate = true
		} else {
			return err
		}
	}
	_, _ = s.db.Exec(r.Context(), `UPDATE conversion_ingest_token SET last_used_at=$2 WHERE id=$1`, tokenID, s.now())
	return ok(w, map[string]any{"ok": true, "duplicate": duplicate, "event_id": eventID})
}

func hmacSignature(rawToken string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(rawToken))
	_, _ = mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}

func (s *Server) validateConversionEvent(in *conversionEventInput, manual bool) error {
	in.Event = strings.ToLower(strings.TrimSpace(in.Event))
	switch in.Event {
	case "register", "paid", "lead", "download", "other":
	default:
		return validationFields("转化事件参数不完整", map[string]string{"event": "事件需为 register/paid/lead/download/other"})
	}
	in.ExternalID = strings.TrimSpace(in.ExternalID)
	if len([]rune(in.ExternalID)) < 1 || len([]rune(in.ExternalID)) > 128 {
		return validationFields("转化事件参数不完整", map[string]string{"external_id": "external_id 需为 1–128 个字符"})
	}
	if strings.Contains(in.ExternalID, "@") {
		return validationFields("转化事件参数不完整", map[string]string{"external_id": "external_id 不能包含邮箱等 PII"})
	}
	if in.OccurredAt == nil {
		return validationFields("转化事件参数不完整", map[string]string{"occurred_at": "请填写 occurred_at"})
	}
	if delta := s.now().Sub(*in.OccurredAt); delta > conversionTimeWindow || delta < -conversionTimeWindow {
		return validationFields("转化事件参数不完整", map[string]string{"occurred_at": "occurred_at 必须在当前时间前后 7 天内"})
	}
	if in.ValueCents != nil && *in.ValueCents < 0 {
		return validationFields("转化事件参数不完整", map[string]string{"value_cents": "金额不能为负"})
	}
	in.Currency = strings.ToUpper(strings.TrimSpace(in.Currency))
	if in.Currency == "" {
		in.Currency = "CNY"
	}
	if len(in.Currency) != 3 || !isASCIIAlpha(in.Currency) {
		return validationFields("转化事件参数不完整", map[string]string{"currency": "币种需为 3 位字母"})
	}
	for k, v := range in.Payload {
		switch k {
		case "channel", "plan", "amount_bucket":
		default:
			return validationFields("转化事件参数不完整", map[string]string{"payload": "payload 只允许 channel/plan/amount_bucket"})
		}
		if strings.Contains(v, "@") {
			return validationFields("转化事件参数不完整", map[string]string{"payload": "payload 不能包含邮箱等 PII"})
		}
	}
	if manual {
		in.Note = strings.TrimSpace(in.Note)
		if len([]rune(in.Note)) < 1 || len([]rune(in.Note)) > 500 {
			return validationFields("人工补录参数不完整", map[string]string{"note": "请填写 1–500 字的补录说明"})
		}
	}
	return nil
}

func isASCIIAlpha(s string) bool {
	for _, r := range s {
		if r < 'A' || r > 'Z' {
			return false
		}
	}
	return true
}

func (s *Server) createManualConversionEvent(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireEditor(r.Context()); err != nil {
		return err
	}
	linkID, err := pathID(r, "id")
	if err != nil {
		return err
	}
	var in conversionEventInput
	if err := decode(r, &in); err != nil {
		return err
	}
	if err := s.validateConversionEvent(&in, true); err != nil {
		return err
	}
	now := s.now().In(s.loc)
	dayStart := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, s.loc)
	var count int
	if err := s.db.QueryRow(r.Context(), `SELECT count(*) FROM conversion_event
		WHERE workspace_id=$1 AND manual=true AND received_at >= $2`,
		ident(r.Context()).WorkspaceID, dayStart).Scan(&count); err != nil {
		return err
	}
	if count >= conversionManualDailyMax {
		return apiErr(http.StatusTooManyRequests, "conversion_manual_daily_limit", "人工补录每天最多 100 条")
	}
	var linkWorkspace uuid.UUID
	var linkStatus string
	if err := s.db.QueryRow(r.Context(), `SELECT workspace_id, status FROM conversion_link WHERE id=$1`, linkID).Scan(&linkWorkspace, &linkStatus); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return notFound("推广链接不存在")
		}
		return err
	}
	if linkWorkspace != ident(r.Context()).WorkspaceID || linkStatus != "active" {
		return notFound("推广链接不存在")
	}
	if in.ExternalID == "" {
		in.ExternalID = "manual-" + uuid.NewString()
	}
	payload, _ := json.Marshal(in.Payload)
	var eventID uuid.UUID
	err = s.db.QueryRow(r.Context(), `INSERT INTO conversion_event
		(workspace_id, link_id, event_name, external_id, occurred_at, value_cents, currency, payload, manual, note, created_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,$9,$10)
		ON CONFLICT (link_id, external_id) DO NOTHING
		RETURNING id`,
		linkWorkspace, linkID, in.Event, in.ExternalID, in.OccurredAt, in.ValueCents,
		in.Currency, payload, in.Note, ident(r.Context()).UserID).Scan(&eventID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ok(w, map[string]any{"ok": true, "duplicate": true})
		}
		return err
	}
	return ok(w, map[string]any{"ok": true, "duplicate": false, "event_id": eventID})
}

func (s *Server) listConversions(w http.ResponseWriter, r *http.Request) error {
	acc, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	from, to, err := conversionRange(r, s.loc, s.now())
	if err != nil {
		return err
	}
	var workFilter *uuid.UUID
	if raw := strings.TrimSpace(r.URL.Query().Get("work_id")); raw != "" {
		id, err := uuid.Parse(raw)
		if err != nil {
			return validationFields("查询参数不正确", map[string]string{"work_id": "work_id 不是有效 UUID"})
		}
		workFilter = &id
	}
	q := `SELECT l.work_id, w.title, l.platform,
			count(DISTINCT l.id) AS links,
			count(e.id) AS events,
			count(e.id) FILTER (WHERE e.event_name='register') AS registers,
			count(e.id) FILTER (WHERE e.event_name='paid') AS paid,
			count(e.id) FILTER (WHERE e.event_name='lead') AS leads,
			count(e.id) FILTER (WHERE e.event_name='download') AS downloads,
			count(e.id) FILTER (WHERE e.event_name='other') AS others,
			coalesce(sum(e.value_cents) FILTER (WHERE e.event_name='paid' AND e.value_cents IS NOT NULL),0) AS amount_cents,
			coalesce(max(e.currency),'CNY') AS currency
		FROM conversion_link l
		JOIN work w ON w.id=l.work_id AND w.deleted_at IS NULL
		LEFT JOIN conversion_event e ON e.link_id=l.id AND e.occurred_at >= $3 AND e.occurred_at < $4
		WHERE l.workspace_id=$1 AND l.account_id=$2`
	args := []any{ident(r.Context()).WorkspaceID, acc.ID, from, to}
	if workFilter != nil {
		q += ` AND l.work_id=$5`
		args = append(args, *workFilter)
	}
	q += ` GROUP BY l.work_id, w.title, l.platform ORDER BY events DESC, w.title`
	rows, err := s.db.Query(r.Context(), q, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	summary := conversionSummary{AccountID: acc.ID, Works: []conversionWorkSummary{}}
	for rows.Next() {
		var x conversionWorkSummary
		if err := rows.Scan(&x.WorkID, &x.WorkTitle, &x.Platform, &x.Links, &x.Events,
			&x.Register, &x.Paid, &x.Lead, &x.Download, &x.Other, &x.AmountCents, &x.Currency); err != nil {
			return err
		}
		x.Connected = x.Events > 0
		if x.Connected {
			summary.Connected = true
		}
		reads, err := s.latestWorkReads(r.Context(), x.WorkID)
		if err != nil {
			return err
		}
		x.Reads = reads
		if reads != nil && *reads > 0 {
			rate := float64(x.Register+x.Paid+x.Lead) / float64(*reads) * 100
			x.ConversionRate = &rate
		}
		summary.Works = append(summary.Works, x)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	return ok(w, summary)
}

func (s *Server) latestWorkReads(ctx context.Context, workID uuid.UUID) (*int64, error) {
	var reads int64
	err := s.db.QueryRow(ctx, `SELECT m.reads FROM metric_snapshot m
		WHERE m.work_id=$1 AND m.reads IS NOT NULL AND m.quality_state='approved' AND metric_source_supported(m.source)
		ORDER BY m.day_offset DESC, m.captured_at DESC LIMIT 1`, workID).Scan(&reads)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &reads, nil
}

func conversionRange(r *http.Request, loc *time.Location, now time.Time) (time.Time, time.Time, error) {
	q := r.URL.Query()
	today := now.In(loc)
	end := time.Date(today.Year(), today.Month(), today.Day(), 0, 0, 0, 0, loc).AddDate(0, 0, 1)
	start := end.AddDate(0, 0, -30)
	if raw := strings.TrimSpace(q.Get("to")); raw != "" {
		t, err := time.ParseInLocation("2006-01-02", raw, loc)
		if err != nil {
			return time.Time{}, time.Time{}, validationFields("查询参数不正确", map[string]string{"to": "to 需为 YYYY-MM-DD"})
		}
		end = t.AddDate(0, 0, 1)
	}
	if raw := strings.TrimSpace(q.Get("from")); raw != "" {
		t, err := time.ParseInLocation("2006-01-02", raw, loc)
		if err != nil {
			return time.Time{}, time.Time{}, validationFields("查询参数不正确", map[string]string{"from": "from 需为 YYYY-MM-DD"})
		}
		start = t
	}
	if !start.Before(end) {
		return time.Time{}, time.Time{}, validationFields("查询参数不正确", map[string]string{"from": "from 必须早于 to"})
	}
	return start, end, nil
}

func notFound(msg string) *APIError { return apiErr(http.StatusNotFound, "not_found", msg) }
