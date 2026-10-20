package app

import (
	"context"
	"fmt"
	"log/slog"
	"reflect"
	"sort"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// ---------- 数据质量（DEV-DR01，14 文档 4.1） ----------

var metricSources = map[string]bool{"manual": true, "paste": true, "file": true, "wechat_api": true, "screenshot": true,
	"wechat_browser": true, "xhs_browser": true}

type dbtx interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// metricWrite is one snapshot to store. Fields left nil are unknown and stay NULL; day_offset is
// derived from work.published_at by the database trigger unless given explicitly.
type metricWrite struct {
	WorkID        uuid.UUID
	CapturedAt    time.Time
	Source        string
	DayOffset     *int
	ExternalID    *string
	Reads         *int
	Impressions   *int64
	Likes         *int
	Wows          *int
	Favorites     *int
	Comments      *int
	Shares        *int
	FollowsGained *int
	Note          string
	// 口径单位（20 文档 §9.1）：官方路径必须显式给出，不得留 unknown 让下游猜。
	ReadUnit  *string
	ShareUnit *string
}

// upsertMetric keeps one row per (work, source, day_offset): a second write to the same node
// fills in the newly known fields instead of adding a row. merged reports that case.
func upsertMetric(ctx context.Context, q dbtx, in metricWrite) (m Metric, merged bool, err error) {
	if !metricSources[in.Source] {
		in.Source = "manual"
	}
	var existing Metric
	existing, err = scanMetric(q.QueryRow(ctx, `SELECT `+metricCols+` FROM metric_snapshot
		WHERE work_id=$1 AND source=$2 AND day_offset IS NOT DISTINCT FROM
			(SELECT CASE WHEN $3::integer IS NULL THEN metric_day_offset($4, published_at) ELSE $3 END FROM work WHERE id=$1)
		FOR UPDATE`, in.WorkID, in.Source, in.DayOffset, in.CapturedAt))
	if err == nil {
		merged = true
		m, err = scanMetric(q.QueryRow(ctx, `UPDATE metric_snapshot SET
			captured_at=$2,
			external_id=coalesce($3, external_id),
			reads=coalesce($4, reads), impressions=coalesce($5, impressions), likes=coalesce($6, likes), wows=coalesce($7, wows),
			favorites=coalesce($8, favorites), comments=coalesce($9, comments), shares=coalesce($10, shares),
			follows_gained=coalesce($11, follows_gained),
			read_unit=coalesce($13, read_unit), share_unit=coalesce($14, share_unit),
			note=CASE WHEN $12<>'' THEN $12 ELSE note END
			WHERE id=$1 RETURNING `+metricCols, existing.ID, in.CapturedAt, in.ExternalID,
			in.Reads, in.Impressions, in.Likes, in.Wows, in.Favorites, in.Comments, in.Shares, in.FollowsGained, in.Note,
			in.ReadUnit, in.ShareUnit))
		return m, merged, err
	}
	if err != pgx.ErrNoRows {
		return Metric{}, false, err
	}
	m, err = scanMetric(q.QueryRow(ctx, `INSERT INTO metric_snapshot (work_id, captured_at, source, day_offset, external_id,
		reads, impressions, likes, wows, favorites, comments, shares, follows_gained, note, read_unit, share_unit)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
		  coalesce($15,'unknown'), coalesce($16,'unknown')) RETURNING `+metricCols,
		in.WorkID, in.CapturedAt, in.Source, in.DayOffset, in.ExternalID,
		in.Reads, in.Impressions, in.Likes, in.Wows, in.Favorites, in.Comments, in.Shares, in.FollowsGained, in.Note,
		in.ReadUnit, in.ShareUnit))
	return m, false, err
}

func lockMetricWork(ctx context.Context, tx pgx.Tx, workID uuid.UUID) (string, error) {
	var status string
	err := tx.QueryRow(ctx, `SELECT status FROM work WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, workID).Scan(&status)
	return status, err
}

func (s *Server) upsertMetricWithAudit(ctx context.Context, tx pgx.Tx, in metricWrite) (Metric, bool, error) {
	if !metricSources[in.Source] {
		in.Source = "manual"
	}
	if _, err := lockMetricWork(ctx, tx, in.WorkID); err != nil {
		return Metric{}, false, err
	}
	before, err := scanMetric(tx.QueryRow(ctx, `SELECT `+metricCols+` FROM metric_snapshot
		WHERE work_id=$1 AND source=$2 AND day_offset IS NOT DISTINCT FROM
			(SELECT CASE WHEN $3::integer IS NULL THEN metric_day_offset($4, published_at) ELSE $3 END FROM work WHERE id=$1)
		FOR UPDATE`, in.WorkID, in.Source, in.DayOffset, in.CapturedAt))
	exists := err == nil
	if err != nil && err != pgx.ErrNoRows {
		return Metric{}, false, err
	}
	after, merged, err := upsertMetric(ctx, tx, in)
	if err != nil {
		return Metric{}, false, err
	}
	if exists && reflect.DeepEqual(metricAuditValues(before), metricAuditValues(after)) {
		return after, merged, nil
	}
	action := "metric_create"
	if exists {
		action = "metric_merge"
	}
	var previous *Metric
	if exists {
		previous = &before
	}
	return after, merged, s.auditMetricMutation(ctx, tx, action, previous, &after, merged)
}

func metricAuditValues(m Metric) map[string]any {
	intValue := func(v *int) any {
		if v == nil {
			return nil
		}
		return *v
	}
	int64Value := func(v *int64) any {
		if v == nil {
			return nil
		}
		return *v
	}
	stringValue := func(v *string) any {
		if v == nil {
			return nil
		}
		return *v
	}
	var dayOffset any
	if m.DayOffset != nil {
		dayOffset = *m.DayOffset
	}
	return map[string]any{
		"captured_at":    m.CapturedAt.UTC().Format(time.RFC3339Nano),
		"reads":          intValue(m.Reads),
		"impressions":    int64Value(m.Impressions),
		"likes":          intValue(m.Likes),
		"wows":           intValue(m.Wows),
		"favorites":      intValue(m.Favorites),
		"comments":       intValue(m.Comments),
		"shares":         intValue(m.Shares),
		"follows_gained": intValue(m.FollowsGained),
		"note":           m.Note,
		"source":         m.Source,
		"day_offset":     dayOffset,
		"external_id":    stringValue(m.ExternalID),
	}
}

func (s *Server) auditMetricMutation(ctx context.Context, tx pgx.Tx, action string, before, after *Metric, merged bool) error {
	if before != nil && after != nil && reflect.DeepEqual(metricAuditValues(*before), metricAuditValues(*after)) {
		return nil
	}
	current := after
	if current == nil {
		current = before
	}
	if current == nil {
		return fmt.Errorf("metric audit requires before or after value")
	}
	detail := map[string]any{"work_id": current.WorkID.String(), "source": current.Source, "merged": merged}
	var metricID string
	fields := make([]string, 0, 12)
	if before != nil {
		metricID = before.ID.String()
		beforeValues := metricAuditValues(*before)
		detail["before"] = beforeValues
		detail["revision_before"] = before.Revision
		if after == nil {
			for field := range beforeValues {
				fields = append(fields, field)
			}
		}
	}
	if after != nil {
		metricID = after.ID.String()
		afterValues := metricAuditValues(*after)
		detail["after"] = afterValues
		detail["revision_after"] = after.Revision
		if before == nil {
			for field := range afterValues {
				fields = append(fields, field)
			}
		}
	}
	if before != nil && after != nil {
		beforeValues, afterValues := metricAuditValues(*before), metricAuditValues(*after)
		for field, value := range beforeValues {
			if !reflect.DeepEqual(value, afterValues[field]) {
				fields = append(fields, field)
			}
		}
	}
	sort.Strings(fields)
	detail["changed_fields"] = fields
	return s.auditTx(ctx, tx, action, "metric_snapshot", metricID, "ok", detail)
}

// ---------- 第 7 天口径与节点完整度（DEV-DR02，14 文档 4.1 第 3–4 条） ----------

var metricNodes = []int{1, 3, 7, 30}

// 来源排序统一走数据库函数 metric_source_rank()，与 work_metric_d7、metric_node_public 共用；
// 新增 source 后不会再因 array_position 返回 NULL 而排到最后。
const metricSourceOrder = `metric_source_rank(source)`

func dayOffsetLabel(d *int) string {
	if d == nil {
		return "发布时间未知"
	}
	return fmt.Sprintf("第 %d 天数据", *d)
}

// metricNodeCoverage counts the 1/3/7-day nodes already due for works published in the last
// `days` days, and how many of them have data.
func (s *Server) metricNodeCoverage(ctx context.Context, accountID uuid.UUID, days int) (due, covered int, err error) {
	err = s.db.QueryRow(ctx, `SELECT count(*), count(*) FILTER (WHERE EXISTS (SELECT 1 FROM metric_snapshot m WHERE m.work_id=w.id AND metric_node(m.day_offset)=n.node AND m.quality_state='approved'))
		FROM work w CROSS JOIN (VALUES (1),(3),(7)) n(node)
		WHERE w.account_id=$1 AND w.deleted_at IS NULL AND w.published_at IS NOT NULL AND w.published_at > $3::timestamptz - make_interval(days => $2)
		AND (w.published_at AT TIME ZONE 'Asia/Shanghai')::date + n.node <= ($3::timestamptz AT TIME ZONE 'Asia/Shanghai')::date`,
		accountID, days, s.now()).Scan(&due, &covered)
	return
}

type metricNodeView struct {
	Node   int        `json:"node"`
	Due    bool       `json:"due"`
	DueAt  *time.Time `json:"due_at"`
	Metric *Metric    `json:"metric"`
}

// metricNodesView is GET /works/{id}/metrics?view=nodes: one slot per node plus the day-7 figure.
func (s *Server) metricNodesView(ctx context.Context, workID uuid.UUID, publishedAt *time.Time) (map[string]any, error) {
	nodes := make([]metricNodeView, 0, len(metricNodes))
	for _, n := range metricNodes {
		v := metricNodeView{Node: n}
		if publishedAt != nil {
			p := publishedAt.In(s.loc)
			at := time.Date(p.Year(), p.Month(), p.Day(), 0, 0, 0, 0, s.loc).AddDate(0, 0, n)
			v.DueAt, v.Due = &at, !s.now().Before(at)
		}
		m, err := scanMetric(s.db.QueryRow(ctx, `SELECT `+metricCols+` FROM metric_snapshot WHERE work_id=$1 AND metric_node(day_offset)=$2
			ORDER BY abs(day_offset-$2), `+metricSourceOrder+`, captured_at DESC LIMIT 1`, workID, n))
		if err == nil {
			v.Metric = &m
		} else if err != pgx.ErrNoRows {
			return nil, err
		}
		nodes = append(nodes, v)
	}
	var d7 *Metric
	if m, err := scanMetric(s.db.QueryRow(ctx, `SELECT `+metricCols+` FROM metric_snapshot WHERE id=(SELECT metric_id FROM work_metric_d7 WHERE work_id=$1)`, workID)); err == nil {
		d7 = &m
	} else if err != pgx.ErrNoRows {
		return nil, err
	}
	return map[string]any{"nodes": nodes, "d7": d7, "published_at": publishedAt}, nil
}

// recomputeMetricOffsets realigns non-API day_offset rows after a publication date is updated
// by a legacy caller. The user-facing publish route plans all sources before it writes anything.
func (s *Server) recomputeMetricOffsets(ctx context.Context, workID uuid.UUID) {
	err := s.withTx(ctx, func(tx pgx.Tx) error {
		if _, err := lockMetricWork(ctx, tx, workID); err != nil {
			return err
		}
		var publishedAt *time.Time
		if err := tx.QueryRow(ctx, `SELECT published_at FROM work WHERE id=$1`, workID).Scan(&publishedAt); err != nil {
			return err
		}
		rows, err := tx.Query(ctx, `SELECT `+metricCols+` FROM metric_snapshot
			WHERE work_id=$1 AND source<>'wechat_api' ORDER BY captured_at,id FOR UPDATE`, workID)
		if err != nil {
			return err
		}
		defer rows.Close()
		var changes []publishMetricChange
		seen := make(map[string]uuid.UUID)
		for rows.Next() {
			before, err := scanMetric(rows)
			if err != nil {
				return err
			}
			var target *int
			if publishedAt != nil {
				offset := publicationDayOffset(before.CapturedAt, publishedAt, s.loc)
				if offset < 0 {
					return apiErr(409, "publish_metric_negative_offset", fmt.Sprintf("数据记录 %s 的统计日早于发布时间，节点未重算。", before.ID))
				}
				target = &offset
			}
			if target != nil {
				key := fmt.Sprintf("%s:%d", before.Source, *target)
				if prior, ok := seen[key]; ok {
					return apiErr(409, "publish_metric_node_conflict", fmt.Sprintf("数据记录 %s 与 %s 会落在同来源同节点，节点未重算。", prior, before.ID))
				}
				seen[key] = before.ID
			}
			if !reflect.DeepEqual(before.DayOffset, target) {
				changes = append(changes, publishMetricChange{Before: before, After: target})
			}
		}
		if err := rows.Err(); err != nil {
			return err
		}
		rows.Close()
		return s.applyPublishMetricChanges(ctx, tx, changes)
	})
	if err != nil {
		slog.Warn("重算数据节点失败", "work", workID, "err", err)
	}
}
