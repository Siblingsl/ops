package app

import (
	"strings"
	"testing"
)

// 回归：查询串里的 NUL（%00）与请求体里的 \u0000 都可能被原样送进 PostgreSQL，
// 而 text 类型不接受 NUL。查询串按“未提供该值”处理；请求体属于输入问题，
// 必须回 422 而不是 500。
func TestNulInputNeverFiveHundred(t *testing.T) {
	f := env.accounts(t)
	var wk Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+f.wechat.ID.String()+"/works", map[string]string{"title": "NUL 测试作品"}, &wk)
	workID := wk.ID.String()

	for _, p := range []string{
		"/api/v1/search?q=%00&types=works",
		"/api/v1/search?q=a%00b&types=works",
		"/api/v1/accounts/" + f.wechat.ID.String() + "/works?q=a%00b",
		"/api/v1/accounts/" + f.wechat.ID.String() + "/works?status=a%00b",
		"/api/v1/hot-items?q=a%00b",
		"/api/v1/agent/conversations?q=a%00b",
		"/api/v1/agent/conversations?q=%00",
	} {
		code, body := env.do("GET", p, nil)
		if code != 200 {
			t.Errorf("GET %s => %d %s", p, code, strings.TrimSpace(string(body)))
		}
	}

	code, body := env.do("PATCH", "/api/v1/works/"+workID, map[string]string{"title": "标题\u0000残留"})
	if code != 422 {
		t.Fatalf("PATCH 作品标题含 NUL 应回 422，实际 %d %s", code, strings.TrimSpace(string(body)))
	}
	if !strings.Contains(string(body), "validation_failed") {
		t.Fatalf("PATCH 作品标题含 NUL 的错误码不对: %s", strings.TrimSpace(string(body)))
	}
	// 被拒绝后作品标题不应被写坏。
	var got Work
	env.mustJSON(t, "GET", "/api/v1/works/"+workID, nil, &got)
	if strings.ContainsRune(got.Title, 0) || got.Title == "" {
		t.Fatalf("作品标题异常: %q", got.Title)
	}
}
