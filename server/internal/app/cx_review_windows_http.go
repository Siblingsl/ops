package app

import (
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
)

type cxReviewMetricRef struct {
	ID         uuid.UUID `json:"metric_id"`
	Revision   int       `json:"revision"`
	Source     string    `json:"source"`
	CapturedAt time.Time `json:"captured_at"`
	Quality    string    `json:"quality"`
	ReadUnit   string    `json:"read_unit"`
	ShareUnit  string    `json:"share_unit"`
}

type cxReviewWindowRangeView struct {
	From time.Time `json:"from"`
	To   time.Time `json:"to"`
}

type cxReviewWindowCoverage struct {
	RetainedSnapshots int `json:"retained_snapshots"`
	FormalSnapshots   int `json:"formal_snapshots"`
}

type cxReviewBaselineStat struct {
	Median        *float64                 `json:"median"`
	SampleSize    int                      `json:"sample_size"`
	ExcludedCount int                      `json:"excluded_count"`
	ReadUnit      string                   `json:"read_unit,omitempty"`
	ShareUnit     string                   `json:"share_unit,omitempty"`
	Samples       []cxReviewBaselineSample `json:"samples"`
}

type cxReviewBaselineSample struct {
	WorkID          uuid.UUID          `json:"work_id"`
	WorkRevision    int                `json:"work_revision"`
	PublishRevision int                `json:"publish_revision"`
	PublishedAt     time.Time          `json:"published_at"`
	MetricRef       *cxReviewMetricRef `json:"metric_ref"`
	Value           float64            `json:"value"`
}

type cxReviewWindowView struct {
	Window         string                          `json:"window"`
	TargetAt       *time.Time                      `json:"target_at"`
	Range          *cxReviewWindowRangeView        `json:"range"`
	MetricRef      *cxReviewMetricRef              `json:"metric_ref"`
	Ratios         cxReviewRatiosResult            `json:"ratios"`
	MissingReasons []string                        `json:"missing_reasons"`
	Baseline       map[string]cxReviewBaselineStat `json:"baseline"`
	Coverage       cxReviewWindowCoverage          `json:"coverage"`
}

func cxReviewMetricReference(metric *Metric) *cxReviewMetricRef {
	if metric == nil {
		return nil
	}
	return &cxReviewMetricRef{ID: metric.ID, Revision: metric.Revision, Source: metric.Source,
		CapturedAt: metric.CapturedAt, Quality: metric.QualityState, ReadUnit: metric.ReadUnit, ShareUnit: metric.ShareUnit}
}

func cxReviewFormalCount(metrics []Metric, publishedAt *time.Time, key string) int {
	if publishedAt == nil {
		return 0
	}
	start, end, _, ok := cxReviewWindowRange(*publishedAt, key)
	if !ok {
		return 0
	}
	count := 0
	for _, metric := range metrics {
		if !metric.CapturedAt.Before(start) && !metric.CapturedAt.After(end) && metric.QualityState == metricQualityApproved && cxReviewSourceRank(metric.Source) != int(^uint(0)>>1) {
			count++
		}
	}
	return count
}

func cxReviewRatioByKey(ratios cxReviewRatiosResult, key string) cxReviewRatio {
	switch key {
	case "favorite_rate":
		return ratios.FavoriteRate
	case "follow_rate":
		return ratios.FollowRate
	case "interaction_rate":
		return ratios.InteractionRate
	default:
		return cxReviewRatio{MissingReasons: []string{"invalid_metric_key"}}
	}
}

func cxReviewBaseline(work cxReviewWorkSnapshot, window string, current *Metric, key string, prior []cxReviewWorkSnapshot) cxReviewBaselineStat {
	stat := cxReviewBaselineStat{ReadUnit: "", ShareUnit: "", ExcludedCount: len(prior)}
	if current == nil || !cxReviewKnownReadUnit(current.ReadUnit) {
		return stat
	}
	stat.ReadUnit, stat.ShareUnit = current.ReadUnit, current.ShareUnit
	values := make([]float64, 0, len(prior))
	stat.Samples = []cxReviewBaselineSample{}
	for _, candidate := range prior {
		metric, _, _ := selectCXReviewWindowMetric(candidate.Metrics, candidate.PublishedAt, window)
		if metric == nil || metric.ReadUnit != current.ReadUnit {
			continue
		}
		if key == "interaction_rate" && metric.ShareUnit != current.ShareUnit {
			continue
		}
		ratio := cxReviewRatioByKey(cxReviewRatios(metric), key)
		if ratio.Value == nil {
			continue
		}
		values = append(values, *ratio.Value)
		stat.Samples = append(stat.Samples, cxReviewBaselineSample{WorkID: candidate.ID, WorkRevision: candidate.Revision,
			PublishRevision: candidate.PublishRevision, PublishedAt: *candidate.PublishedAt, MetricRef: cxReviewMetricReference(metric), Value: *ratio.Value})
	}
	stat.SampleSize = len(values)
	stat.ExcludedCount = len(prior) - len(values)
	if len(values) >= 5 {
		stat.Median = cxReviewMedian(values)
	}
	return stat
}

func (s *Server) getCXReviewMetricWindows(w http.ResponseWriter, r *http.Request) error {
	meta, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	work, err := s.cxReviewWorkSnapshot(r.Context(), meta.Account.ID, meta.ID)
	if err != nil {
		return err
	}
	var prior []cxReviewWorkSnapshot
	if work.PublishedAt != nil {
		prior, err = s.cxReviewPriorWorks(r.Context(), meta.Account.ID, *work.PublishedAt, work.ContentFormat, 10)
		if err != nil {
			return err
		}
	}
	views := make([]cxReviewWindowView, 0, len(cxReviewWindows))
	coverage := map[string]cxReviewWindowCoverage{}
	for _, definition := range cxReviewWindows {
		picked, retained, reasons := selectCXReviewWindowMetric(work.Metrics, work.PublishedAt, definition.Key)
		view := cxReviewWindowView{Window: definition.Key, MetricRef: cxReviewMetricReference(picked),
			Ratios: cxReviewRatios(picked), MissingReasons: append([]string(nil), reasons...),
			Baseline: map[string]cxReviewBaselineStat{}, Coverage: cxReviewWindowCoverage{RetainedSnapshots: retained}}
		if work.PublishedAt != nil {
			start, end, target, _ := cxReviewWindowRange(*work.PublishedAt, definition.Key)
			view.TargetAt = &target
			view.Range = &cxReviewWindowRangeView{From: start, To: end}
		}
		view.Coverage.FormalSnapshots = cxReviewFormalCount(work.Metrics, work.PublishedAt, definition.Key)
		if picked != nil {
			for _, ratio := range []cxReviewRatio{view.Ratios.FavoriteRate, view.Ratios.FollowRate, view.Ratios.InteractionRate} {
				view.MissingReasons = append(view.MissingReasons, ratio.MissingReasons...)
			}
		}
		view.MissingReasons = cxSortedUnique(view.MissingReasons)
		for _, metricKey := range []string{"favorite_rate", "follow_rate", "interaction_rate"} {
			view.Baseline[metricKey] = cxReviewBaseline(work, definition.Key, picked, metricKey, prior)
		}
		coverage[definition.Key] = view.Coverage
		views = append(views, view)
	}
	return ok(w, map[string]any{
		"publication_basis": map[string]any{"published_at": work.PublishedAt, "publish_revision": work.PublishRevision, "work_id": work.ID},
		"windows":           views,
		"sampling":          map[string]any{"mode": "retained_snapshots", "coverage": coverage, "retained_snapshot_count": len(work.Metrics)},
	})
}

type cxReviewCompareItem struct {
	WorkID         uuid.UUID            `json:"work_id"`
	Title          string               `json:"title"`
	ContentFormat  string               `json:"content_format"`
	PublishedAt    time.Time            `json:"published_at"`
	Window         string               `json:"window"`
	TargetAt       time.Time            `json:"target_at"`
	MetricRef      *cxReviewMetricRef   `json:"metric_ref"`
	Ratios         cxReviewRatiosResult `json:"ratios"`
	MissingReasons []string             `json:"missing_reasons"`
	ReadUnit       string               `json:"read_unit,omitempty"`
	ShareUnit      string               `json:"share_unit,omitempty"`
}

func (s *Server) listCXReviewMetricCompare(w http.ResponseWriter, r *http.Request) error {
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	window := strings.TrimSpace(r.URL.Query().Get("window"))
	if _, _, _, ok := cxReviewWindowRange(time.Now(), window); !ok {
		return validation("时间窗口必须是 T1、T3、T7 或 T30")
	}
	contentFormat := strings.TrimSpace(r.URL.Query().Get("content_format"))
	if a.Platform == "toutiao" {
		if contentFormat == "" {
			contentFormat = a.ContentFormat
		}
		if contentFormat != "long_article" && contentFormat != "micro_post" {
			return validation("请选择文章或微头条后比较")
		}
	} else if contentFormat != "" && contentFormat != a.ContentFormat {
		return validation("该账号不支持所选比较形态")
	}
	cursor, err := parseListCursor(r)
	if err != nil {
		return err
	}
	rows, err := s.db.Query(r.Context(), `SELECT w.id,w.title,w.content_format,w.published_at,w.publish_revision
		FROM work w JOIN platform_account a ON a.id=w.account_id
		WHERE w.account_id=$1 AND a.workspace_id=$2 AND w.deleted_at IS NULL AND w.status='published'
		AND w.published_at IS NOT NULL AND ($3='' OR w.content_format=$3)
		AND ($4::timestamptz IS NULL OR (w.published_at,w.id)<($4,$5))
		ORDER BY w.published_at DESC,w.id DESC LIMIT 21`, a.ID, ident(r.Context()).WorkspaceID, contentFormat,
		cursorTime(cursor), cursorID(cursor))
	if err != nil {
		return err
	}
	type rowWork struct {
		id            uuid.UUID
		title, format string
		published     time.Time
		revision      int
	}
	works := []rowWork{}
	for rows.Next() {
		var item rowWork
		if err := rows.Scan(&item.id, &item.title, &item.format, &item.published, &item.revision); err != nil {
			rows.Close()
			return err
		}
		works = append(works, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	var nextCursor *string
	if len(works) > 20 {
		last := works[19]
		value := encodeListCursor(last.published, last.id)
		nextCursor = &value
		works = works[:20]
	}
	ids := make([]uuid.UUID, 0, len(works))
	for _, work := range works {
		ids = append(ids, work.id)
	}
	metrics, err := s.loadCXReviewMetrics(r.Context(), ids)
	if err != nil {
		return err
	}
	items := make([]cxReviewCompareItem, 0, len(works))
	for _, work := range works {
		picked, _, reasons := selectCXReviewWindowMetric(metrics[work.id], &work.published, window)
		ratios := cxReviewRatios(picked)
		for _, ratio := range []cxReviewRatio{ratios.FavoriteRate, ratios.FollowRate, ratios.InteractionRate} {
			reasons = append(reasons, ratio.MissingReasons...)
		}
		_, _, targetAt, _ := cxReviewWindowRange(work.published, window)
		item := cxReviewCompareItem{WorkID: work.id, Title: work.title, ContentFormat: work.format, PublishedAt: work.published,
			Window: window, TargetAt: targetAt, MetricRef: cxReviewMetricReference(picked), Ratios: ratios, MissingReasons: cxSortedUnique(reasons)}
		if picked != nil {
			item.ReadUnit, item.ShareUnit = picked.ReadUnit, picked.ShareUnit
		}
		items = append(items, item)
	}
	return ok(w, map[string]any{"items": items, "next_cursor": nextCursor, "sampling": "retained_snapshots"})
}

func cxSortedUnique(values []string) []string {
	values = uniqueStrings(values)
	sort.Strings(values)
	return values
}
