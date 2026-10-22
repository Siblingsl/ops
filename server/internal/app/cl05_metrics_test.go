package app

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"

	"ops/internal/wechat"
)

func TestCL05MetricRevisionAuditAndOptimisticWrites(t *testing.T) {
	a := drAccount(t, "wechat_mp", "指标并发审计号")
	publishedAt := time.Date(2026, 10, 1, 12, 0, 0, 0, env.srv.loc)
	wk := drWork(t, a, "指标并发审计作品", "published", &publishedAt)
	path := "/api/v1/works/" + wk.ID.String() + "/metrics"

	var created struct {
		ID       uuid.UUID `json:"id"`
		Revision int       `json:"revision"`
		Merged   bool      `json:"merged"`
		Reads    *int      `json:"reads"`
	}
	env.mustJSON(t, "POST", path, map[string]any{"captured_at": publishedAt.AddDate(0, 0, 1), "reads": 100, "likes": 10}, &created)
	if created.Revision != 1 {
		t.Fatalf("new metric revision = %d, want 1", created.Revision)
	}
	assertMetricAudit(t, created.ID.String(), "metric_create", "manual", nil, map[string]any{"reads": float64(100)})

	var merged struct {
		Merged   bool `json:"merged"`
		Revision int  `json:"revision"`
	}
	env.mustJSON(t, "POST", path, map[string]any{"captured_at": publishedAt.AddDate(0, 0, 1), "reads": 100, "likes": 10}, &merged)
	if !merged.Merged || merged.Revision != 1 {
		t.Fatalf("unchanged DR01 merge should not advance revision: %+v", merged)
	}
	assertMetricAuditCount(t, created.ID.String(), 1)

	var updated struct {
		Revision int  `json:"revision"`
		Reads    *int `json:"reads"`
	}
	env.mustJSON(t, "PATCH", "/api/v1/metrics/"+created.ID.String(), map[string]any{
		"base_revision": 1, "reads": 150, "likes": 10,
	}, &updated)
	if updated.Revision != 2 || updated.Reads == nil || *updated.Reads != 150 {
		t.Fatalf("updated metric should advance to revision 2: %+v", updated)
	}
	assertMetricAudit(t, created.ID.String(), "metric_update", "manual", map[string]any{"reads": float64(100)}, map[string]any{"reads": float64(150)})

	env.expectErr(t, "PATCH", "/api/v1/metrics/"+created.ID.String(), map[string]any{
		"base_revision": 1, "reads": 200, "likes": 10,
	}, "state_invalid")
	assertMetricAuditCount(t, created.ID.String(), 2)

	var unchanged struct {
		Revision int `json:"revision"`
	}
	env.mustJSON(t, "PATCH", "/api/v1/metrics/"+created.ID.String(), map[string]any{
		"base_revision": 2, "reads": 150, "likes": 10,
	}, &unchanged)
	if unchanged.Revision != 2 {
		t.Fatalf("no-op update should keep revision 2, got %d", unchanged.Revision)
	}
	assertMetricAuditCount(t, created.ID.String(), 2)

	env.expectErr(t, "PATCH", "/api/v1/metrics/"+created.ID.String(), map[string]any{
		"reads": 175, "likes": 10,
	}, "validation_failed")
	env.expectErr(t, "DELETE", "/api/v1/metrics/"+created.ID.String(), nil, "validation_failed")
	if n := metricCount(t, wk.ID); n != 1 {
		t.Fatalf("write without base revision changed the metric, count=%d", n)
	}

	env.expectErr(t, "DELETE", "/api/v1/metrics/"+created.ID.String()+"?base_revision=1", nil, "state_invalid")
	if n := metricCount(t, wk.ID); n != 1 {
		t.Fatalf("stale delete removed the metric, count=%d", n)
	}
	env.mustJSON(t, "DELETE", "/api/v1/metrics/"+created.ID.String()+"?base_revision=2", nil, nil)
	assertMetricAudit(t, created.ID.String(), "metric_delete", "manual", map[string]any{"reads": float64(150)}, nil)
}

func TestCL05MetricImportAuditRollsBackWithRows(t *testing.T) {
	a := drAccount(t, "wechat_mp", "指标导入审计号")
	publishedAt := time.Date(2026, 10, 1, 12, 0, 0, 0, env.srv.loc)
	wk := drWork(t, a, "指标导入审计作品", "published", &publishedAt)
	path := "/api/v1/accounts/" + a.ID.String() + "/metrics/import"

	env.expectErr(t, "POST", path, map[string]any{"rows": []map[string]any{
		{"work_id": wk.ID.String(), "reads": 100},
		{"work_id": "not-a-work-id", "reads": 200},
	}}, "validation_failed")
	if metricCount(t, wk.ID) != 0 {
		t.Fatal("invalid import should roll back earlier metric rows")
	}
	var auditCount int
	if err := env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM audit_log
		WHERE target_type='metric_snapshot' AND detail->>'work_id'=$1`, wk.ID.String()).Scan(&auditCount); err != nil {
		t.Fatal(err)
	}
	if auditCount != 0 {
		t.Fatalf("invalid import left %d metric audit rows", auditCount)
	}

	env.mustJSON(t, "POST", path, map[string]any{"rows": []map[string]any{{"work_id": wk.ID.String(), "reads": 100}}}, nil)
	var id string
	if err := env.srv.db.QueryRow(context.Background(), `SELECT id::text FROM metric_snapshot WHERE work_id=$1`, wk.ID).Scan(&id); err != nil {
		t.Fatal(err)
	}
	assertMetricAudit(t, id, "metric_create", "paste", nil, map[string]any{"reads": float64(100)})
}

func TestCL05WechatMetricRowsAreAuditedWithSystemIdentity(t *testing.T) {
	a := drAccount(t, "wechat_mp", "微信指标审计号")
	publishedAt := time.Date(2026, 10, 1, 12, 0, 0, 0, env.srv.loc)
	wk := drWork(t, a, "微信指标审计作品", "published", &publishedAt)
	var workspaceID uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(), `SELECT workspace_id FROM platform_account WHERE id=$1`, a.ID).Scan(&workspaceID); err != nil {
		t.Fatal(err)
	}
	ctx := context.WithValue(context.Background(), ctxMember, &identity{WorkspaceID: workspaceID})
	n, err := env.srv.writeArticleDetails(ctx, wk.ID, "msg-1", publishedAt, []wechat.ArticleTotalDetail{{
		StatDate: publishedAt.Format("2006-01-02"), IntPageReadUser: 321, AddToFavUser: 12, ShareUser: 7,
	}})
	if err != nil || n != 1 {
		t.Fatalf("writeArticleDetails = %d, %v", n, err)
	}
	var id string
	var actorIsNull bool
	var raw []byte
	if err := env.srv.db.QueryRow(context.Background(), `SELECT l.target_id, l.actor_id IS NULL, l.detail
		FROM audit_log l JOIN metric_snapshot m ON m.id::text=l.target_id
		WHERE l.target_type='metric_snapshot' AND l.action='metric_create' AND m.work_id=$1`, wk.ID).
		Scan(&id, &actorIsNull, &raw); err != nil {
		t.Fatalf("missing WeChat metric audit: %v", err)
	}
	if !actorIsNull {
		t.Fatal("scheduled/system metric sync must not invent a human actor")
	}
	var detail map[string]any
	if err := json.Unmarshal(raw, &detail); err != nil {
		t.Fatal(err)
	}
	if detail["source"] != "wechat_api" || detail["work_id"] != wk.ID.String() {
		t.Fatalf("system metric audit lacks source identity: %+v", detail)
	}
}

func TestCL05PublishedDateRecalculationAuditsMetricOffset(t *testing.T) {
	a := drAccount(t, "wechat_mp", "指标节点审计号")
	publishedAt := time.Date(2026, 10, 1, 12, 0, 0, 0, env.srv.loc)
	wk := drWork(t, a, "指标节点审计作品", "published", &publishedAt)
	var created metricResp
	env.mustJSON(t, "POST", "/api/v1/works/"+wk.ID.String()+"/metrics", map[string]any{
		"captured_at": publishedAt.AddDate(0, 0, 1), "reads": 100,
	}, &created)
	if created.DayOffset == nil || *created.DayOffset != 1 || created.Revision != 1 {
		t.Fatalf("initial metric: %+v", created)
	}
	var me struct {
		UserID    uuid.UUID `json:"user_id"`
		Workspace struct {
			ID uuid.UUID `json:"id"`
		} `json:"workspace"`
	}
	env.mustJSON(t, "GET", "/api/v1/auth/me", nil, &me)
	ctx := context.WithValue(context.Background(), ctxMember, &identity{UserID: me.UserID, WorkspaceID: me.Workspace.ID})
	if _, err := env.srv.db.Exec(ctx, `UPDATE work SET published_at=$2 WHERE id=$1`, wk.ID, publishedAt.AddDate(0, 0, 1)); err != nil {
		t.Fatal(err)
	}
	env.srv.recomputeMetricOffsets(ctx, wk.ID)
	updated, err := scanMetric(env.srv.db.QueryRow(ctx, `SELECT `+metricCols+` FROM metric_snapshot WHERE id=$1`, created.ID))
	if err != nil {
		t.Fatal(err)
	}
	if updated.DayOffset == nil || *updated.DayOffset != 0 || updated.Revision != 2 {
		t.Fatalf("recomputed metric: %+v", updated)
	}
	assertMetricAudit(t, created.ID.String(), "metric_offset_recomputed", "manual", map[string]any{"day_offset": float64(1)}, map[string]any{"day_offset": float64(0)})
}

func assertMetricAudit(t *testing.T, metricID, action, source string, before, after map[string]any) {
	t.Helper()
	var raw []byte
	var actorPresent bool
	if err := env.srv.db.QueryRow(context.Background(), `SELECT detail, actor_id IS NOT NULL FROM audit_log
		WHERE target_type='metric_snapshot' AND target_id=$1 AND action=$2 ORDER BY created_at DESC LIMIT 1`, metricID, action).
		Scan(&raw, &actorPresent); err != nil {
		t.Fatalf("missing %s audit for metric %s: %v", action, metricID, err)
	}
	if !actorPresent {
		t.Fatalf("%s audit must retain the acting user", action)
	}
	var detail map[string]any
	if err := json.Unmarshal(raw, &detail); err != nil {
		t.Fatal(err)
	}
	if detail["source"] != source {
		t.Fatalf("audit source = %v, want %s", detail["source"], source)
	}
	if before != nil {
		got, _ := detail["before"].(map[string]any)
		for key, want := range before {
			if got[key] != want {
				t.Fatalf("audit before.%s = %v, want %v", key, got[key], want)
			}
		}
	}
	if after != nil {
		got, _ := detail["after"].(map[string]any)
		for key, want := range after {
			if got[key] != want {
				t.Fatalf("audit after.%s = %v, want %v", key, got[key], want)
			}
		}
	}
}

func assertMetricAuditCount(t *testing.T, metricID string, want int) {
	t.Helper()
	var got int
	if err := env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM audit_log
		WHERE target_type='metric_snapshot' AND target_id=$1`, metricID).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("metric %s audit count = %d, want %d", metricID, got, want)
	}
}
