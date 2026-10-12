package app

import (
	"context"

	"github.com/jackc/pgx/v5"
)

func (s *Server) checkWorkRevision(ctx context.Context, tx pgx.Tx, m *workMeta, base *int) error {
	expected := m.Revision
	if base != nil {
		expected = *base
	}
	var current int
	if err := tx.QueryRow(ctx, `SELECT revision FROM work WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, m.ID).Scan(&current); err != nil {
		return err
	}
	if current != expected {
		work, err := s.loadWork(ctx, m.ID)
		if err != nil {
			return err
		}
		return apiErr(409, "version_conflict", "这篇作品已在其他地方修改过").With(map[string]any{"server": work})
	}
	return nil
}

func lockWorkSections(ctx context.Context, tx pgx.Tx, m *workMeta) error {
	rows, err := tx.Query(ctx, `SELECT id FROM work_section WHERE work_id=$1 AND deleted_at IS NULL ORDER BY id FOR UPDATE`, m.ID)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
	}
	return rows.Err()
}
