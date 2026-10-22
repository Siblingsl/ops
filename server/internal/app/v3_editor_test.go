package app

import (
	"context"
	"encoding/json"
	"net/url"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func setSection(t *testing.T, sec Section, content string) Section {
	t.Helper()
	var out struct {
		Section Section `json:"section"`
	}
	env.mustJSON(t, "PATCH", "/api/v1/sections/"+sec.ID.String(), map[string]any{"content_md": content, "base_revision": sec.Revision}, &out)
	return out.Section
}

func sectionIDs(w Work) []uuid.UUID {
	ids := make([]uuid.UUID, len(w.Sections))
	for i, s := range w.Sections {
		ids[i] = s.ID
	}
	return ids
}

func TestUndoSectionDeleteKeepsOrder(t *testing.T) {
	f := env.accounts(t)
	var wk Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+f.wechat.ID.String()+"/works", map[string]string{"title": "撤销顺序"}, &wk)
	id := wk.ID.String()
	env.mustJSON(t, "PATCH", "/api/v1/works/"+id, map[string]string{"viewpoint": "先想清楚再动手"}, nil)
	var outline struct {
		Items []OutlineItem `json:"items"`
	}
	env.mustJSON(t, "POST", "/api/v1/works/"+id+"/outline/generate", nil, &outline)
	if len(outline.Items) < 3 {
		t.Fatalf("need at least 3 outline items, got %d", len(outline.Items))
	}
	env.mustJSON(t, "PUT", "/api/v1/works/"+id+"/outline", map[string]any{"items": outline.Items[:3], "confirm": true}, &wk)
	before := sectionIDs(wk)
	var after Work
	env.mustJSON(t, "DELETE", "/api/v1/sections/"+before[1].String(), nil, &after)
	if len(after.Sections) != 2 {
		t.Fatalf("delete should leave 2 sections, got %d", len(after.Sections))
	}
	env.mustJSON(t, "POST", "/api/v1/sections/"+before[1].String()+"/restore", nil, &after)
	if got := sectionIDs(after); !reflect.DeepEqual(got, before) {
		t.Fatalf("undo must restore the original order: %v, want %v", got, before)
	}
}

func TestOutlineReviewLeavesOutlineUnchanged(t *testing.T) {
	f := env.accounts(t)
	wk := outlinedWork(t, f.wechat, "复盘比计划更重要")
	var res struct {
		Issues []map[string]any `json:"issues"`
	}
	env.mustJSON(t, "POST", "/api/v1/works/"+wk.ID.String()+"/outline/review", nil, &res)
	if len(res.Issues) == 0 {
		t.Fatal("review should return issues")
	}
	var after Work
	env.mustJSON(t, "GET", "/api/v1/works/"+wk.ID.String(), nil, &after)
	if !reflect.DeepEqual(after.Outline, wk.Outline) || after.Revision != wk.Revision {
		t.Fatal("outline review must not modify the outline (EX-E-08)")
	}
}

func TestVariantsDifferAndChoiceRecorded(t *testing.T) {
	f := env.accounts(t)
	wk := outlinedWork(t, f.wechat, "少做一件事反而更有用")
	sec := setSection(t, wk.Sections[0], "很多人以为做得越多越好，其实每一步想清楚为什么要做才最关键。")
	var res struct {
		Variants []variant `json:"variants"`
		AICallID uuid.UUID `json:"ai_call_id"`
	}
	env.mustJSON(t, "POST", "/api/v1/sections/"+sec.ID.String()+"/edit", map[string]any{"mode": "rewrite", "variants": 3}, &res)
	if len(res.Variants) != 3 {
		t.Fatalf("want 3 variants, got %d", len(res.Variants))
	}
	for i := range res.Variants {
		for j := i + 1; j < len(res.Variants); j++ {
			if textSimilarity(res.Variants[i].Text, res.Variants[j].Text) >= 0.8 {
				t.Fatalf("variants %d and %d are too similar", i, j)
			}
		}
	}
	env.mustJSON(t, "POST", "/api/v1/ai-calls/"+res.AICallID.String()+"/feedback", map[string]any{"outcome": "accepted", "choice_index": 1}, nil)
	var idx int
	if err := env.srv.db.QueryRow(context.Background(), `SELECT choice_index FROM ai_feedback WHERE ai_call_id=$1`, res.AICallID).Scan(&idx); err != nil || idx != 1 {
		t.Fatalf("choice_index not recorded: %d %v", idx, err)
	}
	env.expectErr(t, "POST", "/api/v1/sections/"+sec.ID.String()+"/edit", map[string]any{"mode": "rewrite", "variants": 5}, "validation_failed")
}

func TestHistorySlotFollowsPreference(t *testing.T) {
	f := env.accounts(t)
	old := outlinedWork(t, f.wechat, "手冲咖啡入门")
	setSection(t, old.Sections[0], "手冲咖啡的水温控制在九十度左右，研磨度像砂糖，萃取时间两分半最稳定。")
	wk := outlinedWork(t, f.wechat, "手冲咖啡进阶")
	sec := setSection(t, wk.Sections[0], "手冲咖啡的水温和研磨度决定了大部分风味。")
	slotNames := func() map[string]bool {
		var res struct {
			Refs struct {
				Slots []Slot `json:"slots"`
			} `json:"refs"`
		}
		env.mustJSON(t, "POST", "/api/v1/sections/"+sec.ID.String()+"/edit", map[string]any{"mode": "rewrite", "variants": 3}, &res)
		names := map[string]bool{}
		for _, s := range res.Refs.Slots {
			names[s.Name] = true
		}
		return names
	}
	if !slotNames()["history"] {
		t.Fatal("history slot should be used by default")
	}
	env.mustJSON(t, "PUT", "/api/v1/me/preferences", map[string]any{"use_history": false}, nil)
	defer env.mustJSON(t, "PUT", "/api/v1/me/preferences", map[string]any{"use_history": true}, nil)
	if slotNames()["history"] {
		t.Fatal("history slot must be skipped when the user turned it off")
	}
}

func TestSearchFilters(t *testing.T) {
	f := env.accounts(t)
	needle := "搜索筛选专用的" + uuid.NewString()
	env.mustJSON(t, "POST", "/api/v1/accounts/"+f.wechat.ID.String()+"/topics", map[string]string{"title": needle}, nil)
	count := func(qs string) int {
		var res struct {
			Items []SearchHit `json:"items"`
		}
		env.mustJSON(t, "GET", "/api/v1/search?q="+url.QueryEscape(needle)+qs, nil, &res)
		return len(res.Items)
	}
	if count("") == 0 || count("&types=topic&status=pending&days=7") == 0 {
		t.Fatal("new pending topic should be found")
	}
	if count("&types=topic&status=adopted") != 0 {
		t.Fatal("status filter not applied")
	}
	if count("&account_id="+f.xhs.ID.String()) != 0 {
		t.Fatal("account filter not applied")
	}
}

func TestAssigneeCannotApproveOwnWork(t *testing.T) {
	f := env.accounts(t)
	var inv struct {
		Code string `json:"code"`
	}
	env.mustJSON(t, "POST", "/api/v1/workspaces/current/invites", map[string]any{"role": "editor", "max_uses": 1, "days": 1}, &inv)
	other := env.registerClient(t, "reviewer-editor", testPassword)
	if st, body := other.do("POST", "/api/v1/workspaces/join", map[string]any{"code": inv.Code, "switch": true}); st != 200 {
		other.restore(env)
		t.Fatalf("join: %d %s", st, body)
	}
	var me struct {
		CSRF   string `json:"csrf_token"`
		UserID string `json:"user_id"`
	}
	other.mustJSON(t, "GET", "/api/v1/auth/me", nil, &me)
	other.csrf = me.CSRF
	other.restore(env)

	wk := env.readyWork(t, f.wechat, "负责人不能自审")
	id := wk.ID.String()
	env.mustJSON(t, "PATCH", "/api/v1/works/"+id, map[string]any{"review_required": true, "assignee_id": me.UserID, "reviewer_id": me.UserID}, nil)
	other.expectErr(t, "POST", "/api/v1/works/"+id+"/review/approve", nil, "forbidden")
	other.restore(env)

	env.mustJSON(t, "PATCH", "/api/v1/works/"+id, map[string]any{"assignee_id": ""}, nil)
	var got Work
	other.mustJSON(t, "POST", "/api/v1/works/"+id+"/review/approve", nil, &got)
	other.restore(env)
	if got.Status != "ready" {
		t.Fatalf("reviewer approval should move the work to ready, got %s", got.Status)
	}
	var acts []ActivityItem
	env.mustJSON(t, "GET", "/api/v1/works/"+id+"/activity", nil, &acts)
	seen := map[string]bool{}
	for _, a := range acts {
		seen[a.Text] = true
	}
	if !seen["指定了审阅人"] || !seen["审阅通过"] {
		t.Fatalf("activity should label reviewer changes and approval: %v", seen)
	}
}

func TestPresenceMarksEditingSection(t *testing.T) {
	f := env.accounts(t)
	wk := outlinedWork(t, f.wechat, "软锁提示")
	id, sec := wk.ID.String(), wk.Sections[0].ID.String()
	var inv struct {
		Code string `json:"code"`
	}
	env.mustJSON(t, "POST", "/api/v1/workspaces/current/invites", map[string]any{"role": "editor", "max_uses": 1, "days": 1}, &inv)
	other := env.registerClient(t, "soft-lock-peer", testPassword)
	if st, body := other.do("POST", "/api/v1/workspaces/join", map[string]any{"code": inv.Code, "switch": true}); st != 200 {
		other.restore(env)
		t.Fatalf("join: %d %s", st, body)
	}
	var me struct {
		CSRF string `json:"csrf_token"`
	}
	other.mustJSON(t, "GET", "/api/v1/auth/me", nil, &me)
	other.csrf = me.CSRF
	other.restore(env)

	type entry struct {
		SectionID *string `json:"section_id"`
		Editing   bool    `json:"editing"`
	}
	env.mustJSON(t, "POST", "/api/v1/works/"+id+"/presence", map[string]any{"section_id": sec}, nil)
	var seen []entry
	other.mustJSON(t, "POST", "/api/v1/works/"+id+"/presence", map[string]any{"section_id": sec}, &seen)
	other.restore(env)
	if len(seen) != 1 || seen[0].Editing {
		t.Fatalf("viewing only should not count as editing: %+v", seen)
	}
	env.mustJSON(t, "POST", "/api/v1/works/"+id+"/presence", map[string]any{"section_id": sec, "editing": true}, nil)
	env.mustJSON(t, "POST", "/api/v1/works/"+id+"/presence", map[string]any{"section_id": sec}, nil)
	other.mustJSON(t, "GET", "/api/v1/works/"+id+"/presence", nil, &seen)
	other.restore(env)
	if len(seen) != 1 || !seen[0].Editing {
		t.Fatalf("a heartbeat on the same section should keep the editing flag: %+v", seen)
	}
	env.mustJSON(t, "POST", "/api/v1/works/"+id+"/presence", map[string]any{"section_id": wk.Sections[1].ID.String()}, nil)
	other.mustJSON(t, "GET", "/api/v1/works/"+id+"/presence", nil, &seen)
	other.restore(env)
	if len(seen) != 1 || seen[0].Editing {
		t.Fatalf("moving to another section should drop the editing flag: %+v", seen)
	}
}

func TestPromptEvalCallsStayOutOfQuality(t *testing.T) {
	f := env.accounts(t)
	env.mustJSON(t, "POST", "/api/v1/accounts/"+f.wechat.ID.String()+"/topics/suggest", map[string]string{"direction": "回归测试"}, nil)
	type board struct {
		Tasks []struct {
			TaskType string `json:"task_type"`
			Calls    int    `json:"calls"`
		} `json:"tasks"`
	}
	calls := func() int {
		var b board
		env.mustJSON(t, "GET", "/api/v1/quality?days=7", nil, &b)
		for _, x := range b.Tasks {
			if x.TaskType == "topic_suggest" {
				return x.Calls
			}
		}
		return 0
	}
	before := calls()
	var c EvalCase
	env.mustJSON(t, "POST", "/api/v1/prompt-eval/cases", map[string]any{"task_type": "topic_suggest"}, &c)
	var run EvalRun
	env.mustJSON(t, "POST", "/api/v1/prompt-eval/runs", map[string]any{"case_id": c.ID, "template_b": "请给出更具体的选题。"}, &run)
	if run.OutputA == "" || run.OutputB == "" {
		t.Fatalf("both sides should produce output: %+v", run)
	}
	var n int
	if err := env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM ai_call WHERE is_eval AND task_type='topic_suggest' AND created_at > now() - interval '1 minute'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n < 2 {
		t.Fatalf("eval calls should be flagged is_eval, got %d", n)
	}
	if after := calls(); after != before {
		t.Fatalf("eval calls must not count in the quality board: before %d after %d", before, after)
	}
}

func TestSourceDiffFlagsOnlyTheChangedSection(t *testing.T) {
	f := env.accounts(t)
	wk := env.readyWork(t, f.wechat, "只标记改动的那一段")
	if len(wk.Sections) < 2 {
		t.Fatalf("need at least two source sections, got %d", len(wk.Sections))
	}
	var derived Work
	env.mustJSON(t, "POST", "/api/v1/works/"+wk.ID.String()+"/derive", map[string]string{"target_account_id": f.xhs.ID.String()}, &derived)
	type diffItem struct {
		SectionID string `json:"section_id"`
		Changed   bool   `json:"changed"`
		Sources   []struct {
			SourceID   string `json:"source_id"`
			Changed    bool   `json:"changed"`
			OldContent string `json:"old_content"`
		} `json:"sources"`
	}
	diff := func() []diffItem {
		var d []diffItem
		env.mustJSON(t, "GET", "/api/v1/works/"+derived.ID.String()+"/source-diff", nil, &d)
		return d
	}
	edited := wk.Sections[len(wk.Sections)-1]
	original := edited.ContentMD
	env.mustJSON(t, "PATCH", "/api/v1/sections/"+edited.ID.String(), map[string]any{"content_md": original + "\n源稿新增的一句。", "base_revision": edited.Revision}, nil)

	var flagged string
	for _, it := range diff() {
		usesEdited := false
		for _, s := range it.Sources {
			if s.SourceID == edited.ID.String() {
				usesEdited = true
				if s.OldContent != original {
					t.Fatalf("old content should be the source as of the derive: %q", s.OldContent)
				}
			}
		}
		if it.Changed != usesEdited {
			t.Fatalf("section %s changed=%v but uses edited source=%v", it.SectionID, it.Changed, usesEdited)
		}
		if it.Changed {
			flagged = it.SectionID
		}
	}
	if flagged == "" {
		t.Fatal("the derived section built from the edited source should be flagged")
	}

	if ev := lastEvent(t, env.sse(t, "/api/v1/sections/"+flagged+"/rewrite", nil)); ev.Name != "done" {
		t.Fatalf("rewrite: %s %s", ev.Name, ev.Data)
	}
	for _, it := range diff() {
		if it.Changed {
			t.Fatalf("flag should clear after rewriting: %+v", it)
		}
	}

	// 旧数据：没有记录 source_revisions 时，按本段最后修改时间判断。
	if _, err := env.srv.db.Exec(context.Background(), `UPDATE work_section SET source_revisions='{}' WHERE id=$1`, flagged); err != nil {
		t.Fatal(err)
	}
	var cur Work
	env.mustJSON(t, "GET", "/api/v1/works/"+wk.ID.String(), nil, &cur)
	last := cur.Sections[len(cur.Sections)-1]
	time.Sleep(5 * time.Millisecond)
	env.mustJSON(t, "PATCH", "/api/v1/sections/"+last.ID.String(), map[string]any{"content_md": last.ContentMD + "\n再改一次。", "base_revision": last.Revision}, nil)
	found := false
	for _, it := range diff() {
		if it.SectionID == flagged && it.Changed {
			found = true
		}
	}
	if !found {
		t.Fatal("a section without recorded revisions should still be flagged after a later source edit")
	}
}

func TestLayoutSuggestGoldenSentenceAndAI(t *testing.T) {
	f := env.accounts(t)
	wk := outlinedWork(t, f.wechat, "排版建议")
	setSection(t, wk.Sections[0], "先把问题想清楚。慢一点，反而更快。最后再动手。")
	id := wk.ID.String()
	env.mustJSON(t, "POST", "/api/v1/works/"+id+"/golden-sentences", map[string]string{"text": "慢一点，反而更快。"}, nil)
	type resp struct {
		Suggestions []LayoutSuggestion `json:"suggestions"`
		AICallID    *string            `json:"ai_call_id"`
	}
	var rules resp
	env.mustJSON(t, "POST", "/api/v1/works/"+id+"/layout-suggest", nil, &rules)
	found := false
	for _, s := range rules.Suggestions {
		if s.Kind == "bold" && s.Text == "慢一点，反而更快。" {
			found = true
		}
	}
	if !found || rules.AICallID != nil {
		t.Fatalf("saved golden sentence should be suggested by rules without calling AI: %+v", rules)
	}
	var withAI resp
	env.mustJSON(t, "POST", "/api/v1/works/"+id+"/layout-suggest", map[string]bool{"ai": true}, &withAI)
	if withAI.AICallID == nil {
		t.Fatal("AI path should record its call")
	}
	for _, s := range withAI.Suggestions {
		if strings.Contains(s.Text, "原文里没有") {
			t.Fatalf("AI suggestions must quote existing text only: %+v", s)
		}
	}
	if len(withAI.Suggestions) <= len(rules.Suggestions) {
		t.Fatalf("AI should add at least one verbatim suggestion: %+v", withAI.Suggestions)
	}
}

func TestXhsCardKeepsItsSize(t *testing.T) {
	f := env.accounts(t)
	var wk Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+f.xhs.ID.String()+"/works", map[string]string{"title": "卡片尺寸"}, &wk)
	a := env.upload(t, wk.ID.String(), testPNG(1242, 1656))
	if a.Width != 1242 || a.Height != 1656 || a.Bytes > 1<<20 {
		t.Fatalf("a 3:4 text card must stay 1242×1656 within 1MB, got %d×%d %d bytes", a.Width, a.Height, a.Bytes)
	}
}

func TestImageLibraryFiltersAndReuse(t *testing.T) {
	f := env.accounts(t)
	var src, dst Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+f.wechat.ID.String()+"/works", map[string]string{"title": "图片库来源"}, &src)
	env.mustJSON(t, "POST", "/api/v1/accounts/"+f.xhs.ID.String()+"/works", map[string]string{"title": "图片库复用"}, &dst)
	up := env.upload(t, src.ID.String(), testPNG(64, 48))
	var lib []LibraryAsset
	env.mustJSON(t, "GET", "/api/v1/assets?account_id="+f.wechat.ID.String()+"&ai=0", nil, &lib)
	found := false
	for _, a := range lib {
		if a.ID == up.ID {
			found = a.WorkTitle == "图片库来源"
		}
		if a.AccountID == nil || *a.AccountID != f.wechat.ID {
			t.Fatalf("account filter leaked another account's image: %+v", a)
		}
	}
	if !found {
		t.Fatalf("uploaded image missing from library: %+v", lib)
	}
	env.mustJSON(t, "GET", "/api/v1/assets?ai=1", nil, &lib)
	for _, a := range lib {
		if a.ID == up.ID {
			t.Fatal("ai=1 must not include uploaded photos")
		}
	}
	var copied Asset
	env.mustJSON(t, "POST", "/api/v1/works/"+dst.ID.String()+"/assets/reuse", map[string]string{"asset_id": up.ID.String()}, &copied)
	if copied.WorkID != dst.ID || copied.Width != 64 || copied.ID == up.ID {
		t.Fatalf("reuse should copy into the target work: %+v", copied)
	}
	env.mustJSON(t, "GET", "/api/v1/assets", nil, &lib)
	for _, a := range lib {
		if a.ID == copied.ID {
			t.Fatal("reused copies must not show up again in the library")
		}
	}
}

func TestPostPushTodosTickableAfterPublished(t *testing.T) {
	f := env.accounts(t)
	wk := env.readyWork(t, f.wechat, "发布后还能勾选后台待办")
	if ev := lastEvent(t, env.push(t, wk, map[string]any{"confirm_over_limit": true})); ev.Name != "done" {
		t.Fatalf("push: %s %s", ev.Name, ev.Data)
	}
	var got Work
	env.mustJSON(t, "POST", "/api/v1/works/"+wk.ID.String()+"/published", map[string]string{}, &got)
	var todos []postPushTodo
	if err := json.Unmarshal(got.PostPushTodos, &todos); err != nil || len(todos) == 0 {
		t.Fatalf("push should seed back-office todos: %s", got.PostPushTodos)
	}
	todos[0].Done = true
	env.mustJSON(t, "PUT", "/api/v1/works/"+wk.ID.String()+"/post-push-todos", map[string]any{"todos": todos}, &got)
	var after []postPushTodo
	_ = json.Unmarshal(got.PostPushTodos, &after)
	if !got.Locked || len(after) != len(todos) || !after[0].Done {
		t.Fatalf("ticking a todo on a locked work should persist: locked=%v %s", got.Locked, got.PostPushTodos)
	}
	var list []WorkListItem
	env.mustJSON(t, "GET", "/api/v1/accounts/"+f.wechat.ID.String()+"/works", nil, &list)
	for _, x := range list {
		if x.ID == wk.ID && (x.TodosDone != 1 || x.TodosTotal != len(todos)) {
			t.Fatalf("list should carry todo progress: %d/%d", x.TodosDone, x.TodosTotal)
		}
	}
	env.expectErr(t, "PATCH", "/api/v1/works/"+wk.ID.String(), map[string]string{"title": "改标题"}, "state_invalid")
}

func TestBreakdownOnlyTopWorksAndReviewInsightIgnore(t *testing.T) {
	f := env.accounts(t)
	pushed := func(name string, reads int) Work {
		wk := env.readyWork(t, f.wechat, name)
		if ev := lastEvent(t, env.push(t, wk, map[string]any{"confirm_over_limit": true})); ev.Name != "done" {
			t.Fatalf("push: %s %s", ev.Name, ev.Data)
		}
		env.mustJSON(t, "POST", "/api/v1/works/"+wk.ID.String()+"/metrics", map[string]int{"reads": reads, "likes": 1}, nil)
		return wk
	}
	best := pushed("拆解：表现最好", 900000000)
	low := pushed("拆解：表现一般", 1)
	env.expectErr(t, "POST", "/api/v1/works/"+low.ID.String()+"/breakdown", nil, "state_invalid")
	var bd struct {
		Breakdown Breakdown `json:"breakdown"`
	}
	env.mustJSON(t, "POST", "/api/v1/works/"+best.ID.String()+"/breakdown", nil, &bd)
	if len(bd.Breakdown.Structure) == 0 {
		t.Fatalf("breakdown should return a structure: %+v", bd)
	}
	var mem Memory
	env.mustJSON(t, "POST", "/api/v1/accounts/"+f.wechat.ID.String()+"/memories", map[string]string{"kind": "structure", "text": "先抛场景再给结论", "source": "breakdown"}, &mem)
	if mem.Source != "breakdown" || mem.Status != "active" {
		t.Fatalf("remembered breakdown rule should be active with source breakdown: %+v", mem)
	}

	var rep ReviewReport
	env.mustJSON(t, "POST", "/api/v1/accounts/"+f.wechat.ID.String()+"/reviews", map[string]any{"work_ids": []string{best.ID.String()}}, &rep)
	if len(rep.Content.WritingInsights) < 2 {
		t.Fatalf("mock review should carry writing insights: %+v", rep.Content)
	}
	env.mustJSON(t, "POST", "/api/v1/review-reports/"+rep.ID.String()+"/insights/1/ignore", nil, nil)
	var list []ReviewReport
	env.mustJSON(t, "GET", "/api/v1/accounts/"+f.wechat.ID.String()+"/reviews", nil, &list)
	for _, x := range list {
		if x.ID == rep.ID && (len(x.Ignored) != 1 || x.Ignored[0] != 1) {
			t.Fatalf("ignore should persist on the report: %+v", x.Ignored)
		}
	}
	var outcome string
	if err := env.srv.db.QueryRow(context.Background(), `SELECT f.outcome FROM ai_feedback f JOIN review_report r ON r.ai_call_id=f.ai_call_id WHERE r.id=$1`, rep.ID).Scan(&outcome); err != nil || outcome != "rejected" {
		t.Fatalf("ignoring an insight should record rejected feedback: %q %v", outcome, err)
	}
}

func TestTitleFavoritesStoredOnWork(t *testing.T) {
	f := env.accounts(t)
	var wk Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+f.wechat.ID.String()+"/works", map[string]string{"title": "原标题"}, &wk)
	items := []map[string]string{{"text": "候选一", "style": "提问式"}, {"text": "候选一", "style": "重复"}, {"text": "  ", "style": "空"}, {"text": "候选二", "style": "数字式"}}
	env.mustJSON(t, "PUT", "/api/v1/works/"+wk.ID.String()+"/title-favorites", map[string]any{"items": items}, nil)
	var got Work
	env.mustJSON(t, "GET", "/api/v1/works/"+wk.ID.String(), nil, &got)
	var favs []struct{ Text, Style string }
	_ = json.Unmarshal(got.TitleFavorites, &favs)
	if len(favs) != 2 || favs[0].Text != "候选一" || favs[1].Text != "候选二" || got.Title != "原标题" || got.Revision != wk.Revision {
		t.Fatalf("favorites should dedupe, skip blanks and leave the title and revision alone: %+v title=%q rev=%d", favs, got.Title, got.Revision)
	}
}

func TestOutlineTemplateShapesPrompt(t *testing.T) {
	f := env.accounts(t)
	var list []OutlineTemplate
	env.mustJSON(t, "PUT", "/api/v1/outline-templates", map[string]any{"items": []map[string]string{{"name": "三段式", "structure": "现象 → 原因 → 对策"}}}, &list)
	var custom *OutlineTemplate
	for i := range list {
		if !list[i].Builtin {
			custom = &list[i]
		}
	}
	if custom == nil || len(list) != len(builtinOutlineTemplates)+1 {
		t.Fatalf("custom template should be added next to the builtin ones: %+v", list)
	}
	env.expectErr(t, "PUT", "/api/v1/outline-templates", map[string]any{"items": []map[string]string{{"name": "", "structure": "x"}}}, "validation_failed")

	var wk Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+f.wechat.ID.String()+"/works", map[string]string{"title": "模板测试"}, &wk)
	env.mustJSON(t, "PATCH", "/api/v1/works/"+wk.ID.String(), map[string]string{"viewpoint": "先找原因再谈对策"}, nil)
	var out struct {
		Items    []OutlineItem `json:"items"`
		AICallID uuid.UUID     `json:"ai_call_id"`
	}
	env.mustJSON(t, "POST", "/api/v1/works/"+wk.ID.String()+"/outline/generate", map[string]string{"template": custom.ID}, &out)
	var heads []string
	for _, it := range out.Items {
		heads = append(heads, it.Heading)
	}
	if !reflect.DeepEqual(heads, []string{"现象", "原因", "对策"}) {
		t.Fatalf("outline should follow the template structure sent in the prompt: %v", heads)
	}
	var name string
	_ = env.srv.db.QueryRow(context.Background(), `SELECT context_refs->>'outline_template' FROM ai_call WHERE id=$1`, out.AICallID).Scan(&name)
	if name != "三段式" {
		t.Fatalf("ai_call should record the template used, got %q", name)
	}
	env.expectErr(t, "POST", "/api/v1/works/"+wk.ID.String()+"/outline/generate", map[string]string{"template": "nope"}, "validation_failed")
}

func TestPolishIgnoreSticks(t *testing.T) {
	f := env.accounts(t)
	wk := outlinedWork(t, f.wechat, "体检忽略")
	setSection(t, wk.Sections[0], "这是一句非常非常长的句子，它包含了很多很多的内容，读者读到这里的时候可能已经忘记了开头说的是什么事情了吧。短句。")
	type resp struct {
		Issues  []PolishIssue `json:"issues"`
		Ignored int           `json:"ignored"`
	}
	var r resp
	env.mustJSON(t, "POST", "/api/v1/works/"+wk.ID.String()+"/polish-check", map[string]any{}, &r)
	if len(r.Issues) == 0 || r.Ignored != 0 {
		t.Fatalf("long sentence should be reported: %+v", r)
	}
	first := r.Issues[0]
	env.mustJSON(t, "POST", "/api/v1/works/"+wk.ID.String()+"/polish-ignore", map[string]string{"key": first.key()}, nil)
	env.mustJSON(t, "POST", "/api/v1/works/"+wk.ID.String()+"/polish-ignore", map[string]string{"key": first.key()}, nil)
	var again resp
	env.mustJSON(t, "POST", "/api/v1/works/"+wk.ID.String()+"/polish-check", map[string]any{}, &again)
	if again.Ignored != 1 || len(again.Issues) != len(r.Issues)-1 {
		t.Fatalf("ignored issue should stay hidden on re-run (once): %+v", again)
	}
	for _, i := range again.Issues {
		if i.key() == first.key() {
			t.Fatal("ignored issue came back")
		}
	}
	env.mustJSON(t, "POST", "/api/v1/works/"+wk.ID.String()+"/polish-ignore", map[string]bool{"clear": true}, nil)
	env.mustJSON(t, "POST", "/api/v1/works/"+wk.ID.String()+"/polish-check", map[string]any{}, &again)
	if again.Ignored != 0 || len(again.Issues) != len(r.Issues) {
		t.Fatalf("clearing should bring every issue back: %+v", again)
	}
}

func TestSectionSaveRecordsAppliedAI(t *testing.T) {
	f := env.accounts(t)
	wk := outlinedWork(t, f.wechat, "接受建议后的来源")
	sec := setSection(t, wk.Sections[0], "我自己写的第一句。")
	if sec.Origin != "human" {
		t.Fatalf("hand-written section should stay human, got %s", sec.Origin)
	}
	var out struct {
		Section Section `json:"section"`
	}
	env.mustJSON(t, "PATCH", "/api/v1/sections/"+sec.ID.String(), map[string]any{"content_md": sec.ContentMD + "AI 接的半句。", "base_revision": sec.Revision,
		"applied": map[string]any{"kind": "continue"}}, &out)
	if out.Section.Origin != "mixed" {
		t.Fatalf("accepting ghost text should mark the section as AI + human, got %s", out.Section.Origin)
	}
	env.mustJSON(t, "PATCH", "/api/v1/sections/"+sec.ID.String(), map[string]any{"content_md": "改写后的整段。", "base_revision": out.Section.Revision,
		"applied": map[string]any{"kind": "rewrite"}}, &out)
	var revs []SectionRevision
	env.mustJSON(t, "GET", "/api/v1/sections/"+sec.ID.String()+"/revisions", nil, &revs)
	if len(revs) < 3 || revs[0].Origin != "rewrite" || revs[1].Origin != "mixed" {
		t.Fatalf("section history should label the rewrite replacement: %+v", revs)
	}
	var restored Work
	env.mustJSON(t, "POST", "/api/v1/sections/"+sec.ID.String()+"/revisions/"+revs[0].ID.String()+"/restore", nil, &restored)
	for _, s := range restored.Sections {
		if s.ID == sec.ID && s.Origin != "mixed" {
			t.Fatalf("restoring a rewrite revision must keep a valid section origin, got %s", s.Origin)
		}
	}
}

func TestTopicPinAndSeriesContext(t *testing.T) {
	f := env.accounts(t)
	acc := "/api/v1/accounts/" + f.xhs.ID.String()
	var sr Series
	env.mustJSON(t, "POST", acc+"/series", map[string]string{"name": "新人十讲", "outline": "从入职到转正"}, &sr)
	var ids []uuid.UUID
	for i, title := range []string{"第一讲：入职第一周", "第二讲：第一次汇报", "第三讲：第一次犯错"} {
		var out struct {
			Topic Topic `json:"topic"`
		}
		env.mustJSON(t, "POST", acc+"/topics", map[string]any{"title": title, "angle": "角度" + title, "series_id": sr.ID.String(),
			"planned_date": time.Now().AddDate(0, 0, i+1).Format("2006-01-02")}, &out)
		ids = append(ids, out.Topic.ID)
	}

	env.mustJSON(t, "PATCH", "/api/v1/topics/"+ids[0].String(), map[string]any{"pinned": true}, nil)
	for _, q := range []string{"", "?sort=score"} {
		var list []Topic
		env.mustJSON(t, "GET", acc+"/topics"+q, nil, &list)
		if len(list) == 0 || list[0].ID != ids[0] || !list[0].Pinned {
			t.Fatalf("pinned topic should come first (%q): %+v", q, list)
		}
	}
	env.mustJSON(t, "PATCH", "/api/v1/topics/"+ids[0].String(), map[string]any{"title": "第一讲：入职第一周（改）"}, nil)
	var still []Topic
	env.mustJSON(t, "GET", acc+"/topics", nil, &still)
	if !still[0].Pinned || still[0].ID != ids[0] {
		t.Fatal("editing other fields must not unpin")
	}
	env.mustJSON(t, "PATCH", "/api/v1/topics/"+ids[0].String(), map[string]any{"pinned": false}, nil)
	env.mustJSON(t, "GET", acc+"/topics", nil, &still)
	for _, x := range still {
		if x.Pinned {
			t.Fatalf("unpinned topic still pinned: %+v", x)
		}
	}

	env.mustJSON(t, "PATCH", "/api/v1/topics/"+ids[1].String(), map[string]string{"status": "adopted"}, nil)
	var wk Work
	env.mustJSON(t, "POST", "/api/v1/topics/"+ids[1].String()+"/works", nil, &wk)
	if wk.Viewpoint != "" {
		t.Fatalf("starting from a topic must not fill the viewpoint (H-02): %q", wk.Viewpoint)
	}
	var sc SeriesContext
	env.mustJSON(t, "GET", "/api/v1/works/"+wk.ID.String()+"/series-context", nil, &sc)
	if sc.Position != 2 || sc.Total != 3 || sc.Prev == nil || sc.Next == nil || sc.Prev.TopicID != ids[0] || sc.Next.TopicID != ids[2] {
		t.Fatalf("series context should show both neighbours: %+v", sc)
	}
	if sc.Prev.Viewpoint != "角度第一讲：入职第一周" {
		t.Fatalf("neighbour without a work should fall back to the topic angle: %q", sc.Prev.Viewpoint)
	}

	var plain Work
	env.mustJSON(t, "POST", acc+"/works", map[string]string{"title": "不在系列里"}, &plain)
	code, body := env.do("GET", "/api/v1/works/"+plain.ID.String()+"/series-context", nil)
	if code != 200 || strings.TrimSpace(string(body)) != "null" {
		t.Fatalf("work outside a series should return null, got %d %s", code, body)
	}
}

func TestWorkFamilyWalksToRoot(t *testing.T) {
	f := env.accounts(t)
	root := env.readyWork(t, f.wechat, "版本族根作品")
	var child, grand Work
	env.mustJSON(t, "POST", "/api/v1/works/"+root.ID.String()+"/derive", map[string]string{"target_account_id": f.xhs.ID.String()}, &child)
	if st, body := env.do("POST", "/api/v1/works/"+child.ID.String()+"/derive", map[string]string{"target_account_id": f.wechat.ID.String()}); st != 200 {
		t.Skipf("second-level derive not allowed here: %d %s", st, body)
	} else if err := json.Unmarshal(body, &grand); err != nil {
		t.Fatal(err)
	}
	var fam []FamilyMember
	env.mustJSON(t, "GET", "/api/v1/works/"+grand.ID.String()+"/family", nil, &fam)
	if len(fam) != 3 || fam[0].ID != root.ID || fam[2].ID != grand.ID || fam[2].Depth != 2 {
		t.Fatalf("family should list root, child and grandchild in order: %+v", fam)
	}
}

func TestFirstDraftTimeRecordedWhenAllSectionsFilled(t *testing.T) {
	f := env.accounts(t)
	wk := outlinedWork(t, f.wechat, "首稿时间")
	at := func() *time.Time {
		var v *time.Time
		if err := env.srv.db.QueryRow(context.Background(), `SELECT first_draft_at FROM work WHERE id=$1`, wk.ID).Scan(&v); err != nil {
			t.Fatal(err)
		}
		return v
	}
	s0 := setSection(t, wk.Sections[0], "第一段有内容了。")
	if at() != nil {
		t.Fatal("first draft time must wait until every section has content")
	}
	setSection(t, wk.Sections[1], "第二段也有内容了。")
	first := at()
	if first == nil {
		t.Fatal("first draft time should be set once all sections have content")
	}
	setSection(t, s0, "后续修改不应改变首稿时间。")
	if again := at(); again == nil || !again.Equal(*first) {
		t.Fatalf("first draft time must not move: %v -> %v", first, again)
	}
}

func TestNumbersMustComeFromInput(t *testing.T) {
	src := "发布 4 篇（过去 4 周平均每周 2.5 篇），阅读合计 12,345，互动合计 678。"
	if bad := numbersNotIn("上周发布 4 篇，阅读 12345，两个亮点里第 1 个是互动 678", src); len(bad) != 0 {
		t.Fatalf("numbers from the input should pass: %v", bad)
	}
	if bad := numbersNotIn("阅读增长了 35%，平均 3.2 篇，累计 9999 次", src); len(bad) != 3 {
		t.Fatalf("invented numbers should be caught: %v", bad)
	}
	d := BootstrapDraft{PositioningTags: []string{" ", ""}}
	if validBootstrap(&d) == nil {
		t.Fatal("an empty bootstrap draft must fail validation so it is retried")
	}
}

func TestClientErrorLogCarriesNoContent(t *testing.T) {
	path, msg := clientErrorLine("/works/0b6f4c1e-2a3b-4c5d-8e9f-0a1b2c3d4e5f/check?tab=x#s", `TypeError: cannot read "我的私密正文" of undefined`)
	if path != "/works/:id/check" {
		t.Fatalf("path should drop ids and query: %q", path)
	}
	if strings.Contains(msg, "私密正文") {
		t.Fatalf("quoted fragments must not reach the log: %q", msg)
	}
	env.mustJSON(t, "POST", "/api/v1/client-errors", map[string]any{"message": "boom", "path": "/a/x", "where": "page"}, nil)
}

func TestInviteAcceptedNotifiesOwner(t *testing.T) {
	var inv struct {
		Code string `json:"code"`
	}
	env.mustJSON(t, "POST", "/api/v1/workspaces/current/invites", map[string]any{"role": "viewer", "max_uses": 1, "days": 1}, &inv)
	other := env.registerClient(t, "joiner-notify", testPassword)
	st, body := other.do("POST", "/api/v1/workspaces/join", map[string]any{"code": inv.Code, "switch": true})
	other.restore(env)
	if st != 200 {
		t.Fatalf("join: %d %s", st, body)
	}
	var list struct {
		Items []Notification `json:"items"`
	}
	env.mustJSON(t, "GET", "/api/v1/notifications", nil, &list)
	for _, n := range list.Items {
		if strings.Contains(n.Title, "joiner-notify") && n.Link == "/settings/members" {
			return
		}
	}
	t.Fatal("owner should be told that the invite was accepted")
}

func TestSectionRollbackTouchesOneSection(t *testing.T) {
	f := env.accounts(t)
	wk := outlinedWork(t, f.wechat, "回滚只动一段")
	a := setSection(t, wk.Sections[0], "第一版：先把问题写清楚，再去找答案。")
	a = setSection(t, a, "第二版：问题写清楚之后，答案往往自己就出来了。")
	b := setSection(t, wk.Sections[1], "另一段的内容不应该受影响。")
	var revs []SectionRevision
	env.mustJSON(t, "GET", "/api/v1/sections/"+a.ID.String()+"/revisions", nil, &revs)
	var first *SectionRevision
	for i := range revs {
		if revs[i].ContentMD == "第一版：先把问题写清楚，再去找答案。" {
			first = &revs[i]
		}
	}
	if first == nil {
		raw, _ := json.Marshal(revs)
		t.Fatalf("first revision not kept: %s", raw)
	}
	var after Work
	env.mustJSON(t, "POST", "/api/v1/sections/"+a.ID.String()+"/revisions/"+first.ID.String()+"/restore", nil, &after)
	for _, s := range after.Sections {
		switch s.ID {
		case a.ID:
			if s.ContentMD != first.ContentMD {
				t.Fatalf("section not rolled back: %q", s.ContentMD)
			}
		case b.ID:
			if s.ContentMD != b.ContentMD || s.Revision != b.Revision {
				t.Fatal("rollback must not touch other sections")
			}
		}
	}
}
