package app

import (
	"context"
	"testing"
)

// T-132-18 超管代访问矩阵收尾（17 §10.6.5 / §10.6.16）：
// 连接域操作——公众号凭证写入、凭证检测、发布链路预检——显式拒绝超管代访问
// （与 platform_connection「不能修改/撤销平台连接」同一边界，17 §10.6.5
// 「新平台登录、连接或采集操作禁止」）；账号业务写（资料修改、停用/启用）
// 按 requireOwner 既有代访问例外放行，在此登记为设计行为。
// editor/viewer 的 403 矩阵已由 d132-current-account-settings E2E 覆盖，此处不重复。
func TestD132AdminOverrideAccountMatrix(t *testing.T) {
	// 测试内自建公众号账号，不污染共享夹具账号。
	var acc struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{
		"platform": "wechat_mp", "name": "D-132 代访问矩阵", "content_format": "long_article",
	}, &acc)
	accID := acc.ID
	t.Cleanup(func() {
		env.do("DELETE", "/api/v1/accounts/"+accID+"?confirm=true", nil)
	})

	// owner 正常路径对照：凭证写入成功（代访问修复不得影响既有 owner 流程）。
	env.mustJSON(t, "PUT", "/api/v1/accounts/"+accID+"/wechat-credential",
		map[string]string{"app_id": "wx-d132-owner", "app_secret": "secret-d132-owner"}, nil)

	// 登录超管并进入代访问（夹具模式同 TestAG03AdminOverrideGate）。
	ws := env.me(t).Workspace.ID
	st, body := env.do("POST", "/api/v1/auth/login", map[string]string{"username": "skyeder", "password": testAdminPassword})
	if st != 200 {
		t.Fatalf("登录超管失败：%d %s", st, body)
	}
	defer func() {
		st, body := env.do("POST", "/api/v1/auth/login", map[string]string{"username": "owner", "password": testPassword})
		if st != 200 {
			t.Fatalf("恢复 owner 会话失败：%d %s", st, body)
		}
		env.csrf = env.me(t).CSRF
	}()
	env.csrf = env.me(t).CSRF
	env.mustJSON(t, "POST", "/api/v1/admin/workspaces/"+ws+"/enter", map[string]any{}, nil)
	env.csrf = env.me(t).CSRF

	// 连接域：三个接口全部 403 forbidden，凭证不被改写。
	env.expectErr(t, "PUT", "/api/v1/accounts/"+accID+"/wechat-credential",
		map[string]string{"app_id": "wx-d132-override", "app_secret": "x"}, "forbidden")
	env.expectErr(t, "POST", "/api/v1/accounts/"+accID+"/wechat-credential/test", nil, "forbidden")
	env.expectErr(t, "POST", "/api/v1/accounts/"+accID+"/wechat/link-check", nil, "forbidden")

	// 业务域：按既有规则放行（资料改名、停用、启用均 2xx）。
	var renamed struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	env.mustJSON(t, "PATCH", "/api/v1/accounts/"+accID, map[string]any{"name": "代访问期间的资料修改"}, &renamed)
	if renamed.Name != "代访问期间的资料修改" {
		t.Fatalf("代访问资料修改应按既有规则放行：%+v", renamed)
	}
	env.mustJSON(t, "POST", "/api/v1/accounts/"+accID+"/disable", nil, nil)
	env.mustJSON(t, "POST", "/api/v1/accounts/"+accID+"/enable", nil, nil)

	// 退出代访问。
	env.mustJSON(t, "POST", "/api/v1/admin/workspaces/exit", map[string]any{}, nil)
	env.csrf = env.me(t).CSRF

	// 复核：凭证仍是 owner 写入的值，未被代访问请求改写。
	var appID string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT app_id FROM wechat_credential WHERE account_id=$1`, accID).Scan(&appID); err != nil {
		t.Fatal(err)
	}
	if appID != "wx-d132-owner" {
		t.Fatalf("代访问不得改写凭证：app_id=%s", appID)
	}
}
