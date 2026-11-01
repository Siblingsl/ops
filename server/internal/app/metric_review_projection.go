package app

import (
	"context"
	"fmt"
	"math"
	"sort"
	"time"

	"github.com/google/uuid"
)

type cxReviewWindowDefinition struct {
	Key        string
	TargetHour int
	FromHour   int
	ToHour     int
}

var cxReviewWindows = []cxReviewWindowDefinition{
	{Key: "T1", TargetHour: 24, FromHour: 18, ToHour: 30},
	{Key: "T3", TargetHour: 72, FromHour: 60, ToHour: 84},
	{Key: "T7", TargetHour: 168, FromHour: 156, ToHour: 180},
	{Key: "T30", TargetHour: 720, FromHour: 696, ToHour: 744},
}

type cxReviewWorkSnapshot struct {
	ID              uuid.UUID
	Title           string
	Summary         string
	Viewpoint       string
	Topics          []string
	CoverAssetID    *uuid.UUID
	Status          string
	ContentFormat   string
	Platform        string
	PublishedAt     *time.Time
	Revision        int
	PublishRevision int
	Metrics         []Metric
}

// loadCXReviewMetrics is the formal-metric storage boundary for CX21. It keeps all retained
// snapshots so callers can report coverage, while the pure selector admits only approved,
// supported sources into comparisons. Pending observation rows are never joined here.
func (s *Server) loadCXReviewMetrics(ctx context.Context, workIDs []uuid.UUID) (map[uuid.UUID][]Metric, error) {
	return loadCXReviewMetricsFrom(ctx, s.db, workIDs)
}

func loadCXReviewMetricsFrom(ctx context.Context, q dbtx, workIDs []uuid.UUID) (map[uuid.UUID][]Metric, error) {
	byWork := make(map[uuid.UUID][]Metric, len(workIDs))
	if len(workIDs) == 0 {
		return byWork, nil
	}
	rows, err := q.Query(ctx, `SELECT `+metricCols+` FROM metric_snapshot
		WHERE work_id=ANY($1::uuid[]) AND metric_source_supported(source)
		ORDER BY work_id,captured_at,id`, workIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		metric, err := scanMetric(rows)
		if err != nil {
			return nil, err
		}
		byWork[metric.WorkID] = append(byWork[metric.WorkID], metric)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return byWork, nil
}

func (s *Server) cxReviewWorkSnapshot(ctx context.Context, accountID, workID uuid.UUID) (cxReviewWorkSnapshot, error) {
	var work cxReviewWorkSnapshot
	err := s.db.QueryRow(ctx, `SELECT w.id,w.title,w.summary,w.viewpoint,w.topics,w.cover_asset_id,w.status,
		w.content_format,a.platform,w.published_at,w.revision,w.publish_revision
		FROM work w JOIN platform_account a ON a.id=w.account_id
		WHERE w.id=$1 AND w.account_id=$2 AND a.workspace_id=$3 AND w.deleted_at IS NULL`,
		workID, accountID, ident(ctx).WorkspaceID).Scan(&work.ID, &work.Title, &work.Summary, &work.Viewpoint, &work.Topics, &work.CoverAssetID,
		&work.Status, &work.ContentFormat, &work.Platform, &work.PublishedAt, &work.Revision, &work.PublishRevision)
	if err != nil {
		return work, err
	}
	metrics, err := s.loadCXReviewMetrics(ctx, []uuid.UUID{work.ID})
	if err != nil {
		return work, err
	}
	work.Metrics = metrics[work.ID]
	return work, nil
}

func (s *Server) cxReviewPriorWorks(ctx context.Context, accountID uuid.UUID, publishedBefore time.Time, contentFormat string, limit int) ([]cxReviewWorkSnapshot, error) {
	if limit < 1 || limit > 10 {
		return nil, fmt.Errorf("invalid CX21 baseline limit %d", limit)
	}
	rows, err := s.db.Query(ctx, `SELECT w.id,w.title,w.content_format,a.platform,w.published_at,w.revision,w.publish_revision
		FROM work w JOIN platform_account a ON a.id=w.account_id
		WHERE w.account_id=$1 AND a.workspace_id=$2 AND w.deleted_at IS NULL AND w.status='published'
		AND w.published_at IS NOT NULL AND w.published_at<$3 AND w.content_format=$4
		ORDER BY w.published_at DESC,w.id DESC LIMIT $5`,
		accountID, ident(ctx).WorkspaceID, publishedBefore, contentFormat, limit)
	if err != nil {
		return nil, err
	}
	works := []cxReviewWorkSnapshot{}
	for rows.Next() {
		var work cxReviewWorkSnapshot
		if err := rows.Scan(&work.ID, &work.Title, &work.ContentFormat, &work.Platform, &work.PublishedAt, &work.Revision, &work.PublishRevision); err != nil {
			rows.Close()
			return nil, err
		}
		works = append(works, work)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	ids := make([]uuid.UUID, 0, len(works))
	for _, work := range works {
		ids = append(ids, work.ID)
	}
	metrics, err := s.loadCXReviewMetrics(ctx, ids)
	if err != nil {
		return nil, err
	}
	for i := range works {
		works[i].Metrics = metrics[works[i].ID]
	}
	return works, nil
}

func cxReviewWindowRange(publishedAt time.Time, key string) (start, end, target time.Time, ok bool) {
	for _, window := range cxReviewWindows {
		if window.Key == key {
			return publishedAt.Add(time.Duration(window.FromHour) * time.Hour),
				publishedAt.Add(time.Duration(window.ToHour) * time.Hour),
				publishedAt.Add(time.Duration(window.TargetHour) * time.Hour), true
		}
	}
	return time.Time{}, time.Time{}, time.Time{}, false
}

func cxReviewSourceRank(source string) int {
	switch source {
	case "wechat_api":
		return 0
	case "wechat_browser", "xhs_browser":
		return 1
	case "file":
		return 2
	case "screenshot":
		return 3
	case "paste":
		return 4
	case "manual":
		return 5
	default:
		return math.MaxInt
	}
}

// selectCXReviewWindowMetric chooses one retained formal metric. Equal distance chooses the
// earlier timestamp, then the existing metric source rank, then the metric ID.
func selectCXReviewWindowMetric(metrics []Metric, publishedAt *time.Time, key string) (*Metric, int, []string) {
	if publishedAt == nil {
		return nil, 0, []string{"missing_published_at"}
	}
	start, end, target, ok := cxReviewWindowRange(*publishedAt, key)
	if !ok {
		return nil, 0, []string{"invalid_window"}
	}
	inRange := make([]Metric, 0, len(metrics))
	eligible := make([]Metric, 0, len(metrics))
	for _, metric := range metrics {
		if metric.CapturedAt.Before(start) || metric.CapturedAt.After(end) {
			continue
		}
		inRange = append(inRange, metric)
		if metric.QualityState == metricQualityApproved && cxReviewSourceRank(metric.Source) != math.MaxInt {
			eligible = append(eligible, metric)
		}
	}
	if len(eligible) == 0 {
		return nil, len(inRange), []string{"missing_metric"}
	}
	sort.Slice(eligible, func(i, j int) bool {
		di := absDuration(eligible[i].CapturedAt.Sub(target))
		dj := absDuration(eligible[j].CapturedAt.Sub(target))
		if di != dj {
			return di < dj
		}
		if !eligible[i].CapturedAt.Equal(eligible[j].CapturedAt) {
			return eligible[i].CapturedAt.Before(eligible[j].CapturedAt)
		}
		ri, rj := cxReviewSourceRank(eligible[i].Source), cxReviewSourceRank(eligible[j].Source)
		if ri != rj {
			return ri < rj
		}
		return eligible[i].ID.String() < eligible[j].ID.String()
	})
	chosen := eligible[0]
	if !cxReviewKnownReadUnit(chosen.ReadUnit) {
		return &chosen, len(inRange), []string{"read_unit_unknown"}
	}
	return &chosen, len(inRange), nil
}

func absDuration(value time.Duration) time.Duration {
	if value < 0 {
		return -value
	}
	return value
}

type cxReviewRatio struct {
	Value          *float64 `json:"value"`
	MissingReasons []string `json:"missing_reasons"`
}

type cxReviewRatiosResult struct {
	FavoriteRate    cxReviewRatio `json:"favorite_rate"`
	FollowRate      cxReviewRatio `json:"follow_rate"`
	InteractionRate cxReviewRatio `json:"interaction_rate"`
}

func cxReviewRatios(metric *Metric) cxReviewRatiosResult {
	if metric == nil {
		missing := []string{"missing_metric"}
		return cxReviewRatiosResult{
			FavoriteRate:    cxReviewRatio{MissingReasons: missing},
			FollowRate:      cxReviewRatio{MissingReasons: missing},
			InteractionRate: cxReviewRatio{MissingReasons: missing},
		}
	}
	return cxReviewRatiosResult{
		FavoriteRate:    cxReviewRatioFor(metric, "favorites"),
		FollowRate:      cxReviewRatioFor(metric, "follows_gained"),
		InteractionRate: cxReviewInteractionRate(metric),
	}
}

func cxReviewRatioFor(metric *Metric, numerator string) cxReviewRatio {
	reasons := cxReviewReadReasons(metric)
	var value *int
	if numerator == "favorites" {
		value = metric.Favorites
	} else {
		value = metric.FollowsGained
	}
	if value == nil {
		reasons = append(reasons, numerator+"_missing")
	}
	if len(reasons) > 0 {
		return cxReviewRatio{MissingReasons: uniqueStrings(reasons)}
	}
	rate := float64(*value) / float64(*metric.Reads)
	return cxReviewRatio{Value: &rate, MissingReasons: []string{}}
}

func cxReviewInteractionRate(metric *Metric) cxReviewRatio {
	reasons := cxReviewReadReasons(metric)
	parts := map[string]*int{"likes": metric.Likes, "favorites": metric.Favorites, "comments": metric.Comments, "shares": metric.Shares}
	for name, value := range parts {
		if value == nil {
			reasons = append(reasons, name+"_missing")
		}
	}
	if metric.Shares != nil && metric.ShareUnit != "times" && metric.ShareUnit != metricUnitCount {
		reasons = append(reasons, "share_unit_incompatible")
	}
	if len(reasons) > 0 {
		return cxReviewRatio{MissingReasons: uniqueStrings(reasons)}
	}
	numerator := int64(*metric.Likes) + int64(*metric.Favorites) + int64(*metric.Comments) + int64(*metric.Shares)
	rate := float64(numerator) / float64(*metric.Reads)
	return cxReviewRatio{Value: &rate, MissingReasons: []string{}}
}

func cxReviewReadReasons(metric *Metric) []string {
	reasons := []string{}
	if !cxReviewKnownReadUnit(metric.ReadUnit) {
		reasons = append(reasons, "read_unit_unknown")
	}
	if metric.Reads == nil {
		reasons = append(reasons, "reads_missing")
	} else if *metric.Reads <= 0 {
		reasons = append(reasons, "reads_not_positive")
	}
	return reasons
}

func uniqueStrings(values []string) []string {
	seen := make(map[string]bool, len(values))
	out := make([]string, 0, len(values))
	for _, value := range values {
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	return out
}

func cxReviewKnownReadUnit(unit string) bool {
	return unit == metricUnitUsers || unit == metricUnitTimes || unit == metricUnitCount
}

func cxReviewMedian(values []float64) *float64 {
	if len(values) == 0 {
		return nil
	}
	copyValues := append([]float64(nil), values...)
	sort.Float64s(copyValues)
	middle := len(copyValues) / 2
	median := copyValues[middle]
	if len(copyValues)%2 == 0 {
		median = (copyValues[middle-1] + copyValues[middle]) / 2
	}
	return &median
}
