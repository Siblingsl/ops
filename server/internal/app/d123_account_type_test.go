package app

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/google/uuid"
)

// D-123 / DEV-415：账号类型同平台内可迁移。已有作品按作品级快照保持原类型，
// 迁移不动历史数据；但 D-048「新建作品必须与账号当前类型一致」不变——
// 迁移前生成的推荐/槽位仍是旧类型，采用会被明确拒绝，需重新生成（文档 §2.6-A）。

// T-123-1 / T-123-7：迁移成功、返回影响摘要、落库。
func TestD123AccountTypeMigrate(t *testing.T) {
	var a Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{"platform": "wechat_mp", "name": "迁移号", "content_format": "long_article"}, &a)
	p := "/api/v1/accounts/" + a.ID.String()

	var out struct {
		Account    Account        `json:"account"`
		TypeChange map[string]any `json:"type_change"`
	}
	env.mustJSON(t, "PATCH", p, map[string]any{"content_format": "comic", "confirm_type_change": true}, &out)
	if out.Account.ContentFormat != "comic" {
		t.Fatalf("type not migrated: %+v", out.Account)
	}
	if out.TypeChange["works_kept"] == nil || out.TypeChange["character_cards_kept"] == nil {
		t.Fatalf("type_change summary missing: %+v", out.TypeChange)
	}
	var got Account
	env.mustJSON(t, "GET", p, nil, &got)
	if got.ContentFormat != "comic" {
		t.Fatalf("persisted type: %s", got.ContentFormat)
	}
}

// T-123-2：迁移后旧作品仍可按原类型推送（长图文走图文草稿）。
func TestD123ExistingWorkKeepsOwnFormat(t *testing.T) {
	var a Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{"platform": "wechat_mp", "name": "混合态号", "content_format": "long_article"}, &a)
	p := "/api/v1/accounts/" + a.ID.String()
	wk := env.readyWork(t, a, "把复杂的事情讲清楚")
	if wk.Status != "ready" {
		t.Fatalf("want ready, got %s", wk.Status)
	}
	env.reauth(t)
	env.mustJSON(t, "PUT", "/api/v1/accounts/"+a.ID.String()+"/wechat-credential",
		map[string]string{"app_id": "wx-d100-appid", "app_secret": "d100-app-secret-abcdef"}, nil)

	env.mustJSON(t, "PATCH", p, map[string]any{"content_format": "comic", "confirm_type_change": true}, nil)
	var got Account
	env.mustJSON(t, "GET", p, nil, &got)
	if got.ContentFormat != "comic" {
		t.Fatalf("migrate failed: %s", got.ContentFormat)
	}

	// 旧的长图文作品仍按长图文推送
	var after Work
	env.mustJSON(t, "GET", "/api/v1/works/"+wk.ID.String(), nil, &after)
	if after.ContentFormat != "long_article" {
		t.Fatalf("work format changed: %s", after.ContentFormat)
	}
	body := "这是用于迁移回归的正文。"
	for i := range after.Sections {
		sec := after.Sections[i]
		if sec.ContentMD == "" {
			env.mustJSON(t, "PATCH", "/api/v1/sections/"+sec.ID.String(),
				map[string]any{"content_md": body + string(rune('0'+i)), "base_revision": sec.Revision}, nil)
		}
	}
	evs := env.sse(t, "/api/v1/works/"+wk.ID.String()+"/wechat/push", map[string]any{
		"revision": after.Revision, "html": "<p>" + body + "</p>", "fields": map[string]any{}})
	last := lastEvent(t, evs)
	if last.Name != "done" {
		t.Fatalf("push after migrate: %s %s", last.Name, last.Data)
	}
}

// T-123-3：迁移后新建作品使用新类型。
func TestD123NewWorkUsesNewFormat(t *testing.T) {
	var a Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{"platform": "wechat_mp", "name": "新作品类型", "content_format": "long_article"}, &a)
	p := "/api/v1/accounts/" + a.ID.String()
	env.mustJSON(t, "PATCH", p, map[string]any{"content_format": "comic", "confirm_type_change": true}, nil)
	var wk Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+a.ID.String()+"/works", map[string]string{"title": "迁移后的新作品"}, &wk)
	if wk.ContentFormat != "comic" {
		t.Fatalf("new work format: %s", wk.ContentFormat)
	}
}

// T-123-4：无显式确认不执行迁移。
func TestD123TypeChangeRequiresExplicitConfirm(t *testing.T) {
	var a Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{"platform": "xhs", "name": "确认门", "content_format": "image_note"}, &a)
	p := "/api/v1/accounts/" + a.ID.String()
	env.expectErr(t, "PATCH", p, map[string]string{"content_format": "comic"}, "confirm_required")
	env.expectErr(t, "PATCH", p, map[string]any{"content_format": "comic", "confirm": true}, "confirm_required")
	env.expectErr(t, "PATCH", p, map[string]any{"content_format": "comic", "confirm_type_change": false}, "confirm_required")
	var got Account
	env.mustJSON(t, "GET", p, nil, &got)
	if got.ContentFormat != "image_note" {
		t.Fatalf("type changed without explicit confirm: %s", got.ContentFormat)
	}
}

// T-123-5：跨平台与矩阵外类型拒绝。
func TestD123TypeChangeRejectsCrossPlatform(t *testing.T) {
	var a Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{"platform": "wechat_mp", "name": "跨平台门", "content_format": "comic"}, &a)
	p := "/api/v1/accounts/" + a.ID.String()
	env.expectErr(t, "PATCH", p, map[string]any{"content_format": "image_note", "confirm_type_change": true}, "validation_failed")
	env.expectErr(t, "PATCH", p, map[string]any{"content_format": "nonsense", "confirm_type_change": true}, "validation_failed")
	var got Account
	env.mustJSON(t, "GET", p, nil, &got)
	if got.ContentFormat != "comic" {
		t.Fatalf("type changed on rejected attempt: %s", got.ContentFormat)
	}
}

// T-123-8：迁出 comic 后角色卡仍可管理（comic.go:55 兜底：仍有漫画作品时放行）。
func TestD123CharacterCardsAfterLeavingComic(t *testing.T) {
	var a Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{"platform": "wechat_mp", "name": "转出漫画", "content_format": "comic"}, &a)
	var wk Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+a.ID.String()+"/works", map[string]string{"title": "转出前的漫画"}, &wk)
	env.mustJSON(t, "PUT", "/api/v1/works/"+wk.ID.String()+"/storyboard", map[string]any{
		"panels": []map[string]any{
			{"scene": "场景一", "action": "动作", "shot": "中景", "narration": "旁白", "dialogue": "对白"},
			{"scene": "场景二", "action": "动作", "shot": "近景", "narration": "旁白", "dialogue": "对白"},
		},
		"confirm": true,
	}, nil)

	env.mustJSON(t, "PATCH", "/api/v1/accounts/"+a.ID.String(), map[string]any{
		"content_format": "long_article", "confirm_type_change": true}, nil)

	st, body := env.do("POST", "/api/v1/accounts/"+a.ID.String()+"/characters", map[string]any{
		"name": "小砚", "appearance": "黑发", "personality": "冷静", "catchphrase": "先看证据"})
	if st != 200 {
		t.Fatalf("character create after leaving comic: %d %s", st, body)
	}
	var ch struct {
		ID uuid.UUID `json:"id"`
	}
	if err := json.Unmarshal(body, &ch); err != nil {
		t.Fatal(err)
	}
	if ch.ID == uuid.Nil {
		t.Fatal("character card not created")
	}
}

// T-123-6：viewer 成员无权迁移账号类型，且失败后类型保持不变。
func TestD123TypeChangeForbiddenForViewer(t *testing.T) {
	a, _ := v4Account(t, "类型迁移权限")
	guest := env.registerClient(t, "d100-viewer-"+uuid.NewString()[:8], testPassword)
	t.Cleanup(func() { guest.restore(env) })
	guest.restore(env)
	var invite struct {
		Code string `json:"code"`
	}
	env.mustJSON(t, "POST", "/api/v1/workspaces/current/invites", map[string]any{"role": "viewer", "max_uses": 1, "days": 1}, &invite)
	guest.mustJSON(t, "POST", "/api/v1/workspaces/join", map[string]any{"code": invite.Code, "switch": true}, nil)
	var me struct {
		CSRF string `json:"csrf_token"`
	}
	guest.mustJSON(t, "GET", "/api/v1/auth/me", nil, &me)
	guest.csrf = me.CSRF
	guest.expectErr(t, "PATCH", "/api/v1/accounts/"+a.ID.String(), map[string]any{
		"content_format": "comic", "confirm_type_change": true}, "forbidden")
	guest.restore(env)
	var got Account
	env.mustJSON(t, "GET", "/api/v1/accounts/"+a.ID.String(), nil, &got)
	if got.ContentFormat != "image_note" {
		t.Fatalf("viewer changed account type: %s", got.ContentFormat)
	}
}

// T-123-10：迁移前生成的槽位采用被拒且说明原因；启用新版本方案后，未采用的槽位
// 按账号当前类型重建，采用后的选题形态 = 新类型（D-048 第 5.6 节）。
func TestD123PlanSlotsRebuiltAfterMigrate(t *testing.T) {
	a, path := v4Account(t, "槽位迁移")
	opts, call := positioningOptions(t, path)
	ok := opts[0].StrategyFields
	ok.Cadence.Format = ""
	strategyBody := func(niche string) map[string]any {
		return map[string]any{"niche": niche, "audience": ok.Audience, "differentiation": ok.Differentiation,
			"persona": ok.Persona, "pillars": ok.Pillars, "cadence": ok.Cadence, "stage": "cold_start",
			"keywords": ok.Keywords, "daily_settings": ok.DailySettings}
	}
	first := strategyBody(ok.Niche)
	first["ai_call_id"] = call
	env.mustJSON(t, "POST", path+"/strategy", first, nil)
	var plan struct {
		Slots []PlanSlot `json:"slots"`
	}
	env.mustJSON(t, "GET", path+"/plan", nil, &plan)
	if len(plan.Slots) == 0 {
		t.Fatal("no slots")
	}
	for _, s := range plan.Slots {
		if s.Format != "image_note" {
			t.Fatalf("pre-migrate slot format: %s", s.Format)
		}
	}
	old := plan.Slots[0]

	env.mustJSON(t, "PATCH", path, map[string]any{"content_format": "comic", "confirm_type_change": true}, nil)

	// 迁移前的旧类型槽位采用被拒绝，并给出可执行出路。
	ae := env.expectErr(t, "POST", "/api/v1/plan-slots/"+old.ID.String()+"/adopt",
		map[string]string{"title": "迁移前的旧槽位"}, "state_invalid")
	if !strings.Contains(ae.Error.Message, "形态") {
		t.Fatalf("adopt should explain the format mismatch: %s", ae.Error.Message)
	}

	// 启用新版本方案：今天起未采用的槽位按账号当前类型重建。
	env.mustJSON(t, "POST", path+"/strategy", strategyBody(ok.Niche+"（迁移后）"), nil)
	plan.Slots = nil
	env.mustJSON(t, "GET", path+"/plan", nil, &plan)
	if len(plan.Slots) == 0 {
		t.Fatal("slots not rebuilt")
	}
	var target *PlanSlot
	for i := range plan.Slots {
		s := &plan.Slots[i]
		if s.Status == "adopted" {
			t.Fatalf("nothing was adopted, got adopted slot %s", s.ID)
		}
		if s.Format != "comic" {
			t.Fatalf("rebuilt slot format: %s", s.Format)
		}
		if target == nil {
			target = s
		}
	}
	var adopted struct {
		TopicID string `json:"topic_id"`
	}
	env.mustJSON(t, "POST", "/api/v1/plan-slots/"+target.ID.String()+"/adopt",
		map[string]string{"title": "迁移后的新槽位"}, &adopted)
	var tf string
	if e := env.srv.db.QueryRow(context.Background(), `SELECT coalesce(format,'') FROM topic WHERE id=$1`, adopted.TopicID).Scan(&tf); e != nil || tf != "comic" {
		t.Fatalf("adopted topic format: %s %v", tf, e)
	}
	var stale int
	if e := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM account_plan_slot WHERE account_id=$1 AND status<>'adopted' AND format<>'comic'`, a.ID).Scan(&stale); e != nil || stale != 0 {
		t.Fatalf("stale slots remain: %d %v", stale, e)
	}
}

// T-123-11：生成任务带作品上下文时，提示词档案用作品级类型并标「本作品类型」，
// 不能把迁移前的旧作品类型误标成账号类型。
func TestD123ProfileTextUsesWorkFormat(t *testing.T) {
	a, path := v4Account(t, "提示词类型")
	var wk Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+a.ID.String()+"/works", map[string]string{"title": "迁移前的图文笔记"}, &wk)
	env.mustJSON(t, "PATCH", path, map[string]any{"content_format": "comic", "confirm_type_change": true}, nil)
	var acc Account
	env.mustJSON(t, "GET", path, nil, &acc)
	if acc.ContentFormat != "comic" {
		t.Fatalf("migrate failed: %s", acc.ContentFormat)
	}
	ctx := context.Background()
	prof, err := env.srv.loadProfile(ctx, a.ID)
	if err != nil {
		t.Fatal(err)
	}
	withWork := env.srv.profileText(ctx, &acc, prof, &wk.ID)
	if !strings.Contains(withWork, "本作品类型：图文笔记") {
		t.Fatalf("work context should label the work format: %s", withWork)
	}
	if strings.Contains(withWork, "账号类型：") {
		t.Fatalf("work context must not label the old format as the account type: %s", withWork)
	}
	without := env.srv.profileText(ctx, &acc, prof, nil)
	if !strings.Contains(without, "账号类型：漫画") {
		t.Fatalf("account context should use the account format: %s", without)
	}
}

// T-123-12：看板待办行带作品级类型（§2.7），迁移后新旧作品类型混杂也能逐行标注。
func TestD123DashboardTodosCarryWorkFormat(t *testing.T) {
	a, path := v4Account(t, "看板类型")
	var older Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+a.ID.String()+"/works", map[string]string{"title": "迁移前的作品"}, &older)
	env.mustJSON(t, "PATCH", path, map[string]any{"content_format": "comic", "confirm_type_change": true}, nil)
	var newer Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+a.ID.String()+"/works", map[string]string{"title": "迁移后的作品"}, &newer)

	var dash struct {
		Todos []struct {
			WorkID string `json:"work_id"`
			Format string `json:"content_format"`
		} `json:"todos"`
	}
	env.mustJSON(t, "GET", path+"/dashboard", nil, &dash)
	seen := map[string]string{}
	for _, td := range dash.Todos {
		seen[td.WorkID] = td.Format
	}
	if seen[older.ID.String()] != "image_note" {
		t.Fatalf("older work format on dashboard: %q (todos=%+v)", seen[older.ID.String()], dash.Todos)
	}
	if seen[newer.ID.String()] != "comic" {
		t.Fatalf("newer work format on dashboard: %q (todos=%+v)", seen[newer.ID.String()], dash.Todos)
	}
}

// T-123-9：迁移后，迁移前生成的跨类型推荐采用被拒绝并说明原因，不创建跨类型作品。
// D-123 只让已有作品保持原类型，不放宽「新建作品须与账号当前类型一致」的 D-048 约束。
func TestD123AdoptDailyRecommendationAfterMigrate(t *testing.T) {
	var a Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{"platform": "xhs", "name": "推荐迁移号", "content_format": "image_note"}, &a)

	rows := []map[string]any{{
		"title":            "迁移后需要重新生成的推荐",
		"angle":            "从真实实践切入",
		"format":           "long_article",
		"hook":             "一个具体问题",
		"needed_materials": []string{"个人经历"},
	}}
	b, _ := json.Marshal(rows)
	var itemID uuid.UUID
	day := env.srv.today().Format("2006-01-02")
	if err := env.srv.db.QueryRow(context.Background(),
		`INSERT INTO daily_recommendation (account_id, date, items, trigger) VALUES ($1,$2,$3,'manual') RETURNING id`,
		a.ID, day, b).Scan(&itemID); err != nil {
		t.Fatal(err)
	}

	// 迁移账号到 comic，再尝试采用这条长图文推荐
	env.mustJSON(t, "PATCH", "/api/v1/accounts/"+a.ID.String(), map[string]any{
		"content_format": "comic", "confirm_type_change": true}, nil)

	ae := env.expectErr(t, "POST", "/api/v1/daily/"+itemID.String()+"/items/0/adopt", map[string]any{}, "state_invalid")
	// 断言"说清了不匹配"，不锁死具体措辞：D-123 之后统一叫"内容形态"，早期文案叫"类型"。
	if !strings.Contains(ae.Error.Message, "内容形态") && !strings.Contains(ae.Error.Message, "类型") {
		t.Fatalf("adopt should explain the type mismatch: %s", ae.Error.Message)
	}
	env.expectErr(t, "POST", "/api/v1/daily/"+itemID.String()+"/items/0/start", nil, "state_invalid")
	var n int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM work WHERE account_id=$1`, a.ID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("migrated account should not gain cross-type works: %d", n)
	}
}
