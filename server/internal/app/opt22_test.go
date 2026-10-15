package app

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestOPT22PresenceExpiresDuringPauseAndReturnsAfterHeartbeat(t *testing.T) {
	guest := env.registerClient(t, "opt22-"+uuid.NewString()[:8], testPassword)
	t.Cleanup(func() { guest.restore(env) })
	a, _ := v4Account(t, "后台心跳验收")
	var work Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+a.ID.String()+"/works", map[string]string{"title": "暂停心跳"}, &work)
	srv, err := New(env.srv.cfg, env.srv.db)
	if err != nil {
		t.Fatal(err)
	}
	var offset time.Duration
	now := env.srv.now()
	srv.now = func() time.Time { return now.Add(offset) }
	server := httptest.NewServer(srv.Router())
	defer server.Close()
	heartbeat := func() {
		t.Helper()
		req, err := http.NewRequest("POST", server.URL+"/api/v1/works/"+work.ID.String()+"/presence", strings.NewReader("{}"))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-CSRF-Token", env.csrf)
		resp, err := env.client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		body, err := io.ReadAll(resp.Body)
		if err != nil || resp.StatusCode != 200 {
			t.Fatalf("heartbeat: %d %s %v", resp.StatusCode, body, err)
		}
	}
	heartbeat()
	if entries := srv.presenceList(work.ID, uuid.Nil); len(entries) != 1 {
		t.Fatalf("initial presence: %v", entries)
	}
	offset = 31 * time.Second
	if entries := srv.presenceList(work.ID, uuid.Nil); len(entries) != 0 {
		t.Fatalf("paused heartbeat did not expire: %v", entries)
	}
	offset = 5 * time.Minute
	heartbeat()
	if entries := srv.presenceList(work.ID, uuid.Nil); len(entries) != 1 || !entries[0].At.Equal(now.Add(offset)) {
		t.Fatalf("resumed presence: %v", entries)
	}
}
