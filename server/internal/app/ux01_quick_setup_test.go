package app

import (
	"context"
	"slices"
	"testing"

	"github.com/google/uuid"
)

type aiStatusResp struct {
	Ready       bool `json:"ready"`
	VisionRoute bool `json:"vision_route"`
	ImageRoute  bool `json:"image_route"`
}

func (e *testEnv) wsID(t *testing.T) uuid.UUID {
	t.Helper()
	var list []Provider
	e.mustJSON(t, "GET", "/api/v1/model-providers", nil, &list)
	if len(list) == 0 {
		t.Fatal("test env has no provider")
	}
	var ws uuid.UUID
	if err := e.srv.db.QueryRow(context.Background(), `SELECT workspace_id FROM model_provider WHERE id=$1`, list[0].ID).Scan(&ws); err != nil {
		t.Fatal(err)
	}
	return ws
}

// DEV-UX01（D-052 第 1 条）：添加供应商时一并指定主力/经济档/质量档/图片识别模型，只写空着的路由；
// /ai/status 让界面在调用前知道有没有图片识别路由。
func TestUX01QuickSetup(t *testing.T) {
	ctx := context.Background()
	var defaultBefore uuid.UUID
	if err := env.srv.db.QueryRow(ctx, `SELECT provider_id FROM model_route WHERE workspace_id=$1 AND task_type='default'`, env.wsID(t)).Scan(&defaultBefore); err != nil {
		t.Fatalf("test env needs a default route: %v", err)
	}
	_, _ = env.srv.db.Exec(ctx, `DELETE FROM model_route WHERE workspace_id=$1 AND task_type IN ('tier_economy','tier_quality','metric_screenshot')`, env.wsID(t))

	var st aiStatusResp
	env.mustJSON(t, "GET", "/api/v1/ai/status", nil, &st)
	if !st.Ready || st.VisionRoute {
		t.Fatalf("before quick setup: %+v", st)
	}

	env.reauth(t)
	base := map[string]any{"name": "快速配置供应商", "base_url": env.mock.URL + "/v1", "api_key": "test-key", "models": []string{"m-main", "m-eco", "m-vl"}}
	bad := func(assign map[string]string) map[string]any {
		in := map[string]any{}
		for k, v := range base {
			in[k] = v
		}
		in["assign"] = assign
		return in
	}
	env.expectErr(t, "POST", "/api/v1/model-providers", bad(map[string]string{"default": "not-listed"}), "validation_failed")
	env.expectErr(t, "POST", "/api/v1/model-providers", bad(map[string]string{"section_draft": "m-main"}), "validation_failed")

	var created struct {
		Provider
		Assigned []string `json:"assigned"`
		Kept     []string `json:"kept"`
	}
	env.mustJSON(t, "POST", "/api/v1/model-providers", bad(map[string]string{"default": "m-main", "tier_economy": "m-eco", "metric_screenshot": "m-vl", "tier_quality": ""}), &created)
	defer func() {
		_, _ = env.srv.db.Exec(ctx, `DELETE FROM model_route WHERE provider_id=$1`, created.ID)
		_, _ = env.srv.db.Exec(ctx, `DELETE FROM model_provider WHERE id=$1`, created.ID)
	}()
	if created.ID == uuid.Nil || created.Name != "快速配置供应商" {
		t.Fatalf("provider fields must stay flat in the response: %+v", created)
	}
	slices.Sort(created.Assigned)
	if !slices.Equal(created.Assigned, []string{"metric_screenshot", "tier_economy"}) {
		t.Fatalf("only empty routes are written: assigned=%v", created.Assigned)
	}
	if !slices.Equal(created.Kept, []string{"default"}) {
		t.Fatalf("existing default route is kept: kept=%v", created.Kept)
	}
	var defaultAfter uuid.UUID
	_ = env.srv.db.QueryRow(ctx, `SELECT provider_id FROM model_route WHERE workspace_id=$1 AND task_type='default'`, env.wsID(t)).Scan(&defaultAfter)
	if defaultAfter != defaultBefore {
		t.Fatal("quick setup must not overwrite the existing default route")
	}
	var model string
	_ = env.srv.db.QueryRow(ctx, `SELECT model FROM model_route WHERE workspace_id=$1 AND task_type='metric_screenshot'`, env.wsID(t)).Scan(&model)
	if model != "m-vl" {
		t.Fatalf("screenshot route model: %q", model)
	}
	var quality int
	_ = env.srv.db.QueryRow(ctx, `SELECT count(*) FROM model_route WHERE workspace_id=$1 AND task_type='tier_quality'`, env.wsID(t)).Scan(&quality)
	if quality != 0 {
		t.Fatal("an empty role must not create a route")
	}

	env.mustJSON(t, "GET", "/api/v1/ai/status", nil, &st)
	if !st.Ready || !st.VisionRoute {
		t.Fatalf("after quick setup: %+v", st)
	}
	env.expectErr(t, "PATCH", "/api/v1/model-providers/"+created.ID.String(), map[string]any{"assign": map[string]string{"default": "m-main"}}, "validation_failed")
}
