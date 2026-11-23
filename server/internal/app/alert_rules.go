package app

// REF41 F1：告警规则与 job。四种规则（job_failure_rate/publish_failure_count/
// model_5xx_count/health_failure_count）每 5 分钟聚合窗口内指标；超阈值 →
// alert_event upsert（dedupe=rule:{id}:{窗口桶}）→ notifyWorkspace(owner)；
// 恢复 → 同 dedupe 更新 resolved + 通知一次；0/0 不告警；规则关闭不发；
// 消息只含计数与规则，不含正文/密钥（redactString 兜底）。

import (
	"context"
	"net/http"

	"github.com/go-chi/chi/v5"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
)

const alertJobInterval = 5 * time.Minute

var alertRuleKeys = []string{"job_failure_rate", "publish_failure_count", "model_5xx_count", "health_failure_count"}

type alertRule struct {
	ID            uuid.UUID `json:"id"`
	Key           string    `json:"key"`
	Threshold     float64   `json:"threshold"`
	WindowMinutes int       `json:"window_minutes"`
	Enabled       bool      `json:"enabled"`
	UpdatedAt     string    `json:"updated_at"`
}

type alertEvent struct {
	ID         uuid.UUID `json:"id"`
	RuleID     uuid.UUID `json:"rule_id"`
	DedupeKey  string    `json:"dedupe_key"`
	Message    string    `json:"message"`
	State      string    `json:"state"`
	CreatedAt  string     `json:"created_at"`
	ResolvedAt *time.Time `json:"resolved_at,omitempty"`
}

// listAlertRules GET /alert-rules：规则列表（无则空，创建走 POST）。
func (s *Server) listAlertRules(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireEditor(r.Context()); err != nil {
		return err
	}
	rows, err := s.db.Query(r.Context(), `SELECT id, key, threshold, window_minutes, enabled, updated_at
		FROM alert_rule WHERE workspace_id=$1 ORDER BY key`, ident(r.Context()).WorkspaceID)
	if err != nil {
		return err
	}
	defer rows.Close()
	list := []alertRule{}
	for rows.Next() {
		var rule alertRule
		var updatedAt time.Time
		if err := rows.Scan(&rule.ID, &rule.Key, &rule.Threshold, &rule.WindowMinutes, &rule.Enabled, &updatedAt); err != nil {
			return err
		}
		rule.UpdatedAt = updatedAt.Format(time.RFC3339)
		list = append(list, rule)
	}
	writeJSON(w, http.StatusOK, map[string]any{"rules": list})
	return nil
}

// upsertAlertRule PUT /alert-rules/{key}：创建或更新单条规则（阈值/窗口/启停）。
func (s *Server) upsertAlertRule(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireEditor(r.Context()); err != nil {
		return err
	}
	key := chi.URLParam(r, "key")
	valid := false
	for _, k := range alertRuleKeys {
		if k == key {
			valid = true
			break
		}
	}
	if !valid {
		return validation("未知告警规则：" + key)
	}
	var in struct {
		Threshold     float64 `json:"threshold"`
		WindowMinutes int     `json:"window_minutes"`
		Enabled       *bool   `json:"enabled"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	if in.Threshold < 0 {
		return validation("阈值不能为负")
	}
	window := in.WindowMinutes
	if window == 0 {
		window = 60
	}
	if window < 5 || window > 1440 {
		return validation("窗口需在 5–1440 分钟之间")
	}
	enabled := true
	if in.Enabled != nil {
		enabled = *in.Enabled
	}
	tag, err := s.db.Exec(r.Context(), `INSERT INTO alert_rule (workspace_id, key, threshold, window_minutes, enabled)
		VALUES ($1,$2,$3,$4,$5)
		ON CONFLICT (workspace_id, key) DO UPDATE SET threshold=$3, window_minutes=$4, enabled=$5, updated_at=now()`,
		ident(r.Context()).WorkspaceID, key, in.Threshold, window, enabled)
	if err != nil {
		return err
	}
	_ = tag
	var id uuid.UUID
	if err := s.db.QueryRow(r.Context(), `SELECT id FROM alert_rule WHERE workspace_id=$1 AND key=$2`,
		ident(r.Context()).WorkspaceID, key).Scan(&id); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": id, "key": key,
		"threshold": in.Threshold, "window_minutes": window, "enabled": enabled})
	return nil
}

// listAlertEvents GET /alert-events：最近 20 条事件（firing+resolved）。
func (s *Server) listAlertEvents(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireEditor(r.Context()); err != nil {
		return err
	}
	rows, err := s.db.Query(r.Context(), `SELECT id, rule_id, dedupe_key, message, state, created_at, resolved_at
		FROM alert_event WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 20`, ident(r.Context()).WorkspaceID)
	if err != nil {
		return err
	}
	defer rows.Close()
	list := []alertEvent{}
	for rows.Next() {
		var ev alertEvent
		var createdAt time.Time
		if err := rows.Scan(&ev.ID, &ev.RuleID, &ev.DedupeKey, &ev.Message, &ev.State, &createdAt, &ev.ResolvedAt); err != nil {
			return err
		}
		ev.CreatedAt = createdAt.Format(time.RFC3339)
		list = append(list, ev)
	}
	writeJSON(w, http.StatusOK, map[string]any{"events": list})
	return nil
}

// alertEvaluate 单规则评估：返回 (当前值, 是否触发)。0/0（无数据）不告警。
// job_run 随 F3 落库前，job_failure_rate 恒无数据（返回 ok=false）。
func (s *Server) alertEvaluate(ctx context.Context, ws uuid.UUID, rule alertRule, now time.Time) (float64, bool) {
	windowStart := now.Add(-time.Duration(rule.WindowMinutes) * time.Minute)
	switch rule.Key {
	case "publish_failure_count":
		var failed int
		err := s.db.QueryRow(ctx, `SELECT count(*) FROM publish_task
			WHERE workspace_id=$1 AND state='failed' AND updated_at >= $2`, ws, windowStart).Scan(&failed)
		if err != nil {
			return 0, false
		}
		return float64(failed), float64(failed) > rule.Threshold
	case "model_5xx_count":
		var count int
		err := s.db.QueryRow(ctx, `SELECT count(*) FROM ai_call
			WHERE workspace_id=$1 AND status='error' AND created_at >= $2`, ws, windowStart).Scan(&count)
		if err != nil {
			return 0, false
		}
		return float64(count), float64(count) > rule.Threshold
	case "health_failure_count":
		var count int
		err := s.db.QueryRow(ctx, `SELECT count(*) FROM publish_health_check
			WHERE workspace_id=$1 AND state='failed' AND finished_at >= $2`, ws, windowStart).Scan(&count)
		if err != nil {
			return 0, false
		}
		return float64(count), float64(count) > rule.Threshold
	case "job_failure_rate":
		// job_run 由 F3 引入；表未建前无数据（不告警）。
		var exists bool
		if err := s.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name='job_run')`).Scan(&exists); err != nil || !exists {
			return 0, false
		}
		var total, failed int
		err := s.db.QueryRow(ctx, `SELECT count(*), count(*) FILTER (WHERE status='failed') FROM job_run
			WHERE workspace_id=$1 AND created_at >= $2`, ws, windowStart).Scan(&total, &failed)
		if err != nil || total == 0 {
			return 0, false // 0/0 不告警
		}
		rate := float64(failed) / float64(total)
		return rate, rate > rule.Threshold
	}
	return 0, false
}

// alertCheckJob 每 5 分钟：评估全部启用规则，触发/恢复写 alert_event 并通知 owner。
func (s *Server) alertCheckJob(ctx context.Context) {
	now := time.Now()
	rows, err := s.db.Query(ctx, `SELECT id, workspace_id, key, threshold, window_minutes, enabled
		FROM alert_rule WHERE enabled=true`)
	if err != nil {
		return
	}
	type row struct {
		rule alertRule
		ws   uuid.UUID
	}
	items := []row{}
	for rows.Next() {
		var item row
		var key string
		if err := rows.Scan(&item.rule.ID, &item.ws, &key, &item.rule.Threshold, &item.rule.WindowMinutes, &item.rule.Enabled); err != nil {
			rows.Close()
			return
		}
		item.rule.Key = key
		items = append(items, item)
	}
	rows.Close()
	for _, item := range items {
		value, firing := s.alertEvaluate(ctx, item.ws, item.rule, now)
		bucket := now.Unix() / int64(item.rule.WindowMinutes*60)
		dedupe := "rule:" + item.rule.ID.String() + ":" + strconv.FormatInt(bucket, 10)
		if firing {
			message := "告警「" + alertRuleLabel(item.rule.Key) + "」当前值 " + strconv.FormatFloat(value, 'f', -1, 64) +
				" 超过阈值 " + strconv.FormatFloat(item.rule.Threshold, 'f', -1, 64) +
				"（窗口 " + strconv.Itoa(item.rule.WindowMinutes) + " 分钟）"
			message = redactString(message)
			var fired bool
			err := s.db.QueryRow(ctx, `INSERT INTO alert_event (workspace_id, rule_id, dedupe_key, message, state)
				VALUES ($1,$2,$3,$4,'firing')
				ON CONFLICT (workspace_id, dedupe_key) DO UPDATE SET message=$4
				RETURNING (xmax = 0) AS inserted`, item.ws, item.rule.ID, dedupe, message).Scan(&fired)
			if err == nil && fired {
				s.notifyWorkspace(ctx, item.ws, []string{"owner"}, "alert",
					"告警触发", message, "/health", dedupe)
			}
		} else {
			// 恢复：该规则当前窗口桶之前的 firing 事件置 resolved 并通知一次。
			tag, err := s.db.Exec(ctx, `UPDATE alert_event SET state='resolved', resolved_at=now()
				WHERE workspace_id=$1 AND rule_id=$2 AND state='firing' AND created_at < $3`,
				item.ws, item.rule.ID, now.Add(-time.Duration(item.rule.WindowMinutes)*time.Minute))
			if err == nil && tag.RowsAffected() > 0 {
				s.notifyWorkspace(ctx, item.ws, []string{"owner"}, "alert",
					"告警恢复", "告警「"+alertRuleLabel(item.rule.Key)+"」已恢复（当前窗口内指标回到阈值以下）", "/health", "")
			}
		}
	}
}

func alertRuleLabel(key string) string {
	switch key {
	case "job_failure_rate":
		return "任务失败率"
	case "publish_failure_count":
		return "发布失败数"
	case "model_5xx_count":
		return "模型 5xx 数"
	case "health_failure_count":
		return "体检失败数"
	}
	return strings.ReplaceAll(key, "_", " ")
}

// ensureAlertRuleOf 便捷查询（测试用）。
func (s *Server) ensureAlertRuleOf(ctx context.Context, ws uuid.UUID, key string) (alertRule, error) {
	var rule alertRule
	var updatedAt time.Time
	err := s.db.QueryRow(ctx, `SELECT id, key, threshold, window_minutes, enabled, updated_at
		FROM alert_rule WHERE workspace_id=$1 AND key=$2`, ws, key).
		Scan(&rule.ID, &rule.Key, &rule.Threshold, &rule.WindowMinutes, &rule.Enabled, &updatedAt)
	return rule, err
}

// alertMonitorJob 每分钟触发、游标 5 分钟一轮（与 P7 巡检同游标口径）。
func (s *Server) alertMonitorJob(ctx context.Context) {
	if s.shouldRunPatrol(ctx, "alert_check", alertJobInterval) {
		s.touchJobMarker(ctx, "alert_check")
		s.alertCheckJob(ctx)
	}
}
