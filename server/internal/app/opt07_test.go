package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestOPT07AIWritebackPreservesConcurrentEdit(t *testing.T) {
	for _, task := range []string{"draft", "rewrite"} {
		t.Run(task, func(t *testing.T) {
			guest := env.registerClient(t, "opt07-"+uuid.NewString()[:8], testPassword)
			t.Cleanup(func() { guest.restore(env) })
			var a Account
			env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{"platform": "wechat_mp", "content_format": "long_article", "name": "修订保护模拟号"}, &a)
			wk := outlinedWork(t, a, "把任务拆成小步骤，这是我的经验判断")
			if task == "rewrite" {
				var target Account
				env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{"platform": "xhs", "content_format": "image_note", "name": "派生修订模拟号"}, &target)
				env.mustJSON(t, "PATCH", "/api/v1/sections/"+wk.Sections[0].ID.String(), map[string]any{"content_md": "先明确目标，再安排一小步。这是我的经验判断。", "base_revision": wk.Sections[0].Revision}, nil)
				env.mustJSON(t, "POST", "/api/v1/works/"+wk.ID.String()+"/derive", map[string]any{"target_account_id": target.ID}, &wk)
			}
			sec := wk.Sections[0]
			ctx := context.Background()
			var beforeSource string
			if err := env.srv.db.QueryRow(ctx, `SELECT source_revisions::text FROM work_section WHERE id=$1`, sec.ID).Scan(&beforeSource); err != nil {
				t.Fatal(err)
			}
			started, gate := make(chan struct{}), make(chan struct{})
			release := sync.OnceFunc(func() { close(gate) })
			model := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				close(started)
				select {
				case <-gate:
					if task == "draft" {
						w.Header().Set("Content-Type", "text/event-stream")
						frame, _ := json.Marshal(map[string]any{"choices": []map[string]any{{"delta": map[string]string{"content": "这是最好的安排，选择小步骤更容易坚持。"}}}})
						fmt.Fprintf(w, "data: %s\n\ndata: [DONE]\n\n", frame)
					} else {
						env.llm.Handler().ServeHTTP(w, r)
					}
				case <-r.Context().Done():
				}
			}))
			t.Cleanup(model.Close)
			t.Cleanup(release)
			var provider struct{ ID uuid.UUID }
			env.mustJSON(t, "POST", "/api/v1/model-providers", map[string]any{"name": "修订交错模拟模型", "base_url": model.URL + "/v1", "api_key": "opt07-local-mock-key", "models": []string{"mock-writer"}}, &provider)
			env.mustJSON(t, "PUT", "/api/v1/model-routes", []map[string]any{{"task_type": "default", "provider_id": provider.ID, "model": "mock-writer"}}, nil)
			streamCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
			defer cancel()
			events := opt04Stream(streamCtx, "/api/v1/sections/"+sec.ID.String()+"/"+task, env.csrf)
			select {
			case <-started:
			case <-streamCtx.Done():
				t.Fatal("mock model did not start")
			}
			manual := "模型等待期间，另一会话保存的正文。"
			env.mustJSON(t, "PATCH", "/api/v1/sections/"+sec.ID.String(), map[string]any{"content_md": manual, "base_revision": sec.Revision}, nil)
			release()
			event := opt04Wait(t, events, "error", "")
			var failure struct {
				Code    string `json:"code"`
				Message string `json:"message"`
				Detail  struct {
					Server          Section         `json:"server"`
					Candidate       string          `json:"candidate"`
					CallID          uuid.UUID       `json:"ai_call_id"`
					SourceRevisions json.RawMessage `json:"source_revisions"`
					Refs            map[string]any  `json:"refs"`
					SelfCheck       *struct {
						Fixes    []draftFix `json:"fixes"`
						Original string     `json:"original"`
					} `json:"self_check"`
				} `json:"detail"`
			}
			if err := json.Unmarshal(event.Data, &failure); err != nil {
				t.Fatal(err)
			}
			if failure.Code != "version_conflict" || failure.Message != "这段在生成期间被修改过" || failure.Detail.Server.ContentMD != manual || failure.Detail.Candidate == "" || failure.Detail.CallID == uuid.Nil {
				t.Fatalf("AI conflict: %s", event.Data)
			}
			if failure.Detail.Refs["section_id"] != sec.ID.String() {
				t.Fatalf("conflict candidate lost references: %s", event.Data)
			}
			if task == "draft" && (failure.Detail.SelfCheck == nil || len(failure.Detail.SelfCheck.Fixes) != 1 || !strings.Contains(failure.Detail.SelfCheck.Original, "最好的") || strings.Contains(failure.Detail.Candidate, "最好的")) {
				t.Fatalf("conflict candidate lost references/self-check annotation: %s", event.Data)
			}
			var afterSource, text string
			var revision, candidateHistory int
			if err := env.srv.db.QueryRow(ctx, `SELECT source_revisions::text, content_md, revision FROM work_section WHERE id=$1`, sec.ID).Scan(&afterSource, &text, &revision); err != nil {
				t.Fatal(err)
			}
			if err := env.srv.db.QueryRow(ctx, `SELECT count(*) FROM section_revision WHERE section_id=$1 AND content_md=$2`, sec.ID, failure.Detail.Candidate).Scan(&candidateHistory); err != nil {
				t.Fatal(err)
			}
			if text != manual || revision != sec.Revision+1 || beforeSource != afterSource || candidateHistory != 0 {
				t.Fatalf("AI overwrote current/history/source: text=%q revision=%d sources=%s/%s history=%d", text, revision, beforeSource, afterSource, candidateHistory)
			}
			env.mustJSON(t, "PATCH", "/api/v1/sections/"+sec.ID.String(), map[string]any{"content_md": failure.Detail.Candidate, "base_revision": revision, "applied": map[string]any{"kind": "draft", "ai_call_id": failure.Detail.CallID, "source_revisions": failure.Detail.SourceRevisions}}, nil)
			var current Work
			env.mustJSON(t, "GET", "/api/v1/works/"+wk.ID.String(), nil, &current)
			var raw string
			if err := env.srv.db.QueryRow(ctx, `SELECT ai_raw_md FROM work_section WHERE id=$1`, sec.ID).Scan(&raw); err != nil {
				t.Fatal(err)
			}
			if current.Sections[0].ContentMD != failure.Detail.Candidate || current.Sections[0].Origin != "ai" || raw != failure.Detail.Candidate || current.Sections[0].Revision != revision+1 {
				t.Fatal("explicit candidate replacement did not retain AI metadata")
			}
			env.expectErr(t, "PATCH", "/api/v1/sections/"+sec.ID.String(), map[string]any{"content_md": "迟到的选择不能覆盖", "base_revision": revision}, "version_conflict")
		})
	}
}

func TestOPT07StaleRestoreOrderOutlineTitleAndSummary(t *testing.T) {
	wk := outlinedWork(t, env.accounts(t).wechat, "先完成小目标，这是我的经验判断")
	sec := wk.Sections[0]
	id := wk.ID.String()
	env.mustJSON(t, "PATCH", "/api/v1/sections/"+sec.ID.String(), map[string]any{"content_md": "人工保存的正文", "base_revision": sec.Revision}, nil)
	var revisions []SectionRevision
	env.mustJSON(t, "GET", "/api/v1/sections/"+sec.ID.String()+"/revisions", nil, &revisions)
	env.expectErr(t, "POST", "/api/v1/sections/"+sec.ID.String()+"/revisions/"+revisions[0].ID.String()+"/restore", map[string]any{"base_revision": sec.Revision}, "version_conflict")
	ids := []uuid.UUID{}
	for _, section := range wk.Sections {
		ids = append(ids, section.ID)
	}
	env.expectErr(t, "PUT", "/api/v1/works/"+id+"/sections/order", map[string]any{"ids": ids, "base_revision": wk.Revision}, "version_conflict")
	env.expectErr(t, "PUT", "/api/v1/works/"+id+"/outline", map[string]any{"items": wk.Outline, "confirm": true, "base_revision": wk.Revision}, "version_conflict")
	env.expectErr(t, "PATCH", "/api/v1/works/"+id, map[string]any{"title": "过期标题", "base_revision": wk.Revision}, "version_conflict")
	env.expectErr(t, "PATCH", "/api/v1/works/"+id, map[string]any{"summary": "过期摘要", "base_revision": wk.Revision}, "version_conflict")
	var current Work
	env.mustJSON(t, "GET", "/api/v1/works/"+id, nil, &current)
	if current.Title != wk.Title || current.Summary != wk.Summary || current.Sections[0].ContentMD != "人工保存的正文" || current.Revision != wk.Revision+1 {
		t.Fatal("stale write changed work")
	}
	env.mustJSON(t, "POST", "/api/v1/sections/"+sec.ID.String()+"/revisions/"+revisions[0].ID.String()+"/restore", map[string]any{"base_revision": current.Sections[0].Revision}, &current)
	env.mustJSON(t, "PUT", "/api/v1/works/"+id+"/sections/order", map[string]any{"ids": ids, "base_revision": current.Revision}, &current)
	env.mustJSON(t, "PATCH", "/api/v1/works/"+id, map[string]any{"title": "有效标题", "summary": "有效摘要", "base_revision": current.Revision}, &current)
	if current.Title != "有效标题" || current.Summary != "有效摘要" {
		t.Fatal("fresh revisions did not save")
	}
}

func TestOPT07ConcurrentManualSaveChecksUnderLock(t *testing.T) {
	wk := outlinedWork(t, env.accounts(t).wechat, "每次只做一小步，这是我的经验判断")
	sec := wk.Sections[0]
	ctx := context.Background()
	tx, err := env.srv.db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT id FROM work_section WHERE id=$1 FOR UPDATE`, sec.ID); err != nil {
		t.Fatal(err)
	}
	out := make(chan int, 2)
	for i := 0; i < 2; i++ {
		go func() {
			status, _ := env.do("PATCH", "/api/v1/sections/"+sec.ID.String(), map[string]any{"content_md": "同基准的保存请求", "base_revision": sec.Revision})
			out <- status
		}()
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		var waiting int
		if err := env.srv.db.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FROM work_section WHERE id=$1 AND deleted_at IS NULL FOR UPDATE%'`).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting == 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("both save requests did not wait for the row lock")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	first, second := <-out, <-out
	if !(first == 200 && second == 409 || first == 409 && second == 200) {
		t.Fatalf("same revision statuses: %d %d", first, second)
	}
	var current Work
	env.mustJSON(t, "GET", "/api/v1/works/"+wk.ID.String(), nil, &current)
	if current.Sections[0].Revision != sec.Revision+1 || !strings.Contains(current.Sections[0].ContentMD, "同基准") {
		t.Fatal("concurrent saves did not commit exactly once")
	}
}
