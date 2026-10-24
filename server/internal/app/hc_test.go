package app

// HC-01 至 HC-25：人工确认点与红线的回归测试（08 文档第 6 节、10 文档第 6 节）。不得删除或跳过。

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"ops/internal/crawl"
)

// HC-21 and HC-23 cover the collector seam, in addition to crawl's fake-clock tests.
func TestHC21_CrawlOffMakesNoRequests(t *testing.T) {
	enableTestCrawl(t)
	ctx := context.Background()
	now := time.Date(2026, 10, 10, 0, 0, 0, 0, env.srv.loc)
	env.srv.now = func() time.Time { return now }
	_, err := env.srv.db.Exec(ctx, `UPDATE crawl_source SET enabled=true WHERE key='baidu'`)
	if err != nil {
		t.Fatal(err)
	}
	var before, after int
	if err = env.srv.db.QueryRow(ctx, `SELECT count(*) FROM crawl_run`).Scan(&before); err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"deployment_off", "level_off"} {
		env.srv.cfg.CrawlMode = "allow"
		if mode == "deployment_off" {
			env.srv.cfg.CrawlMode = "off"
		} else {
			_, _ = env.srv.db.Exec(ctx, `UPDATE system_setting SET value='"off"' WHERE key='crawl.level'`)
		}
		for range 1440 {
			env.srv.collectHot(ctx)
			now = now.Add(time.Minute)
		}
	}
	if err = env.srv.db.QueryRow(ctx, `SELECT count(*) FROM crawl_run`).Scan(&after); err != nil || after != before {
		t.Fatalf("disabled collector ran: %d -> %d %v", before, after, err)
	}
	if err = env.srv.db.QueryRow(ctx, `SELECT coalesce(sum(requests),0)::int FROM crawl_budget`).Scan(&after); err != nil || after != 0 {
		t.Fatalf("off requests=%d %v", after, err)
	}
}

func TestHC23_CrawlRequestIdentity(t *testing.T) {
	enableTestCrawl(t)
	calls := 0
	mockServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Header.Get("Cookie") != "" || r.Header.Get("Authorization") != "" || r.Header.Get("User-Agent") != crawl.UserAgent {
			t.Errorf("unexpected identity headers")
		}
		if r.URL.Path == "/robots.txt" {
			_, _ = w.Write([]byte("User-agent: *\nAllow: /\n"))
		} else {
			_, _ = w.Write([]byte(`{"data":[{"Title":"公开标题","Url":"https://example.com/a"}]}`))
		}
	}))
	defer mockServer.Close()
	old := env.srv.cfg.MockListen
	env.srv.cfg.MockListen = strings.TrimPrefix(mockServer.URL, "http://")
	t.Cleanup(func() { env.srv.cfg.MockListen = old })
	ctx := context.Background()
	_, _ = env.srv.db.Exec(ctx, `UPDATE crawl_source SET enabled=true,last_attempt_at=NULL WHERE key='toutiao'`)
	source, err := scanCrawlSource(env.srv.db.QueryRow(ctx, `SELECT `+crawlSourceCols+` FROM crawl_source WHERE key='toutiao'`))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = env.srv.collectSource(ctx, source); err != nil {
		t.Fatal(err)
	}
	if calls != 2 {
		t.Fatalf("requests %d", calls)
	}
	// Adapters may not instantiate their own network clients.
	sourceCode, err := os.ReadFile("../crawl/sources.go")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(sourceCode), "http.Client") || strings.Contains(string(sourceCode), "http.Get(") {
		t.Fatal("adapter bypasses unified client")
	}
}

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
		Suggestions []map[string]any `json:"suggestions"`
	}
	env.mustJSON(t, "POST", "/api/v1/accounts/"+id+"/topics/suggest", map[string]string{"direction": "时间管理"}, &res)
	if len(res.Suggestions) < 5 {
		t.Fatalf("want at least 5 suggestions, got %d", len(res.Suggestions))
	}
	if after := topicCount(t, id); after != before {
		t.Fatalf("suggest wrote to topic pool: %d -> %d", before, after)
	}
	env.mustJSON(t, "POST", "/api/v1/accounts/"+id+"/topics/hot-suggest", map[string]string{"direction": "职场"}, &res)
	if len(res.Suggestions) < 5 {
		t.Fatalf("hot-suggest: want at least 5, got %d", len(res.Suggestions))
	}
	if after := topicCount(t, id); after != before {
		t.Fatalf("hot-suggest wrote to topic pool: %d -> %d", before, after)
	}
	// 入库只能逐条：请求体只接受一个选题。
	env.mustJSON(t, "POST", "/api/v1/accounts/"+id+"/topics", map[string]any{"title": res.Suggestions[0]["title"], "angle": res.Suggestions[0]["angle"], "source": "ai"}, nil)
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

func TestHC02_ConfirmOutlineRequiresViewpoint(t *testing.T) {
	f := env.accounts(t)
	var wk Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+f.wechat.ID.String()+"/works", map[string]string{"title": "确认大纲但没有观点"}, &wk)
	id := wk.ID.String()
	ae := env.expectErr(t, "PUT", "/api/v1/works/"+id+"/outline", map[string]any{
		"items":   []OutlineItem{{Heading: "第一段"}},
		"confirm": true,
	}, "human_step_required")
	if !strings.Contains(string(ae.Error.Detail), "H-02") {
		t.Fatalf("want H-02, got %s", ae.Error.Detail)
	}
	var confirmed *time.Time
	if err := env.srv.db.QueryRow(context.Background(), `SELECT outline_confirmed_at FROM work WHERE id=$1`, wk.ID).Scan(&confirmed); err != nil {
		t.Fatal(err)
	}
	if confirmed != nil {
		t.Fatal("rejected confirm must not set outline_confirmed_at")
	}
	// 写下观点后可以确认，且生成段落块。
	env.mustJSON(t, "PATCH", "/api/v1/works/"+id, map[string]string{"viewpoint": "我自己的观点"}, nil)
	var after Work
	env.mustJSON(t, "PUT", "/api/v1/works/"+id+"/outline", map[string]any{
		"items":   []OutlineItem{{Heading: "第一段"}},
		"confirm": true,
	}, &after)
	if after.OutlineConfirmedAt == nil || len(after.Sections) != 1 {
		t.Fatalf("confirm should create sections, got confirmed=%v sections=%d", after.OutlineConfirmedAt, len(after.Sections))
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
		// 禁止绕过「确认大纲」的起稿入口；草稿箱同步（FR-M10-06）不含正文生成，允许。
		// DEV-SK3 / 23 文档 4.3 节：skills/draft 是技能草拟（G 类，不写正文业务数据），允许。
		if strings.Contains(r, "draft") && !strings.Contains(r, "/sections/{id}/draft") && !strings.Contains(r, "sync-draft") &&
			r != "POST /api/v1/accounts/{accountId}/platform-works/{platformWorkId}/draft" &&
			r != "POST /api/v1/skills/draft" {
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
	// 只认 `UPDATE work ... SET ... status='published'` 这类写入。`WHERE w.status='published'`
	// 是只读比较（头条发布包要判断"同一篇是否已发布到别的平台"），不属于自动改状态。
	setPublished := regexp.MustCompile(`(?is)UPDATE\s+work\b[^;]*?\bSET\b[^;]*?\bstatus\s*=\s*'published'`)
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

// HC-13：viewer 只读，不能创建作品；邀请可发邮件（扩展 FR-M1-06 / FR-M1-11）
func TestHC13_ViewerCannotCreateWork(t *testing.T) {
	f := env.accounts(t)
	var inv struct {
		ID   string `json:"id"`
		Code string `json:"code"`
	}
	env.mustJSON(t, "POST", "/api/v1/workspaces/current/invites", map[string]any{"role": "viewer", "max_uses": 3, "days": 7}, &inv)
	var sent struct {
		Status string `json:"status"`
	}
	env.mustJSON(t, "POST", "/api/v1/workspaces/current/invites/"+inv.ID+"/send-email",
		map[string]any{"email": "viewer@example.com"}, &sent)
	if sent.Status != "dev_logged" && sent.Status != "sent" {
		t.Fatalf("email status=%s", sent.Status)
	}

	other := env.registerClient(t, "viewer-user", testPassword)
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
	if me.Role != "viewer" {
		t.Fatalf("role=%s", me.Role)
	}
	ae := other.expectErr(t, "POST", "/api/v1/accounts/"+f.wechat.ID.String()+"/works", map[string]any{
		"title": "不应创建", "content_format": "long_article",
	}, "forbidden")
	if ae.Error.Code != "forbidden" {
		t.Fatalf("code=%s", ae.Error.Code)
	}
}

// HC-14：所有者可转让（D-036）；转让后原 owner 变为 editor
func TestHC14_TransferOwner(t *testing.T) {
	var self struct {
		UserID string `json:"user_id"`
		Role   string `json:"role"`
	}
	env.mustJSON(t, "GET", "/api/v1/auth/me", nil, &self)
	var inv struct {
		Code string `json:"code"`
	}
	env.mustJSON(t, "POST", "/api/v1/workspaces/current/invites", map[string]any{"role": "editor", "max_uses": 2, "days": 7}, &inv)
	other := env.registerClient(t, "next-owner", testPassword)
	defer func() {
		other.use()
		_, _ = other.do("POST", "/api/v1/workspaces/current/transfer", map[string]any{"user_id": self.UserID})
		other.restore(env)
	}()
	st, body := other.do("POST", "/api/v1/workspaces/join", map[string]any{"code": inv.Code, "switch": true})
	if st != 200 {
		t.Fatalf("join: %d %s", st, body)
	}
	var ome struct {
		UserID string `json:"user_id"`
		Role   string `json:"role"`
		CSRF   string `json:"csrf_token"`
	}
	other.mustJSON(t, "GET", "/api/v1/auth/me", nil, &ome)
	other.csrf = ome.CSRF
	if ome.Role != "editor" {
		t.Fatalf("join role=%s", ome.Role)
	}
	other.restore(env)
	env.mustJSON(t, "POST", "/api/v1/workspaces/current/transfer", map[string]any{"user_id": ome.UserID}, nil)
	var me struct {
		Role string `json:"role"`
	}
	env.mustJSON(t, "GET", "/api/v1/auth/me", nil, &me)
	if me.Role != "editor" {
		t.Fatalf("former owner role=%s", me.Role)
	}
	other.mustJSON(t, "GET", "/api/v1/auth/me", nil, &ome)
	if ome.Role != "owner" {
		t.Fatalf("new owner role=%s", ome.Role)
	}
	other.restore(env)
	env.expectErr(t, "POST", "/api/v1/workspaces/current/invites", map[string]any{"role": "editor"}, "forbidden")
}

// HC-15：全站超级管理员（D-044 / FR-M1-12）；永久超管为 skyeder
func TestHC15_SystemAdmin(t *testing.T) {
	const adminUser = "skyeder"
	const adminPass = testAdminPassword
	st, body := env.do("POST", "/api/v1/auth/login", map[string]string{"username": adminUser, "password": adminPass})
	if st != 200 {
		t.Fatalf("login permanent admin: %d %s", st, body)
	}
	var me struct {
		UserID        string `json:"user_id"`
		Username      string `json:"username"`
		IsSystemAdmin bool   `json:"is_system_admin"`
		CSRF          string `json:"csrf_token"`
	}
	env.mustJSON(t, "GET", "/api/v1/auth/me", nil, &me)
	env.csrf = me.CSRF
	if !me.IsSystemAdmin || me.Username != adminUser {
		t.Fatalf("want permanent admin %s, got user=%s admin=%v", adminUser, me.Username, me.IsSystemAdmin)
	}
	defer func() {
		st, body := env.do("POST", "/api/v1/auth/login", map[string]string{"username": "owner", "password": testPassword})
		if st != 200 {
			t.Fatalf("restore owner session: %d %s", st, body)
		}
		var ownerMe struct {
			CSRF string `json:"csrf_token"`
		}
		env.mustJSON(t, "GET", "/api/v1/auth/me", nil, &ownerMe)
		env.csrf = ownerMe.CSRF
	}()

	tenantName := "tenant-admin-" + t.Name()
	other := env.registerClient(t, tenantName, testPassword)
	defer other.restore(env)
	var ome struct {
		UserID        string `json:"user_id"`
		IsSystemAdmin bool   `json:"is_system_admin"`
		CSRF          string `json:"csrf_token"`
		Workspace     struct {
			ID string `json:"id"`
		} `json:"workspace"`
	}
	other.mustJSON(t, "GET", "/api/v1/auth/me", nil, &ome)
	other.csrf = ome.CSRF
	if ome.IsSystemAdmin {
		t.Fatal("second user must not be system admin")
	}
	ae := other.expectErr(t, "GET", "/api/v1/admin/users", nil, "forbidden")
	if ae.Error.Code != "forbidden" {
		t.Fatalf("code=%s", ae.Error.Code)
	}
	other.restore(env)

	var users []struct {
		ID       string `json:"id"`
		Username string `json:"username"`
	}
	env.mustJSON(t, "GET", "/api/v1/admin/users", nil, &users)
	if len(users) < 2 {
		t.Fatalf("want >=2 users, got %d", len(users))
	}

	env.mustJSON(t, "POST", "/api/v1/admin/users/"+ome.UserID+"/revoke-sessions", map[string]any{}, nil)
	env.mustJSON(t, "PATCH", "/api/v1/admin/users/"+ome.UserID, map[string]any{"disabled": true}, nil)
	st, body = other.do("POST", "/api/v1/auth/login", map[string]string{"username": tenantName, "password": testPassword})
	if st == 200 {
		t.Fatalf("disabled user should not login: %s", body)
	}
	other.restore(env)
	env.mustJSON(t, "PATCH", "/api/v1/admin/users/"+ome.UserID, map[string]any{"disabled": false}, nil)

	var workspaces []struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	env.mustJSON(t, "GET", "/api/v1/admin/workspaces", nil, &workspaces)
	targetWS := ome.Workspace.ID
	found := false
	for _, w := range workspaces {
		if w.ID == targetWS {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("workspace %s not listed", targetWS)
	}
	env.mustJSON(t, "POST", "/api/v1/admin/workspaces/"+targetWS+"/enter", map[string]any{}, nil)
	var overrideMe struct {
		AdminOverride bool   `json:"admin_override"`
		Role          string `json:"role"`
		CSRF          string `json:"csrf_token"`
	}
	env.mustJSON(t, "GET", "/api/v1/auth/me", nil, &overrideMe)
	env.csrf = overrideMe.CSRF
	if !overrideMe.AdminOverride || overrideMe.Role != "owner" {
		t.Fatalf("override=%v role=%s", overrideMe.AdminOverride, overrideMe.Role)
	}
	// Owner-only action in foreign workspace should succeed under override.
	env.mustJSON(t, "POST", "/api/v1/workspaces/current/invites", map[string]any{"role": "editor", "max_uses": 1, "days": 1}, nil)
	env.mustJSON(t, "POST", "/api/v1/admin/workspaces/exit", map[string]any{}, nil)

	env.mustJSON(t, "PUT", "/api/v1/admin/system-settings", map[string]any{"registration_open": false}, nil)
	st, body = other.do("POST", "/api/v1/auth/register", map[string]string{"username": "blocked-" + t.Name(), "password": testPassword})
	if st == 200 {
		t.Fatalf("register should be closed: %s", body)
	}
	other.restore(env)
	env.mustJSON(t, "PUT", "/api/v1/admin/system-settings", map[string]any{"registration_open": true}, nil)

	env.mustJSON(t, "PUT", "/api/v1/admin/system-settings", map[string]any{"maintenance_mode": true}, nil)
	// Re-login other after enable
	st, body = other.do("POST", "/api/v1/auth/login", map[string]string{"username": tenantName, "password": testPassword})
	if st != 200 {
		t.Fatalf("login during maintenance: %d %s", st, body)
	}
	other.mustJSON(t, "GET", "/api/v1/auth/me", nil, &ome)
	other.csrf = ome.CSRF
	ae = other.expectErr(t, "GET", "/api/v1/accounts", nil, "maintenance")
	if ae.Error.Code != "maintenance" {
		t.Fatalf("code=%s", ae.Error.Code)
	}
	other.restore(env)
	env.mustJSON(t, "PUT", "/api/v1/admin/system-settings", map[string]any{"maintenance_mode": false}, nil)
}

func TestGenerateWorkImageWatermarked(t *testing.T) {
	f := env.accounts(t)
	var wk Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+f.wechat.ID.String()+"/works", map[string]string{"title": "出图"}, &wk)
	var a Asset
	env.mustJSON(t, "POST", "/api/v1/works/"+wk.ID.String()+"/generate-image", map[string]string{"prompt": "一只茶杯"}, &a)
	if !a.AIGenerated {
		t.Fatal("want ai_generated")
	}
	if a.URL == "" {
		t.Fatal("empty url")
	}
}

// FR-M1-10 / D-041：可再创建工作区并切换过去
func TestCreateWorkspaceAndSwitch(t *testing.T) {
	var before struct {
		Workspace struct {
			ID string `json:"id"`
		} `json:"workspace"`
		Workspaces []struct {
			ID string `json:"id"`
		} `json:"workspaces"`
	}
	env.mustJSON(t, "GET", "/api/v1/auth/me", nil, &before)
	n0 := len(before.Workspaces)
	var created struct {
		ID       string `json:"id"`
		Name     string `json:"name"`
		Role     string `json:"role"`
		Switched bool   `json:"switched"`
	}
	env.mustJSON(t, "POST", "/api/v1/workspaces", map[string]any{"name": "第二工作室", "switch": true}, &created)
	if created.Role != "owner" || !created.Switched || created.ID == before.Workspace.ID {
		t.Fatalf("create: %+v (was %s)", created, before.Workspace.ID)
	}
	var after struct {
		Workspace  struct{ ID, Name string } `json:"workspace"`
		Workspaces []struct {
			ID string `json:"id"`
		} `json:"workspaces"`
	}
	env.mustJSON(t, "GET", "/api/v1/auth/me", nil, &after)
	if after.Workspace.ID != created.ID || after.Workspace.Name != "第二工作室" {
		t.Fatalf("current=%+v want %s", after.Workspace, created.ID)
	}
	if len(after.Workspaces) != n0+1 {
		t.Fatalf("workspaces %d → %d", n0, len(after.Workspaces))
	}
	// 切回原工作区，避免污染后续测试
	env.mustJSON(t, "POST", "/api/v1/workspaces/"+before.Workspace.ID+"/switch", nil, nil)
}

// draftedWork builds a work up to drafted sections (outline confirmed, no checks yet).
func (e *testEnv) draftedWork(t *testing.T, a Account, viewpoint string) Work {
	t.Helper()
	var wk Work
	e.mustJSON(t, "POST", "/api/v1/accounts/"+a.ID.String()+"/works", map[string]string{"title": "测试作品"}, &wk)
	id := wk.ID.String()
	e.mustJSON(t, "PATCH", "/api/v1/works/"+id, map[string]string{"viewpoint": viewpoint}, nil)
	var outline struct {
		Items []OutlineItem `json:"items"`
	}
	e.mustJSON(t, "POST", "/api/v1/works/"+id+"/outline/generate", nil, &outline)
	e.mustJSON(t, "PUT", "/api/v1/works/"+id+"/outline", map[string]any{"items": outline.Items[:2], "confirm": true}, &wk)
	for _, sec := range wk.Sections {
		if ev := lastEvent(t, e.sse(t, "/api/v1/sections/"+sec.ID.String()+"/draft", nil)); ev.Name != "done" {
			t.Fatalf("draft: %s %s", ev.Name, ev.Data)
		}
	}
	e.mustJSON(t, "GET", "/api/v1/works/"+id, nil, &wk)
	return wk
}

// wechatWriteCalls keeps calls that create or change drafts / publish; the read-only draft-box sync (batchget) is allowed.
func wechatWriteCalls(calls []string) []string {
	var out []string
	for _, c := range calls {
		for _, w := range []string{"add", "update", "upload", "publish", "submit", "mass", "delete"} {
			if strings.Contains(c, w) {
				out = append(out, c)
				break
			}
		}
	}
	return out
}

// HC-16：内容日历只做计划。设置计划发布日并把时钟推进到当天，系统不调用任何微信草稿 / 发布接口，作品状态不变。
func TestHC16_PlannedDateNeverPublishes(t *testing.T) {
	f := env.accounts(t)
	wk := env.readyWork(t, f.wechat, "日历只是计划")
	day := time.Now().In(env.srv.loc).AddDate(0, 0, 3)
	env.mustJSON(t, "PATCH", "/api/v1/works/"+wk.ID.String(), map[string]any{"planned_date": day.Format("2006-01-02")}, nil)
	before := wechatWriteCalls(env.mockWX.Calls())
	orig := env.srv.now
	env.srv.now = func() time.Time {
		return time.Date(day.Year(), day.Month(), day.Day(), 10, 30, 0, 0, env.srv.loc)
	}
	env.srv.runJobsOnce(context.Background())
	env.srv.now = func() time.Time {
		return time.Date(day.Year(), day.Month(), day.Day(), 12, 5, 0, 0, env.srv.loc)
	}
	env.srv.runJobsOnce(context.Background())
	env.srv.now = orig
	after := wechatWriteCalls(env.mockWX.Calls())
	if len(after) != len(before) {
		t.Fatalf("jobs called WeChat on the planned day: %v", after[len(before):])
	}
	var got Work
	env.mustJSON(t, "GET", "/api/v1/works/"+wk.ID.String(), nil, &got)
	if got.Status != "ready" {
		t.Fatalf("planned day changed status: %s", got.Status)
	}
	for _, r := range routes(t) {
		low := strings.ToLower(r)
		if strings.Contains(low, "calendar") && !strings.HasPrefix(r, "GET") {
			t.Fatalf("calendar must be read-only: %s", r)
		}
	}
	planned := regexp.MustCompile(`planned_date[^\n]*(draft/add|draft/update|freepublish|wechatPush|pushWork)`)
	for p, src := range goSources(t) {
		if loc := planned.FindStringIndex(src); loc != nil {
			t.Fatalf("%s links planned_date to publishing: %q", p, src[loc[0]:loc[1]])
		}
	}
}

// HC-17：写作副驾驶不输出整篇正文，也不能写入段落。
func TestHC17_CopilotNeverWritesBody(t *testing.T) {
	f := env.accounts(t)
	wk := env.draftedWork(t, f.wechat, "副驾驶只出主意")
	ev := lastEvent(t, env.sse(t, "/api/v1/works/"+wk.ID.String()+"/copilot", map[string]any{"message": "帮我写完整篇文章", "scope": "work"}))
	if ev.Name != "done" {
		t.Fatalf("copilot: %s %s", ev.Name, ev.Data)
	}
	if !strings.Contains(string(ev.Data), "请逐段起草") {
		t.Fatalf("whole-work request must be declined: %s", ev.Data)
	}
	var got Work
	env.mustJSON(t, "GET", "/api/v1/works/"+wk.ID.String(), nil, &got)
	if len(got.Sections) != len(wk.Sections) || got.Revision != wk.Revision {
		t.Fatalf("copilot changed the work: rev %d -> %d, sections %d -> %d", wk.Revision, got.Revision, len(wk.Sections), len(got.Sections))
	}
	for i, s := range got.Sections {
		if s.ContentMD != wk.Sections[i].ContentMD || s.Revision != wk.Sections[i].Revision {
			t.Fatalf("copilot wrote section %s", s.ID)
		}
	}
	for _, r := range routes(t) {
		if strings.Contains(r, "copilot") && !strings.HasSuffix(r, "/works/{id}/copilot") {
			t.Fatalf("unexpected copilot route: %s", r)
		}
	}
}

// HC-18：AI 修复建议只能逐条生成，采纳后该检查项仍要人工确认，没有批量修复入口。
func TestHC18_FixSuggestIsPerItem(t *testing.T) {
	f := env.accounts(t)
	wk := env.draftedWork(t, f.wechat, "修复要逐条确认")
	sec := wk.Sections[0]
	content := sec.ContentMD + "\n这是全网最好的方法。"
	env.mustJSON(t, "PATCH", "/api/v1/sections/"+sec.ID.String(), map[string]any{"content_md": content, "base_revision": sec.Revision}, nil)
	id := wk.ID.String()
	env.mustJSON(t, "POST", "/api/v1/works/"+id+"/checks", map[string]int{"html_chars": 3000, "html_bytes": 9000}, nil)
	run := env.latestCheck(t, id)
	var item *CheckItem
	for i := range run.Items {
		if run.Items[i].Category == "ad_law" {
			item = &run.Items[i]
			break
		}
	}
	if item == nil {
		t.Fatal("want an ad_law item")
	}
	var fix struct {
		Variants []variant `json:"variants"`
		Sentence string    `json:"sentence"`
	}
	env.mustJSON(t, "POST", "/api/v1/check-items/"+item.ID.String()+"/fix-suggest", nil, &fix)
	if len(fix.Variants) == 0 || len(fix.Variants) > 3 {
		t.Fatalf("want 1-3 variants, got %d", len(fix.Variants))
	}
	run = env.latestCheck(t, id)
	for _, it := range run.Items {
		if it.ID == item.ID && it.Resolution != nil {
			t.Fatalf("fix-suggest resolved the item by itself: %s", *it.Resolution)
		}
	}
	env.expectErr(t, "POST", "/api/v1/works/"+id+"/checks/complete", nil, "human_step_required")
	// 作者采纳候选（改写正文）后，旧检查失效，必须重新检查、逐项确认。
	var cur Work
	env.mustJSON(t, "GET", "/api/v1/works/"+id, nil, &cur)
	fixed := strings.Replace(cur.Sections[0].ContentMD, "这是全网最好的方法。", fix.Variants[0].Text, 1)
	env.mustJSON(t, "PATCH", "/api/v1/sections/"+sec.ID.String(), map[string]any{"content_md": fixed, "base_revision": cur.Sections[0].Revision}, nil)
	env.expectErr(t, "POST", "/api/v1/works/"+id+"/checks/complete", nil, "state_invalid")
	for _, r := range routes(t) {
		low := strings.ToLower(r)
		if strings.Contains(low, "fix") && r != "POST /api/v1/check-items/{id}/fix-suggest" {
			t.Fatalf("unexpected fix route: %s", r)
		}
		if strings.Contains(low, "adopt-all") || strings.Contains(low, "fix-all") || strings.Contains(low, "apply-all") {
			t.Fatalf("batch route exists: %s", r)
		}
	}
}

// HC-19：开启审阅后，未经 H-09 审阅通过不能推送或生成发布包。
func TestHC19_ReviewGateBeforePushAndPack(t *testing.T) {
	f := env.accounts(t)
	for _, a := range []Account{f.wechat, f.xhs} {
		wk := env.readyWork(t, a, "审阅通过才能发出")
		id := wk.ID.String()
		var got Work
		env.mustJSON(t, "PATCH", "/api/v1/works/"+id, map[string]any{"review_required": true}, &got)
		env.mustJSON(t, "GET", "/api/v1/works/"+id, nil, &got)
		if got.Status != "reviewing" {
			t.Fatalf("want reviewing, got %s", got.Status)
		}
		var ae apiError
		if a.Platform == "wechat_mp" {
			ae = env.expectErr(t, "POST", "/api/v1/works/"+id+"/wechat/push", map[string]any{"html": testHTML(got), "revision": got.Revision, "fields": got.WechatFields, "confirm_over_limit": true}, "human_step_required")
		} else {
			ae = env.expectErr(t, "POST", "/api/v1/works/"+id+"/xhs/pack", nil, "human_step_required")
		}
		if !strings.Contains(string(ae.Error.Detail), "H-09") {
			t.Fatalf("want H-09, got %s", ae.Error.Detail)
		}
		env.mustJSON(t, "POST", "/api/v1/works/"+id+"/review/approve", nil, &got)
		if got.Status != "ready" || got.ReviewedAt == nil {
			t.Fatalf("approve: status %s reviewed_at %v", got.Status, got.ReviewedAt)
		}
		if a.Platform == "xhs" {
			env.mustJSON(t, "POST", "/api/v1/works/"+id+"/xhs/pack", nil, nil)
		}
	}
}

// HC-20：待确认的记忆不进入上下文，确认只能逐条，没有一键全部确认。
func TestHC20_SuggestedMemoryNotInContext(t *testing.T) {
	f := env.accounts(t)
	ctx := context.Background()
	var ws uuid.UUID
	if err := env.srv.db.QueryRow(ctx, `SELECT workspace_id FROM platform_account WHERE id=$1`, f.wechat.ID).Scan(&ws); err != nil {
		t.Fatal(err)
	}
	jctx := context.WithValue(ctx, ctxMember, &identity{WorkspaceID: ws})
	const text = "HC20 待确认偏好：段落开头不要用设问句"
	if _, err := env.srv.suggestMemory(jctx, f.wechat.ID, "avoid", "all", text, "instruction", nil); err != nil {
		t.Fatal(err)
	}
	a, err := env.srv.account(jctx, f.wechat.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, typ := range []string{"section_draft", "title", "topic_suggest", "copilot_chat"} {
		pack, err := env.srv.buildContext(jctx, aiTask{Type: typ, Account: a, User: "x"})
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(pack.System, text) || strings.Contains(pack.User, text) {
			t.Fatalf("%s: suggested memory leaked into context", typ)
		}
	}
	var list []Memory
	env.mustJSON(t, "GET", "/api/v1/accounts/"+f.wechat.ID.String()+"/memories", nil, &list)
	var mem *Memory
	for i := range list {
		if list[i].Text == text {
			mem = &list[i]
		}
	}
	if mem == nil || mem.Status != "suggested" {
		t.Fatalf("suggested memory not listed: %+v", mem)
	}
	env.mustJSON(t, "PATCH", "/api/v1/memories/"+mem.ID.String(), map[string]string{"status": "active"}, nil)
	pack, err := env.srv.buildContext(jctx, aiTask{Type: "section_draft", Account: a, User: "x"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(pack.System, text) {
		t.Fatal("confirmed memory should be in context")
	}
	env.mustJSON(t, "PATCH", "/api/v1/memories/"+mem.ID.String(), map[string]string{"status": "disabled"}, nil)
	for _, r := range routes(t) {
		low := strings.ToLower(r)
		if strings.Contains(low, "memor") && (strings.Contains(low, "all") || strings.Contains(low, "batch") || strings.Contains(low, "bulk") || strings.Contains(low, "confirm")) {
			t.Fatalf("batch memory route exists: %s", r)
		}
	}
}

func TestHC22V4SingleObjectActions(t *testing.T) {
	id := "00000000-0000-0000-0000-000000000001"
	for _, path := range []string{"/api/v1/daily/" + id + "/items/0/adopt", "/api/v1/daily/" + id + "/items/0/start", "/api/v1/hot-matches/" + id + "/convert", "/api/v1/plan-slots/" + id + "/adopt"} {
		status, b := env.do("POST", path, []map[string]string{{"title": "不能批量"}})
		if status != 400 {
			t.Fatalf("array body accepted %s: %d %s", path, status, b)
		}
	}
}
func TestHC25V4NoWechatWrites(t *testing.T) {
	before := len(env.mockWX.Calls())
	TestE2E19DailyRecommend(t)
	if len(env.mockWX.Calls()) != before {
		t.Fatal("daily generation/adoption called WeChat")
	}
	enableTestCrawl(t)
	loginCrawlAdmin(t)

	for _, limits := range []map[string]int{{"interval_min": 5, "max_items": 50, "daily_requests": 300, "fail_limit": 3, "pause_hours": 6}, {"interval_min": 10, "max_items": 101, "daily_requests": 300, "fail_limit": 3, "pause_hours": 6}, {"interval_min": 10, "max_items": 50, "daily_requests": 2001, "fail_limit": 3, "pause_hours": 6}} {
		env.expectErr(t, "PUT", "/api/v1/admin/crawl", map[string]any{"level": "conservative", "limits": limits, "retention_days": 14}, "validation_failed")
	}
}

func TestHC24SensitiveAndReferenceIsolation(t *testing.T) {
	paths, err := filepath.Glob("../crawl/*.go")
	if err != nil {
		t.Fatal(err)
	}
	paths = append(paths, "../../go.mod")
	for _, path := range paths {
		if strings.HasSuffix(path, "_test.go") {
			continue
		}
		b, e := os.ReadFile(path)
		if e != nil {
			t.Fatal(e)
		}
		for _, bad := range []string{`"x-s"`, `"x-t"`, "x-s-common", "playwright", "chromedp", "proxy_pool"} {
			if strings.Contains(strings.ToLower(string(b)), bad) {
				t.Fatalf("forbidden dependency %s", bad)
			}
		}
	}
	b, e := os.ReadFile("contextpack.go")
	if e != nil {
		t.Fatal(e)
	}
	if strings.Contains(string(b), "body_text") {
		t.Fatal("reference body in context assembler")
	}
	if !overlapLong("连续十六个汉字会被识别并拒绝输出原文复述", "连续十六个汉字会被识别并拒绝输出原文复述") || overlapLong("原文", "原文") {
		t.Fatal("overlap boundary")
	}
	enableTestCrawl(t)
	loginCrawlAdmin(t)
	for _, domain := range []string{"xiaohongshu.com", "xhslink.com", "xhscdn.com", "mp.weixin.qq.com"} {
		for _, kind := range []string{"rss", "hotlist", "aggregator", "summary"} {
			_, out, err := env.srv.crawlClient().Read(context.Background(), crawl.Source{Key: "blocked-adapter", Kind: kind, URL: "https://" + domain + "/single"}, env.srv.loadCrawl(context.Background()).Limits)
			if err == nil || out.Requests != 0 || !strings.Contains(err.Error(), "独立读取队列") {
				t.Fatalf("sensitive domain bypassed platform queue: %s/%s %+v %v", domain, kind, out, err)
			}
		}
	}
	for _, limits := range []CrawlPlatform{
		{Level: "conservative", IntervalMin: 2, DailyMax: 30, RepeatHours: 72},
		{Level: "standard", IntervalMin: 3, DailyMax: 101, RepeatHours: 24},
		{Level: "standard", IntervalMin: 3, DailyMax: 80, RepeatHours: 11},
	} {
		for _, platform := range []string{"xhs_page", "wechat_page"} {
			env.expectErr(t, "PUT", "/api/v1/admin/crawl/platforms/"+platform, limits, "validation_failed")
		}
	}
}
