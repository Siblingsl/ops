package app

import (
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestCXReviewWindowBoundsAndTieBreak(t *testing.T) {
	published := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	start, end, target, ok := cxReviewWindowRange(published, "T1")
	if !ok || !start.Equal(published.Add(18*time.Hour)) || !end.Equal(published.Add(30*time.Hour)) || !target.Equal(published.Add(24*time.Hour)) {
		t.Fatalf("unexpected T1 range: start=%v end=%v target=%v ok=%v", start, end, target, ok)
	}
	tooEarly := cxReviewMetric(published.Add(17*time.Hour), "wechat_api", "users", "times", 1)
	tooLate := cxReviewMetric(published.Add(31*time.Hour), "wechat_api", "users", "times", 2)
	earlyTie := cxReviewMetric(published.Add(20*time.Hour), "manual", "users", "times", 3)
	lateTie := cxReviewMetric(published.Add(28*time.Hour), "wechat_api", "users", "times", 4)
	picked, count, reasons := selectCXReviewWindowMetric([]Metric{tooEarly, tooLate, lateTie, earlyTie}, &published, "T1")
	if picked == nil || picked.ID != earlyTie.ID || count != 2 || len(reasons) != 0 {
		t.Fatalf("20h/28h tie must choose the earlier sample and exclude out-of-range rows: picked=%+v count=%d reasons=%v", picked, count, reasons)
	}
}

func TestCXReviewWindowRequiresFormalMetricsAndKnownUnits(t *testing.T) {
	published := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	metric := cxReviewMetric(published.Add(24*time.Hour), "manual", "unknown", "unknown", 1)
	metric.QualityState = "held"
	picked, _, reasons := selectCXReviewWindowMetric([]Metric{metric}, &published, "T1")
	if picked != nil || len(reasons) == 0 || reasons[0] != "missing_metric" {
		t.Fatalf("held snapshots must not become formal window metrics: picked=%+v reasons=%v", picked, reasons)
	}
	metric.QualityState = "approved"
	picked, _, reasons = selectCXReviewWindowMetric([]Metric{metric}, &published, "T1")
	if picked == nil || len(reasons) == 0 || reasons[0] != "read_unit_unknown" {
		t.Fatalf("approved unknown-unit sample remains visible but cannot be a denominator: picked=%+v reasons=%v", picked, reasons)
	}
	picked, _, reasons = selectCXReviewWindowMetric([]Metric{metric}, nil, "T1")
	if picked != nil || len(reasons) == 0 || reasons[0] != "missing_published_at" {
		t.Fatalf("missing publication time must be explicit: picked=%+v reasons=%v", picked, reasons)
	}
}

func TestCXReviewRatiosKeepZeroAndRejectMissingOrIncompatibleValues(t *testing.T) {
	metric := cxReviewMetric(time.Now(), "manual", "users", "times", 1)
	reads, likes, favorites, comments, shares, follows := 100, 0, 0, 0, 0, 0
	metric.Reads, metric.Likes, metric.Favorites, metric.Comments, metric.Shares, metric.FollowsGained = &reads, &likes, &favorites, &comments, &shares, &follows
	ratios := cxReviewRatios(&metric)
	for key, ratio := range map[string]cxReviewRatio{"favorite_rate": ratios.FavoriteRate, "interaction_rate": ratios.InteractionRate, "follow_rate": ratios.FollowRate} {
		if ratio.Value == nil || *ratio.Value != 0 || len(ratio.MissingReasons) != 0 {
			t.Errorf("%s must preserve a real zero: %+v", key, ratio)
		}
	}
	metric.Reads = nil
	ratios = cxReviewRatios(&metric)
	if ratios.FavoriteRate.Value != nil || !cxReviewHasReason(ratios.FavoriteRate.MissingReasons, "reads_missing") {
		t.Errorf("missing reads must produce null with a reason: %+v", ratios.FavoriteRate)
	}
	metric.Reads = &reads
	metric.Shares = &shares
	metric.ShareUnit = "users"
	ratios = cxReviewRatios(&metric)
	if ratios.InteractionRate.Value != nil || !cxReviewHasReason(ratios.InteractionRate.MissingReasons, "share_unit_incompatible") {
		t.Errorf("incompatible share unit must invalidate interaction rate: %+v", ratios.InteractionRate)
	}
}

func cxReviewHasReason(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}

func TestCXReviewMedianUsesEvenMiddlePair(t *testing.T) {
	median := cxReviewMedian([]float64{0.1, 0.4, 0.2, 0.3})
	if median == nil || *median != 0.25 {
		t.Fatalf("even median must average the middle pair: %v", median)
	}
	if cxReviewMedian(nil) != nil {
		t.Fatal("empty sample must have no median")
	}
}

func cxReviewMetric(at time.Time, source, readUnit, shareUnit string, id int) Metric {
	reads, likes, favorites, comments, shares, follows := 10, 2, 3, 4, 5, 1
	return Metric{ID: uuid.NewSHA1(uuid.NameSpaceOID, []byte{byte(id)}), CapturedAt: at, Source: source,
		QualityState: "approved", ReadUnit: readUnit, ShareUnit: shareUnit,
		Reads: &reads, Likes: &likes, Favorites: &favorites, Comments: &comments, Shares: &shares, FollowsGained: &follows}
}
