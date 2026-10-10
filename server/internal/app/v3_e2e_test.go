package app

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"ops/internal/secure"
)

// draftRefs runs one section draft and returns the context slots recorded in the done event.
func draftRefs(t *testing.T, sectionID string) []Slot {
	t.Helper()
	ev := lastEvent(t, env.sse(t, "/api/v1/sections/"+sectionID+"/draft", nil))
	if ev.Name != "done" {
		t.Fatalf("draft: %s %s", ev.Name, ev.Data)
	}
	var done struct {
		Refs struct {
			Slots []Slot `json:"slots"`
		} `json:"refs"`
	}
	if err := json.Unmarshal(ev.Data, &done); err != nil {
		t.Fatal(err)
	}
	return done.Refs.Slots
}

func slotHas(slots []Slot, name, id string) bool {
	for _, s := range slots {
		if s.Name != name {
			continue
		}
		for _, it := range s.Items {
			if it.ID == id && it.Used {
				return true
			}
		}
	}
	return false
}

// D-044：永久超管密码只来自环境变量；未配置时不新建账号，已有账号保留原密码。
func TestPermanentAdminPasswordOnlyFromEnv(t *testing.T) {
	ctx := context.Background()
	orig := env.srv.cfg
	cfg := *orig
	env.srv.cfg = &cfg
	defer func() { env.srv.cfg = orig }()
	cfg.SystemAdminPassword = ""
	cfg.SystemAdminUser = "ghost-admin"
	if err := env.srv.EnsurePermanentAdmin(ctx); err != nil {
		t.Fatal(err)
	}
	var n int
	_ = env.srv.db.QueryRow(ctx, `SELECT count(*) FROM app_user WHERE username='ghost-admin'`).Scan(&n)
	if n != 0 {
		t.Fatal("no admin may be created without a configured password")
	}
	cfg.SystemAdminUser = orig.SystemAdminUser
	if err := env.srv.EnsurePermanentAdmin(ctx); err != nil {
		t.Fatal(err)
	}
	var hash string
	var admin bool
	_ = env.srv.db.QueryRow(ctx, `SELECT password_hash, is_system_admin FROM app_user WHERE lower(username)=lower($1)`, cfg.SystemAdminUser).Scan(&hash, &admin)
	if !admin || !secure.VerifyPassword(testAdminPassword, hash) {
		t.Fatal("existing admin should stay admin and keep its password")
	}
}

// E2E-12：智能建档 → 从 AI 选题开始 → 写完一篇 → 检查 → 写入草稿（模拟模型，全程 ≤ 30 分钟）。
func TestE2E12_NewUserFirstWork(t *testing.T) {
	start := time.Now()
	f := env.accounts(t)
	acc := "/api/v1/accounts/" + f.wechat.ID.String()
	var orig Profile
	env.mustJSON(t, "GET", acc+"/profile", nil, &orig)
	defer env.mustJSON(t, "PUT", acc+"/profile", orig, nil)

	ev := lastEvent(t, env.sse(t, acc+"/profile/bootstrap", map[string]any{"samples": []map[string]string{
		{"title": "旧文", "content": strings.Repeat("我习惯先写结论，再讲自己踩过的坑。", 20)}}}))
	if ev.Name != "done" {
		t.Fatalf("bootstrap: %s %s", ev.Name, ev.Data)
	}
	var boot struct {
		Result BootstrapDraft `json:"result"`
	}
	if err := json.Unmarshal(ev.Data, &boot); err != nil || len(boot.Result.PositioningTags) == 0 {
		t.Fatalf("bootstrap draft: %s", ev.Data)
	}
	var untouched Profile
	env.mustJSON(t, "GET", acc+"/profile", nil, &untouched)
	if strings.Join(untouched.PositioningTags, ",") != strings.Join(orig.PositioningTags, ",") || untouched.TargetAudience != orig.TargetAudience {
		t.Fatal("bootstrap must only return a draft; the profile changes when the user adopts it")
	}
	adopted := orig
	adopted.PositioningTags, adopted.TargetAudience, adopted.PersonaTone = boot.Result.PositioningTags, boot.Result.TargetAudience, boot.Result.PersonaTone
	env.mustJSON(t, "PUT", acc+"/profile", adopted, nil)

	var sug struct {
		Suggestions []map[string]any `json:"suggestions"`
	}
	env.mustJSON(t, "POST", acc+"/topics/suggest", map[string]string{"direction": "职场效率"}, &sug)
	if len(sug.Suggestions) == 0 {
		t.Fatal("no topic suggestions")
	}
	var tp struct {
		Topic Topic `json:"topic"`
	}
	env.mustJSON(t, "POST", acc+"/topics", map[string]any{"title": sug.Suggestions[0]["title"], "angle": sug.Suggestions[0]["angle"], "source": "ai"}, &tp)
	env.mustJSON(t, "PATCH", "/api/v1/topics/"+tp.Topic.ID.String(), map[string]string{"status": "adopted"}, nil)
	var wk Work
	env.mustJSON(t, "POST", "/api/v1/topics/"+tp.Topic.ID.String()+"/works", nil, &wk)
	id := wk.ID.String()
	env.mustJSON(t, "PATCH", "/api/v1/works/"+id, map[string]string{"viewpoint": "效率不是做得更多，而是少做无用功"}, nil)
	var outline struct {
		Items []OutlineItem `json:"items"`
	}
	env.mustJSON(t, "POST", "/api/v1/works/"+id+"/outline/generate", nil, &outline)
	env.mustJSON(t, "PUT", "/api/v1/works/"+id+"/outline", map[string]any{"items": outline.Items[:2], "confirm": true}, &wk)
	for _, sec := range wk.Sections {
		if ev := lastEvent(t, env.sse(t, "/api/v1/sections/"+sec.ID.String()+"/draft", nil)); ev.Name != "done" {
			t.Fatalf("draft: %s %s", ev.Name, ev.Data)
		}
	}
	asset := env.upload(t, id, testPNG(900, 500))
	env.mustJSON(t, "PATCH", "/api/v1/works/"+id, map[string]any{"title": "少做无用功", "summary": "效率的关键", "cover_asset_id": asset.ID,
		"cover_crops": map[string]cropBox{"2.35_1": {0, 0.2, 1, 0.6}, "1_1": {0.2, 0, 0.75, 1}}}, nil)
	env.confirmChecks(t, id)
	env.mustJSON(t, "GET", "/api/v1/works/"+id, nil, &wk)
	if ev := lastEvent(t, env.push(t, wk, map[string]any{"confirm_over_limit": true})); ev.Name != "done" {
		t.Fatalf("push: %s %s", ev.Name, ev.Data)
	}
	if d := time.Since(start); d > 30*time.Minute {
		t.Fatalf("first work took %s", d)
	}
}

// E2E-13：手动添加记忆 → 起草时本次参考出现该记忆 → 停用 → 再起草不出现。
func TestE2E13_MemoryLoop(t *testing.T) {
	f := env.accounts(t)
	var mem Memory
	env.mustJSON(t, "POST", "/api/v1/accounts/"+f.wechat.ID.String()+"/memories",
		map[string]string{"kind": "structure", "scope": "all", "text": "E2E13：每段结尾给一个可执行的小建议"}, &mem)
	if mem.Status != "active" {
		t.Fatalf("manual memory should take effect at once: %s", mem.Status)
	}
	wk := outlinedWork(t, f.wechat, "记忆闭环")
	if !slotHas(draftRefs(t, wk.Sections[0].ID.String()), "memory", mem.ID.String()) {
		t.Fatal("active memory should show up in this draft's refs")
	}
	env.mustJSON(t, "PATCH", "/api/v1/memories/"+mem.ID.String(), map[string]string{"status": "disabled"}, nil)
	if slotHas(draftRefs(t, wk.Sections[1].ID.String()), "memory", mem.ID.String()) {
		t.Fatal("disabled memory must not be used again")
	}
}

// E2E-14：提炼素材 → 逐条保存 → 写作时检索推荐出现 → 用于本段 → 起草引用 → 用素材补齐待核实。
func TestE2E14_MaterialLoop(t *testing.T) {
	f := env.accounts(t)
	var ex struct {
		Items []MaterialCandidate `json:"items"`
	}
	env.mustJSON(t, "POST", "/api/v1/materials/extract", map[string]any{"account_id": f.wechat.ID,
		"text": "调查显示 E2E14 样本中 62% 的通勤族在地铁上刷短视频。我自己的做法是通勤路上只听播客。读书会的朋友说通勤是最好的复盘时间。"}, &ex)
	if len(ex.Items) == 0 {
		t.Fatal("extract should return candidates")
	}
	var saved Material
	env.mustJSON(t, "POST", "/api/v1/materials", map[string]any{"account_id": f.wechat.ID, "kind": ex.Items[0].Kind, "content": ex.Items[0].Content}, &saved)

	wk := outlinedWork(t, f.wechat, "通勤时间怎么用才不浪费")
	sec := wk.Sections[1]
	var rec struct {
		Items []RetrieveHit `json:"items"`
	}
	env.mustJSON(t, "POST", "/api/v1/accounts/"+f.wechat.ID.String()+"/retrieve", map[string]any{"query": saved.Content, "work_id": wk.ID}, &rec)
	found := false
	for _, h := range rec.Items {
		found = found || h.ID == saved.ID.String()
	}
	if !found {
		t.Fatalf("saved material should be recommended while writing: %+v", rec.Items)
	}
	env.mustJSON(t, "PUT", "/api/v1/sections/"+sec.ID.String()+"/materials", map[string]any{"material_ids": []string{saved.ID.String()}}, nil)
	if !slotHas(draftRefs(t, sec.ID.String()), "materials", saved.ID.String()) {
		t.Fatal("material bound to the section should be cited by the draft")
	}

	var got Work
	env.mustJSON(t, "GET", "/api/v1/works/"+wk.ID.String(), nil, &got)
	var drafted Section
	for _, s := range got.Sections {
		if s.ID == sec.ID {
			drafted = s
		}
	}
	i, j := strings.Index(drafted.ContentMD, "【待核实"), strings.Index(drafted.ContentMD, "】")
	if i < 0 || j < i {
		t.Fatalf("mock draft for a 为什么 heading should leave a 待核实 marker: %q", drafted.ContentMD)
	}
	filled := drafted.ContentMD[:i] + saved.Content + drafted.ContentMD[j+len("】"):]
	after := setSection(t, drafted, filled)
	if strings.Contains(after.ContentMD, "【待核实") || !strings.Contains(after.ContentMD, saved.Content) {
		t.Fatalf("待核实 should be replaced by the material: %q", after.ContentMD)
	}
}

// E2E-15：起草中断开连接（刷新页面）→ 后台任务继续，结果写入该段且只调用一次模型。
func TestE2E15_DraftSurvivesRefresh(t *testing.T) {
	f := env.accounts(t)
	defer setDraftRoute(t, "mock-slow", "")()
	wk := outlinedWork(t, f.wechat, "刷新后起草不丢")
	sec := wk.Sections[0]
	resp := env.request("POST", "/api/v1/sections/"+sec.ID.String()+"/draft", strings.NewReader("{}"), "application/json")
	buf := make([]byte, 4096)
	var head string
	for !strings.Contains(head, "event: job") {
		n, err := resp.Body.Read(buf)
		if err != nil {
			t.Fatalf("no job event: %v %q", err, head)
		}
		head += string(buf[:n])
	}
	resp.Body.Close()

	var active []AIJob
	env.mustJSON(t, "GET", "/api/v1/ai-jobs?status=active&work_id="+wk.ID.String(), nil, &active)
	if len(active) != 1 || active[0].SectionID == nil || *active[0].SectionID != sec.ID {
		t.Fatalf("reloaded editor should find the running draft: %+v", active)
	}
	deadline := time.Now().Add(15 * time.Second)
	var job AIJob
	for {
		env.mustJSON(t, "GET", "/api/v1/ai-jobs/"+active[0].ID.String(), nil, &job)
		if job.Status != "queued" && job.Status != "running" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("draft job never finished")
		}
		time.Sleep(200 * time.Millisecond)
	}
	if job.Status != "done" {
		t.Fatalf("draft should finish after the client left: %s %s", job.Status, job.Error)
	}
	var got Work
	env.mustJSON(t, "GET", "/api/v1/works/"+wk.ID.String(), nil, &got)
	if strings.TrimSpace(got.Sections[0].ContentMD) == "" {
		t.Fatal("draft result should be written to the section")
	}
	var calls int
	_ = env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM ai_call WHERE work_id=$1 AND task_type='section_draft'`, wk.ID).Scan(&calls)
	if calls != 1 {
		t.Fatalf("one draft should be billed once, got %d calls", calls)
	}
}
