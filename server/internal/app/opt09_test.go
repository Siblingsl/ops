package app

import (
	"context"
	"encoding/json"
	"io"
	"net/http/httptest"
	"sort"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type opt09Queries struct{ count atomic.Int64 }

func (q *opt09Queries) TraceQueryStart(ctx context.Context, _ *pgx.Conn, _ pgx.TraceQueryStartData) context.Context {
	q.count.Add(1)
	return ctx
}
func (*opt09Queries) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

func TestOPT09DashboardQueriesLatencyAndScope(t *testing.T) {
	a, path := opt02Account(t)
	b, _ := v4Account(t, "同工作区另一账号")
	ctx := v4Context(t, a)
	ws := ident(ctx).WorkspaceID
	other := opt12Workspace(t)
	before := env.srv.tokensToday(ctx)
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := env.srv.db.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO work(account_id,content_format,title) SELECT $1,$2,'OPT09-'||i FROM generate_series(1,1000) i`, a.ID, a.ContentFormat)
	exec(`INSERT INTO work(account_id,content_format,title,status,deleted_at) VALUES($1,$2,'已删','ready',now()),($3,$2,'另一账号','ready',NULL)`, a.ID, a.ContentFormat, b.ID)
	exec(`INSERT INTO topic(account_id,title) SELECT $1,'OPT09-'||i FROM generate_series(1,3) i`, a.ID)
	exec(`INSERT INTO topic(account_id,title,deleted_at) VALUES($1,'已删',now()),($2,'另一账号',NULL)`, a.ID, b.ID)
	exec(`INSERT INTO ai_call(workspace_id,account_id,task_type,prompt_tokens,completion_tokens) VALUES($1,$2,'opt09',100,25),($1,$3,'opt09',200,50),($4,NULL,'opt09',90000,10000)`, ws, a.ID, b.ID, other)
	exec(`INSERT INTO style_sample(account_id,title,content_md) VALUES($1,'样本','本地验收')`, a.ID)
	exec(`UPDATE account_profile SET target_audience='本地验收读者' WHERE account_id=$1`, a.ID)
	exec(`INSERT INTO push_record(work_id,account_id,action,status,created_at) SELECT id,$1,'add','ok',$2 FROM work WHERE account_id=$1 AND deleted_at IS NULL LIMIT 1`, a.ID, env.srv.today())
	exec(`INSERT INTO app_setting(workspace_id,key,value) VALUES($1,'ai_limit','{"enabled":true,"daily_tokens":123456}') ON CONFLICT(workspace_id,key) DO UPDATE SET value=excluded.value`, ws)
	queries := &opt09Queries{}
	cfg := env.srv.db.Config()
	cfg.ConnConfig.Tracer = queries
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	srv, err := New(env.srv.cfg, pool)
	if err != nil {
		t.Fatal(err)
	}
	srv.now = env.srv.now
	server := httptest.NewServer(srv.Router())
	defer server.Close()
	request := func(route string) ([]byte, int64, time.Duration) {
		t.Helper()
		queries.count.Store(0)
		started := time.Now()
		resp, err := env.client.Get(server.URL + route)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		body, err := io.ReadAll(resp.Body)
		if err != nil || resp.StatusCode != 200 {
			t.Fatalf("GET %s: %d %s %v", route, resp.StatusCode, body, err)
		}
		return body, queries.count.Load(), time.Since(started)
	}
	var dash struct {
		Counts        map[string]int  `json:"counts"`
		Todos         []any           `json:"todos"`
		PendingTopics int             `json:"pending_topics"`
		TodayPush     int             `json:"today_push"`
		Tokens        int             `json:"tokens_today"`
		Limit         aiLimit         `json:"ai_limit"`
		Setup         map[string]bool `json:"setup"`
	}
	body, _, _ := request(path + "/dashboard")
	if err := json.Unmarshal(body, &dash); err != nil {
		t.Fatal(err)
	}
	if dash.Counts["drafting"] != 1000 || dash.Counts["ready"] != 0 || len(dash.Todos) != 30 || dash.PendingTopics != 3 || dash.TodayPush != 1 || dash.Tokens != before+375 || !dash.Setup["ai"] || !dash.Setup["profile"] || !dash.Setup["samples"] || !dash.Limit.Enabled || dash.Limit.DailyTokens != 123456 {
		t.Fatalf("dashboard aggregates/scope: %+v", dash)
	}
	body, count, _ := request("/api/v1/ai/status")
	var status struct {
		Tokens int  `json:"tokens_today"`
		Ready  bool `json:"ready"`
	}
	if err := json.Unmarshal(body, &status); err != nil || status.Tokens != dash.Tokens || !status.Ready || count > 3 {
		t.Fatalf("lightweight workspace usage: %s queries=%d %v", body, count, err)
	}
	for i := 0; i < 5; i++ {
		request(path + "/dashboard")
	}
	var durations []time.Duration
	var peak int64
	for i := 0; i < 200; i++ {
		_, count, duration := request(path + "/dashboard")
		if count > peak {
			peak = count
		}
		durations = append(durations, duration)
	}
	sort.Slice(durations, func(i, j int) bool { return durations[i] < durations[j] })
	p95 := durations[189]
	if peak > 5 || p95 >= 150*time.Millisecond {
		t.Fatalf("queries=%d p95=%s", peak, p95)
	}
	t.Logf("1000 works, 5 warmups, 200 sequential full HTTP requests including session authentication: max SQL=%d, p95=%s; ai/status SQL=%d", peak, p95, count)
}

func TestOPT09PreparationOnlyOnOpsOpen(t *testing.T) {
	guest := env.registerClient(t, "opt09-"+uuid.NewString()[:8], testPassword)
	t.Cleanup(func() { guest.restore(env) })
	a, path := v4Account(t, "运营页准备入口")
	options, _ := positioningOptions(t, path)
	f := options[0].StrategyFields
	f.DailySettings = map[string]any{"generate": "on_open"}
	off := false
	f.HotEnabled = &off
	env.mustJSON(t, "POST", path+"/strategy", f, nil)
	env.mustJSON(t, "GET", path+"/dashboard", nil, nil)
	var preview struct {
		JobID          *uuid.UUID `json:"job_id"`
		Recommendation *Daily     `json:"recommendation"`
		Preparing      bool       `json:"preparing"`
	}
	env.mustJSON(t, "GET", path+"/daily?prepare=false", nil, &preview)
	var jobs, activities int
	err := env.srv.db.QueryRow(context.Background(), `SELECT
		(SELECT count(*) FROM ai_job WHERE account_id=$1 AND task_type='ops_daily'),
		(SELECT count(*) FROM account_ops_activity WHERE account_id=$1)`, a.ID).Scan(&jobs, &activities)
	if err != nil || jobs != 0 || activities != 0 || preview.JobID != nil || preview.Preparing || preview.Recommendation != nil {
		t.Fatalf("dashboard/preview started preparation: %+v jobs=%d activities=%d err=%v", preview, jobs, activities, err)
	}
	var opened struct {
		JobID *uuid.UUID `json:"job_id"`
	}
	env.mustJSON(t, "GET", path+"/daily", nil, &opened)
	if opened.JobID == nil {
		t.Fatal("ops open did not prepare")
	}
	for i := 0; i < 100; i++ {
		var status string
		if err := env.srv.db.QueryRow(context.Background(), `SELECT status FROM ai_job WHERE id=$1`, opened.JobID).Scan(&status); err != nil {
			t.Fatal(err)
		}
		if status == "done" {
			break
		}
		if status == "failed" {
			t.Fatal("mock preparation failed")
		}
		time.Sleep(20 * time.Millisecond)
	}
	env.mustJSON(t, "GET", path+"/daily?prepare=false", nil, &preview)
	if preview.Recommendation == nil {
		t.Fatal("preview cannot read existing recommendation")
	}
}
