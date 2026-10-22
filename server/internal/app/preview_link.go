package app

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
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

func (s *Server) previewSigningKey() []byte {
	mac := hmac.New(sha256.New, s.cfg.MasterKey)
	_, _ = mac.Write([]byte("ops:public-preview:v1"))
	return mac.Sum(nil)
}

func (s *Server) signPreview(claims previewClaims) (string, error) {
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	encoded := base64.RawURLEncoding.EncodeToString(payload)
	mac := hmac.New(sha256.New, s.previewSigningKey())
	_, _ = mac.Write([]byte(encoded))
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
	_, _ = mac.Write([]byte(payloadPart))
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
	var title, accountName, theme, platform string
	var accountID uuid.UUID
	err = s.db.QueryRow(r.Context(), `SELECT w.title, a.name, w.theme, a.id, a.platform
		FROM work w JOIN platform_account a ON a.id=w.account_id
		WHERE w.id=$1 AND a.workspace_id=$2 AND a.platform IN ('wechat_mp','toutiao') AND w.deleted_at IS NULL`,
		claims.WorkID, claims.WorkspaceID).Scan(&title, &accountName, &theme, &accountID, &platform)
	if errors.Is(err, pgx.ErrNoRows) {
		return errNotFound
	}
	if err != nil {
		return err
	}
	if platform == "toutiao" {
		return s.getToutiaoPublicPreview(w, r, claims, accountName)
	}
	rows, err := s.db.Query(r.Context(), `SELECT heading, content_md FROM work_section
		WHERE work_id=$1 AND deleted_at IS NULL ORDER BY position, created_at`, claims.WorkID)
	if err != nil {
		return err
	}
	sections := []previewSection{}
	for rows.Next() {
		var section previewSection
		if err := rows.Scan(&section.Heading, &section.ContentMD); err != nil {
			rows.Close()
			return err
		}
		sections = append(sections, section)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	assetRows, err := s.db.Query(r.Context(), `SELECT id, alt_text FROM asset WHERE work_id=$1 ORDER BY position, created_at`, claims.WorkID)
	if err != nil {
		return err
	}
	assets := []previewAsset{}
	for assetRows.Next() {
		var asset previewAsset
		if err := assetRows.Scan(&asset.ID, &asset.AltText); err != nil {
			assetRows.Close()
			return err
		}
		assets = append(assets, asset)
	}
	if err := assetRows.Err(); err != nil {
		assetRows.Close()
		return err
	}
	assetRows.Close()
	var customTheme *CustomTheme
	var raw []byte
	if err := s.db.QueryRow(r.Context(), `SELECT custom_theme FROM account_profile WHERE account_id=$1`, accountID).Scan(&raw); err != nil {
		return err
	}
	if len(raw) > 0 {
		var t CustomTheme
		if json.Unmarshal(raw, &t) == nil {
			customTheme = &t
		}
	}
	return ok(w, map[string]any{
		"title": title, "account_name": accountName, "theme": theme,
		"custom_theme": customTheme, "sections": sections, "assets": assets,
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
	_, _ = w.Write(data)
	return nil
}
