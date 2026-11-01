package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"ops/internal/cxcanonicaljson"
)

var (
	cxDNAHexColor   = regexp.MustCompile(`^#[0-9A-F]{6}$`)
	cxDNAScale      = regexp.MustCompile(`^[0-9]\.[0-9]{2}$`)
	cxDNAOpacity    = regexp.MustCompile(`^[0-1]\.[0-9]{2}$`)
	cxDNALink       = regexp.MustCompile(`(?i)(https?://|\bwww\.)`)
	cxDNACSS        = regexp.MustCompile(`(?i)(url\s*\(|@import|expression\s*\(|<\s*/?\s*(style|script|link)|\{[^}]*\}|(?:^|[;\s])(color|font|background|margin|padding|border)\s*:)`)
	cxDNADomainLike = regexp.MustCompile(`(?i)\b[a-z0-9-]+\.(com|net|org|cn|io|co|me|app|dev)(?:/|\b)`)
)

type cxVisualDNAPalette struct {
	Primary    string `json:"primary"`
	Secondary  string `json:"secondary"`
	Background string `json:"background"`
	Text       string `json:"text"`
	Muted      string `json:"muted"`
}

type cxVisualDNAWatermark struct {
	Text     string `json:"text"`
	Position string `json:"position"`
	Opacity  string `json:"opacity"`
}

type cxVisualDNATokens struct {
	Schema              string               `json:"schema"`
	Palette             cxVisualDNAPalette   `json:"palette"`
	FontStack           string               `json:"font_stack"`
	Radius              int                  `json:"radius"`
	SpacingScale        string               `json:"spacing_scale"`
	LogoAssetID         *uuid.UUID           `json:"logo_asset_id"`
	Watermark           cxVisualDNAWatermark `json:"watermark"`
	CardTemplateDefault string               `json:"card_template_default"`
	CardRatioDefault    string               `json:"card_ratio_default"`
	EndCopy             string               `json:"end_copy"`
}

type cxVisualDNAVersion struct {
	Version    int                `json:"version"`
	Tokens     *cxVisualDNATokens `json:"tokens"`
	TokensHash *string            `json:"tokens_hash"`
	CreatedAt  *time.Time         `json:"created_at,omitempty"`
	CreatedBy  *uuid.UUID         `json:"created_by,omitempty"`
}

func (t cxVisualDNATokens) validate() error {
	if t.Schema != "ops.visual-dna/v1" {
		return validation("视觉 DNA schema 必须为 ops.visual-dna/v1")
	}
	for name, color := range map[string]string{
		"主色": t.Palette.Primary, "辅色": t.Palette.Secondary, "背景色": t.Palette.Background, "正文色": t.Palette.Text, "辅助文字色": t.Palette.Muted,
	} {
		if !cxDNAHexColor.MatchString(color) {
			return validation(name + "需要使用大写 #RRGGBB 格式")
		}
	}
	for name, color := range map[string]string{"主色": t.Palette.Primary, "辅色": t.Palette.Secondary, "正文色": t.Palette.Text, "辅助文字色": t.Palette.Muted} {
		if cxDNAContrastRatio(color, t.Palette.Background) < 4.5 {
			return validation(name + "与背景色的文字对比度不足 4.5:1")
		}
	}
	switch t.FontStack {
	case "system-sans", "system-serif", "system-rounded", "system-mono":
	default:
		return validation("请选择支持的系统字体族")
	}
	if t.Radius < 0 || t.Radius > 32 {
		return validation("圆角需为 0–32 的整数")
	}
	if !cxDNAScale.MatchString(t.SpacingScale) {
		return validation("间距比例需保留两位小数")
	}
	scale, _ := strconv.ParseFloat(t.SpacingScale, 64)
	if scale < 0.8 || scale > 1.4 {
		return validation("间距比例需在 0.80–1.40 之间")
	}
	if t.Watermark.Position != "bottom-left" && t.Watermark.Position != "bottom-right" {
		return validation("水印位置无效")
	}
	if runeLen(t.Watermark.Text) > 40 || runeLen(t.EndCopy) > 80 {
		return validation("水印文案最多 40 个字符，结尾文案最多 80 个字符")
	}
	if !cxDNAOpacity.MatchString(t.Watermark.Opacity) {
		return validation("水印透明度需为 0.00–1.00 的两位小数字符串")
	}
	opacity, _ := strconv.ParseFloat(t.Watermark.Opacity, 64)
	if opacity < 0 || opacity > 1 {
		return validation("水印透明度需在 0.00–1.00 之间")
	}
	for _, text := range []string{t.Watermark.Text, t.EndCopy} {
		if cxDNALink.MatchString(text) || cxDNADomainLike.MatchString(text) || cxDNACSS.MatchString(text) {
			return validation("视觉 DNA 文案不能包含 URL 或 CSS")
		}
	}
	switch t.CardTemplateDefault {
	case "editorial", "swiss":
	default:
		return validation("默认卡片模板无效")
	}
	switch t.CardRatioDefault {
	case "1:1", "3:4", "9:16":
	default:
		return validation("默认卡片比例无效")
	}
	return nil
}

func cxDNAContrastRatio(a, b string) float64 {
	la, lb := cxDNALuminance(a), cxDNALuminance(b)
	if la < lb {
		la, lb = lb, la
	}
	return (la + 0.05) / (lb + 0.05)
}

func cxDNALuminance(color string) float64 {
	channels := [3]float64{}
	for i, offset := range []int{1, 3, 5} {
		value, _ := strconv.ParseUint(color[offset:offset+2], 16, 8)
		channel := float64(value) / 255
		if channel <= 0.04045 {
			channels[i] = channel / 12.92
		} else {
			channels[i] = math.Pow((channel+0.055)/1.055, 2.4)
		}
	}
	return channels[0]*0.2126 + channels[1]*0.7152 + channels[2]*0.0722
}

func cxDNAObjectKeys(raw json.RawMessage, expected ...string) error {
	var object map[string]json.RawMessage
	if err := json.Unmarshal(raw, &object); err != nil || object == nil {
		return validation("视觉 DNA 令牌必须是对象")
	}
	if len(object) != len(expected) {
		return validation("视觉 DNA 令牌字段不完整或包含未支持字段")
	}
	for _, key := range expected {
		if _, ok := object[key]; !ok {
			return validation("视觉 DNA 令牌字段不完整或包含未支持字段")
		}
	}
	return nil
}

func decodeCXDNATokens(raw json.RawMessage) (cxVisualDNATokens, error) {
	var tokens cxVisualDNATokens
	if err := cxDNAObjectKeys(raw, "schema", "palette", "font_stack", "radius", "spacing_scale", "logo_asset_id", "watermark", "card_template_default", "card_ratio_default", "end_copy"); err != nil {
		return tokens, err
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&tokens); err != nil {
		return tokens, validation("视觉 DNA 令牌格式不正确")
	}
	var paletteRaw, watermarkRaw json.RawMessage
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return tokens, validation("视觉 DNA 令牌格式不正确")
	}
	paletteRaw, watermarkRaw = fields["palette"], fields["watermark"]
	if err := cxDNAObjectKeys(paletteRaw, "primary", "secondary", "background", "text", "muted"); err != nil {
		return tokens, err
	}
	if err := cxDNAObjectKeys(watermarkRaw, "text", "position", "opacity"); err != nil {
		return tokens, err
	}
	if err := tokens.validate(); err != nil {
		return tokens, err
	}
	return tokens, nil
}

func decodeCXDNARequest(r *http.Request, out any) error {
	dec := json.NewDecoder(http.MaxBytesReader(nil, r.Body, 8<<20))
	dec.DisallowUnknownFields()
	if err := dec.Decode(out); err != nil {
		return requestFormatError(r.Context(), err)
	}
	var extra any
	if err := dec.Decode(&extra); err != io.EOF {
		if err == nil {
			return validation("请求只能包含一个 JSON 对象")
		}
		return requestFormatError(r.Context(), err)
	}
	return nil
}

func (s *Server) getCXVisualDNA(w http.ResponseWriter, r *http.Request) error {
	account, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	version, err := scanCXVisualDNAVersion(s.db.QueryRow(r.Context(), `SELECT version,tokens,tokens_hash,created_at,created_by
		FROM account_visual_dna WHERE account_id=$1 ORDER BY version DESC LIMIT 1`, account.ID))
	if errors.Is(err, pgx.ErrNoRows) {
		return ok(w, cxVisualDNAVersion{Version: 0})
	}
	if err != nil {
		return err
	}
	return ok(w, version)
}

func scanCXVisualDNAVersion(row pgx.Row) (cxVisualDNAVersion, error) {
	var item cxVisualDNAVersion
	var raw []byte
	var hash string
	var createdAt time.Time
	var createdBy *uuid.UUID
	if err := row.Scan(&item.Version, &raw, &hash, &createdAt, &createdBy); err != nil {
		return item, err
	}
	var tokens cxVisualDNATokens
	if err := json.Unmarshal(raw, &tokens); err != nil {
		return item, err
	}
	item.Tokens, item.TokensHash, item.CreatedAt, item.CreatedBy = &tokens, &hash, &createdAt, createdBy
	return item, nil
}

func (s *Server) listCXVisualDNAVersions(w http.ResponseWriter, r *http.Request) error {
	account, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	limit := 20
	if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
		limit, err = strconv.Atoi(raw)
		if err != nil || limit < 1 || limit > 100 {
			return validation("历史分页 limit 需为 1–100")
		}
	}
	cursor := 0
	if raw := strings.TrimSpace(r.URL.Query().Get("cursor")); raw != "" {
		cursor, err = strconv.Atoi(raw)
		if err != nil || cursor < 1 {
			return validation("历史分页 cursor 格式不正确")
		}
	}
	rows, err := s.db.Query(r.Context(), `SELECT version,tokens,tokens_hash,created_at,created_by
		FROM account_visual_dna WHERE account_id=$1 AND ($2=0 OR version<$2)
		ORDER BY version DESC LIMIT $3`, account.ID, cursor, limit+1)
	if err != nil {
		return err
	}
	defer rows.Close()
	items := []cxVisualDNAVersion{}
	for rows.Next() {
		item, err := scanCXVisualDNAVersion(rows)
		if err != nil {
			return err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	var next *string
	if len(items) > limit {
		items = items[:limit]
		value := strconv.Itoa(items[len(items)-1].Version)
		next = &value
	}
	return ok(w, map[string]any{"items": items, "next_cursor": next})
}

func (s *Server) getCXVisualDNAVersion(w http.ResponseWriter, r *http.Request) error {
	account, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	version, err := strconv.Atoi(chi.URLParam(r, "version"))
	if err != nil || version < 1 {
		return validation("视觉 DNA 版本号无效")
	}
	item, err := scanCXVisualDNAVersion(s.db.QueryRow(r.Context(), `SELECT version,tokens,tokens_hash,created_at,created_by
		FROM account_visual_dna WHERE account_id=$1 AND version=$2`, account.ID, version))
	if errors.Is(err, pgx.ErrNoRows) {
		return errNotFound
	}
	if err != nil {
		return err
	}
	return ok(w, item)
}

func (s *Server) putCXVisualDNA(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireOwner(r.Context()); err != nil {
		return err
	}
	accountID, err := pathID(r, "accountId")
	if err != nil {
		return err
	}
	var in struct {
		BaseVersion int             `json:"base_version"`
		Tokens      json.RawMessage `json:"tokens"`
	}
	if err := decodeCXDNARequest(r, &in); err != nil {
		return err
	}
	if in.BaseVersion < 0 || len(in.Tokens) == 0 {
		return validation("需要有效的 base_version 和 tokens")
	}
	tokens, err := decodeCXDNATokens(in.Tokens)
	if err != nil {
		return err
	}
	version, hash, err := s.saveCXVisualDNA(r.Context(), accountID, in.BaseVersion, tokens, nil)
	if err != nil {
		return err
	}
	s.audit(r.Context(), "cx_visual_dna_save", "platform_account", accountID.String(), "ok", map[string]any{"version": version})
	writeJSON(w, http.StatusCreated, map[string]any{"version": version, "tokens_hash": hash})
	return nil
}

func (s *Server) rollbackCXVisualDNA(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireOwner(r.Context()); err != nil {
		return err
	}
	accountID, err := pathID(r, "accountId")
	if err != nil {
		return err
	}
	var in struct {
		BaseVersion   int `json:"base_version"`
		TargetVersion int `json:"target_version"`
	}
	if err := decodeCXDNARequest(r, &in); err != nil {
		return err
	}
	if in.BaseVersion < 0 || in.TargetVersion < 1 {
		return validation("需要有效的 base_version 和 target_version")
	}
	version, hash, err := s.saveCXVisualDNA(r.Context(), accountID, in.BaseVersion, cxVisualDNATokens{}, &in.TargetVersion)
	if err != nil {
		return err
	}
	s.audit(r.Context(), "cx_visual_dna_rollback", "platform_account", accountID.String(), "ok", map[string]any{"version": version, "target_version": in.TargetVersion})
	writeJSON(w, http.StatusCreated, map[string]any{"version": version, "tokens_hash": hash})
	return nil
}

func (s *Server) saveCXVisualDNA(ctx context.Context, accountID uuid.UUID, baseVersion int, tokens cxVisualDNATokens, targetVersion *int) (int, string, error) {
	actor := ident(ctx)
	version, hash := 0, ""
	err := s.withTx(ctx, func(tx pgx.Tx) error {
		if actor == nil {
			return errUnauthorized
		}
		if !(actor.AdminOverride && actor.SystemAdmin) {
			var role, status string
			err := tx.QueryRow(ctx, `SELECT role,status FROM workspace_member WHERE workspace_id=$1 AND user_id=$2 FOR SHARE`, actor.WorkspaceID, actor.UserID).Scan(&role, &status)
			if errors.Is(err, pgx.ErrNoRows) {
				return errUnauthorized
			}
			if err != nil {
				return err
			}
			if status != "active" {
				return errUnauthorized
			}
			if role != "owner" {
				return apiErr(http.StatusForbidden, "forbidden", "需要工作区所有者权限")
			}
		}
		var accountStatus string
		err := tx.QueryRow(ctx, `SELECT status FROM platform_account WHERE id=$1 AND workspace_id=$2 FOR UPDATE`, accountID, actor.WorkspaceID).Scan(&accountStatus)
		if errors.Is(err, pgx.ErrNoRows) {
			return errNotFound
		}
		if err != nil {
			return err
		}
		if accountStatus != "active" {
			return apiErr(http.StatusConflict, "account_disabled", "账号已停用，不能修改视觉 DNA")
		}
		var currentVersion int
		if err := tx.QueryRow(ctx, `SELECT coalesce(max(version),0) FROM account_visual_dna WHERE account_id=$1`, accountID).Scan(&currentVersion); err != nil {
			return err
		}
		if currentVersion != baseVersion {
			return apiErr(http.StatusConflict, "version_conflict", "视觉 DNA 已被其他窗口修改，请刷新后比较再保存")
		}
		if targetVersion != nil {
			var raw []byte
			err := tx.QueryRow(ctx, `SELECT tokens FROM account_visual_dna WHERE account_id=$1 AND version=$2`, accountID, *targetVersion).Scan(&raw)
			if errors.Is(err, pgx.ErrNoRows) {
				return errNotFound
			}
			if err != nil {
				return err
			}
			decoded, err := decodeCXDNATokens(raw)
			if err != nil {
				return apiErr(http.StatusInternalServerError, "visual_dna_invalid_history", "历史视觉 DNA 令牌无法验证")
			}
			tokens = decoded
		}
		if err := tokens.validate(); err != nil {
			return err
		}
		if tokens.LogoAssetID != nil {
			var assetID uuid.UUID
			err := tx.QueryRow(ctx, `SELECT id FROM asset WHERE id=$1 AND workspace_id=$2 AND account_id=$3
				AND work_id IS NULL AND origin_asset_id IS NULL AND mime LIKE 'image/%' FOR KEY SHARE`, *tokens.LogoAssetID, actor.WorkspaceID, accountID).Scan(&assetID)
			if errors.Is(err, pgx.ErrNoRows) {
				return validation("logo_asset_id 必须属于当前工作区和账号，且为账号级图片")
			}
			if err != nil {
				return err
			}
		}
		newVersion := currentVersion + 1
		hash, err = cxVisualDNATokensHash(tokens)
		if err != nil {
			return err
		}
		raw, err := json.Marshal(tokens)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO account_visual_dna(account_id,version,tokens,tokens_hash,created_by)
			VALUES($1,$2,$3,$4,$5)`, accountID, newVersion, raw, hash, actor.UserID); err != nil {
			return err
		}
		version = newVersion
		return nil
	})
	return version, hash, err
}

func cxVisualDNATokensHash(tokens cxVisualDNATokens) (string, error) {
	raw, err := json.Marshal(tokens)
	if err != nil {
		return "", err
	}
	value, err := cxcanonicaljson.Parse(raw)
	if err != nil {
		return "", err
	}
	return cxcanonicaljson.Hash(value)
}
