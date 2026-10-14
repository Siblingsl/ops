package app

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type opt28QueryTracer struct {
	mu      sync.Mutex
	queries []string
}

func (t *opt28QueryTracer) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	t.mu.Lock()
	t.queries = append(t.queries, data.SQL)
	t.mu.Unlock()
	return ctx
}

func (t *opt28QueryTracer) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

func (t *opt28QueryTracer) reset() {
	t.mu.Lock()
	t.queries = nil
	t.mu.Unlock()
}

func (t *opt28QueryTracer) snapshot() []string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return append([]string(nil), t.queries...)
}

func TestOPT28WorkQueriesAndPushPreviewPayload(t *testing.T) {
	f := env.accounts(t)
	var cardAccount Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{
		"platform": "xhs", "name": "OPT28 卡片查询", "content_format": "card_post",
	}, &cardAccount)
	var cardWork Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+cardAccount.ID.String()+"/works", map[string]string{"title": "OPT28 卡片作品"}, &cardWork)
	var previewWork Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+f.wechat.ID.String()+"/works", map[string]string{"title": "OPT28 预览作品"}, &previewWork)

	var workspaceID uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(), `SELECT workspace_id FROM platform_account WHERE id=$1`, cardAccount.ID).Scan(&workspaceID); err != nil {
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

	requestContext := func(id string) context.Context {
		route := chi.NewRouteContext()
		route.URLParams.Add("id", id)
		ctx := context.WithValue(context.Background(), chi.RouteCtxKey, route)
		return context.WithValue(ctx, ctxMember, &identity{WorkspaceID: workspaceID})
	}
	workResponse := httptest.NewRecorder()
	workRequest := httptest.NewRequest("GET", "/api/v1/works/"+cardWork.ID.String(), nil).WithContext(requestContext(cardWork.ID.String()))
	if err := env.srv.getWork(workResponse, workRequest); err != nil {
		t.Fatal(err)
	}
	if workResponse.Code != 200 {
		t.Fatalf("work detail status = %d, body=%s", workResponse.Code, workResponse.Body.String())
	}
	if got := len(tracer.snapshot()); got > 5 {
		t.Fatalf("work detail queries = %d, want at most 5", got)
	}

	tracer.reset()
	previewResponse := httptest.NewRecorder()
	previewRequest := httptest.NewRequest("GET", "/api/v1/works/"+previewWork.ID.String()+"/wechat/push-preview", nil).
		WithContext(requestContext(previewWork.ID.String()))
	if err := env.srv.pushPreview(previewResponse, previewRequest); err != nil {
		t.Fatal(err)
	}
	if previewResponse.Code != 200 {
		t.Fatalf("push preview status = %d, body=%s", previewResponse.Code, previewResponse.Body.String())
	}
	var preview struct {
		Title         string `json:"title"`
		ContentFormat string `json:"content_format"`
	}
	if err := json.Unmarshal(previewResponse.Body.Bytes(), &preview); err != nil {
		t.Fatal(err)
	}
	if preview.Title != "OPT28 预览作品" || preview.ContentFormat != "long_article" {
		t.Fatalf("push preview metadata = %+v", preview)
	}
	for _, query := range tracer.snapshot() {
		lower := strings.ToLower(query)
		if strings.Contains(lower, "content_md") || strings.Contains(lower, "ai_raw_md") {
			t.Fatalf("push preview queried article body: %s", query)
		}
	}
}

func TestOPT28OrderedListNumberRegexPreservesNumbering(t *testing.T) {
	got := mdToPlain("1. 第一项\n12. 第十二项")
	if got != "1. 第一项\n12. 第十二项" {
		t.Fatalf("ordered list output = %q", got)
	}
}
