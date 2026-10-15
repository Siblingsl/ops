package app

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/url"
	"strings"
	"testing"

	"github.com/google/uuid"

	"ops/internal/secure"
)

// 16 文档第 2.3 节与第 13.2 节第 3、8、9 项：分发器契约测试。

func (e *testEnv) agentSession(t *testing.T) (sessionID, workspaceID, userID uuid.UUID) {
	t.Helper()
	u, err := url.Parse(e.http.URL)
	if err != nil {
		t.Fatalf("解析测试地址失败：%v", err)
	}
	token := ""
	for _, c := range e.client.Jar.Cookies(u) {
		if c.Name == sessionCookie {
			token = c.Value
		}
	}
	if token == "" {
		t.Fatal("找不到会话 Cookie")
	}
	if err := e.srv.db.QueryRow(context.Background(),
		`SELECT id, current_workspace_id, user_id FROM session WHERE token_hash=$1`,
		secure.SHA256([]byte(token))).Scan(&sessionID, &workspaceID, &userID); err != nil {
		t.Fatalf("读取会话失败：%v", err)
	}
	return sessionID, workspaceID, userID
}

// agentDispatch 以当前浏览器会话的身份走进程内分发器调用一个目录条目。
func (e *testEnv) agentDispatch(t *testing.T, name string, args map[string]any, mutate func(*agentDispatchRequest)) *agentDispatchResult {
	t.Helper()
	sess, ws, _ := e.agentSession(t)
	tool := agentTool(name)
	if tool == nil {
		t.Fatalf("目录中没有工具 %s", name)
	}
	if args == nil {
		args = map[string]any{}
	}
	req := agentDispatchRequest{
		Principal: agentPrincipal{
			SessionID: sess, WorkspaceID: ws,
			ConversationID: uuid.New(), RunID: uuid.New(), ActionID: uuid.New(),
		},
		Tool: tool,
		Args: args,
	}
	if mutate != nil {
		mutate(&req)
	}
	res, err := e.srv.dispatchAgentTool(context.Background(), req)
	if err != nil {
		t.Fatalf("分发 %s 失败：%v", name, err)
	}
	return res
}

func agentResultError(t *testing.T, res *agentDispatchResult) (string, string) {
	t.Helper()
	var env struct {
		OK    bool `json:"ok"`
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(res.Raw, &env); err != nil {
		t.Fatalf("错误结果不是 JSON：%v (%s)", err, res.Raw)
	}
	if env.OK {
		t.Fatalf("期望失败，实际成功：%s", res.Raw)
	}
	return env.Error.Code, env.Error.Message
}

// 内部请求跳过 Cookie 与 CSRF：分发器自己构造请求，浏览器侧不带任何凭据。
func TestAG04DispatchSkipsCookieAndCSRF(t *testing.T) {
	res := env.agentDispatch(t, "workspace__members", nil, nil)
	if res.Status != 200 {
		t.Fatalf("读取类分发返回 %d：%s", res.Status, res.Raw)
	}
	// 写类同样跳过 CSRF。
	res = env.agentDispatch(t, "notifications__read_all", nil, nil)
	if res.Status != 200 {
		t.Fatalf("写入类分发返回 %d：%s", res.Status, res.Raw)
	}
}

// 路径参数注入被拒绝（第 2.3 节「允许的请求」第 1 项）。
func TestAG04DispatchRejectsPathInjection(t *testing.T) {
	env.accounts(t)
	_, _, _ = env.agentSession(t)
	sess, ws, _ := env.agentSession(t)
	tool := agentTool("works__get")
	for _, bad := range []string{"../etc/passwd", "..%2f..%2f", "not-a-uuid", "/abs/path"} {
		_, err := env.srv.dispatchAgentTool(context.Background(), agentDispatchRequest{
			Principal: agentPrincipal{SessionID: sess, WorkspaceID: ws},
			Tool:      tool,
			Args:      map[string]any{"id": bad},
		})
		if err == nil {
			t.Fatalf("路径参数 %q 未被拒绝", bad)
		}
		ae, ok := err.(*APIError)
		if !ok || ae.Status != 422 {
			t.Fatalf("路径参数 %q 的拒绝方式不是 422：%v", bad, err)
		}
	}
	// 未声明的参数一律拒绝。
	_, err := env.srv.dispatchAgentTool(context.Background(), agentDispatchRequest{
		Principal: agentPrincipal{SessionID: sess, WorkspaceID: ws},
		Tool:      tool,
		Args:      map[string]any{"id": uuid.NewString(), "sql": "select 1"},
	})
	if err == nil {
		t.Fatal("未声明的参数未被拒绝")
	}
}

// 内部请求的 ReauthOK 强制为 false：需要再次输入密码的接口经分发器调用返回 reauth_required。
func TestAG04DispatchForcesReauth(t *testing.T) {
	acct := env.accounts(t)
	sess, ws, _ := env.agentSession(t)
	// 该接口本身不在目录中（第 3.7 节黑名单），这里直接构造条目验证第二道保险。
	probe := &AgentTool{
		Name: "probe__save_wechat_credential", Kind: toolW, Method: "PUT",
		Path:   "/accounts/{accountId}/wechat-credential",
		Params: []ToolParam{pPath("accountId")},
	}
	res, err := env.srv.dispatchAgentTool(context.Background(), agentDispatchRequest{
		Principal: agentPrincipal{SessionID: sess, WorkspaceID: ws},
		Tool:      probe,
		Args:      map[string]any{"accountId": acct.wechat.ID.String()},
	})
	if err != nil {
		t.Fatalf("分发失败：%v", err)
	}
	if res.Status != 403 {
		t.Fatalf("期望 403，实际 %d：%s", res.Status, res.Raw)
	}
	if code, _ := agentResultError(t, res); code != "reauth_required" {
		t.Fatalf("期望 reauth_required，实际 %s", code)
	}
}

// 身份在每次分发前重新读取：角色变化后下一次调用立即生效。
func TestAG04DispatchRoleChangeTakesEffect(t *testing.T) {
	sess, ws, user := env.agentSession(t)
	_ = sess
	if res := env.agentDispatch(t, "workspace__invites", nil, nil); res.Status != 200 {
		t.Fatalf("所有者调用返回 %d：%s", res.Status, res.Raw)
	}
	ctx := context.Background()
	if _, err := env.srv.db.Exec(ctx, `UPDATE workspace_member SET role='editor' WHERE workspace_id=$1 AND user_id=$2`, ws, user); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_, _ = env.srv.db.Exec(ctx, `UPDATE workspace_member SET role='owner' WHERE workspace_id=$1 AND user_id=$2`, ws, user)
	}()
	res := env.agentDispatch(t, "workspace__invites", nil, nil)
	if res.Status != 403 {
		t.Fatalf("降级后仍可调用，返回 %d：%s", res.Status, res.Raw)
	}
}

// 会话切换到其他工作区后运行停止（第 2.3 节「身份」第 3 项）。
func TestAG04DispatchWorkspaceSwitchStops(t *testing.T) {
	ctx := context.Background()
	sess, ws, user := env.agentSession(t)
	var created struct {
		ID uuid.UUID `json:"id"`
	}
	env.mustJSON(t, "POST", "/api/v1/workspaces", map[string]any{"name": "第二个工作区", "switch": false}, &created)
	if created.ID == uuid.Nil {
		t.Fatal("创建工作区失败")
	}
	defer func() {
		_, _ = env.srv.db.Exec(ctx, `UPDATE session SET current_workspace_id=$2 WHERE id=$1`, sess, ws)
		_, _ = env.srv.db.Exec(ctx, `DELETE FROM workspace_member WHERE workspace_id=$1`, created.ID)
		_, _ = env.srv.db.Exec(ctx, `DELETE FROM workspace WHERE id=$1`, created.ID)
	}()
	if _, err := env.srv.db.Exec(ctx, `UPDATE session SET current_workspace_id=$2 WHERE id=$1`, sess, created.ID); err != nil {
		t.Fatal(err)
	}
	_ = user
	tool := agentTool("workspace__members")
	res, err := env.srv.dispatchAgentTool(ctx, agentDispatchRequest{
		Principal: agentPrincipal{SessionID: sess, WorkspaceID: ws},
		Tool:      tool,
	})
	if err != nil {
		t.Fatalf("分发失败：%v", err)
	}
	if res.Status != 409 {
		t.Fatalf("期望 409，实际 %d：%s", res.Status, res.Raw)
	}
	if code, msg := agentResultError(t, res); code != "state_invalid" || !strings.Contains(msg, "工作区") {
		t.Fatalf("期望 state_invalid 且提示工作区，实际 %s %s", code, msg)
	}
}

// 维护模式拦截（第 2.3 节「允许的请求」之外的第二道保险）。
func TestAG04DispatchMaintenanceBlocks(t *testing.T) {
	ctx := context.Background()
	setMaintenance := func(on bool) {
		v := "false"
		if on {
			v = "true"
		}
		_, err := env.srv.db.Exec(ctx,
			`INSERT INTO system_setting(key,value) VALUES('maintenance_mode',$1::jsonb)
			 ON CONFLICT(key) DO UPDATE SET value=excluded.value`, v)
		if err != nil {
			t.Fatal(err)
		}
	}
	setMaintenance(true)
	defer setMaintenance(false)
	res := env.agentDispatch(t, "workspace__members", nil, nil)
	if res.Status != 503 {
		t.Fatalf("维护模式下期望 503，实际 %d：%s", res.Status, res.Raw)
	}
}

// 访问日志含 via=agent（第 2.3 节「请求构造」第 6 项）。
func TestAG04DispatchLogsViaAgent(t *testing.T) {
	var buf bytes.Buffer
	old := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelInfo})))
	defer slog.SetDefault(old)
	res := env.agentDispatch(t, "workspace__members", nil, nil)
	if res.Status != 200 {
		t.Fatalf("分发返回 %d：%s", res.Status, res.Raw)
	}
	if !strings.Contains(buf.String(), "via=agent") {
		t.Fatalf("访问日志缺少 via=agent：\n%s", buf.String())
	}
}

// 审计 detail 自动追加 via_agent、agent_action_id、agent_conversation_id（第 9.6 节）。
func TestAG04DispatchAuditViaAgent(t *testing.T) {
	ctx := context.Background()
	conv := uuid.New()
	action := uuid.New()
	res := env.agentDispatch(t, "accounts__create", map[string]any{
		"platform": "xhs", "name": "审计用账号", "content_format": "image_note",
	}, func(r *agentDispatchRequest) {
		r.Principal.ConversationID = conv
		r.Principal.ActionID = action
	})
	if res.Status != 200 {
		t.Fatalf("分发返回 %d：%s", res.Status, res.Raw)
	}
	var created struct {
		ID uuid.UUID `json:"id"`
	}
	if err := json.Unmarshal(res.Raw, &created); err != nil {
		t.Fatalf("解析结果失败：%v", err)
	}
	defer func() {
		env.mustJSON(t, "DELETE", "/api/v1/accounts/"+created.ID.String()+"?confirm=true", nil, nil)
	}()
	var detail map[string]any
	var raw []byte
	if err := env.srv.db.QueryRow(ctx,
		`SELECT detail FROM audit_log WHERE action='account_create' AND target_id=$1`, created.ID.String()).Scan(&raw); err != nil {
		t.Fatalf("读取审计失败：%v", err)
	}
	if err := json.Unmarshal(raw, &detail); err != nil {
		t.Fatal(err)
	}
	if detail["via_agent"] != true {
		t.Errorf("审计 detail 缺少 via_agent：%v", detail)
	}
	if detail["agent_action_id"] != action.String() {
		t.Errorf("审计 detail 的 agent_action_id 不正确：%v", detail)
	}
	if detail["agent_conversation_id"] != conv.String() {
		t.Errorf("审计 detail 的 agent_conversation_id 不正确：%v", detail)
	}
}

// 只读模式：/hot、/brief、/daily 加 prepare=false 后不新增 ai_job、活动记录或任务标记（第 13.2 节第 9 项）。
func TestAG04ReadonlyModes(t *testing.T) {
	ctx := context.Background()
	acct := env.accounts(t)
	count := func(q string, args ...any) int {
		var n int
		if err := env.srv.db.QueryRow(ctx, q, args...).Scan(&n); err != nil {
			t.Fatalf("计数失败：%v", err)
		}
		return n
	}
	jobBefore := count(`SELECT count(*) FROM ai_job`)
	actBefore := count(`SELECT count(*) FROM account_ops_activity WHERE account_id=$1`, acct.wechat.ID)
	for _, name := range []string{"hot__get", "accounts__brief", "daily__get"} {
		res := env.agentDispatch(t, name, map[string]any{"accountId": acct.wechat.ID.String()}, nil)
		if res.Status != 200 {
			t.Fatalf("%s 返回 %d：%s", name, res.Status, res.Raw)
		}
	}
	if jobAfter := count(`SELECT count(*) FROM ai_job`); jobAfter != jobBefore {
		t.Fatalf("只读模式新增了 %d 条 ai_job", jobAfter-jobBefore)
	}
	if actAfter := count(`SELECT count(*) FROM account_ops_activity WHERE account_id=$1`, acct.wechat.ID); actAfter != actBefore {
		t.Fatalf("只读模式写入了运营活动记录")
	}
}

// 角色对照（第 13.2 节第 8 项）：所有者工具以编辑者身份调用返回 403；超管工具以所有者身份调用返回 403。
func TestAG04RoleMatrix(t *testing.T) {
	ctx := context.Background()
	_, ws, user := env.agentSession(t)
	restore := func() {
		_, _ = env.srv.db.Exec(ctx, `UPDATE workspace_member SET role='owner' WHERE workspace_id=$1 AND user_id=$2`, ws, user)
	}
	check := func(t *testing.T, wantRole Role) {
		t.Helper()
		for _, tool := range agentCatalog() {
			if tool.MinRole != wantRole || tool.Path == "" {
				continue
			}
			res := env.agentDispatch(t, tool.Name, agentSampleArgs(tool), nil)
			if res.Status != 403 {
				t.Errorf("条目 %s（最低角色 %s）期望 403，实际 %d：%s", tool.Name, wantRole, res.Status, truncateRunes(string(res.Raw), 200))
			}
		}
	}

	// 降为编辑者，验证所有者工具。
	if _, err := env.srv.db.Exec(ctx, `UPDATE workspace_member SET role='editor' WHERE workspace_id=$1 AND user_id=$2`, ws, user); err != nil {
		t.Fatal(err)
	}
	check(t, roleOwner)
	restore()

	// 所有者身份，验证超管工具。
	check(t, roleSystemAdmin)
}

// agentSampleArgs 为条目的必填参数生成占位值，用于角色对照测试。
func agentSampleArgs(tool AgentTool) map[string]any {
	out := map[string]any{}
	for _, p := range tool.Params {
		if p.Required {
			out[p.Name] = agentSampleValue(p.Schema)
		}
	}
	return out
}

func agentSampleValue(schema json.RawMessage) any {
	var s agentParamSchema
	_ = json.Unmarshal(schema, &s)
	if len(s.Enum) > 0 {
		return s.Enum[0]
	}
	switch s.Type {
	case "string":
		if s.Format == "uuid" {
			return uuid.NewString()
		}
		n := 1
		if s.MinLength != nil {
			n = *s.MinLength
		}
		return strings.Repeat("测", n)
	case "integer":
		if s.Minimum != nil {
			return int64(*s.Minimum)
		}
		return int64(1)
	case "number":
		if s.Minimum != nil {
			return *s.Minimum
		}
		return float64(1)
	case "boolean":
		return true
	case "array":
		return []any{agentSampleValue(s.Items)}
	case "object":
		return map[string]any{}
	default:
		return "x"
	}
}
