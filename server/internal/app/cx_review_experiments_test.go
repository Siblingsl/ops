package app

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestCXReviewExperimentSelectionValidation(t *testing.T) {
	account := env.accounts(t).xhs
	input := cxReviewExperimentInput{
		Hypothesis: "更具体的标题会提高收藏率",
		Variable:   "title", MetricKey: "favorite_rate", Window: "T7",
		BaselineFrom: "2026-10-01", BaselineTo: "2026-10-10", ResultFrom: "2026-10-11", ResultTo: "2026-10-20",
		SelectionBasis: cxReviewExperimentSelectionInput{Timezone: "Asia/Shanghai", Platform: "xhs", ContentFormat: "image_note", ReadUnit: "users", ShareUnit: "times"},
	}
	selection, _, _, err := validateCXReviewExperimentInput(&account, input)
	if err != nil || selection.Platform != "xhs" || selection.ContentFormat != "image_note" || selection.Timezone != "Asia/Shanghai" {
		t.Fatalf("valid selection should freeze the account and sample basis: %+v err=%v", selection, err)
	}
	input.SelectionBasis.Platform = "wechat_mp"
	if _, _, _, err := validateCXReviewExperimentInput(&account, input); err == nil {
		t.Fatal("selection may not change the account platform")
	}
	input.SelectionBasis.Platform = "xhs"
	input.ResultFrom = input.BaselineTo
	if _, _, _, err := validateCXReviewExperimentInput(&account, input); err == nil {
		t.Fatal("date ranges must not overlap")
	}
	input.ResultFrom = "2026-10-11"
	input.SelectionBasis.ReadUnit = "unknown"
	if _, _, _, err := validateCXReviewExperimentInput(&account, input); err == nil {
		t.Fatal("unknown denominator unit cannot define an experiment")
	}
	input.SelectionBasis.ReadUnit = "users"
	input.Variable = "format"
	if _, _, _, err := validateCXReviewExperimentInput(&account, input); err == nil {
		t.Fatal("format experiments require explicit comparison groups")
	}
	input.SelectionBasis.BaselineContentFormat = "image_note"
	input.SelectionBasis.ResultContentFormat = "comic"
	if _, _, _, err := validateCXReviewExperimentInput(&account, input); err != nil {
		t.Fatalf("explicit same-platform format groups should be accepted: %v", err)
	}
}

func TestCXReviewExperimentCreateConcludeCASAndStaleBasis(t *testing.T) {
	account := env.accounts(t).xhs
	now := time.Now().In(env.srv.loc)
	baseFrom, baseTo := now.AddDate(0, 0, -14), now.AddDate(0, 0, -8)
	resultFrom, resultTo := now.AddDate(0, 0, -7), now.AddDate(0, 0, -1)
	seedCXReviewExperimentWorks(t, account.ID, "image_note", baseFrom, baseTo, 3)
	seedCXReviewExperimentWorks(t, account.ID, "image_note", resultFrom, resultTo, 3)
	path := "/api/v1/accounts/" + account.ID.String() + "/experiments"
	input := cxReviewExperimentRequest(account, baseFrom, baseTo, resultFrom, resultTo)
	var created cxReviewExperiment
	env.mustJSON(t, "POST", path, input, &created)
	if created.Status != "running" || created.Revision != 1 {
		t.Fatalf("unexpected running experiment: %+v", created)
	}
	if status, body := env.do("POST", path, input); status != 409 {
		t.Fatalf("second running experiment for an account must conflict: status=%d body=%s", status, body)
	}
	var concluded cxReviewExperiment
	env.mustJSON(t, "POST", "/api/v1/experiments/"+created.ID.String()+"/conclude", map[string]any{
		"base_revision": 1, "conclusion": "support", "note": "按同一窗口观察",
	}, &concluded)
	if concluded.Status != "concluded" || concluded.Revision != 2 || concluded.Stale {
		t.Fatalf("valid experiment should conclude with a current snapshot: %+v", concluded)
	}
	var snapshot cxReviewExperimentSnapshot
	if err := json.Unmarshal(concluded.ResultSnapshot, &snapshot); err != nil || len(snapshot.Baseline) != 3 || len(snapshot.Result) != 3 {
		t.Fatalf("support requires three valid samples on each side: %+v err=%v", snapshot, err)
	}
	if status, body := env.do("POST", "/api/v1/experiments/"+created.ID.String()+"/conclude", map[string]any{
		"base_revision": 1, "conclusion": "reject", "note": "stale request",
	}); status != 409 {
		t.Fatalf("repeat transition must fail CAS: status=%d body=%s", status, body)
	}
	if len(snapshot.Result) == 0 {
		t.Fatal("expected result references")
	}
	ref := snapshot.Result[0]
	if _, err := env.srv.db.Exec(context.Background(), `UPDATE metric_snapshot SET favorites=favorites+1 WHERE id=$1`, ref.MetricID); err != nil {
		t.Fatal(err)
	}
	var detail cxReviewExperiment
	env.mustJSON(t, "GET", "/api/v1/experiments/"+created.ID.String(), nil, &detail)
	if !detail.Stale {
		t.Fatalf("metric revision change must mark the frozen conclusion stale: %+v", detail)
	}
}

func TestCXReviewExperimentLowSampleOnlyAllowsInconclusiveAndAbandonReleasesSlot(t *testing.T) {
	account := env.accounts(t).wechat
	now := time.Now().In(env.srv.loc)
	baseFrom, baseTo := now.AddDate(0, 0, -14), now.AddDate(0, 0, -8)
	resultFrom, resultTo := now.AddDate(0, 0, -7), now.AddDate(0, 0, -1)
	path := "/api/v1/accounts/" + account.ID.String() + "/experiments"
	input := cxReviewExperimentRequest(account, baseFrom, baseTo, resultFrom, resultTo)
	var created cxReviewExperiment
	env.mustJSON(t, "POST", path, input, &created)
	if status, body := env.do("POST", "/api/v1/experiments/"+created.ID.String()+"/conclude", map[string]any{
		"base_revision": 1, "conclusion": "support", "note": "too few",
	}); status != 422 {
		t.Fatalf("low-sample conclusion cannot claim support: status=%d body=%s", status, body)
	}
	var abandoned cxReviewExperiment
	env.mustJSON(t, "POST", "/api/v1/experiments/"+created.ID.String()+"/abandon", map[string]any{
		"base_revision": 1, "reason": "停止本次观察",
	}, &abandoned)
	if abandoned.Status != "abandoned" || abandoned.Revision != 2 {
		t.Fatalf("abandon must release the account running slot: %+v", abandoned)
	}
	var replacement cxReviewExperiment
	env.mustJSON(t, "POST", path, input, &replacement)
	if replacement.Status != "running" {
		t.Fatalf("a new experiment should start after explicit abandon: %+v", replacement)
	}
}

func cxReviewExperimentRequest(account Account, baselineFrom, baselineTo, resultFrom, resultTo time.Time) map[string]any {
	return map[string]any{
		"hypothesis": "标题信息更具体会提高收藏率", "variable": "title", "metric_key": "favorite_rate", "window": "T7",
		"selection_basis": map[string]any{"timezone": "Asia/Shanghai", "platform": account.Platform,
			"content_format": account.ContentFormat, "read_unit": "users", "share_unit": "times"},
		"baseline_from": baselineFrom.Format("2006-01-02"), "baseline_to": baselineTo.Format("2006-01-02"),
		"result_from": resultFrom.Format("2006-01-02"), "result_to": resultTo.Format("2006-01-02"),
	}
}

func seedCXReviewExperimentWorks(t *testing.T, accountID uuid.UUID, format string, from, to time.Time, count int) {
	t.Helper()
	for i := 0; i < count; i++ {
		published := from.Add(time.Duration(i) * time.Hour)
		if published.After(to) {
			published = to.Add(-time.Duration(i) * time.Hour)
		}
		work := cxReviewSeedWork(t, accountID, "实验作品", format, published)
		cxReviewInsertMetric(t, work.ID, published.Add(168*time.Hour), "manual", "users", "times", 100, 5+i, 10+i, 2, 1, 1, "approved")
	}
}
