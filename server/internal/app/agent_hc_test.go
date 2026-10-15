package app

// DEV-AG06 交付的 HC-26、HC-27、HC-29、HC-30（16 文档第 13.1 节）。

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/google/uuid"
)

// agentBusinessSnapshot 对业务表做「行数 + 内容哈希」快照（第 13.2 节第 11 项口径）。
// 排除 agent_* 与 ai_call、ai_job、audit_log 三张日志类表，以及第 14.2 节第 4 项的槽位表。
func agentBusinessSnapshot(t *testing.T) map[string]string {
	t.Helper()
	tables := []string{
		"platform_account", "workspace", "workspace_member", "workspace_invite",
		"work", "work_section", "work_version", "comic_panel",
		"topic", "material", "inbox_item", "asset",
		"check_run", "check_item", "push_record",
		"account_memory", "character_card", "style_sample", "sensitive_word", "metric_unmatched",
	}
	out := map[string]string{}
	for _, tb := range tables {
		var sig string
		q := fmt.Sprintf(`SELECT count(*)::text || ':' || coalesce(md5(string_agg(x::text, '|' ORDER BY x::text)), '') FROM %s x`, tb)
		if err := env.srv.db.QueryRow(context.Background(), q).Scan(&sig); err != nil {
			t.Fatalf("快照 %s：%v", tb, err)
		}
		out[tb] = sig
	}
	return out
}

// agentSweepArgs 为扫描测试生成最小参数：路径参数按条目路径解析到种子数据。
func agentSweepArgs(tool *AgentTool, workID, accountID, sectionID, itemID, assetID string) string {
	args := map[string]any{}
	for _, p := range tool.Params {
		if p.In != "path" {
			continue
		}
		switch {
		case strings.Contains(tool.Path, "/works/{id}"):
			args[p.Name] = workID
		case strings.Contains(tool.Path, "/sections/{id}"):
			args[p.Name] = sectionID
		case strings.Contains(tool.Path, "/check-items/{id}"):
			args[p.Name] = itemID
		case strings.Contains(tool.Path, "/accounts/{accountId}"):
			args[p.Name] = accountID
		case strings.Contains(tool.Path, "/assets/{id}"):
			args[p.Name] = assetID
		default:
			args[p.Name] = uuid.NewString()
		}
	}
	b, _ := json.Marshal(args)
	return string(b)
}

// 判据 HC-26（第 13.1 节）：模拟模型要求调用全部 W/H/X 工具时，运行只提出 pending 卡片，
// 业务表与模拟微信均不受影响；拒绝全部卡片后业务表仍不变。
func TestHC26_WriteToolsProposeCardsOnly(t *testing.T) {
	pid := env.ensureToolModel(t)
	acc := env.accounts(t)
	wk := env.readyWork(t, acc.wechat, "HC26 只提出卡片")
	defer agentDropWork(wk.ID)
	c := env.agentRunConversation(t, pid)
	defer deleteConversations(t, c.ID)

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

	before := agentBusinessSnapshot(t)
	wxBefore := len(env.mockWX.Calls())

	// 13 个领域每轮加载 3 个；每轮让模拟模型要求调用该批领域内的全部 W/H/X 工具。
	domains := agentDomainNames()
	cardIDs := []uuid.UUID{}
	for i := 0; i < len(domains); i += 3 {
		end := min(i+3, len(domains))
		batch := map[string]bool{}
		text := ""
		for _, d := range domains[i:end] {
			batch[d] = true
			text += agentLoadDomain(d) + "\n"
		}
		for _, tool := range agentCatalog() {
			if tool.Mutating() && batch[tool.Domain] {
				text += "#tool " + tool.Name + " " +
					agentSweepArgs(&tool, wk.ID.String(), acc.wechat.ID.String(), sectionID, itemID, assetID) + "\n"
			}
		}
		evs := env.sse(t, agentRunPath(c, "messages"), map[string]any{"text": text})
		for _, ev := range evs {
			if ev.Name != "action" {
				continue
			}
			var v agentActionView
			if err := json.Unmarshal(ev.Data, &v); err == nil && v.ID != uuid.Nil {
				cardIDs = append(cardIDs, v.ID)
			}
		}
	}
	if len(cardIDs) == 0 {
		t.Fatal("全部 W/H/X 工具应至少提出一张卡片")
	}

	after := agentBusinessSnapshot(t)
	for tb, sig := range before {
		if after[tb] != sig {
			t.Fatalf("只提出卡片时业务表 %s 不应变化：%s -> %s", tb, sig, after[tb])
		}
	}
	if got := len(env.mockWX.Calls()); got != wxBefore {
		t.Fatalf("只提出卡片时模拟微信不应收到请求：%d -> %d", wxBefore, got)
	}

	// 卡片全部为 pending，且没有执行过任何一张。
	var bad int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM agent_action WHERE conversation_id=$1 AND status <> 'pending'`, c.ID).Scan(&bad); err != nil {
		t.Fatal(err)
	}
	if bad != 0 {
		t.Fatalf("应只有 pending 卡片：%d 张非 pending", bad)
	}

	// 拒绝全部卡片后业务表仍不变。
	for _, id := range cardIDs {
		if st, body := env.do("POST", agentActionPath(id, "reject"), map[string]any{}); st != 200 {
			t.Fatalf("拒绝应成功：%d %s", st, body)
		}
	}
	final := agentBusinessSnapshot(t)
	for tb, sig := range before {
		if final[tb] != sig {
			t.Fatalf("拒绝全部卡片后业务表 %s 不应变化：%s -> %s", tb, sig, final[tb])
		}
	}
	if got := len(env.mockWX.Calls()); got != wxBefore {
		t.Fatalf("拒绝卡片后模拟微信不应收到请求：%d -> %d", wxBefore, got)
	}
}

// 判据 HC-27（第 13.1 节）：执行接口只接受单个卡片；/agent/actions 下只有两条路由；
// 并发、门槛与二次确认返回 409。
func TestHC27_ExecuteGuardsAndRoutes(t *testing.T) {
	// 路由静态检查。
	for _, r := range agentRouteList(env.srv.Router()) {
		if !strings.HasPrefix(r.Path, "/api/v1/agent/actions") {
			continue
		}
		if r.Method != "POST" || (r.Path != "/api/v1/agent/actions/{id}/execute" &&
			r.Path != "/api/v1/agent/actions/{id}/reject") {
			t.Fatalf("非法路由：%s %s", r.Method, r.Path)
		}
	}

	pid := env.ensureToolModel(t)
	acc := env.accounts(t)
	wk := env.readyWork(t, acc.wechat, "HC27 执行守卫")
	defer agentDropWork(wk.ID)
	c := env.agentRunConversation(t, pid)
	defer deleteConversations(t, c.ID)

	// 请求体为数组 → 400；包含多个卡片 ID（数组字段）→ 400。
	probe := "/api/v1/agent/actions/" + uuid.NewString() + "/execute"
	if st, _ := env.do("POST", probe, []map[string]any{{"confirm": true}}); st != 400 {
		t.Fatalf("数组请求体应 400：%d", st)
	}
	if st, _ := env.do("POST", probe, map[string]any{"confirm": true,
		"ids": []string{uuid.NewString(), uuid.NewString()}}); st != 400 {
		t.Fatalf("多个卡片 ID 应 400：%d", st)
	}

	// H 类缺 gate_ack → 409。
	evs := env.sse(t, agentRunPath(c, "messages"), map[string]any{"text": "完成检查\n" +
		agentLoadDomain("publish") + "\n#tool checks__complete {\"id\":\"" + wk.ID.String() + "\"}"})
	complete := findActionEvent(t, evs)
	if complete == nil {
		t.Fatal("应提出 checks__complete 卡片")
	}
	env.expectErr(t, "POST", agentActionPath(complete.ID, "execute"),
		map[string]any{"confirm": true}, "agent_gate_ack_required")

	// X 类缺二次确认 → 409；名称不符 → 409。
	evs2 := env.sse(t, agentRunPath(c, "messages"), map[string]any{"text": "删除账号\n" +
		agentLoadDomain("accounts") + "\n#tool accounts__delete {\"accountId\":\"" + acc.xhs.ID.String() + "\"}"})
	del := findActionEvent(t, evs2)
	if del == nil {
		t.Fatal("应提出 accounts__delete 卡片")
	}
	env.expectErr(t, "POST", agentActionPath(del.ID, "execute"),
		map[string]any{"confirm": true}, "agent_gate_ack_required")
	env.expectErr(t, "POST", agentActionPath(del.ID, "execute"),
		map[string]any{"confirm": true, "second_confirm": true, "confirm_text": "名称不对"},
		"agent_gate_ack_required")

	// 同一对话一张执行中 → 另一张 409。
	evs3 := env.sse(t, agentRunPath(c, "messages"), map[string]any{"text": agentLoadDomain("topics") + "\n#tool topics__create {\"accountId\":\"" + acc.wechat.ID.String() +
		"\",\"title\":\"HC27 第一张\",\"angle\":\"角度\"}" +
		"\n" + agentLoadDomain("materials") + "\n#tool inbox__create {\"content\":\"HC27 第二张\"}"})
	first, second := twoActions(t, evs3)
	if first == nil || second == nil {
		t.Fatal("应提出两张卡片")
	}
	if _, err := env.srv.db.Exec(context.Background(),
		`UPDATE agent_action SET status='executing' WHERE id=$1`, first.ID); err != nil {
		t.Fatal(err)
	}
	env.expectErr(t, "POST", agentActionPath(second.ID, "execute"),
		map[string]any{"confirm": true}, "agent_run_busy")
}

// 判据 HC-29（第 13.1 节）：观点只能来自用户原文；段落与素材写入使用非生成、非原文文字时拒绝。
func TestHC29_Provenance(t *testing.T) {
	pid := env.ensureToolModel(t)
	acc := env.accounts(t)
	wk := env.readyWork(t, acc.wechat, "HC29 来源约束")
	defer agentDropWork(wk.ID)
	c := env.agentRunConversation(t, pid)
	defer deleteConversations(t, c.ID)

	// 观点为用户消息原文：卡片预填。
	viewpoint := "秋天适合写一杯咖啡的温度"
	evs := env.sse(t, agentRunPath(c, "messages"), map[string]any{"text": "我的观点是：" + viewpoint + "\n" +
		agentLoadDomain("works") + "\n#tool works__set_viewpoint {\"id\":\"" + wk.ID.String() +
		"\",\"viewpoint\":\"" + viewpoint + "\"}"})
	action := findActionEvent(t, evs)
	if action == nil {
		t.Fatal("应提出观点卡片")
	}
	if len(action.BlankFields) != 0 {
		t.Fatalf("用户原文观点不应被清空：%+v", action.BlankFields)
	}
	if got := agentCardChangeValue(t, action, "viewpoint"); got != viewpoint {
		t.Fatalf("观点应预填用户原文：%q", got)
	}
	// 处理掉第一张卡片：同一目标、同一工具最多一张未结束卡片（第 5.5 节）。
	if st, body := env.do("POST", agentActionPath(action.ID, "reject"), map[string]any{}); st != 200 {
		t.Fatalf("拒绝第一张卡片应成功：%d %s", st, body)
	}

	// 观点为模型自拟：卡片中观点为空且不可执行。
	fake := agentEsc("智能体替你总结的核心观点")
	evs2 := env.sse(t, agentRunPath(c, "messages"), map[string]any{"text": "随便帮我写个观点\n" +
		agentLoadDomain("works") + "\n#tool works__set_viewpoint {\"id\":\"" + wk.ID.String() +
		"\",\"viewpoint\":\"" + fake + "\"}"})
	blanked := findActionEvent(t, evs2)
	if blanked == nil {
		t.Fatal("U 类字段失败也应提出卡片")
	}
	if len(blanked.BlankFields) == 0 || blanked.BlankFields[0] != "viewpoint" {
		t.Fatalf("自拟观点应清空：%+v", blanked.BlankFields)
	}
	// 清空字段未由用户填写前不能执行：缺门槛勾选与填写都不行（第 4.5 节）。
	env.expectErr(t, "POST", agentActionPath(blanked.ID, "execute"),
		map[string]any{"confirm": true}, "agent_gate_ack_required")
	env.expectErr(t, "POST", agentActionPath(blanked.ID, "execute"),
		map[string]any{"confirm": true, "gate_ack": true}, "agent_gate_ack_required")

	// 段落写入使用非生成、非用户原文的文字 → content_provenance_failed。
	fakeBody := agentEsc("模型自己编的段落正文")
	evs3 := env.sse(t, agentRunPath(c, "messages"), map[string]any{"text": "改一下这一段\n" +
		agentLoadDomain("writing") + "\n#tool sections__update {\"id\":\"" + wk.Sections[0].ID.String() +
		"\",\"content_md\":\"" + fakeBody + "\"}"})
	assertToolProvenanceFailed(t, evs3, c.ID, "sections__update")

	// 素材内容同理。
	fakeMaterial := agentEsc("模型编造的素材内容")
	evs4 := env.sse(t, agentRunPath(c, "messages"), map[string]any{"text": "存个素材\n" +
		agentLoadDomain("materials") + "\n#tool materials__create {\"content\":\"" + fakeMaterial +
		"\",\"kind\":\"opinion\"}"})
	assertToolProvenanceFailed(t, evs4, c.ID, "materials__create")
}

// assertToolProvenanceFailed 断言工具事件为错误且结果含 content_provenance_failed。
func assertToolProvenanceFailed(t *testing.T, evs []sseEvent, convID uuid.UUID, toolName string) {
	t.Helper()
	failed := false
	for _, ev := range evs {
		if ev.Name != "tool" {
			continue
		}
		var row struct {
			Name   string `json:"name"`
			Status string `json:"status"`
		}
		if err := json.Unmarshal(ev.Data, &row); err != nil {
			t.Fatal(err)
		}
		if row.Name == toolName && row.Status == "error" {
			failed = true
		}
	}
	if !failed {
		t.Fatalf("%s 的来源校验失败时 tool 事件应为 error", toolName)
	}
	var stored string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT content FROM agent_message WHERE conversation_id=$1 AND role='tool' ORDER BY seq DESC LIMIT 1`,
		convID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(stored, "content_provenance_failed") {
		t.Fatalf("工具结果应返回 content_provenance_failed：%s", stored)
	}
}

// 判据 HC-30（第 13.1 节）：密钥与一次性值不进入模型请求、消息与卡片；
// 需要再次输入密码的接口经分发器调用返回 reauth_required；疑似密钥消息 422 且不保存。
func TestHC30_Secrets(t *testing.T) {
	ctx := context.Background()
	me := env.me(t)
	wsID := uuid.MustParse(me.Workspace.ID)
	pid := env.ensureToolModel(t)
	acc := env.accounts(t)

	// 供应商密钥（种子已有）+ AppSecret + 邀请码（一次性值）均存在。
	env.reauth(t)
	appSecret := "hc30-app-secret-abcdef123456"
	env.mustJSON(t, "PUT", "/api/v1/accounts/"+acc.wechat.ID.String()+"/wechat-credential",
		map[string]string{"app_id": "wx-hc30-appid", "app_secret": appSecret}, nil)
	var invite struct {
		Code string `json:"code"`
	}
	env.mustJSON(t, "POST", "/api/v1/workspaces/current/invites",
		map[string]any{"role": "editor", "max_uses": 1, "days": 1}, &invite)
	if invite.Code == "" {
		t.Fatal("邀请码应创建")
	}

	secrets := []string{appSecret, invite.Code}
	for _, s := range env.srv.agentSecretValues(ctx, wsID) {
		if len(s) >= 8 {
			secrets = append(secrets, s)
		}
	}
	if len(secrets) < 2 {
		t.Fatal("应存在可脱敏的密钥")
	}

	c := env.agentRunConversation(t, pid)
	defer deleteConversations(t, c.ID)
	env.llm.ResetRequests()

	// 一轮读取与执行：读账号与模型（掩码）、提出并执行创建邀请卡片（一次性值只在 done 返回）。
	evs := env.sse(t, agentRunPath(c, "messages"), map[string]any{"text": agentLoadDomain("accounts") + "\n#tool accounts__list {}" +
		"\n" + agentLoadDomain("settings") + "\n#tool models__providers {}" +
		"\n" + agentLoadDomain("workspace") + "\n#tool workspace__create_invite {\"role\":\"editor\"}"})
	action := findActionEvent(t, evs)
	if action == nil {
		t.Fatal("应提出创建邀请卡片")
	}
	out := env.sse(t, agentActionPath(action.ID, "execute"), map[string]any{"confirm": true})
	done := lastEvent(t, out)
	var donePayload struct {
		SecretOnce map[string]any `json:"secret_once"`
	}
	if err := json.Unmarshal(done.Data, &donePayload); err != nil {
		t.Fatal(err)
	}
	if len(donePayload.SecretOnce) == 0 {
		t.Fatal("邀请码应通过 done.secret_once 一次性返回")
	}

	// 模型请求、agent_message、agent_action 均不得出现密钥原文。
	for _, req := range env.llm.Requests() {
		for _, s := range secrets {
			if strings.Contains(req, s) {
				t.Fatalf("模型请求不应包含密钥原文（%s）", s[:4]+"…")
			}
		}
	}
	rows, err := env.srv.db.Query(ctx,
		`SELECT content FROM agent_message WHERE conversation_id=$1`, c.ID)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var content string
		if err := rows.Scan(&content); err != nil {
			t.Fatal(err)
		}
		for _, s := range secrets {
			if strings.Contains(content, s) {
				t.Fatalf("agent_message 不应包含密钥原文（%s）", s[:4]+"…")
			}
		}
	}
	rows.Close()
	rows, err = env.srv.db.Query(ctx,
		`SELECT coalesce(params::text,'') || coalesce(preview::text,'') || coalesce(result::text,'')
		 FROM agent_action WHERE conversation_id=$1`, c.ID)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var blob string
		if err := rows.Scan(&blob); err != nil {
			t.Fatal(err)
		}
		for _, s := range secrets {
			if strings.Contains(blob, s) {
				t.Fatalf("agent_action 不应包含密钥原文（%s）", s[:4]+"…")
			}
		}
	}
	rows.Close()

	// 经分发器调用需要再次输入密码的接口 → reauth_required（第 2.3 节 ReauthOK 恒 false）。
	probe := &AgentTool{Name: "hc30_reauth_probe", Domain: "accounts", Kind: toolW,
		Method: "PUT", Path: "/accounts/{accountId}/wechat-credential",
		Params: []ToolParam{pPath("accountId")}}
	st := &agentRunState{SessionID: agentTestSessionID(t, uuid.MustParse(me.UserID)),
		WorkspaceID: wsID, ConversationID: c.ID, RunID: uuid.New()}
	res, derr := env.srv.dispatchAgentTool(ctx, agentDispatchRequest{
		Principal: agentPrincipal{SessionID: st.SessionID, WorkspaceID: st.WorkspaceID,
			ConversationID: st.ConversationID, RunID: st.RunID},
		Tool:    probe,
		Args:    map[string]any{"accountId": acc.wechat.ID.String()},
		Timeout: agentReadTimeout,
	})
	if derr != nil {
		t.Fatal(derr)
	}
	if res.Status != 403 || !strings.Contains(string(res.Raw), "reauth_required") {
		t.Fatalf("内部请求应返回 reauth_required：%d %s", res.Status, res.Raw)
	}

	// 含疑似密钥的用户消息 → 422 且不保存。
	var messagesBefore int
	if err := env.srv.db.QueryRow(ctx,
		`SELECT count(*) FROM agent_message WHERE conversation_id=$1`, c.ID).Scan(&messagesBefore); err != nil {
		t.Fatal(err)
	}
	ae := env.expectErr(t, "POST", agentRunPath(c, "messages"),
		map[string]any{"text": "帮我保存 sk-abcdefghijklmnopqrstuvwxyz0123"}, "validation_failed")
	if !strings.Contains(ae.Error.Message, "不要发给智能体") {
		t.Fatalf("提示文案错误：%s", ae.Error.Message)
	}
	var messagesAfter int
	if err := env.srv.db.QueryRow(ctx,
		`SELECT count(*) FROM agent_message WHERE conversation_id=$1`, c.ID).Scan(&messagesAfter); err != nil {
		t.Fatal(err)
	}
	if messagesAfter != messagesBefore {
		t.Fatal("被拒绝的消息不应保存")
	}
}
