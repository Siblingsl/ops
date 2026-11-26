package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

// RC-17 / D1：push-preview 是写入草稿的前置读取，权限必须与写入一致：
// owner/editor 可读，viewer 只读角色返回 403 forbidden。
func TestPushPreviewRoleGuardRC17D1(t *testing.T) {
	f := env.accounts(t)
	var wk Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+f.wechat.ID.String()+"/works", map[string]string{"title": "RC17 D1 预览权限"}, &wk)
	var workspaceID uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(), `SELECT workspace_id FROM platform_account WHERE id=$1`, f.wechat.ID).Scan(&workspaceID); err != nil {
		t.Fatal(err)
	}

	call := func(role string) (int, string) {
		t.Helper()
		route := chi.NewRouteContext()
		route.URLParams.Add("id", wk.ID.String())
		ctx := context.WithValue(context.Background(), chi.RouteCtxKey, route)
		ctx = context.WithValue(ctx, ctxMember, &identity{WorkspaceID: workspaceID, Role: role})
		req := httptest.NewRequest(http.MethodGet, "/api/v1/works/"+wk.ID.String()+"/wechat/push-preview", nil).WithContext(ctx)
		rec := httptest.NewRecorder()
		env.srv.h(env.srv.pushPreview)(rec, req)
		var body struct {
			Error struct {
				Code string `json:"code"`
			} `json:"error"`
		}
		if rec.Body.Len() > 0 {
			_ = json.Unmarshal(rec.Body.Bytes(), &body)
		}
		return rec.Code, body.Error.Code
	}

	for _, role := range []string{"owner", "editor"} {
		if status, _ := call(role); status != http.StatusOK {
			t.Fatalf("%s push-preview status = %d, want 200", role, status)
		}
	}
	if status, code := call("viewer"); status != http.StatusForbidden || code != "forbidden" {
		t.Fatalf("viewer push-preview status = %d code = %q, want 403 forbidden", status, code)
	}
}
