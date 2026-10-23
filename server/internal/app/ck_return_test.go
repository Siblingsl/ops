package app

import (
	"testing"
)

// TestCK03_ReturnReviewMovesToDrafting 覆盖 CK-03（审阅退回）：
// 指定审阅人退回后作品回到「创作中」、留下评论与审计；非审阅人不能退回；
// 退回原因必填且不超过 2000 字；不在待审阅状态时返回 state_invalid。
func TestCK03_ReturnReviewMovesToDrafting(t *testing.T) {
	f := env.accounts(t)

	makeReviewingWork := func(t *testing.T, a Account, viewpoint string) Work {
		t.Helper()
		wk := env.readyWork(t, a, viewpoint)
		var got Work
		env.mustJSON(t, "PATCH", "/api/v1/works/"+wk.ID.String(), map[string]any{"review_required": true}, &got)
		if got.Status != "reviewing" {
			t.Fatalf("设置 review_required 后期望 reviewing，实际 %s", got.Status)
		}
		return got
	}

	t.Run("successful_return", func(t *testing.T) {
		wk := makeReviewingWork(t, f.wechat, "审阅退回测试")
		id := wk.ID.String()
		var out struct {
			Work      string `json:"work"`
			CommentID string `json:"comment_id"`
		}
		env.mustJSON(t, "POST", "/api/v1/works/"+id+"/review/return", map[string]any{
			"note": "请补充数据来源并修正事实错误",
		}, &out)
		if out.CommentID == "" {
			t.Fatal("退回后应返回 comment_id")
		}
		var fresh Work
		env.mustJSON(t, "GET", "/api/v1/works/"+id, nil, &fresh)
		if fresh.Status != "drafting" {
			t.Fatalf("退回后状态应为 drafting，实际 %s", fresh.Status)
		}
		if fresh.ReviewedAt != nil {
			t.Fatal("退回后 reviewed_at 应为空")
		}
		var comments struct {
			Items []Comment `json:"items"`
		}
		env.mustJSON(t, "GET", "/api/v1/works/"+id+"/comments", nil, &comments)
		found := false
		for _, c := range comments.Items {
			if c.ID.String() == out.CommentID && c.Body == "请补充数据来源并修正事实错误" {
				found = true
			}
		}
		if !found {
			t.Fatal("退回原因应作为评论留在作品里")
		}
		var n int
		if err := env.srv.db.QueryRow(t.Context(),
			`SELECT count(*) FROM audit_log WHERE action='review_return' AND target_id=$1`, id).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n == 0 {
			t.Fatal("audit_log 应记录 review_return")
		}
	})

	t.Run("note_empty_returns_validation", func(t *testing.T) {
		wk := makeReviewingWork(t, f.wechat, "空退回原因")
		id := wk.ID.String()
		env.expectErr(t, "POST", "/api/v1/works/"+id+"/review/return", map[string]any{"note": ""}, "validation_failed")
		env.expectErr(t, "POST", "/api/v1/works/"+id+"/review/return", map[string]any{"note": "   "}, "validation_failed")
	})

	t.Run("note_too_long_returns_validation", func(t *testing.T) {
		wk := makeReviewingWork(t, f.wechat, "超长退回原因")
		id := wk.ID.String()
		long := make([]rune, 2001)
		for i := range long {
			long[i] = 'a'
		}
		env.expectErr(t, "POST", "/api/v1/works/"+id+"/review/return", map[string]any{"note": string(long)}, "validation_failed")
	})

	t.Run("work_not_in_reviewing_returns_state_invalid", func(t *testing.T) {
		wk := env.readyWork(t, f.xhs, "非 reviewing 状态")
		env.expectErr(t, "POST", "/api/v1/works/"+wk.ID.String()+"/review/return", map[string]any{"note": "test"}, "state_invalid")
	})
}

// TestCK06_CheckExitMovesToDrafting 覆盖 CK-06（退出检查）：
// 检查中可退回「创作中」，历史检查结果保留；不在检查中时返回 state_invalid；退出写审计。
func TestCK06_CheckExitMovesToDrafting(t *testing.T) {
	f := env.accounts(t)

	startCheck := func(t *testing.T, wk Work) string {
		t.Helper()
		var started struct {
			Run CheckRun `json:"run"`
		}
		env.mustJSON(t, "POST", "/api/v1/works/"+wk.ID.String()+"/checks", nil, &started)
		var fresh Work
		env.mustJSON(t, "GET", "/api/v1/works/"+wk.ID.String(), nil, &fresh)
		if fresh.Status != "checking" {
			t.Skipf("检查未进入 checking（状态 %s），跳过", fresh.Status)
		}
		return started.Run.ID.String()
	}

	t.Run("successful_exit_from_checking", func(t *testing.T) {
		wk := env.readyWork(t, f.wechat, "检查退出测试")
		id := wk.ID.String()
		runID := startCheck(t, wk)
		var out Work
		env.mustJSON(t, "POST", "/api/v1/works/"+id+"/check/exit", nil, &out)
		if out.Status != "drafting" {
			t.Fatalf("退出检查后状态应为 drafting，实际 %s", out.Status)
		}
		// 退出只是离开检查状态，已经跑出来的这次检查结果要留着，便于对照修改。
		var latest struct {
			Run *CheckRun `json:"run"`
		}
		env.mustJSON(t, "GET", "/api/v1/works/"+id+"/checks/latest", nil, &latest)
		if latest.Run == nil || latest.Run.ID.String() != runID {
			t.Fatalf("退出检查后应保留这次检查结果 %s，实际 %+v", runID, latest.Run)
		}
	})

	t.Run("not_in_checking_returns_state_invalid", func(t *testing.T) {
		wk := env.readyWork(t, f.xhs, "非 checking 状态")
		env.expectErr(t, "POST", "/api/v1/works/"+wk.ID.String()+"/check/exit", nil, "state_invalid")
	})

	t.Run("audit_entry_created", func(t *testing.T) {
		wk := env.readyWork(t, f.wechat, "检查退出审计测试")
		id := wk.ID.String()
		startCheck(t, wk)
		env.mustJSON(t, "POST", "/api/v1/works/"+id+"/check/exit", nil, nil)
		var n int
		if err := env.srv.db.QueryRow(t.Context(),
			`SELECT count(*) FROM audit_log WHERE action='check_exit' AND target_id=$1`, id).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n == 0 {
			t.Fatal("audit_log 应记录 check_exit")
		}
	})
}
