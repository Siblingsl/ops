package app

import (
	"context"
	"testing"

	"github.com/google/uuid"
)

// DEV-PS09 定向测试：连接控制接口的权限与开关语义（20 文档 §4.3、§11.2、§14）。
// 覆盖 owner/editor/viewer、暂停允许本人、auto_adopt 在正式验收前不可开启。

// TestPlatformConnectionPatchPermissions 验证 §4.3 的权限矩阵：
// 增权项只允许 owner 且需重新认证；暂停允许连接保管人本人。
func TestPlatformConnectionPatchPermissions(t *testing.T) {
	f := newPlatformRunFixture(t, "xhs", "xhs_user_id:fixture-self")
	path := "/api/v1/accounts/" + f.Account.ID.String() + "/platform-connection"

	// 未重新认证时不能开启自动采集（增权项）。
	clearReauth(t)
	env.expectErr(t, "PATCH", path, map[string]any{
		"auto_collect": true, "authorization_revision": connectionAuthRevision(t, f.Connection),
	}, "reauth_required")

	// 重新认证后 owner 可以开启。
	env.reauth(t)
	var updated platformConnection
	env.mustJSON(t, "PATCH", path, map[string]any{
		"auto_collect": true, "authorization_revision": connectionAuthRevision(t, f.Connection),
	}, &updated)
	if !updated.AutoCollect {
		t.Fatalf("owner 重新认证后应能开启自动采集：%+v", updated)
	}

	// 自动采用在正式验收前一律拒绝。
	env.expectErr(t, "PATCH", path, map[string]any{
		"auto_adopt": true, "adoption_revision": updated.AdoptionRevision,
	}, "platform_consent_required")

	// 暂停只减权：不要求重新认证。
	clearReauth(t)
	var paused platformConnection
	env.mustJSON(t, "PATCH", path, map[string]any{"state": "paused"}, &paused)
	if paused.State != "paused" {
		t.Fatalf("暂停应成功：%+v", paused)
	}
	// 暂停会取消未结束任务。
	var active int
	if err := env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM platform_sync_run
		WHERE connection_id=$1 AND status IN ('queued','leased','running')`, f.Connection).Scan(&active); err != nil || active != 0 {
		t.Fatalf("暂停后不应有未结束任务：%d %v", active, err)
	}

	// editor 不能开启增权项。直接把成员关系写进目标工作区，避免依赖邀请流程的额外状态。
	editor := env.registerClient(t, "ps09-editor-"+f.Account.ID.String()[:8], testPassword)
	var res struct {
		CSRF   string `json:"csrf_token"`
		UserID string `json:"user_id"`
	}
	editor.mustJSON(t, "GET", "/api/v1/auth/me", nil, &res)
	editor.csrf = res.CSRF
	editorID, err := uuid.Parse(res.UserID)
	if err != nil {
		editor.restore(env)
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(context.Background(), `INSERT INTO workspace_member (workspace_id,user_id,role,status)
		VALUES ($1,$2,'editor','active') ON CONFLICT DO NOTHING`, f.Workspace, editorID); err != nil {
		editor.restore(env)
		t.Fatal(err)
	}
	if st, body := editor.do("POST", "/api/v1/workspaces/"+f.Workspace.String()+"/switch", nil); st != 200 {
		editor.restore(env)
		t.Fatalf("editor switch: %d %s", st, body)
	}
	editor.expectErr(t, "PATCH", path, map[string]any{"auto_collect": false}, "forbidden")
	editor.restore(env)
}

// clearReauth 清掉当前测试会话的重认证窗口，用于验证“必须重新认证”。
func clearReauth(t *testing.T) {
	t.Helper()
	if _, err := env.srv.db.Exec(context.Background(), `UPDATE session SET reauth_until=NULL
		WHERE expires_at > now()`); err != nil {
		t.Fatal(err)
	}
}
