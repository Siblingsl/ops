package app

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Anonymous access remains scoped to the signed work and revision; the pack owns
// content conversion, selected images, material validity and final consistency.
func (s *Server) toutiaoPreviewPack(ctx context.Context, claims previewClaims) (*toutiaoPackBuild, error) {
	stale := apiErr(http.StatusGone, "preview_stale", "共享内容已修改或失效，请让作者重新生成分享预览")
	if claims.BasisRevision < 1 {
		return nil, stale
	}
	ctx = context.WithValue(ctx, ctxMember, &identity{WorkspaceID: claims.WorkspaceID, Role: "viewer"})
	pack, source, err := s.buildToutiaoPack(ctx, claims.WorkID, claims.BasisRevision, false)
	if err == nil {
		err = s.verifyToutiaoPackBasis(ctx, claims.WorkID, claims.BasisRevision, source.Status)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errNotFound
	}
	var apiError *APIError
	if errors.As(err, &apiError) && apiError.Status < 500 {
		return nil, stale
	}
	return pack, err
}

func (s *Server) getToutiaoPublicPreview(w http.ResponseWriter, r *http.Request, claims previewClaims, accountName string) error {
	pack, err := s.toutiaoPreviewPack(r.Context(), claims)
	if err != nil {
		return err
	}
	images := []map[string]any{}
	articleHTML := string(pack.Files["article.html"])
	if articleHTML != "" {
		_, articleHTML, _ = strings.Cut(articleHTML, "<body>")
		articleHTML, _, _ = strings.Cut(articleHTML, "</body>")
	}
	for _, image := range pack.View.Images {
		url := "/api/v1/public-previews/" + chi.URLParam(r, "token") + "/assets/" + image.AssetID.String()
		alt := image.AltText
		if len(image.Uses) > 0 {
			alt = image.Uses[0].Alt
		}
		images = append(images, map[string]any{"url": url, "alt_text": alt, "ai_generated": image.AIGenerated})
		articleHTML = strings.ReplaceAll(articleHTML, `src="`+image.File+`"`, `src="`+url+`"`)
	}
	title := ""
	if pack.View.PublishTitle != nil {
		title = *pack.View.PublishTitle
	}
	return ok(w, map[string]any{
		"platform": "toutiao", "content_format": pack.View.ContentFormat, "title": title, "account_name": accountName,
		"body_text": pack.View.BodyText, "article_html": articleHTML, "topics": pack.View.Topics, "images": images,
	})
}

func (s *Server) getToutiaoPublicPreviewAsset(w http.ResponseWriter, r *http.Request, claims previewClaims, assetID uuid.UUID) error {
	pack, err := s.toutiaoPreviewPack(r.Context(), claims)
	if err != nil {
		return err
	}
	if variant := r.URL.Query().Get("variant"); variant != "" && variant != "original" {
		return validation("头条分享预览只提供原图")
	}
	for _, image := range pack.View.Images {
		if image.AssetID != assetID {
			continue
		}
		w.Header().Set("Content-Type", image.Mime)
		w.Header().Set("X-Content-Type-Options", "nosniff")
		_, err := w.Write(pack.Files[image.File])
		return err
	}
	return errNotFound
}
