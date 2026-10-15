package app

// DEV-AG06 卡片契约补齐的测试（16 文档第 5.2、5.4、5.6、5.9、11.3 节）：
// H-03/H-04/H-05/H-09 卡片的完整预览、平铺 client_payload、推送 need_choice 事件与拒绝返回。

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/google/uuid"
)

// agentCardChangeValue 取卡片差异中某字段的 after 文本。
func agentCardChangeValue(t *testing.T, action *agentActionView, field string) string {
	t.Helper()
	for _, ch := range action.Changes {
		if ch.Field == field {
			return ch.After
		}
	}
	return ""
}

// agentCardParams 读取卡片的冻结参数。
func agentCardParams(t *testing.T, id uuid.UUID) map[string]any {
	t.Helper()
	var raw []byte
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT params FROM agent_action WHERE id=$1`, id).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	_ = json.Unmarshal(raw, &out)
	return out
}

// agentCardFingerprint 读取卡片的指纹。
func agentCardFingerprint(t *testing.T, id uuid.UUID) string {
	t.Helper()
	var fp string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT fingerprint FROM agent_action WHERE id=$1`, id).Scan(&fp); err != nil {
		t.Fatal(err)
	}
	return fp
}

// 判据 1（第 5.6 节 H-03）：大纲确认卡片展示完整大纲，并冻结提出时的修订号。
func TestAG06ContractOutlineConfirm(t *testing.T) {
	pid := env.ensureToolModel(t)
	acc := env.accounts(t)
	wk := env.readyWork(t, acc.wechat, "大纲确认观点")
	defer agentDropWork(wk.ID)
	c := env.agentRunConversation(t, pid)
	defer deleteConversations(t, c.ID)

	evs := env.sse(t, agentRunPath(c, "messages"), map[string]any{"text": agentLoadDomain("writing") + "\n#tool outline__confirm {\"id\":\"" + wk.ID.String() + "\"}"})
	action := findActionEvent(t, evs)
	if action == nil {
		t.Fatal("应提出 outline__confirm 卡片")
	}
	var work struct {
		Outline []OutlineItem `json:"outline"`
	}
	env.mustJSON(t, "GET", "/api/v1/works/"+wk.ID.String(), nil, &work)
	if len(work.Outline) == 0 {
		t.Fatal("前置作品应有大纲")
	}
	items := agentCardChangeValue(t, action, "items")
	if !strings.Contains(items, work.Outline[0].Heading) {
		t.Fatalf("卡片应完整展示大纲：%q 缺少 %q", items, work.Outline[0].Heading)
	}
	if _, ok := agentCardParams(t, action.ID)["base_revision"]; !ok {
		t.Fatalf("提出时应冻结 base_revision：%+v", agentCardParams(t, action.ID))
	}

	// 执行：以当前大纲 + 冻结修订号确认，生成段落。
	env.sse(t, agentActionPath(action.ID, "execute"), map[string]any{"confirm": true, "gate_ack": true})
	var sections int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM work_section WHERE work_id=$1`, wk.ID).Scan(&sections); err != nil {
		t.Fatal(err)
	}
	if sections == 0 {
		t.Fatal("确认后应生成段落")
	}
}

// 判据 2（第 5.6 节 H-03）：分镜确认卡片展示完整分镜，提出后被修改则 stale。
func TestAG06ContractStoryboardConfirm(t *testing.T) {
	pid := env.ensureToolModel(t)
	acc := env.accounts(t)
	wk := env.readyWork(t, acc.wechat, "分镜确认观点")
	defer agentDropWork(wk.ID)
	if _, err := env.srv.db.Exec(context.Background(),
		`UPDATE work SET content_format='comic' WHERE id=$1`, wk.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(context.Background(), `INSERT INTO comic_panel
		(work_id, position, scene, character_ids, action, shot, narration, dialogue, image_prompt)
		VALUES ($1,1,'客厅','{}','倒咖啡','近景','旁白一','台词一','提示一'), ($1,2,'窗边','{}','看窗外','远景','旁白二','','提示二')`, wk.ID); err != nil {
		t.Fatal(err)
	}
	c := env.agentRunConversation(t, pid)
	defer deleteConversations(t, c.ID)

	evs := env.sse(t, agentRunPath(c, "messages"), map[string]any{"text": agentLoadDomain("writing") + "\n#tool storyboard__confirm {\"id\":\"" + wk.ID.String() + "\"}"})
	action := findActionEvent(t, evs)
	if action == nil {
		t.Fatal("应提出 storyboard__confirm 卡片")
	}
	if !strings.Contains(agentCardChangeValue(t, action, "panels"), "倒咖啡") {
		t.Fatalf("卡片应完整展示分镜：%+v", action.Changes)
	}
	if agentCardFingerprint(t, action.ID) == "" {
		t.Fatal("分镜卡片应带指纹（提出后被修改则 stale）")
	}

	// 执行：以当前分镜 + confirm 保存。
	out := env.sse(t, agentActionPath(action.ID, "execute"), map[string]any{"confirm": true, "gate_ack": true})
	if lastEvent(t, out).Name != "done" {
		t.Fatalf("执行应以 done 结束")
	}
	var panels int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM comic_panel WHERE work_id=$1`, wk.ID).Scan(&panels); err != nil {
		t.Fatal(err)
	}
	if panels != 2 {
		t.Fatalf("确认后分镜应为 2 格：%d", panels)
	}
}

// 判据 3（第 5.6 节 H-03）：整理结果卡片展示整理全文，执行时由分发器从工具结果读取 markdown。
func TestAG06ContractOrganizeApply(t *testing.T) {
	pid := env.ensureToolModel(t)
	acc := env.accounts(t)
	wk := env.readyWork(t, acc.wechat, "整理应用观点")
	defer agentDropWork(wk.ID)
	c := env.agentRunConversation(t, pid)
	defer deleteConversations(t, c.ID)

	callID := "call_organize_1"
	markdown := "## 第一段\n整理后的正文一。\n\n## 第二段\n整理后的正文二。"
	doneJSON, _ := json.Marshal(map[string]any{"text": markdown, "ai_call_id": uuid.NewString()})
	if _, err := env.srv.db.Exec(context.Background(), `INSERT INTO agent_message
		(conversation_id, seq, role, content, tool_call_id, tool_name)
		VALUES ($1, 1, 'tool', $2, $3, 'organize_notes')`, c.ID, doneJSON, callID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(context.Background(),
		`UPDATE agent_conversation SET next_seq = greatest(next_seq, 2) WHERE id=$1`, c.ID); err != nil {
		t.Fatal(err)
	}

	evs := env.sse(t, agentRunPath(c, "messages"), map[string]any{"text": agentLoadDomain("writing") + "\n#tool works__organize_apply {\"id\":\"" + wk.ID.String() +
		"\",\"source_tool_call_id\":\"" + callID + "\"}"})
	action := findActionEvent(t, evs)
	if action == nil {
		t.Fatal("应提出 works__organize_apply 卡片")
	}
	if !strings.Contains(agentCardChangeValue(t, action, "items"), "整理后的正文一") {
		t.Fatalf("卡片应展示整理结果：%+v", action.Changes)
	}

	out := env.sse(t, agentActionPath(action.ID, "execute"),
		map[string]any{"confirm": true, "gate_ack": true, "second_confirm": true})
	if lastEvent(t, out).Name != "done" {
		t.Fatal("执行应以 done 结束")
	}
	var headings []string
	rows, err := env.srv.db.Query(context.Background(),
		`SELECT heading FROM work_section WHERE work_id=$1 ORDER BY position`, wk.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var h string
		if err := rows.Scan(&h); err != nil {
			t.Fatal(err)
		}
		headings = append(headings, h)
	}
	if len(headings) != 2 || headings[0] != "第一段" || headings[1] != "第二段" {
		t.Fatalf("整理结果应写入段落：%v", headings)
	}
}

// 判据 4（第 5.6 节 H-04）：检查项卡片显示类别、命中文字与建议；完成卡片显示通过数与总数。
func TestAG06ContractChecksPreviews(t *testing.T) {
	pid := env.ensureToolModel(t)
	acc := env.accounts(t)
	wk := env.readyWork(t, acc.wechat, "检查预览观点")
	defer agentDropWork(wk.ID)
	run := env.latestCheck(t, wk.ID.String())
	if run == nil || len(run.Items) == 0 {
		t.Fatal("前置检查应存在检查项")
	}
	item := run.Items[0]
	c := env.agentRunConversation(t, pid)
	defer deleteConversations(t, c.ID)

	evs := env.sse(t, agentRunPath(c, "messages"), map[string]any{"text": agentLoadDomain("publish") + "\n#tool checks__resolve_item {\"id\":\"" + item.ID.String() + "\"}"})
	action := findActionEvent(t, evs)
	if action == nil {
		t.Fatal("应提出 checks__resolve_item 卡片")
	}
	if agentCardChangeValue(t, action, "category") != item.Category {
		t.Fatalf("卡片应返回检查类别：%+v", action.Changes)
	}
	if agentCardChangeValue(t, action, "matched_text") != item.MatchedText {
		t.Fatalf("卡片应返回命中文字：%+v", action.Changes)
	}
	if agentCardChangeValue(t, action, "message") != item.Message {
		t.Fatalf("卡片应返回建议：%+v", action.Changes)
	}

	evs2 := env.sse(t, agentRunPath(c, "messages"), map[string]any{"text": agentLoadDomain("publish") + "\n#tool checks__complete {\"id\":\"" + wk.ID.String() + "\"}"})
	action2 := findActionEvent(t, evs2)
	if action2 == nil {
		t.Fatal("应提出 checks__complete 卡片")
	}
	if agentCardChangeValue(t, action2, "total") == "" {
		t.Fatalf("完成卡片应返回总数：%+v", action2.Changes)
	}
	if agentCardChangeValue(t, action2, "passed") == "" {
		t.Fatalf("完成卡片应返回通过数：%+v", action2.Changes)
	}
}

// 判据 5（第 5.6 节 H-05）：推送卡片显示标题、封面、摘要、图片数、今日次数与草稿状态。
func TestAG06ContractPushPreview(t *testing.T) {
	pid := env.ensureToolModel(t)
	acc := env.accounts(t)
	wk := env.readyWork(t, acc.wechat, "推送预览观点")
	defer agentDropWork(wk.ID)
	c := env.agentRunConversation(t, pid)
	defer deleteConversations(t, c.ID)

	evs := env.sse(t, agentRunPath(c, "messages"), map[string]any{"text": agentLoadDomain("publish") + "\n#tool wechat__push {\"id\":\"" + wk.ID.String() + "\"}"})
	action := findActionEvent(t, evs)
	if action == nil {
		t.Fatal("应提出 wechat__push 卡片")
	}
	for _, field := range []string{"title", "summary", "cover", "images", "today", "draft"} {
		if agentCardChangeValue(t, action, field) == "" {
			t.Fatalf("推送卡片缺少 %s 预览：%+v", field, action.Changes)
		}
	}
	editable := false
	for _, f := range action.EditableFields {
		if f == "fields" {
			editable = true
		}
	}
	if !editable {
		t.Fatalf("推送设置应可修改：%+v", action.EditableFields)
	}
	if _, ok := agentCardParams(t, action.ID)["fields"]; !ok {
		t.Fatalf("提出时应冻结推送设置默认值：%+v", agentCardParams(t, action.ID))
	}
}

// 判据 6（第 5.6 节 H-09）：审阅卡片显示最近检查摘要。
func TestAG06ContractApproveReviewPreview(t *testing.T) {
	pid := env.ensureToolModel(t)
	acc := env.accounts(t)
	wk := env.readyWork(t, acc.wechat, "审阅预览观点")
	defer agentDropWork(wk.ID)
	c := env.agentRunConversation(t, pid)
	defer deleteConversations(t, c.ID)

	evs := env.sse(t, agentRunPath(c, "messages"), map[string]any{"text": agentLoadDomain("publish") + "\n#tool works__approve_review {\"id\":\"" + wk.ID.String() + "\"}"})
	action := findActionEvent(t, evs)
	if action == nil {
		t.Fatal("应提出 works__approve_review 卡片")
	}
	if agentCardChangeValue(t, action, "check_summary") == "" {
		t.Fatalf("审阅卡片应返回最近检查摘要：%+v", action.Changes)
	}
}

// 判据 7（第 5.2、5.4 节）：sections__update 冻结提出时的段落修订号。
func TestAG06ContractSectionUpdateRevision(t *testing.T) {
	pid := env.ensureToolModel(t)
	acc := env.accounts(t)
	wk := env.readyWork(t, acc.wechat, "段落修订观点")
	defer agentDropWork(wk.ID)
	if len(wk.Sections) == 0 {
		t.Fatal("前置作品应有段落")
	}
	section := wk.Sections[0]
	c := env.agentRunConversation(t, pid)
	defer deleteConversations(t, c.ID)

	// content_md 是 G/O 来源：先写入一条工具结果，供来源校验命中。
	if _, err := env.srv.db.Exec(context.Background(), `INSERT INTO agent_message
		(conversation_id, seq, role, content, tool_call_id, tool_name)
		VALUES ($1, 1, 'tool', '修订后的正文内容', 'call_draft_1', 'sections__draft')`, c.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(context.Background(),
		`UPDATE agent_conversation SET next_seq = greatest(next_seq, 2) WHERE id=$1`, c.ID); err != nil {
		t.Fatal(err)
	}

	evs := env.sse(t, agentRunPath(c, "messages"), map[string]any{"text": agentLoadDomain("writing") + "\n#tool sections__update {\"id\":\"" + section.ID.String() +
		"\",\"content_md\":\"修订后的正文内容\"}"})
	action := findActionEvent(t, evs)
	if action == nil {
		t.Fatal("应提出 sections__update 卡片")
	}
	if _, ok := agentCardParams(t, action.ID)["base_revision"]; !ok {
		t.Fatalf("提出时应冻结段落修订号：%+v", agentCardParams(t, action.ID))
	}
}

// 判据 8（第 11.3 节）：client_payload 是平铺字段；wechat_html 至少需要 revision。
func TestAG06ContractClientPayloadFlat(t *testing.T) {
	// 需要载荷的条目：载荷缺省 → 422。
	push := agentTool("wechat__push")
	if err := agentCheckClientPayload(push, nil); err == nil {
		t.Fatal("缺少载荷应 422")
	}
	// 平铺 {revision} → 通过；{wechat_html: {...}} 的嵌套形状不再被接受。
	if err := agentCheckClientPayload(push, map[string]any{"revision": float64(3)}); err != nil {
		t.Fatalf("平铺载荷应通过：%v", err)
	}
	if err := agentCheckClientPayload(push, map[string]any{"html": "…"}); err == nil {
		t.Fatal("wechat_html 缺少 revision 应 422")
	}
	// checks__start 的载荷允许为空对象（漫画/卡片作品只提交 revision）。
	start := agentTool("checks__start")
	if err := agentCheckClientPayload(start, map[string]any{}); err != nil {
		t.Fatalf("空载荷应通过：%v", err)
	}
	// 不需要载荷的条目不受影响。
	if err := agentCheckClientPayload(agentTool("works__update"), nil); err != nil {
		t.Fatalf("无载荷条目应通过：%v", err)
	}
}

// 判据 9（第 5.3 节第 2 项）：推送接口以 need_choice 事件表达草稿缺失/被修改。
func TestAG06ContractPushNeedChoiceEvents(t *testing.T) {
	missing := &agentDispatchResult{Status: 200, Events: []agentSSEEvent{
		{Event: "step", Data: json.RawMessage(`{"name":"check_backend"}`)},
		{Event: "need_choice", Data: json.RawMessage(`{"reason":"missing","message":"原草稿已不在草稿箱"}`)},
	}}
	kind, need := agentNeedKind(missing)
	if kind != "draft_missing" || need["kind"] != "draft_missing" {
		t.Fatalf("缺失草稿应 draft_missing：%s %+v", kind, need)
	}
	modified := &agentDispatchResult{Status: 200, Events: []agentSSEEvent{
		{Event: "need_choice", Data: json.RawMessage(`{"reason":"modified","message":"草稿被修改过"}`)},
	}}
	if kind, _ := agentNeedKind(modified); kind != "draft_modified" {
		t.Fatalf("草稿被修改应 draft_modified：%s", kind)
	}
	over := &agentDispatchResult{Status: 409, Raw: []byte(`{"error":{"code":"push_limit_reached","message":"超限"}}`)}
	if kind, _ := agentNeedKind(over); kind != "over_limit" {
		t.Fatalf("超限应 over_limit：%s", kind)
	}
	plain := &agentDispatchResult{Status: 200, Events: []agentSSEEvent{{Event: "step", Data: json.RawMessage(`{}`)}}}
	if kind, _ := agentNeedKind(plain); kind != "" {
		t.Fatalf("普通成功不应判定 needs_input：%s", kind)
	}
}

// 判据 10（第 5.9 节、第 6.4 节）：拒绝接口返回批次与续跑状态。
func TestAG06ContractRejectReturnsContinue(t *testing.T) {
	pid := env.ensureToolModel(t)
	c := env.agentRunConversation(t, pid)
	defer deleteConversations(t, c.ID)

	note := "这条记忆我先不要"
	evs := env.sse(t, agentRunPath(c, "messages"), map[string]any{"text": note +
		"\n" + agentLoadDomain("profile") + "\n#tool memory__create {\"accountId\":\"" +
		env.accounts(t).wechat.ID.String() + "\",\"text\":\"" + note + "\"}"})
	action := findActionEvent(t, evs)
	if action == nil {
		t.Fatal("应提出卡片")
	}
	st, body := env.do("POST", agentActionPath(action.ID, "reject"), map[string]any{"reason": "不需要"})
	if st != 200 {
		t.Fatalf("拒绝应成功：%d %s", st, body)
	}
	var payload struct {
		OK            bool `json:"ok"`
		BatchResolved bool `json:"batch_resolved"`
		CanContinue   bool `json:"can_continue"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatal(err)
	}
	if !payload.OK || !payload.BatchResolved || !payload.CanContinue {
		t.Fatalf("拒绝响应应带批次与续跑状态：%s", body)
	}
}

// 判据 11（第 5.7 节、第 11.2 节）：二次确认的输入对象类型以 type_name 序列化。
func TestAG06ContractSecondConfirmTypeName(t *testing.T) {
	pid := env.ensureToolModel(t)
	acc := env.accounts(t)
	c := env.agentRunConversation(t, pid)
	defer deleteConversations(t, c.ID)

	evs := env.sse(t, agentRunPath(c, "messages"), map[string]any{"text": "删除这个账号\n" +
		agentLoadDomain("accounts") + "\n#tool accounts__delete {\"accountId\":\"" + acc.wechat.ID.String() + "\"}"})
	action := findActionEvent(t, evs)
	if action == nil {
		t.Fatal("应提出 accounts__delete 卡片")
	}
	second, ok := action.SecondConfirm.(map[string]any)
	if !ok {
		t.Fatalf("二次确认应为对象：%+v", action.SecondConfirm)
	}
	if second["type_name"] != "account_name" {
		t.Fatalf("二次确认类型应为 type_name=account_name：%+v", second)
	}
}
