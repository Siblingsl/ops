package app

import (
	"context"
	"net/http"
	"testing"

	"github.com/google/uuid"
	"ops/internal/ai"
)

// cJoinRole 创建邀请码并以指定角色加入当前工作区；返回的 guestClient 可直接发起
// 该角色的请求。env 的 owner 会话在 setup 结束后立即恢复，避免影响同用例后续断言。
func cJoinRole(t *testing.T, role string) *guestClient {
	t.Helper()
	ws := uuid.MustParse(env.me(t).Workspace.ID)
	var inv struct {
		Code string `json:"code"`
	}
	env.mustJSON(t, http.MethodPost, "/api/v1/workspaces/current/invites", map[string]any{
		"role": role, "max_uses": 1, "days": 1,
	}, &inv)
	username := "ref41-c-" + role + "-" + uuid.NewString()[:8]
	g := env.registerClient(t, username, testPassword)
	g.mustJSON(t, http.MethodPost, "/api/v1/workspaces/join", map[string]any{"code": inv.Code, "switch": true}, nil)
	var userID uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(), `SELECT id FROM app_user WHERE username=$1`, username).Scan(&userID); err != nil {
		t.Fatal(err)
	}
	g.restore(env)
	t.Cleanup(func() {
		g.restore(env)
		_, _ = env.srv.db.Exec(context.Background(), `DELETE FROM workspace_member WHERE user_id=$1 AND workspace_id=$2`, userID, ws)
	})
	return g
}

func TestC_I6ViewerFollowerWritesForbidden(t *testing.T) {
	a := drAccount(t, "xhs", "C 类 I6 viewer 只读号")
	base := "/api/v1/accounts/" + a.ID.String()
	viewer := cJoinRole(t, "viewer")
	var summary followerSummary
	viewer.mustJSON(t, http.MethodGet, base+"/followers/summary?days=30", nil, &summary)
	viewer.expectErr(t, http.MethodPost, base+"/followers", map[string]any{
		"date": env.srv.today().AddDate(0, 0, -1).Format("2006-01-02"), "cumulate": 10,
	}, "forbidden")
	viewer.expectErr(t, http.MethodPost, base+"/followers/backfill", map[string]any{
		"platform": "xhs", "from": env.srv.today().AddDate(0, 0, -2).Format("2006-01-02"),
		"to": env.srv.today().AddDate(0, 0, -2).Format("2006-01-02"),
		"values": []any{map[string]any{"date": env.srv.today().AddDate(0, 0, -2).Format("2006-01-02"), "count": 10}},
	}, "forbidden")
}

func TestC_I7ViewerConversionWritesForbidden(t *testing.T) {
	a := drAccount(t, "wechat_mp", "C 类 I7 viewer 只读号")
	wk := drWork(t, a, "C 类 I7 viewer 作品", "drafting", nil)
	base := "/api/v1/works/" + wk.ID.String() + "/conversion-links"
	var link conversionLink
	env.mustJSON(t, http.MethodPost, base, map[string]any{
		"platform": "wechat_mp", "target_url": "https://example.com/c-viewer",
	}, &link)
	viewer := cJoinRole(t, "viewer")
	var links struct {
		Links []conversionLink `json:"links"`
	}
	viewer.mustJSON(t, http.MethodGet, base, nil, &links)
	viewer.expectErr(t, http.MethodPost, base, map[string]any{
		"platform": "wechat_mp", "target_url": "https://example.com/c-viewer-blocked",
	}, "forbidden")
	viewer.expectErr(t, http.MethodPut, base+"/"+link.ID.String(), map[string]any{
		"target_url": "https://example.com/c-viewer-updated",
	}, "forbidden")
	viewer.expectErr(t, http.MethodPost, "/api/v1/conversion-links/"+link.ID.String()+"/manual-event", map[string]any{
		"event": "paid", "external_id": "c-viewer-manual",
	}, "forbidden")
}

func TestC_I3ViewerClusterWritesForbidden(t *testing.T) {
	a := i3FreshAccount(t)
	i3QuestionComment(t, a, "C 类 viewer 问题一怎么处理？", "读者甲")
	i3QuestionComment(t, a, "C 类 viewer 问题一怎么处理呢", "读者乙")
	i3Rebuild(t, uuid.MustParse(env.me(t).Workspace.ID), a)
	page, _ := i3ListClusters(t, a, "")
	if len(page.Items) != 1 {
		t.Fatalf("cluster count=%d, want 1", len(page.Items))
	}
	viewer := cJoinRole(t, "viewer")
	viewer.mustJSON(t, http.MethodGet, "/api/v1/accounts/"+a.ID.String()+"/comment-clusters", nil, &page)
	viewer.expectErr(t, http.MethodPost, "/api/v1/comment-clusters/"+page.Items[0].ID+"/convert", map[string]any{}, "forbidden")
	viewer.expectErr(t, http.MethodPost, "/api/v1/comment-clusters/"+page.Items[0].ID+"/ignore", map[string]any{}, "forbidden")
}

func TestC_I5ViewerPeerCompareReadable(t *testing.T) {
	a := drAccount(t, "xhs", "C 类 I5 viewer 只读号")
	pub := i5Pub(-7)
	wk := i5Work(t, a, "C 类 I5 viewer 作品", pub)
	i5Metric(t, wk.ID, env.srv.now(), 100, 10, 5, 2, 1, 8)
	viewer := cJoinRole(t, "viewer")
	var card peerCompareCard
	viewer.mustJSON(t, http.MethodGet, "/api/v1/works/"+wk.ID.String()+"/peer-compare?node=7", nil, &card)
	if card.SampleSize != 0 {
		t.Fatalf("viewer peer sample=%d, want 0", card.SampleSize)
	}
	byKey := map[string]peerCompareMetricRow{}
	for _, row := range card.Metrics {
		byKey[row.Key] = row
	}
	if reads := byKey["reads"]; reads.Current == nil || *reads.Current != 100 {
		t.Fatalf("viewer peer reads: %+v", reads)
	}
}

func TestC_A3CapabilityGapCrossWorkspaceNotFound(t *testing.T) {
	ctx, st := aw06ToolRun(t)
	call := ai.ToolCall{ID: "c-a3-gap", Type: "function"}
	call.Function.Name = "report_capability_gap"
	call.Function.Arguments = `{"gap_key":"c-cross-workspace","title":"C 类跨工作区缺口","detail":"只应属于原工作区"}`
	if err := env.srv.agentHandleToolCall(ctx, st, ident(ctx), call, func(string, any) {}); err != nil {
		t.Fatal(err)
	}
	var gapID uuid.UUID
	if err := env.srv.db.QueryRow(ctx, `SELECT id FROM agent_capability_gap WHERE workspace_id=$1 AND gap_key=$2`,
		st.WorkspaceID, "c-cross-workspace").Scan(&gapID); err != nil {
		t.Fatal(err)
	}
	viewer := cJoinRole(t, "viewer")
	viewer.expectErr(t, http.MethodGet, "/api/v1/agent-capability-gaps", nil, "forbidden")
	viewer.expectErr(t, http.MethodPatch, "/api/v1/agent-capability-gaps/"+gapID.String(),
		map[string]any{"status": "planned"}, "forbidden")
	viewer.restore(env)
	initial := env.me(t).Workspace.ID
	var created struct {
		ID uuid.UUID `json:"id"`
	}
	env.mustJSON(t, http.MethodPost, "/api/v1/workspaces", map[string]any{"name": "C 类第二工作区", "switch": false}, &created)
	defer func() {
		_, _ = env.srv.db.Exec(ctx, `UPDATE session SET current_workspace_id=$2 WHERE current_workspace_id=$1`, created.ID, initial)
		_, _ = env.srv.db.Exec(ctx, `DELETE FROM workspace WHERE id=$1`, created.ID)
	}()
	env.mustJSON(t, http.MethodPost, "/api/v1/workspaces/"+created.ID.String()+"/switch", nil, nil)
	env.expectErr(t, http.MethodPatch, "/api/v1/agent-capability-gaps/"+gapID.String(),
		map[string]any{"status": "planned"}, "not_found")
}

func TestC_A8InvalidParamsAndCrossWorkspace(t *testing.T) {
	env.expectErr(t, http.MethodGet, "/api/v1/usage/agent-cost?group_by=bogus", nil, "validation_failed")
	env.expectErr(t, http.MethodGet, "/api/v1/usage/agent-cost?from=not-a-date", nil, "validation_failed")
	env.expectErr(t, http.MethodGet, "/api/v1/usage/agent-cost?from=2026-01-02&to=2026-01-01", nil, "validation_failed")

	provider := env.ensureToolModel(t)
	viewer := cJoinRole(t, "viewer")
	viewer.expectErr(t, http.MethodPatch, "/api/v1/model-providers/"+provider, map[string]any{
		"input_price_micros_per_1k": 1,
	}, "forbidden")
	viewer.mustJSON(t, http.MethodGet, "/api/v1/usage/agent-cost?group_by=day", nil, nil)
	viewer.restore(env)

	ctx, st := aw06ToolRun(t)
	initial := env.me(t).Workspace.ID
	var created struct {
		ID uuid.UUID `json:"id"`
	}
	env.mustJSON(t, http.MethodPost, "/api/v1/workspaces", map[string]any{"name": "A8 跨工作区", "switch": false}, &created)
	defer func() {
		_, _ = env.srv.db.Exec(ctx, `UPDATE session SET current_workspace_id=$2 WHERE current_workspace_id=$1`, created.ID, initial)
		_, _ = env.srv.db.Exec(ctx, `DELETE FROM workspace WHERE id=$1`, created.ID)
	}()
	env.mustJSON(t, http.MethodPost, "/api/v1/workspaces/"+created.ID.String()+"/switch", nil, nil)
	env.expectErr(t, http.MethodGet, "/api/v1/agent-runs/"+st.RunID.String()+"/cost", nil, "not_found")
}
