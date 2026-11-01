package app

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestCXReviewWindowsSelectExactSnapshotsAndSameUnitBaseline(t *testing.T) {
	account := cxReviewCreateAccount(t, "xhs", "image_note")
	now := time.Now().UTC().Truncate(time.Second)
	currentAt := now.Add(-20 * 24 * time.Hour)
	current := cxReviewSeedWork(t, account.ID, "当前复盘作品", "image_note", currentAt)
	metric20 := cxReviewInsertMetric(t, current.ID, currentAt.Add(20*time.Hour), "manual", "users", "times", 100, 10, 20, 2, 3, 1, "approved")
	_ = cxReviewInsertMetric(t, current.ID, currentAt.Add(28*time.Hour), "wechat_api", "users", "times", 100, 90, 99, 99, 99, 99, "approved")
	_ = cxReviewInsertMetric(t, current.ID, currentAt.Add(17*time.Hour), "file", "users", "times", 100, 90, 99, 99, 99, 99, "approved")
	_ = cxReviewInsertMetric(t, current.ID, currentAt.Add(168*time.Hour), "manual", "users", "times", 100, 10, 20, 2, 3, 1, "approved")

	priorRatios := []int{10, 20, 30, 40, 50, 60}
	for i, favorites := range priorRatios {
		published := currentAt.AddDate(0, 0, -(i + 1))
		work := cxReviewSeedWork(t, account.ID, fmt.Sprintf("历史作品 %d", i), "image_note", published)
		cxReviewInsertMetric(t, work.ID, published.Add(168*time.Hour), "manual", "users", "times", 100, 10, favorites, 2, 3, 1, "approved")
	}
	future := cxReviewSeedWork(t, account.ID, "未来发布作品", "image_note", currentAt.Add(time.Hour))
	cxReviewInsertMetric(t, future.ID, future.PublishedAt.Add(168*time.Hour), "manual", "users", "times", 100, 10, 100, 2, 3, 1, "approved")

	var windows struct {
		PublicationBasis struct {
			PublishRevision int `json:"publish_revision"`
		} `json:"publication_basis"`
		Windows  []cxReviewWindowView `json:"windows"`
		Sampling struct {
			Mode string `json:"mode"`
		} `json:"sampling"`
	}
	env.mustJSON(t, "GET", "/api/v1/works/"+current.ID.String()+"/metrics/windows", nil, &windows)
	if windows.Sampling.Mode != "retained_snapshots" || len(windows.Windows) != 4 {
		t.Fatalf("window response must declare retained snapshot sampling: %+v", windows)
	}
	byWindow := map[string]cxReviewWindowView{}
	for _, window := range windows.Windows {
		byWindow[window.Window] = window
	}
	t1 := byWindow["T1"]
	if t1.MetricRef == nil || t1.MetricRef.ID != metric20.ID || t1.MetricRef.Source != "manual" {
		t.Fatalf("20h/28h tie must use the earlier retained metric: %+v", t1)
	}
	if t1.Ratios.FavoriteRate.Value == nil || *t1.Ratios.FavoriteRate.Value != 0.2 {
		t.Fatalf("favorite rate should use selected snapshot: %+v", t1.Ratios.FavoriteRate)
	}
	baseline := byWindow["T7"].Baseline["favorite_rate"]
	if baseline.SampleSize != 6 || baseline.ExcludedCount != 0 || baseline.Median == nil || *baseline.Median != 0.35 {
		t.Fatalf("baseline should use six earlier same-unit works and exclude future work: %+v", baseline)
	}

	var compare struct {
		Items      []cxReviewCompareItem `json:"items"`
		NextCursor *string               `json:"next_cursor"`
	}
	env.mustJSON(t, "GET", "/api/v1/accounts/"+account.ID.String()+"/metrics/compare?window=T7", nil, &compare)
	if len(compare.Items) == 0 || compare.Items[0].WorkID != future.ID {
		t.Fatalf("comparison should use published-time descending order: %+v", compare.Items)
	}
}

func TestCXReviewWindowsMissingPublicationAndQualityAreExplicit(t *testing.T) {
	account := cxReviewCreateAccount(t, "wechat_mp", "long_article")
	work := cxReviewSeedWork(t, account.ID, "缺发布时间", account.ContentFormat, time.Time{})
	// Keep work.status='published' while leaving published_at NULL, matching imported historical facts.
	if _, err := env.srv.db.Exec(context.Background(), `UPDATE work SET published_at=NULL WHERE id=$1`, work.ID); err != nil {
		t.Fatal(err)
	}
	_ = cxReviewInsertMetric(t, work.ID, time.Now().UTC(), "manual", "users", "times", 100, 10, 5, 2, 3, 1, "approved")
	var response struct {
		Windows []cxReviewWindowView `json:"windows"`
	}
	env.mustJSON(t, "GET", "/api/v1/works/"+work.ID.String()+"/metrics/windows", nil, &response)
	if len(response.Windows) != 4 || response.Windows[0].TargetAt != nil || len(response.Windows[0].MissingReasons) == 0 || response.Windows[0].MissingReasons[0] != "missing_published_at" {
		t.Fatalf("missing publication time must not be replaced by a synthetic date: %+v", response.Windows)
	}
}

func TestCXReviewWindowResponseUsesExactRatioAndNullsForInvalidDenominator(t *testing.T) {
	account := cxReviewCreateAccount(t, "xhs", "image_note")
	published := time.Now().UTC().Add(-5 * 24 * time.Hour)
	work := cxReviewSeedWork(t, account.ID, "缺分子作品", "image_note", published)
	_ = cxReviewInsertMetric(t, work.ID, published.Add(24*time.Hour), "manual", "users", "times", 0, 0, 0, 0, 0, 0, "approved")
	var response struct {
		Windows []cxReviewWindowView `json:"windows"`
	}
	env.mustJSON(t, "GET", "/api/v1/works/"+work.ID.String()+"/metrics/windows", nil, &response)
	if response.Windows[0].Ratios.FavoriteRate.Value != nil || !cxReviewHasReason(response.Windows[0].Ratios.FavoriteRate.MissingReasons, "reads_not_positive") {
		t.Fatalf("zero reads must remain a missing ratio, never become zero rate: %+v", response.Windows[0].Ratios.FavoriteRate)
	}
	if response.Windows[0].Ratios.FollowRate.Value != nil || !cxReviewHasReason(response.Windows[0].Ratios.FollowRate.MissingReasons, "reads_not_positive") {
		t.Fatalf("follow rate must not coalesce invalid denominator: %+v", response.Windows[0].Ratios.FollowRate)
	}
	var encoded []byte
	encoded, _ = json.Marshal(response)
	if len(encoded) == 0 {
		t.Fatal("response should remain JSON serializable")
	}
}

func cxReviewCreateAccount(t *testing.T, platform, contentFormat string) Account {
	t.Helper()
	var account Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{"platform": platform, "name": "CX21复盘测试" + uuid.NewString()[:8], "content_format": contentFormat}, &account)
	return account
}
