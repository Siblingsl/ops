package app

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

// DEV-UX02（D-052 第 2 条）：工作台主线补齐配置模型、按节点录入数据、回填已发布、待匹配文章、复盘草稿建议。
func TestUX02MainLineRules(t *testing.T) {
	now := time.Date(2026, 10, 10, 10, 0, 0, 0, time.Local)
	pushed, published := uuid.New(), uuid.New()
	node7 := 7
	in := naInput{Now: now, AccountID: uuid.New(), Platform: "wechat_mp", AIMissing: true, IsOwner: true, Unmatched: 2, DraftPending: 3, PendingMemories: 1,
		Works: []naWork{
			{ID: pushed, Title: "等回填", Status: "pushed", UpdatedAt: now.AddDate(0, 0, -2), PushedOrPacked: true},
			{ID: published, Title: "满七天", Status: "published", UpdatedAt: now, PushedOrPacked: true, DueNode: &node7},
		}}
	list := nextActions(in, 10)
	order := []string{}
	byKind := map[string]NextAction{}
	for _, a := range list {
		order = append(order, a.Kind)
		byKind[a.Kind] = a
	}
	want := []string{"setup", "metrics", "publish", "unmatched", "report", "memory"}
	if strings.Join(order, ",") != strings.Join(want, ",") {
		t.Fatalf("main line order: got %v want %v", order, want)
	}
	if a := byKind["setup"]; a.Action != "快速配置" || a.Link != "/settings/models" {
		t.Fatalf("owner setup action: %+v", a)
	}
	if a := byKind["metrics"]; !strings.HasSuffix(a.Link, "node=7") || !strings.Contains(a.Text, "第 7 天") {
		t.Fatalf("metrics follows the due node: %+v", a)
	}
	if a := byKind["publish"]; !strings.HasSuffix(a.Link, "/push") || !strings.Contains(a.Text, "已写入草稿箱 2 天") {
		t.Fatalf("publish backfill: %+v", a)
	}

	in.IsOwner = false
	if a := nextActions(in, 1)[0]; a.Kind != "setup" || !strings.Contains(a.Text, "所有者") {
		t.Fatalf("non-owner setup wording: %+v", a)
	}

	fresh := naInput{Now: now, AccountID: uuid.New(), Platform: "xhs", Works: []naWork{
		{ID: uuid.New(), Title: "刚生成", Status: "packed", UpdatedAt: now, PushedOrPacked: true},
		{ID: uuid.New(), Title: "昨天生成", Status: "packed", UpdatedAt: now.AddDate(0, 0, -1), PushedOrPacked: true},
	}}
	got := nextActions(fresh, 10)
	if len(got) != 1 || got[0].Kind != "publish" || !strings.HasSuffix(got[0].Link, "/pack") || !strings.Contains(got[0].Text, "已生成发布包") {
		t.Fatalf("backfill only after a day, xhs links the pack page: %+v", got)
	}
}

func TestUX02MainLineAPI(t *testing.T) {
	ctx := context.Background()
	a := drWechatAccount(t, "主线验收号")
	path := "/api/v1/accounts/" + a.ID.String() + "/next-actions"
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO metric_unmatched (account_id, external_id, title, ref_date) VALUES ($1,'m1_1','没对上',current_date),($1,'m2_1','也没对上',current_date)`, a.ID); err != nil {
		t.Fatal(err)
	}
	var list []NextAction
	env.mustJSON(t, "GET", path+"?limit=10", nil, &list)
	found := false
	for _, x := range list {
		if x.Kind == "setup" {
			t.Fatalf("AI is configured in the test env: %+v", x)
		}
		if x.Kind == "unmatched" && strings.Contains(x.Text, "2 篇") {
			found = true
		}
	}
	if !found {
		t.Fatalf("unmatched articles belong on the main line: %+v", list)
	}

	ws := env.wsID(t)
	if _, err := env.srv.db.Exec(ctx, `UPDATE model_provider SET status='disabled' WHERE workspace_id=$1`, ws); err != nil {
		t.Fatal(err)
	}
	defer func() { _, _ = env.srv.db.Exec(ctx, `UPDATE model_provider SET status='active' WHERE workspace_id=$1`, ws) }()
	env.mustJSON(t, "GET", path, nil, &list)
	if len(list) == 0 || list[0].Kind != "setup" || len(list) > 3 {
		t.Fatalf("missing model ranks first; default limit stays 3: %+v", list)
	}
	env.mustJSON(t, "GET", path+"?limit=99", nil, &list)
	if len(list) > 10 {
		t.Fatalf("limit is capped at 10, got %d", len(list))
	}
	var st aiStatusResp
	env.mustJSON(t, "GET", "/api/v1/ai/status", nil, &st)
	if st.Ready {
		t.Fatal("ai status follows active providers")
	}
}
