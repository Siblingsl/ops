package app

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

// The response is injected at the model HTTP boundary; upload, parsing, persistence and confirmation remain real API calls.
func ttScreenshotModel(t *testing.T, response *string) {
	t.Helper()
	model := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		frame, _ := json.Marshal(map[string]any{"choices": []map[string]any{{"delta": map[string]string{"content": *response}}}})
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprintf(w, "data: %s\n\ndata: [DONE]\n\n", frame)
	}))
	t.Cleanup(model.Close)
	env.reauth(t)
	var p Provider
	env.mustJSON(t, "POST", "/api/v1/model-providers", map[string]any{"name": "T45受控视觉模型", "base_url": model.URL + "/v1", "api_key": "tt45-local-test-key", "models": []string{"mock-vision"}}, &p)
	env.mustJSON(t, "PUT", "/api/v1/model-routes", []map[string]any{{"task_type": "metric_screenshot", "provider_id": p.ID, "model": "mock-vision"}}, nil)
}

func ttShotJSON(w Work, raw string, metrics map[string]any) map[string]any {
	return map[string]any{"work_id": w.ID, "content_format": w.ContentFormat, "title": w.Title, "day_hint": "截至今日", "raw_text": raw, "metrics": metrics}
}

func TestToutiaoT41T45ScreenshotUncertainNetFollowersAndSevenDayCleanup(t *testing.T) {
	guest := env.registerClient(t, "tt45-"+uuid.NewString()[:8], testPassword)
	t.Cleanup(func() { guest.restore(env) })
	a := drAccount(t, "toutiao", "T41T45截图口径")
	pub := env.srv.now().AddDate(0, 0, -3)
	w := ttMetricWork(t, a, "micro_post", "没有外部标题的微头条", pub)
	other := ttMetricWork(t, a, "long_article", "逐行确认文章", pub)
	responseBytes, _ := json.Marshal(map[string]any{"rows": []map[string]any{
		ttShotJSON(w, "展现 1.2万 阅读 300 点赞看不清", map[string]any{"impressions": "1.2万", "reads": "300", "likes": "?", "comments": "999"}),
		ttShotJSON(other, "阅读 20 账号净粉丝 7", map[string]any{"reads": "20", "follows_gained": "7"}),
	}})
	response := string(responseBytes)
	ttScreenshotModel(t, &response)
	st, b := uploadShots(t, a.ID.String(), 2, "")
	if st != 200 {
		t.Fatalf("upload: %d %s", st, b)
	}
	var uploaded shotResp
	if err := json.Unmarshal(b, &uploaded); err != nil || len(uploaded.Rows) != 2 {
		t.Fatalf("rows: %v %s", err, b)
	}
	r := uploaded.Rows[0]
	if r.Impressions == nil || *r.Impressions != 12000 || r.Reads == nil || *r.Reads != 300 || r.Likes != nil || r.Comments != nil || r.RawText != "展现 1.2万 阅读 300 点赞看不清" {
		t.Fatalf("uncertain numbers invented or raw text changed: %+v", r)
	}
	if uploaded.Rows[1].FollowsGained != nil {
		t.Fatalf("account net followers mapped to per-work gained follows: %+v", uploaded.Rows[1])
	}
	if metricCount(t, w.ID)+metricCount(t, other.ID) != 0 {
		t.Fatal("recognition wrote unconfirmed rows")
	}
	path := "/api/v1/metrics/screenshots/" + uploaded.ID + "/rows/0/confirm"
	var saved Metric
	env.mustJSON(t, "POST", path, map[string]any{"work_id": w.ID, "reads": 300, "impressions": 12000}, &saved)
	if saved.Source != "screenshot" || saved.Impressions == nil || *saved.Impressions != 12000 || saved.Likes != nil {
		t.Fatalf("confirmed metric: %+v", saved)
	}
	if metricCount(t, other.ID) != 0 {
		t.Fatal("confirming first row wrote second row")
	}
	env.expectErr(t, "POST", "/api/v1/metrics/screenshots/"+uploaded.ID+"/rows/1/confirm", map[string]any{"work_id": other.ID, "reads": 20, "follows_gained": 7}, "validation_failed")
	ctx := context.Background()
	if _, err := env.srv.db.Exec(ctx, `UPDATE metric_upload SET created_at=$2 WHERE id=$1`, uploaded.ID, env.srv.now().AddDate(0, 0, -6)); err != nil {
		t.Fatal(err)
	}
	env.srv.purgeMetricUploads(ctx)
	if _, err := os.Stat(filepath.Join(env.srv.cfg.DataDir, "metric_uploads", uploaded.ID)); err != nil {
		t.Fatalf("younger-than-7d screenshot deleted: %v", err)
	}
	if _, err := env.srv.db.Exec(ctx, `UPDATE metric_upload SET created_at=$2 WHERE id=$1`, uploaded.ID, env.srv.now().AddDate(0, 0, -8)); err != nil {
		t.Fatal(err)
	}
	env.srv.purgeMetricUploads(ctx)
	var left int
	if err := env.srv.db.QueryRow(ctx, `SELECT count(*) FROM metric_upload WHERE id=$1`, uploaded.ID).Scan(&left); err != nil || left != 0 {
		t.Fatalf("expired upload remains: %d %v", left, err)
	}
	if _, err := os.Stat(filepath.Join(env.srv.cfg.DataDir, "metric_uploads", uploaded.ID)); !os.IsNotExist(err) {
		t.Fatalf("expired screenshot files remain: %v", err)
	}
	if metricCount(t, w.ID) != 1 {
		t.Fatal("cleanup removed confirmed metrics")
	}
	env.expectErr(t, "POST", path, map[string]any{"work_id": w.ID, "reads": 300}, "not_found")
}

func TestToutiaoScreenshotIntervalHintComesFromModelThroughConfirmation(t *testing.T) {
	a := drAccount(t, "toutiao", "T41截图区间识别")
	work := ttMetricWork(t, a, "micro_post", "区间标识识别作品", env.srv.now().AddDate(0, 0, -3))
	responseBytes, _ := json.Marshal(map[string]any{"rows": []map[string]any{{
		"work_id": work.ID, "content_format": work.ContentFormat, "title": work.Title,
		"published_at": "", "day_hint": "近7天", "raw_text": "近7天阅读 100",
		"metrics": map[string]any{"reads": "100"},
	}}})
	response := string(responseBytes)
	ttScreenshotModel(t, &response)
	status, body := uploadShots(t, a.ID.String(), 1, "")
	if status != 200 {
		t.Fatalf("upload: %d %s", status, body)
	}
	var uploaded shotResp
	if err := json.Unmarshal(body, &uploaded); err != nil || len(uploaded.Rows) != 1 || !uploaded.Rows[0].IntervalHint {
		t.Fatalf("model's interval hint did not survive the real upload API: %v %s", err, body)
	}
	path := "/api/v1/metrics/screenshots/" + uploaded.ID + "/rows/0/confirm"
	env.expectErr(t, "POST", path, map[string]any{"work_id": work.ID, "reads": 100}, "validation_failed")
	var saved Metric
	env.mustJSON(t, "POST", path, map[string]any{"work_id": work.ID, "reads": 100, "cumulative_confirmed": true}, &saved)
	if saved.Reads == nil || *saved.Reads != 100 || saved.Source != "screenshot" {
		t.Fatalf("confirmed cumulative snapshot: %+v", saved)
	}
}

func TestToutiaoScreenshotRejectsConflictingPublishedDateHint(t *testing.T) {
	a := drAccount(t, "toutiao", "T44截图发布日期")
	work := ttMetricWork(t, a, "micro_post", "截图日期冲突作品", env.srv.now().AddDate(0, 0, -3))
	responseBytes, _ := json.Marshal(map[string]any{"rows": []map[string]any{{
		"work_id": work.ID, "content_format": work.ContentFormat, "title": work.Title,
		"published_at": "2001-01-01", "day_hint": "截至今日", "raw_text": "阅读 100",
		"metrics": map[string]any{"reads": "100"},
	}}})
	response := string(responseBytes)
	ttScreenshotModel(t, &response)
	status, body := uploadShots(t, a.ID.String(), 1, "")
	if status != 200 {
		t.Fatalf("upload: %d %s", status, body)
	}
	var uploaded shotResp
	if err := json.Unmarshal(body, &uploaded); err != nil || len(uploaded.Rows) != 1 || uploaded.Rows[0].WorkID == nil {
		t.Fatalf("recognition did not retain its candidate: %v %s", err, body)
	}
	env.expectErr(t, "POST", "/api/v1/metrics/screenshots/"+uploaded.ID+"/rows/0/confirm", map[string]any{"work_id": work.ID, "reads": 100}, "validation_failed")
	if metricCount(t, work.ID) != 0 {
		t.Fatal("date-conflicting screenshot was imported")
	}
}

func ttSeedLearningSamples(t *testing.T, a Account, articleN, microN int) {
	t.Helper()
	ctx := context.Background()
	for _, shape := range []struct {
		format string
		n      int
	}{{"long_article", articleN}, {"micro_post", microN}} {
		if _, err := env.srv.db.Exec(ctx, `INSERT INTO work(account_id,title,content_format,status,published_at)
			SELECT $1,CASE WHEN i%2=0 THEN '2026高表现标题'||i ELSE '普通写作标题' END,$2,'published',$3::timestamptz+i*interval '1 second'
			FROM generate_series(1,$4) i`, a.ID, shape.format, env.srv.now().AddDate(0, 0, -20), shape.n); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO metric_snapshot(work_id,captured_at,source,day_offset,reads,likes)
		SELECT id,published_at+interval '7 days','manual',7,CASE WHEN title LIKE '2026%' THEN 2000 ELSE 500 END,1 FROM work WHERE account_id=$1`, a.ID); err != nil {
		t.Fatal(err)
	}
}

func TestToutiaoT46MixedFormatsShareFiveHundredWindowAndNeverBorrowSamples(t *testing.T) {
	a := drAccount(t, "toutiao", "T46五百总窗口")
	ttSeedLearningSamples(t, a, 491, 10)
	ctx := context.Background()
	// Keep the nine newest micro-posts inside the shared window and move one just outside it.
	if _, err := env.srv.db.Exec(ctx, `UPDATE work SET published_at=CASE WHEN title='普通写作标题' AND id=(SELECT id FROM work WHERE account_id=$1 AND content_format='micro_post' ORDER BY published_at LIMIT 1)
		THEN published_at-interval '30 days' ELSE published_at+interval '1 day' END WHERE account_id=$1 AND content_format='micro_post'`, a.ID); err != nil {
		t.Fatal(err)
	}
	samples, err := env.srv.perfSamples(ctx, a.ID)
	if err != nil || len(samples) != 500 {
		t.Fatalf("bounded window: %d %v", len(samples), err)
	}
	counts := map[string]int{}
	for _, s := range samples {
		counts[s.ContentFormat]++
	}
	if counts["long_article"] != 491 || counts["micro_post"] != 9 {
		t.Fatalf("per-format 500 window was used: %+v", counts)
	}
	var out struct {
		Enough   bool          `json:"enough"`
		Samples  int           `json:"samples"`
		Need     int           `json:"need"`
		Features []AttrFeature `json:"features"`
	}
	env.llm.ResetRequests()
	env.mustJSON(t, "POST", "/api/v1/accounts/"+a.ID.String()+"/reviews/attribution", map[string]string{"content_format": "micro_post"}, &out)
	if out.Enough || out.Samples != 9 || out.Need != 10 || len(out.Features) != 0 {
		t.Fatalf("insufficient micro samples borrowed articles: %+v", out)
	}
	if len(env.llm.Requests()) != 0 {
		t.Fatal("insufficient samples reached model")
	}
	var tops []struct {
		ContentFormat string    `json:"content_format"`
		WorkID        uuid.UUID `json:"work_id"`
	}
	for _, format := range []string{"long_article", "micro_post"} {
		env.mustJSON(t, "GET", "/api/v1/accounts/"+a.ID.String()+"/top-works?content_format="+format, nil, &tops)
		want := 49
		if format == "micro_post" {
			want = 1
		}
		if len(tops) != want {
			t.Fatalf("%s top10%%=%d want=%d", format, len(tops), want)
		}
		for _, top := range tops {
			if top.ContentFormat != format {
				t.Fatalf("high performer crossed shape: %+v", top)
			}
		}
	}
	for _, p := range preferenceViews(t, a.ID) {
		if strings.HasPrefix(p.Feature, "micro_post:") {
			t.Fatalf("insufficient shape learned preference: %+v", p)
		}
	}
	// Existing 3-per-side and 20% thresholds remain in effect through the attribution API.
	threshold := drAccount(t, "toutiao", "T46阈值保持")
	ttSeedLearningSamples(t, threshold, 10, 10)
	if _, err := env.srv.db.Exec(ctx, `UPDATE metric_snapshot SET reads=CASE WHEN w.title LIKE '2026%' THEN 119 ELSE 100 END FROM work w WHERE w.id=work_id AND w.account_id=$1`, threshold.ID); err != nil {
		t.Fatal(err)
	}
	env.mustJSON(t, "POST", "/api/v1/accounts/"+threshold.ID.String()+"/reviews/attribution", map[string]string{"content_format": "long_article"}, &out)
	if !out.Enough || out.Samples != 10 {
		t.Fatalf("qualified shape count: %+v", out)
	}
	if got := preferenceViews(t, threshold.ID); len(got) != 0 {
		t.Fatalf("19%% difference lowered threshold: %+v", got)
	}
	if _, err := env.srv.db.Exec(ctx, `UPDATE work SET title=CASE WHEN id IN
		(SELECT id FROM work WHERE account_id=$1 AND content_format='long_article' ORDER BY id LIMIT 2) THEN '2026样本' ELSE '普通样本' END
		WHERE account_id=$1 AND content_format='long_article'`, threshold.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(ctx, `UPDATE metric_snapshot SET reads=CASE WHEN w.title='2026样本' THEN 2000 ELSE 100 END
		FROM work w WHERE w.id=work_id AND w.account_id=$1 AND w.content_format='long_article'`, threshold.ID); err != nil {
		t.Fatal(err)
	}
	env.mustJSON(t, "POST", "/api/v1/accounts/"+threshold.ID.String()+"/reviews/attribution", map[string]string{"content_format": "long_article"}, &out)
	if got := preferenceViews(t, threshold.ID); len(got) != 0 {
		t.Fatalf("two samples on winning side lowered 3-per-side threshold: %+v", got)
	}
}

func TestToutiaoT47DualShapeAtomicCASAndMissingShapeBasisNotInjected(t *testing.T) {
	a := drAccount(t, "toutiao", "T47双形态CAS")
	ttSeedLearningSamples(t, a, 10, 10)
	ctx := context.Background()
	var attr any
	env.mustJSON(t, "POST", "/api/v1/accounts/"+a.ID.String()+"/reviews/attribution", map[string]string{"content_format": "long_article"}, &attr)
	revision := prefInputRevision(t, a.ID)
	if prefProcessedRevision(t, a.ID) != revision {
		t.Fatal("both shapes did not advance processed revision together")
	}
	views := preferenceViews(t, a.ID)
	seen := map[string]bool{}
	for _, p := range views {
		if !p.Applicable || p.BasisSampleCount != 10 {
			t.Fatalf("partial publication: %+v", p)
		}
		seen[strings.Split(p.Feature, ":")[0]] = true
	}
	if !seen["long_article"] || !seen["micro_post"] {
		t.Fatalf("missing published shape: %+v", views)
	}
	samples, err := env.srv.perfSamples(ctx, a.ID)
	if err != nil {
		t.Fatal(err)
	}
	// Force failure on the second shape to prove neither the first shape nor processed revision commits partially.
	triggerName := "tt47_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	if _, err := env.srv.db.Exec(ctx, fmt.Sprintf(`CREATE FUNCTION %s() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
		IF NEW.account_id='%s'::uuid AND NEW.feature LIKE 'micro_post:%%' THEN RAISE EXCEPTION 'TT47 second shape failure'; END IF;
		RETURN NEW; END $$`, triggerName, a.ID)); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		env.srv.db.Exec(context.Background(), `DROP TRIGGER IF EXISTS `+triggerName+` ON account_data_preference`)
		env.srv.db.Exec(context.Background(), `DROP FUNCTION IF EXISTS `+triggerName+`()`)
	})
	if _, err := env.srv.db.Exec(ctx, `CREATE TRIGGER `+triggerName+` BEFORE INSERT ON account_data_preference FOR EACH ROW EXECUTE FUNCTION `+triggerName+`()`); err != nil {
		t.Fatal(err)
	}
	if applied, err := env.srv.persistToutiaoDataPreferences(ctx, a.ID, revision, samples, false); err == nil || applied {
		t.Fatalf("forced second shape failure committed: %v %v", applied, err)
	}
	rolledBack := preferenceViews(t, a.ID)
	if len(rolledBack) != len(views) || prefProcessedRevision(t, a.ID) != revision {
		t.Fatalf("partial two-shape rollback: %+v", rolledBack)
	}
	for i, p := range rolledBack {
		if p.ID != views[i].ID {
			t.Fatal("first shape deletion escaped second shape rollback")
		}
	}
	if _, err := env.srv.db.Exec(ctx, `DROP TRIGGER `+triggerName+` ON account_data_preference`); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(ctx, `UPDATE work SET topics=ARRAY['输入变化'] WHERE account_id=$1 AND content_format='micro_post'`, a.ID); err != nil {
		t.Fatal(err)
	}
	if applied, err := env.srv.persistToutiaoDataPreferences(ctx, a.ID, revision, samples, false); err != nil || applied {
		t.Fatalf("obsolete two-shape CAS committed: applied=%v err=%v", applied, err)
	}
	if prefProcessedRevision(t, a.ID) != revision {
		t.Fatal("obsolete CAS advanced processed revision")
	}
	for _, format := range []string{"long_article", "micro_post"} {
		p, err := env.srv.loadDataPreferences(ctx, a.ID, format)
		if err != nil || len(p) != 0 {
			t.Fatalf("%s stale injection: %v %+v", format, err, p)
		}
	}
	env.mustJSON(t, "POST", "/api/v1/accounts/"+a.ID.String()+"/reviews/attribution", map[string]string{"content_format": "micro_post"}, &attr)
	// Remove only the shape metadata while retaining an otherwise current basis.
	if _, err := env.srv.db.Exec(ctx, `UPDATE account_data_preference SET basis_meta=basis_meta-'content_format' WHERE account_id=$1 AND feature LIKE 'micro_post:%'`, a.ID); err != nil {
		t.Fatal(err)
	}
	prefs, err := env.srv.loadDataPreferences(ctx, a.ID, "micro_post")
	if err != nil || len(prefs) != 0 {
		t.Fatalf("missing-shape basis injected: %v %+v", err, prefs)
	}
	// Exercise a real title-generation call; audit refs must not advertise the missing-basis preferences.
	target := ttMetricWork(t, a, "micro_post", "生成验证当前偏好", env.srv.now())
	if _, err := env.srv.db.Exec(ctx, `UPDATE platform_account SET pref_processed_revision=pref_input_revision WHERE id=$1`, a.ID); err != nil {
		t.Fatal(err)
	}
	env.llm.ResetRequests()
	env.mustJSON(t, "POST", "/api/v1/works/"+target.ID.String()+"/titles", nil, nil)
	if strings.Contains(strings.Join(env.llm.Requests(), "\n"), "读者数据偏好") {
		t.Fatal("missing/stale shape basis reached generation prompt")
	}
	// Compete the real two-shape persistence with a newer input. Either lock order must make old conclusions unusable.
	revision = prefInputRevision(t, a.ID)
	samples, err = env.srv.perfSamples(ctx, a.ID)
	if err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	done := make(chan error, 2)
	raceCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	go func() {
		<-start
		_, e := env.srv.persistToutiaoDataPreferences(raceCtx, a.ID, revision, samples, false)
		done <- e
	}()
	go func() {
		<-start
		_, e := env.srv.db.Exec(raceCtx, `UPDATE work SET topics=ARRAY['竞争新输入'] WHERE id=$1`, samples[0].WorkID)
		done <- e
	}()
	close(start)
	for range 2 {
		if err := <-done; err != nil {
			t.Fatal(err)
		}
	}
	for _, format := range []string{"long_article", "micro_post"} {
		p, err := env.srv.loadDataPreferences(ctx, a.ID, format)
		if err != nil || len(p) != 0 {
			t.Fatalf("CAS race attached old %s result: %v %+v", format, err, p)
		}
	}
}
