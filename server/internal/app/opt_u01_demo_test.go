package app

// OPT-U01（docs/43 §4）：零账号可直接进入“5 分钟演示工作区”。
// 本测试锁三件事：
// 1) POST /api/v1/demo 原子创建公众号 + 小红书两个示例账号，档案/选题/素材/草稿齐全；
// 2) 示例账号的全部真实写入入口（公众号草稿、发布任务、批次、粉丝数据）服务端硬返回 409；
// 3) DELETE /api/v1/demo 只清示例账号，不伤同一工作区的真实账号与真实作品。

import (
	"context"
	"fmt"
	"net/http"
	"testing"

	"github.com/google/uuid"
)

func TestDemoWorkspaceDualAccountsAndGuards(t *testing.T) {
	ctx := context.Background()
	t.Cleanup(func() {
		// 失败中断时也不把示例数据留给后续用例。
		env.do("DELETE", "/api/v1/demo", nil)
	})

	var created struct {
		AccountID    uuid.UUID   `json:"account_id"`
		XHSAccountID uuid.UUID   `json:"xhs_account_id"`
		AccountIDs   []uuid.UUID `json:"account_ids"`
	}
	env.mustJSON(t, "POST", "/api/v1/demo", nil, &created)
	if created.AccountID == uuid.Nil || created.XHSAccountID == uuid.Nil || created.AccountID == created.XHSAccountID {
		t.Fatalf("demo workspace ids: %+v", created)
	}
	if len(created.AccountIDs) != 2 || created.AccountIDs[0] != created.AccountID || created.AccountIDs[1] != created.XHSAccountID {
		t.Fatalf("demo account_ids 必须同时返回两个账号: %+v", created.AccountIDs)
	}

	count := func(table, where string, id uuid.UUID) int {
		t.Helper()
		var n int
		if err := env.srv.db.QueryRow(ctx, fmt.Sprintf(`SELECT count(*) FROM %s WHERE %s=$1`, table, where), id).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	requireDemo := func(id uuid.UUID, platform, format, name string) {
		t.Helper()
		var gotPlatform, gotFormat, gotName string
		var isDemo bool
		if err := env.srv.db.QueryRow(ctx, `SELECT platform, content_format, name, is_demo FROM platform_account WHERE id=$1`, id).
			Scan(&gotPlatform, &gotFormat, &gotName, &isDemo); err != nil {
			t.Fatal(err)
		}
		if gotPlatform != platform || gotFormat != format || gotName != name || !isDemo {
			t.Fatalf("示例账号不符：platform=%s format=%s name=%s demo=%v", gotPlatform, gotFormat, gotName, isDemo)
		}
		if count("account_profile", "account_id", id) != 1 {
			t.Fatalf("%s 示例账号缺定位档案", platform)
		}
		if got := count("topic", "account_id", id); got < 2 {
			t.Fatalf("%s 示例选题不足 2 条：%d", platform, got)
		}
		if got := count("material", "account_id", id); got < 3 {
			t.Fatalf("%s 示例素材不足 3 条：%d", platform, got)
		}
		var workID uuid.UUID
		if err := env.srv.db.QueryRow(ctx, `SELECT id FROM work WHERE account_id=$1 AND deleted_at IS NULL ORDER BY created_at LIMIT 1`, id).Scan(&workID); err != nil {
			t.Fatalf("%s 示例草稿缺失: %v", platform, err)
			return
		}
		if got := count("work_section", "work_id", workID); got < 3 {
			t.Fatalf("%s 示例草稿正文不足 3 段：%d", platform, got)
		}
	}
	requireDemo(created.AccountID, "wechat_mp", "long_article", "示例 · 职场成长笔记")
	requireDemo(created.XHSAccountID, "xhs", "image_note", "示例 · 效率工具手账")

	// 防重复导入：已有示例账号时再次导入必须 state_invalid。
	env.expectErr(t, "POST", "/api/v1/demo", nil, "state_invalid")

	var workspaceID uuid.UUID
	if err := env.srv.db.QueryRow(ctx, `SELECT workspace_id FROM platform_account WHERE id=$1`, created.AccountID).Scan(&workspaceID); err != nil {
		t.Fatal(err)
	}
	var wechatWorkID uuid.UUID
	if err := env.srv.db.QueryRow(ctx, `SELECT id FROM work WHERE account_id=$1 AND deleted_at IS NULL ORDER BY created_at LIMIT 1`, created.AccountID).Scan(&wechatWorkID); err != nil {
		t.Fatal(err)
	}

	// 1) 示例公众号作品不得写入真实草稿箱。
	pushErr := expectStatusErr(t, "POST", "/api/v1/works/"+wechatWorkID.String()+"/wechat/push",
		map[string]any{"revision": 1}, http.StatusConflict, "demo_account_readonly")
	if pushErr.Error.Message != "示例账号仅供体验写作与预览，不能写入真实平台草稿，请先绑定真实账号" {
		t.Fatalf("push 文案不符: %s", pushErr.Error.Message)
	}

	// 2) 示例作品不得创建发布任务或发布批次。
	expectStatusErr(t, "POST", "/api/v1/works/"+wechatWorkID.String()+"/publish-tasks",
		map[string]any{"platforms": []string{"wechat_mp"}, "mode": "manual"},
		http.StatusConflict, "demo_account_readonly")
	expectStatusErr(t, "POST", "/api/v1/publish-batches",
		map[string]any{"label": "示例批次", "work_ids": []uuid.UUID{wechatWorkID}, "platforms": []string{"wechat_mp"}, "mode": "manual"},
		http.StatusConflict, "demo_account_readonly")

	// 3) 示例账号不得录入/导入/回填粉丝数据，account_metric_daily 必须保持零行。
	metricErr := expectStatusErr(t, "POST", "/api/v1/accounts/"+created.XHSAccountID.String()+"/followers",
		map[string]any{"date": "2026-11-20", "cumulate": 10},
		http.StatusConflict, "demo_account_readonly")
	if metricErr.Error.Message != "示例账号不记录真实账号统计数据，请先绑定真实账号" {
		t.Fatalf("followers 文案不符: %s", metricErr.Error.Message)
	}
	expectStatusErr(t, "POST", "/api/v1/accounts/"+created.XHSAccountID.String()+"/followers/import",
		map[string]any{"csv": "date,count\n2026-11-20,10"},
		http.StatusConflict, "demo_account_readonly")
	expectStatusErr(t, "POST", "/api/v1/accounts/"+created.XHSAccountID.String()+"/followers/backfill",
		map[string]any{"platform": "xhs", "from": "2026-11-20", "to": "2026-11-20", "values": []map[string]any{{"date": "2026-11-20", "count": 10}}},
		http.StatusConflict, "demo_account_readonly")
	if got := count("account_metric_daily", "account_id", created.XHSAccountID); got != 0 {
		t.Fatalf("示例账号写入了 account_metric_daily：%d", got)
	}

	// 4) 已有示例任务也不得排队（queue / retry 走同一 queued 分支）。
	var taskID uuid.UUID
	if err := env.srv.db.QueryRow(ctx, `INSERT INTO publish_task
		(workspace_id, account_id, work_id, platform, state, state_version, mode, idempotency_key)
		VALUES ($1,$2,$3,'wechat_mp','ready',1,'manual','demo-guard-test') RETURNING id`,
		workspaceID, created.AccountID, wechatWorkID).Scan(&taskID); err != nil {
		t.Fatal(err)
	}
	expectStatusErr(t, "POST", "/api/v1/publish-tasks/"+taskID.String()+"/queue",
		map[string]any{"expected_version": 1, "idempotency_key": "demo-queue"},
		http.StatusConflict, "demo_account_readonly")

	// 5) 一键清空只清示例：先建真实账号 + 真实作品，再清。
	f := env.accounts(t)
	var realWork Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+f.wechat.ID.String()+"/works",
		map[string]string{"title": "真实账号的作品"}, &realWork)

	var cleared struct {
		Cleared int `json:"cleared"`
	}
	env.mustJSON(t, "DELETE", "/api/v1/demo", nil, &cleared)
	if cleared.Cleared != 2 {
		t.Fatalf("cleared = %d, want 2", cleared.Cleared)
	}
	var demoAccounts int
	if err := env.srv.db.QueryRow(ctx, `SELECT count(*) FROM platform_account WHERE workspace_id=$1 AND is_demo`, workspaceID).Scan(&demoAccounts); err != nil {
		t.Fatal(err)
	}
	if demoAccounts != 0 {
		t.Fatalf("清空后仍有示例账号: %d", demoAccounts)
	}
	if got := count("topic", "account_id", created.AccountID); got != 0 {
		t.Fatalf("示例选题未清空: %d", got)
	}
	if got := count("material", "account_id", created.AccountID); got != 0 {
		t.Fatalf("示例素材未清空: %d", got)
	}
	var demoWorks int
	if err := env.srv.db.QueryRow(ctx, `SELECT count(*) FROM work WHERE account_id IN ($1,$2)`, created.AccountID, created.XHSAccountID).Scan(&demoWorks); err != nil {
		t.Fatal(err)
	}
	if demoWorks != 0 {
		t.Fatalf("示例作品未清空: %d", demoWorks)
	}
	var realStillThere int
	if err := env.srv.db.QueryRow(ctx, `SELECT count(*) FROM work WHERE id=$1 AND deleted_at IS NULL`, realWork.ID).Scan(&realStillThere); err != nil {
		t.Fatal(err)
	}
	if realStillThere != 1 {
		t.Fatalf("真实作品被误删")
	}
	var realAccount int
	if err := env.srv.db.QueryRow(ctx, `SELECT count(*) FROM platform_account WHERE id=$1 AND is_demo=false`, f.wechat.ID).Scan(&realAccount); err != nil {
		t.Fatal(err)
	}
	if realAccount != 1 {
		t.Fatalf("真实账号被误删")
	}
}
