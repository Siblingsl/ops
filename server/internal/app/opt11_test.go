package app

import (
	"bytes"
	"context"
	"log/slog"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

func TestOPT11RetentionPoliciesAndProtectedWorkVersions(t *testing.T) {
	f := env.accounts(t)
	ctx := context.Background()
	marker := "opt11-retention:" + env.srv.today().Format("2006-01-02")
	var previousMarker time.Time
	err := env.srv.db.QueryRow(ctx, `DELETE FROM job_marker WHERE key=$1 RETURNING created_at`, marker).Scan(&previousMarker)
	hadMarker := err == nil
	if err != nil && err != pgx.ErrNoRows {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(ctx, `DELETE FROM job_marker WHERE key=$1`, marker)
		if hadMarker {
			_, _ = env.srv.db.Exec(ctx, `INSERT INTO job_marker(key,created_at) VALUES($1,$2)`, marker, previousMarker)
		}
	})
	var work Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+f.wechat.ID.String()+"/works", map[string]string{"title": "OPT11 保留期验收"}, &work)
	if _, err := env.srv.db.Exec(ctx, `UPDATE work SET status='pushed' WHERE id=$1`, work.ID); err != nil {
		t.Fatal(err)
	}

	if _, err := env.srv.db.Exec(ctx, `INSERT INTO ai_call (account_id,workspace_id,task_type,provider,model,prompt_tokens,completion_tokens,latency_ms,status,created_at)
		SELECT $1,workspace_id,'opt11_retention','mock','mock-model',2,3,10,'ok',now()-interval '400 days'
		FROM platform_account CROSS JOIN generate_series(1,5001) WHERE id=$1`, f.wechat.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO ai_call (account_id,workspace_id,task_type,provider,model,prompt_tokens,completion_tokens,latency_ms,status,created_at)
		SELECT $1,workspace_id,'opt11_retention','mock','mock-model',2,3,10,'ok',now()-interval '170 days'
		FROM platform_account WHERE id=$1`, f.wechat.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO audit_log (action,target_type,target_id,created_at)
		SELECT 'opt11','work','opt11-expired',now()-interval '400 days' FROM generate_series(1,5001)`); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO audit_log (action,target_type,target_id,created_at) VALUES ('opt11','work','opt11-recent',now()-interval '300 days')`); err != nil {
		t.Fatal(err)
	}
	var oldRun, recentRun string
	if err := env.srv.db.QueryRow(ctx, `INSERT INTO check_run (work_id,revision,target_platform,created_at) VALUES ($1,1,'wechat_mp',now()-interval '400 days') RETURNING id`, work.ID).Scan(&oldRun); err != nil {
		t.Fatal(err)
	}
	if err := env.srv.db.QueryRow(ctx, `INSERT INTO check_run (work_id,revision,target_platform,created_at) VALUES ($1,1,'wechat_mp',now()-interval '300 days') RETURNING id`, work.ID).Scan(&recentRun); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO check_item (check_run_id,category,fingerprint,message)
		SELECT $1,'ai_disclosure','opt11-expired-'||n,'AI 声明' FROM generate_series(1,5001) n`, oldRun); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO check_item (check_run_id,category,fingerprint,message) VALUES ($1,'format','opt11-format','格式检查'),($2,'ai_disclosure','opt11-recent','AI 声明')`, oldRun, recentRun); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO work_version (work_id,version_no,snapshot,reason,created_at)
		SELECT $1,n,'{}'::jsonb,CASE WHEN n=1 THEN 'check' WHEN n=2 THEN 'publish' ELSE 'manual' END,now()-interval '400 days'
		FROM generate_series(1,62) n`, work.ID); err != nil {
		t.Fatal(err)
	}
	env.mustJSON(t, "POST", "/api/v1/works/"+work.ID.String()+"/published", map[string]any{}, nil)

	var logs bytes.Buffer
	previousLogger := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	env.srv.runJobsOnce(ctx)
	slog.SetDefault(previousLogger)
	t.Log(logs.String())

	var count int
	if err := env.srv.db.QueryRow(ctx, `SELECT count(*) FROM ai_call WHERE account_id=$1 AND task_type='opt11_retention' AND created_at < now()-interval '180 days'`, f.wechat.ID).Scan(&count); err != nil || count != 0 {
		t.Errorf("expired AI call details remain: count=%d err=%v", count, err)
	}
	if err := env.srv.db.QueryRow(ctx, `SELECT count(*) FROM ai_call WHERE account_id=$1 AND task_type='opt11_retention'`, f.wechat.ID).Scan(&count); err != nil || count != 1 {
		t.Errorf("recent AI call should remain: count=%d err=%v", count, err)
	}
	var calls, successes, failures, promptTokens, completionTokens int
	if err := env.srv.db.QueryRow(ctx, `SELECT call_count,success_count,failed_count,prompt_tokens,completion_tokens
		FROM ai_call_monthly_summary WHERE account_id=$1 AND task_type='opt11_retention'`, f.wechat.ID).
		Scan(&calls, &successes, &failures, &promptTokens, &completionTokens); err != nil || calls != 5001 || successes != 5001 || failures != 0 || promptTokens != 10002 || completionTokens != 15003 {
		t.Errorf("monthly summary mismatch: calls=%d success=%d failed=%d prompt=%d completion=%d err=%v", calls, successes, failures, promptTokens, completionTokens, err)
	}
	if err := env.srv.db.QueryRow(ctx, `SELECT count(*) FROM audit_log WHERE target_id='opt11-expired'`).Scan(&count); err != nil || count != 0 {
		t.Errorf("expired audit rows remain: count=%d err=%v", count, err)
	}
	if err := env.srv.db.QueryRow(ctx, `SELECT count(*) FROM audit_log WHERE target_id='opt11-recent'`).Scan(&count); err != nil || count != 1 {
		t.Errorf("recent audit row should remain: count=%d err=%v", count, err)
	}
	if err := env.srv.db.QueryRow(ctx, `SELECT count(*) FROM check_item WHERE fingerprint LIKE 'opt11-expired-%'`).Scan(&count); err != nil || count != 0 {
		t.Errorf("expired AI disclosure rows remain: count=%d err=%v", count, err)
	}
	if err := env.srv.db.QueryRow(ctx, `SELECT count(*) FROM check_item WHERE fingerprint IN ('opt11-format','opt11-recent')`).Scan(&count); err != nil || count != 2 {
		t.Errorf("non-disclosure or recent check items should remain: count=%d err=%v", count, err)
	}
	if err := env.srv.db.QueryRow(ctx, `SELECT count(*) FROM work_version WHERE work_id=$1`, work.ID).Scan(&count); err != nil || count != 52 {
		t.Errorf("expected 50 latest plus two protected milestones, got count=%d err=%v", count, err)
	}
	if err := env.srv.db.QueryRow(ctx, `SELECT count(*) FROM work_version WHERE work_id=$1 AND reason='publish'`, work.ID).Scan(&count); err != nil || count != 2 {
		t.Errorf("published milestones should be retained, got count=%d err=%v", count, err)
	}

	maxBatch, maxMillis := 0, 0
	for _, line := range strings.Split(logs.String(), "\n") {
		if !strings.Contains(line, "msg=保留期清理批次") {
			continue
		}
		batchMatch := regexp.MustCompile(`count=(\d+)`).FindStringSubmatch(line)
		timeMatch := regexp.MustCompile(`duration_ms=(\d+)`).FindStringSubmatch(line)
		if len(batchMatch) != 2 || len(timeMatch) != 2 {
			t.Errorf("retention batch log missing count or duration: %s", line)
			continue
		}
		batch, _ := strconv.Atoi(batchMatch[1])
		millis, _ := strconv.Atoi(timeMatch[1])
		maxBatch, maxMillis = max(maxBatch, batch), max(maxMillis, millis)
	}
	if maxBatch == 0 || maxBatch > 5000 || maxMillis >= 1000 {
		t.Errorf("retention batch bounds not met: max_batch=%d max_duration_ms=%d", maxBatch, maxMillis)
	}
}
