package app

import (
	"context"
	"encoding/json"
	"github.com/google/uuid"
	"os"
	"strings"
	"testing"
	"time"
)

func TestE2E21References(t *testing.T) {
	enableTestCrawl(t)
	s := env.srv
	ctx := context.Background()
	now := time.Date(2026, 10, 10, 9, 0, 0, 0, s.loc)
	s.now = func() time.Time { return now }
	_, e := s.db.Exec(ctx, `UPDATE crawl_platform_state SET enabled=true,next_request_at=NULL,paused_until=NULL,request_date=NULL,strikes_7d=0,last_strike_at=NULL,jitter_min=0 WHERE platform='xhs_page'`)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() {
		_, _ = s.db.Exec(ctx, `UPDATE crawl_platform_state SET enabled=false,next_request_at=NULL,paused_until=NULL,request_date=NULL,strikes_7d=0,last_strike_at=NULL`)
		_, _ = s.db.Exec(ctx, `DELETE FROM crawl_platform_read`)
	})
	account, _ := v4Account(t, "参考队列")
	env.mustJSON(t, "POST", "/api/v1/accounts/"+account.ID.String()+"/references", map[string]any{"links": []string{"https://xiaohongshu.com/one", "https://xiaohongshu.com/two", "https://xiaohongshu.com/login", "https://xiaohongshu.com/four", "https://xiaohongshu.com/five"}}, nil)
	for i := 0; i < 5; i++ {
		s.collectReferences(ctx)
		now = now.Add(15 * time.Minute)
	}
	var refs []Reference
	env.mustJSON(t, "GET", "/api/v1/accounts/"+account.ID.String()+"/references", nil, &refs)
	done, blocked, queued := 0, 0, 0
	var target Reference
	for _, x := range refs {
		switch x.Status {
		case "done":
			done++
		case "blocked":
			blocked++
			target = x
		case "queued":
			queued++
		}
	}
	if done != 2 || blocked != 1 || queued != 2 {
		t.Fatalf("queue %d %d %d: %+v", done, blocked, queued, refs)
	}
	body := "这里是一个仅用于保留期与上下文隔离检验的独特原文片段，作者讲述自己的成长过程并列出实践细节。"
	env.mustJSON(t, "POST", "/api/v1/references/"+target.ID.String()+"/paste", map[string]any{"body": body, "title": "手动参考"}, nil)
	var ws uuid.UUID
	_ = s.db.QueryRow(ctx, `SELECT workspace_id FROM platform_account WHERE id=$1`, account.ID).Scan(&ws)
	jctx := context.WithValue(ctx, ctxMember, &identity{WorkspaceID: ws, Role: "owner"})
	pack, e := s.buildContext(jctx, aiTask{Type: "section_draft", Account: &account, User: "写一段"})
	if e != nil {
		t.Fatal(e)
	}
	b, _ := json.Marshal(pack.refs())
	if strings.Contains(pack.User, body) || strings.Contains(string(b), body) || !strings.Contains(pack.User, "参考结构") {
		t.Fatalf("reference context isolation: %+v", pack)
	}
	now = now.AddDate(0, 0, 8)
	s.collectReferences(ctx)
	var stored string
	var analysis []byte
	e = s.db.QueryRow(ctx, `SELECT body_text,analysis FROM reference_item WHERE id=$1`, target.ID).Scan(&stored, &analysis)
	if e != nil || stored != "" || len(analysis) == 0 {
		t.Fatalf("retention %q %s %v", stored, analysis, e)
	}
}

func TestHC24SensitiveAndReferenceIsolation(t *testing.T) {
	for _, path := range []string{"../crawl/client.go", "../crawl/sources.go", "../crawl/page.go"} {
		b, e := os.ReadFile(path)
		if e != nil {
			t.Fatal(e)
		}
		for _, bad := range []string{"x-s-common", "playwright", "chromedp", "proxy_pool"} {
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
}
