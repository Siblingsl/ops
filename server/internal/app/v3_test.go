package app

// 10 文档（V3 智能化与体验增强）的规则与流程测试。

import (
	"context"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestNextActionsOrdering(t *testing.T) {
	now := time.Date(2026, 10, 10, 10, 0, 0, 0, time.Local)
	ids := make([]uuid.UUID, 6)
	for i := range ids {
		ids[i] = uuid.New()
	}
	published := now.AddDate(0, 0, -4)
	planned := truncDay(now)
	node3 := 3
	in := naInput{Now: now, AccountID: uuid.New(), Platform: "wechat_mp", AdoptedNotStarted: 2, PendingMemories: 1, Works: []naWork{
		{ID: ids[0], Title: "待推送", Status: "ready", UpdatedAt: now.AddDate(0, 0, -3)},
		{ID: ids[1], Title: "待审阅", Status: "reviewing", UpdatedAt: now},
		{ID: ids[2], Title: "检查中", Status: "checking", UpdatedAt: now, PendingCheckItems: 2},
		{ID: ids[3], Title: "起草中", Status: "drafting", UpdatedAt: now, OutlineConfirmed: true, Viewpoint: true, EmptySections: []uuid.UUID{uuid.New(), uuid.New()}},
		{ID: ids[4], Title: "今天计划", Status: "drafting", UpdatedAt: now, PlannedDate: &planned},
		{ID: ids[5], Title: "已发布", Status: "published", UpdatedAt: now, PushedOrPacked: true, PublishedAt: &published, DueNode: &node3, OpenTodos: 2},
	}}
	list := nextActions(in, 20)
	kinds := map[string]bool{}
	seen := map[uuid.UUID]bool{}
	for _, a := range list {
		kinds[a.Kind] = true
		if a.WorkID != nil && a.Kind != "todos" {
			if seen[*a.WorkID] {
				t.Fatalf("work %s appears twice", *a.WorkID)
			}
			seen[*a.WorkID] = true
		}
	}
	for _, k := range []string{"push", "review", "check", "draft", "planned", "metrics", "todos", "topic", "memory"} {
		if !kinds[k] {
			t.Fatalf("missing %s in %+v", k, list)
		}
	}
	if list[0].Kind != "push" {
		t.Fatalf("blocking push should rank first, got %s", list[0].Kind)
	}
	if list[len(list)-1].Kind != "memory" {
		t.Fatalf("new-task suggestions rank last, got %s", list[len(list)-1].Kind)
	}
	if got := nextActions(in, 3); len(got) != 3 {
		t.Fatalf("limit: %d", len(got))
	}
	in.WriteEndingFirst = true
	for _, a := range nextActions(in, 20) {
		if a.Kind == "draft" && a.WorkID != nil && *a.WorkID == ids[3] && !strings.HasSuffix(a.Link, in.Works[3].EmptySections[1].String()) {
			t.Fatalf("ending-first should link the last empty section: %s", a.Link)
		}
	}
}

func TestPolishRules(t *testing.T) {
	long := strings.Repeat("这是一个非常非常长的句子用来测试可读性规则", 3) + "。"
	passive := "方案被否了，预算被砍了，人也被调走了。"
	same := "我们先看问题。我们再看原因。我们最后看办法。"
	issues := polishRules("s1", long+"\n"+passive+"\n"+same+"\n其实其实其实就是这样。其实。", []string{"其实"})
	rules := map[string]bool{}
	for _, it := range issues {
		rules[it.Rule] = true
		if it.Source != "rule" || it.SectionID != "s1" {
			t.Fatalf("bad issue: %+v", it)
		}
		for _, bad := range []string{"AI 味", "检测", "去AI"} {
			if strings.Contains(it.Message, bad) {
				t.Fatalf("NFR-10 wording in %q", it.Message)
			}
		}
	}
	for _, r := range []string{"long_sentence", "passive", "same_opening", "catchphrase"} {
		if !rules[r] {
			t.Fatalf("missing rule %s: %+v", r, issues)
		}
	}
	if got := polishRules("s2", "短句。清楚。", nil); len(got) != 0 {
		t.Fatalf("clean text flagged: %+v", got)
	}
}

func TestParsePublishLink(t *testing.T) {
	ts := time.Date(2026, 9, 1, 8, 0, 0, 0, time.UTC).Unix()
	got := parsePublishLink(fmt.Sprintf("https://mp.weixin.qq.com/s?__biz=x&timestamp=%d", ts))
	if got.Platform != "wechat_mp" || got.PublishedAt == nil || got.PublishedAt.Unix() != ts {
		t.Fatalf("wechat: %+v", got)
	}
	got = parsePublishLink("https://mp.weixin.qq.com/s/abcdef")
	if got.Platform != "wechat_mp" || got.PublishedAt != nil || got.Note == "" {
		t.Fatalf("wechat without time: %+v", got)
	}
	noteID := fmt.Sprintf("%08x", ts) + "0000000000000000"
	got = parsePublishLink("https://www.xiaohongshu.com/explore/" + noteID)
	if got.Platform != "xhs" || got.PublishedAt == nil || got.PublishedAt.Unix() != ts {
		t.Fatalf("xhs: %+v", got)
	}
	if got = parsePublishLink("https://example.com/a"); got.Platform != "" || got.Note == "" {
		t.Fatalf("other: %+v", got)
	}
	if got = parsePublishLink("不是链接"); got.Platform != "" {
		t.Fatalf("garbage: %+v", got)
	}
	calls := len(env.mockWX.Calls())
	env.mustJSON(t, "POST", "/api/v1/publish-link/parse", map[string]string{"url": "https://mp.weixin.qq.com/s/xyz"}, nil)
	if len(env.mockWX.Calls()) != calls {
		t.Fatal("parsing a link must not make outbound requests")
	}
}

func TestLintAgreesWithFormalCheck(t *testing.T) {
	text := "这是最好的选择，效果第一。"
	hits := lintText(text, []checkWord{{w: "选择", source: "custom"}}, []string{"效果"})
	cats := map[string]string{}
	for _, h := range hits {
		cats[h.Word] = h.Category
		if []rune(text)[h.Start] != []rune(h.Word)[0] {
			t.Fatalf("rune offset wrong for %q: %d", h.Word, h.Start)
		}
	}
	if cats["最"] != "ad_law" || cats["第一"] != "ad_law" || cats["选择"] != "sensitive" || cats["效果"] != "memory" {
		t.Fatalf("categories: %+v", cats)
	}
	for _, w := range adWords {
		if len(lintText("前缀"+w+"后缀", nil, nil)) == 0 {
			t.Fatalf("ad word %q not linted", w)
		}
	}
}

func TestKeepFaithfulNumbers(t *testing.T) {
	src := "调查显示，62% 的受访者每天加班，平均通勤 1,200 米。"
	in := []MaterialCandidate{
		{Kind: "data", Content: "62% 的受访者每天加班"},
		{Kind: "data", Content: "平均通勤 1200 米"},
		{Kind: "data", Content: "75% 的人想换工作"},
		{Kind: "opinion", Content: "加班文化需要改变，九成人认同"},
		{Kind: "unknown", Content: "无效类型"},
	}
	out := keepFaithfulNumbers(in, src)
	if len(out) != 3 {
		t.Fatalf("want 3 kept, got %+v", out)
	}
	for _, it := range out {
		if strings.Contains(it.Content, "75%") {
			t.Fatal("fabricated number kept")
		}
	}
}

func TestSmartCropBoxFindsSubject(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 400, 200))
	for y := 0; y < 200; y++ {
		for x := 0; x < 400; x++ {
			img.Set(x, y, color.RGBA{30, 30, 30, 255})
		}
	}
	for y := 60; y < 140; y++ {
		for x := 300; x < 380; x++ {
			img.Set(x, y, color.RGBA{220, 160, 130, 255})
		}
	}
	box := smartCropBox(img, 1)
	if box.X1 < 0.4 || box.X2 > 1.0001 || box.Y1 != 0 || box.Y2 != 1 {
		t.Fatalf("square crop should move to the subject on the right: %+v", box)
	}
	wide := smartCropBox(img, 2.35)
	if wide.X2-wide.X1 < 0.99 {
		t.Fatalf("2.35:1 on a 2:1 image should keep full width: %+v", wide)
	}
}

func TestAttributionNeedsTenSamples(t *testing.T) {
	var a Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{"platform": "wechat_mp", "name": "归因测试号", "content_format": "long_article"}, &a)
	var res struct {
		Enough  bool   `json:"enough"`
		Message string `json:"message"`
	}
	env.mustJSON(t, "POST", "/api/v1/accounts/"+a.ID.String()+"/reviews/attribution", nil, &res)
	if res.Enough || !strings.Contains(res.Message, "数据还不够") {
		t.Fatalf("want not enough: %+v", res)
	}
	samples := make([]perfSample, 12)
	for i := range samples {
		samples[i] = perfSample{Title: fmt.Sprintf("第%d个方法？", i), PublishedAt: time.Now(), Reads: 100 * i, Chars: 1500, Topics: []string{"效率"}}
	}
	feats := attributionStats(samples, time.Local)
	if len(feats) < 5 {
		t.Fatalf("features: %+v", feats)
	}
}

func TestRetrievalRecall(t *testing.T) {
	var a Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{"platform": "wechat_mp", "name": "检索测试号", "content_format": "long_article"}, &a)
	topics := map[string][]string{
		"咖啡": {"手冲咖啡的水温控制在九十度左右口感最稳定", "咖啡豆放在密封罐里能保存两周香气", "冷萃咖啡需要在冰箱里浸泡十二小时"},
		"跑步": {"跑步前热身十分钟能明显减少膝盖不适", "新手跑步每周三次比每天跑更容易坚持", "跑步鞋大约八百公里就该更换"},
		"睡眠": {"睡眠前一小时放下手机入睡更快", "午睡控制在二十分钟内不影响夜间睡眠", "卧室温度十八度左右睡眠质量更好"},
		"理财": {"理财第一步是记账弄清每月支出", "应急理财备用金建议留够六个月开销", "定投理财最怕的是半途停掉"},
		"育儿": {"育儿中最有效的是固定的睡前阅读时间", "孩子发脾气时先共情再讲道理是育儿常识", "育儿不必追求完美父母只要足够好"},
		"摄影": {"手机摄影时把对焦点放在人物眼睛上", "摄影构图用三分法画面更平衡", "傍晚的金色时段最适合人像摄影"},
		"面试": {"面试前把简历里每个项目都准备一个故事", "面试结尾一定要准备一个反问问题", "群面面试里倾听比抢话更加分"},
		"园艺": {"园艺新手从绿萝和吊兰开始最不容易失败", "多肉园艺浇水要见干见湿", "阳台园艺记得每月施一次薄肥"},
		"露营": {"露营选营地先看有没有平整的地面和水源", "第一次露营建议选有补给的营地", "露营夜里温差大要多带一层保暖"},
		"编程": {"学编程最快的方法是做一个自己想用的小工具", "编程卡住时先把问题讲给别人听", "编程时写测试能让重构更放心"},
	}
	queries := map[string]string{
		"咖啡": "怎么在家做好喝的咖啡", "跑步": "跑步新手怎么开始", "睡眠": "睡眠不好怎么办", "理财": "年轻人怎么开始理财",
		"育儿": "育儿有什么好方法", "摄影": "手机摄影技巧", "面试": "面试怎么准备", "园艺": "阳台园艺入门",
		"露营": "第一次露营要注意什么", "编程": "编程怎么入门",
	}
	ids := map[string]map[string]bool{}
	for topic, list := range topics {
		ids[topic] = map[string]bool{}
		for _, c := range list {
			var m Material
			env.mustJSON(t, "POST", "/api/v1/materials", map[string]any{"account_id": a.ID, "kind": "experience", "content": c}, &m)
			ids[topic][m.ID.String()] = true
		}
	}
	found, total := 0, 0
	for topic, q := range queries {
		var res struct {
			Items []RetrieveHit `json:"items"`
		}
		env.mustJSON(t, "POST", "/api/v1/accounts/"+a.ID.String()+"/retrieve", map[string]any{"query": q, "limit": 5}, &res)
		for _, h := range res.Items {
			if ids[topic][h.ID] {
				found++
			}
			if h.Reason == "" {
				t.Fatalf("hit without reason: %+v", h)
			}
		}
		total += 3
	}
	if recall := float64(found) / float64(total); recall < 0.7 {
		t.Fatalf("recall %.2f < 0.70", recall)
	}
}

// 上下文组装器（3.1）：槽位按优先级排列，超预算时按调用方给的相关度顺序保留素材、先裁相邻段落，并完整记录每个条目。
func TestContextPackBudgets(t *testing.T) {
	f := env.accounts(t)
	ctx := context.Background()
	var ws uuid.UUID
	if err := env.srv.db.QueryRow(ctx, `SELECT workspace_id FROM platform_account WHERE id=$1`, f.wechat.ID).Scan(&ws); err != nil {
		t.Fatal(err)
	}
	jctx := context.WithValue(ctx, ctxMember, &identity{WorkspaceID: ws})
	a, err := env.srv.account(jctx, f.wechat.ID)
	if err != nil {
		t.Fatal(err)
	}
	var mats []uuid.UUID
	for i := 0; i < 6; i++ {
		var m Material
		env.mustJSON(t, "POST", "/api/v1/materials", map[string]any{"account_id": a.ID, "kind": "case", "content": fmt.Sprintf("预算测试素材%d：%s", i, strings.Repeat("长", 900))}, &m)
		mats = append(mats, m.ID)
	}
	main := "观点：" + strings.Repeat("观", 1000)
	pack, err := env.srv.buildContext(jctx, aiTask{Type: "section_draft", Account: a, Materials: mats, Work: main,
		Neighbors: strings.Repeat("邻", 5000), Instruction: "更口语", User: "x"})
	if err != nil {
		t.Fatal(err)
	}
	order := map[string]int{"rules": 0, "profile": 1, "memory": 2, "task_instruction": 3, "style": 4, "materials": 5, "history": 6, "work": 7, "user_instruction": 8}
	last := -1
	slots := map[string]Slot{}
	for _, sl := range pack.Slots {
		if order[sl.Name] < last {
			t.Fatalf("slot %s out of priority order", sl.Name)
		}
		last = order[sl.Name]
		slots[sl.Name] = sl
		if sl.Label == "" {
			t.Fatalf("slot %s has no label", sl.Name)
		}
	}
	ms := slots["materials"]
	if !ms.Truncated || ms.Chars > ms.Budget || len(ms.Items) != len(mats) {
		t.Fatalf("materials slot: %+v", ms)
	}
	for i, it := range ms.Items {
		if it.ID != mats[i].String() {
			t.Fatalf("material %d recorded out of order", i)
		}
		if want := i < 4; it.Used != want {
			t.Fatalf("material %d used=%v, want %v (keep the most relevant first)", i, it.Used, want)
		}
	}
	if strings.Contains(pack.User, "预算测试素材5") || !strings.Contains(pack.User, "预算测试素材0") {
		t.Fatal("trimmed material leaked into the prompt or kept one missing")
	}
	w := slots["work"]
	if !w.Truncated || w.Chars > w.Budget || len(w.Items) != 2 || !w.Items[0].Used || w.Items[0].Chars != runeLen(main) {
		t.Fatalf("work slot must keep the work and trim neighbours first: %+v", w)
	}
	if ui := slots["user_instruction"]; ui.Chars != runeLen("更口语") || pack.Instruction != "更口语" {
		t.Fatalf("user instruction not recorded: %+v", ui)
	}
	refs := pack.refs()
	if _, ok := refs["slots"]; !ok {
		t.Fatal("refs must carry the slot list")
	}
	b, _ := json.Marshal(refs)
	if strings.Contains(string(b), strings.Repeat("长", 100)) {
		t.Fatal("context_refs must store ids and sizes, not full text")
	}
}

func TestModelFallback(t *testing.T) {
	f := env.accounts(t)
	var providers []struct {
		ID     uuid.UUID `json:"id"`
		Models []string  `json:"models"`
	}
	env.mustJSON(t, "GET", "/api/v1/model-providers", nil, &providers)
	if len(providers) == 0 {
		t.Fatal("no provider")
	}
	pid := providers[0].ID
	env.mustJSON(t, "PUT", "/api/v1/model-routes", []map[string]any{{"task_type": "tag_suggest", "provider_id": pid, "model": "mock-down", "fallback_provider_id": pid, "fallback_model": "mock-fast"}}, nil)
	defer env.mustJSON(t, "PUT", "/api/v1/model-routes", []map[string]any{{"task_type": "tag_suggest", "provider_id": pid, "model": "mock-fast"}}, nil)
	var wk Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+f.xhs.ID.String()+"/works", map[string]string{"title": "备用模型测试"}, &wk)
	env.mustJSON(t, "POST", "/api/v1/works/"+wk.ID.String()+"/tag-suggest", nil, nil)
	rows, err := env.srv.db.Query(context.Background(), `SELECT model, status FROM ai_call WHERE work_id=$1 AND task_type='tag_suggest' ORDER BY created_at`, wk.ID)
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for rows.Next() {
		var m, s string
		_ = rows.Scan(&m, &s)
		got = append(got, m+":"+s)
	}
	rows.Close()
	if len(got) != 2 || got[0] != "mock-down:failed" || got[1] != "mock-fast:ok" {
		t.Fatalf("want primary failed then fallback ok, got %v", got)
	}

	// 「换备用模型」重试：直接走备用模型，不再先打主模型。
	req, _ := http.NewRequest("POST", env.http.URL+"/api/v1/works/"+wk.ID.String()+"/tag-suggest", strings.NewReader("{}"))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-CSRF-Token", env.csrf)
	req.Header.Set("X-AI-Prefer", "fallback")
	resp, err := env.client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("prefer fallback: %d", resp.StatusCode)
	}
	var n int
	if err := env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM ai_call WHERE work_id=$1 AND task_type='tag_suggest' AND model='mock-down'`, wk.ID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("prefer fallback still called the primary model: %d calls", n)
	}

	// 没有备用模型时，失败信息要告诉前端无法一键换备用。
	env.mustJSON(t, "PUT", "/api/v1/model-routes", []map[string]any{{"task_type": "tag_suggest", "provider_id": pid, "model": "mock-down"}}, nil)
	ae := env.expectErr(t, "POST", "/api/v1/works/"+wk.ID.String()+"/tag-suggest", nil, "ai_upstream_error")
	if !strings.Contains(string(ae.Error.Detail), `"fallback_available":false`) {
		t.Fatalf("want fallback_available=false, got %s", ae.Error.Detail)
	}
}

// outlinedWork returns a work with a confirmed two-section outline and empty sections.
func outlinedWork(t *testing.T, a Account, viewpoint string) Work {
	t.Helper()
	var wk Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+a.ID.String()+"/works", map[string]string{"title": "测试作品"}, &wk)
	id := wk.ID.String()
	env.mustJSON(t, "PATCH", "/api/v1/works/"+id, map[string]string{"viewpoint": viewpoint}, nil)
	var outline struct {
		Items []OutlineItem `json:"items"`
	}
	env.mustJSON(t, "POST", "/api/v1/works/"+id+"/outline/generate", nil, &outline)
	env.mustJSON(t, "PUT", "/api/v1/works/"+id+"/outline", map[string]any{"items": outline.Items[:2], "confirm": true}, &wk)
	return wk
}

func setDraftRoute(t *testing.T, model, fallback string) func() {
	t.Helper()
	var providers []struct {
		ID uuid.UUID `json:"id"`
	}
	env.mustJSON(t, "GET", "/api/v1/model-providers", nil, &providers)
	pid := providers[0].ID
	rt := map[string]any{"task_type": "section_draft", "provider_id": pid, "model": model}
	if fallback != "" {
		rt["fallback_provider_id"], rt["fallback_model"] = pid, fallback
	}
	env.mustJSON(t, "PUT", "/api/v1/model-routes", []map[string]any{rt}, nil)
	return func() {
		env.mustJSON(t, "PUT", "/api/v1/model-routes", []map[string]any{{"task_type": "section_draft", "provider_id": pid, "model": "mock-fast"}}, nil)
	}
}

// E2E-16：主模型返回 503 时起草仍成功，并在本次参考中标明用了备用模型。
func TestDraftFallsBackOn503(t *testing.T) {
	f := env.accounts(t)
	defer setDraftRoute(t, "mock-down", "mock-fast")()
	wk := outlinedWork(t, f.wechat, "备用模型兜底起草")
	ev := lastEvent(t, env.sse(t, "/api/v1/sections/"+wk.Sections[0].ID.String()+"/draft", nil))
	if ev.Name != "done" || !strings.Contains(string(ev.Data), `"fallback_used":true`) {
		t.Fatalf("draft with primary down: %s %s", ev.Name, ev.Data)
	}
	var got Work
	env.mustJSON(t, "GET", "/api/v1/works/"+wk.ID.String(), nil, &got)
	if strings.TrimSpace(got.Sections[0].ContentMD) == "" {
		t.Fatal("fallback draft was not written")
	}
}

// 3.5：取消起草任务后不写入正文。
func TestCancelDraftJobWritesNothing(t *testing.T) {
	f := env.accounts(t)
	defer setDraftRoute(t, "mock-slow", "")()
	wk := outlinedWork(t, f.wechat, "取消就不写入")
	sec := wk.Sections[0]
	resp := env.request("POST", "/api/v1/sections/"+sec.ID.String()+"/draft", strings.NewReader("{}"), "application/json")
	defer resp.Body.Close()
	buf := make([]byte, 4096)
	var head string
	for !strings.Contains(head, "event: job") {
		n, err := resp.Body.Read(buf)
		if err != nil {
			t.Fatalf("no job event: %v %q", err, head)
		}
		head += string(buf[:n])
	}
	i := strings.Index(head, `"id":"`)
	if i < 0 {
		t.Fatalf("job id missing: %q", head)
	}
	jobID := head[i+6 : i+6+36]
	var job AIJob
	env.mustJSON(t, "POST", "/api/v1/ai-jobs/"+jobID+"/cancel", nil, &job)
	if job.Status != "cancelled" {
		t.Fatalf("cancel: %s", job.Status)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	time.Sleep(300 * time.Millisecond)
	var got Work
	env.mustJSON(t, "GET", "/api/v1/works/"+wk.ID.String(), nil, &got)
	if got.Sections[0].ContentMD != "" || got.Sections[0].Revision != sec.Revision {
		t.Fatalf("cancelled draft was written: %q", got.Sections[0].ContentMD)
	}
}

func TestSourceDiffAfterSourceEdit(t *testing.T) {
	f := env.accounts(t)
	wk := env.readyWork(t, f.wechat, "源作品改了要提示")
	var derived Work
	env.mustJSON(t, "POST", "/api/v1/works/"+wk.ID.String()+"/derive", map[string]string{"target_account_id": f.xhs.ID.String()}, &derived)
	type diffItem struct {
		Changed bool `json:"changed"`
		Sources []struct {
			Changed    bool   `json:"changed"`
			OldContent string `json:"old_content"`
			NewContent string `json:"new_content"`
		} `json:"sources"`
	}
	var before []diffItem
	env.mustJSON(t, "GET", "/api/v1/works/"+derived.ID.String()+"/source-diff", nil, &before)
	for _, it := range before {
		if it.Changed {
			t.Fatal("fresh derive should have no changes")
		}
	}
	for _, sec := range wk.Sections {
		env.mustJSON(t, "PATCH", "/api/v1/sections/"+sec.ID.String(), map[string]any{"content_md": sec.ContentMD + "\n补充一句新内容。", "base_revision": sec.Revision}, nil)
	}
	var after []diffItem
	env.mustJSON(t, "GET", "/api/v1/works/"+derived.ID.String()+"/source-diff", nil, &after)
	changed := false
	for _, it := range after {
		for _, s := range it.Sources {
			if s.Changed {
				changed = true
				if !strings.Contains(s.NewContent, "补充一句新内容") {
					t.Fatalf("new content: %q", s.NewContent)
				}
			}
		}
	}
	if !changed {
		t.Fatalf("source edit not detected: %+v", after)
	}
}

func TestMaterialExtractAndInboxAreOneByOne(t *testing.T) {
	f := env.accounts(t)
	ctx := context.Background()
	count := func(table string) int {
		var n int
		_ = env.srv.db.QueryRow(ctx, `SELECT count(*) FROM `+table).Scan(&n)
		return n
	}
	mats := count("material")
	var ex struct {
		Items []MaterialCandidate `json:"items"`
	}
	env.mustJSON(t, "POST", "/api/v1/materials/extract", map[string]any{"account_id": f.wechat.ID, "text": "调查显示 62% 的职场人每天加班。我自己的经验是先列清单再动手。"}, &ex)
	if len(ex.Items) == 0 {
		t.Fatal("no candidates")
	}
	if count("material") != mats {
		t.Fatal("extract wrote materials")
	}
	var item struct {
		ID uuid.UUID `json:"id"`
	}
	env.mustJSON(t, "POST", "/api/v1/inbox", map[string]any{"account_id": f.wechat.ID, "content": "周末写一篇关于通勤时间利用的文章"}, &item)
	topics := topicCount(t, f.wechat.ID.String())
	env.mustJSON(t, "POST", "/api/v1/inbox/"+item.ID.String()+"/convert", map[string]any{"to": "topic", "title": "通勤时间怎么用"}, nil)
	if topicCount(t, f.wechat.ID.String()) != topics+1 {
		t.Fatal("convert should add exactly one topic")
	}
	env.expectErr(t, "POST", "/api/v1/inbox/"+item.ID.String()+"/convert", map[string]any{"to": "topic", "title": "再来一次"}, "state_invalid")
}

func TestDemoImportAndClear(t *testing.T) {
	var res struct {
		AccountID uuid.UUID `json:"account_id"`
	}
	env.mustJSON(t, "POST", "/api/v1/demo", nil, &res)
	env.expectErr(t, "POST", "/api/v1/demo", nil, "state_invalid")
	var n int
	_ = env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM platform_account WHERE is_demo`).Scan(&n)
	if n != 1 {
		t.Fatalf("demo accounts: %d", n)
	}
	env.mustJSON(t, "DELETE", "/api/v1/demo", nil, nil)
	_ = env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM platform_account WHERE is_demo`).Scan(&n)
	if n != 0 {
		t.Fatalf("demo not cleared: %d", n)
	}
}
