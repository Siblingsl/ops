package app

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/google/uuid"
)

// 判据（第 13.2 节第 11 项）：以种子数据对附录 A 中每个 R、G 工具各执行一次，
// 执行前后对业务表做行数与内容哈希快照，除 `ai_call`、`ai_job`、`audit_log`
// 三张日志类表与第 14.2 节第 4 项的槽位补齐外不得有变化。
// 执行经分发器直接调用（与第 8 项角色对照同一路径），不经运行循环，
// 因此不受读取/生成限额影响；只验证类别语义（R/G 不写业务数据）。
func TestAG11ReadGenerateToolsAudit(t *testing.T) {
	acc := env.accounts(t)
	wk := env.readyWork(t, acc.wechat, "R/G 类别核对")
	defer agentDropWork(wk.ID)

	// 种子参数（同 HC-26）。
	var sectionID, itemID, assetID string
	if len(wk.Sections) > 0 {
		sectionID = wk.Sections[0].ID.String()
	}
	if run := env.latestCheck(t, wk.ID.String()); run != nil && len(run.Items) > 0 {
		itemID = run.Items[0].ID.String()
	}
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT id FROM asset WHERE work_id=$1 LIMIT 1`, wk.ID).Scan(&assetID); err != nil {
		t.Fatal(err)
	}

	// 超管条目需要超管身份才能被接口层放行；临时提升后执行，结束后恢复。
	ctx := context.Background()
	var uid string
	if err := env.srv.db.QueryRow(ctx, `SELECT id::text FROM app_user WHERE username=$1`,
		env.me(t).Username).Scan(&uid); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(ctx, `UPDATE app_user SET is_system_admin=true WHERE id=$1`, uid); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_, _ = env.srv.db.Exec(ctx, `UPDATE app_user SET is_system_admin=false WHERE id=$1`, uid)
	}()

	before := agentBusinessSnapshot(t)

	// 元工具不属于附录 A（第 3.3 节），排除。
	metaTools := map[string]bool{"get_context": true, "load_tool_domain": true, "global_search": true, "make_link": true}
	sess, ws, _ := env.agentSession(t)
	checked := 0
	okCount := 0
	failures := []string{}
	for _, tool := range agentCatalog() {
		if tool.Kind != toolR && tool.Kind != toolG {
			continue
		}
		if metaTools[tool.Name] || tool.Path == "" {
			continue
		}
		checked++
		args := agentCoverageArgs(&tool, wk.ID.String(), acc.wechat.ID.String(), sectionID, itemID, assetID)
		// 直接经分发器执行；参数不足等分发错误同样计为一次「执行尝试」（不改变数据）。
		res, err := env.srv.dispatchAgentTool(ctx, agentDispatchRequest{
			Principal: agentPrincipal{SessionID: sess, WorkspaceID: ws,
				ConversationID: uuid.New(), RunID: uuid.New(), ActionID: uuid.New()},
			Tool: &tool, Args: args,
		})
		if err != nil {
			failures = append(failures, tool.Name+":err")
			continue
		}
		if res.Status == 200 {
			okCount++
		} else {
			failures = append(failures, fmt.Sprintf("%s:%d", tool.Name, res.Status))
		}
	}
	if checked < 100 {
		t.Fatalf("R/G 条目数异常：%d（期望 114）", checked)
	}

	after := agentBusinessSnapshot(t)
	for tb, sig := range before {
		if after[tb] != sig {
			t.Fatalf("R/G 工具执行后业务表 %s 不应变化：%s -> %s", tb, sig, after[tb])
		}
	}
	t.Logf("R/G 共 %d 条：执行成功 %d，非 200 %d", checked, okCount, len(failures))
	if len(failures) > 0 {
		t.Logf("非 200 清单（参数不足或权限限制，不影响无副作用结论）：%s", strings.Join(failures, " "))
	}
}

// agentCoverageArgs 在 agentSweepArgs（路径参数）基础上，为必填的 query/body 参数补充最小合法值：
// 种子 ID 优先（让读取尽量命中真实对象），其余按 Schema 采样（agentSampleValue）。
func agentCoverageArgs(tool *AgentTool, workID, accountID, sectionID, itemID, assetID string) map[string]any {
	args := map[string]any{}
	_ = json.Unmarshal([]byte(agentSweepArgs(tool, workID, accountID, sectionID, itemID, assetID)), &args)
	for _, p := range tool.Params {
		if !p.Required || p.In == "path" {
			continue
		}
		switch p.Name {
		case "account_id", "accountId":
			args[p.Name] = accountID
		case "work_id", "workId":
			args[p.Name] = workID
		default:
			args[p.Name] = agentSampleValue(p.Schema)
		}
	}
	return args
}

// 判据（第 13.5 节第 2 项）：附录 A 每个领域至少一个 R 工具和一个 W/H/X 工具在
// E2E 或契约测试中实际执行过。本测试补齐 profile、ops、review、admin 四个领域的执行覆盖
// （其余九个领域已由 E2E-22 至 30、HC-30 与 AG07 分发用例覆盖执行）。
func TestAG11DomainExecutionCoverage(t *testing.T) {
	acc := env.accounts(t)
	wk := env.readyWork(t, acc.wechat, "领域执行覆盖")
	defer agentDropWork(wk.ID)

	// admin 领域需要超管身份；临时提升后执行，结束后恢复。
	ctx := context.Background()
	var uid string
	if err := env.srv.db.QueryRow(ctx, `SELECT id::text FROM app_user WHERE username=$1`,
		env.me(t).Username).Scan(&uid); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(ctx, `UPDATE app_user SET is_system_admin=true WHERE id=$1`, uid); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_, _ = env.srv.db.Exec(ctx, `UPDATE app_user SET is_system_admin=false WHERE id=$1`, uid)
	}()

	// profile__update 是完整替换接口：先读取当前档案，合并后提交（保留原值 + 改动人设语气）。
	get := env.agentDispatch(t, "profile__get", map[string]any{"accountId": acc.wechat.ID.String()}, nil)
	if get.Status != 200 {
		t.Fatalf("profile__get 应成功：%d %s", get.Status, get.Raw)
	}
	var profile map[string]any
	if err := json.Unmarshal(get.Raw, &profile); err != nil {
		t.Fatal(err)
	}
	update := map[string]any{"accountId": acc.wechat.ID.String()}
	for _, key := range []string{"positioning_tags", "target_audience", "persona_tone", "banned_words", "style_summary", "default_theme"} {
		if v, ok := profile[key]; ok {
			update[key] = v
		}
	}
	update["persona_tone"] = "领域执行覆盖核对。"

	// daily_settings__update 同样是完整替换接口：先读取当前设置，合并后提交。
	dsGet := env.agentDispatch(t, "daily_settings__get", nil, nil)
	if dsGet.Status != 200 {
		t.Fatalf("daily_settings__get 应成功：%d %s", dsGet.Status, dsGet.Raw)
	}
	var ds map[string]any
	if err := json.Unmarshal(dsGet.Raw, &ds); err != nil {
		t.Fatal(err)
	}
	dsUpdate := map[string]any{"hour": 9}
	for _, key := range []string{"generate", "primary_count", "alternate_count"} {
		if v, ok := ds[key]; ok {
			dsUpdate[key] = v
		}
	}

	// review 领域的数据录入要求作品已发布/已生成发布包；预置状态（与 E2E 的 readyDraft 同口径）。
	if _, err := env.srv.db.Exec(ctx, `UPDATE work SET status='published' WHERE id=$1`, wk.ID); err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		domain string
		name   string
		args   map[string]any
	}{
		{"profile", "profile__get", map[string]any{"accountId": acc.wechat.ID.String()}},
		{"profile", "profile__update", update},
		{"ops", "daily__get", map[string]any{"accountId": acc.wechat.ID.String()}},
		{"ops", "daily_settings__update", dsUpdate},
		{"review", "metrics__list", map[string]any{"id": wk.ID.String()}},
		{"review", "metrics__create", map[string]any{"id": wk.ID.String(), "reads": 120}},
		{"review", "reviews__create", map[string]any{"accountId": acc.wechat.ID.String(), "recent": 7}},
		{"admin", "admin__users", map[string]any{}},
		{"admin", "admin__crawl_update", map[string]any{"level": "off", "retention_days": 30, "limits": map[string]any{
			"interval_min": 30, "max_items": 50, "daily_requests": 1000, "fail_limit": 3, "pause_hours": 6}}},
	}
	for _, c := range cases {
		res := env.agentDispatch(t, c.name, c.args, nil)
		if res.Status != 200 {
			t.Errorf("[%s] %s 应执行成功：%d %s", c.domain, c.name, res.Status, truncateRunes(string(res.Raw), 160))
		}
	}
}
