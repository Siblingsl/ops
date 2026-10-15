package app

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestOPT29WorkListP95Under100msAt300(t *testing.T) {
	var account Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{
		"platform": "wechat_mp", "name": "OPT29 作品性能", "content_format": "long_article",
	}, &account)
	if _, err := env.srv.db.Exec(context.Background(), `INSERT INTO work(account_id,content_format,title)
		SELECT $1,'long_article','OPT29 性能作品 '||n FROM generate_series(1,300) n`, account.ID); err != nil {
		t.Fatal(err)
	}
	var workspaceID uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(), `SELECT workspace_id FROM platform_account WHERE id=$1`, account.ID).Scan(&workspaceID); err != nil {
		t.Fatal(err)
	}
	ctxForAccount := func() context.Context {
		route := chi.NewRouteContext()
		route.URLParams.Add("accountId", account.ID.String())
		ctx := context.WithValue(context.Background(), chi.RouteCtxKey, route)
		return context.WithValue(ctx, ctxMember, &identity{WorkspaceID: workspaceID})
	}
	request := func() time.Duration {
		recorder := httptest.NewRecorder()
		r := httptest.NewRequest("GET", "/api/v1/accounts/"+account.ID.String()+"/works", nil).WithContext(ctxForAccount())
		start := time.Now()
		if err := env.srv.listWorks(recorder, r); err != nil {
			t.Fatal(err)
		}
		elapsed := time.Since(start)
		if recorder.Code != 200 {
			t.Fatalf("list works status = %d, body=%s", recorder.Code, recorder.Body.String())
		}
		var items []WorkListItem
		if err := json.Unmarshal(recorder.Body.Bytes(), &items); err != nil {
			t.Fatal(err)
		}
		if len(items) != 300 {
			t.Fatalf("work list length = %d, want 300", len(items))
		}
		return elapsed
	}
	for i := 0; i < 5; i++ {
		request()
	}
	samples := make([]time.Duration, 100)
	for i := range samples {
		samples[i] = request()
	}
	sort.Slice(samples, func(i, j int) bool { return samples[i] < samples[j] })
	p95 := samples[(len(samples)*95+99)/100-1]
	t.Logf("300-work list: 100 requests, p95=%s", p95)
	if p95 >= 100*time.Millisecond {
		t.Fatalf("300-work list p95 = %s, want <100ms", p95)
	}
}

func TestOPT29TopicPaginationAndOneMaterialScan(t *testing.T) {
	var account Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{
		"platform": "xhs", "name": "OPT29 选题分页", "content_format": "image_note",
	}, &account)
	var topics []Topic
	for i := 0; i < 55; i++ {
		var created struct {
			Topic Topic `json:"topic"`
		}
		env.mustJSON(t, "POST", "/api/v1/accounts/"+account.ID.String()+"/topics", map[string]string{
			"title": "OPT29 分页主题 " + string(rune('A'+i)), "angle": "经验整理",
		}, &created)
		topics = append(topics, created.Topic)
	}
	env.mustJSON(t, "PATCH", "/api/v1/topics/"+topics[len(topics)-1].ID.String(), map[string]bool{"pinned": true}, nil)
	var workspaceID uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(), `SELECT workspace_id FROM platform_account WHERE id=$1`, account.ID).Scan(&workspaceID); err != nil {
		t.Fatal(err)
	}
	poolConfig, err := pgxpool.ParseConfig(env.srv.cfg.DatabaseURL)
	if err != nil {
		t.Fatal(err)
	}
	tracer := &opt28QueryTracer{}
	poolConfig.ConnConfig.Tracer = tracer
	pool, err := pgxpool.NewWithConfig(context.Background(), poolConfig)
	if err != nil {
		t.Fatal(err)
	}
	oldPool := env.srv.db
	env.srv.db = pool
	defer func() {
		env.srv.db = oldPool
		pool.Close()
	}()
	request := func(cursor string, score bool) (*httptest.ResponseRecorder, error) {
		route := chi.NewRouteContext()
		route.URLParams.Add("accountId", account.ID.String())
		ctx := context.WithValue(context.Background(), chi.RouteCtxKey, route)
		ctx = context.WithValue(ctx, ctxMember, &identity{WorkspaceID: workspaceID})
		path := "/api/v1/accounts/" + account.ID.String() + "/topics?limit=50"
		if score {
			path += "&scores=1"
		}
		if cursor != "" {
			path += "&cursor=" + cursor
		}
		recorder := httptest.NewRecorder()
		err := env.srv.listTopics(recorder, httptest.NewRequest("GET", path, nil).WithContext(ctx))
		return recorder, err
	}
	firstResponse, err := request("", true)
	if err != nil {
		t.Fatal(err)
	}
	var first struct {
		Items        []Topic           `json:"items"`
		StatusCounts topicStatusCounts `json:"status_counts"`
		NextCursor   *string           `json:"next_cursor"`
	}
	if err := json.Unmarshal(firstResponse.Body.Bytes(), &first); err != nil {
		t.Fatal(err)
	}
	if len(first.Items) != 50 || first.NextCursor == nil || first.StatusCounts.Pending != 55 {
		t.Fatalf("first topic page: items=%d cursor=%v counts=%+v", len(first.Items), first.NextCursor, first.StatusCounts)
	}
	if first.Items[0].ID != topics[len(topics)-1].ID || !first.Items[0].Pinned {
		t.Fatalf("pinned topic was not first: %+v", first.Items[0])
	}
	materialScans := 0
	for _, query := range tracer.snapshot() {
		if strings.Contains(strings.ToLower(query), "from material") {
			materialScans++
		}
	}
	if materialScans != 1 {
		t.Fatalf("page scoring material scans = %d, want 1", materialScans)
	}
	secondResponse, err := request(*first.NextCursor, false)
	if err != nil {
		t.Fatal(err)
	}
	var second struct {
		Items      []Topic `json:"items"`
		NextCursor *string `json:"next_cursor"`
	}
	if err := json.Unmarshal(secondResponse.Body.Bytes(), &second); err != nil {
		t.Fatal(err)
	}
	if len(second.Items) != 5 || second.NextCursor != nil || second.Items[0].ID == first.Items[len(first.Items)-1].ID {
		t.Fatalf("second topic page: items=%d cursor=%v", len(second.Items), second.NextCursor)
	}
}
