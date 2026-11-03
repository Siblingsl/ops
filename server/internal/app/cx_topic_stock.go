package app

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// DEV-CX13-C / FR-CX-19 选题库存与补给节奏。
//
// 库存是独立五态维度（idea/verified/ready/used/dropped），原 status（pending/adopted/dropped）
// 的创建/采用事实保留不变，两者在同事务内同步维护。Q-CX-06 拍板（90 D-165）：
// 旧 pending 迁移为 idea 且核验时间保持 NULL（unknown），逐题核验后才进新排期；
// 不引入任何 legacy 豁免标记，核验门禁对存量题同样生效；历史缺时间不伪造。

const (
	topicStockIdea     = "idea"
	topicStockVerified = "verified"
	topicStockReady    = "ready"
	topicStockUsed     = "used"
	topicStockDropped  = "dropped"

	// 设计默认（24 §FR-CX-19）：水位按未删除且未过期的 ready 计。
	topicStockTargetDefault = 12
	topicStockWarnDefault   = 6
	// 核验 60 天失效仅标 stale：从有效可写数量排除，不改终态。
	topicStockVerifyTTL = 60 * 24 * time.Hour
)

// 允许的库存转换（PATCH stock_transition）。verified 由专用核验端点触发，used 只由
// 「从选题建作品」成功事务触发，都不在 PATCH 里开放。
var topicStockTransitions = map[string][]string{
	topicStockIdea:     {topicStockDropped},
	topicStockVerified: {topicStockReady, topicStockIdea, topicStockDropped},
	topicStockReady:    {topicStockVerified, topicStockDropped},
	topicStockUsed:     {},
	topicStockDropped:  {topicStockIdea},
}

type topicStockRow struct {
	StockStatus string
	Status      string
	VerifiedAt  *time.Time
	UsedAt      *time.Time
	UpdatedAt   time.Time
}

func loadTopicStockRow(ctx context.Context, tx pgx.Tx, topicID uuid.UUID) (topicStockRow, error) {
	var row topicStockRow
	err := tx.QueryRow(ctx, `SELECT stock_status, status, verified_at, used_at, updated_at FROM topic WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`,
		topicID).Scan(&row.StockStatus, &row.Status, &row.VerifiedAt, &row.UsedAt, &row.UpdatedAt)
	return row, err
}

func checkTopicStockBasis(row topicStockRow, basis *time.Time) error {
	if basis == nil || basis.IsZero() {
		return validation("请提供有效的选题版本依据")
	}
	if !row.UpdatedAt.Equal(*basis) {
		return apiErr(http.StatusConflict, "version_conflict", "选题已被修改，请刷新后重试")
	}
	return nil
}

// applyTopicStockTransition 校验并落一条库存转换，同时同步原 status。
// 调用方负责在事务里先 loadTopicStockRow FOR UPDATE。
func applyTopicStockTransition(ctx context.Context, tx pgx.Tx, topicID uuid.UUID, current topicStockRow, target, reason, plannedDate string) error {
	if current.Status == "adopted" {
		return validation("已采用的选题不能重新进入待采用库存")
	}
	allowed := false
	for _, next := range topicStockTransitions[current.StockStatus] {
		if next == target {
			allowed = true
			break
		}
	}
	if !allowed {
		return validation("当前库存状态不能转换到目标状态：" + current.StockStatus + " → " + target)
	}
	switch target {
	case topicStockReady:
		// 进新排期必须先核验（转换矩阵只在 verified→ready 开放 ready 目标）+ 明确计划日期。
		if plannedDate == "" {
			return validation("进入可排期（ready）必须填写计划日期")
		}
		if _, err := tx.Exec(ctx, `UPDATE topic SET stock_status='ready', stock_changed_at=now(), planned_date=$2::date, stock_reason=$3,
			updated_at=now() WHERE id=$1`, topicID, plannedDate, reason); err != nil {
			return err
		}
		return syncTopicStatusStock(ctx, tx, topicID, "pending")
	case topicStockIdea:
		// verified 退回 idea 或 dropped 显式恢复：本次核验有效性清除，不伪造历史核验。
		if current.StockStatus == topicStockVerified && strings.TrimSpace(reason) == "" {
			return validation("退回想法必须填写原因")
		}
		if _, err := tx.Exec(ctx, `UPDATE topic SET stock_status='idea', stock_changed_at=now(), verified_at=NULL, verified_by=NULL,
			verify_note='', stock_reason=$2, planned_date=NULL, updated_at=now() WHERE id=$1`, topicID, reason); err != nil {
			return err
		}
		return syncTopicStatusStock(ctx, tx, topicID, "pending")
	case topicStockVerified:
		// ready 取消排期退回 verified：保留既有核验记录（核验仍在其有效期内）。
		if _, err := tx.Exec(ctx, `UPDATE topic SET stock_status='verified', stock_changed_at=now(), planned_date=NULL, stock_reason=$2,
			updated_at=now() WHERE id=$1`, topicID, reason); err != nil {
			return err
		}
		return syncTopicStatusStock(ctx, tx, topicID, "pending")
	case topicStockDropped:
		if _, err := tx.Exec(ctx, `UPDATE topic SET stock_status='dropped', stock_changed_at=now(), planned_date=NULL, stock_reason=$2,
			updated_at=now() WHERE id=$1`, topicID, reason); err != nil {
			return err
		}
		return syncTopicStatusStock(ctx, tx, topicID, "dropped")
	}
	return validation("未知库存目标状态")
}

// syncTopicStatusStock keeps the legacy status column in the same transaction.
// Callers have already rejected contradictory moves (adopted facts never
// re-enter stock; dropped topics cannot be marked adopted directly).
func syncTopicStatusStock(ctx context.Context, tx pgx.Tx, topicID uuid.UUID, status string) error {
	_, err := tx.Exec(ctx, `UPDATE topic SET status=$2, updated_at=now() WHERE id=$1`, topicID, status)
	return err
}

// markTopicStockUsed records the adoption fact in the stock dimension inside
// the "create work from topic" transaction. A used topic never returns.
// planned_date 保留：series 上下文仍按它排序，作品已接管该日期（NW-A7）。
func markTopicStockUsed(ctx context.Context, tx pgx.Tx, topicID uuid.UUID) error {
	_, err := tx.Exec(ctx, `UPDATE topic SET stock_status='used', used_at=coalesce(used_at, now()), stock_changed_at=now(), updated_at=now() WHERE id=$1`, topicID)
	return err
}

// verifyTopicStock handles POST /topics/{id}/verify：人工核验，actor 由会话取。
func (s *Server) verifyTopicStock(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	var in struct {
		BasisUpdatedAt *time.Time `json:"basis_updated_at"`
		Note           string     `json:"note"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	note := strings.TrimSpace(in.Note)
	if n := len([]rune(note)); n < 20 || n > 500 {
		return validation("核验说明需要 20..500 个码点，说明这条选题为什么值得写")
	}
	ctx := r.Context()
	if _, err := s.ownedAccountRow(ctx, "topic", id); err != nil {
		return err
	}
	userID := ident(ctx).UserID
	err = s.withTx(ctx, func(tx pgx.Tx) error {
		row, err := loadTopicStockRow(ctx, tx, id)
		if err != nil {
			return err
		}
		if err := checkTopicStockBasis(row, in.BasisUpdatedAt); err != nil {
			return err
		}
		if row.StockStatus != topicStockIdea && row.StockStatus != topicStockVerified {
			return validation("只有想法或已核验（含过期）的选题可以核验；可排期选题请先取消排期再重新核验")
		}
		if row.Status == "dropped" {
			return validation("已放弃的选题需要先显式恢复才能核验")
		}
		if _, err := tx.Exec(ctx, `UPDATE topic SET stock_status='verified', stock_changed_at=now(), verified_at=now(), verified_by=$2,
			verify_note=$3, updated_at=now() WHERE id=$1`, id, userID, note); err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		return err
	}
	t, err := scanTopic(s.db.QueryRow(ctx, `SELECT `+topicCols+` FROM topic t WHERE t.id=$1`, id))
	if err != nil {
		return err
	}
	s.audit(ctx, "cx_topic_stock_verify", "topic", id.String(), "ok", nil)
	return ok(w, map[string]any{"ok": true, "topic": t})
}

// topicStockSummary is the GET /accounts/{id}/topic-stock response.
type topicStockSummary struct {
	Counts         map[string]int `json:"counts"`
	EffectiveReady int            `json:"effective_ready"`
	StaleReady     int            `json:"stale_ready"`
	Target         int            `json:"target"`
	Warn           int            `json:"warn"`
	NeedRefill     int            `json:"need_refill"`
	TurnoverDays   *float64       `json:"turnover_days"`
	AdoptionRate   *float64       `json:"adoption_rate"`
	SampleCount    int            `json:"sample_count"`
	ExcludedCount  int            `json:"excluded_count"`
}

func (s *Server) topicStock(w http.ResponseWriter, r *http.Request) error {
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	summary, err := s.computeTopicStock(r.Context(), a.ID)
	if err != nil {
		return err
	}
	return ok(w, summary)
}

func (s *Server) computeTopicStock(ctx context.Context, accountID uuid.UUID) (topicStockSummary, error) {
	summary := topicStockSummary{Counts: map[string]int{}}
	var targetPtr, warnPtr *int
	if err := s.db.QueryRow(ctx, `SELECT
			NULLIF(topic_stock_policy->>'target_ready','')::int,
			NULLIF(topic_stock_policy->>'warn_ready','')::int
		FROM account_profile WHERE account_id=$1`, accountID).Scan(&targetPtr, &warnPtr); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return summary, err
	}
	// owner 配置缺失或非法时回退设计默认，不静默保存修正值。
	summary.Target, summary.Warn = topicStockTargetDefault, topicStockWarnDefault
	if targetPtr != nil && warnPtr != nil && *warnPtr >= 1 && *warnPtr <= *targetPtr && *targetPtr <= 100 {
		summary.Target, summary.Warn = *targetPtr, *warnPtr
	}
	rows, err := s.db.Query(ctx, `SELECT stock_status,
			count(*) FILTER (WHERE verified_at IS NOT NULL AND verified_at < now() - $2::interval),
			count(*)
		FROM topic WHERE account_id=$1 AND deleted_at IS NULL GROUP BY stock_status`, accountID, "60 days")
	if err != nil {
		return summary, err
	}
	for rows.Next() {
		var status string
		var stale, total int
		if err := rows.Scan(&status, &stale, &total); err != nil {
			rows.Close()
			return summary, err
		}
		summary.Counts[status] = total
		if status == topicStockReady {
			summary.StaleReady = stale
		}
	}
	rows.Close()
	summary.EffectiveReady = summary.Counts[topicStockReady] - summary.StaleReady
	summary.NeedRefill = summary.Target - summary.EffectiveReady
	if summary.NeedRefill < 0 {
		summary.NeedRefill = 0
	}
	// 周转天数：有真实 verified_at 与 used_at 的样本均值；空分母返回 null，不以 0 冒充。
	if err := s.db.QueryRow(ctx, `SELECT avg(extract(epoch FROM (used_at-verified_at))/86400.0)
		FROM topic WHERE account_id=$1 AND deleted_at IS NULL AND stock_status='used'
		AND verified_at IS NOT NULL AND used_at IS NOT NULL`, accountID).Scan(&summary.TurnoverDays); err != nil {
		return summary, err
	}
	// 采用率按当前自然月的终态事件计算；历史缺事件时间单独计数。
	var usedCounted, excluded, droppedCounted int
	if err := s.db.QueryRow(ctx, `SELECT
			count(*) FILTER (WHERE stock_status='used' AND used_at >= date_trunc('month', now()) AND used_at < date_trunc('month', now()) + interval '1 month'),
			count(*) FILTER (WHERE (stock_status='used' AND used_at IS NULL) OR (stock_status='dropped' AND stock_changed_at IS NULL)),
			count(*) FILTER (WHERE stock_status='dropped' AND stock_changed_at >= date_trunc('month', now()) AND stock_changed_at < date_trunc('month', now()) + interval '1 month')
		FROM topic WHERE account_id=$1 AND deleted_at IS NULL`, accountID).Scan(&usedCounted, &excluded, &droppedCounted); err != nil {
		return summary, err
	}
	summary.ExcludedCount = excluded
	summary.SampleCount = usedCounted + droppedCounted
	if total := usedCounted + droppedCounted; total > 0 {
		rate := float64(usedCounted) / float64(total)
		summary.AdoptionRate = &rate
	}
	return summary, nil
}
