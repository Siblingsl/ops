package app

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const (
	platformDailyRunsPerSubject       = 3
	platformDailyWorkAttempts         = 60
	platformDailyDataQueries          = 300
	platformQueryPacing               = 5 * time.Second
	platformRunStaticRequests         = 500
	platformRunStaticBytes      int64 = 50 << 20
)

type platformBudgetDecision struct {
	Allowed       bool       `json:"allowed"`
	Reason        string     `json:"reason,omitempty"`
	NextAllowedAt *time.Time `json:"next_allowed_at,omitempty"`
}

type platformHeartbeatBudgetRequest struct {
	Kind        string `json:"kind"`
	WorkAttempt bool   `json:"work_attempt,omitempty"`
	Requests    int    `json:"requests,omitempty"`
	Bytes       int64  `json:"bytes,omitempty"`
}

func (s *Server) reservePlatformBudget(ctx context.Context, runID, deviceID uuid.UUID, generation int64, request platformHeartbeatBudgetRequest) (platformBudgetDecision, error) {
	if request.Kind != "data_query" && request.Kind != "static_resource" {
		return platformBudgetDecision{}, validation("预算请求类型无效")
	}
	if request.Kind == "data_query" && (request.Requests != 0 || request.Bytes != 0) {
		return platformBudgetDecision{}, validation("data_query 不接受静态资源计数")
	}
	if request.Kind == "static_resource" && (request.WorkAttempt || request.Requests <= 0 || request.Bytes < 0) {
		return platformBudgetDecision{}, validation("static_resource 计数无效")
	}
	decision := platformBudgetDecision{}
	err := s.withTx(ctx, func(tx pgx.Tx) error {
		var err error
		decision, err = s.reservePlatformRunQuery(ctx, tx, runID, deviceID, generation,
			request.WorkAttempt, request.Requests, request.Bytes, s.now())
		return err
	})
	return decision, err
}

func platformSubjectLock(ctx context.Context, tx pgx.Tx, platform, externalAccountKey string) error {
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
		"platform-subject:"+platform+":"+externalAccountKey)
	return err
}

func (s *Server) platformSubjectDailyUsage(ctx context.Context, tx pgx.Tx, platform, externalAccountKey string, now time.Time) (runs, queries, workAttempts int, err error) {
	start := platformBudgetDayStart(now)
	err = tx.QueryRow(ctx, `SELECT count(*)::int,coalesce(sum(r.budget_query_count),0)::int,
		coalesce(sum(r.budget_work_attempts),0)::int
		FROM platform_sync_run r JOIN platform_connection c ON c.id=r.connection_id
		WHERE c.platform=$1 AND c.external_account_key=$2 AND r.created_at >= $3`,
		platform, externalAccountKey, start).Scan(&runs, &queries, &workAttempts)
	return
}

func platformBudgetDayStart(now time.Time) time.Time {
	loc, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		loc = time.FixedZone("CST", 8*60*60)
	}
	local := now.In(loc)
	return time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, loc)
}

func platformBudgetNextWindow(now time.Time) time.Time {
	loc, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		loc = time.FixedZone("CST", 8*60*60)
	}
	local := now.In(loc)
	today := time.Date(local.Year(), local.Month(), local.Day(), platformDailyWindowStart, 0, 0, 0, loc)
	if local.Before(today) {
		return today
	}
	return today.AddDate(0, 0, 1)
}

// platformCanReserveRun 是**当前唯一真正生效**的预算闸门：每主体（platform +
// external_account_key）每天的 run 数上限，取 `min(硬常量, 工作区策略)`。
//
// 另一层 `reservePlatformRunQuery` 里的查询/作品预算尚未接线（客户端从不发
// budget_request），不要以为那里也在把关。详见 docs/21 十七点三十七。
func (s *Server) platformCanReserveRun(ctx context.Context, tx pgx.Tx, workspaceID uuid.UUID, platform, externalAccountKey string, now time.Time) (bool, time.Time, error) {
	var dailyRunLimit int
	if err := tx.QueryRow(ctx, `SELECT daily_run_limit FROM platform_collection_policy WHERE workspace_id=$1`, workspaceID).Scan(&dailyRunLimit); err != nil {
		return false, time.Time{}, err
	}
	if !platformWithinDailyWindow(now, s.loc) {
		return false, platformBudgetNextWindow(now), nil
	}
	runs, _, _, err := s.platformSubjectDailyUsage(ctx, tx, platform, externalAccountKey, now)
	if err != nil {
		return false, time.Time{}, err
	}
	if runs >= minInt(platformDailyRunsPerSubject, dailyRunLimit) {
		return false, platformBudgetNextWindow(now), nil
	}
	return true, time.Time{}, nil
}

// reservePlatformRunQuery 是**当前未接线**的预算校验（20 文档 §13.3）。
//
// ⚠️ 这里面的六道闸门（单 run 100 查询 / 20 作品 / 500 静态请求 / 50MB 静态字节，
// 以及按主体的日 300 查询 / 60 作品）**目前一道都不生效**：
// 调用链是 reservePlatformRunQuery ← reservePlatformBudget ← 心跳 handler
// （且被 `in.BudgetRequest != nil` 门控），而桌面端客户端从不发送 budget_request
// （`desktop/src` 全仓搜索零命中，心跳 payload 只有 lease_generation）。
//
// 连带后果：`budget_query_count` 是建 run 时**预扣**的 100，不会随真实读取累加，
// 所以日查询量账本与平台侧真实请求量完全脱节。当前实际生效的只有
// `platformCanReserveRun` 的"每主体每天 N 个 run"加 09:00–21:00 读取窗口。
//
// 因此：**不要**把这里的判断当成已在起作用的保护。接线需要客户端改造与
// D-129 决策，详见 `docs/21-平台采集技术债处理记录.md` 十七点三十七。
func (s *Server) reservePlatformRunQuery(ctx context.Context, tx pgx.Tx, runID, deviceID uuid.UUID, generation int64,
	workAttempt bool, staticRequests int, staticBytes int64, now time.Time) (platformBudgetDecision, error) {
	decision := platformBudgetDecision{Allowed: false}
	var platform, externalAccountKey, status string
	var workspaceID uuid.UUID
	var operationID uuid.UUID
	var currentGeneration int64
	var queryCount, workCount, staticCount int
	var staticBytesUsed int64
	var lastQuery *time.Time
	if err := tx.QueryRow(ctx, `SELECT c.platform,c.external_account_key,r.status,r.operation_id,c.workspace_id,
		r.lease_generation,r.budget_query_count,r.budget_work_attempts,
		r.budget_static_requests,r.budget_static_bytes,r.last_data_query_at
		FROM platform_sync_run r JOIN platform_connection c ON c.id=r.connection_id
		WHERE r.id=$1 AND r.workspace_id=$2 AND c.user_id=$3 AND c.device_id=$4 FOR UPDATE OF r`,
		runID, ident(ctx).WorkspaceID, ident(ctx).UserID, deviceID).Scan(
		&platform, &externalAccountKey, &status, &operationID, &workspaceID, &currentGeneration, &queryCount, &workCount,
		&staticCount, &staticBytesUsed, &lastQuery); err != nil {
		return decision, err
	}
	if generation != currentGeneration || (status != platformRunStatusLeased && status != platformRunStatusRunning) {
		return decision, apiErr(409, "platform_lease_stale", "该任务已结束或已由新执行替代")
	}
	if err := platformSubjectLock(ctx, tx, platform, externalAccountKey); err != nil {
		return decision, err
	}
	if !platformWithinDailyWindow(now, s.loc) {
		next := platformBudgetNextWindow(now)
		decision.Reason = "daily_window"
		decision.NextAllowedAt = &next
		return decision, nil
	}
	if staticRequests > 0 || staticBytes > 0 {
		if staticRequests < 0 || staticBytes < 0 || staticCount+staticRequests > platformRunStaticRequests || staticBytesUsed+staticBytes > platformRunStaticBytes {
			decision.Reason = "static_resource_budget_exhausted"
			return decision, nil
		}
		if _, err := tx.Exec(ctx, `UPDATE platform_sync_run SET budget_static_requests=budget_static_requests+$2,
			budget_static_bytes=budget_static_bytes+$3 WHERE id=$1`, runID, staticRequests, staticBytes); err != nil {
			return decision, err
		}
		decision.Allowed = true
		return decision, nil
	}
	if workAttempt && workCount >= 20 {
		decision.Reason = "run_work_budget_exhausted"
		return decision, nil
	}
	if queryCount >= 100 {
		decision.Reason = "run_query_budget_exhausted"
		return decision, nil
	}
	if lastQuery != nil && now.Before(lastQuery.Add(platformQueryPacing)) {
		next := lastQuery.Add(platformQueryPacing)
		decision.Reason = "query_pacing"
		decision.NextAllowedAt = &next
		return decision, nil
	}
	_, dailyQueries, dailyWorks, err := s.platformSubjectDailyUsage(ctx, tx, platform, externalAccountKey, now)
	if err != nil {
		return decision, err
	}
	var dailyWorkLimit int
	if err := tx.QueryRow(ctx, `SELECT daily_work_limit FROM platform_collection_policy WHERE workspace_id=$1`, workspaceID).Scan(&dailyWorkLimit); err != nil {
		return decision, err
	}
	if dailyQueries >= platformDailyDataQueries || (workAttempt && dailyWorks >= minInt(platformDailyWorkAttempts, dailyWorkLimit)) {
		next := platformBudgetNextWindow(now)
		decision.Reason = "platform_budget_exhausted"
		decision.NextAllowedAt = &next
		if operationID != uuid.Nil {
			_, err = tx.Exec(ctx, `UPDATE platform_sync_operation SET status='waiting_budget',next_allowed_at=$2,
				pause_reason='budget',revision=revision+1,updated_at=$3 WHERE id=$1 AND status IN ('queued','running')`, operationID, next, now)
		}
		return decision, err
	}
	_, err = tx.Exec(ctx, `UPDATE platform_sync_run SET budget_query_count=budget_query_count+1,
		budget_work_attempts=budget_work_attempts+CASE WHEN $2 THEN 1 ELSE 0 END,last_data_query_at=$3 WHERE id=$1`,
		runID, workAttempt, now)
	if err != nil {
		return decision, err
	}
	decision.Allowed = true
	return decision, nil
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}
