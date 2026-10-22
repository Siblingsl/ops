package app

import (
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func (s *Server) importPastedWork(w http.ResponseWriter, r *http.Request) error {
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	if a.Platform != "wechat_mp" || a.ContentFormat != "long_article" {
		return validation("旧文导入仅支持公众号长图文账号")
	}
	if a.Status != "active" {
		return stateInvalid("账号已停用，不能导入作品")
	}
	var in struct {
		ConfirmPublished bool   `json:"confirm_published"`
		Title            string `json:"title"`
		PublishedDate    string `json:"published_date"`
		Sections         []struct {
			Heading   string `json:"heading"`
			ContentMD string `json:"content_md"`
		} `json:"sections"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	if !in.ConfirmPublished {
		return humanStep("published_import", "请确认这篇旧文已经由你在平台上发表")
	}
	in.Title = strings.TrimSpace(in.Title)
	if in.Title == "" {
		return validationFields("请填写作品标题", map[string]string{"title": "请填写作品标题"})
	}
	in.Title = truncateRunes(in.Title, 64)
	if len(in.Sections) == 0 {
		return validation("正文至少需要一个非空段落")
	}
	for i := range in.Sections {
		in.Sections[i].Heading = strings.TrimSpace(in.Sections[i].Heading)
		in.Sections[i].ContentMD = strings.TrimSpace(in.Sections[i].ContentMD)
		if in.Sections[i].ContentMD == "" {
			return validation("正文段落不能为空")
		}
	}

	var publishedAt *time.Time
	if strings.TrimSpace(in.PublishedDate) != "" {
		at, err := time.ParseInLocation("2006-01-02", strings.TrimSpace(in.PublishedDate), s.loc)
		if err != nil {
			return validationFields("发布日期格式不正确", map[string]string{"published_date": "请选择有效日期"})
		}
		publishedAt = &at
	}

	var id uuid.UUID
	err = s.withTx(r.Context(), func(tx pgx.Tx) error {
		// NW-E1：导入也走 insertWorkTx，统一停用账号校验、默认主题与创建审计。
		created, err := s.insertWorkTx(r.Context(), tx, a, nil, in.Title, "long_article", "long_article", "", "import")
		if err != nil {
			return err
		}
		id = created
		for i, section := range in.Sections {
			if _, err := tx.Exec(r.Context(), `INSERT INTO work_section (work_id, position, heading, key_point, content_md, origin)
				VALUES ($1,$2,$3,$3,$4,'human')`, id, i+1, section.Heading, section.ContentMD); err != nil {
				return err
			}
		}
		return s.setWorkPublished(r.Context(), tx, id, "", publishedAt)
	})
	if err != nil {
		return err
	}
	s.audit(r.Context(), "work_import", "work", id.String(), "ok", map[string]any{"account_id": a.ID.String()})
	return s.writeWork(w, r, id)
}
