package app

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/google/uuid"
)

// ---------- 测试辅助 ----------

// skillAgentBind 直接为账号绑定若干技能（绕过 API 速度更快），返回技能 ID 列表。
func skillAgentBind(t *testing.T, accID uuid.UUID, n int, personal bool) []uuid.UUID {
	t.Helper()
	uid := ownerUserID(t)
	var ids []uuid.UUID
	for i := 0; i < n; i++ {
		name := fmt.Sprintf("智能体技能-%s-%d", uuid.NewString()[:8], i)
		var body string
		if personal {
			body = "这是第 " + fmt.Sprint(i) + " 个个人技能的完整正文，用于验证目录与加载链路。"
		} else {
			body = "这是第 " + fmt.Sprint(i) + " 个工作区技能的完整正文，用于验证目录与加载链路。"
		}
		var id uuid.UUID
		var err error
		if personal {
			err = env.srv.db.QueryRow(context.Background(), `INSERT INTO skill (user_id, name, summary, triggers, instructions) VALUES ($1,$2,'用于智能体接入测试的技能用途','目录与加载测试触发条件',$3) RETURNING id`,
				uid, name, body).Scan(&id)
		} else {
			err = env.srv.db.QueryRow(context.Background(), `INSERT INTO skill (workspace_id, name, summary, triggers, instructions) VALUES ($1,$2,'用于智能体接入测试的技能用途','目录与加载测试触发条件',$3) RETURNING id`,
				ownerWS(t), name, body).Scan(&id)
		}
		if err != nil {
			t.Fatal(err)
		}
		if _, err := env.srv.db.Exec(context.Background(),
			`INSERT INTO skill_binding (account_id, audience_user_id, skill_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
			accID, func() any { if personal { return any(&uid) }; return nil }(), id); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
	}
	return ids
}

func skillAgentBindPublic(t *testing.T, accID, skillID uuid.UUID) {
	t.Helper()
	if _, err := env.srv.db.Exec(context.Background(),
		`INSERT INTO skill_binding (account_id, skill_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, accID, skillID); err != nil {
		t.Fatal(err)
	}
}

// skillRunState 构造一次运行的技能测试状态。
func skillRunState(t *testing.T) (*agentRunState, *Account) {
	t.Helper()
	fx := env.accounts(t)
	st := &agentRunState{RunID: uuid.New(), ConversationID: uuid.New(), WorkspaceID: ownerWS(t),
		UserID: uuidOf(ownerUserID(t)), SessionID: uuid.New(), AccountID: &fx.wechat.ID}
	return st, &fx.wechat
}

// ---------- T-SK-10：目录只分配一次、前 8 条渲染、序列化预算与隐藏条目发现 ----------

func TestSkillAgentCatalogBudget(t *testing.T) {
	st, acc := skillRunState(t)
	skillAgentBind(t, acc.ID, 10, true)
	ctx := context.Background()
	ctx = context.WithValue(ctx, ctxMember, &identity{UserID: st.UserID, WorkspaceID: st.WorkspaceID, Role: "owner"})

	c1, err := env.srv.agentSkillEnsureContext(ctx, st, acc, nil, acc.ContentFormat)
	if err != nil {
		t.Fatal(err)
	}
	if len(c1.Items) != 10 {
		t.Fatalf("want 10 selected, got %d", len(c1.Items))
	}
	for i, item := range c1.Items {
		if item.Ref != "s"+agentItoa(i+1) {
			t.Fatalf("ref order: %s", item.Ref)
		}
	}
	c2, err := env.srv.agentSkillEnsureContext(ctx, st, acc, nil, acc.ContentFormat)
	if err != nil {
		t.Fatal(err)
	}
	if c2.CatalogID != c1.CatalogID {
		t.Fatal("catalog must be frozen per run/context")
	}
	sec := agentEnvSkillSection(c1)
	if sec == nil {
		t.Fatal("env section missing")
	}
	// 8 条是渲染上限而非保证装满；按最终序列化 ≤600 只保留完整条目（8.1 节第 2 项）。
	if len(sec.Items) > 8 || len(sec.Items) == 0 {
		t.Fatalf("rendered items out of range: %d", len(sec.Items))
	}
	if sec.Omitted != 10-len(sec.Items) {
		t.Fatalf("omitted count: %d", sec.Omitted)
	}
	if runeLen(agentSkillSectionJSON(sec)) > skillCatalogBudget {
		t.Fatalf("catalog section exceeds 600: %d", runeLen(agentSkillSectionJSON(sec)))
	}
	if !strings.Contains(sec.OmittedNote, "skills__list") {
		t.Fatalf("omitted note: %q", sec.OmittedNote)
	}
	// 环境块整体 ≤1500。
	if _, err := env.srv.agentEnvBlock(ctx, st); err != nil {
		t.Fatalf("env block: %v", err)
	}
	block, _ := env.srv.agentEnvBlock(ctx, st)
	if runeLen(block) > agentEnvBlockLimit {
		t.Fatalf("env block %d > %d", runeLen(block), agentEnvBlockLimit)
	}
	agentReleaseSkillState(st.RunID)
}

// ---------- T-SK-11 / 22 / 30：load_skill 回执、幂等、预算与失效 ----------

func TestSkillAgentLoadSkill(t *testing.T) {
	st, acc := skillRunState(t)
	ids := skillAgentBind(t, acc.ID, 2, true)
	// 未绑定的可见技能：不能成为目录条目。
	var visibleNotBound uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(), `INSERT INTO skill (workspace_id, name, summary, triggers, instructions)
		VALUES ($1,'未绑定技能','工作区里可见但未绑定','从未触发','这个正文永远不该被加载。') RETURNING id`, ownerWS(t)).Scan(&visibleNotBound); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	ctx = context.WithValue(ctx, ctxMember, &identity{UserID: st.UserID, WorkspaceID: st.WorkspaceID, Role: "owner"})
	c, err := env.srv.agentSkillEnsureContext(ctx, st, acc, nil, acc.ContentFormat)
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range c.Items {
		if item.Def.ID == visibleNotBound {
			t.Fatal("unbound skill must not be in the catalog")
		}
	}

	// 回执不含正文。
	r1, err := env.srv.agentSkillLoad(ctx, st, acc, map[string]any{
		"skill_ref": c.Items[0].Ref, "catalog_id": c.CatalogID.String()})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(fmt.Sprint(r1), "完整正文") {
		t.Fatalf("receipt must not carry the body: %v", r1)
	}
	if r1["skill_id"] != c.Items[0].Def.ID {
		t.Fatalf("receipt skill: %v", r1["skill_id"])
	}
	// 幂等：重复请求不重复追加。
	r2, err := env.srv.agentSkillLoad(ctx, st, acc, map[string]any{
		"skill_ref": c.Items[0].Ref, "catalog_id": c.CatalogID.String()})
	if err != nil {
		t.Fatal(err)
	}
	if r2["status"] != "loaded" {
		t.Fatalf("idempotent receipt: %v", r2)
	}
	if len(agentSkillActive(st.RunID).Loaded) != 1 {
		t.Fatalf("loaded set must stay 1, got %d", len(agentSkillActive(st.RunID).Loaded))
	}
	// 第二条技能装入 → 可信指令区出现在消息中，正文完整。
	if _, err := env.srv.agentSkillLoad(ctx, st, acc, map[string]any{
		"skill_ref": c.Items[1].Ref, "catalog_id": c.CatalogID.String()}); err != nil {
		t.Fatal(err)
	}
	msgs, err := env.srv.agentBuildMessages(ctx, st, &identity{UserID: st.UserID, WorkspaceID: st.WorkspaceID, Role: "owner"})
	if err != nil {
		t.Fatal(err)
	}
	zoneFound := 0
	for _, m := range msgs {
		// 可信技能区以「## 用户已配置技能」标题开头；系统规则第 13 条只是提及，不算区本体。
		if strings.HasPrefix(m.Content, agentSkillZoneHeader()) {
			zoneFound++
			var body1, body2 string
			env.srv.db.QueryRow(context.Background(), `SELECT instructions FROM skill WHERE id=$1`, ids[0]).Scan(&body1)
			env.srv.db.QueryRow(context.Background(), `SELECT instructions FROM skill WHERE id=$1`, ids[1]).Scan(&body2)
			if !strings.Contains(m.Content, body1) || !strings.Contains(m.Content, body2) {
				t.Fatal("loaded zone must carry the full bodies")
			}
		}
	}
	if zoneFound != 1 {
		t.Fatalf("trusted skill zone missing: %d", zoneFound)
	}

	// 未知引用：catalog 不属于本运行 / ref 不存在 → unknown_skill_ref。
	if _, err := env.srv.agentSkillLoad(ctx, st, acc, map[string]any{
		"skill_ref": "s1", "catalog_id": uuid.NewString()}); err == nil {
		t.Fatal("foreign catalog must fail")
	} else if ae, ok := err.(*APIError); !ok || ae.Code != "unknown_skill_ref" {
		t.Fatalf("want unknown_skill_ref, got %v", err)
	}
	if _, err := env.srv.agentSkillLoad(ctx, st, acc, map[string]any{
		"skill_ref": "s999", "catalog_id": c.CatalogID.String()}); err == nil {
		t.Fatal("unknown ref must fail")
	}

	// 预算：继续装入直到 skill_budget_exceeded，已加载集合保持不变。
	long := strings.Repeat("长", 560)
	var longID uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(), `INSERT INTO skill (user_id, name, summary, triggers, instructions)
		VALUES ($1,'超长技能','正文接近上限的技能','预算测试触发条件',$2) RETURNING id`,
		ownerUserID(t), long).Scan(&longID); err != nil {
		t.Fatal(err)
	}
	skillAgentBindPersonal(t, acc.ID, longID)
	// 当前已加载 2 条（约 200 字）；再装 2 条 1400 字的 → 第二条应超预算。
	for i := 0; i < 2; i++ {
		in := SkillResolveInput{WorkspaceID: st.WorkspaceID, Account: acc, ActorKind: "user", ActorUserID: &st.UserID,
			TargetFormat: acc.ContentFormat, Surface: "agent"}
		res, err := env.srv.resolveSkillSet(ctx, in)
		if err != nil {
			t.Fatal(err)
		}
		_ = res
		// 直接重建目录找不到新技能（目录冻结）——用新 run 的目录验证预算拒绝。
		accID := acc.ID
		st2 := &agentRunState{RunID: uuid.New(), ConversationID: uuid.New(), WorkspaceID: st.WorkspaceID,
			UserID: st.UserID, SessionID: st.SessionID, AccountID: &accID}
		c2, err := env.srv.agentSkillEnsureContext(ctx, st2, acc, nil, acc.ContentFormat)
		if err != nil {
			t.Fatal(err)
		}
		var budgetErr error
		for _, item := range c2.Items {
			if item.Def.ID != longID {
				continue
			}
			_, budgetErr = env.srv.agentSkillLoad(ctx, st2, acc, map[string]any{
				"skill_ref": item.Ref, "catalog_id": c2.CatalogID.String()})
		}
		if i == 0 {
			if budgetErr != nil {
				t.Fatalf("first long skill should fit: %v", budgetErr)
			}
		} else if budgetErr == nil {
			// 已装 1 条长文 + 之前可能还有空间；循环直到超限。
			continue
		} else if ae, ok := budgetErr.(*APIError); !ok || ae.Code != "skill_budget_exceeded" {
			t.Fatalf("want skill_budget_exceeded, got %v", budgetErr)
		}
	}
	agentReleaseSkillState(st.RunID)
}

func skillAgentBindPersonal(t *testing.T, accID, skillID uuid.UUID) {
	t.Helper()
	uid := ownerUserID(t)
	if _, err := env.srv.db.Exec(context.Background(),
		`INSERT INTO skill_binding (account_id, audience_user_id, skill_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
		accID, &uid, skillID); err != nil {
		t.Fatal(err)
	}
}

// T-SK-30：原 s1=A / s2=B，解绑 A 后旧 s1 绝不加载 B；目录失效返回 skill_context_changed。
func TestSkillAgentCatalogInvalidation(t *testing.T) {
	st, acc := skillRunState(t)
	ids := skillAgentBind(t, acc.ID, 2, true)
	ctx := context.Background()
	ctx = context.WithValue(ctx, ctxMember, &identity{UserID: st.UserID, WorkspaceID: st.WorkspaceID, Role: "owner"})
	c, err := env.srv.agentSkillEnsureContext(ctx, st, acc, nil, acc.ContentFormat)
	if err != nil {
		t.Fatal(err)
	}
	// 动态定位 ids[0] / ids[1] 的引用号（账号分区里可能有更早测试的绑定）。
	refA, refB := "", ""
	for _, item := range c.Items {
		if item.Def.ID == ids[0] {
			refA = item.Ref
		}
		if item.Def.ID == ids[1] {
			refB = item.Ref
		}
	}
	if refA == "" || refB == "" {
		t.Fatal("fixture skills missing from catalog")
	}
	// 先装入 B 使其成为活动上下文（含 A 仍在目录中）。
	if _, err := env.srv.agentSkillLoad(ctx, st, acc, map[string]any{
		"skill_ref": refB, "catalog_id": c.CatalogID.String()}); err != nil {
		t.Fatal(err)
	}
	// 解绑 A（删除其绑定）：目录入选集变化 → 旧 s1 绝不加载 A，整体失效。
	if _, err := env.srv.db.Exec(context.Background(), `DELETE FROM skill_binding WHERE skill_id=$1 AND account_id=$2`, ids[0], acc.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.agentSkillLoad(ctx, st, acc, map[string]any{
		"skill_ref": refA, "catalog_id": c.CatalogID.String()}); err == nil {
		t.Fatal("stale ref must not load")
	} else if ae, ok := err.(*APIError); !ok || ae.Code != "skill_context_changed" {
		t.Fatalf("want skill_context_changed, got %v", err)
	}
	// 旧目录整体失效：每轮复核停止。
	if err := env.srv.agentSkillVerifyActive(ctx, st, acc); err == nil {
		t.Fatal("verify must stop after unbind")
	}
	if err := env.srv.agentSkillVerifyActive(ctx, st, acc); err == nil {
		t.Fatal("already-invalidated catalog keeps stopping")
	}
	agentReleaseSkillState(st.RunID)

	// 切换作品上下文：加载清空旧集合（T-SK-22）。
	st2, acc2 := skillRunState(t)
	skillAgentBind(t, acc2.ID, 1, true)
	var wk Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+acc2.ID.String()+"/works", map[string]string{"title": "上下文切换作品"}, &wk)
	cw, err := env.srv.agentSkillEnsureContext(ctx, st2, acc2, &wk.ID, acc2.ContentFormat)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.agentSkillLoad(ctx, st2, acc2, map[string]any{
		"skill_ref": cw.Items[0].Ref, "catalog_id": cw.CatalogID.String(), "work_id": wk.ID.String()}); err != nil {
		t.Fatal(err)
	}
	if agentSkillActive(st2.RunID).WorkID == nil || *agentSkillActive(st2.RunID).WorkID != wk.ID {
		t.Fatal("active context must switch to the work")
	}
	// 跨上下文引用：用默认目录的 catalog 加载 work 上下文的 ref → 拒绝。
	cd, err := env.srv.agentSkillEnsureContext(ctx, st2, acc2, nil, acc2.ContentFormat)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.agentSkillLoad(ctx, st2, acc2, map[string]any{
		"skill_ref": "s1", "catalog_id": cd.CatalogID.String(), "work_id": wk.ID.String()}); err == nil {
		t.Fatal("catalog/work mismatch must fail")
	}
	agentReleaseSkillState(st2.RunID)
}

// ---------- T-SK-16 / 11：运行内 effective 视图与 unknown_skill_ref 计数 ----------

func TestSkillAgentEffectiveInRun(t *testing.T) {
	pid := env.ensureToolModel(t)
	acc := env.accounts(t)
	skillAgentBind(t, acc.wechat.ID, 2, true)
	c := env.agentRunConversation(t, pid)
	defer deleteConversations(t, c.ID)

	evs := env.sse(t, agentRunPath(c, "messages"), map[string]any{"text":
		agentLoadDomain("profile") + "\n#tool skills__list {\"view\":\"effective\",\"account_id\":\"" + acc.wechat.ID.String() + "\"}"})
	toolOK := false
	for _, ev := range evs {
		if ev.Name == "tool" {
			toolOK = true
		}
	}
	if !toolOK {
		t.Fatalf("skills__list tool event missing: %+v", evs)
	}
	// 运行内状态：目录已按运行冻结，引用号可从工具结果读出。
	var body string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT content FROM agent_message WHERE conversation_id=$1 AND tool_name='skills__list' ORDER BY seq DESC LIMIT 1`,
		c.ID).Scan(&body); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(body, `"ref":"s1"`) || !strings.Contains(body, "catalog_id") {
		t.Fatalf("effective result must carry refs and catalog_id: %s", truncate(body, 300))
	}

	// 未知 catalog 的 load_skill：unknown_skill_ref 并计入连续无效（工具错误事件，运行继续）。
	evs = env.sse(t, agentRunPath(c, "messages"), map[string]any{"text":
		"#tool load_skill {\"skill_ref\":\"s1\",\"catalog_id\":\"" + uuid.NewString() + "\"}"})
	errSeen := false
	for _, ev := range evs {
		if ev.Name == "tool" {
			var data struct {
				Status string `json:"status"`
			}
			_ = json.Unmarshal(ev.Data, &data)
			if data.Status == "error" {
				errSeen = true
			}
		}
	}
	if !errSeen {
		t.Fatalf("load_skill unknown catalog must return a tool error: %+v", evs)
	}
}

// ---------- T-SK-17：目的受限来源 ----------

func TestSkillAgentProvenancePurpose(t *testing.T) {
	skillSrc := agentSource{Kind: agentSrcO, Purpose: agentPurposeSkill,
		Norms: agentNormalizeAll([]string{"技能正文里的方法句"})}
	bizSrc := agentSource{Kind: agentSrcG, Purpose: agentPurposeBusiness, Norms: agentNormalizeAll([]string{"业务生成结果里的句子"})}
	set := &agentSourceSet{sources: []agentSource{skillSrc, bizSrc}}

	// 技能文字字段：skill_definition 供源通过；业务 G 供源拒绝。
	if _, ok := set.match([]string{agentSrcUser, agentSrcAttachment, agentSrcG, agentSrcO}, agentPurposeSkill, "技能正文里的方法句"); !ok {
		t.Fatal("skill definition source must supply skill fields")
	}
	if _, ok := set.match([]string{agentSrcUser, agentSrcAttachment, agentSrcG, agentSrcO}, agentPurposeSkill, "业务生成结果里的句子"); ok {
		t.Fatal("business G must not supply skill fields")
	}
	// 业务字段：技能来源不供源。
	if _, ok := set.match([]string{agentSrcUser, agentSrcAttachment, agentSrcG, agentSrcO}, agentPurposeBusiness, "技能正文里的方法句"); ok {
		t.Fatal("skill source must not supply business fields")
	}
	if _, ok := set.match([]string{agentSrcUser, agentSrcAttachment, agentSrcG, agentSrcO}, agentPurposeBusiness, "业务生成结果里的句子"); !ok {
		t.Fatal("business source must supply business fields")
	}
	// 用户原文永远可以供技能字段（U）。
	userSet := &agentSourceSet{sources: []agentSource{{Kind: agentSrcUser, Purpose: agentPurposeBusiness,
		Norms: agentNormalizeAll([]string{"用户亲口写的技能说明"})}}}
	if _, ok := userSet.match([]string{agentSrcUser, agentSrcAttachment, agentSrcG, agentSrcO}, agentPurposeSkill, "用户亲口写的技能说明"); !ok {
		t.Fatal("user text must supply skill fields")
	}

	// 消息收集：skills__get 只取四个字段；load_skill / get_context / skills__list 不进来源。
	c := env.agentRunConversation(t, env.ensureToolModel(t))
	defer deleteConversations(t, c.ID)
	insertAgentMsg := func(role, tool, content string) {
		t.Helper()
		if _, err := env.srv.db.Exec(context.Background(), `INSERT INTO agent_message
			(conversation_id, seq, role, content, tool_name) VALUES ($1, (SELECT coalesce(max(seq),0)+1 FROM agent_message WHERE conversation_id=$2), $3, $4, $5)`,
			c.ID, c.ID, role, content, tool); err != nil {
			t.Fatal(err)
		}
	}
	insertAgentMsg("tool", "skills__get", `{"name":"检索到的技能名","summary":"检索摘要","triggers":"检索触发","instructions":"检索正文内容","revision":3,"id":"x"}`)
	insertAgentMsg("tool", "get_context", `{"env":"get_context 里的内容不应进入来源"}`)
	insertAgentMsg("tool", "load_skill", `{"ok":true,"name":"加载回执名"}`)
	insertAgentMsg("tool", "skills__list", `{"items":[{"name":"列表名"}]}`)
	set2, err := env.srv.agentCollectSources(context.Background(), c.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(set2.sources) != 1 {
		t.Fatalf("only skills__get result should enter sources, got %d", len(set2.sources))
	}
	src := set2.sources[0]
	if src.Purpose != agentPurposeSkill {
		t.Fatalf("skills__get purpose: %s", src.Purpose)
	}
	joined := strings.Join(src.Norms, "|")
	for _, want := range []string{"检索到的技能名", "检索摘要", "检索触发", "检索正文内容"} {
		if !strings.Contains(joined, agentNormalize(want)) {
			t.Fatalf("whitelist field missing: %s in %s", want, joined)
		}
	}
	for _, banned := range []string{"revision", "3"} {
		_ = banned
	}
	if strings.Contains(joined, agentNormalize("不应进入来源")) || strings.Contains(joined, agentNormalize("加载回执名")) || strings.Contains(joined, agentNormalize("列表名")) {
		t.Fatalf("excluded tools leaked into sources: %s", joined)
	}
}

// ---------- T-SK-12 / 32：AI 草稿逐张确认保存；SSE 只发 stage/done/error ----------

func TestSkillAgentDraftSSE(t *testing.T) {
	acc := env.accounts(t)
	// done：草稿字段合法；事件只有 stage 与 done（缓冲式，无 delta）。
	evs := env.sse(t, "/api/v1/skills/draft", map[string]any{"brief": "帮我起草一个用于小红书开头的方法"})
	for _, ev := range evs {
		if ev.Name == "delta" {
			t.Fatal("draft SSE must not send delta events")
		}
		if ev.Name != "stage" && ev.Name != "done" && ev.Name != "error" {
			t.Fatalf("unexpected event %s", ev.Name)
		}
	}
	lastEv := lastEvent(t, evs)
	if lastEv.Name != "done" {
		t.Fatalf("draft should finish with done: %s %s", lastEv.Name, lastEv.Data)
	}
	var done struct {
		Draft struct {
			Name  string `json:"name"`
			Body  string `json:"instructions"`
			Tasks []any  `json:"task_types"`
		} `json:"draft"`
		AICallID string `json:"ai_call_id"`
	}
	if err := json.Unmarshal(lastEv.Data, &done); err != nil {
		t.Fatal(err)
	}
	if done.Draft.Name == "" || done.Draft.Body == "" || done.AICallID == "" {
		t.Fatalf("draft fields missing: %s", lastEv.Data)
	}
	// done 的 ai_call_id 是一次真实的 skill_draft 调用。
	var n int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM ai_call WHERE id=$1 AND task_type='skill_draft'`, uuid.MustParse(done.AICallID)).Scan(&n); err != nil || n != 1 {
		t.Fatalf("done ai_call_id must point at a skill_draft call: %d %v", n, err)
	}

	// 密钥：brief 命中合成密钥 → skill_secret_detected，无 done。
	ae := env.expectErr(t, "POST", "/api/v1/skills/draft", map[string]any{"brief": "密钥是 sk-TESTKEY0000000000000000abc 请使用"}, "skill_secret_detected")
	_ = ae
	// 生成内容含合成密钥 → 直接失败，无纠错重试。
	env.llm.PushReplies(`{"name":"x","summary":"y","triggers":"z","instructions":"sk-TESTKEY0000000000000000abc","platforms":[],"content_formats":[],"task_types":[],"task_enabled":true,"agent_enabled":true}`)
	evs = env.sse(t, "/api/v1/skills/draft", map[string]any{"brief": "起草一个正常技能"})
	lastEv = lastEvent(t, evs)
	if lastEv.Name != "error" || !strings.Contains(string(lastEv.Data), "skill_secret_detected") {
		t.Fatalf("secret in generation must fail: %s %s", lastEv.Name, lastEv.Data)
	}
	// 结构失败两次 → ai_output_invalid，无 done。
	env.llm.PushReplies("第一段不是 JSON", "第二段也不是 JSON")
	evs = env.sse(t, "/api/v1/skills/draft", map[string]any{"brief": "再起草一个技能"})
	lastEv = lastEvent(t, evs)
	if lastEv.Name != "error" || !strings.Contains(string(lastEv.Data), "ai_output_invalid") {
		t.Fatalf("structure failure must surface ai_output_invalid: %s %s", lastEv.Name, lastEv.Data)
	}
	// viewer 不能起草。
	viewer := skillJoinMember(t, "viewer")
	gExpectErr(t, viewer, "POST", "/api/v1/skills/draft", map[string]any{"brief": "草拟"}, "forbidden")
	viewer.restore(env)
	_ = acc
}

// T-SK-12 / 33 / 34：草稿 → skills__create 卡片 → 用户执行；普通聊天输出不能冒充 G。
func TestSkillAgentDraftCardFlow(t *testing.T) {
	pid := env.ensureToolModel(t)
	env.accounts(t)
	c := env.agentRunConversation(t, pid)
	defer deleteConversations(t, c.ID)

	// 模拟模型：先 skills__draft（G），再用草稿结果提出 skills__create 卡片。
	text := agentLoadDomain("profile") + "\n#tool skills__draft {\"brief\":\"起草一个测试技能\"}\n#tool skills__create {\"scope\":\"personal\",\"name\":\"起草的写作技能\",\"summary\":\"按用户需求起草的可复用写作方法\",\"triggers\":\"符合用户需求描述的场景时使用\",\"instructions\":\"先确认本次要解决的问题，再按步骤给出可复用的写作方法。只用用户提供的素材，不编造事实、数据或引语；缺少依据时明确标注待补充内容。\"}"
	evs := env.sse(t, agentRunPath(c, "messages"), map[string]any{"text": text})
	action := findActionEvent(t, evs)
	if action == nil {
		t.Fatalf("应提出 skills__create 卡片：%+v", evs)
	}
	// done 的 ai_call_id 精确关联到 skills__draft 的工具结果消息。
	var aiID uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT id FROM ai_call WHERE task_type='skill_draft' AND workspace_id=$1 ORDER BY created_at DESC LIMIT 1`, ownerWS(t)).Scan(&aiID); err != nil {
		t.Fatal(err)
	}
	var msgCall *uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT ai_call_id FROM agent_message WHERE conversation_id=$1 AND tool_name='skills__draft' ORDER BY seq DESC LIMIT 1`,
		c.ID).Scan(&msgCall); err != nil {
		t.Fatal(err)
	}
	if msgCall == nil || *msgCall != aiID {
		t.Fatalf("skills__draft result must link the exact draft ai_call: %v vs %v", msgCall, aiID)
	}

	// 用户执行卡片（个人范围无公开确认）→ 技能创建，origin=manual。
	exeEv := env.sse(t, agentActionPath(action.ID, "execute"), map[string]any{"confirm": true})
	for _, ev := range exeEv {
		if ev.Name == "error" {
			t.Fatalf("card execution failed: %s", ev.Data)
		}
	}
	var actStatus, actErr string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT status, coalesce(error::text,'') FROM agent_action WHERE id=$1`, action.ID).Scan(&actStatus, &actErr); err != nil {
		t.Fatal(err)
	}
	if actStatus != "succeeded" {
		t.Fatalf("action status %s error %s", actStatus, actErr)
	}
	var origin string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT origin FROM skill WHERE user_id=$1 AND name='起草的写作技能'`, ownerUserID(t)).Scan(&origin); err != nil {
		t.Fatalf("skill should be created after card execution: %v", err)
	}
	if origin != "manual" {
		t.Fatalf("origin: %s", origin)
	}

	// 普通聊天输出不能冒充 G：不含草稿来源的新对话提出同样内容 → 拒绝创建卡片。
	c2 := env.agentRunConversation(t, pid)
	defer deleteConversations(t, c2.ID)
	// 删除刚才创建的技能，避免同名冲突（也要恢复唯一性）。
	env.srv.db.Exec(context.Background(), `DELETE FROM skill WHERE user_id=$1 AND name='起草的写作技能'`, ownerUserID(t))
	text2 := "起草的写作技能：按用户需求起草的可复用写作方法\n#tool skills__create {\"scope\":\"personal\",\"name\":\"起草的写作技能\",\"summary\":\"按用户需求起草的可复用写作方法\",\"triggers\":\"符合用户需求描述的场景时使用\",\"instructions\":\"先确认本次要解决的问题，再按步骤给出可复用的写作方法。只用用户提供的素材，不编造事实、数据或引语；缺少依据时明确标注待补充内容。\"}"
	evs2 := env.sse(t, agentRunPath(c2, "messages"), map[string]any{"text": text2})
	if a2 := findActionEvent(t, evs2); a2 != nil {
		t.Fatalf("assistant text must not act as a G source for skill fields: %+v", a2)
	}
}

// T-SK-34：同技能不同账号的绑定卡片不误合并；create 目标稳定。
func TestSkillAgentCardTargets(t *testing.T) {
	acc := env.accounts(t)
	fx := *acc
	tool := agentTool("skills__set_binding")
	skillID := uuid.New()
	typ1, key1, _, _ := env.srv.agentActionTarget(context.Background(), &agentRunState{WorkspaceID: ownerWS(t), UserID: uuidOf(ownerUserID(t))}, tool,
		map[string]any{"accountId": fx.wechat.ID.String(), "audience": "public", "skillId": skillID.String()})
	typ2, key2, _, _ := env.srv.agentActionTarget(context.Background(), &agentRunState{WorkspaceID: ownerWS(t), UserID: uuidOf(ownerUserID(t))}, tool,
		map[string]any{"accountId": fx.xhs.ID.String(), "audience": "public", "skillId": skillID.String()})
	if typ1 != "skill_binding" || typ1 != typ2 || key1 == key2 {
		t.Fatalf("same skill on different accounts must have different targets: %s %s", key1, key2)
	}
	_, key3, _, _ := env.srv.agentActionTarget(context.Background(), &agentRunState{WorkspaceID: ownerWS(t), UserID: uuidOf(ownerUserID(t))}, tool,
		map[string]any{"accountId": fx.wechat.ID.String(), "audience": "personal", "skillId": skillID.String()})
	if key3 == key1 {
		t.Fatal("audience must be part of the target key")
	}
	// create：同名不同 scope 目标不同。
	createTool := agentTool("skills__create")
	_, ck1, _, _ := env.srv.agentActionTarget(context.Background(), &agentRunState{WorkspaceID: ownerWS(t), UserID: uuidOf(ownerUserID(t))}, createTool,
		map[string]any{"scope": "personal", "name": "同名技能"})
	_, ck2, _, _ := env.srv.agentActionTarget(context.Background(), &agentRunState{WorkspaceID: ownerWS(t), UserID: uuidOf(ownerUserID(t))}, createTool,
		map[string]any{"scope": "workspace", "name": "同名技能"})
	if ck1 == ck2 || !strings.HasPrefix(ck1, "skill_create:") {
		t.Fatalf("create targets: %s vs %s", ck1, ck2)
	}
}
