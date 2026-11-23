package app

// REF41 F2：账号合并与停用影响清单。
// - preview：只读计数（作品/选题/素材/指标/评论簇/竞对目标/发布任务/manifest/构建/连接/热点）；
// - merge：同工作区同平台校验 → 事务内逐表迁移（publish_task 按 (work_id,platform) 唯一冲突不覆盖）→
//   源账号 disabled（不删除）→ account_merge_log completed + 审计 + owner 通知；
// - 失败整体回滚不留半迁移；幂等（源已 disabled → 直接返回最近一次 completed 记录）。
// - 停用复用既有 updateAccount status=disabled 语义；本文件提供 deactivation-preview 只读清单。

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// accountDeactivationPreview 停用/删除前影响清单（只读计数）。
type accountDeactivationPreview struct {
	AccountID      uuid.UUID `json:"account_id"`
	Platform       string    `json:"platform"`
	Status         string    `json:"status"`
	Works          int64     `json:"works"`
	Topics         int64     `json:"topics"`
	Materials      int64     `json:"materials"`
	Metrics        int64     `json:"metrics"`
	CommentCluster int64     `json:"comment_clusters"`
	Benchmark      int64     `json:"benchmark_targets"`
	PublishTasks   int64     `json:"publish_tasks"`
	PublishManifests int64   `json:"publish_manifests"`
	WorkBuilds     int64     `json:"work_builds"`
	Connections    int64     `json:"connections"`
	HotMatches     int64     `json:"hot_matches"`
	ActiveTasks    int64     `json:"active_tasks"`
}

// accountDeactivationPreviewHandler GET /accounts/{accountId}/deactivation-preview。
func (s *Server) accountDeactivationPreviewHandler(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireOwner(r.Context()); err != nil {
		return err
	}
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	p, err := s.accountMergePreviewCounts(r.Context(), a.ID)
	if err != nil {
		return err
	}
	p.Platform = a.Platform
	p.Status = a.Status
	writeJSON(w, http.StatusOK, p)
	return nil
}

// accountMergePreviewCounts 各表计数（全部限定 account_id）。
func (s *Server) accountMergePreviewCounts(ctx context.Context, accountID uuid.UUID) (*accountDeactivationPreview, error) {
	p := &accountDeactivationPreview{AccountID: accountID}
	count := func(dst *int64, query string) error {
		return s.db.QueryRow(ctx, query, accountID).Scan(dst)
	}
	if err := count(&p.Works, `SELECT count(*) FROM work WHERE account_id=$1 AND deleted_at IS NULL`); err != nil {
		return nil, err
	}
	if err := count(&p.Topics, `SELECT count(*) FROM topic WHERE account_id=$1 AND deleted_at IS NULL`); err != nil {
		return nil, err
	}
	if err := count(&p.Materials, `SELECT count(*) FROM material WHERE account_id=$1 AND deleted_at IS NULL`); err != nil {
		return nil, err
	}
	if err := count(&p.Metrics, `SELECT count(*) FROM platform_metric_observation WHERE account_id=$1`); err != nil {
		return nil, err
	}
	if err := count(&p.CommentCluster, `SELECT count(*) FROM comment_question_cluster WHERE account_id=$1`); err != nil {
		return nil, err
	}
	if err := count(&p.Benchmark, `SELECT count(*) FROM benchmark_target WHERE account_id=$1 AND archived_at IS NULL`); err != nil {
		return nil, err
	}
	if err := count(&p.PublishTasks, `SELECT count(*) FROM publish_task WHERE account_id=$1`); err != nil {
		return nil, err
	}
	if err := count(&p.PublishManifests, `SELECT count(*) FROM publish_manifest WHERE account_id=$1`); err != nil {
		return nil, err
	}
	if err := count(&p.WorkBuilds, `SELECT count(*) FROM work_build wb JOIN work w ON w.id=wb.work_id WHERE w.account_id=$1`); err != nil {
		return nil, err
	}
	if err := count(&p.Connections, `SELECT count(*) FROM platform_connection WHERE account_id=$1`); err != nil {
		return nil, err
	}
	if err := count(&p.HotMatches, `SELECT count(*) FROM account_hot_match WHERE account_id=$1`); err != nil {
		return nil, err
	}
	if err := count(&p.ActiveTasks, `SELECT count(*) FROM publish_task WHERE account_id=$1 AND state IN ('ready','queued','filling','filled','awaiting_user','submitted','scheduled')`); err != nil {
		return nil, err
	}
	return p, nil
}

// accountMerge POST /accounts/{accountId}/merge {source_account_id}：
// 目标=路径账号（接收方），源=body（被并入方）。同工作区、同平台、目标 active、源非合并中。
func (s *Server) accountMerge(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireOwner(r.Context()); err != nil {
		return err
	}
	target, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	var in struct {
		SourceAccountID string `json:"source_account_id"`
		Confirm         string `json:"confirm"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	if in.Confirm != "合并" {
		return validation("请输入确认词「合并」后执行")
	}
	sourceID, err := uuid.Parse(in.SourceAccountID)
	if err != nil {
		return validation("source_account_id 必须是 UUID")
	}
	if sourceID == target.ID {
		return validation("源账号与目标账号相同")
	}
	source, err := s.account(r.Context(), sourceID)
	if errors.Is(err, pgx.ErrNoRows) {
		return apiErr(http.StatusNotFound, "merge_source_not_found", "源账号不存在或属于其他工作区")
	}
	_ = source
	if err != nil {
		return err
	}
	if source.Platform != target.Platform {
		return apiErr(http.StatusUnprocessableEntity, "merge_platform_mismatch", "不允许跨平台合并")
	}
	if target.Status != "active" {
		return apiErr(http.StatusConflict, "merge_target_inactive", "目标账号必须为启用状态")
	}
	// 幂等：源已 disabled 且最近一次 completed → 直接返回该记录。
	if source.Status == "disabled" {
		var logID uuid.UUID
		var moved json.RawMessage
		err := s.db.QueryRow(r.Context(), `SELECT id, moved FROM account_merge_log
			WHERE workspace_id=$1 AND source_account_id=$2 AND target_account_id=$3 AND status='completed'
			ORDER BY created_at DESC LIMIT 1`, ident(r.Context()).WorkspaceID, sourceID, target.ID).
			Scan(&logID, &moved)
		if err == nil {
			writeJSON(w, http.StatusOK, map[string]any{"merge_id": logID, "moved": moved,
				"conflicts": json.RawMessage("[]"), "status": "completed", "idempotent": true})
			return nil
		}
	}
	// 事务：逐表迁移 + 冲突记录 + 源停用 + 日志 completed；失败整体回滚。
	tx, err := s.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer tx.Rollback(context.WithoutCancel(r.Context()))
	moved := map[string]int64{}
	conflicts := []map[string]any{}

	// publish_task：(work_id,platform) 唯一——目标已有同 work 任务 → 记冲突不迁移。
	rows, err := tx.Query(r.Context(), `SELECT pt.id, pt.work_id FROM publish_task pt
		WHERE pt.account_id=$1 AND EXISTS (SELECT 1 FROM publish_task t2
			WHERE t2.work_id=pt.work_id AND t2.platform=pt.platform AND t2.account_id=$2)`, sourceID, target.ID)
	if err != nil {
		return err
	}
	skipTask := map[uuid.UUID]bool{}
	for rows.Next() {
		var id, workID uuid.UUID
		if err := rows.Scan(&id, &workID); err != nil {
			rows.Close()
			return err
		}
		skipTask[id] = true
		conflicts = append(conflicts, map[string]any{"table": "publish_task", "work_id": workID,
			"reason": "target_already_has_task"})
	}
	rows.Close()
	var movedTasks int64
	tagTask, err := tx.Exec(r.Context(), `UPDATE publish_task SET account_id=$2, workspace_id=$3, updated_at=now()
		WHERE account_id=$1 AND NOT (id = ANY($4::uuid[]))`,
		sourceID, target.ID, ident(r.Context()).WorkspaceID, uuidSliceOrNil(skipTask))
	if err != nil {
		return err
	}
	movedTasks = tagTask.RowsAffected()
	moved["publish_task"] = movedTasks

	// 其余表按 account_id 直接迁移（无唯一键冲突语义）。
	for _, item := range []struct {
		table  string
		extra  string
		filter string
	}{
		{"work", "", " AND deleted_at IS NULL"},
		{"topic", "", " AND deleted_at IS NULL"},
		{"material", "", " AND deleted_at IS NULL"},
		{"platform_metric_observation", "workspace_id=$3, ", ""},
		{"comment_question_cluster", "workspace_id=$3, ", ""},
		{"benchmark_target", "", ""},
		{"publish_manifest", "workspace_id=$3, ", ""},
		{"account_hot_match", "", ""},
	} {
		var tag interface{ RowsAffected() int64 }
		var err error
		if item.extra != "" {
			// 表带 workspace_id 列：一并改到目标工作区（保持一致）。
			query := `UPDATE ` + item.table + ` SET ` + item.extra + `account_id=$2 WHERE account_id=$1` + item.filter
			tag, err = tx.Exec(r.Context(), query, sourceID, target.ID, ident(r.Context()).WorkspaceID)
		} else {
			query := `UPDATE ` + item.table + ` SET account_id=$2 WHERE account_id=$1` + item.filter
			tag, err = tx.Exec(r.Context(), query, sourceID, target.ID)
		}
		if err != nil {
			return err
		}
		moved[item.table] = tag.RowsAffected()
	}
	// work_build 挂 work（无 account_id 列）：经 work 归属迁移。
	tagBuilds, err := tx.Exec(r.Context(), `UPDATE work_build wb SET workspace_id=$2 FROM work w
		WHERE wb.work_id=w.id AND w.account_id=$1`, sourceID, ident(r.Context()).WorkspaceID)
	if err != nil {
		return err
	}
	movedBuilds := tagBuilds.RowsAffected()
	moved["work_build"] = movedBuilds
	// 连接迁移或停用：platform_connection 归目标。
	tagConn, err := tx.Exec(r.Context(), `UPDATE platform_connection SET account_id=$2 WHERE account_id=$1`,
		sourceID, target.ID)
	if err != nil {
		return err
	}
	movedConn := tagConn.RowsAffected()
	moved["platform_connection"] = movedConn
	// 源停用（不删除）。
	if _, err := tx.Exec(r.Context(), `UPDATE platform_account SET status='disabled', updated_at=now() WHERE id=$1`, sourceID); err != nil {
		return err
	}
	// 日志 completed + moved/conflicts。
	var logID uuid.UUID
	if err := tx.QueryRow(r.Context(), `INSERT INTO account_merge_log
		(workspace_id, source_account_id, target_account_id, status, moved, conflicts, requested_by, finished_at)
		VALUES ($1,$2,$3,'completed',$4,$5,$6,now()) RETURNING id`,
		ident(r.Context()).WorkspaceID, sourceID, target.ID, mustJSONMap(moved), mustJSONList(conflicts), ident(r.Context()).UserID).Scan(&logID); err != nil {
		return err
	}
	if err := tx.Commit(r.Context()); err != nil {
		return err
	}
	s.audit(r.Context(), "account_merge", "platform_account", target.ID.String(), "ok",
		map[string]any{"source": sourceID, "moved": moved, "conflicts": len(conflicts)})
	s.notifyWorkspace(r.Context(), ident(r.Context()).WorkspaceID, []string{"owner"}, "account_merge",
		"账号合并完成", "源账号已停用并并入目标账号；作品/选题/素材等已迁移，冲突项未覆盖。", "/accounts/"+target.ID.String(), "")
	writeJSON(w, http.StatusOK, map[string]any{"merge_id": logID, "moved": moved, "conflicts": conflicts, "status": "completed"})
	return nil
}

// uuidSliceOrNil 空→空数组（NOT (id = ANY(NULL)) 会全为 NULL 导致 0 行更新）；
// 非空→数组。
func uuidSliceOrNil(set map[uuid.UUID]bool) any {
	out := make([]uuid.UUID, 0, len(set))
	for id := range set {
		out = append(out, id)
	}
	return out
}

func mustJSONMap(v map[string]int64) json.RawMessage {
	b, _ := json.Marshal(v)
	return json.RawMessage(b)
}

func mustJSONList(v []map[string]any) json.RawMessage {
	b, _ := json.Marshal(v)
	return json.RawMessage(b)
}

// mergeLogList GET /accounts/{accountId}/merge-logs：最近合并记录。
func (s *Server) mergeLogList(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireOwner(r.Context()); err != nil {
		return err
	}
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	rows, err := s.db.Query(r.Context(), `SELECT id, source_account_id, target_account_id, status, moved, conflicts, created_at, finished_at
		FROM account_merge_log WHERE workspace_id=$1 AND (source_account_id=$2 OR target_account_id=$2)
		ORDER BY created_at DESC LIMIT 20`, ident(r.Context()).WorkspaceID, a.ID)
	if err != nil {
		return err
	}
	defer rows.Close()
	type logRow struct {
		ID         uuid.UUID  `json:"id"`
		Source     uuid.UUID  `json:"source_account_id"`
		Target     uuid.UUID  `json:"target_account_id"`
		Status     string     `json:"status"`
		Moved      json.RawMessage `json:"moved"`
		Conflicts  json.RawMessage `json:"conflicts"`
		CreatedAt  time.Time  `json:"created_at"`
		FinishedAt *time.Time `json:"finished_at,omitempty"`
	}
	list := []logRow{}
	for rows.Next() {
		var item logRow
		if err := rows.Scan(&item.ID, &item.Source, &item.Target, &item.Status, &item.Moved, &item.Conflicts, &item.CreatedAt, &item.FinishedAt); err != nil {
			return err
		}
		list = append(list, item)
	}
	writeJSON(w, http.StatusOK, map[string]any{"logs": list})
	return nil
}
