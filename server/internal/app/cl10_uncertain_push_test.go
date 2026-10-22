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

	"ops/internal/wechat"
)

func TestCL10WechatWriteSucceededLocalPersistenceFailedRemainsReserved(t *testing.T) {
	ctx := context.Background()
	a := env.accounts(t).wechat
	wk := env.readyWork(t, a, "先把发布结果不明的边界验证清楚")

	constraint := "cl10_fail_push_" + strings.ReplaceAll(wk.ID.String(), "-", "")
	ddl := fmt.Sprintf(`ALTER TABLE work ADD CONSTRAINT %s CHECK (id <> '%s'::uuid OR status <> 'pushed') NOT VALID`, constraint, wk.ID)
	if _, err := env.srv.db.Exec(ctx, ddl); err != nil {
		t.Fatal(err)
	}
	oldWX := env.srv.wx
	var mu sync.Mutex
	var addCalls, getCalls int
	var draftMediaID string
	var draftReadBack bool
	delegate := env.mockWX.Handler()
	gate := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		recorder := httptest.NewRecorder()
		delegate.ServeHTTP(recorder, r)
		mu.Lock()
		switch r.URL.Path {
		case "/cgi-bin/draft/add":
			addCalls++
			var body struct {
				MediaID string `json:"media_id"`
			}
			if recorder.Code == http.StatusOK && json.Unmarshal(recorder.Body.Bytes(), &body) == nil {
				draftMediaID = body.MediaID
			}
		case "/cgi-bin/draft/get":
			getCalls++
			var body struct {
				NewsItem []json.RawMessage `json:"news_item"`
			}
			if recorder.Code == http.StatusOK && json.Unmarshal(recorder.Body.Bytes(), &body) == nil && len(body.NewsItem) == 1 {
				draftReadBack = true
			}
		}
		mu.Unlock()
		for key, values := range recorder.Header() {
			for _, value := range values {
				w.Header().Add(key, value)
			}
		}
		w.WriteHeader(recorder.Code)
		_, _ = w.Write(recorder.Body.Bytes())
	}))
	env.srv.wx = wechat.New(gate.URL)
	t.Cleanup(func() {
		env.srv.wx = oldWX
		gate.Close()
		_, _ = env.srv.db.Exec(context.Background(), fmt.Sprintf(`ALTER TABLE work DROP CONSTRAINT IF EXISTS %s`, constraint))
	})

	events := env.push(t, wk, nil)
	var eventErr struct {
		Code string `json:"code"`
	}
	if got := lastEvent(t, events); got.Name != "error" || json.Unmarshal(got.Data, &eventErr) != nil || eventErr.Code != "internal" {
		t.Fatalf("expected a local persistence error after WeChat accepted the draft, got %+v", got)
	}

	mu.Lock()
	adds, gets, mediaID, readBack := addCalls, getCalls, draftMediaID, draftReadBack
	mu.Unlock()
	if adds != 1 || gets != 1 || mediaID == "" || !readBack {
		t.Fatalf("mock WeChat did not confirm one created and readable draft: add=%d get=%d media_id=%q read_back=%v", adds, gets, mediaID, readBack)
	}
	var recordStatus, failedStep string
	var recordMediaID string
	var recordCount int
	if err := env.srv.db.QueryRow(ctx, `SELECT count(*), coalesce(max(status),''), coalesce(max(failed_step),''), coalesce(max(draft_media_id),'')
		FROM push_record WHERE work_id=$1`, wk.ID).Scan(&recordCount, &recordStatus, &failedStep, &recordMediaID); err != nil {
		t.Fatal(err)
	}
	if recordCount != 1 || recordStatus != "running" || failedStep != "" || recordMediaID != "" {
		t.Fatalf("uncertain local result must remain reserved without claiming failure or success: count=%d status=%q step=%q media_id=%v", recordCount, recordStatus, failedStep, recordMediaID)
	}
	var status string
	var workMediaID string
	if err := env.srv.db.QueryRow(ctx, `SELECT status,coalesce(wechat_draft_media_id,'') FROM work WHERE id=$1`, wk.ID).Scan(&status, &workMediaID); err != nil {
		t.Fatal(err)
	}
	if status != "ready" || workMediaID != "" {
		t.Fatalf("failed local persistence changed the work: status=%q media_id=%v", status, workMediaID)
	}

	input := map[string]any{"html": testHTML(wk), "revision": wk.Revision, "fields": wk.WechatFields}
	env.expectErr(t, "POST", "/api/v1/works/"+wk.ID.String()+"/wechat/push", input, "wechat_push_running")
	mu.Lock()
	adds = addCalls
	mu.Unlock()
	if adds != 1 {
		t.Fatalf("an immediate retry made another external draft write: add calls=%d", adds)
	}
	t.Logf("injected local save failure after successful mock DraftAdd and DraftGet (%s): external add=1, push_record=running, work unchanged, immediate retry rejected", mediaID)
}
