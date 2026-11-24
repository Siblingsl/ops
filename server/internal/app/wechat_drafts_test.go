package app

// RC-01 / D-221：公众号草稿箱产品路由。
// 覆盖 list/count/delete 的真实产品路径、分页参数校验、逐张 confirm 与删除后计数回落。

import (
	"context"
	"strings"
	"testing"

	"github.com/google/uuid"

	"ops/internal/wechat"
)

func TestWechatDraftProductRoutes(t *testing.T) {
	ctx := context.Background()
	var a Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{
		"platform": "wechat_mp", "name": "RC-01 产品化账号", "content_format": "long_article",
	}, &a)
	t.Cleanup(func() { _, _ = env.srv.db.Exec(context.Background(), `DELETE FROM platform_account WHERE id=$1`, a.ID) })
	env.mustJSON(t, "PUT", "/api/v1/accounts/"+a.ID.String()+"/wechat-credential",
		map[string]string{"app_id": "wx1234567890", "app_secret": "rc01-test-secret"}, nil)

	token, err := env.srv.accessToken(ctx, a.ID, true)
	if err != nil {
		t.Fatalf("accessToken: %v", err)
	}
	base, err := env.srv.wx.DraftCount(ctx, token)
	if err != nil {
		t.Fatalf("baseline DraftCount: %v", err)
	}
	thumb, _, err := env.srv.wx.AddImageMaterial(ctx, token, "rc01-thumb.png", testPNG(900, 500))
	if err != nil {
		t.Fatalf("AddImageMaterial: %v", err)
	}
	const title = "RC-01 产品化草稿：逐张删除"
	mid, err := env.srv.wx.DraftAdd(ctx, token, wechat.Article{
		Title: title, Content: "<p>RC-01 product draft</p>", ThumbMediaID: thumb,
	})
	if err != nil {
		t.Fatalf("DraftAdd: %v", err)
	}
	t.Cleanup(func() { _ = env.srv.wx.DraftDelete(context.Background(), token, mid) })

	var list wechatDraftList
	env.mustJSON(t, "GET", "/api/v1/accounts/"+a.ID.String()+"/wechat/drafts?offset=0&count=10", nil, &list)
	if list.TotalCount != base+1 {
		t.Fatalf("list total=%d want %d", list.TotalCount, base+1)
	}
	found := false
	for _, it := range list.Items {
		if it.MediaID == mid {
			found = true
			if it.Title != title {
				t.Fatalf("title=%q want %q", it.Title, title)
			}
			if strings.TrimSpace(it.UpdatedAt) == "" {
				t.Fatal("updated_at empty")
			}
		}
	}
	if !found {
		t.Fatalf("created media_id %s not in list: %+v", mid, list.Items)
	}

	var count struct {
		TotalCount int `json:"total_count"`
	}
	env.mustJSON(t, "GET", "/api/v1/accounts/"+a.ID.String()+"/wechat/drafts/count", nil, &count)
	if count.TotalCount != base+1 {
		t.Fatalf("count=%d want %d", count.TotalCount, base+1)
	}

	// 非法分页必须显式 422，不能静默回退。
	env.expectErr(t, "GET", "/api/v1/accounts/"+a.ID.String()+"/wechat/drafts?count=21", nil, "validation_failed")

	// 不确认不得删除；确认后只删这一篇。
	env.expectErr(t, "DELETE", "/api/v1/accounts/"+a.ID.String()+"/wechat/drafts/"+mid,
		map[string]bool{"confirm": false}, "confirm_required")

	var deleted map[string]any
	env.mustJSON(t, "DELETE", "/api/v1/accounts/"+a.ID.String()+"/wechat/drafts/"+mid,
		map[string]bool{"confirm": true}, &deleted)
	if deleted["ok"] != true {
		t.Fatalf("delete response: %+v", deleted)
	}

	env.mustJSON(t, "GET", "/api/v1/accounts/"+a.ID.String()+"/wechat/drafts/count", nil, &count)
	if count.TotalCount != base {
		t.Fatalf("count after delete=%d want baseline %d", count.TotalCount, base)
	}

	// 已删除的 media_id 再次删除返回微信错误，而不是被静默当成功。
	env.expectErr(t, "DELETE", "/api/v1/accounts/"+a.ID.String()+"/wechat/drafts/"+mid,
		map[string]bool{"confirm": true}, "wechat_error")
}

// TestWechatDraftProductRoutesPermissions 固定 D-221 的权限口径：
// list/count 任意工作区成员可读，delete 仅 owner；非 owner 即使带 confirm 也不得删除。
func TestWechatDraftProductRoutesPermissions(t *testing.T) {
	ctx := context.Background()
	var a Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{
		"platform": "wechat_mp", "name": "RC-01 权限账号", "content_format": "long_article",
	}, &a)
	t.Cleanup(func() { _, _ = env.srv.db.Exec(context.Background(), `DELETE FROM platform_account WHERE id=$1`, a.ID) })
	env.mustJSON(t, "PUT", "/api/v1/accounts/"+a.ID.String()+"/wechat-credential",
		map[string]string{"app_id": "wx1234567890", "app_secret": "rc01-test-secret"}, nil)

	token, err := env.srv.accessToken(ctx, a.ID, true)
	if err != nil {
		t.Fatalf("accessToken: %v", err)
	}
	thumb, _, err := env.srv.wx.AddImageMaterial(ctx, token, "rc01-perm-thumb.png", testPNG(900, 500))
	if err != nil {
		t.Fatalf("AddImageMaterial: %v", err)
	}
	mid, err := env.srv.wx.DraftAdd(ctx, token, wechat.Article{
		Title: "RC-01 权限草稿", Content: "<p>permissions</p>", ThumbMediaID: thumb,
	})
	if err != nil {
		t.Fatalf("DraftAdd: %v", err)
	}
	t.Cleanup(func() { _ = env.srv.wx.DraftDelete(context.Background(), token, mid) })

	var inv struct {
		Code string `json:"code"`
	}
	env.mustJSON(t, "POST", "/api/v1/workspaces/current/invites", map[string]any{
		"role": "viewer", "max_uses": 1, "days": 1,
	}, &inv)
	viewer := env.registerClient(t, "rc01-draft-viewer", testPassword)
	viewer.mustJSON(t, "POST", "/api/v1/workspaces/join", map[string]any{"code": inv.Code, "switch": true}, nil)
	var viewerID uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(), `SELECT id FROM app_user WHERE username=$1`, "rc01-draft-viewer").Scan(&viewerID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(context.Background(), `DELETE FROM workspace_member WHERE user_id=$1`, viewerID)
	})

	var list wechatDraftList
	viewer.mustJSON(t, "GET", "/api/v1/accounts/"+a.ID.String()+"/wechat/drafts?offset=0&count=10", nil, &list)
	if list.TotalCount < 1 {
		t.Fatalf("viewer list total=%d want >=1", list.TotalCount)
	}
	var count struct {
		TotalCount int `json:"total_count"`
	}
	viewer.mustJSON(t, "GET", "/api/v1/accounts/"+a.ID.String()+"/wechat/drafts/count", nil, &count)
	if count.TotalCount != list.TotalCount {
		t.Fatalf("viewer count=%d list=%d", count.TotalCount, list.TotalCount)
	}
	viewer.expectErr(t, "DELETE", "/api/v1/accounts/"+a.ID.String()+"/wechat/drafts/"+mid,
		map[string]bool{"confirm": true}, "forbidden")
	viewer.restore(env)

	// 非 owner 的删除被拒后，草稿必须还在。
	env.mustJSON(t, "GET", "/api/v1/accounts/"+a.ID.String()+"/wechat/drafts/count", nil, &count)
	if count.TotalCount < 1 {
		t.Fatalf("draft disappeared after forbidden delete: count=%d", count.TotalCount)
	}
}
