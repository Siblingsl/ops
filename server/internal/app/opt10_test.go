package app

import (
	"context"
	"encoding/json"
	"io"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestOPT10SummarySizeDetailsAndScope(t *testing.T) {
	guest := env.registerClient(t, "opt10-"+uuid.NewString()[:8], testPassword)
	t.Cleanup(func() { guest.restore(env) })
	a, _ := v4Account(t, "素材摘要验收")
	b, _ := v4Account(t, "其他账号")
	ctx := v4Context(t, a)
	ws := ident(ctx).WorkspaceID
	rows, err := env.srv.db.Query(ctx, `INSERT INTO material(workspace_id,account_id,kind,content)
		SELECT $1,$2,'experience',repeat('中',2400)||'尾标'||i FROM generate_series(1,200) i RETURNING id`, ws, a.ID)
	if err != nil {
		t.Fatal(err)
	}
	var ids []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil || len(ids) != 200 {
		t.Fatalf("seed rows=%d %v", len(ids), err)
	}
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := env.srv.db.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`UPDATE material SET account_id=NULL WHERE id=$1`, ids[0])
	exec(`INSERT INTO material(workspace_id,account_id,kind,content) VALUES($1,$2,'case','另一账号原文')`, ws, b.ID)
	path := "/api/v1/materials?account_id=" + a.ID.String()
	resp := env.request("GET", path, nil, "")
	body, err := io.ReadAll(resp.Body)
	resp.Body.Close()
	if err != nil || resp.StatusCode != 200 || len(body) >= 100*1024 {
		t.Fatalf("JSON bytes=%d status=%d %v", len(body), resp.StatusCode, err)
	}
	var list []materialPreview
	if err := json.Unmarshal(body, &list); err != nil || len(list) != 200 {
		t.Fatalf("list rows=%d %v", len(list), err)
	}
	shared := 0
	for _, m := range list {
		if m.Content != strings.Repeat("中", 120) || m.Tags == nil {
			t.Fatalf("summary/metadata: %+v", m)
		}
		if m.Shared {
			shared++
		}
	}
	if shared != 1 || strings.Contains(string(body), "尾标") || strings.Contains(string(body), "account_id") {
		t.Fatal("list leaked full content or lost shared metadata")
	}
	t.Logf("200 materials, each 2400 Chinese characters plus a distinct suffix, empty optional metadata, 1 shared: uncompressed JSON=%d bytes (<102400), each summary=120 characters", len(body))
	var full Material
	env.mustJSON(t, "GET", "/api/v1/materials/"+ids[0].String(), nil, &full)
	if full.Content != strings.Repeat("中", 2400)+"尾标1" || full.AccountID != nil {
		t.Fatal("shared detail lost full content/scope")
	}
	var found []materialPreview
	env.mustJSON(t, "GET", path+"&q=尾标200", nil, &found)
	if len(found) != 1 || found[0].Content != strings.Repeat("中", 120) {
		t.Fatal("search no longer uses full stored content")
	}
	exec(`UPDATE material SET source='完整出处',tags=ARRAY['测试'],valid_until=$2::date WHERE id=$1`, ids[1], env.srv.today().AddDate(0, 0, -1))
	env.mustJSON(t, "GET", path+"&usage=expired", nil, &found)
	if len(found) != 1 || !found[0].Expired || found[0].Source != "完整出处" || len(found[0].Tags) != 1 || found[0].ValidUntil == nil {
		t.Fatalf("nonempty metadata lost: %+v", found)
	}
	exec(`UPDATE material SET deleted_at=now() WHERE id=$1`, ids[1])
	env.expectErr(t, "GET", "/api/v1/materials/"+ids[1].String(), nil, "not_found")
	otherWS := opt12Workspace(t)
	var foreign uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(), `INSERT INTO material(workspace_id,kind,content) VALUES($1,'opinion','其他工作区不可读') RETURNING id`, otherWS).Scan(&foreign); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := env.srv.db.Exec(context.Background(), `DELETE FROM material WHERE id=$1`, foreign); err != nil {
			t.Error(err)
		}
	})
	env.expectErr(t, "GET", "/api/v1/materials/"+foreign.String(), nil, "not_found")
}
