package app

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"ops/internal/ai"
)

func v4Context(t *testing.T, a Account) context.Context {
	t.Helper()
	var ws uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(), `SELECT workspace_id FROM platform_account WHERE id=$1`, a.ID).Scan(&ws); err != nil {
		t.Fatal(err)
	}
	return context.WithValue(context.Background(), ctxMember, &identity{WorkspaceID: ws, Role: "owner"})
}

func TestV419ReferenceIngressAndAccountDeletion(t *testing.T) {
	a, path := v4Account(t, "参考入口与删除")
	b, other := v4Account(t, "共用参考账号")
	options, _ := positioningOptions(t, path)
	f := options[0].StrategyFields
	f.DailySettings = map[string]any{"generate": "off"}
	shared := "https://xiaohongshu.com/completion-shared"
	f.Benchmarks = []Benchmark{{Name: "对标", Links: []string{shared}}}
	env.mustJSON(t, "POST", path+"/strategy", f, nil)
	var first []Reference
	env.mustJSON(t, "GET", path+"/references", nil, &first)
	if len(first) != 1 {
		t.Fatalf("benchmark was not queued: %+v", first)
	}
	env.mustJSON(t, "POST", other+"/references", map[string]any{"links": []string{shared}}, nil)
	var linked []Reference
	env.mustJSON(t, "GET", other+"/references", nil, &linked)
	if len(linked) != 1 || linked[0].ID != first[0].ID {
		t.Fatalf("canonical reference missing for second account: %+v", linked)
	}
	content := "灵感 https://mp.weixin.qq.com/s/completion-inbox"
	env.mustJSON(t, "POST", "/api/v1/inbox", map[string]any{"account_id": a.ID, "content": content}, nil)
	env.mustJSON(t, "GET", path+"/references", nil, &first)
	if len(first) != 1 {
		t.Fatal("unselected read_page queued reference")
	}
	env.mustJSON(t, "POST", "/api/v1/inbox", map[string]any{"account_id": a.ID, "content": content, "read_page": true}, nil)
	env.mustJSON(t, "POST", "/api/v1/materials", map[string]any{"account_id": a.ID, "kind": "opinion", "content": "素材 https://xiaohongshu.com/completion-material", "read_page": true}, nil)
	env.mustJSON(t, "GET", path+"/references", nil, &first)
	if len(first) != 3 {
		t.Fatalf("ingress links missing: %+v", first)
	}
	ctx := v4Context(t, a)
	var before, after int
	_ = env.srv.db.QueryRow(ctx, `SELECT count(*) FROM inbox_item WHERE account_id=$1`, a.ID).Scan(&before)
	env.expectErr(t, "POST", "/api/v1/inbox", map[string]any{"account_id": a.ID, "content": "https://xiaohongshu.com/user/profile/demo", "read_page": true}, "validation_failed")
	_ = env.srv.db.QueryRow(ctx, `SELECT count(*) FROM inbox_item WHERE account_id=$1`, a.ID).Scan(&after)
	if before != after {
		t.Fatal("invalid reference left an inbox side effect")
	}
	for _, sql := range []string{
		`INSERT INTO daily_recommendation(account_id,date,items,trigger) VALUES($1,current_date,'[{}]','manual')`,
		`INSERT INTO account_ops_activity(account_id,last_opened_at) VALUES($1,now())`,
		`INSERT INTO account_daily_claim(account_id,date) VALUES($1,current_date)`,
	} {
		if _, err := env.srv.db.Exec(ctx, sql, a.ID); err != nil {
			t.Fatal(err)
		}
	}
	if err := env.srv.hardDeleteAccount(ctx, a.ID); err != nil {
		t.Fatal(err)
	}
	env.mustJSON(t, "GET", other+"/references", nil, &linked)
	if len(linked) != 1 || linked[0].URL != shared {
		t.Fatal("shared reference deleted with original account")
	}
	if err := env.srv.hardDeleteAccount(v4Context(t, b), b.ID); err != nil {
		t.Fatal(err)
	}
	var remaining int
	if err := env.srv.db.QueryRow(ctx, `SELECT count(*) FROM reference_item WHERE url=$1`, shared).Scan(&remaining); err != nil || remaining != 0 {
		t.Fatalf("orphan reference: %d %v", remaining, err)
	}
}

func TestV416StaleHotActions(t *testing.T) {
	enableTestCrawl(t)
	a, path := v4Account(t, "热点失效校验")
	ctx := v4Context(t, a)
	if _, err := env.srv.db.Exec(ctx, `UPDATE crawl_source SET enabled=true,last_attempt_at=NULL,paused_until=NULL WHERE key='baidu'`); err != nil {
		t.Fatal(err)
	}
	env.mustJSON(t, "PUT", "/api/v1/hot-sources", map[string]any{"sources": []string{"baidu"}}, nil)
	src, err := scanCrawlSource(env.srv.db.QueryRow(ctx, `SELECT `+crawlSourceCols+` FROM crawl_source WHERE key='baidu'`))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = env.srv.collectSource(ctx, src); err != nil {
		t.Fatal(err)
	}
	options, _ := positioningOptions(t, path)
	f := options[0].StrategyFields
	f.DailySettings = map[string]any{"generate": "off"}
	env.mustJSON(t, "POST", path+"/strategy", f, nil)
	var out struct {
		Items []HotMatch `json:"items"`
	}
	env.mustJSON(t, "POST", path+"/hot/refresh", nil, &out)
	var hot HotMatch
	for _, m := range out.Items {
		if !highRisk(m.Risk) {
			hot = m
			break
		}
	}
	if hot.ID == uuid.Nil {
		t.Fatal("no test hotspot")
	}
	before := topicCount(t, a.ID.String())
	if _, err = env.srv.db.Exec(ctx, `UPDATE crawl_source SET enabled=false WHERE key='baidu'`); err != nil {
		t.Fatal(err)
	}
	env.expectErr(t, "POST", "/api/v1/hot-matches/"+hot.ID.String()+"/convert", map[string]any{}, "state_invalid")
	env.expectErr(t, "POST", path+"/topics", map[string]any{"title": "失效热点", "source": "hot", "hot_item_id": hot.HotItem.ID}, "state_invalid")
	if topicCount(t, a.ID.String()) != before {
		t.Fatal("disabled hotspot adopted")
	}
	if _, err = env.srv.db.Exec(ctx, `UPDATE crawl_source SET enabled=true WHERE key='baidu'`); err != nil {
		t.Fatal(err)
	}
	f.BlockedWords = []string{hot.HotItem.Title}
	env.mustJSON(t, "POST", path+"/strategy", f, nil)
	env.expectErr(t, "POST", "/api/v1/hot-matches/"+hot.ID.String()+"/convert", map[string]any{}, "state_invalid")
	env.mustJSON(t, "GET", path+"/hot", nil, &out)
	for _, m := range out.Items {
		if m.HotItem.ID == hot.HotItem.ID {
			t.Fatal("blocked cached hotspot visible")
		}
	}
}

func TestV422ConfirmedCandidatesAndDefaults(t *testing.T) {
	a, path := v4Account(t, "候选与默认数量")
	options, _ := positioningOptions(t, path)
	f := options[0].StrategyFields
	f.DailySettings = map[string]any{"generate": "off", "primary_count": 0, "alternate_count": 0}
	env.mustJSON(t, "POST", path+"/strategy", f, nil)
	ctx := v4Context(t, a)
	s := env.srv
	st, err := s.activeStrategy(ctx, a.ID)
	if err != nil {
		t.Fatal(err)
	}
	p, n := dailyCounts(st, time.Date(2026, 10, 12, 0, 0, 0, 0, s.loc))
	if p != 2 || n != 2 {
		t.Fatalf("zero changed defaults: %d/%d", p, n)
	}
	var old []byte
	oldErr := s.db.QueryRow(ctx, `SELECT value FROM app_setting WHERE workspace_id=$1 AND key='daily.settings'`, ident(ctx).WorkspaceID).Scan(&old)
	t.Cleanup(func() {
		if oldErr == nil {
			_, _ = s.db.Exec(ctx, `UPDATE app_setting SET value=$2 WHERE workspace_id=$1 AND key='daily.settings'`, ident(ctx).WorkspaceID, old)
		} else {
			_, _ = s.db.Exec(ctx, `DELETE FROM app_setting WHERE workspace_id=$1 AND key='daily.settings'`, ident(ctx).WorkspaceID)
		}
	})
	env.mustJSON(t, "PUT", "/api/v1/daily-settings", DailySettings{Generate: "off", Hour: 7, PrimaryCount: 4, AlternateCount: 3}, nil)
	d := s.effectiveDaily(ctx, st)
	if d.PrimaryCount != 4 || d.AlternateCount != 3 {
		t.Fatalf("account zero did not inherit: %+v", d)
	}
	env.mustJSON(t, "POST", "/api/v1/materials", map[string]any{"account_id": a.ID, "kind": "opinion", "content": st.Pillars[0].Name + "过期资料", "valid_until": s.today().AddDate(0, 0, -1).Format("2006-01-02")}, nil)
	if _, err = s.db.Exec(ctx, `INSERT INTO review_report(account_id,content,adopted) VALUES($1,'{"conclusions":["未确认结论"],"topic_suggestions":[{"title":"已确认建议"},{"title":"未确认建议"}]}',ARRAY[0])`, a.ID); err != nil {
		t.Fatal(err)
	}
	candidates, err := s.dailyCandidates(ctx, &a, st)
	if err != nil {
		t.Fatal(err)
	}
	confirmed := false
	for _, c := range candidates {
		if c.Type == "material" {
			t.Fatal("expired material recommended")
		}
		if c.Type == "review" {
			confirmed = true
			if !strings.Contains(c.Detail, "已确认建议") || strings.Contains(c.Detail, "未确认") {
				t.Fatalf("unconfirmed review leaked: %s", c.Detail)
			}
		}
	}
	if !confirmed {
		t.Fatal("adopted review missing")
	}
}

func TestV4TaskSettingsAndPromptRegression(t *testing.T) {
	a, path := v4Account(t, "V4任务设置")
	options, _ := positioningOptions(t, path)
	f := options[0].StrategyFields
	f.DailySettings = map[string]any{"generate": "off"}
	env.mustJSON(t, "POST", path+"/strategy", f, nil)
	ctx := v4Context(t, a)
	pack, err := env.srv.buildContext(ctx, aiTask{Type: "section_draft", Account: &a, User: "本地测试"})
	if err != nil || !strings.Contains(pack.System, "当前运营方案") || !strings.Contains(pack.System, f.Niche) {
		t.Fatalf("strategy omitted from creation context: %v", err)
	}
	var templates []PromptTemplate
	env.mustJSON(t, "GET", "/api/v1/prompt-templates", nil, &templates)
	for _, typ := range []string{"account_positioning", "strategy_revise", "strategy_outline", "hot_relevance", "daily_recommend", "reference_analyze"} {
		if taskLabel(typ) == typ {
			t.Fatalf("task label missing %s", typ)
		}
		found := false
		for _, p := range templates {
			if p.TaskType == typ {
				found = true
			}
		}
		if !found {
			t.Fatalf("editable template missing %s", typ)
		}
		var output map[string]any
		if _, err := env.srv.runAIJSON(ctx, aiTask{Type: typ, Account: &a, SkipStyle: true, User: "本地任务配置回归，只用模拟数据"}, &output, nil); err != nil {
			t.Fatal(err)
		}
		var c EvalCase
		env.mustJSON(t, "POST", "/api/v1/prompt-eval/cases", map[string]string{"task_type": typ, "name": fmt.Sprintf("V4 %s 回归", typ)}, &c)
		if c.TaskType != typ || c.Chars == 0 {
			t.Fatalf("V4 regression case missing %+v", c)
		}
	}
}

type v4SearchTransport func(*http.Request) (*http.Response, error)

func (f v4SearchTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestV434Search429CircuitBreaker(t *testing.T) {
	enableTestCrawl(t)
	other := env.registerClient(t, "v434-search-429", testPassword)
	defer other.restore(env)
	a, _ := v4Account(t, "联网搜索熔断")
	ctx := v4Context(t, a)
	s := env.srv
	var pid uuid.UUID
	if err := s.db.QueryRow(ctx, `SELECT id FROM model_provider WHERE workspace_id=$1 AND status='active' LIMIT 1`, ident(ctx).WorkspaceID).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	config, _ := json.Marshal(map[string]string{"provider_id": pid.String(), "model": "mock-fast", "query": "本地熔断测试"})
	key := "search:429:" + a.ID.String()
	if _, err := s.db.Exec(ctx, `INSERT INTO crawl_source(key,kind,name,enabled,workspace_id,config) VALUES($1,'search','本地熔断测试',true,$2,$3)`, key, ident(ctx).WorkspaceID, config); err != nil {
		t.Fatal(err)
	}
	src, err := scanCrawlSource(s.db.QueryRow(ctx, `SELECT `+crawlSourceCols+` FROM crawl_source WHERE key=$1`, key))
	if err != nil {
		t.Fatal(err)
	}
	old := s.aiHTTP
	t.Cleanup(func() { s.aiHTTP = old })
	calls := 0
	s.aiHTTP = &http.Client{Transport: v4SearchTransport(func(r *http.Request) (*http.Response, error) {
		calls++
		return &http.Response{StatusCode: 429, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("response-body-must-not-be-logged")), Request: r}, nil
	})}
	_, err = s.collectSource(ctx, src)
	upstream, ok := err.(*ai.SearchHTTPError)
	if !ok || upstream.Status != 429 {
		t.Fatalf("native upstream status: %v", err)
	}
	var status int
	var pause time.Time
	var msg string
	if err = s.db.QueryRow(ctx, `SELECT r.http_status,src.paused_until,r.error FROM crawl_run r JOIN crawl_source src ON src.key=r.source_key WHERE src.key=$1`, key).Scan(&status, &pause, &msg); err != nil {
		t.Fatal(err)
	}
	if status != 429 || pause.Before(s.now().Add(23*time.Hour)) || strings.Contains(msg, "response-body") {
		t.Fatalf("native pause/log: %d %s %q", status, pause, msg)
	}
	if _, err = s.collectSource(ctx, src); err == nil || calls != 1 {
		t.Fatal("paused search still requested")
	}
}

func TestV4MalformedObjectHasNoSideEffects(t *testing.T) {
	for _, body := range []string{"{", `{"x":1}{"x":2}`, "null", "[]"} {
		called := false
		fn := env.srv.v4Object(func(http.ResponseWriter, *http.Request) error { called = true; return nil })
		err := fn(httptest.NewRecorder(), httptest.NewRequest("POST", "/", strings.NewReader(body)))
		if err == nil || called {
			t.Fatalf("malformed object accepted %q", body)
		}
	}
}

func TestAssignPillarsExtremeRatioKeepsRunLimit(t *testing.T) {
	ps := []Pillar{{Name: "主要支柱", Ratio: 80}, {Name: "第二支柱", Ratio: 10}, {Name: "第三支柱", Ratio: 10}}
	assigned := assignPillars(ps, 12)
	for i := 2; i < len(assigned); i++ {
		if assigned[i] == assigned[i-1] && assigned[i] == assigned[i-2] {
			t.Fatal("extreme ratio bypassed consecutive limit")
		}
	}
	if ps[0].Ratio != 80 {
		t.Fatal("human ratio changed automatically")
	}
}
