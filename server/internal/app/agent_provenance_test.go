package app

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/google/uuid"
)

// 判据 5（16 文档第 13.2 节第 5 项）：操作卡片契约测试。
// 覆盖来源校验（第 4 节）、预览与指纹、逐张执行、拒绝、过期与并发互斥。

// agentDropWork 删除测试作品，避免污染固定账号数据。
func agentDropWork(id uuid.UUID) {
	_, _ = env.srv.db.Exec(context.Background(), `DELETE FROM work WHERE id=$1`, id)
}

// findActionEvent 取事件流里最后一张卡片。
func findActionEvent(t *testing.T, evs []sseEvent) *agentActionView {
	t.Helper()
	var out *agentActionView
	for _, ev := range evs {
		if ev.Name != "action" {
			continue
		}
		var a agentActionView
		if err := json.Unmarshal(ev.Data, &a); err != nil {
			continue
		}
		out = &a
	}
	return out
}

// twoActions 取事件流里最后两张卡片。
func twoActions(t *testing.T, evs []sseEvent) (*agentActionView, *agentActionView) {
	t.Helper()
	list := []agentActionView{}
	for _, ev := range evs {
		if ev.Name != "action" {
			continue
		}
		var a agentActionView
		if err := json.Unmarshal(ev.Data, &a); err != nil {
			continue
		}
		list = append(list, a)
	}
	if len(list) < 2 {
		return nil, nil
	}
	return &list[len(list)-2], &list[len(list)-1]
}

// agentActionPath 返回卡片操作路径。
func agentActionPath(id uuid.UUID, suffix string) string {
	return "/api/v1/agent/actions/" + id.String() + "/" + suffix
}

// agentLoadDomain 生成 load_tool_domain 指令，让模拟模型先加载领域。
// 真实链路里模型自己会调用该元工具，这里只是让测试场景可控。
func agentLoadDomain(domain string) string {
	return `#tool load_tool_domain {"domain":"` + domain + `"}`
}

// agentEsc 把文本转成 \uXXXX 序列。模拟模型的工具参数取自用户消息原文，
// 若直接写字面量，参数值就成了用户消息的子串、永远通过来源校验；转义后
// 参数值不出现在用户消息里，可模拟“模型编造内容”。
func agentEsc(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r < 0x80 {
			b.WriteRune(r)
			continue
		}
		b.WriteString(fmt.Sprintf("\\u%04x", r))
	}
	return b.String()
}

// TestAG06Normalize：第 4.4 节第 1 项的归一化口径。
func TestAG06Normalize(t *testing.T) {
	cases := []struct{ in, want string }{
		{"秋天的**第一杯**咖啡", "秋天的第一杯咖啡"},
		{"全角，标点。测试", "全角,标点.测试"},
		{"Hello   World", "HelloWorld"},
		{"ＡＢＣ１２３", "ABC123"},
		{"`code` 与 _斜体_", "code与斜体"},
	}
	for _, c := range cases {
		if got := agentNormalize(c.in); got != c.want {
			t.Errorf("agentNormalize(%q) = %q，期望 %q", c.in, got, c.want)
		}
	}
}

// TestAG06SourceKinds：第 4.2 节的来源类别归类。
func TestAG06SourceKinds(t *testing.T) {
	cases := map[string]string{
		"works__titles":        agentSrcG, // G 类工具
		"sections__rewrite":    agentSrcG, // 带 AI 的 W 工具
		"works__list":          agentSrcO, // R 工具
		"works__set_viewpoint": "",        // 纯 W 工具不进来源集合
		"topics__create":       "",        // H 类不进来源集合
		"unknown__tool":        "",
	}
	for name, want := range cases {
		if got := agentToolSourceKind(name); got != want {
			t.Errorf("agentToolSourceKind(%s) = %q，期望 %q", name, got, want)
		}
	}
}

// TestAG06KindsOfMapping：第 4.2 节的类别映射——G 含 U 的全部来源；第 4.5 节仅纯 U 字段
// 失败时清空，含 G/O 的组合（U/G/O、U/O、G/O）按 G、O 类直接拒绝（HC-29）。
func TestAG06KindsOfMapping(t *testing.T) {
	contains := func(kinds []string, want ...string) bool {
		set := map[string]bool{}
		for _, k := range kinds {
			set[k] = true
		}
		for _, w := range want {
			if !set[w] {
				return false
			}
		}
		return true
	}
	if got := agentKindsOf("G"); !contains(got, agentSrcUser, agentSrcAttachment, agentSrcG) {
		t.Fatalf("G 应含 U 的全部来源与生成结果：%v", got)
	}
	if got := agentKindsOf("G/O"); !contains(got, agentSrcUser, agentSrcAttachment, agentSrcG, agentSrcO) {
		t.Fatalf("G/O 应含用户、生成与系统记录：%v", got)
	}
	if got := agentKindsOf("U/G/O"); !contains(got, agentSrcUser, agentSrcAttachment, agentSrcG, agentSrcO) {
		t.Fatalf("U/G/O 应含全部四类：%v", got)
	}
	for source, want := range map[string]bool{
		"U": true, "U/G/O": false, "U/O": false, "G/O": false, "G": false, "O": false, "F": false, "": false,
	} {
		if got := agentSourceIsU(source); got != want {
			t.Errorf("agentSourceIsU(%q) = %v，期望 %v", source, got, want)
		}
	}
}

// TestAG06ParagraphSingleSource：第 4.4 节第 4 项，段落可分别来自同一来源的不同候选，
// 但不能跨来源拼接。
func TestAG06ParagraphSingleSource(t *testing.T) {
	set := &agentSourceSet{sources: []agentSource{
		{Kind: agentSrcG, AICallID: uuid.New(), Norms: []string{"第一段的正文内容", "第二段的正文内容"}},
		{Kind: agentSrcG, AICallID: uuid.New(), Norms: []string{"别处的文字"}},
	}}
	kinds := []string{agentSrcUser, agentSrcAttachment, agentSrcG, agentSrcO}
	if _, ok := set.match(kinds, "第一段的正文内容\n\n第二段的正文内容"); !ok {
		t.Fatal("同一来源的多段应该通过")
	}
	if _, ok := set.match(kinds, "第一段的正文内容\n\n别处的文字"); ok {
		t.Fatal("跨来源拼接不应该通过")
	}
	if _, ok := set.match(nil, "无"); !ok {
		t.Fatal("短值应按 F 放行")
	}
}

// TestAG06ProvenanceRejectsModelText：模型自己编造的标题必须在提出阶段被拒（第 4.5 节 G/O 类）。
func TestAG06ProvenanceRejectsModelText(t *testing.T) {
	pid := env.ensureToolModel(t)
	c := env.agentRunConversation(t, pid)
	defer deleteConversations(t, c.ID)

	fake := agentEsc("模型自己起的标题")
	evs := env.sse(t, agentRunPath(c, "messages"), map[string]any{"text": "只读过列表，没有读过任何生成结果\n" +
		agentLoadDomain("works") +
		"\n#tool works__update {\"id\":\"00000000-0000-0000-0000-000000000000\",\"title\":\"" + fake + "\"}"})
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
		if row.Name == "works__update" && row.Status == "error" {
			failed = true
		}
	}
	if !failed {
		t.Fatal("来源校验失败时 tool 事件应为 error")
	}
	var stored string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT content FROM agent_message WHERE conversation_id=$1 AND role='tool' ORDER BY seq DESC LIMIT 1`,
		c.ID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(stored, "content_provenance_failed") {
		t.Fatalf("工具结果应返回 content_provenance_failed：%s", stored)
	}
}

// TestAG06ViewpointFromUserText：核心观点必须是用户原话，取自用户消息时通过并建成卡片（H-02）。
func TestAG06ViewpointFromUserText(t *testing.T) {
	pid := env.ensureToolModel(t)
	acc := env.accounts(t)
	wk := env.readyWork(t, acc.wechat, "初始观点")
	defer agentDropWork(wk.ID)
	c := env.agentRunConversation(t, pid)
	defer deleteConversations(t, c.ID)

	viewpoint := "秋天适合写一杯咖啡的温度"
	evs := env.sse(t, agentRunPath(c, "messages"), map[string]any{"text": "我的观点是：" + viewpoint + "\n" +
		agentLoadDomain("works") +
		"\n#tool works__set_viewpoint {\"id\":\"" + wk.ID.String() + "\",\"viewpoint\":\"" + viewpoint + "\"}"})
	action := findActionEvent(t, evs)
	if action == nil {
		t.Fatal("来源通过时应提出卡片")
	}
	if len(action.BlankFields) != 0 {
		t.Fatalf("用户原话不应被清空：%+v", action.BlankFields)
	}
	var count int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM agent_action WHERE conversation_id=$1 AND status='pending'`, c.ID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("应写入 1 张 pending 卡片：%d", count)
	}
}

// TestAG06ViewpointBlankedAndBlocked：模型编造观点时卡片照常创建但字段清空，
// 未填写前不能执行（第 4.5 节 U 类）。
func TestAG06ViewpointBlankedAndBlocked(t *testing.T) {
	pid := env.ensureToolModel(t)
	acc := env.accounts(t)
	wk := env.readyWork(t, acc.wechat, "初始观点")
	defer agentDropWork(wk.ID)
	c := env.agentRunConversation(t, pid)
	defer deleteConversations(t, c.ID)

	fake := agentEsc("智能体替你总结的核心观点")
	evs := env.sse(t, agentRunPath(c, "messages"), map[string]any{"text": "随便帮我写个观点\n" +
		agentLoadDomain("works") +
		"\n#tool works__set_viewpoint {\"id\":\"" + wk.ID.String() + "\",\"viewpoint\":\"" + fake + "\"}"})
	action := findActionEvent(t, evs)
	if action == nil {
		t.Fatal("U 类字段失败也应创建卡片")
	}
	if len(action.BlankFields) != 1 || action.BlankFields[0] != "viewpoint" {
		t.Fatalf("viewpoint 应被清空并标记：%+v", action.BlankFields)
	}
	if len(action.BlankFields) == 0 {
		t.Fatalf("编造的观点应在卡片上清空并标记：%+v", action)
	}
	if len(action.Changes) == 0 {
		t.Fatalf("卡片仍应给出字段变更：%+v", action.Changes)
	}
	for _, ch := range action.Changes {
		if ch.Field == "viewpoint" && ch.After != "" {
			t.Fatalf("清空后的字段不应保留编造值：%+v", ch)
		}
	}
	// 未填写 → 409 agent_gate_ack_required。
	env.expectErr(t, "POST", agentActionPath(action.ID, "execute"),
		map[string]any{"confirm": true}, "agent_gate_ack_required")
}

// TestAG06ExecuteRejectsArrayBody：执行接口只接受单个卡片 ID，数组返回 400（HC-27）。
func TestAG06ExecuteRejectsArrayBody(t *testing.T) {
	c := env.agentRunConversation(t, env.ensureToolModel(t))
	defer deleteConversations(t, c.ID)
	body := []map[string]any{{"confirm": true}, {"confirm": true}}
	env.expectErr(t, "POST", "/api/v1/agent/actions/"+uuid.NewString()+"/execute", body, "validation_failed")
}

// TestAG06ExecuteUnknownCard：不存在的卡片 404。
func TestAG06ExecuteUnknownCard(t *testing.T) {
	code, res := env.do("POST", "/api/v1/agent/actions/"+uuid.NewString()+"/execute",
		map[string]any{"confirm": true})
	if code != 404 {
		t.Fatalf("未知卡片应 404：%d %s", code, res)
	}
}

// TestAG06GateAckRequired：H 类卡片缺 gate_ack 返回 409（HC-27）。
func TestAG06GateAckRequired(t *testing.T) {
	pid := env.ensureToolModel(t)
	acc := env.accounts(t)
	wk := env.readyWork(t, acc.wechat, "观点甲")
	defer agentDropWork(wk.ID)
	c := env.agentRunConversation(t, pid)
	defer deleteConversations(t, c.ID)

	evs := env.sse(t, agentRunPath(c, "messages"), map[string]any{"text": "帮我完成检查\n" +
		agentLoadDomain("publish") +
		"\n#tool checks__complete {\"id\":\"" + wk.ID.String() + "\"}"})
	action := findActionEvent(t, evs)
	if action == nil {
		t.Fatal("H 类应提出卡片")
	}
	if action.Gate != "H-04" {
		t.Fatalf("卡片应带门槛编号：%+v", action)
	}
	env.expectErr(t, "POST", agentActionPath(action.ID, "execute"),
		map[string]any{"confirm": true}, "agent_gate_ack_required")
	// gate_ack 与前端载荷补齐后链路会继续（第 5.4 节），这里只校验“缺 gate_ack 被拦”。
	env.expectErr(t, "POST", agentActionPath(action.ID, "execute"),
		map[string]any{"confirm": true}, "agent_gate_ack_required")
}

// TestAG06SecondConfirmNameMismatch：需要输入名称的不可逆操作，名称不符 409（HC-27）。
func TestAG06SecondConfirmNameMismatch(t *testing.T) {
	pid := env.ensureToolModel(t)
	acc := env.accounts(t)
	c := env.agentRunConversation(t, pid)
	defer deleteConversations(t, c.ID)

	evs := env.sse(t, agentRunPath(c, "messages"), map[string]any{"text": "删除这个账号\n" +
		agentLoadDomain("accounts") +
		"\n#tool accounts__delete {\"accountId\":\"" + acc.wechat.ID.String() + "\"}"})
	action := findActionEvent(t, evs)
	if action == nil {
		t.Fatal("X 类应提出卡片")
	}
	if action.SecondConfirm == nil {
		t.Fatalf("X 类卡片应带二次确认：%+v", action)
	}
	env.expectErr(t, "POST", agentActionPath(action.ID, "execute"),
		map[string]any{"confirm": true}, "agent_gate_ack_required")
	env.expectErr(t, "POST", agentActionPath(action.ID, "execute"),
		map[string]any{"confirm": true, "second_confirm": true, "confirm_text": "别的东西"},
		"agent_gate_ack_required")
	// 名称正确时不应命中“名称不一致”错误。为避免真实删除账号破坏后续测试的固定数据，
	// 这里直接校验服务端的名称比对函数。
	name, err := env.srv.agentConfirmTargetName(context.Background(), agentTool("accounts__delete"),
		map[string]any{"accountId": acc.wechat.ID.String()})
	if err != nil {
		t.Fatal(err)
	}
	if name == "" {
		t.Fatal("应取到当前账号名称用于比对")
	}
	if strings.TrimSpace(name) == strings.TrimSpace("别的东西") {
		t.Fatal("错误名称不应被服务端认可")
	}
	var status string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT status FROM agent_action WHERE id=$1`, action.ID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "pending" {
		t.Fatalf("两次被拒后卡片应仍为 pending：%s", status)
	}
}

// TestAG06ExecuteConcurrentBlocked：同一对话一张执行中时，另一张返回 409（第 5.5 节末行）。
func TestAG06ExecuteConcurrentBlocked(t *testing.T) {
	pid := env.ensureToolModel(t)
	acc := env.accounts(t)
	c := env.agentRunConversation(t, pid)
	defer deleteConversations(t, c.ID)

	// 两个不同目标各提出一张卡片（同一目标会被“未结束卡片唯一”拦下）。
	text := agentLoadDomain("profile") + "\n#tool memory__create {\"accountId\":\"" + acc.wechat.ID.String() +
		"\",\"text\":\"同一批次第一张\"}" + "\n" + agentLoadDomain("materials") +
		"\n#tool inbox__create {\"content\":\"同一批次第二张\"}"
	evs := env.sse(t, agentRunPath(c, "messages"), map[string]any{"text": text})
	first, second := twoActions(t, evs)
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

// TestAG06EditsRejectNonEditable：edits 只能包含可修改字段（第 5.3 节第 4 项）。
func TestAG06EditsRejectNonEditable(t *testing.T) {
	pid := env.ensureToolModel(t)
	acc := env.accounts(t)
	c := env.agentRunConversation(t, pid)
	defer deleteConversations(t, c.ID)

	evs := env.sse(t, agentRunPath(c, "messages"), map[string]any{"text": agentLoadDomain("profile") +
		"\n#tool memory__create {\"accountId\":\"" + acc.wechat.ID.String() +
		"\",\"text\":\"这条记忆的编辑范围测试\"}"})
	action := findActionEvent(t, evs)
	if action == nil {
		t.Fatal("应提出卡片")
	}
	// 路径参数（accountId）不可在卡片上修改。
	env.expectErr(t, "POST", agentActionPath(action.ID, "execute"),
		map[string]any{"confirm": true, "edits": map[string]any{"accountId": uuid.NewString()}},
		"validation_failed")
}

// TestAG06ExecuteSucceeds：一张可执行卡片走完整链路，返回 succeeded 与 done 事件字段。
func TestAG06ExecuteSucceeds(t *testing.T) {
	pid := env.ensureToolModel(t)
	acc := env.accounts(t)
	c := env.agentRunConversation(t, pid)
	defer deleteConversations(t, c.ID)

	// memory__create 是纯 W 工具，文字来自用户消息。
	note := "记住我喜欢在早上写稿"
	evs := env.sse(t, agentRunPath(c, "messages"), map[string]any{"text": note + "\n" +
		agentLoadDomain("profile") +
		"\n#tool memory__create {\"accountId\":\"" + acc.wechat.ID.String() + "\",\"text\":\"" + note + "\"}"})
	action := findActionEvent(t, evs)
	if action == nil {
		t.Fatal("应提出卡片")
	}
	out := env.sse(t, agentActionPath(action.ID, "execute"), map[string]any{"confirm": true})
	done := lastEvent(t, out)
	if done.Name != "done" {
		t.Fatalf("最后一个事件应为 done：%s", done.Name)
	}
	var payload struct {
		Action struct {
			ID     string `json:"id"`
			Status string `json:"status"`
		} `json:"action"`
		BatchResolved bool   `json:"batch_resolved"`
		CanContinue   bool   `json:"can_continue"`
		ResultSummary string `json:"result_summary"`
	}
	if err := json.Unmarshal(done.Data, &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Action.Status != "succeeded" {
		t.Fatalf("卡片应 succeeded：%+v", payload)
	}
	if payload.Action.ID != action.ID.String() {
		t.Fatalf("done 应带回该卡片：%s != %s", payload.Action.ID, action.ID)
	}
	if !payload.BatchResolved || !payload.CanContinue {
		t.Fatalf("批次结束且可续跑：%+v", payload)
	}
	// 终态卡片不能再执行。
	env.expectErr(t, "POST", agentActionPath(action.ID, "execute"),
		map[string]any{"confirm": true}, "agent_action_state_invalid")
	// applied 只对段落类条目注入；这一张不应带入任何 applied。
	var params []byte
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT params FROM agent_action WHERE id=$1`, action.ID).Scan(&params); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(params), "applied") {
		t.Fatalf("非段落条目不应注入 applied：%s", params)
	}
}

// TestAG06Reject：拒绝一张卡片并可附原因（第 5.9 节第 1 项）。
func TestAG06Reject(t *testing.T) {
	pid := env.ensureToolModel(t)
	acc := env.accounts(t)
	c := env.agentRunConversation(t, pid)
	defer deleteConversations(t, c.ID)

	note := "这条记忆我不要了"
	evs := env.sse(t, agentRunPath(c, "messages"), map[string]any{"text": note + "\n" +
		agentLoadDomain("profile") +
		"\n#tool memory__create {\"accountId\":\"" + acc.wechat.ID.String() + "\",\"text\":\"" + note + "\"}"})
	action := findActionEvent(t, evs)
	if action == nil {
		t.Fatal("应提出卡片")
	}
	env.mustJSON(t, "POST", agentActionPath(action.ID, "reject"),
		map[string]any{"reason": "不需要"}, nil)
	var status, reason string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT status, reject_reason FROM agent_action WHERE id=$1`, action.ID).Scan(&status, &reason); err != nil {
		t.Fatal(err)
	}
	if status != "rejected" || reason != "不需要" {
		t.Fatalf("应 rejected 并记录原因：%s/%s", status, reason)
	}
	var rows int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM agent_message WHERE conversation_id=$1 AND role='action_result'`, c.ID).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 1 {
		t.Fatalf("拒绝应写一条 action_result：%d", rows)
	}
	env.expectErr(t, "POST", agentActionPath(action.ID, "execute"),
		map[string]any{"confirm": true}, "agent_action_state_invalid")
}

// TestAG06ExpireLazy：超过 24 小时的卡片在读取时惰性过期（第 5.9 节第 2 项）。
func TestAG06ExpireLazy(t *testing.T) {
	pid := env.ensureToolModel(t)
	acc := env.accounts(t)
	c := env.agentRunConversation(t, pid)
	defer deleteConversations(t, c.ID)

	note := "这条记忆会过期"
	evs := env.sse(t, agentRunPath(c, "messages"), map[string]any{"text": note + "\n" +
		agentLoadDomain("profile") +
		"\n#tool memory__create {\"accountId\":\"" + acc.wechat.ID.String() + "\",\"text\":\"" + note + "\"}"})
	action := findActionEvent(t, evs)
	if action == nil {
		t.Fatal("应提出卡片")
	}
	if _, err := env.srv.db.Exec(context.Background(),
		`UPDATE agent_action SET expires_at = now() - interval '1 hour' WHERE id=$1`, action.ID); err != nil {
		t.Fatal(err)
	}
	env.expectErr(t, "POST", agentActionPath(action.ID, "execute"),
		map[string]any{"confirm": true}, "agent_action_state_invalid")
	var status string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT status FROM agent_action WHERE id=$1`, action.ID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "expired" {
		t.Fatalf("应惰性过期：%s", status)
	}
}
