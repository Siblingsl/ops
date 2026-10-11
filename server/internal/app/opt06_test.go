package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"ops/internal/wechat"
)

func TestOPT06ConcurrentPushCreatesOneDraft(t *testing.T) {
	for _, format := range []string{"long_article", "card_post"} {
		t.Run(format, func(t *testing.T) {
			var a Account
			var wk Work
			if format == "long_article" {
				a = env.accounts(t).wechat
				wk = env.readyWork(t, a, "先完成小目标，这是我的经验判断")
			} else {
				a, wk = buildCardWork(t, "wechat_mp")
				env.confirmChecks(t, wk.ID.String())
				env.mustJSON(t, "GET", "/api/v1/works/"+wk.ID.String(), nil, &wk)
				env.reauth(t)
				env.mustJSON(t, "PUT", "/api/v1/accounts/"+a.ID.String()+"/wechat-credential", map[string]string{"app_id": "wx1234567890", "app_secret": "s3cret-value-for-test"}, nil)
			}
			ctx := context.Background()
			before, err := env.srv.todayPushCount(ctx, a.ID)
			if err != nil {
				t.Fatal(err)
			}
			started, release := make(chan struct{}), make(chan struct{})
			var unblock sync.Once
			var adds atomic.Int32
			delegate := env.mockWX.Handler()
			gate := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/cgi-bin/draft/add" {
					if adds.Add(1) == 1 {
						close(started)
					}
					select {
					case <-release:
					case <-r.Context().Done():
						return
					}
				}
				delegate.ServeHTTP(w, r)
			}))
			defer func() {
				unblock.Do(func() { close(release) })
				gate.Close()
			}()
			oldWX := env.srv.wx
			env.srv.wx = wechat.New(gate.URL)
			defer func() { env.srv.wx = oldWX }()
			input := map[string]any{"revision": wk.Revision, "fields": wk.WechatFields, "html": testHTML(wk), "confirm_over_limit": true}
			payload, _ := json.Marshal(input)
			type response struct {
				status int
				body   string
				err    error
			}
			send := func() <-chan response {
				out := make(chan response, 1)
				go func() {
					req, _ := http.NewRequest("POST", env.http.URL+"/api/v1/works/"+wk.ID.String()+"/wechat/push", bytes.NewReader(payload))
					req.Header.Set("Content-Type", "application/json")
					req.Header.Set("X-CSRF-Token", env.csrf)
					rsp, err := env.client.Do(req)
					if err != nil {
						out <- response{err: err}
						return
					}
					defer rsp.Body.Close()
					body, err := io.ReadAll(rsp.Body)
					out <- response{rsp.StatusCode, string(body), err}
				}()
				return out
			}
			first := send()
			select {
			case <-started:
			case result := <-first:
				t.Fatalf("first write did not reach mock draft/add: %+v", result)
			case <-time.After(10 * time.Second):
				t.Fatal("first write did not reach mock draft/add")
			}
			tx, err := env.srv.db.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			_, err = tx.Exec(ctx, `SELECT id FROM work WHERE id=$1 FOR UPDATE NOWAIT`, wk.ID)
			_ = tx.Rollback(ctx)
			if err != nil {
				t.Fatalf("network call retains work row lock: %v", err)
			}
			second := send()
			select {
			case result := <-second:
				if result.err != nil || result.status != 409 || !strings.Contains(result.body, "wechat_push_running") || !strings.Contains(result.body, "正在写入，请稍候") {
					t.Fatalf("second write: %+v", result)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("second write did not reject while first was running")
			}
			unblock.Do(func() { close(release) })
			result := <-first
			if result.err != nil || result.status != 200 || !strings.Contains(result.body, "event: done") || strings.Contains(result.body, "event: error") {
				t.Fatalf("first write: %+v", result)
			}
			var total, ok, mediaIDs int
			if err := env.srv.db.QueryRow(ctx, `SELECT count(*), count(*) FILTER (WHERE status='ok'), count(DISTINCT draft_media_id) FROM push_record WHERE work_id=$1`, wk.ID).Scan(&total, &ok, &mediaIDs); err != nil {
				t.Fatal(err)
			}
			after, err := env.srv.todayPushCount(ctx, a.ID)
			if err != nil || adds.Load() != 1 || total != 1 || ok != 1 || mediaIDs != 1 || after != before+1 {
				t.Fatalf("adds=%d records=%d ok=%d mediaIDs=%d count=%d->%d err=%v", adds.Load(), total, ok, mediaIDs, before, after, err)
			}
			var latest Work
			env.mustJSON(t, "GET", "/api/v1/works/"+wk.ID.String(), nil, &latest)
			m := &workMeta{ID: wk.ID, Account: &a}
			record, err := env.srv.reserveWechatPush(ctx, m, &wk, pushInput{Revision: latest.Revision, ConfirmOverLimit: true}, "update")
			if err != nil {
				t.Fatal(err)
			}
			if wk.WechatDraftMediaID == nil || latest.WechatDraftMediaID == nil || *wk.WechatDraftMediaID != *latest.WechatDraftMediaID {
				t.Fatal("stale snapshot did not reload the completed draft ID")
			}
			if _, err := env.srv.db.Exec(ctx, `DELETE FROM push_record WHERE id=$1`, record.ID); err != nil {
				t.Fatal(err)
			}
			t.Logf("%s: mock draft/add=1, unique media_id=1, successful records=1, daily count +1; network wait holds no work row lock", format)
		})
	}
}

func TestOPT06ReservationExpiryAndHumanChecks(t *testing.T) {
	a, wk := buildCardWork(t, "wechat_mp")
	env.confirmChecks(t, wk.ID.String())
	env.mustJSON(t, "GET", "/api/v1/works/"+wk.ID.String(), nil, &wk)
	ctx := context.Background()
	m := &workMeta{ID: wk.ID, Account: &a}
	in := pushInput{Revision: wk.Revision}
	checkError := func(err error, code string) {
		t.Helper()
		var ae *APIError
		if !errors.As(err, &ae) || ae.Code != code {
			t.Fatalf("want %s, got %v", code, err)
		}
	}
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO push_record(work_id,account_id,action,status,created_at) VALUES($1,$2,'newspic','running',$3)`, wk.ID, a.ID, env.srv.now().Add(-10*time.Minute-time.Second)); err != nil {
		t.Fatal(err)
	}
	record, err := env.srv.reserveWechatPush(ctx, m, &wk, in, "newspic")
	if err != nil {
		t.Fatalf("expired running record blocks retry: %v", err)
	}
	_, err = env.srv.reserveWechatPush(ctx, m, &wk, in, "newspic")
	checkError(err, "wechat_push_running")
	if _, err := env.srv.db.Exec(ctx, `UPDATE push_record SET status='failed' WHERE id=$1`, record.ID); err != nil {
		t.Fatal(err)
	}
	for _, status := range []string{"drafting", "reviewing"} {
		if _, err := env.srv.db.Exec(ctx, `UPDATE work SET status=$2 WHERE id=$1`, wk.ID, status); err != nil {
			t.Fatal(err)
		}
		_, err := env.srv.reserveWechatPush(ctx, m, &wk, in, "newspic")
		checkError(err, "human_step_required")
	}
	if _, err := env.srv.db.Exec(ctx, `UPDATE work SET status='ready',revision=revision+1 WHERE id=$1`, wk.ID); err != nil {
		t.Fatal(err)
	}
	_, err = env.srv.reserveWechatPush(ctx, m, &wk, in, "newspic")
	checkError(err, "state_invalid")
	in.Revision++
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO push_record(work_id,account_id,action,status) SELECT $1,$2,'newspic','ok' FROM generate_series(1,$3)`, wk.ID, a.ID, a.DailyPushLimit); err != nil {
		t.Fatal(err)
	}
	_, err = env.srv.reserveWechatPush(ctx, m, &wk, in, "newspic")
	checkError(err, "push_limit_reached")
	in.ConfirmOverLimit = true
	record, err = env.srv.reserveWechatPush(ctx, m, &wk, in, "newspic")
	if err != nil || !record.OverLimit || record.Count != a.DailyPushLimit {
		t.Fatalf("explicit over-limit confirmation: %+v %v", record, err)
	}
	if _, err := env.srv.db.Exec(ctx, `UPDATE push_record SET status='failed' WHERE id=$1`, record.ID); err != nil {
		t.Fatal(err)
	}
}
