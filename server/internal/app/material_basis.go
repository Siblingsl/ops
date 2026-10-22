package app

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"ops/internal/secure"
)

const materialBasisAlgorithm = "cl06-material-basis-v1"

type materialBasisQuerier interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
	QueryRow(context.Context, string, ...any) pgx.Row
}

type materialBasisReference struct {
	Scope       string `json:"scope"`
	MaterialID  string `json:"material_id"`
	Exists      bool   `json:"exists"`
	Visible     bool   `json:"visible"`
	WorkspaceID string `json:"workspace_id"`
	AccountID   string `json:"account_id"`
	Content     string `json:"content"`
	Source      string `json:"source"`
	ValidUntil  string `json:"valid_until"`
	Expired     bool   `json:"expired"`
	Deleted     bool   `json:"deleted"`
}

type materialBasisSnapshot struct {
	Algorithm  string                   `json:"algorithm"`
	References []materialBasisReference `json:"references"`
}

// materialBasisHash includes factual material fields and reference scope, while
// deliberately excluding tags, ordering, and the current calendar date.
func (s *Server) materialBasisHash(ctx context.Context, q materialBasisQuerier, workID uuid.UUID, lockMaterials bool) (string, error) {
	refs := make([]materialBasisReference, 0)
	rows, err := q.Query(ctx, `SELECT refs.scope, refs.material_id
		FROM (
			SELECT 'work'::text AS scope, wm.material_id
			FROM work_material wm WHERE wm.work_id=$1
			UNION
			SELECT 'section:' || ws.id::text AS scope, mids.material_id
			FROM work_section ws CROSS JOIN LATERAL unnest(ws.material_ids) AS mids(material_id)
			WHERE ws.work_id=$1 AND ws.deleted_at IS NULL
		) refs
		ORDER BY refs.scope, refs.material_id`, workID)
	if err != nil {
		return "", err
	}
	for rows.Next() {
		var ref materialBasisReference
		var materialID uuid.UUID
		if err := rows.Scan(&ref.Scope, &materialID); err != nil {
			rows.Close()
			return "", err
		}
		ref.MaterialID = materialID.String()
		refs = append(refs, ref)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return "", err
	}
	rows.Close()

	if lockMaterials && len(refs) > 0 {
		tx, ok := q.(pgx.Tx)
		if !ok {
			return "", fmt.Errorf("material basis locking requires a transaction")
		}
		ids := make([]uuid.UUID, 0, len(refs))
		seen := make(map[uuid.UUID]bool, len(refs))
		for _, ref := range refs {
			id, err := uuid.Parse(ref.MaterialID)
			if err != nil {
				return "", err
			}
			if !seen[id] {
				ids = append(ids, id)
				seen[id] = true
			}
		}
		lockRows, err := tx.Query(ctx, `SELECT id FROM material WHERE id=ANY($1) ORDER BY id FOR SHARE`, ids)
		if err != nil {
			return "", err
		}
		for lockRows.Next() {
			var id uuid.UUID
			if err := lockRows.Scan(&id); err != nil {
				lockRows.Close()
				return "", err
			}
		}
		if err := lockRows.Err(); err != nil {
			lockRows.Close()
			return "", err
		}
		lockRows.Close()
	}

	rows, err = q.Query(ctx, `WITH refs AS (
			SELECT 'work'::text AS scope, wm.material_id
			FROM work_material wm WHERE wm.work_id=$1
			UNION
			SELECT 'section:' || ws.id::text AS scope, mids.material_id
			FROM work_section ws CROSS JOIN LATERAL unnest(ws.material_ids) AS mids(material_id)
			WHERE ws.work_id=$1 AND ws.deleted_at IS NULL
		), basis AS (
			SELECT refs.scope, refs.material_id, m.id IS NOT NULL AS exists,
				COALESCE(m.workspace_id::text,'') AS workspace_id, COALESCE(m.account_id::text,'') AS account_id,
				(m.id IS NOT NULL AND m.deleted_at IS NULL AND m.workspace_id=a.workspace_id
					AND (m.account_id IS NULL OR m.account_id=w.account_id)) AS visible,
				m.content, m.source, m.valid_until, m.deleted_at
			FROM refs JOIN work w ON w.id=$1 JOIN platform_account a ON a.id=w.account_id
			LEFT JOIN material m ON m.id=refs.material_id
		)
		SELECT scope, material_id, exists, visible, workspace_id, account_id,
			CASE WHEN visible THEN COALESCE(content,'') ELSE '' END,
			CASE WHEN visible THEN COALESCE(source,'') ELSE '' END,
			CASE WHEN visible THEN COALESCE(to_char(valid_until,'YYYY-MM-DD'),'') ELSE '' END,
			CASE WHEN visible THEN COALESCE(valid_until < $2::date,false) ELSE false END,
			COALESCE(deleted_at IS NOT NULL,false)
		FROM basis ORDER BY scope, material_id`, workID, s.today())
	if err != nil {
		return "", err
	}
	refs = refs[:0]
	for rows.Next() {
		var ref materialBasisReference
		var materialID uuid.UUID
		if err := rows.Scan(&ref.Scope, &materialID, &ref.Exists, &ref.Visible, &ref.WorkspaceID, &ref.AccountID, &ref.Content,
			&ref.Source, &ref.ValidUntil, &ref.Expired, &ref.Deleted); err != nil {
			rows.Close()
			return "", err
		}
		ref.MaterialID = materialID.String()
		refs = append(refs, ref)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return "", err
	}
	rows.Close()

	b, err := json.Marshal(materialBasisSnapshot{Algorithm: materialBasisAlgorithm, References: refs})
	if err != nil {
		return "", err
	}
	return secure.SHA256Hex(b), nil
}

func materialBasisUnavailableCount(ctx context.Context, q materialBasisQuerier, workID uuid.UUID) (int, error) {
	var count int
	err := q.QueryRow(ctx, `WITH refs AS (
			SELECT 'work'::text AS scope, wm.material_id FROM work_material wm WHERE wm.work_id=$1
			UNION
			SELECT 'section:' || ws.id::text AS scope, mids.material_id
			FROM work_section ws CROSS JOIN LATERAL unnest(ws.material_ids) AS mids(material_id)
			WHERE ws.work_id=$1 AND ws.deleted_at IS NULL
		)
		SELECT count(*) FROM refs
		JOIN work w ON w.id=$1
		JOIN platform_account a ON a.id=w.account_id
		LEFT JOIN material m ON m.id=refs.material_id
		WHERE m.id IS NULL OR m.deleted_at IS NOT NULL OR m.workspace_id<>a.workspace_id
			OR (m.account_id IS NOT NULL AND m.account_id<>w.account_id)`, workID).Scan(&count)
	return count, err
}

func (s *Server) checkRunMaterialBasis(ctx context.Context, tx pgx.Tx, workID, runID uuid.UUID) error {
	var runRevision, workRevision int
	if err := tx.QueryRow(ctx, `SELECT revision FROM check_run WHERE id=$1 AND work_id=$2`, runID, workID).Scan(&runRevision); err != nil {
		return err
	}
	if err := tx.QueryRow(ctx, `SELECT revision FROM work WHERE id=$1`, workID).Scan(&workRevision); err != nil {
		return err
	}
	if runRevision != workRevision {
		return stateInvalid("内容在检查后又修改过，请重新检查")
	}
	matches, err := s.runMaterialBasisMatches(ctx, tx, workID, runID)
	if err != nil {
		return err
	}
	if !matches {
		return materialBasisStaleError()
	}
	return nil
}

func lockMaterialRowsForShare(ctx context.Context, tx pgx.Tx, workspaceID, accountID uuid.UUID, ids []uuid.UUID) error {
	if len(ids) == 0 {
		return nil
	}
	rows, err := tx.Query(ctx, `SELECT id FROM material WHERE id=ANY($1) AND workspace_id=$2 AND deleted_at IS NULL
		AND (account_id IS NULL OR account_id=$3) ORDER BY id FOR SHARE`, ids, workspaceID, accountID)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return err
		}
	}
	return rows.Err()
}

func (s *Server) runMaterialBasisMatches(ctx context.Context, tx pgx.Tx, workID, runID uuid.UUID) (bool, error) {
	var saved string
	if err := tx.QueryRow(ctx, `SELECT material_basis_hash FROM check_run WHERE id=$1 AND work_id=$2`, runID, workID).Scan(&saved); err != nil {
		return false, err
	}
	current, err := s.materialBasisHash(ctx, tx, workID, true)
	if err != nil {
		return false, err
	}
	return saved != "" && saved == current, nil
}

func (s *Server) checkLatestMaterialBasis(ctx context.Context, tx pgx.Tx, workID uuid.UUID) error {
	var runID uuid.UUID
	var runRevision, workRevision int
	err := tx.QueryRow(ctx, `SELECT id, revision FROM check_run WHERE work_id=$1 AND completed_at IS NOT NULL
		ORDER BY revision DESC, created_at DESC LIMIT 1`, workID).Scan(&runID, &runRevision)
	if err == pgx.ErrNoRows {
		return humanStep("H-04", "请先完成发布前检查")
	}
	if err != nil {
		return err
	}
	if err := tx.QueryRow(ctx, `SELECT revision FROM work WHERE id=$1`, workID).Scan(&workRevision); err != nil {
		return err
	}
	if runRevision != workRevision {
		return stateInvalid("内容在检查后又修改过，请重新检查")
	}
	return s.checkRunMaterialBasis(ctx, tx, workID, runID)
}

func (s *Server) latestMaterialBasisState(ctx context.Context, q materialBasisQuerier, workID uuid.UUID) (bool, bool, bool, error) {
	var saved string
	var runRevision, workRevision int
	err := q.QueryRow(ctx, `SELECT material_basis_hash, revision FROM check_run WHERE work_id=$1 AND completed_at IS NOT NULL
		ORDER BY revision DESC, created_at DESC LIMIT 1`, workID).Scan(&saved, &runRevision)
	if err == pgx.ErrNoRows {
		return false, false, false, nil
	}
	if err != nil {
		return false, false, false, err
	}
	if err := q.QueryRow(ctx, `SELECT revision FROM work WHERE id=$1`, workID).Scan(&workRevision); err != nil {
		return true, false, false, err
	}
	if runRevision != workRevision {
		return true, false, true, nil
	}
	current, err := s.materialBasisHash(ctx, q, workID, false)
	if err != nil {
		return true, false, false, err
	}
	return true, saved == "" || saved != current, false, nil
}

func materialBasisStaleError() error {
	return apiErr(409, "material_basis_stale", "素材依据已变化，需重新检查")
}
