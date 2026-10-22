package app

import (
	"context"
	"fmt"
	"sort"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestCL06PreferenceBasisTracksMetricChangesAndZeroSamples(t *testing.T) {
	ctx := context.Background()
	a := drAccount(t, "wechat_mp", "偏好依据版本验收号")
	pub := env.srv.now().AddDate(0, 0, -5)
	for i := range 10 {
		title, reads := fmt.Sprintf("含数字%d的标题", i), 2000
		if i >= 5 {
			title, reads = "普通标题", 800
		}
		w := drWork(t, a, title, "published", &pub)
		drMetric(t, w.ID, "manual", 7, reads)
	}
	env.srv.day7PrefsJob(ctx)
	if got := dataPrefs(t, a.ID); len(got) == 0 {
		t.Fatal("current qualified preferences should be available")
	}
	if got := preferenceViews(t, a.ID); len(got) == 0 || !got[0].Applicable || got[0].Applicability != "current" || got[0].BasisSampleCount != 10 {
		t.Fatalf("current preference basis view: %+v", got)
	}
	before := prefInputRevision(t, a.ID)
	var metricID uuid.UUID
	if err := env.srv.db.QueryRow(ctx, `SELECT id FROM metric_snapshot WHERE work_id IN
		(SELECT id FROM work WHERE account_id=$1 AND title='普通标题') ORDER BY id LIMIT 1`, a.ID).Scan(&metricID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(ctx, `UPDATE metric_snapshot SET favorites=7 WHERE id=$1`, metricID); err != nil {
		t.Fatal(err)
	}
	after := prefInputRevision(t, a.ID)
	if after <= before {
		t.Fatalf("interaction-only metric change did not advance input revision: before=%d after=%d", before, after)
	}
	if got := dataPrefs(t, a.ID); len(got) != 0 {
		t.Fatalf("stale preferences leaked before recomputation: %+v", got)
	}
	if got := preferenceViews(t, a.ID); len(got) == 0 || got[0].Applicable || got[0].Applicability != "stale" {
		t.Fatalf("stale preference should remain visible but unavailable: %+v", got)
	}
	env.srv.day7PrefsJob(ctx)
	if got := dataPrefs(t, a.ID); len(got) == 0 {
		t.Fatal("recomputed preferences should be current")
	}
	if processed := prefProcessedRevision(t, a.ID); processed != after {
		t.Fatalf("processed revision = %d, want %d", processed, after)
	}
	if _, err := env.srv.db.Exec(ctx, `UPDATE metric_snapshot SET favorites=favorites WHERE id=$1`, metricID); err != nil {
		t.Fatal(err)
	}
	if got := prefInputRevision(t, a.ID); got != after {
		t.Fatalf("no-op metric update advanced input revision: %d -> %d", after, got)
	}

	if _, err := env.srv.db.Exec(ctx, `DELETE FROM metric_snapshot WHERE work_id IN (SELECT id FROM work WHERE account_id=$1)`, a.ID); err != nil {
		t.Fatal(err)
	}
	zeroRevision := prefInputRevision(t, a.ID)
	if zeroRevision <= after {
		t.Fatalf("deleting the final samples did not advance input revision: %d -> %d", after, zeroRevision)
	}
	env.srv.day7PrefsJob(ctx)
	var kept int
	if err := env.srv.db.QueryRow(ctx, `SELECT count(*) FROM account_data_preference WHERE account_id=$1`, a.ID).Scan(&kept); err != nil {
		t.Fatal(err)
	}
	if kept == 0 {
		t.Fatal("insufficient samples must preserve the historical preference row")
	}
	if got := dataPrefs(t, a.ID); len(got) != 0 {
		t.Fatalf("inapplicable preferences leaked after samples were deleted: %+v", got)
	}
	if got := preferenceViews(t, a.ID); len(got) == 0 || got[0].Applicable || got[0].Applicability != "insufficient_samples" {
		t.Fatalf("insufficient-sample preference should be visible but paused: %+v", got)
	}
	if processed := prefProcessedRevision(t, a.ID); processed != zeroRevision {
		t.Fatalf("zero-sample input was not marked processed: %d != %d", processed, zeroRevision)
	}
}

func TestCL06PreferenceRevisionCoversSampleFeaturesAndWindowInputs(t *testing.T) {
	ctx := context.Background()
	a := drAccount(t, "wechat_mp", "偏好样本字段验收号")
	pub := env.srv.now().AddDate(0, 0, -5)
	w := drWork(t, a, "样本标题", "published", &pub)
	drMetric(t, w.ID, "manual", 7, 1000)
	read := func() int64 { return prefInputRevision(t, a.ID) }
	assertBump := func(name string, mutate func() error) {
		t.Helper()
		before := read()
		if err := mutate(); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if after := read(); after <= before {
			t.Fatalf("%s did not advance preference input revision: %d -> %d", name, before, after)
		}
	}
	assertNoBump := func(name string, mutate func() error) {
		t.Helper()
		before := read()
		if err := mutate(); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if after := read(); after != before {
			t.Fatalf("%s advanced preference input revision despite no sample change: %d -> %d", name, before, after)
		}
	}
	assertBump("title", func() error {
		_, err := env.srv.db.Exec(ctx, `UPDATE work SET title=title||'更新' WHERE id=$1`, w.ID)
		return err
	})
	assertBump("topics", func() error {
		_, err := env.srv.db.Exec(ctx, `UPDATE work SET topics=ARRAY['新话题'] WHERE id=$1`, w.ID)
		return err
	})
	assertBump("published_at", func() error {
		_, err := env.srv.db.Exec(ctx, `UPDATE work SET published_at=published_at-interval '1 day' WHERE id=$1`, w.ID)
		return err
	})
	assertBump("section character length", func() error {
		_, err := env.srv.db.Exec(ctx, `INSERT INTO work_section(work_id,position,heading,content_md) VALUES($1,0,'正文','增加长度')`, w.ID)
		return err
	})
	assertNoBump("same-length section edit", func() error {
		_, err := env.srv.db.Exec(ctx, `UPDATE work_section SET content_md='调整长度' WHERE work_id=$1`, w.ID)
		return err
	})
	assertNoBump("empty section addition", func() error {
		_, err := env.srv.db.Exec(ctx, `INSERT INTO work_section(work_id,position,heading,content_md) VALUES($1,1,'空段','')`, w.ID)
		return err
	})
	assertBump("section soft deletion", func() error {
		_, err := env.srv.db.Exec(ctx, `UPDATE work_section SET deleted_at=now() WHERE work_id=$1`, w.ID)
		return err
	})
	assertBump("work soft deletion", func() error {
		_, err := env.srv.db.Exec(ctx, `UPDATE work SET deleted_at=now() WHERE id=$1`, w.ID)
		return err
	})
	assertBump("work restore", func() error {
		_, err := env.srv.db.Exec(ctx, `UPDATE work SET deleted_at=NULL WHERE id=$1`, w.ID)
		return err
	})
	assertBump("sample window candidate", func() error {
		newWork := drWork(t, a, "新窗口作品", "published", &pub)
		drMetric(t, newWork.ID, "manual", 7, 1500)
		return nil
	})

	before := read()
	if _, err := env.srv.db.Exec(ctx, `UPDATE work SET status=status WHERE id=$1`, w.ID); err != nil {
		t.Fatal(err)
	}
	if after := read(); after != before {
		t.Fatalf("irrelevant no-op update advanced preference input revision: %d -> %d", before, after)
	}
	assertNoBump("non-sample metric field", func() error {
		_, err := env.srv.db.Exec(ctx, `UPDATE metric_snapshot SET follows_gained=3,note='仅备注' WHERE work_id=$1`, w.ID)
		return err
	})
}

func TestCL06StalePreferenceCalculationCannotCommit(t *testing.T) {
	ctx := context.Background()
	a := drAccount(t, "wechat_mp", "偏好重算竞争验收号")
	pub := env.srv.now().AddDate(0, 0, -5)
	for i := range 10 {
		title, reads := fmt.Sprintf("样本%d标题", i), 1800
		if i >= 5 {
			title, reads = "普通样本标题", 700
		}
		w := drWork(t, a, title, "published", &pub)
		drMetric(t, w.ID, "manual", 7, reads)
	}
	oldRevision := prefInputRevision(t, a.ID)
	samples, err := env.srv.perfSamples(ctx, a.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(samples) < minAttributionSamples {
		t.Fatalf("test setup has only %d samples", len(samples))
	}
	if _, err := env.srv.db.Exec(ctx, `UPDATE work SET topics=ARRAY['并发变化'] WHERE account_id=$1 AND title='普通样本标题'`, a.ID); err != nil {
		t.Fatal(err)
	}
	prefs := deriveDataPreferences(attributionStats(samples, env.srv.loc))
	applied, err := env.srv.persistDataPreferences(ctx, a.ID, oldRevision, samples, prefs, true, false)
	if err != nil {
		t.Fatal(err)
	}
	if applied {
		t.Fatal("a calculation from an obsolete input revision committed")
	}
	if got := dataPrefs(t, a.ID); len(got) != 0 {
		t.Fatalf("obsolete calculation became injectable: %+v", got)
	}
}

func TestCL06RecentFiveHundredSampleBoundaryIsStableAndInvalidated(t *testing.T) {
	ctx := context.Background()
	a := drAccount(t, "wechat_mp", "偏好样本窗口验收号")
	base := env.srv.now().AddDate(0, 0, -20)
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO work(account_id,title,content_format,status,published_at)
		SELECT $1,CASE WHEN i%2=0 THEN '窗口样本2026-'||lpad(i::text,3,'0') ELSE '窗口样本普通' END,
			'long_article','published',$2::timestamptz+i*interval '1 second'
		FROM generate_series(1,501) i`, a.ID, base); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO metric_snapshot(work_id,captured_at,source,day_offset,reads,likes)
		SELECT id,published_at+interval '7 days','manual',7,
			CASE WHEN title LIKE '窗口样本2026-%' THEN 2000 ELSE 500 END,1
		FROM work WHERE account_id=$1 AND title LIKE '窗口样本%'`, a.ID); err != nil {
		t.Fatal(err)
	}
	firstRevision := prefInputRevision(t, a.ID)
	initial, err := env.srv.perfSamples(ctx, a.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(initial) != 500 {
		t.Fatalf("perfSamples returned %d candidates, want 500", len(initial))
	}
	oldBoundary := initial[len(initial)-1].WorkID
	var newest uuid.UUID
	if err := env.srv.db.QueryRow(ctx, `INSERT INTO work(account_id,title,content_format,status,published_at)
		VALUES($1,'窗口样本2026最新候选','long_article','published',$2) RETURNING id`, a.ID, base.Add(1000*time.Second)).Scan(&newest); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO metric_snapshot(work_id,captured_at,source,day_offset,reads,likes)
		VALUES($1,$2,'manual',7,2000,1)`, newest, base.Add(1000*time.Second+7*24*time.Hour)); err != nil {
		t.Fatal(err)
	}
	if revision := prefInputRevision(t, a.ID); revision <= firstRevision {
		t.Fatalf("new sample entering the 500-item candidate window did not advance revision: %d -> %d", firstRevision, revision)
	}
	updated, err := env.srv.perfSamples(ctx, a.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(updated) != 500 || updated[0].WorkID != newest {
		t.Fatalf("new candidate did not occupy the first sample slot: len=%d first=%s", len(updated), updated[0].WorkID)
	}
	for _, sample := range updated {
		if sample.WorkID == oldBoundary {
			t.Fatal("the prior 500th sample remained after a newer candidate entered")
		}
	}

	currentRevision := prefInputRevision(t, a.ID)
	prefs := deriveDataPreferences(attributionStats(updated, env.srv.loc))
	if len(prefs) == 0 {
		t.Fatal("the 500-sample fixture should produce at least one qualified preference")
	}
	if applied, err := env.srv.persistDataPreferences(ctx, a.ID, currentRevision, updated, prefs, true, false); err != nil || !applied {
		t.Fatalf("persist 500-sample preference fixture: applied=%v err=%v", applied, err)
	}
	if views := preferenceViews(t, a.ID); len(views) == 0 || !views[0].Applicable || views[0].Applicability != "current" {
		t.Fatalf("500-sample preference fixture is not current: %+v", views)
	}

	measure := func(name string, run func() error) (time.Duration, time.Duration) {
		t.Helper()
		const repetitions = 20
		durations := make([]time.Duration, 0, repetitions)
		for range repetitions {
			start := time.Now()
			if err := run(); err != nil {
				t.Fatalf("%s: %v", name, err)
			}
			durations = append(durations, time.Since(start))
		}
		sort.Slice(durations, func(i, j int) bool { return durations[i] < durations[j] })
		return durations[len(durations)/2], durations[len(durations)-1]
	}
	perfMedian, perfMax := measure("500-sample perfSamples", func() error {
		samples, err := env.srv.perfSamples(ctx, a.ID)
		if err == nil && len(samples) != 500 {
			return fmt.Errorf("got %d samples", len(samples))
		}
		return err
	})
	viewMedian, viewMax := measure("500-sample preference view", func() error {
		views := preferenceViews(t, a.ID)
		if len(views) == 0 || !views[0].Applicable || views[0].Applicability != "current" {
			return fmt.Errorf("current preference missing: %+v", views)
		}
		return nil
	})

	// Compete a 500-sample CAS commit with an input write. Either lock order is valid,
	// but the newer input must make every old-basis preference unavailable.
	raceRevision := prefInputRevision(t, a.ID)
	raceSamples, err := env.srv.perfSamples(ctx, a.ID)
	if err != nil {
		t.Fatal(err)
	}
	racePrefs := deriveDataPreferences(attributionStats(raceSamples, env.srv.loc))
	startRace := make(chan struct{})
	type raceResult struct {
		name    string
		elapsed time.Duration
		applied bool
		err     error
	}
	results := make(chan raceResult, 2)
	raceCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	go func() {
		<-startRace
		start := time.Now()
		applied, err := env.srv.persistDataPreferences(raceCtx, a.ID, raceRevision, raceSamples, racePrefs, true, false)
		results <- raceResult{name: "preference commit", elapsed: time.Since(start), applied: applied, err: err}
	}()
	go func() {
		<-startRace
		start := time.Now()
		_, err := env.srv.db.Exec(raceCtx, `UPDATE work SET topics=ARRAY['并发验证'] WHERE id=$1`, newest)
		results <- raceResult{name: "input update", elapsed: time.Since(start), err: err}
	}()
	close(startRace)
	first, second := <-results, <-results
	var commitResult, updateResult raceResult
	for _, result := range []raceResult{first, second} {
		if result.err != nil {
			t.Fatalf("%s: %v", result.name, result.err)
		}
		if result.name == "preference commit" {
			commitResult = result
		} else {
			updateResult = result
		}
	}
	if got := dataPrefs(t, a.ID); len(got) != 0 {
		t.Fatalf("concurrent input update left stale preferences injectable: %+v", got)
	}
	for _, view := range preferenceViews(t, a.ID) {
		if view.Applicable || view.Applicability != "stale" {
			t.Fatalf("concurrent update did not mark the old preference basis stale: %+v", view)
		}
	}
	t.Logf("500 samples: perfSamples median=%s max=%s; GET preferences median=%s max=%s; competing CAS=%s applied=%v, input update=%s; stale basis not injected",
		perfMedian, perfMax, viewMedian, viewMax, commitResult.elapsed, commitResult.applied, updateResult.elapsed)
}

func TestCL06LegacyAndSupersededPreferencesAreNotInjected(t *testing.T) {
	ctx := context.Background()
	a := drAccount(t, "wechat_mp", "旧偏好适用性验收号")
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO account_data_preference (account_id,feature,conclusion,sample_size)
		VALUES ($1,'title_digit','旧结论',12)`, a.ID); err != nil {
		t.Fatal(err)
	}
	if got := dataPrefs(t, a.ID); len(got) != 0 {
		t.Fatalf("legacy preference without basis metadata was injected: %+v", got)
	}
	if got := preferenceViews(t, a.ID); len(got) != 1 || got[0].Applicable || got[0].Applicability != "unverified" {
		t.Fatalf("legacy preference should be visible as unverified: %+v", got)
	}
	if _, err := env.srv.db.Exec(ctx, `UPDATE platform_account SET pref_processed_revision=pref_input_revision WHERE id=$1`, a.ID); err != nil {
		t.Fatal(err)
	}
	if got := dataPrefs(t, a.ID); len(got) != 0 {
		t.Fatalf("legacy metadata became current solely because processed revision matched: %+v", got)
	}
}

func preferenceViews(t *testing.T, accountID uuid.UUID) []DataPreferenceView {
	t.Helper()
	var out []DataPreferenceView
	env.mustJSON(t, "GET", "/api/v1/accounts/"+accountID.String()+"/data-preferences", nil, &out)
	return out
}

func prefInputRevision(t *testing.T, accountID uuid.UUID) int64 {
	t.Helper()
	var revision int64
	if err := env.srv.db.QueryRow(context.Background(), `SELECT pref_input_revision FROM platform_account WHERE id=$1`, accountID).Scan(&revision); err != nil {
		t.Fatal(err)
	}
	return revision
}

func prefProcessedRevision(t *testing.T, accountID uuid.UUID) int64 {
	t.Helper()
	var revision *int64
	if err := env.srv.db.QueryRow(context.Background(), `SELECT pref_processed_revision FROM platform_account WHERE id=$1`, accountID).Scan(&revision); err != nil {
		t.Fatal(err)
	}
	if revision == nil {
		t.Fatal("preference revision has not been processed")
	}
	return *revision
}

func dataPrefs(t *testing.T, accountID uuid.UUID) []DataPreference {
	t.Helper()
	prefs, err := env.srv.loadDataPreferences(context.Background(), accountID)
	if err != nil {
		t.Fatal(err)
	}
	return prefs
}
