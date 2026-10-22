package app

// 第二轮 P0（TP-01 / XC-04 相关）：收件箱丢掉可撤销。

import (
	"context"
	"testing"

	"github.com/google/uuid"
)

func TestInboxDismissCanBeRestored(t *testing.T) {
	f := env.accounts(t)
	var item struct {
		ID string `json:"id"`
	}
	env.mustJSON(t, "POST", "/api/v1/inbox", map[string]any{"content": "丢掉再撤销", "account_id": f.wechat.ID}, &item)

	env.mustJSON(t, "DELETE", "/api/v1/inbox/"+item.ID, nil, nil)
	var status string
	if err := env.srv.db.QueryRow(context.Background(), `SELECT status FROM inbox_item WHERE id=$1`, item.ID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "dismissed" {
		t.Fatalf("status after dismiss = %s, want dismissed", status)
	}

	env.mustJSON(t, "POST", "/api/v1/inbox/"+item.ID+"/restore", nil, nil)
	if err := env.srv.db.QueryRow(context.Background(), `SELECT status FROM inbox_item WHERE id=$1`, item.ID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "new" {
		t.Fatalf("status after restore = %s, want new", status)
	}
	// 撤销后重新出现在列表里。
	var page struct {
		Items []map[string]any `json:"items"`
	}
	env.mustJSON(t, "GET", "/api/v1/inbox", nil, &page)
	for _, it := range page.Items {
		if it["id"] == item.ID {
			return
		}
	}
	t.Fatal("restored inbox item should be listed again")
}

func TestInboxRestoreRejectsUnknownItem(t *testing.T) {
	env.accounts(t)
	env.expectErr(t, "POST", "/api/v1/inbox/"+uuid.NewString()+"/restore", nil, "not_found")
}
