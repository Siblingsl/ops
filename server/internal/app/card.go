package app

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// D-048 图文卡片（card_post）：卡片 = 作品段落（卡片标题与正文）+ 逐卡 AI 配图。
// 大纲确认后每段是一张卡片；打包与公众号图片消息按卡片图取材，文案随包输出。
type WorkCard struct {
	ID           uuid.UUID  `json:"id"`
	SectionID    uuid.UUID  `json:"section_id"`
	Position     int        `json:"position"`
	Heading      string     `json:"heading"`
	Body         string     `json:"body"`
	ImageAssetID *uuid.UUID `json:"image_asset_id"`
	ImageURL     string     `json:"image_url,omitempty"`
	CreatedAt    time.Time  `json:"created_at"`
	UpdatedAt    time.Time  `json:"updated_at"`
}

func (s *Server) loadCards(ctx context.Context, q pgx.Tx, workID uuid.UUID) ([]WorkCard, error) {
	sql := `SELECT c.id, c.section_id, c.position, s.heading, s.content_md, c.image_asset_id, c.created_at, c.updated_at
		FROM work_card c JOIN work_section s ON s.id=c.section_id
		WHERE c.work_id=$1 AND s.deleted_at IS NULL ORDER BY c.position, c.created_at`
	var rows pgx.Rows
	var err error
	if q != nil {
		rows, err = q.Query(ctx, sql, workID)
	} else {
		rows, err = s.db.Query(ctx, sql, workID)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := []WorkCard{}
	for rows.Next() {
		var c WorkCard
		if err := rows.Scan(&c.ID, &c.SectionID, &c.Position, &c.Heading, &c.Body, &c.ImageAssetID, &c.CreatedAt, &c.UpdatedAt); err != nil {
			return nil, err
		}
		if c.ImageAssetID != nil {
			c.ImageURL = "/api/v1/assets/" + c.ImageAssetID.String() + "/file"
		}
		list = append(list, c)
	}
	return list, rows.Err()
}

func cardPlainText(cards []WorkCard) string {
	var parts []string
	for _, c := range cards {
		var b strings.Builder
		if h := strings.TrimSpace(c.Heading); h != "" {
			b.WriteString(h)
		}
		if body := strings.TrimSpace(c.Body); body != "" {
			if b.Len() > 0 {
				b.WriteByte('\n')
			}
			b.WriteString(body)
		}
		if b.Len() > 0 {
			parts = append(parts, b.String())
		}
	}
	return strings.Join(parts, "\n\n")
}

// generateCardImage creates the illustration for one card (D-048 第 9 节：逐卡生图).
func (s *Server) generateCardImage(w http.ResponseWriter, r *http.Request) error {
	m, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	if err := m.editable(); err != nil {
		return err
	}
	if m.ContentFormat != "card_post" {
		return validation("只有图文卡片作品可以生成卡片图")
	}
	sectionID, err := pathID(r, "sectionId")
	if err != nil {
		return err
	}
	ctx := r.Context()
	var heading, body string
	err = s.db.QueryRow(ctx, `SELECT heading, content_md FROM work_section WHERE id=$1 AND work_id=$2 AND deleted_at IS NULL`,
		sectionID, m.ID).Scan(&heading, &body)
	if err != nil {
		return validation("卡片不存在或不属于这篇作品")
	}
	var in struct {
		Prompt string `json:"prompt"`
		Size   string `json:"size"`
	}
	_ = decode(r, &in)
	prompt := strings.TrimSpace(in.Prompt)
	if prompt == "" {
		prompt = fmt.Sprintf("信息卡片插画。卡片标题：%s；卡片内容：%s。扁平插画风，构图干净，留出文字空间，画面中不要出现文字。", truncate(heading, 40), truncate(body, 120))
	}
	asset, err := s.runImageGen(ctx, m.Account, &m.ID, prompt, in.Size)
	if err != nil {
		return err
	}
	err = s.withTx(ctx, func(tx pgx.Tx) error {
		// 与排序共用专用事务锁；不改变正文保存的段落→作品锁顺序。
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('card-order:' || $1::text,0))`, m.ID.String()); err != nil {
			return err
		}
		var position int
		if err := tx.QueryRow(ctx, `SELECT position FROM work_section WHERE id=$1 AND work_id=$2 AND deleted_at IS NULL`, sectionID, m.ID).Scan(&position); err != nil {
			return validation("卡片已删除或不属于这篇作品")
		}
		_, err := tx.Exec(ctx, `INSERT INTO work_card (work_id, section_id, position, image_asset_id) VALUES ($1,$2,$3,$4)
			ON CONFLICT (work_id, section_id) DO UPDATE SET image_asset_id=$4, position=$3, updated_at=now()`, m.ID, sectionID, position, asset.ID)
		return err
	})
	if err != nil {
		return err
	}
	s.audit(ctx, "card_image_gen", "work_card", m.ID.String(), "ok", map[string]any{"asset_id": asset.ID.String()})
	return ok(w, map[string]any{"asset": asset, "image_url": "/api/v1/assets/" + asset.ID.String() + "/file"})
}
