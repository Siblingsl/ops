package app

import (
	"context"
	"net/http"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"ops/internal/markdownsyntax"
)

func (s *Server) renderCheck(w http.ResponseWriter, r *http.Request) error {
	m, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	var in struct {
		BasisRevision int `json:"basis_revision"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	if in.BasisRevision < 1 {
		return validation("请提供当前作品版本")
	}

	ctx := r.Context()
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	var revision int
	if err := tx.QueryRow(ctx, `SELECT revision FROM work WHERE id=$1 AND deleted_at IS NULL`, m.ID).Scan(&revision); err != nil {
		return err
	}
	if revision != in.BasisRevision {
		return apiErr(409, "version_conflict", "作品已修改，请刷新后重新检查").With(map[string]int{"server_revision": revision})
	}
	sections, err := s.loadSections(ctx, tx, m.ID)
	if err != nil {
		return err
	}
	assets := make(map[string]bool)
	rows, err := tx.Query(ctx, `SELECT id FROM asset WHERE work_id=$1`, m.ID)
	if err != nil {
		return err
	}
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		assets[id.String()] = true
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	if err := tx.Commit(ctx); err != nil {
		return err
	}

	input := make([]markdownsyntax.Section, 0, len(sections))
	for _, section := range sections {
		input = append(input, markdownsyntax.Section{ID: section.ID.String(), Heading: section.Heading, Content: section.ContentMD})
	}
	report := markdownsyntax.Scan(input, revision, assets)
	var currentRevision int
	if err := s.db.QueryRow(ctx, `SELECT revision FROM work WHERE id=$1 AND deleted_at IS NULL`, m.ID).Scan(&currentRevision); err != nil {
		return err
	}
	if currentRevision != revision {
		return apiErr(409, "version_conflict", "作品在检查期间已修改，请重新检查").With(map[string]int{"server_revision": currentRevision})
	}
	if report.HasErrors {
		return apiErr(422, "render_unsupported_syntax", "当前稿件包含不能可靠排版的语法").With(report)
	}
	return ok(w, report)
}
