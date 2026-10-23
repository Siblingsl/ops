package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"testing"

	"github.com/google/uuid"
)

func TestPlatformSyncItemsStageStatePaginationAndScope(t *testing.T) {
	f := startSyncPipelineFixture(t)
	ctx := context.Background()
	var operationID uuid.UUID
	if err := env.srv.db.QueryRow(ctx, `SELECT id FROM platform_sync_operation WHERE account_id=$1`, f.Account.ID).Scan(&operationID); err != nil {
		t.Fatal(err)
	}
	for _, item := range []struct{ id, content, metrics string }{
		{"items-a", "failed", "complete"}, {"items-b", "complete", "failed"}, {"items-c", "not_requested", "not_started"},
	} {
		if _, err := env.srv.db.Exec(ctx, `INSERT INTO platform_work_mirror
			(workspace_id,account_id,platform,external_account_key,external_id,remote_content_type,title,
			content_state,initial_metrics_state,last_sync_operation_id,content_error_code,body_text)
			SELECT workspace_id,account_id,platform,external_account_key,$2,'image_note',$2,$3,$4,$5,
			CASE WHEN $3='failed' THEN 'content_size_exceeded' ELSE NULL END,'正文不应出现在明细接口'
			FROM platform_connection WHERE id=$1`, f.Connection, item.id, item.content, item.metrics, operationID); err != nil {
			t.Fatal(err)
		}
	}
	base := "/api/v1/accounts/" + f.Account.ID.String() + "/platform-sync-operations/" + operationID.String() + "/items"
	type item struct {
		ID      string  `json:"external_id"`
		Metrics string  `json:"initial_metrics_state"`
		Error   *string `json:"error_code"`
		Body    *string `json:"body_text"`
	}
	type page struct {
		Items []item  `json:"items"`
		Next  *string `json:"next_cursor"`
	}
	read := func(path string) page {
		t.Helper()
		status, response := env.do(http.MethodGet, path, nil)
		var result page
		if status != http.StatusOK {
			t.Fatalf("items: %d %s", status, response)
		}
		if err := json.Unmarshal(response, &result); err != nil {
			t.Fatal(err)
		}
		for _, row := range result.Items {
			if row.Body != nil {
				t.Fatal("items leaked full body")
			}
		}
		return result
	}
	content := read(base + "?state=failed")
	if len(content.Items) != 1 || content.Items[0].ID != "items-a" || content.Items[0].Metrics != "complete" || content.Items[0].Error == nil {
		t.Fatalf("default content stage: %+v", content)
	}
	metrics := read(base + "?stage=metrics&state=failed")
	if len(metrics.Items) != 1 || metrics.Items[0].ID != "items-b" || metrics.Items[0].Metrics != "failed" {
		t.Fatalf("metrics must filter its own state: %+v", metrics)
	}
	if pending := read(base + "?stage=metrics&state=not_started"); len(pending.Items) != 1 || pending.Items[0].ID != "items-c" {
		t.Fatalf("metrics pending: %+v", pending)
	}
	seen := map[string]bool{}
	path := base + "?limit=1"
	for n := 0; n < 3; n++ {
		result := read(path)
		if len(result.Items) != 1 || seen[result.Items[0].ID] {
			t.Fatalf("pagination duplicate or missing: %+v", result)
		}
		seen[result.Items[0].ID] = true
		if n < 2 {
			if result.Next == nil {
				t.Fatal("missing cursor")
			}
			path = base + "?limit=1&cursor=" + url.QueryEscape(*result.Next)
		} else if result.Next != nil {
			t.Fatal("unexpected final cursor")
		}
	}
	for _, query := range []string{"?stage=catalog", "?stage=metrics&state=not_requested", "?stage=content&state=not_started", "?limit=101", "?cursor=invalid"} {
		status, response := env.do(http.MethodGet, base+query, nil)
		if status != http.StatusUnprocessableEntity {
			t.Fatalf("invalid filter %s: %d %s", query, status, response)
		}
	}
	other := platformTestAccount(t, "xhs", "另一账号明细隔离")
	status, response := env.do(http.MethodGet, "/api/v1/accounts/"+other.ID.String()+"/platform-sync-operations/"+operationID.String()+"/items", nil)
	if status != http.StatusNotFound {
		t.Fatalf("cross-account operation: %d %s", status, response)
	}
	// 镜像后续归入另一操作后，旧操作不再宣称该行仍属于自己的当前明细。
	if _, err := env.srv.db.Exec(ctx, `UPDATE platform_work_mirror SET last_sync_operation_id=NULL WHERE account_id=$1`, f.Account.ID); err != nil {
		t.Fatal(err)
	}
	if result := read(base); len(result.Items) != 0 {
		t.Fatalf("stale membership: %+v", result)
	}
}
