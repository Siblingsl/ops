package app

import (
	"encoding/json"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"context"
)

// TP-04：桌面端搜索过去只过滤已加载的一页；服务端支持 q 之后应能搜到分页之外的选题。
func TestTP04ListTopicsQuerySearchesBeyondCurrentPage(t *testing.T) {
	f := env.accounts(t)
	acc := "/api/v1/accounts/" + f.xhs.ID.String()
	var want struct {
		Topic Topic `json:"topic"`
	}
	env.mustJSON(t, "POST", acc+"/topics", map[string]any{
		"title": "候补选题：远方来客", "angle": "角度写给刚入职的运营", "hook": "一个真实的增长故事", "audience": "运营新手",
	}, &want)
	// 灌满 50 条以上无关选题，让目标选题落在第一页之外。
	if _, err := env.srv.db.Exec(context.Background(), `INSERT INTO topic(account_id,title,angle,audience,hook,status)
		SELECT $1,'无关选题 '||n,'切入点 '||n,'谁在读','一句话钩子','pending' FROM generate_series(1,60) n`, f.xhs.ID); err != nil {
		t.Fatal(err)
	}
	var workspaceID uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(), `SELECT workspace_id FROM platform_account WHERE id=$1`, f.xhs.ID).Scan(&workspaceID); err != nil {
		t.Fatal(err)
	}
	request := func(query string) []Topic {
		route := chi.NewRouteContext()
		route.URLParams.Add("accountId", f.xhs.ID.String())
		ctx := context.WithValue(context.Background(), chi.RouteCtxKey, route)
		ctx = context.WithValue(ctx, ctxMember, &identity{WorkspaceID: workspaceID})
		recorder := httptest.NewRecorder()
		if err := env.srv.listTopics(recorder, httptest.NewRequest("GET", acc+"/topics?limit=50&q="+query, nil).WithContext(ctx)); err != nil {
			t.Fatal(err)
		}
		if recorder.Code != 200 {
			t.Fatalf("list topics status = %d, body=%s", recorder.Code, recorder.Body.String())
		}
		var page struct {
			Items []Topic `json:"items"`
		}
		if err := json.Unmarshal(recorder.Body.Bytes(), &page); err != nil {
			t.Fatal(err)
		}
		return page.Items
	}

	// 不带 q：目标选题不在第一页（说明它确实在分页之外）。
	found := false
	for _, x := range request("") {
		if x.ID == want.Topic.ID {
			found = true
		}
	}
	if found {
		t.Fatal("fixture should sit beyond the first page")
	}
	// 带 q 命中 title。
	if items := request("%E8%BF%9C%E6%96%B9%E6%9D%A5%E5%AE%A2"); len(items) != 1 || items[0].ID != want.Topic.ID {
		t.Fatalf("q=title keyword should find the topic beyond page 1: %+v", items)
	}
	// 带 q 命中 audience / hook / angle。
	for _, kw := range []string{"%E8%BF%90%E8%90%A5%E6%96%B0%E6%89%8B", "%E5%A2%9E%E9%95%BF%E6%95%85%E4%BA%8B", "%E8%A7%92%E5%BA%A6%E5%86%99%E7%BB%99"} {
		items := request(kw)
		if len(items) != 1 || items[0].ID != want.Topic.ID {
			t.Fatalf("q=%s should find the topic: %+v", kw, items)
		}
	}
}
