package app

// HC-01 至 HC-10：人工确认点与红线的回归测试（08 文档第 6 节）。不得删除或跳过。

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
)

func topicCount(t *testing.T, accountID string) int {
	t.Helper()
	var list []Topic
	env.mustJSON(t, "GET", "/api/v1/accounts/"+accountID+"/topics", nil, &list)
	return len(list)
}

func routes(t *testing.T) []string {
	t.Helper()
	var out []string
	err := chi.Walk(env.srv.Router().(chi.Routes), func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		out = append(out, method+" "+route)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func TestHC01_SuggestTopicsDoesNotWritePool(t *testing.T) {
	f := env.accounts(t)
	id := f.wechat.ID.String()
	before := topicCount(t, id)
	var res struct {
		Suggestions []map[string]string `json:"suggestions"`
	}
	env.mustJSON(t, "POST", "/api/v1/accounts/"+id+"/topics/suggest", map[string]string{"direction": "时间管理"}, &res)
	if len(res.Suggestions) < 5 {
		t.Fatalf("want at least 5 suggestions, got %d", len(res.Suggestions))
	}
	if after := topicCount(t, id); after != before {
		t.Fatalf("suggest wrote to topic pool: %d -> %d", before, after)
	}
	// 入库只能逐条：请求体只接受一个选题。
	env.mustJSON(t, "POST", "/api/v1/accounts/"+id+"/topics", map[string]string{"title": res.Suggestions[0]["title"], "angle": res.Suggestions[0]["angle"], "source": "ai"}, nil)
	if after := topicCount(t, id); after != before+1 {
		t.Fatalf("want exactly one new topic, got %d -> %d", before, after)
	}
	for _, r := range routes(t) {
		if strings.Contains(r, "topics") && (strings.Contains(r, "batch") || strings.Contains(r, "bulk") || strings.Contains(r, "all")) {
			t.Fatalf("batch topic route exists: %s", r)
		}
	}
}

func TestHC02_OutlineRequiresViewpoint(t *testing.T) {
	f := env.accounts(t)
	var wk Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+f.wechat.ID.String()+"/works", map[string]string{"title": "没有观点"}, &wk)
	ae := env.expectErr(t, "POST", "/api/v1/works/"+wk.ID.String()+"/outline/generate", nil, "human_step_required")
	if !strings.Contains(string(ae.Error.Detail), "H-02") {
		t.Fatalf("want H-02, got %s", ae.Error.Detail)
	}
}

func TestHC03_DraftRequiresConfirmedOutline(t *testing.T) {
	f := env.accounts(t)
	var wk Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+f.wechat.ID.String()+"/works", map[string]string{"title": "大纲未确认"}, &wk)
	id := wk.ID.String()
	env.mustJSON(t, "PATCH", "/api/v1/works/"+id, map[string]string{"viewpoint": "先想清楚再动笔"}, nil)
	env.expectErr(t, "POST", "/api/v1/works/"+id+"/sections", map[string]string{"heading": "手动段落"}, "human_step_required")
	// 大纲保存但未确认：仍然不能起稿（段落直接写库，模拟任何绕过界面的情况）。
	env.mustJSON(t, "PUT", "/api/v1/works/"+id+"/outline", map[string]any{"items": []OutlineItem{{Heading: "未确认的大纲项"}}}, nil)
	var secID string
	if err := env.srv.db.QueryRow(context.Background(), `INSERT INTO work_section (work_id, position, heading) VALUES ($1,0,'绕过的段落') RETURNING id::text`, wk.ID).Scan(&secID); err != nil {
		t.Fatal(err)
	}
	ae := env.expectErr(t, "POST", "/api/v1/sections/"+secID+"/draft", nil, "human_step_required")
	if !strings.Contains(string(ae.Error.Detail), "H-03") {
		t.Fatalf("want H-03, got %s", ae.Error.Detail)
	}
	for _, r := range routes(t) {
		if strings.Contains(r, "draft") && !strings.Contains(r, "/sections/{id}/draft") {
			t.Fatalf("unexpected draft route: %s", r)
		}
	}
}

func TestHC04_PushAndPackRequireConfirmedChecks(t *testing.T) {
	f := env.accounts(t)
	for _, a := range []Account{f.wechat, f.xhs} {
		var wk Work
		env.mustJSON(t, "POST", "/api/v1/accounts/"+a.ID.String()+"/works", map[string]string{"title": "未检查"}, &wk)
		id := wk.ID.String()
		if a.Platform == "wechat_mp" {
			ae := env.expectErr(t, "POST", "/api/v1/works/"+id+"/wechat/push", map[string]any{"html": "<p>x</p>", "revision": wk.Revision}, "human_step_required")
			if !strings.Contains(string(ae.Error.Detail), "H-04") {
				t.Fatalf("want H-04, got %s", ae.Error.Detail)
			}
		} else {
			env.expectErr(t, "POST", "/api/v1/works/"+id+"/xhs/pack", nil, "human_step_required")
		}
		// 有未确认项时不能完成检查。
		env.mustJSON(t, "PATCH", "/api/v1/works/"+id, map[string]string{"viewpoint": "观点"}, nil)
		env.mustJSON(t, "POST", "/api/v1/works/"+id+"/checks", nil, nil)
		env.latestCheck(t, id)
		env.expectErr(t, "POST", "/api/v1/works/"+id+"/checks/complete", nil, "human_step_required")
	}
	for _, r := range routes(t) {
		if strings.Contains(r, "check") && (strings.Contains(r, "batch") || strings.Contains(r, "bulk") || strings.Contains(r, "all") || strings.Contains(r, "confirm")) {
			t.Fatalf("batch check route exists: %s", r)
		}
		if strings.HasPrefix(r, "PATCH") && strings.Contains(r, "check") && r != "PATCH /api/v1/check-items/{id}" {
			t.Fatalf("unexpected check update route: %s", r)
		}
	}
}

func TestHC05_PushIsSingleWorkOnly(t *testing.T) {
	var push []string
	for _, r := range routes(t) {
		low := strings.ToLower(r)
		for _, bad := range []string{"batch", "bulk", "schedule", "cron", "timer", "push-all", "pushall"} {
			if strings.Contains(low, bad) {
				t.Fatalf("forbidden route: %s", r)
			}
		}
		if strings.Contains(r, "push") && strings.HasPrefix(r, "POST") {
			push = append(push, r)
		}
	}
	if len(push) != 1 || push[0] != "POST /api/v1/works/{id}/wechat/push" {
		t.Fatalf("push routes: %v", push)
	}
}

func goSources(t *testing.T) map[string]string {
	t.Helper()
	root, _ := filepath.Abs("../..")
	files := map[string]string{}
	_ = filepath.Walk(root, func(p string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() || !strings.HasSuffix(p, ".go") || strings.HasSuffix(p, "_test.go") {
			return nil
		}
		b, _ := os.ReadFile(p)
		files[p] = string(b)
		return nil
	})
	if len(files) < 10 {
		t.Fatalf("source scan found only %d files", len(files))
	}
	return files
}

func TestHC06_NoPublishOrMassSendAPIs(t *testing.T) {
	forbidden := regexp.MustCompile(`freepublish|message/mass|mass/send|mass/sendall|masssend|/cgi-bin/message/`)
	for p, src := range goSources(t) {
		if loc := forbidden.FindStringIndex(src); loc != nil {
			t.Fatalf("%s calls a publish/mass-send API: %q", p, src[loc[0]:loc[1]])
		}
	}
}

func TestHC07_OnlyHumanMarksPublished(t *testing.T) {
	f := env.accounts(t)
	wk := env.readyWork(t, f.wechat, "发布状态只能由人回填")
	if ev := lastEvent(t, env.push(t, wk, nil)); ev.Name != "done" {
		t.Fatalf("push: %s %s", ev.Name, ev.Data)
	}
	env.srv.runJobsOnce(context.Background())
	var got Work
	env.mustJSON(t, "GET", "/api/v1/works/"+wk.ID.String(), nil, &got)
	if got.Status != "pushed" {
		t.Fatalf("after push and jobs, want pushed, got %s", got.Status)
	}
	setPublished := regexp.MustCompile(`status\s*=\s*'published'`)
	count := 0
	for p, src := range goSources(t) {
		n := len(setPublished.FindAllStringIndex(src, -1))
		if n > 0 && filepath.Base(p) != "publish.go" {
			t.Fatalf("%s sets status published", p)
		}
		count += n
	}
	if count != 1 {
		t.Fatalf("want exactly one place setting published (markPublished), got %d", count)
	}
	env.mustJSON(t, "POST", "/api/v1/works/"+wk.ID.String()+"/published", map[string]string{"url": "https://mp.weixin.qq.com/s/test"}, &got)
	if got.Status != "published" || !got.Locked {
		t.Fatalf("want published+locked, got %s %v", got.Status, got.Locked)
	}
}

func TestHC08_ReviewDoesNotWriteTopics(t *testing.T) {
	f := env.accounts(t)
	wk := env.readyWork(t, f.wechat, "复盘只给建议")
	if ev := lastEvent(t, env.push(t, wk, map[string]any{"confirm_over_limit": true})); ev.Name != "done" {
		t.Fatalf("push: %s %s", ev.Name, ev.Data)
	}
	env.mustJSON(t, "POST", "/api/v1/works/"+wk.ID.String()+"/metrics", map[string]int{"reads": 1200, "likes": 30}, nil)
	id := f.wechat.ID.String()
	before := topicCount(t, id)
	var rep ReviewReport
	env.mustJSON(t, "POST", "/api/v1/accounts/"+id+"/reviews", map[string]any{"work_ids": []string{wk.ID.String()}}, &rep)
	if len(rep.Content.TopicSuggestions) < 3 {
		t.Fatalf("want >=3 suggestions, got %d", len(rep.Content.TopicSuggestions))
	}
	if after := topicCount(t, id); after != before {
		t.Fatalf("review wrote topics: %d -> %d", before, after)
	}
	env.mustJSON(t, "POST", "/api/v1/review-reports/"+rep.ID.String()+"/suggestions/1/adopt", nil, nil)
	if after := topicCount(t, id); after != before+1 {
		t.Fatalf("adopt should add exactly one topic: %d -> %d", before, after)
	}
	env.expectErr(t, "POST", "/api/v1/review-reports/"+rep.ID.String()+"/suggestions/1/adopt", nil, "state_invalid")
}

func TestHC09_DeriveRejectsSamePlatform(t *testing.T) {
	f := env.accounts(t)
	var second Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{"platform": "wechat_mp", "name": "第二个公众号", "content_format": "long_article"}, &second)
	wk := env.readyWork(t, f.wechat, "派生只能跨平台")
	ae := env.expectErr(t, "POST", "/api/v1/works/"+wk.ID.String()+"/derive", map[string]string{"target_account_id": second.ID.String()}, "validation_failed")
	if !strings.Contains(ae.Error.Message, "不同平台") {
		t.Fatalf("unexpected message: %s", ae.Error.Message)
	}
	env.mustJSON(t, "POST", "/api/v1/accounts/"+second.ID.String()+"/disable", nil, nil)
}

func TestHC10_DailyPushLimitNeedsConfirmation(t *testing.T) {
	f := env.accounts(t)
	id := f.wechat.ID.String()
	env.expectErr(t, "PATCH", "/api/v1/accounts/"+id, map[string]any{"daily_push_limit": 0}, "validation_failed")
	env.mustJSON(t, "PATCH", "/api/v1/accounts/"+id, map[string]any{"daily_push_limit": 1}, nil)
	defer env.mustJSON(t, "PATCH", "/api/v1/accounts/"+id, map[string]any{"daily_push_limit": 3}, nil)
	// 前面的测试已经推送过，今天的次数已达上限 1。
	wk := env.readyWork(t, f.wechat, "频繁推送需要确认")
	ae := env.expectErr(t, "POST", "/api/v1/works/"+wk.ID.String()+"/wechat/push",
		map[string]any{"html": testHTML(wk), "revision": wk.Revision, "fields": wk.WechatFields}, "push_limit_reached")
	var detail map[string]int
	_ = json.Unmarshal(ae.Error.Detail, &detail)
	if detail["daily_limit"] != 1 {
		t.Fatalf("detail: %s", ae.Error.Detail)
	}
	if ev := lastEvent(t, env.push(t, wk, map[string]any{"confirm_over_limit": true})); ev.Name != "done" {
		t.Fatalf("confirmed push: %s %s", ev.Name, ev.Data)
	}
	var over bool
	if err := env.srv.db.QueryRow(context.Background(), `SELECT over_limit FROM push_record WHERE work_id=$1 AND status='ok'`, wk.ID).Scan(&over); err != nil || !over {
		t.Fatalf("over-limit push not recorded: %v %v", over, err)
	}
}

// HC-11：跨工作区用 ID 访问账号 → 404（D-036 租户隔离）
func TestHC11_CrossWorkspaceAccountIs404(t *testing.T) {
	f := env.accounts(t)
	other := env.registerClient(t, "tenant-b", testPassword)
	defer other.restore(env)
	st, body := other.do("GET", "/api/v1/accounts/"+f.wechat.ID.String(), nil)
	if st != 404 {
		t.Fatalf("cross-tenant account: want 404, got %d %s", st, body)
	}
}

// HC-12：editor 不能改模型密钥（D-036 权限）
func TestHC12_EditorCannotCreateModelProvider(t *testing.T) {
	var inv struct {
		Code string `json:"code"`
	}
	env.mustJSON(t, "POST", "/api/v1/workspaces/current/invites", map[string]any{"role": "editor", "max_uses": 5, "days": 7}, &inv)
	other := env.registerClient(t, "editor-user", testPassword)
	defer other.restore(env)
	st, body := other.do("POST", "/api/v1/workspaces/join", map[string]any{"code": inv.Code, "switch": true})
	if st != 200 {
		t.Fatalf("join: %d %s", st, body)
	}
	var me struct {
		CSRF string `json:"csrf_token"`
		Role string `json:"role"`
	}
	other.mustJSON(t, "GET", "/api/v1/auth/me", nil, &me)
	other.csrf = me.CSRF
	if me.Role != "editor" {
		t.Fatalf("role=%s", me.Role)
	}
	other.mustJSON(t, "POST", "/api/v1/auth/reauth", map[string]string{"password": testPassword}, nil)
	other.mustJSON(t, "GET", "/api/v1/auth/me", nil, &me)
	other.csrf = me.CSRF
	ae := other.expectErr(t, "POST", "/api/v1/model-providers", map[string]any{
		"name": "x", "base_url": "http://example.com/v1", "api_key": "k", "models": []string{"m"},
	}, "forbidden")
	if ae.Error.Code != "forbidden" {
		t.Fatalf("code=%s", ae.Error.Code)
	}
}
