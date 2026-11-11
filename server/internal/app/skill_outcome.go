package app

import (
	"context"
	"encoding/json"
	"log/slog"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// DEEP-03：技能效果归因旁路。只聚合公共技能 ID，不进 lastPacks，不存个人正文。

type skillOutcomeHistory struct {
	Uses       int            `json:"uses"`
	Adopted    int            `json:"adopted"`
	Published  int            `json:"published"`
	AdoptRate  float64        `json:"adopt_rate"`
	ByTask     []skillOutcomeTaskStat `json:"by_task"`
}

type skillOutcomeTaskStat struct {
	TaskType  string  `json:"task_type"`
	Uses      int     `json:"uses"`
	Adopted   int     `json:"adopted"`
	Published int     `json:"published"`
	AdoptRate float64 `json:"adopt_rate"`
}

// recordSkillOutcomesFromSnap 在 ai_call 成功后旁路写入：仅 PublicItems 且 Used=true。
func (s *Server) recordSkillOutcomesFromSnap(ctx context.Context, callID uuid.UUID, workID *uuid.UUID, taskType string, snap *SkillSnapshot) {
	if snap == nil || callID == uuid.Nil {
		return
	}
	ws := snap.Input.WorkspaceID
	if ws == uuid.Nil {
		if id := ident(ctx); id != nil {
			ws = id.WorkspaceID
		}
	}
	if ws == uuid.Nil {
		return
	}
	for _, it := range snap.PublicItems {
		if !it.Used || it.ID == uuid.Nil || it.Scope == "personal" {
			continue
		}
		_, err := s.db.Exec(context.WithoutCancel(ctx), `
			INSERT INTO skill_outcome (workspace_id, skill_id, task_type, ai_call_id, work_id)
			VALUES ($1,$2,$3,$4,$5)
			ON CONFLICT (ai_call_id, skill_id) WHERE ai_call_id IS NOT NULL DO NOTHING`,
			ws, it.ID, taskType, callID, workID)
		if err != nil {
			slog.Warn("skill_outcome 采样失败", "err", err, "skill_id", it.ID, "ai_call_id", callID)
		}
	}
}

// markSkillOutcomesAdopted 在 ai_feedback 为 accepted/edited 时旁路打标。
func (s *Server) markSkillOutcomesAdopted(ctx context.Context, callID uuid.UUID) {
	if callID == uuid.Nil {
		return
	}
	_, err := s.db.Exec(context.WithoutCancel(ctx), `
		UPDATE skill_outcome SET adopted=true, updated_at=now()
		WHERE ai_call_id=$1 AND adopted=false`, callID)
	if err != nil {
		slog.Warn("skill_outcome 采用标记失败", "err", err, "ai_call_id", callID)
	}
}

// markSkillOutcomesPublishedTx 作品标记已发布时，把关联 ai_call 的 outcome 打 published。
// 只写聚合标记与极简 metric_snapshot（ID/状态），不含正文。
func (s *Server) markSkillOutcomesPublishedTx(ctx context.Context, tx pgx.Tx, workID uuid.UUID) error {
	snap, _ := json.Marshal(map[string]any{"work_id": workID, "status": "published"})
	_, err := tx.Exec(ctx, `
		UPDATE skill_outcome o SET published=true, metric_snapshot=$2, updated_at=now()
		FROM ai_call c
		WHERE o.ai_call_id=c.id AND c.work_id=$1 AND o.published=false`,
		workID, snap)
	return err
}

// skillOutcomeWeights 按工作区+任务类型汇总有效性权重；查询失败返回空表，不阻断解析。
// 权重：uses + 2*adopted + 3*published；仅用于同层同 priority 的次级排序。
func skillOutcomeWeights(ctx context.Context, q skillQuerier, workspaceID uuid.UUID, taskType string, ids []uuid.UUID) map[uuid.UUID]int64 {
	out := map[uuid.UUID]int64{}
	if workspaceID == uuid.Nil || len(ids) == 0 {
		return out
	}
	rows, err := q.Query(ctx, `
		SELECT skill_id,
			count(*)::bigint + 2*count(*) FILTER (WHERE adopted)::bigint + 3*count(*) FILTER (WHERE published)::bigint
		FROM skill_outcome
		WHERE workspace_id=$1 AND skill_id = ANY($2) AND ($3='' OR task_type=$3)
		GROUP BY skill_id`, workspaceID, ids, taskType)
	if err != nil {
		slog.Warn("skill_outcome 权重查询失败", "err", err)
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var id uuid.UUID
		var w int64
		if err := rows.Scan(&id, &w); err != nil {
			slog.Warn("skill_outcome 权重扫描失败", "err", err)
			return out
		}
		out[id] = w
	}
	return out
}

func (s *Server) loadSkillOutcomeHistory(ctx context.Context, workspaceID, skillID uuid.UUID) (skillOutcomeHistory, error) {
	h := skillOutcomeHistory{ByTask: []skillOutcomeTaskStat{}}
	rows, err := s.db.Query(ctx, `
		SELECT task_type, count(*)::int, count(*) FILTER (WHERE adopted)::int, count(*) FILTER (WHERE published)::int
		FROM skill_outcome
		WHERE workspace_id=$1 AND skill_id=$2
		GROUP BY task_type
		ORDER BY task_type`, workspaceID, skillID)
	if err != nil {
		return h, err
	}
	defer rows.Close()
	for rows.Next() {
		var st skillOutcomeTaskStat
		if err := rows.Scan(&st.TaskType, &st.Uses, &st.Adopted, &st.Published); err != nil {
			return h, err
		}
		if st.Uses > 0 {
			st.AdoptRate = float64(st.Adopted) / float64(st.Uses)
		}
		h.Uses += st.Uses
		h.Adopted += st.Adopted
		h.Published += st.Published
		h.ByTask = append(h.ByTask, st)
	}
	if err := rows.Err(); err != nil {
		return h, err
	}
	if h.Uses > 0 {
		h.AdoptRate = float64(h.Adopted) / float64(h.Uses)
	}
	return h, nil
}
