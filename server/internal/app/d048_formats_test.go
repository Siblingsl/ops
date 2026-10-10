package app

import (
	"context"
	"strings"
	"testing"
)

// D-048 第 9 节：文字类新类型必须有真实工作流。每个类型走完 大纲→起草→检查→就绪 闭环，
// 且大纲/起草提示词注入了类型专属的结构约定。
func TestD048TextTypeWorkflows(t *testing.T) {
	cases := []struct{ platform, format string }{
		{"wechat_mp", "qa_article"},
		{"wechat_mp", "briefing"},
		{"wechat_mp", "script"},
		{"xhs", "list_note"},
		{"xhs", "script"},
	}
	for _, c := range cases {
		var a Account
		env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{"platform": c.platform, "name": "文字类型-" + c.format, "content_format": c.format}, &a)
		wk := env.readyWork(t, a, "把复杂的事情讲清楚")
		if wk.ContentFormat != c.format || wk.Status != "ready" {
			t.Fatalf("%s/%s: format=%s status=%s", c.platform, c.format, wk.ContentFormat, wk.Status)
		}
	}

	// 最后一个案例是 xhs/script：验证大纲与起草提示词确实带上了脚本类型的结构要求。
	var ws string
	if e := env.srv.db.QueryRow(context.Background(), `SELECT workspace_id FROM platform_account WHERE content_format='script' AND platform='xhs' LIMIT 1`).Scan(&ws); e != nil {
		t.Fatal(e)
	}
	v, ok := env.srv.lastPacks.Load(ws + "/outline")
	if !ok {
		t.Fatal("no outline pack snapshot")
	}
	snap := v.(evalSnapshot)
	if !strings.Contains(snap.System+snap.UserRest, "镜1：场景") {
		t.Fatal("script outline prompt missing type brief")
	}
	v, ok = env.srv.lastPacks.Load(ws + "/section_draft")
	if !ok {
		t.Fatal("no section_draft pack snapshot")
	}
	snap = v.(evalSnapshot)
	if !strings.Contains(snap.System+snap.UserRest, "【画面】") {
		t.Fatal("script draft prompt missing type brief")
	}
}
