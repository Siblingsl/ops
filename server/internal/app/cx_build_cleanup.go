package app

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type cxBuildCleanupItem struct {
	ID          uuid.UUID
	WorkspaceID uuid.UUID
}

// cleanupCXBuilds expires running work, then removes staged and expired artifact
// files before deleting their database indexes. Pending cleanup is retried after
// process crashes and filesystem errors.
func (s *Server) cleanupCXBuilds(ctx context.Context) (int, error) {
	now := s.now()
	var items []cxBuildCleanupItem
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	if _, err := tx.Exec(ctx, `UPDATE work_build SET status='failed',reusable=false,error_code='build_timeout',finished_at=$1
		WHERE status='running' AND deadline_at<=$1`, now); err != nil {
		return 0, err
	}
	rows, err := tx.Query(ctx, `SELECT id,workspace_id FROM work_build
		WHERE cleanup_state='pending'
			OR (cleanup_state='active' AND status='failed' AND finished_at<=$1::timestamptz-interval '24 hours')
			OR (cleanup_state='active' AND status='built' AND expires_at<=$1)
		ORDER BY coalesce(expires_at,finished_at),id
		LIMIT 100 FOR UPDATE SKIP LOCKED`, now)
	if err != nil {
		return 0, err
	}
	for rows.Next() {
		var item cxBuildCleanupItem
		if err := rows.Scan(&item.ID, &item.WorkspaceID); err != nil {
			rows.Close()
			return 0, err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return 0, err
	}
	rows.Close()
	for _, item := range items {
		if _, err := tx.Exec(ctx, `UPDATE work_build SET cleanup_state='pending',reusable=false WHERE id=$1`, item.ID); err != nil {
			return 0, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}

	cleaned := 0
	for _, item := range items {
		if err := s.cxDeleteBuildArtifactFiles(ctx, item.ID, item.WorkspaceID); err != nil {
			return cleaned, err
		}
		if err := s.withTx(ctx, func(tx pgx.Tx) error {
			if _, err := tx.Exec(ctx, `DELETE FROM work_build_artifact WHERE build_id=$1 AND workspace_id=$2`, item.ID, item.WorkspaceID); err != nil {
				return err
			}
			_, err := tx.Exec(ctx, `UPDATE work_build SET cleanup_state='done' WHERE id=$1 AND workspace_id=$2 AND cleanup_state='pending'`, item.ID, item.WorkspaceID)
			return err
		}); err != nil {
			return cleaned, err
		}
		cleaned++
	}
	return cleaned, nil
}

func (s *Server) cxDeleteBuildArtifactFiles(ctx context.Context, buildID, workspaceID uuid.UUID) error {
	rows, err := s.db.Query(ctx, `SELECT id,storage_path FROM work_build_artifact WHERE build_id=$1 AND workspace_id=$2`, buildID, workspaceID)
	if err != nil {
		return err
	}
	type artifactFile struct {
		id   uuid.UUID
		path string
	}
	files := []artifactFile{}
	for rows.Next() {
		var file artifactFile
		if err := rows.Scan(&file.id, &file.path); err != nil {
			rows.Close()
			return err
		}
		files = append(files, file)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	for _, file := range files {
		if file.path != cxBuildStoragePath(workspaceID, buildID, file.id) {
			return fmt.Errorf("构建产物存储路径与受控前缀不符: build=%s artifact=%s", buildID, file.id)
		}
		full := filepath.Join(s.cfg.DataDir, filepath.FromSlash(file.path))
		if err := os.Remove(full); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("删除构建产物失败: build=%s artifact=%s: %w", buildID, file.id, err)
		}
	}
	return nil
}

// purgeCXBuildsForWork is called before hard deletion of a soft-deleted work.
// It preserves indexes until every indexed file is safely removed.
func (s *Server) purgeCXBuildsForWork(ctx context.Context, workID uuid.UUID) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	rows, err := tx.Query(ctx, `SELECT id,workspace_id FROM work_build WHERE work_id=$1 FOR UPDATE`, workID)
	if err != nil {
		return err
	}
	items := []cxBuildCleanupItem{}
	for rows.Next() {
		var item cxBuildCleanupItem
		if err := rows.Scan(&item.ID, &item.WorkspaceID); err != nil {
			rows.Close()
			return err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	if _, err := tx.Exec(ctx, `UPDATE work_build SET status=CASE WHEN status='running' THEN 'failed' ELSE status END,
		reusable=false,error_code=CASE WHEN status='running' THEN 'build_cancelled' ELSE error_code END,
		finished_at=CASE WHEN status='running' THEN now() ELSE finished_at END,cleanup_state='pending' WHERE work_id=$1`, workID); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	for _, item := range items {
		if err := s.cxDeleteBuildArtifactFiles(ctx, item.ID, item.WorkspaceID); err != nil {
			return err
		}
	}
	return s.withTx(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `DELETE FROM work_build_artifact WHERE build_id IN (SELECT id FROM work_build WHERE work_id=$1)`, workID); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `DELETE FROM work_build WHERE work_id=$1`, workID)
		return err
	})
}
