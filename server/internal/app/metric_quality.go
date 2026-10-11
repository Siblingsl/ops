package app

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// ---------- 数据质量（DEV-DR01，14 文档 4.1） ----------

var metricSources = map[string]bool{"manual": true, "paste": true, "file": true, "wechat_api": true, "screenshot": true}

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
	Likes         *int
	Wows          *int
	Favorites     *int
	Comments      *int
	Shares        *int
	FollowsGained *int
	Note          string
}

// upsertMetric keeps one row per (work, source, day_offset): a second write to the same node
// fills in the newly known fields instead of adding a row. merged reports that case.
func upsertMetric(ctx context.Context, q dbtx, in metricWrite) (m Metric, merged bool, err error) {
	if !metricSources[in.Source] {
		in.Source = "manual"
	}
	row := q.QueryRow(ctx, `INSERT INTO metric_snapshot (work_id, captured_at, source, day_offset, external_id,
		reads, likes, wows, favorites, comments, shares, follows_gained, note)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
		ON CONFLICT (work_id, source, day_offset) DO UPDATE SET
			captured_at=EXCLUDED.captured_at,
			external_id=coalesce(EXCLUDED.external_id, metric_snapshot.external_id),
			reads=coalesce(EXCLUDED.reads, metric_snapshot.reads),
			likes=coalesce(EXCLUDED.likes, metric_snapshot.likes),
			wows=coalesce(EXCLUDED.wows, metric_snapshot.wows),
			favorites=coalesce(EXCLUDED.favorites, metric_snapshot.favorites),
			comments=coalesce(EXCLUDED.comments, metric_snapshot.comments),
			shares=coalesce(EXCLUDED.shares, metric_snapshot.shares),
			follows_gained=coalesce(EXCLUDED.follows_gained, metric_snapshot.follows_gained),
			note=CASE WHEN EXCLUDED.note<>'' THEN EXCLUDED.note ELSE metric_snapshot.note END
		RETURNING `+metricCols+`, xmax::text<>'0'`,
		in.WorkID, in.CapturedAt, in.Source, in.DayOffset, in.ExternalID,
		in.Reads, in.Likes, in.Wows, in.Favorites, in.Comments, in.Shares, in.FollowsGained, in.Note)
	err = row.Scan(append(metricDest(&m), &merged)...)
	return m, merged, err
}

// ---------- 第 7 天口径与节点完整度（DEV-DR02，14 文档 4.1 第 3–4 条） ----------

var metricNodes = []int{1, 3, 7, 30}

const metricSourceOrder = `array_position(ARRAY['wechat_api','file','screenshot','paste','manual'], source)`

func dayOffsetLabel(d *int) string {
	if d == nil {
		return "发布时间未知"
	}
	return fmt.Sprintf("第 %d 天数据", *d)
}

// metricNodeCoverage counts the 1/3/7-day nodes already due for works published in the last
// `days` days, and how many of them have data.
func (s *Server) metricNodeCoverage(ctx context.Context, accountID uuid.UUID, days int) (due, covered int, err error) {
	err = s.db.QueryRow(ctx, `SELECT count(*), count(*) FILTER (WHERE EXISTS (SELECT 1 FROM metric_snapshot m WHERE m.work_id=w.id AND metric_node(m.day_offset)=n.node))
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

// recomputeMetricOffsets realigns day_offset after published_at changes. Rows that would collide
// with an existing node of the same source keep their old offset rather than being dropped.
func (s *Server) recomputeMetricOffsets(ctx context.Context, workID uuid.UUID) {
	rows, err := s.db.Query(ctx, `SELECT m.id, metric_day_offset(m.captured_at, w.published_at) FROM metric_snapshot m JOIN work w ON w.id=m.work_id
		WHERE m.work_id=$1 AND m.source<>'wechat_api' AND m.day_offset IS DISTINCT FROM metric_day_offset(m.captured_at, w.published_at)`, workID)
	if err != nil {
		slog.Warn("重算数据节点失败", "work", workID, "err", err)
		return
	}
	type fix struct {
		id  uuid.UUID
		off *int
	}
	var list []fix
	for rows.Next() {
		var f fix
		if rows.Scan(&f.id, &f.off) == nil {
			list = append(list, f)
		}
	}
	rows.Close()
	for _, f := range list {
		if _, err := s.db.Exec(ctx, `UPDATE metric_snapshot SET day_offset=$2 WHERE id=$1`, f.id, f.off); err != nil && !isUniqueViolation(err) {
			slog.Warn("重算数据节点失败", "metric", f.id, "err", err)
		}
	}
}
