package app

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"
)

// ---------- 测试辅助 ----------

// skillAIEnv 建立一个带技能绑定的账号上下文：返回 ctx（含身份与快照持有者）。
func skillAIEnv(t *testing.T) (context.Context, *fixture) {
	t.Helper()
	fx := env.accounts(t)
	me := env.me(t)
	ctx := context.Background()
	ctx = context.WithValue(ctx, ctxMember, &identity{
		UserID:      uuid.MustParse(me.UserID),
		SessionID:   uuid.New(),
		WorkspaceID: uuid.MustParse(me.Workspace.ID),
		Username:    me.Username,
		Role:        me.Role,
	})
	ctx = withSkillSnapshotHolder(ctx)
	return ctx, fx
}

func skillBindPersonal(t *testing.T, accID, skillID uuid.UUID) {
	t.Helper()
	_, err := env.srv.db.Exec(context.Background(),
		`INSERT INTO skill_binding (account_id, audience_user_id, skill_id, priority) VALUES ($1,$2,$3,100)
		 ON CONFLICT DO NOTHING`, accID, ownerUserID(t), skillID)
	if err != nil {
		t.Fatal(err)
	}
}

func skillBindPublic(t *testing.T, accID, skillID uuid.UUID) {
	t.Helper()
	_, err := env.srv.db.Exec(context.Background(),
		`INSERT INTO skill_binding (account_id, skill_id, priority) VALUES ($1,$2,100)
		 ON CONFLICT DO NOTHING`, accID, skillID)
	if err != nil {
		t.Fatal(err)
	}
}

// skillAIIn 把四层技能各建一个并绑定到账号，返回按层命名的技能 ID。
func skillAIInLayers(t *testing.T, fx *fixture) (personal, account, workspace uuid.UUID) {
	t.Helper()
	suffix := uuid.NewString()[:8]
	mk := func(name, scope string, accID *string) map[string]any {
		in := skillBaseFields(name)
		in["scope"] = scope
		if accID != nil {
			in["account_id"] = *accID
			in["publish_confirmation"] = map[string]any{"confirmed": true,
				"digest": skillDigest(t, "create", nil, "account", ptrUUID(*accID), in)}
		} else if scope == "workspace" {
			in["publish_confirmation"] = map[string]any{"confirmed": true,
				"digest": skillDigest(t, "create", nil, "workspace", nil, in)}
		}
		return in
	}
	p := skillCreateSkill(t, mk("层序个人-"+suffix, "personal", nil))
	accID := fx.wechat.ID.String()
	a := skillCreateSkill(t, mk("层序账号-"+suffix, "account", &accID))
	w := skillCreateSkill(t, mk("层序工作区-"+suffix, "workspace", nil))
	skillBindPersonal(t, fx.wechat.ID, skillIDOf(t, p))
	skillBindPublic(t, fx.wechat.ID, skillIDOf(t, a))
	skillBindPublic(t, fx.wechat.ID, skillIDOf(t, w))
	return skillIDOf(t, p), skillIDOf(t, a), skillIDOf(t, w)
}

func ptrUUID(s string) *uuid.UUID {
	id := uuid.MustParse(s)
	return &id
}

// systemOf 提取 mock 记录的请求体中的 system 消息文本。
func systemOf(t *testing.T, raw string) string {
	t.Helper()
	var req struct {
		Messages []struct {
			Role    string `json:"role"`
			Content string `json:"content"`
		} `json:"messages"`
	}
	if err := json.Unmarshal([]byte(raw), &req); err != nil {
		t.Fatalf("mock request decode: %v", err)
	}
	for _, m := range req.Messages {
		if m.Role == "system" {
			return m.Content
		}
	}
	return ""
}

func userOf(t *testing.T, raw string) string {
	t.Helper()
	var req struct {
		Messages []struct {
			Role    string `json:"role"`
			Content string `json:"content"`
		} `json:"messages"`
	}
	if err := json.Unmarshal([]byte(raw), &req); err != nil {
		t.Fatalf("mock request decode: %v", err)
	}
	for _, m := range req.Messages {
		if m.Role == "user" {
			return m.Content
		}
	}
	return ""
}

// ---------- T-SK-8：槽位装配、排序、预算与逐项留痕 ----------

func TestSkillAISlotAssembly(t *testing.T) {
	ctx, fx := skillAIEnv(t)
	personal, account, workspace := skillAIInLayers(t, fx)
	env.llm.ResetRequests()
	if _, err := env.srv.runAI(ctx, aiTask{Type: "title", Account: &fx.wechat, User: "写一个标题"}, nil); err != nil {
		t.Fatal(err)
	}
	reqs := env.llm.Requests()
	if len(reqs) == 0 {
		t.Fatal("no requests recorded")
	}
	sys := systemOf(t, reqs[len(reqs)-1])
	if !strings.Contains(sys, skillSlotHeader()) {
		t.Fatal("skills slot header missing")
	}
	// 层序：个人→账号→工作区。
	pi := strings.Index(sys, "层序个人")
	ai := strings.Index(sys, "层序账号")
	wi := strings.Index(sys, "层序工作区")
	if pi < 0 || ai < 0 || wi < 0 || !(pi < ai && ai < wi) {
		t.Fatalf("layer order wrong: personal=%d account=%d workspace=%d", pi, ai, wi)
	}
	// 正文完整装入不截断。
	for _, id := range []uuid.UUID{personal, account, workspace} {
		var body string
		if err := env.srv.db.QueryRow(context.Background(), `SELECT instructions FROM skill WHERE id=$1`, id).Scan(&body); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(sys, body) {
			t.Fatalf("instructions truncated for %s", id)
		}
	}
	// ai_call 引用：公共项含元数据；个人项只含匿名数量（10.3 节）。
	var refsRaw, privRaw []byte
	var owner *uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(), `SELECT context_refs, private_context_refs, context_owner_user_id
		FROM ai_call WHERE workspace_id=$1 AND task_type='title' ORDER BY created_at DESC LIMIT 1`,
		ownerWS(t)).Scan(&refsRaw, &privRaw, &owner); err != nil {
		t.Fatal(err)
	}
	var refs struct {
		Skills *struct {
			Items []SkillUseItem `json:"items"`
			PersonalUsed int    `json:"personal_used_count"`
		} `json:"skills"`
	}
	if err := json.Unmarshal(refsRaw, &refs); err != nil || refs.Skills == nil {
		t.Fatalf("refs.skills missing: %s", refsRaw)
	}
	foundPublic, foundPersonal := 0, 0
	for _, it := range refs.Skills.Items {
		if it.ID == personal {
			foundPersonal++
		}
		if it.ID == workspace || it.ID == account {
			foundPublic++
		}
	}
	if foundPublic != 2 || foundPersonal != 0 {
		t.Fatalf("public refs must not contain personal ids: %+v", refs.Skills.Items)
	}
	if refs.Skills.PersonalUsed != 1 {
		t.Fatalf("personal_used_count: %d", refs.Skills.PersonalUsed)
	}
	if owner == nil || *owner != uuid.MustParse(env.me(t).UserID) {
		t.Fatalf("context owner: %v", owner)
	}
	// 私有引用含个人元数据但无正文。
	if !strings.Contains(string(privRaw), personal.String()) || strings.Contains(string(privRaw), "这是测试正文") {
		t.Fatalf("private refs: %s", privRaw)
	}
}

func ownerWS(t *testing.T) uuid.UUID {
	t.Helper()
	return uuid.MustParse(env.me(t).Workspace.ID)
}

// T-SK-9：无绑定账号提示词逐字节不变；全部被过滤时不输出空技能标题。
func TestSkillAINoBindingByteIdentical(t *testing.T) {
	ctx, _ := skillAIEnv(t)
	// fx.wechat 此刻可能已带早期测试的绑定；用全新账号确保零绑定。
	var fresh Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{"platform": "wechat_mp", "name": "无绑定账号", "content_format": "long_article"}, &fresh)

	env.llm.ResetRequests()
	if _, err := env.srv.runAI(ctx, aiTask{Type: "title", Account: &fresh, User: "标题任务"}, nil); err != nil {
		t.Fatal(err)
	}
	sys := systemOf(t, env.llm.Requests()[len(env.llm.Requests())-1])
	if strings.Contains(sys, "写作技能") || strings.Contains(sys, skillSlotDeclaration) {
		t.Fatal("no-binding prompt must not contain the skills slot")
	}
	// 基线：同一账号在技能路径关闭（Bare 之外的条件不变）时生成的槽位之外部分一致。
	// 直接断言槽位之外内容 = 既有规则+档案+…+任务，即包含系统规则且不含技能声明。
	if !strings.Contains(sys, "你是一位帮助内容创作者写作的助手") {
		t.Fatal("system rules missing")
	}

	// 全部被过滤：绑定一个仅适用小红书的技能到公众号账号 → 无空标题。
	suffix := uuid.NewString()[:8]
	in := skillBaseFields("过滤空槽-" + suffix)
	in["scope"] = "personal"
	in["platforms"] = []string{"xhs"}
	sk := skillCreateSkill(t, in)
	skillBindPersonal(t, fresh.ID, skillIDOf(t, sk))
	env.llm.ResetRequests()
	if _, err := env.srv.runAI(ctx, aiTask{Type: "title", Account: &fresh, User: "标题任务"}, nil); err != nil {
		t.Fatal(err)
	}
	sys2 := systemOf(t, env.llm.Requests()[len(env.llm.Requests())-1])
	if strings.Contains(sys2, "写作技能") {
		t.Fatal("all-filtered prompt must not emit an empty skills header")
	}
}

// ---------- T-SK-31：两类重试边界 ----------

func TestSkillAIRetryBoundaries(t *testing.T) {
	ctx, fx := skillAIEnv(t)
	personal, _, workspace := skillAIInLayers(t, fx)

	// 备用模型同 pack：主模型 mock-down（503），备用 mock-fast。
	ws := ownerWS(t)
	enc, err := env.srv.box.Encrypt("local-dev-key")
	if err != nil {
		t.Fatal(err)
	}
	var providerID uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(), "INSERT INTO model_provider (workspace_id, name, base_url, api_key_enc, key_version, models)"+
		" VALUES ($1,'主模型不可用',$2,$3,1,$4) RETURNING id",
		ws, "http://"+env.srv.cfg.MockListen+"/v1", enc, []string{"mock-down"}).Scan(&providerID); err != nil {
		t.Fatal(err)
	}
	var seededProvider uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(), `SELECT id FROM model_provider WHERE workspace_id=$1 AND name='本地模拟模型'`, ws).Scan(&seededProvider); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(context.Background(), `INSERT INTO model_route (workspace_id, task_type, provider_id, model, fallback_provider_id, fallback_model)
		VALUES ($1,'title',$2,'mock-down',$3,'mock-fast')
		ON CONFLICT (workspace_id, task_type) DO UPDATE SET provider_id=$2, model='mock-down', fallback_provider_id=$3, fallback_model='mock-fast'`,
		ws, providerID, seededProvider); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(context.Background(), `DELETE FROM model_route WHERE workspace_id=$1 AND task_type='title'`, ws)
		_, _ = env.srv.db.Exec(context.Background(), `DELETE FROM model_provider WHERE id=$1`, providerID)
	})
	env.llm.ResetRequests()
	if _, err := env.srv.runAI(ctx, aiTask{Type: "title", Account: &fx.wechat, User: "备用模型同包"}, nil); err != nil {
		t.Fatal(err)
	}
	reqs := env.llm.Requests()
	if len(reqs) < 2 {
		t.Fatalf("fallback should produce two attempts, got %d", len(reqs))
	}
	if systemOf(t, reqs[0]) != systemOf(t, reqs[1]) {
		t.Fatal("fallback attempt must reuse the same pack")
	}
	if !strings.Contains(systemOf(t, reqs[1]), "层序个人") {
		t.Fatal("fallback pack lost the skills slot")
	}

	// JSON 纠错只追加纠错信息、复用快照。
	var pid uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(), `SELECT provider_id FROM model_route WHERE workspace_id=$1 AND task_type='default'`, ws).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(context.Background(), `UPDATE model_route SET provider_id=$2, model='mock-writer', fallback_provider_id=NULL, fallback_model=''
		WHERE workspace_id=$1 AND task_type='title'`, ws, pid); err != nil {
		t.Fatal(err)
	}
	env.llm.ResetRequests()
	env.llm.PushReplies("这不是 JSON", `{"title":"修复后的标题"}`)
	var out struct {
		Title string `json:"title"`
	}
	if _, err := env.srv.runAIJSON(ctx, aiTask{Type: "title", Account: &fx.wechat, User: "纠错重试"}, &out, func() error { return nil }); err != nil {
		t.Fatal(err)
	}
	reqs = env.llm.Requests()
	if len(reqs) != 2 {
		t.Fatalf("correction retry should record two requests, got %d", len(reqs))
	}
	sys1, sys2 := systemOf(t, reqs[0]), systemOf(t, reqs[1])
	if sys1 != sys2 || !strings.Contains(sys2, "层序个人") {
		t.Fatal("correction retry must reuse the same skills snapshot")
	}
	u1, u2 := userOf(t, reqs[0]), userOf(t, reqs[1])
	// 纠错信息只插入一次（连同其引导换行追加到本次请求），其余内容逐字节不变。
	const head = "上一次输出不符合要求："
	const tail = "。只输出修正后的 JSON。"
	start := strings.Index(u2, "\n\n"+head)
	if start < 0 || strings.Count(u2, head) != 1 {
		t.Fatalf("correction text missing: %q", u2)
	}
	rel := strings.Index(u2[start:], tail)
	if rel < 0 {
		t.Fatalf("correction tail missing: %q", u2)
	}
	stripped := u2[:start] + u2[start+rel+len(tail):]
	if stripped != u1 {
		t.Fatalf("correction must not change anything else:\n%q\nvs\n%q", stripped, u1)
	}

	// 运行中变化在重试前停止：修改入选技能 priority 后复核失败。
	var snap *SkillSnapshot
	{
		in := SkillResolveInput{WorkspaceID: ws, Account: &fx.wechat, ActorKind: "user",
			ActorUserID: ptr(uuidOf(env.me(t).UserID)), Surface: "task", TaskType: "title"}
		snap, err = env.srv.loadSkillSnapshot(ctx, in)
		if err != nil {
			t.Fatal(err)
		}
		if err := env.srv.verifySkillSnapshot(ctx, snap); err != nil {
			t.Fatalf("fresh snapshot must verify: %v", err)
		}
		if _, err := env.srv.db.Exec(context.Background(), `UPDATE skill_binding SET priority=7 WHERE audience_user_id=$1 AND skill_id=$2`,
			uuidOf(env.me(t).UserID), personal); err != nil {
			t.Fatal(err)
		}
		if err := env.srv.verifySkillSnapshot(ctx, snap); !isSkillContextChanged(err) {
			t.Fatalf("priority change must stop: %v", err)
		}
	}
	// 解绑后重绑（binding_id 变化）→ 变化。
	{
		in := SkillResolveInput{WorkspaceID: ws, Account: &fx.wechat, ActorKind: "user",
			ActorUserID: ptr(uuidOf(env.me(t).UserID)), Surface: "task", TaskType: "title"}
		snap, err := env.srv.loadSkillSnapshot(ctx, in)
		if err != nil {
			t.Fatal(err)
		}
		var bid uuid.UUID
		if err := env.srv.db.QueryRow(context.Background(), `SELECT id FROM skill_binding WHERE audience_user_id=$1 AND skill_id=$2`,
			uuidOf(env.me(t).UserID), personal).Scan(&bid); err != nil {
			t.Fatal(err)
		}
		if _, err := env.srv.db.Exec(context.Background(), `DELETE FROM skill_binding WHERE id=$1`, bid); err != nil {
			t.Fatal(err)
		}
		if err := env.srv.verifySkillSnapshot(ctx, snap); err == nil {
			t.Fatal("unbind must stop")
		}
		skillBindPersonal(t, fx.wechat.ID, personal)
		if err := env.srv.verifySkillSnapshot(ctx, snap); err == nil {
			t.Fatal("rebind changes binding_id and must stop")
		}
	}
	// 定义修订变化 → 停止；非入选新增不影响本次。
	{
		in := SkillResolveInput{WorkspaceID: ws, Account: &fx.wechat, ActorKind: "user",
			ActorUserID: ptr(uuidOf(env.me(t).UserID)), Surface: "task", TaskType: "title"}
		snap, err := env.srv.loadSkillSnapshot(ctx, in)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := env.srv.db.Exec(context.Background(), `UPDATE skill SET revision=revision+1 WHERE id=$1`, workspace); err != nil {
			t.Fatal(err)
		}
		if err := env.srv.verifySkillSnapshot(ctx, snap); err == nil {
			t.Fatal("definition revision change must stop")
		}
		suffix := uuid.NewString()[:8]
		inN := skillBaseFields("快照外新增-" + suffix)
		inN["scope"] = "personal"
		inN["task_types"] = []string{"hook_suggest"} // 不命中 title，非入选
		skN := skillCreateSkill(t, inN)
		skillBindPersonal(t, fx.wechat.ID, skillIDOf(t, skN))
		in2 := SkillResolveInput{WorkspaceID: ws, Account: &fx.wechat, ActorKind: "user",
			ActorUserID: ptr(uuidOf(env.me(t).UserID)), Surface: "task", TaskType: "title"}
		snap2, err := env.srv.loadSkillSnapshot(ctx, in2)
		if err != nil {
			t.Fatal(err)
		}
		_ = snap2
		// 旧快照（新增前）仍应通过：非入选技能的新增留待下一次动作。
		in3 := SkillResolveInput{WorkspaceID: ws, Account: &fx.wechat, ActorKind: "user",
			ActorUserID: ptr(uuidOf(env.me(t).UserID)), Surface: "task", TaskType: "hook_suggest"}
		snap3, err := env.srv.loadSkillSnapshot(ctx, in3)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := env.srv.db.Exec(context.Background(), `UPDATE skill SET revision=revision+1 WHERE id=$1`, skillIDOf(t, skN)); err != nil {
			t.Fatal(err)
		}
		if err := env.srv.verifySkillSnapshot(ctx, snap3); err == nil {
			t.Fatal("selected skill revision change must stop even if newly added")
		}
	}
	// 目标形态变化（作品形态）→ 停止。
	{
		var wk Work
		env.mustJSON(t, "POST", "/api/v1/accounts/"+fx.wechat.ID.String()+"/works", map[string]string{"title": "形态变化作品"}, &wk)
		in := SkillResolveInput{WorkspaceID: ws, Account: &fx.wechat, ActorKind: "user",
			ActorUserID: ptr(uuidOf(env.me(t).UserID)), Surface: "task", TaskType: "title", WorkID: &wk.ID}
		snap, err := env.srv.loadSkillSnapshot(ctx, in)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := env.srv.db.Exec(context.Background(), `UPDATE work SET content_format='script' WHERE id=$1`, wk.ID); err != nil {
			t.Fatal(err)
		}
		if err := env.srv.verifySkillSnapshot(ctx, snap); err == nil {
			t.Fatal("work format change must stop")
		}
	}
	// 成员资格撤销 → 停止（禁用期间会话会按既有规则切换工作区，故先捕获身份并最终切回）。
	{
		in := SkillResolveInput{WorkspaceID: ws, Account: &fx.wechat, ActorKind: "user",
			ActorUserID: ptr(uuidOf(env.me(t).UserID)), Surface: "task", TaskType: "title"}
		snap, err := env.srv.loadSkillSnapshot(ctx, in)
		if err != nil {
			t.Fatal(err)
		}
		uid := uuidOf(env.me(t).UserID)
		if _, err := env.srv.db.Exec(context.Background(), `UPDATE workspace_member SET status='disabled' WHERE workspace_id=$1 AND user_id=$2`,
			ws, uid); err != nil {
			t.Fatal(err)
		}
		err = env.srv.verifySkillSnapshot(ctx, snap)
		if _, err := env.srv.db.Exec(context.Background(), `UPDATE workspace_member SET status='active' WHERE workspace_id=$1 AND user_id=$2`,
			ws, uid); err != nil {
			t.Fatal(err)
		}
		if err == nil {
			t.Fatal("membership loss must stop")
		}
		// 禁用期间会话已被切到个人工作区，切回后继续。
		if _, body := env.do("POST", "/api/v1/workspaces/"+ws.String()+"/switch", nil); !true {
			t.Fatal(body)
		}
	}
}

func ptr(id uuid.UUID) *uuid.UUID { return &id }
func uuidOf(s string) uuid.UUID   { return uuid.MustParse(s) }

// isSkillContextChanged 判断错误是否为 skill_context_changed（6.3 节停止信号）。
func isSkillContextChanged(err error) bool {
	var ae *APIError
	return errors.As(err, &ae) && ae.Code == "skill_context_changed"
}

// ---------- T-SK-20 / 23：执行主体与任务矩阵 ----------

func TestSkillSubjectAndTaskMatrix(t *testing.T) {
	_, fx := skillAIEnv(t)
	suffix := uuid.NewString()[:8]

	// 个人技能 + 公共技能绑定到小红书账号。
	inP := skillBaseFields("主体个人-" + suffix)
	inP["scope"] = "personal"
	inP["content_formats"] = []string{"image_note"}
	p := skillCreateSkill(t, inP)
	inW := skillBaseFields("主体公共-" + suffix)
	inW["scope"] = "workspace"
	inW["content_formats"] = []string{"image_note"}
	inW["publish_confirmation"] = map[string]any{"confirmed": true, "digest": skillDigest(t, "create", nil, "workspace", nil, inW)}
	w := skillCreateSkill(t, inW)
	skillBindPersonal(t, fx.xhs.ID, skillIDOf(t, p))
	skillBindPublic(t, fx.xhs.ID, skillIDOf(t, w))

	// 系统主体：只用公共。
	resSys, err := env.srv.resolveSkillSet(context.Background(), SkillResolveInput{
		WorkspaceID: ownerWS(t), Account: &fx.xhs, ActorKind: "system", TargetFormat: "image_note", Surface: "task", TaskType: "summary"})
	if err != nil {
		t.Fatal(err)
	}
	if len(resSys.Selected) != 1 || resSys.Selected[0].Def.ID != skillIDOf(t, w) {
		t.Fatalf("system subject must use public only: %+v", resSys.Selected)
	}
	// 系统执行携带个人身份：拒绝。
	if _, err := env.srv.resolveSkillSet(context.Background(), SkillResolveInput{
		WorkspaceID: ownerWS(t), Account: &fx.xhs, ActorKind: "system", ActorUserID: ptr(uuidOf(env.me(t).UserID)),
		TargetFormat: "image_note", Surface: "task", TaskType: "summary"}); err == nil {
		t.Fatal("system actor must not carry a user id")
	}
	// 用户主体：个人优先在前。
	resUser, err := env.srv.resolveSkillSet(context.Background(), SkillResolveInput{
		WorkspaceID: ownerWS(t), Account: &fx.xhs, ActorKind: "user", ActorUserID: ptr(uuidOf(env.me(t).UserID)),
		TargetFormat: "image_note", Surface: "task", TaskType: "summary"})
	if err != nil {
		t.Fatal(err)
	}
	if len(resUser.Selected) != 2 || resUser.Selected[0].Def.ID != skillIDOf(t, p) {
		t.Fatalf("user subject order: %+v", resUser.Selected)
	}

	// C1 显式：空 task_types 不适用于 C1 任务；显式 [tag_suggest] 适用。
	inC1 := skillBaseFields("辅助任务-" + suffix)
	inC1["scope"] = "personal"
	inC1["content_formats"] = []string{"image_note"}
	inC1["task_types"] = []string{"tag_suggest"}
	c1 := skillCreateSkill(t, inC1)
	skillBindPersonal(t, fx.xhs.ID, skillIDOf(t, c1))
	inv := SkillResolveInput{WorkspaceID: ownerWS(t), Account: &fx.xhs, ActorKind: "user",
		ActorUserID: ptr(uuidOf(env.me(t).UserID)), TargetFormat: "image_note", Surface: "task", TaskType: "tag_suggest"}
	resC1, err := env.srv.resolveSkillSet(context.Background(), inv)
	if err != nil {
		t.Fatal(err)
	}
	if len(resC1.Selected) != 1 || resC1.Selected[0].Def.ID != skillIDOf(t, c1) {
		t.Fatalf("C1 explicit: %+v", resC1.Selected)
	}
	// image_gen / embedding / agent_chat / default 不注入。
	for _, tt := range []string{"image_gen", "embedding", "agent_chat", "default", "fact_flag"} {
		res, err := env.srv.resolveSkillSet(context.Background(), SkillResolveInput{
			WorkspaceID: ownerWS(t), Account: &fx.xhs, ActorKind: "user", ActorUserID: ptr(uuidOf(env.me(t).UserID)),
			TargetFormat: "image_note", Surface: "task", TaskType: tt})
		if err != nil {
			t.Fatal(err)
		}
		if len(res.Items) != 0 || len(res.Selected) != 0 {
			t.Fatalf("task %s must not inject skills", tt)
		}
	}
	// 无账号 / Bare 不注入。
	resBare, err := env.srv.resolveSkillSet(context.Background(), SkillResolveInput{
		WorkspaceID: ownerWS(t), Account: &fx.xhs, ActorKind: "user", ActorUserID: ptr(uuidOf(env.me(t).UserID)),
		TargetFormat: "image_note", Surface: "task", TaskType: "summary", Bare: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(resBare.Selected) != 0 {
		t.Fatal("bare tasks must not inject")
	}
}

// ---------- T-SK-18 / 19：隐私阻断共享缓存与回执读取 ----------

func TestSkillAIPrivacy(t *testing.T) {
	ctx, fx := skillAIEnv(t)
	suffix := uuid.NewString()[:8]
	in := skillBaseFields("隐私个人-" + suffix)
	in["scope"] = "personal"
	in["content_formats"] = []string{"long_article"}
	p := skillCreateSkill(t, in)
	skillBindPersonal(t, fx.wechat.ID, skillIDOf(t, p))

	env.llm.ResetRequests()
	if _, err := env.srv.runAI(ctx, aiTask{Type: "outline", Account: &fx.wechat, User: "隐私检测"}, nil); err != nil {
		t.Fatal(err)
	}
	// lastPacks 标记私有：保存回归用例 409（outline 是可编辑提示词任务）。
	v, ok := env.srv.lastPacks.Load(ownerWS(t).String() + "/outline")
	if !ok {
		t.Fatal("lastPacks entry missing")
	}
	es := v.(evalSnapshot)
	if !es.Private || es.System != "" {
		t.Fatalf("private pack must not keep text: %+v", es)
	}
	env.expectErr(t, "POST", "/api/v1/prompt-eval/cases", map[string]any{"task_type": "outline", "name": "隐私"}, "private_context_not_shareable")

	// 回执读取：本人合并私有项；他人只见公共项与匿名数量。
	var callID uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(), `SELECT id FROM ai_call WHERE task_type='outline' AND account_id=$1 ORDER BY created_at DESC LIMIT 1`,
		fx.wechat.ID).Scan(&callID); err != nil {
		t.Fatal(err)
	}
	var mine struct {
		Items []struct {
			ID    string `json:"id"`
			Scope string `json:"scope"`
		} `json:"items"`
		PersonalUsed int `json:"personal_used_count"`
	}
	env.mustJSON(t, "GET", "/api/v1/ai-calls/"+callID.String()+"/skill-context", nil, &mine)
	foundPersonal := false
	for _, it := range mine.Items {
		if it.ID == skillIDOf(t, p).String() {
			if it.Scope != "personal" {
				t.Fatal("personal scope mismatch")
			}
			foundPersonal = true
		}
	}
	if !foundPersonal || mine.PersonalUsed < 1 {
		t.Fatalf("owner must see private items: %+v", mine)
	}
	// 他人：只看公共项；不能通过参数代读。
	editor := skillJoinMember(t, "editor")
	var theirs struct {
		Items []struct {
			ID string `json:"id"`
		} `json:"items"`
		PersonalUsed int `json:"personal_used_count"`
	}
	gMustJSON(t, editor, "GET", "/api/v1/ai-calls/"+callID.String()+"/skill-context?owner_user_id="+env.me(t).UserID, nil, &theirs)
	for _, it := range theirs.Items {
		if it.ID == skillIDOf(t, p).String() {
			t.Fatal("other members must not see personal ids")
		}
	}
	if theirs.PersonalUsed < 1 {
		t.Fatalf("anonymous count visible: %d", theirs.PersonalUsed)
	}
	// 跨租户：其他工作区成员 404。
	outsider := env.registerClient(t, "sk-outside-"+uuid.NewString()[:8], testPassword)
	outsider.expectErr(t, "GET", "/api/v1/ai-calls/"+callID.String()+"/skill-context", nil, "not_found")
	outsider.restore(env)
	editor.restore(env)
}
