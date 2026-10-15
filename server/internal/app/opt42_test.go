package app

import (
	"bytes"
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
)

func opt42Account(t *testing.T) Account {
	t.Helper()
	guest := env.registerClient(t, "opt42-"+uuid.NewString()[:8], testPassword)
	t.Cleanup(func() { guest.restore(env) })
	var a Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{"platform": "wechat_mp", "content_format": "long_article", "name": "素材完整性模拟号"}, &a)
	return a
}

func opt42Model(t *testing.T, handler http.Handler) {
	t.Helper()
	model := httptest.NewServer(handler)
	t.Cleanup(model.Close)
	var provider Provider
	env.mustJSON(t, "POST", "/api/v1/model-providers", map[string]any{"name": "素材完整性模拟模型", "base_url": model.URL + "/v1", "api_key": "opt42-local-mock-key", "models": []string{"mock-writer"}}, &provider)
	env.mustJSON(t, "PUT", "/api/v1/model-routes", []map[string]any{{"task_type": "section_draft", "provider_id": provider.ID, "model": "mock-writer"}}, nil)
}

func TestOPT42DraftPreservesSixMaterialsViewpointAndTenthOutline(t *testing.T) {
	a := opt42Account(t)
	var mids []uuid.UUID
	var texts []string
	for i := 0; i < 6; i++ {
		text := fmt.Sprintf("素材%d：", i+1) + strings.Repeat(string(rune('甲'+i)), 996)
		var material Material
		env.mustJSON(t, "POST", "/api/v1/materials", map[string]any{"account_id": a.ID, "kind": "case", "content": text}, &material)
		mids, texts = append(mids, material.ID), append(texts, text)
	}
	viewpoint := "作者完整观点：" + strings.Repeat("观点必须完整", 600)
	var work Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+a.ID.String()+"/works", map[string]string{"title": "第十段素材验收"}, &work)
	env.mustJSON(t, "PATCH", "/api/v1/works/"+work.ID.String(), map[string]any{"viewpoint": viewpoint, "material_ids": mids, "base_revision": work.Revision}, &work)
	items := make([]OutlineItem, 10)
	for i := range items {
		items[i] = OutlineItem{Heading: fmt.Sprintf("第%d段小标题", i+1), KeyPoint: fmt.Sprintf("第%d段完整要点：", i+1) + strings.Repeat("要点", 250)}
	}
	env.mustJSON(t, "PUT", "/api/v1/works/"+work.ID.String()+"/outline", map[string]any{"items": items, "confirm": true, "base_revision": work.Revision}, &work)
	received := make(chan string, 1)
	opt42Model(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, err := io.ReadAll(r.Body)
		if err != nil {
			w.WriteHeader(400)
			return
		}
		var request struct {
			Messages []struct{ Role, Content string }
		}
		if json.Unmarshal(raw, &request) != nil {
			w.WriteHeader(400)
			return
		}
		for _, message := range request.Messages {
			if message.Role == "user" {
				received <- message.Content
			}
		}
		r.Body = io.NopCloser(bytes.NewReader(raw))
		env.llm.Handler().ServeHTTP(w, r)
	}))
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	done := opt04Wait(t, opt04Stream(ctx, "/api/v1/sections/"+work.Sections[9].ID.String()+"/draft", env.csrf), "done", "")
	prompt := <-received
	for i, text := range texts {
		if !strings.Contains(prompt, text) {
			t.Fatalf("material %d missing or truncated", i+1)
		}
	}
	if !strings.Contains(prompt, viewpoint) || !strings.Contains(prompt, "10. "+items[9].Heading+" —— "+items[9].KeyPoint) {
		t.Fatal("viewpoint or full tenth outline item truncated")
	}
	for i := 0; i < 9; i++ {
		if !strings.Contains(prompt, fmt.Sprintf("%d. %s\n", i+1, items[i].Heading)) || strings.Contains(prompt, items[i].KeyPoint) {
			t.Fatalf("unrelated outline %d must retain only its heading", i+1)
		}
	}
	var result struct {
		Refs struct {
			Slots []Slot `json:"slots"`
		} `json:"refs"`
	}
	if err := json.Unmarshal(done.Data, &result); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, slot := range result.Refs.Slots {
		if slot.Name != "materials" {
			continue
		}
		found = true
		if slot.Truncated || slot.Budget != 0 || slot.Chars < 6000 || len(slot.Items) != 6 {
			t.Fatalf("material refs: %+v", slot)
		}
		for _, item := range slot.Items {
			if !item.Used {
				t.Fatalf("unused material: %+v", item)
			}
		}
	}
	if !found {
		t.Fatal("material slot missing from done refs")
	}
}

func TestOPT42ContextRejectionHasChineseActionAndNoRetry(t *testing.T) {
	for _, status := range []int{400, 413} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			a := opt42Account(t)
			work := outlinedWork(t, a, "只使用我明确选择的素材")
			var material Material
			env.mustJSON(t, "POST", "/api/v1/materials", map[string]any{"account_id": a.ID, "kind": "case", "content": "作者提供的完整素材"}, &material)
			env.mustJSON(t, "PATCH", "/api/v1/works/"+work.ID.String(), map[string]any{"material_ids": []uuid.UUID{material.ID}, "base_revision": work.Revision}, nil)
			opt42Model(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(status)
				fmt.Fprint(w, `{"error":{"code":"context_length_exceeded","message":"context too long"}}`)
			}))
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			failure := opt04Wait(t, opt04Stream(ctx, "/api/v1/sections/"+work.Sections[0].ID.String()+"/draft", env.csrf), "error", "")
			var got struct{ Code, Message string }
			if err := json.Unmarshal(failure.Data, &got); err != nil {
				t.Fatal(err)
			}
			if got.Code != "ai_context_too_long" || got.Message != "选中素材过长，请减少" {
				t.Fatalf("error: %s", failure.Data)
			}
			var count int
			if err := env.srv.db.QueryRow(ctx, `SELECT count(*) FROM ai_call WHERE work_id=$1 AND task_type='section_draft' AND status='failed'`, work.ID).Scan(&count); err != nil || count != 1 {
				t.Fatalf("failed attempts=%d err=%v", count, err)
			}
		})
	}
}

func TestOPT42ProtectedWorkCanExceedSoftBudget(t *testing.T) {
	a := opt42Account(t)
	var ws uuid.UUID
	ctx := context.Background()
	if err := env.srv.db.QueryRow(ctx, `SELECT workspace_id FROM platform_account WHERE id=$1`, a.ID).Scan(&ws); err != nil {
		t.Fatal(err)
	}
	ctx = context.WithValue(ctx, ctxMember, &identity{WorkspaceID: ws})
	main := "核心观点：" + strings.Repeat("观点", 2000)
	pack, err := env.srv.buildContext(ctx, aiTask{Type: "section_draft", Account: &a, Work: main, Neighbors: strings.Repeat("邻文", 1000), User: "写当前一段"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(pack.User, main) || strings.Contains(pack.User, "邻文") {
		t.Fatal("protected work must survive while neighbours are dropped")
	}
}
