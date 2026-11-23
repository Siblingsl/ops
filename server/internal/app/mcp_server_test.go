package app

import (
	"bytes"
	"context"
	"net/http"
	"testing"

	"github.com/google/uuid"
)

func e2CreateToken(t *testing.T, name string, scopes []string) (tokenID uuid.UUID, plain string) {
	t.Helper()
	var out struct {
		ID     string   `json:"id"`
		Token  string   `json:"token"`
		Scopes []string `json:"scopes"`
	}
	env.mustJSON(t, "POST", "/api/v1/mcp/tokens", map[string]any{"name": name, "scopes": scopes}, &out)
	return uuid.MustParse(out.ID), out.Token
}

func e2Call(t *testing.T, plain, tool string, args map[string]any) (int, []byte) {
	t.Helper()
	if args == nil {
		args = map[string]any{}
	}
	return env.doHeader("POST", "/api/v1/mcp/call", map[string]any{"tool": tool, "arguments": args},
		map[string]string{"Authorization": "Bearer " + plain})
}

func TestE2TokenLifecycleAndScopes(t *testing.T) {
	// E2-A1/A3/A4：签发只显示一次明文、scope 校验、撤销立即 401。
	a := drAccount(t, "xhs", "E2 令牌小红书")
	env.ensureToolModel(t)
	// 明文只在创建响应出现一次；列表无 token 字段。
	tokenID, plain := e2CreateToken(t, "外部看板", []string{"read:topics", "read:works"})
	if plain == "" {
		t.Fatal("plain token missing")
	}
	var list struct {
		Tokens []map[string]any `json:"tokens"`
	}
	env.mustJSON(t, "GET", "/api/v1/mcp/tokens", nil, &list)
	for _, token := range list.Tokens {
		if _, has := token["token"]; has {
			t.Fatal("list must not expose plain token")
		}
		if _, has := token["token_hash"]; has {
			t.Fatal("list must not expose token hash")
		}
	}
	// 数据库存哈希（64 hex）。
	var hash string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT token_hash FROM mcp_token WHERE id=$1`, tokenID).Scan(&hash); err != nil {
		t.Fatal(err)
	}
	if len(hash) != 64 {
		t.Fatalf("hash length = %d", len(hash))
	}
	if hash == plain {
		t.Fatal("must store hash, not plain")
	}
	// 无 scope 调用被拒。
	status, body := e2Call(t, plain, "get_review", map[string]any{"work_id": uuid.NewString()})
	if status != http.StatusForbidden || !bytes.Contains(body, []byte("mcp_scope_denied")) {
		t.Fatalf("scope denied: status=%d body=%s", status, body)
	}
	// 撤销立即生效 → 401。
	env.mustJSON(t, "DELETE", "/api/v1/mcp/tokens/"+tokenID.String(), nil, &struct{}{})
	status, body = e2Call(t, plain, "list_topics", map[string]any{"account_id": a.ID.String()})
	if status != http.StatusUnauthorized || !bytes.Contains(body, []byte("mcp_token_revoked")) {
		t.Fatalf("revoked must 401: status=%d body=%s", status, body)
	}
}

func TestE2TenantIsolationAndReadOnly(t *testing.T) {
	// E2-A3：跨租户 ID → mcp_not_found；未知工具/写工具不可用。
	a := drAccount(t, "xhs", "E2 隔离小红书")
	env.ensureToolModel(t)
	wk := publishTestWork(t, a, "E2 作品", 900, 1200, []string{"测试"})
	tokenID, plain := e2CreateToken(t, "隔离检查", []string{"read:topics", "read:works", "read:reviews", "read:metrics", "read:benchmark"})
	_ = tokenID
	// 正常读：get_work。
	status, body := e2Call(t, plain, "get_work", map[string]any{"work_id": wk.ID.String()})
	if status != 200 || !bytes.Contains(body, []byte("read_only")) {
		t.Fatalf("get_work: status=%d body=%s", status, body)
	}
	// 跨租户 work_id → mcp_not_found。
	g := env.registerClient(t, "e2_cross_"+uuid.NewString()[:8], testPassword)
	defer g.restore(env)
	otherToken := ""
	var out struct {
		Token string `json:"token"`
	}
	env.mustJSON(t, "POST", "/api/v1/mcp/tokens", map[string]any{"name": "他人令牌", "scopes": []string{"read:works"}}, &out)
	otherToken = out.Token
	// 恢复主客户端身份后再看：otherToken 属于新工作区，读不到 a 的作品。
	status, body = e2Call(t, otherToken, "get_work", map[string]any{"work_id": wk.ID.String()})
	if status != http.StatusNotFound || !bytes.Contains(body, []byte("mcp_not_found")) {
		t.Fatalf("cross tenant must 404: status=%d body=%s", status, body)
	}
	// 未知工具。
	status, _ = e2Call(t, plain, "publish_now", map[string]any{})
	if status != http.StatusUnprocessableEntity {
		t.Fatalf("write tool must be unknown: status=%d", status)
	}
	// list_topics 参数缺失。
	status, _ = e2Call(t, plain, "list_topics", map[string]any{"account_id": "not-uuid"})
	if status != http.StatusUnprocessableEntity {
		t.Fatalf("bad uuid must 422: status=%d", status)
	}
}

func TestE2AuditLogMetadataOnly(t *testing.T) {
	// E2-A5：审计只存 token/tool/result_code/duration_ms，无正文列。
	a := drAccount(t, "xhs", "E2 审计小红书")
	env.ensureToolModel(t)
	wk := publishTestWork(t, a, "E2 审计作品", 900, 1200, []string{"测试"})
	_, plain := e2CreateToken(t, "审计检查", []string{"read:works"})
	if status, _ := e2Call(t, plain, "get_work", map[string]any{"work_id": wk.ID.String()}); status != 200 {
		t.Fatalf("call failed: %d", status)
	}
	var tool, code string
	var duration int
	var bodyText *string
	err := env.srv.db.QueryRow(context.Background(),
		`SELECT tool, result_code, duration_ms FROM mcp_call_log ORDER BY at DESC LIMIT 1`).
		Scan(&tool, &code, &duration)
	if err != nil {
		t.Fatal(err)
	}
	if tool != "get_work" || code != "ok" || duration < 0 {
		t.Fatalf("audit fields wrong: %s/%s/%d", tool, code, duration)
	}
	// mcp_call_log 不存在正文类列。
	var cols []string
	rows, err := env.srv.db.Query(context.Background(),
		`SELECT column_name FROM information_schema.columns WHERE table_name='mcp_call_log'`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var c string
		_ = rows.Scan(&c)
		cols = append(cols, c)
	}
	for _, c := range cols {
		if c == "body" || c == "result" || c == "response" || c == "content" {
			t.Fatalf("audit must not store body column: %s", c)
		}
	}
	_ = bodyText
}
