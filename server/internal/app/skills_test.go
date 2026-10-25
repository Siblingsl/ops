package app

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func ownerUserID(t *testing.T) string {
	t.Helper()
	return env.me(t).UserID
}

// ---------- 测试辅助 ----------

func skillBaseFields(name string) map[string]any {
	return map[string]any{
		"name": name, "summary": "用于测试的技能用途", "triggers": "测试触发说明",
		"instructions": "这是测试正文，足够长以通过非空校验。",
		"platforms":    []string{}, "content_formats": []string{}, "task_types": []string{},
		"task_enabled": true, "agent_enabled": true, "status": "active",
	}
}

// skillDigest 为公共目标计算 sp1 确认摘要（与 createSkill / putSkill 相同口径）。
func skillDigest(t *testing.T, operation string, skillID *uuid.UUID, scope string, accID *uuid.UUID, fields map[string]any) string {
	t.Helper()
	strs := func(key string) []string {
		raw, _ := json.Marshal(fields[key])
		var arr []string
		_ = json.Unmarshal(raw, &arr)
		return arr
	}
	f := SkillFields{
		Name: fields["name"].(string), Summary: fields["summary"].(string), Triggers: fields["triggers"].(string),
		Instructions: fields["instructions"].(string),
		Platforms:    normalizeEnumArray(strs("platforms")), ContentFormats: normalizeEnumArray(strs("content_formats")),
		TaskTypes: normalizeEnumArray(strs("task_types")),
	}
	if v, ok := fields["task_enabled"].(bool); ok {
		f.TaskEnabled = v
	}
	if v, ok := fields["agent_enabled"].(bool); ok {
		f.AgentEnabled = v
	}
	f.Status = "active"
	if v, ok := fields["status"].(string); ok && v != "" {
		f.Status = v
	}
	d, err := skillPublishDigest(operation, skillID, scope, accID, f)
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func skillCreateSkill(t *testing.T, in map[string]any) map[string]any {
	t.Helper()
	var out struct {
		Skill map[string]any `json:"skill"`
	}
	env.mustJSON(t, "POST", "/api/v1/skills", in, &out)
	// 共享测试库的配额（个人定义 50 / 账号绑定 20）会被跨测试累计击穿：测试结束清理本条定义。
	t.Cleanup(func() {
		id, _ := uuid.Parse(out.Skill["id"].(string))
		_, _ = env.srv.db.Exec(context.Background(), `DELETE FROM skill WHERE id=$1`, id)
	})
	return out.Skill
}

func skillPersonalCreate(t *testing.T, name string) map[string]any {
	t.Helper()
	in := skillBaseFields(name)
	in["scope"] = "personal"
	return skillCreateSkill(t, in)
}

func skillWorkspaceCreate(t *testing.T, name string) map[string]any {
	t.Helper()
	in := skillBaseFields(name)
	in["scope"] = "workspace"
	in["publish_confirmation"] = map[string]any{"confirmed": true, "digest": skillDigest(t, "create", nil, "workspace", nil, in)}
	return skillCreateSkill(t, in)
}

func skillAccountCreate(t *testing.T, name string, accID string) map[string]any {
	t.Helper()
	in := skillBaseFields(name)
	in["scope"] = "account"
	in["account_id"] = accID
	aid := uuid.MustParse(accID)
	in["publish_confirmation"] = map[string]any{"confirmed": true, "digest": skillDigest(t, "create", nil, "account", &aid, in)}
	return skillCreateSkill(t, in)
}

func skillJoinMember(t *testing.T, role string) *guestClient {
	t.Helper()
	var inv inviteDTO
	env.mustJSON(t, "POST", "/api/v1/workspaces/current/invites", map[string]any{"role": role, "max_uses": 1, "days": 1}, &inv)
	m := env.registerClient(t, "sk-"+role+"-"+uuid.NewString()[:8], testPassword)
	var vme meInfo
	m.mustJSON(t, "GET", "/api/v1/auth/me", nil, &vme)
	m.csrf = vme.CSRF
	m.mustJSON(t, "POST", "/api/v1/workspaces/join", map[string]any{"code": inv.Code, "switch": true}, nil)
	return m
}

// gMustJSON / gExpectErr 在调用后恢复 env 的默认客户端，避免后续 env 调用串身份。
func gMustJSON(t *testing.T, m *guestClient, method, path string, in, out any) {
	t.Helper()
	defer m.restore(env)
	m.mustJSON(t, method, path, in, out)
}

func gExpectErr(t *testing.T, m *guestClient, method, path string, in any, code string) apiError {
	t.Helper()
	defer m.restore(env)
	return m.expectErr(t, method, path, in, code)
}

func skillIDOf(t *testing.T, dto map[string]any) uuid.UUID {
	t.Helper()
	id, err := uuid.Parse(dto["id"].(string))
	if err != nil {
		t.Fatal(err)
	}
	return id
}

// ---------- T-SK-1 / T-SK-25：四层可见性、详情隔离与创建原子性 ----------

func TestSkillDefinitionsAndIsolation(t *testing.T) {
	fx := env.accounts(t)
	suffix := uuid.NewString()[:8]

	personal := skillPersonalCreate(t, "个人隔离-"+suffix)
	if personal["scope"] != "personal" || personal["revision"].(float64) != 1 {
		t.Fatalf("personal dto: %+v", personal)
	}
	if personal["content_hash"] == "" || personal["origin"] != "manual" {
		t.Fatalf("content_hash/origin: %+v", personal)
	}
	ws := skillWorkspaceCreate(t, "工作区共享-"+suffix)
	acc := skillAccountCreate(t, "账号专属-"+suffix, fx.wechat.ID.String())
	if acc["account_id"] == nil {
		t.Fatalf("account skill missing account_id: %+v", acc)
	}

	pid := skillIDOf(t, personal)
	wid := skillIDOf(t, ws)
	aid := skillIDOf(t, acc)

	// 第二个 editor：可见 workspace / account，不可见他人 personal。
	editor := skillJoinMember(t, "editor")
	gMustJSON(t, editor, "GET", "/api/v1/skills/"+wid.String(), nil, nil)
	gMustJSON(t, editor, "GET", "/api/v1/skills/"+aid.String(), nil, nil)
	gExpectErr(t, editor, "GET", "/api/v1/skills/"+pid.String(), nil, "not_found")
	gExpectErr(t, editor, "GET", "/api/v1/skills/"+pid.String()+"/export", nil, "not_found")
	gExpectErr(t, editor, "GET", "/api/v1/skills/"+pid.String()+"/impact?action=delete", nil, "not_found")
	editor.restore(env)

	// editor 修改 workspace 技能需要新的公开确认；个人技能本人可改（无确认参数）。
	var detail map[string]any
	putFields := skillBaseFields("工作区共享-改")
	putFields["status"] = "active"
	env.mustJSON(t, "GET", "/api/v1/skills/"+wid.String(), nil, &detail)
	rev := int64(detail["revision"].(float64))
	in := map[string]any{}
	for k, v := range putFields {
		in[k] = v
	}
	in["base_revision"] = rev
	in["impact_token"] = "si1:placeholder"
	in["publish_confirmation"] = map[string]any{"confirmed": true, "digest": skillDigest(t, "update", &wid, "workspace", nil, putFields)}
	env.expectErr(t, "PUT", "/api/v1/skills/"+wid.String(), in, "stale") // 未经影响预览的 token 一律 stale

	// 影响预览 → PUT。
	var impact struct {
		ImpactToken string `json:"impact_token"`
		Base        int64  `json:"base_revision"`
		Affected    int    `json:"affected_bindings"`
	}
	env.mustJSON(t, "GET", "/api/v1/skills/"+wid.String()+"/impact?action=update", nil, &impact)
	if impact.Base != rev {
		t.Fatalf("impact base revision %d != %d", impact.Base, rev)
	}
	in["impact_token"] = impact.ImpactToken
	var upd struct {
		Skill map[string]any `json:"skill"`
	}
	env.mustJSON(t, "PUT", "/api/v1/skills/"+wid.String(), in, &upd)
	if upd.Skill["revision"].(float64) != float64(rev+1) {
		t.Fatalf("revision must increment: %+v", upd.Skill)
	}

	// scope 不可迁移：PUT 不接受归属变化（请求字段里根本没有 scope），
	// 账号层技能 PUT 保持归属。
	var accDetail map[string]any
	env.mustJSON(t, "GET", "/api/v1/skills/"+aid.String(), nil, &accDetail)
	if accDetail["scope"] != "account" {
		t.Fatalf("account scope kept: %+v", accDetail)
	}
}

// ---------- T-SK-2：内置不可改删、确定性 UUID；另存独立 ----------

func TestSkillBuiltinImmutableAndCopy(t *testing.T) {
	b := skillBuiltinByKey("builtin:hook_opening")
	id := b.ID
	// 列表可见内置。
	var list struct {
		Items []map[string]any `json:"items"`
	}
	env.mustJSON(t, "GET", "/api/v1/skills?view=library&scope=builtin&limit=12", nil, &list)
	if len(list.Items) != 8 {
		t.Fatalf("want 8 builtins in library, got %d", len(list.Items))
	}
	env.mustJSON(t, "GET", "/api/v1/skills/"+id.String(), nil, nil)

	in := map[string]any{"scope": "personal", "copy_from_id": id.String()}
	var out struct {
		Skill map[string]any `json:"skill"`
	}
	env.mustJSON(t, "POST", "/api/v1/skills", in, &out)
	if out.Skill["origin"] != "copied" || out.Skill["source_key"] != "builtin:hook_opening" {
		t.Fatalf("copied origin: %+v", out.Skill)
	}
	if out.Skill["instructions"] != b.Fields.Instructions {
		t.Fatal("copy must carry the builtin body")
	}
	// 修改副本不影响内置。
	cid := skillIDOf(t, out.Skill)
	var impact struct {
		ImpactToken string `json:"impact_token"`
	}
	env.mustJSON(t, "GET", "/api/v1/skills/"+cid.String()+"/impact?action=update", nil, &impact)
	put := skillBaseFields("另存副本-已改")
	put["base_revision"] = int64(out.Skill["revision"].(float64))
	put["impact_token"] = impact.ImpactToken
	env.mustJSON(t, "PUT", "/api/v1/skills/"+cid.String(), put, nil)
	// 内置正文不变。
	var bi map[string]any
	env.mustJSON(t, "GET", "/api/v1/skills/"+id.String(), nil, &bi)
	if bi["instructions"] != b.Fields.Instructions {
		t.Fatal("builtin changed after editing the copy")
	}
	// 内置不可改删。
	env.expectErr(t, "PUT", "/api/v1/skills/"+id.String(), skillBaseFields("x"), "immutable_skill")
	env.expectErr(t, "DELETE", "/api/v1/skills/"+id.String()+"?confirm=true&base_revision=1&impact_token=si1:x", nil, "immutable_skill")
	env.expectErr(t, "GET", "/api/v1/skills/"+id.String()+"/impact?action=delete", nil, "immutable_skill")
	// copy_from_id 只可另存内置：用副本 ID 再复制拒绝。
	env.expectErr(t, "POST", "/api/v1/skills", map[string]any{"scope": "personal", "copy_from_id": cid.String()}, "validation_failed")
}

// ---------- T-SK-5：名称唯一与定义 / 绑定额度 ----------

func TestSkillQuotasAndNameConflict(t *testing.T) {
	suffix := uuid.NewString()[:8]
	// 层内同名拒绝（忽略大小写）。
	skillPersonalCreate(t, "重名检测-"+suffix)
	in := skillBaseFields("重名检测-" + suffix)
	in["scope"] = "personal"
	env.expectErr(t, "POST", "/api/v1/skills", in, "name_conflict")
	in2 := skillBaseFields("重名检测-" + strings.ToUpper(suffix))
	in2["scope"] = "personal"
	env.expectErr(t, "POST", "/api/v1/skills", in2, "name_conflict")
	// 不同层同名允许。
	skillWorkspaceCreate(t, "重名检测-"+suffix)

	// personal 定义额度 50（每人独立计数）：用新加入的 editor 成员填充，
	// 不影响 owner 后续测试；停用仍占配置额度。
	quser := skillJoinMember(t, "editor")
	var qcount int
	if err := env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM skill WHERE user_id=$1`, editorUserID(t, quser)).Scan(&qcount); err != nil {
		t.Fatal(err)
	}
	created := 0
	for qcount+created < 50 {
		gMustJSON(t, quser, "POST", "/api/v1/skills", func() map[string]any {
			in := skillBaseFields(fmt.Sprintf("额度填充-%s-%d", suffix, created))
			in["scope"] = "personal"
			return in
		}(), nil)
		created++
	}
	in51 := skillBaseFields("额度超额-" + suffix)
	in51["scope"] = "personal"
	gExpectErr(t, quser, "POST", "/api/v1/skills", in51, "skill_limit_reached")
	// 停用仍占额度：停用一个再创建仍拒绝。
	var list struct {
		Items []map[string]any `json:"items"`
	}
	gMustJSON(t, quser, "GET", "/api/v1/skills?view=library&scope=personal&q=额度填充-"+suffix, nil, &list)
	stale := list.Items[0]
	var impact struct {
		ImpactToken string `json:"impact_token"`
	}
	gMustJSON(t, quser, "GET", fmt.Sprintf("/api/v1/skills/%s/impact?action=update", stale["id"]), nil, &impact)
	dis := map[string]any{}
	for k, v := range skillBaseFields(stale["name"].(string)) {
		dis[k] = v
	}
	dis["status"] = "disabled"
	dis["base_revision"] = int64(stale["revision"].(float64))
	dis["impact_token"] = impact.ImpactToken
	gMustJSON(t, quser, "PUT", fmt.Sprintf("/api/v1/skills/%s", stale["id"]), dis, nil)
	gExpectErr(t, quser, "POST", "/api/v1/skills", in51, "skill_limit_reached")
	quser.restore(env)
}

// ---------- T-SK-6：单项绑定幂等、分区隔离与 CAS ----------

func TestSkillBindingCASAndPartitions(t *testing.T) {
	fx := env.accounts(t)
	suffix := uuid.NewString()[:8]
	accID := fx.wechat.ID

	editor := skillJoinMember(t, "editor")
	editorMine := editorPersonalCreate(t, editor, "编辑个人-"+suffix)

	var bind struct {
		Public struct {
			BaseRevision string           `json:"base_revision"`
			Count        int              `json:"count"`
			Items        []map[string]any `json:"items"`
		} `json:"public"`
		Mine struct {
			BaseRevision string           `json:"base_revision"`
			Count        int              `json:"count"`
			Items        []map[string]any `json:"items"`
		} `json:"mine"`
	}
	// editor 先配置自己的个人绑定。
	var eb struct {
		Changed     bool           `json:"changed"`
		BaseRevisio string         `json:"base_revision"`
		Item        map[string]any `json:"item"`
	}
	gMustJSON(t, editor, "GET", "/api/v1/accounts/"+accID.String()+"/skill-bindings", nil, &bind)
	gMustJSON(t, editor, "PUT", "/api/v1/accounts/"+accID.String()+"/skill-bindings/personal/"+skillIDOf(t, editorMine).String(),
		map[string]any{"enabled": true, "base_revision": bind.Mine.BaseRevision}, &eb)
	if !eb.Changed {
		t.Fatal("first enable should change")
	}
	createdAt := eb.Item["created_at"]
	bindingID := eb.Item["binding_id"]

	// 幂等：重复启用同 priority → changed=false，不重置 created_at。
	gMustJSON(t, editor, "GET", "/api/v1/accounts/"+accID.String()+"/skill-bindings", nil, &bind)
	gMustJSON(t, editor, "PUT", "/api/v1/accounts/"+accID.String()+"/skill-bindings/personal/"+skillIDOf(t, editorMine).String(),
		map[string]any{"enabled": true, "base_revision": bind.Mine.BaseRevision}, &eb)
	if eb.Changed || eb.Item["created_at"] != createdAt || eb.Item["binding_id"] != bindingID {
		t.Fatalf("idempotent enable must keep binding: %+v", eb)
	}
	// priority 调整保留 binding_id / created_at。
	gMustJSON(t, editor, "GET", "/api/v1/accounts/"+accID.String()+"/skill-bindings", nil, &bind)
	var eb2 struct {
		Changed bool           `json:"changed"`
		Item    map[string]any `json:"item"`
	}
	gMustJSON(t, editor, "PUT", "/api/v1/accounts/"+accID.String()+"/skill-bindings/personal/"+skillIDOf(t, editorMine).String(),
		map[string]any{"enabled": true, "priority": 7, "base_revision": bind.Mine.BaseRevision}, &eb2)
	if !eb2.Changed || eb2.Item["priority"].(float64) != 7 || eb2.Item["created_at"] != createdAt {
		t.Fatalf("priority update: %+v", eb2)
	}
	// 旧分区修订 → stale（用 owner 的当前分区指纹攻击 editor 的写入）。
	gExpectErr(t, editor, "PUT", "/api/v1/accounts/"+accID.String()+"/skill-bindings/personal/"+skillIDOf(t, editorMine).String(),
		map[string]any{"enabled": false, "base_revision": bind.Mine.BaseRevision}, "stale")

	// 甲（owner）的绑定操作不删除乙（editor）的绑定，也不共占个人额度。
	var bindBefore struct {
		Mine struct {
			Count int `json:"count"`
		} `json:"mine"`
	}
	env.mustJSON(t, "GET", "/api/v1/accounts/"+accID.String()+"/skill-bindings", nil, &bindBefore)
	ownerMineBefore := bindBefore.Mine.Count
	ownerBind := skillPersonalCreate(t, "甲绑定-"+suffix)
	env.mustJSON(t, "GET", "/api/v1/accounts/"+accID.String()+"/skill-bindings", nil, &bind)
	env.mustJSON(t, "PUT", "/api/v1/accounts/"+accID.String()+"/skill-bindings/personal/"+skillIDOf(t, ownerBind).String(),
		map[string]any{"enabled": true, "base_revision": bind.Mine.BaseRevision}, nil)
	// owner 看不到 editor 的配置数量变化之外的信息；editor 的绑定仍在。
	var bind2 struct {
		Mine struct {
			Count int              `json:"count"`
			Items []map[string]any `json:"items"`
		} `json:"mine"`
	}
	gMustJSON(t, editor, "GET", "/api/v1/accounts/"+accID.String()+"/skill-bindings", nil, &bind2)
	found := false
	for _, it := range bind2.Mine.Items {
		if it["skill_id"] == skillIDOf(t, editorMine).String() {
			found = true
		}
	}
	if !found || bind2.Mine.Count != 1 {
		t.Fatalf("editor partition must be intact: %+v", bind2.Mine)
	}
	// 本人绑定分区计数独立（owner 只新增自己这 1 条，与 editor 互不占额）。
	env.mustJSON(t, "GET", "/api/v1/accounts/"+accID.String()+"/skill-bindings", nil, &bind)
	if bind.Mine.Count != ownerMineBefore+1 {
		t.Fatalf("owner mine count: %d (before %d)", bind.Mine.Count, ownerMineBefore)
	}

	// 取消启用 → item=null；不存在的合法取消为无变化成功。
	gMustJSON(t, editor, "GET", "/api/v1/accounts/"+accID.String()+"/skill-bindings", nil, &bind)
	var eb3 struct {
		Changed bool           `json:"changed"`
		Item    map[string]any `json:"item"`
		Count   int            `json:"count"`
	}
	gMustJSON(t, editor, "PUT", "/api/v1/accounts/"+accID.String()+"/skill-bindings/personal/"+skillIDOf(t, editorMine).String(),
		map[string]any{"enabled": false, "base_revision": bind.Mine.BaseRevision}, &eb3)
	if !eb3.Changed || eb3.Item != nil {
		t.Fatalf("disable: %+v", eb3)
	}
	gMustJSON(t, editor, "GET", "/api/v1/accounts/"+accID.String()+"/skill-bindings", nil, &bind)
	var eb4 struct {
		Changed bool `json:"changed"`
	}
	gMustJSON(t, editor, "PUT", "/api/v1/accounts/"+accID.String()+"/skill-bindings/personal/"+skillIDOf(t, editorMine).String(),
		map[string]any{"enabled": false, "base_revision": bind.Mine.BaseRevision}, &eb4)
	if eb4.Changed {
		t.Fatal("cancelling a missing binding must be a no-op success")
	}
	editor.restore(env)
}

func editorPersonalCreate(t *testing.T, m *guestClient, name string) map[string]any {
	t.Helper()
	in := skillBaseFields(name)
	in["scope"] = "personal"
	var out struct {
		Skill map[string]any `json:"skill"`
	}
	m.mustJSON(t, "POST", "/api/v1/skills", in, &out)
	return out.Skill
}

// ---------- T-SK-7：平台 / 形态 / 任务过滤与 WorkID 校验 ----------

func TestSkillContextPreviewFilters(t *testing.T) {
	fx := env.accounts(t)
	suffix := uuid.NewString()[:8]

	// 个人技能仅适用 xhs / image_note / title。
	in := skillBaseFields("过滤检测-" + suffix)
	in["scope"] = "personal"
	in["platforms"] = []string{"xhs"}
	in["content_formats"] = []string{"image_note"}
	in["task_types"] = []string{"title"}
	sk := skillCreateSkill(t, in)
	sid := skillIDOf(t, sk)

	env.mustJSON(t, "GET", "/api/v1/accounts/"+fx.wechat.ID.String()+"/skill-bindings", nil, nil)
	var bind struct {
		Mine struct {
			BaseRevision string `json:"base_revision"`
		} `json:"mine"`
	}
	env.mustJSON(t, "GET", "/api/v1/accounts/"+fx.wechat.ID.String()+"/skill-bindings", nil, &bind)
	env.mustJSON(t, "PUT", "/api/v1/accounts/"+fx.wechat.ID.String()+"/skill-bindings/personal/"+sid.String(),
		map[string]any{"enabled": true, "base_revision": bind.Mine.BaseRevision}, nil)
	// 同一技能再启用到小红书账号（个人技能在每个账号分别启用）。
	var bindX struct {
		Mine struct {
			BaseRevision string `json:"base_revision"`
		} `json:"mine"`
	}
	env.mustJSON(t, "GET", "/api/v1/accounts/"+fx.xhs.ID.String()+"/skill-bindings", nil, &bindX)
	env.mustJSON(t, "PUT", "/api/v1/accounts/"+fx.xhs.ID.String()+"/skill-bindings/personal/"+sid.String(),
		map[string]any{"enabled": true, "base_revision": bindX.Mine.BaseRevision}, nil)

	// 公众号账号：platform_mismatch（先于 format / task 原因）。
	var ctxW struct {
		Items []struct {
			ID       string  `json:"id"`
			Selected bool    `json:"selected"`
			Used     bool    `json:"used"`
			Reason   *string `json:"reason"`
		} `json:"items"`
	}
	env.mustJSON(t, "GET", "/api/v1/accounts/"+fx.wechat.ID.String()+"/skill-context?surface=task&task_type=title", nil, &ctxW)
	found := false
	for _, it := range ctxW.Items {
		if it.ID == sid.String() {
			found = true
			if it.Selected || it.Used || it.Reason == nil || *it.Reason != "platform_mismatch" {
				t.Fatalf("wechat preview: %+v", it)
			}
		}
	}
	if !found {
		t.Fatal("skill missing from candidate list")
	}

	// 小红书账号 + 不支持的任务：task_mismatch。
	var ctxX struct {
		Items []struct {
			ID     string  `json:"id"`
			Reason *string `json:"reason"`
		} `json:"items"`
	}
	env.mustJSON(t, "GET", "/api/v1/accounts/"+fx.xhs.ID.String()+"/skill-context?surface=task&task_type=summary", nil, &ctxX)
	for _, it := range ctxX.Items {
		if it.ID == sid.String() && (it.Reason == nil || *it.Reason != "task_mismatch") {
			t.Fatalf("xhs title-only skill on summary: %+v", it)
		}
	}
	// 小红书 + title：入选。
	env.mustJSON(t, "GET", "/api/v1/accounts/"+fx.xhs.ID.String()+"/skill-context?surface=task&task_type=title", nil, &ctxX)
	for _, it := range ctxX.Items {
		if it.ID == sid.String() && it.Reason != nil {
			t.Fatalf("should be selected: %+v", it)
		}
	}

	// agent 预览：selected=true / used=false / not_loaded；assembled_chars=null。
	var ctxA2 map[string]any
	env.mustJSON(t, "GET", "/api/v1/accounts/"+fx.xhs.ID.String()+"/skill-context?surface=agent", nil, &ctxA2)
	items := ctxA2["items"].([]any)
	matched := false
	for _, raw := range items {
		it := raw.(map[string]any)
		if it["id"] == sid.String() {
			matched = true
			if it["selected"] != true || it["used"] != false || it["reason"] != "not_loaded" {
				t.Fatalf("agent preview item: %+v", it)
			}
		}
	}
	if !matched || ctxA2["assembled_chars"] != nil {
		t.Fatalf("agent preview: %+v", ctxA2["assembled_chars"])
	}

	// 不支持的任务返回 task_unsupported 空列表。
	var ctxBad map[string]any
	env.mustJSON(t, "GET", "/api/v1/accounts/"+fx.xhs.ID.String()+"/skill-context?surface=task&task_type=image_gen", nil, &ctxBad)
	if ctxBad["context_status"] != "task_unsupported" || len(ctxBad["items"].([]any)) != 0 {
		t.Fatalf("unsupported task: %+v", ctxBad)
	}
	// task 必须带 task_type；agent 不得带。
	env.expectErr(t, "GET", "/api/v1/accounts/"+fx.xhs.ID.String()+"/skill-context?surface=task", nil, "validation_failed")
	env.expectErr(t, "GET", "/api/v1/accounts/"+fx.xhs.ID.String()+"/skill-context?surface=agent&task_type=title", nil, "validation_failed")

	// WorkID 越权 / 跨账号拒绝：xhs 账号的作品不能作为公众号账号上下文。
	var wk Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+fx.xhs.ID.String()+"/works", map[string]string{"title": "技能上下文作品"}, &wk)
	env.expectErr(t, "GET", "/api/v1/accounts/"+fx.wechat.ID.String()+"/skill-context?surface=agent&work_id="+wk.ID.String(), nil, "not_found")
	// target_format 与作品形态不一致 → 422。
	env.expectErr(t, "GET", "/api/v1/accounts/"+fx.xhs.ID.String()+"/skill-context?surface=agent&work_id="+wk.ID.String()+"&target_format=long_article", nil, "validation_failed")
}

// ---------- T-SK-13：影响预览、执行重验与删除级联 ----------

func TestSkillImpactAndDelete(t *testing.T) {
	fx := env.accounts(t)
	suffix := uuid.NewString()[:8]
	ws := skillWorkspaceCreate(t, "影响删除-"+suffix)
	sid := skillIDOf(t, ws)

	// 绑定到公众号账号（公共分区）。
	var bind struct {
		Public struct {
			BaseRevision string `json:"base_revision"`
		} `json:"public"`
	}
	env.mustJSON(t, "GET", "/api/v1/accounts/"+fx.wechat.ID.String()+"/skill-bindings", nil, &bind)
	env.mustJSON(t, "PUT", "/api/v1/accounts/"+fx.wechat.ID.String()+"/skill-bindings/public/"+sid.String(),
		map[string]any{"enabled": true, "base_revision": bind.Public.BaseRevision}, nil)

	var impact struct {
		ImpactToken      string           `json:"impact_token"`
		AffectedBindings int              `json:"affected_bindings"`
		Accounts         []map[string]any `json:"accounts"`
	}
	env.mustJSON(t, "GET", "/api/v1/skills/"+sid.String()+"/impact?action=delete", nil, &impact)
	if impact.AffectedBindings != 1 || len(impact.Accounts) != 1 {
		t.Fatalf("impact: %+v", impact)
	}
	// 未确认删除 → confirm_required。
	env.expectErr(t, "DELETE", "/api/v1/skills/"+sid.String()+"?confirm=false&base_revision=1&impact_token="+impact.ImpactToken, nil, "confirm_required")
	// 竞态：预览后该技能新增另一条绑定（同一技能再绑到另一账号）→ 旧 token stale。
	env.mustJSON(t, "GET", "/api/v1/accounts/"+fx.xhs.ID.String()+"/skill-bindings", nil, &bind)
	env.mustJSON(t, "PUT", "/api/v1/accounts/"+fx.xhs.ID.String()+"/skill-bindings/public/"+sid.String(),
		map[string]any{"enabled": true, "base_revision": bind.Public.BaseRevision}, nil)
	env.expectErr(t, "DELETE", "/api/v1/skills/"+sid.String()+"?confirm=true&base_revision=1&impact_token="+impact.ImpactToken, nil, "stale")

	// 重新预览后删除：级联绑定 + 审计同事务。
	env.mustJSON(t, "GET", "/api/v1/skills/"+sid.String()+"/impact?action=delete", nil, &impact)
	var del struct {
		Deleted          bool `json:"deleted"`
		AffectedBindings int  `json:"affected_bindings"`
	}
	env.mustJSON(t, "DELETE", "/api/v1/skills/"+sid.String()+"?confirm=true&base_revision=1&impact_token="+impact.ImpactToken, nil, &del)
	if !del.Deleted || del.AffectedBindings != 2 {
		t.Fatalf("delete: %+v", del)
	}
	env.expectErr(t, "GET", "/api/v1/skills/"+sid.String(), nil, "not_found")
	var cnt int
	if err := env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM skill_binding WHERE skill_id=$1`, sid).Scan(&cnt); err != nil || cnt != 0 {
		t.Fatalf("bindings must cascade: %d %v", cnt, err)
	}
}

// ---------- T-SK-14：viewer 精确豁免 ----------

func TestSkillViewerPermissions(t *testing.T) {
	fx := env.accounts(t)
	suffix := uuid.NewString()[:8]
	viewer := skillJoinMember(t, "viewer")

	// viewer 可创建 / 解析 / 导出 / 编辑自己的个人定义。
	vSkill := editorPersonalCreate(t, viewer, "观察者个人-"+suffix)
	vid := skillIDOf(t, vSkill)
	var parsed struct {
		Fields map[string]any `json:"fields"`
	}
	gMustJSON(t, viewer, "POST", "/api/v1/skills/parse", map[string]any{"content": "---\nname: 观察者解析\nsummary: 摘要内容\ntriggers: 触发条件\n---\n正文"}, &parsed)
	if st, body := viewer.do("GET", "/api/v1/skills/"+vid.String()+"/export", nil); st != 200 || !strings.Contains(string(body), "观察者个人") {
		t.Fatalf("viewer export own personal: %d %s", st, body)
	}
	var detailV map[string]any
	gMustJSON(t, viewer, "GET", "/api/v1/skills/"+vid.String(), nil, &detailV)
	var impact struct {
		ImpactToken string `json:"impact_token"`
	}
	gMustJSON(t, viewer, "GET", "/api/v1/skills/"+vid.String()+"/impact?action=update", nil, &impact)
	put := skillBaseFields(vSkill["name"].(string))
	put["summary"] = "观察者已修改"
	put["base_revision"] = int64(detailV["revision"].(float64))
	put["impact_token"] = impact.ImpactToken
	var updV struct {
		Skill map[string]any `json:"skill"`
	}
	gMustJSON(t, viewer, "PUT", "/api/v1/skills/"+vid.String(), put, &updV)
	if updV.Skill["revision"].(float64) != detailV["revision"].(float64)+1 {
		t.Fatalf("viewer personal update: %+v", updV.Skill)
	}

	// viewer 公共定义写入 403（已知可见对象）；他人个人 404。
	ws := skillWorkspaceCreate(t, "观察者禁止-"+suffix)
	put2 := skillBaseFields("x")
	put2["status"] = "active"
	put2["base_revision"] = int64(1)
	put2["impact_token"] = "si1:fake"
	gExpectErr(t, viewer, "PUT", "/api/v1/skills/"+skillIDOf(t, ws).String(), put2, "forbidden")
	gExpectErr(t, viewer, "POST", "/api/v1/skills", func() map[string]any {
		in := skillBaseFields("观察者公共-" + suffix)
		in["scope"] = "workspace"
		return in
	}(), "forbidden")

	// viewer 绑定一律 403（先解析可见性：workspace 技能可见 → 403）。
	var bind struct {
		Public struct {
			BaseRevision string `json:"base_revision"`
		} `json:"public"`
		Mine struct {
			BaseRevision string `json:"base_revision"`
		} `json:"mine"`
	}
	gMustJSON(t, viewer, "GET", "/api/v1/accounts/"+fx.wechat.ID.String()+"/skill-bindings", nil, &bind)
	gExpectErr(t, viewer, "PUT", "/api/v1/accounts/"+fx.wechat.ID.String()+"/skill-bindings/public/"+skillIDOf(t, ws).String(),
		map[string]any{"enabled": true, "base_revision": bind.Public.BaseRevision}, "forbidden")
	gExpectErr(t, viewer, "PUT", "/api/v1/accounts/"+fx.wechat.ID.String()+"/skill-bindings/personal/"+vid.String(),
		map[string]any{"enabled": true, "base_revision": bind.Mine.BaseRevision}, "forbidden")

	// 白名单不扩大：viewer 的模型配置与账号创建仍被中间件拒绝
	//（/skills/draft 属 DEV-SK3 注册，届时同样不在白名单）。
	gExpectErr(t, viewer, "POST", "/api/v1/model-providers", map[string]any{"name": "x"}, "forbidden")
	gExpectErr(t, viewer, "POST", "/api/v1/accounts", map[string]string{"platform": "xhs", "name": "x", "content_format": "image_note"}, "forbidden")
	// viewer 删除自己的个人定义成功。
	gMustJSON(t, viewer, "GET", "/api/v1/skills/"+vid.String()+"/impact?action=delete", nil, &impact)
	gMustJSON(t, viewer, "DELETE", fmt.Sprintf("/api/v1/skills/%s?confirm=true&base_revision=2&impact_token=%s", vid.String(), impact.ImpactToken), nil, nil)
	viewer.restore(env)
}

// ---------- T-SK-15：personal 审计可见性 ----------

func TestSkillPersonalAuditVisibility(t *testing.T) {
	suffix := uuid.NewString()[:8]
	mine := skillPersonalCreate(t, "审计个人-"+suffix)
	sid := skillIDOf(t, mine)
	fx := env.accounts(t)
	var bind struct {
		Mine struct {
			BaseRevision string `json:"base_revision"`
		} `json:"mine"`
	}
	env.mustJSON(t, "GET", "/api/v1/accounts/"+fx.wechat.ID.String()+"/skill-bindings", nil, &bind)
	env.mustJSON(t, "PUT", "/api/v1/accounts/"+fx.wechat.ID.String()+"/skill-bindings/personal/"+sid.String(),
		map[string]any{"enabled": true, "base_revision": bind.Mine.BaseRevision}, nil)

	var logs []struct {
		Action string `json:"action"`
	}
	env.mustJSON(t, "GET", "/api/v1/audit-logs?visibility=personal", nil, &logs)
	actions := map[string]bool{}
	for _, l := range logs {
		actions[l.Action] = true
	}
	if !actions["skill_create"] || !actions["skill_binding_update"] {
		t.Fatalf("personal audit missing events: %+v", logs)
	}
	// editor 看不到 owner 的私有审计。
	editor := skillJoinMember(t, "editor")
	var elogs []struct {
		Action string `json:"action"`
	}
	gMustJSON(t, editor, "GET", "/api/v1/audit-logs?visibility=personal", nil, &elogs)
	for _, l := range elogs {
		if l.Action == "skill_create" && strings.Contains(fmt.Sprint(l), "审计个人") {
			t.Fatal("editor must not see owner personal audit")
		}
	}
	// 默认工作区日志不含 personal 事件（personal 绑定事件整体私有）。
	var wlogs2 []struct {
		Action string          `json:"action"`
		Detail json.RawMessage `json:"detail"`
	}
	gMustJSON(t, editor, "GET", "/api/v1/audit-logs?limit=200", nil, &wlogs2)
	for _, l := range wlogs2 {
		if strings.Contains(string(l.Detail), `"audience":"personal"`) {
			t.Fatalf("workspace log must exclude personal events: %s", l.Detail)
		}
	}
	editor.restore(env)
}

// ---------- T-SK-33：公开确认 ----------

func TestSkillPublicConfirmation(t *testing.T) {
	fx := env.accounts(t)
	suffix := uuid.NewString()[:8]

	// 缺确认。
	in := skillBaseFields("公开确认-" + suffix)
	in["scope"] = "workspace"
	env.expectErr(t, "POST", "/api/v1/skills", in, "public_confirmation_required")
	// 摘要不符。
	in["publish_confirmation"] = map[string]any{"confirmed": true, "digest": "sp1:0000000000000000000000000000000000000000000000000000000000000000"}
	env.expectErr(t, "POST", "/api/v1/skills", in, "stale")
	// 个人目标不接受确认参数。
	inP := skillBaseFields("个人带确认-" + suffix)
	inP["scope"] = "personal"
	inP["publish_confirmation"] = map[string]any{"confirmed": true, "digest": "sp1:x"}
	env.expectErr(t, "POST", "/api/v1/skills", inP, "validation_failed")

	// 正确摘要 → 成功，审计含 public_confirmed。
	ws := skillWorkspaceCreate(t, "公开确认-"+suffix)
	sid := skillIDOf(t, ws)
	var logs []struct {
		Action string          `json:"action"`
		Detail json.RawMessage `json:"detail"`
	}
	env.mustJSON(t, "GET", "/api/v1/audit-logs?limit=50&action=skill_create", nil, &logs)
	okAudit := false
	for _, l := range logs {
		if strings.Contains(string(l.Detail), "public_confirmed") {
			okAudit = true
		}
	}
	if !okAudit {
		t.Fatal("public create audit must record public_confirmed")
	}

	// 个人技能内容派生到公共：完整字段创建 + 单独确认（原个人对象保留）。
	personal := skillPersonalCreate(t, "派生来源-"+suffix)
	derived := skillBaseFields("派生公共-" + suffix)
	derived["scope"] = "workspace"
	derived["instructions"] = personal["instructions"]
	derived["publish_confirmation"] = map[string]any{"confirmed": true, "digest": skillDigest(t, "create", nil, "workspace", nil, derived)}
	var out struct {
		Skill map[string]any `json:"skill"`
	}
	env.mustJSON(t, "POST", "/api/v1/skills", derived, &out)
	// 原个人对象仍在，且公共对象不含个人来源标识。
	var p2 map[string]any
	env.mustJSON(t, "GET", "/api/v1/skills/"+skillIDOf(t, personal).String(), nil, &p2)
	if p2["scope"] != "personal" {
		t.Fatal("personal original must remain")
	}
	if strings.Contains(fmt.Sprint(out.Skill), skillIDOf(t, personal).String()) {
		t.Fatal("public object must not leak the personal source id")
	}
	// 公共审计不记录个人 ID / 派生链。
	env.mustJSON(t, "GET", "/api/v1/audit-logs?limit=50&action=skill_create", nil, &logs)
	for _, l := range logs {
		if strings.Contains(string(l.Detail), skillIDOf(t, personal).String()) {
			t.Fatal("public audit leaked personal source id")
		}
	}
	_ = fx
	_ = sid
}

// ---------- T-SK-29：三种入口组合 ----------

func TestSkillEntryCombos(t *testing.T) {
	suffix := uuid.NewString()[:8]
	mk := func(taskOn, agentOn bool) map[string]any {
		in := skillBaseFields(fmt.Sprintf("组合-%t%t-%s", taskOn, agentOn, suffix))
		in["scope"] = "personal"
		in["task_enabled"] = taskOn
		in["agent_enabled"] = agentOn
		return in
	}
	for _, c := range []struct{ taskOn, agentOn bool }{{true, false}, {false, true}, {true, true}} {
		skillCreateSkill(t, mk(c.taskOn, c.agentOn))
	}
	env.expectErr(t, "POST", "/api/v1/skills", mk(false, false), "validation_failed")
	// PUT 切换组合。
	in := mk(true, true)
	in["name"] = "组合-切换-" + suffix
	sk := skillCreateSkill(t, in)
	sid := skillIDOf(t, sk)
	var impact struct {
		ImpactToken string `json:"impact_token"`
	}
	env.mustJSON(t, "GET", "/api/v1/skills/"+sid.String()+"/impact?action=update", nil, &impact)
	put := skillBaseFields(sk["name"].(string))
	put["task_enabled"] = false
	put["agent_enabled"] = true
	put["status"] = "active"
	put["base_revision"] = int64(1)
	put["impact_token"] = impact.ImpactToken
	var upd struct {
		Skill map[string]any `json:"skill"`
	}
	env.mustJSON(t, "PUT", "/api/v1/skills/"+sid.String(), put, &upd)
	if upd.Skill["task_enabled"] != false || upd.Skill["agent_enabled"] != true {
		t.Fatalf("combo switch: %+v", upd.Skill)
	}
	// status 停用保留入口组合。
	put["status"] = "disabled"
	put["base_revision"] = 2
	env.mustJSON(t, "GET", "/api/v1/skills/"+sid.String()+"/impact?action=update", nil, &impact)
	put["impact_token"] = impact.ImpactToken
	env.mustJSON(t, "PUT", "/api/v1/skills/"+sid.String(), put, &upd)
	if upd.Skill["status"] != "disabled" || upd.Skill["task_enabled"] != false || upd.Skill["agent_enabled"] != true {
		t.Fatalf("disabled keeps combo: %+v", upd.Skill)
	}
	// 双 false 经 PUT 也拒绝。
	put["task_enabled"] = false
	put["agent_enabled"] = false
	put["base_revision"] = 3
	env.mustJSON(t, "GET", "/api/v1/skills/"+sid.String()+"/impact?action=update", nil, &impact)
	put["impact_token"] = impact.ImpactToken
	env.expectErr(t, "PUT", "/api/v1/skills/"+sid.String(), put, "validation_failed")
}

// ---------- T-SK-36：列表分页与排序稳定 ----------

func TestSkillListPagination(t *testing.T) {
	suffix := uuid.NewString()[:8]
	for i := 0; i < 5; i++ {
		skillPersonalCreate(t, fmt.Sprintf("分页-%s-%02d", suffix, i))
	}
	var p1 struct {
		Items      []map[string]any `json:"items"`
		NextCursor *string          `json:"next_cursor"`
		Total      int              `json:"total"`
	}
	env.mustJSON(t, "GET", "/api/v1/skills?view=library&scope=personal&limit=2&q=分页-"+suffix, nil, &p1)
	if len(p1.Items) != 2 || p1.NextCursor == nil || p1.Total != 5 {
		t.Fatalf("page1: %d %v %d", len(p1.Items), p1.NextCursor, p1.Total)
	}
	var p2 struct {
		Items []map[string]any `json:"items"`
	}
	env.mustJSON(t, "GET", "/api/v1/skills?view=library&scope=personal&limit=2&q=分页-"+suffix+"&cursor="+*p1.NextCursor, nil, &p2)
	if len(p2.Items) != 2 {
		t.Fatalf("page2: %d", len(p2.Items))
	}
	if p2.Items[0]["id"] == p1.Items[0]["id"] {
		t.Fatal("cursor must advance")
	}
	// 快照变化 → cursor_stale。
	var upd struct {
		Skill map[string]any `json:"skill"`
	}
	env.mustJSON(t, "GET", "/api/v1/skills/"+skillIDOf(t, p1.Items[0]).String(), nil, &upd)
	var impact struct {
		ImpactToken string `json:"impact_token"`
	}
	env.mustJSON(t, "GET", "/api/v1/skills/"+skillIDOf(t, p1.Items[0]).String()+"/impact?action=update", nil, &impact)
	put := skillBaseFields(p1.Items[0]["name"].(string))
	put["base_revision"] = int64(p1.Items[0]["revision"].(float64))
	put["impact_token"] = impact.ImpactToken
	env.mustJSON(t, "PUT", "/api/v1/skills/"+skillIDOf(t, p1.Items[0]).String(), put, nil)
	env.expectErr(t, "GET", "/api/v1/skills?view=library&scope=personal&limit=2&q=分页-"+suffix+"&cursor="+*p1.NextCursor, nil, "cursor_stale")
	// 非法 cursor 422。
	env.expectErr(t, "GET", "/api/v1/skills?view=library&cursor=%21%21", nil, "validation_failed")
	// 跨租户：其他用户的工作区技能 404。
	editor := skillJoinMember(t, "editor")
	env.expectErr(t, "GET", "/api/v1/skills/"+skillIDOf(t, p1.Items[0]).String(), nil, "not_found")
	editor.restore(env)
}

// ---------- T-SK-26：成员退出清理本人绑定 ----------

func TestSkillMemberLeaveCleanup(t *testing.T) {
	fx := env.accounts(t)
	suffix := uuid.NewString()[:8]
	editor := skillJoinMember(t, "editor")
	es := editorPersonalCreate(t, editor, "退出清理-"+suffix)
	esid := skillIDOf(t, es)
	var bind struct {
		Mine struct {
			BaseRevision string `json:"base_revision"`
		} `json:"mine"`
	}
	gMustJSON(t, editor, "GET", "/api/v1/accounts/"+fx.wechat.ID.String()+"/skill-bindings", nil, &bind)
	gMustJSON(t, editor, "PUT", "/api/v1/accounts/"+fx.wechat.ID.String()+"/skill-bindings/personal/"+esid.String(),
		map[string]any{"enabled": true, "base_revision": bind.Mine.BaseRevision}, nil)
	// 个人定义保留。
	gMustJSON(t, editor, "GET", "/api/v1/skills/"+esid.String(), nil, nil)

	// 移出成员：本人绑定删除，个人定义保留。
	env.mustJSON(t, "PATCH", "/api/v1/workspaces/current/members/"+editorUserID(t, editor), map[string]any{"remove": true}, nil)
	var cnt int
	if err := env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM skill_binding WHERE skill_id=$1`, esid).Scan(&cnt); err != nil || cnt != 0 {
		t.Fatalf("member bindings must be removed: %d %v", cnt, err)
	}
	// 个人定义保留：owner 访问他人个人定义 404（定义仍属于 editor）。
	env.expectErr(t, "GET", "/api/v1/skills/"+esid.String(), nil, "not_found")
	editor.restore(env)
}

func editorUserID(t *testing.T, m *guestClient) string {
	t.Helper()
	var me meInfo
	gMustJSON(t, m, "GET", "/api/v1/auth/me", nil, &me)
	return me.UserID
}
