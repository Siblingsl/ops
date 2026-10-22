package app

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestOPT35MaterialsExpireAtShanghaiMidnight(t *testing.T) {
	oldNow := env.srv.now
	t.Cleanup(func() { env.srv.now = oldNow })
	env.srv.now = func() time.Time {
		return time.Date(2030, 1, 2, 0, 30, 0, 0, env.srv.loc)
	}
	guest := env.registerClient(t, "opt35-midnight-"+uuid.NewString(), testPassword)
	t.Cleanup(func() { guest.restore(env) })
	var a Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{
		"platform": "wechat_mp", "name": "午夜素材验证", "content_format": "long_article",
	}, &a)
	for _, tc := range []struct {
		content string
		until   string
		expired bool
	}{
		{"OPT35 昨天到期", "2030-01-01", true},
		{"OPT35 今天到期", "2030-01-02", false},
		{"OPT35 无有效期", "", false},
	} {
		var created Material
		env.mustJSON(t, "POST", "/api/v1/materials", map[string]any{
			"account_id": a.ID, "kind": "data", "content": tc.content, "source": "午夜验证", "tags": []string{"OPT35"}, "valid_until": tc.until,
		}, &created)
		if created.Expired != tc.expired {
			t.Fatalf("create %s: expired=%v want=%v", tc.content, created.Expired, tc.expired)
		}
	}
	path := "/api/v1/materials?account_id=" + a.ID.String() + "&scope=account&q=OPT35"
	var items []Material
	env.mustJSON(t, "GET", path, nil, &items)
	if len(items) != 3 {
		t.Fatalf("material list: %+v", items)
	}
	for _, item := range items {
		if item.Expired != (item.Content == "OPT35 昨天到期") {
			t.Fatalf("midnight expiry: %+v", item)
		}
	}
	env.mustJSON(t, "GET", path+"&usage=expired", nil, &items)
	if len(items) != 1 || items[0].Content != "OPT35 昨天到期" || !items[0].Expired {
		t.Fatalf("expired filter: %+v", items)
	}
}

func TestOPT35ConnectionUsesShanghaiDate(t *testing.T) {
	var date string
	ctx := context.Background()
	if err := env.srv.db.QueryRow(ctx, `SELECT to_char($1::timestamptz::date,'YYYY-MM-DD')`, "2030-01-01T16:30:00Z").Scan(&date); err != nil {
		t.Fatal(err)
	}
	if date != "2030-01-02" {
		t.Fatalf("Shanghai 00:30 date=%s", date)
	}
}
