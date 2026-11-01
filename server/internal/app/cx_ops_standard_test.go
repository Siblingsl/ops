package app

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

// DEV-CX13-F / FR-CX-23 / T-CX23：运营标准——
// 版本 CAS、同日/同版本 409、历史 405（不可修改）、时区 at 查询、未来版不提前应用、
// 归档不影响历史 check_run 解析、软规则不覆盖 format 硬限制、无两套真源。
type standardItem struct {
	Version       int    `json:"version"`
	Positioning   string `json:"positioning"`
	EffectiveFrom string `json:"effective_from"`
	ContentHash   string `json:"content_hash"`
	ArchivedAt    *string `json:"archived_at"`
}

func TestCXOpsStandardVersionsAndEffectiveQuery(t *testing.T) {
	account := env.accounts(t).xhs
	base := "/api/v1/accounts/" + account.ID.String() + "/standards"

	// owner 创建 v1（10-01 生效）。
	var v1 standardItem
	status, body := env.do("POST", base, map[string]any{
		"base_version": 0, "positioning": "只写真实经历", "effective_from": "2026-10-01",
		"text_rules": []map[string]string{{"text": "正文尽量给可执行步骤"}},
		"visual_rules": map[string]any{"preferred_ratio": "3:4", "min_images_hint": 2, "dna_version": nil},
	})
	if status != 201 || json.Unmarshal(body, &v1) != nil {
		t.Fatalf("create v1: status=%d body=%s", status, body)
	}
	if v1.Version != 1 || v1.ContentHash == "" {
		t.Fatalf("v1 shape: %+v", v1)
	}

	// base_version CAS：陈旧 base 409。
	status, body = env.do("POST", base, map[string]any{"base_version": 0, "positioning": "并发", "effective_from": "2026-12-01"})
	if status != 409 || !strings.Contains(string(body), "version_conflict") {
		t.Fatalf("stale base_version must 409: %d %s", status, body)
	}
	// 同 effective_from 并发冲突 409。
	status, _ = env.do("POST", base, map[string]any{"base_version": 1, "positioning": "同日", "effective_from": "2026-10-01"})
	if status != 409 {
		t.Fatalf("same-day conflict must 409: %d", status)
	}
	// 未来版 v2（11-01 生效）。
	var v2 standardItem
	status, body = env.do("POST", base, map[string]any{"base_version": 1, "positioning": "下月启用", "effective_from": "2026-11-01"})
	if status != 201 || json.Unmarshal(body, &v2) != nil {
		t.Fatalf("create v2: status=%d body=%s", status, body)
	}

	// at 查询：10-15 取 v1；11-15 取 v2；09-15 无标准。
	status, body = env.do("GET", base+"/effective?at=2026-10-15", nil)
	var oct struct {
		Standard *standardItem `json:"standard"`
	}
	_ = json.Unmarshal(body, &oct)
	if status != 200 || oct.Standard == nil || oct.Standard.Version != 1 {
		t.Fatalf("at 2026-10-15 must resolve v1: status=%d body=%s", status, body)
	}
	status, body = env.do("GET", base+"/effective?at=2026-11-15", nil)
	var nov struct {
		Standard *standardItem `json:"standard"`
	}
	_ = json.Unmarshal(body, &nov)
	if status != 200 || nov.Standard == nil || nov.Standard.Version != 2 {
		t.Fatalf("at 2026-11-15 must resolve v2: status=%d body=%s", status, body)
	}
	status, body = env.do("GET", base+"/effective?at=2026-09-15", nil)
	var none struct {
		Standard *standardItem `json:"standard"`
	}
	_ = json.Unmarshal(body, &none)
	if status != 200 || none.Standard != nil {
		t.Fatalf("no standard must return null: status=%d body=%s", status, body)
	}

	// 历史 405：标准不可修改/删除。
	status, _ = env.do("PATCH", base+"/1", map[string]any{"positioning": "改历史"})
	if status != 405 {
		t.Fatalf("history PATCH must 405: %d", status)
	}
	status, _ = env.do("DELETE", base+"/1", nil)
	if status != 405 {
		t.Fatalf("history DELETE must 405: %d", status)
	}

	// 归档 v1（只变列表可见性）；归档后 effective 历史解析不受影响。
	status, _ = env.do("POST", base+"/1/archive", map[string]any{"archived": true})
	if status != 200 {
		t.Fatalf("archive: %d", status)
	}
	status, body = env.do("GET", base, nil)
	var list struct {
		Items []standardItem `json:"items"`
	}
	_ = json.Unmarshal(body, &list)
	for _, item := range list.Items {
		if item.Version == 1 {
			t.Fatal("archived standard must leave the visible list")
		}
	}
	status, body = env.do("GET", base+"/effective?at=2026-10-15", nil)
	_ = json.Unmarshal(body, &oct)
	if status != 200 || oct.Standard == nil || oct.Standard.Version != 1 {
		t.Fatalf("archived version must still resolve historically: status=%d body=%s", status, body)
	}
	// 归档版本历史内容可查（含 archived_at）。
	status, body = env.do("GET", base+"/1", nil)
	var history standardItem
	_ = json.Unmarshal(body, &history)
	if status != 200 || history.ArchivedAt == nil {
		t.Fatalf("archived history must be readable: status=%d body=%s", status, body)
	}

	// 非 owner 拒绝创建/归档。
	var workspaceID, userID string
	if err := env.srv.db.QueryRow(context.Background(), `SELECT workspace_id FROM platform_account WHERE id=$1`, account.ID).Scan(&workspaceID); err != nil {
		t.Fatal(err)
	}
	if err := env.srv.db.QueryRow(context.Background(), `SELECT user_id FROM workspace_member WHERE workspace_id=$1 AND role='owner' LIMIT 1`, workspaceID).Scan(&userID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(context.Background(), `UPDATE workspace_member SET role='editor' WHERE workspace_id=$1 AND user_id=$2`, workspaceID, userID); err != nil {
		t.Fatal(err)
	}
	status, _ = env.do("POST", base, map[string]any{"base_version": 2, "positioning": "编辑者", "effective_from": "2026-12-01"})
	if status != 403 {
		t.Fatalf("editor must not create standards: %d", status)
	}
	if _, err := env.srv.db.Exec(context.Background(), `UPDATE workspace_member SET role='owner' WHERE workspace_id=$1 AND user_id=$2`, workspaceID, userID); err != nil {
		t.Fatal(err)
	}
}

// 检查启动冻结标准快照；归档/变化不重算历史 run；软规则不覆盖 format 硬限制由既有 M9 流程保障。
func TestCXOpsStandardFrozenIntoCheckRun(t *testing.T) {
	// 独立账号避免共享 fixture 的历史标准干扰版本断言。
	var fresh Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{"platform": "xhs", "name": "标准冻结专用号", "content_format": "image_note"}, &fresh)
	account := fresh
	base := "/api/v1/accounts/" + account.ID.String() + "/standards"
	var v1 standardItem
	status, body := env.do("POST", base, map[string]any{
		"base_version": 0, "positioning": "冻结验收", "effective_from": "2026-01-01",
	})
	if status != 201 || json.Unmarshal(body, &v1) != nil {
		t.Fatalf("seed standard: status=%d body=%s", status, body)
	}
	wk := env.readyWork(t, account, "标准冻结验收")
	defer agentDropWork(wk.ID)
	baseWork := "/api/v1/works/" + wk.ID.String()
	var run struct {
		Run CheckRun `json:"run"`
	}
	env.mustJSON(t, "POST", baseWork+"/checks", map[string]int{"html_chars": 3000, "html_bytes": 9000}, &run)

	// check_run.ops_standard_basis 冻结了 version/content_hash。
	var basisRaw []byte
	if err := env.srv.db.QueryRow(context.Background(), `SELECT ops_standard_basis FROM check_run WHERE id=$1`, run.Run.ID).Scan(&basisRaw); err != nil {
		t.Fatal(err)
	}
	var basis struct {
		Version     int    `json:"version"`
		ContentHash string `json:"content_hash"`
	}
	if err := json.Unmarshal(basisRaw, &basis); err != nil {
		t.Fatalf("decode basis: %v body=%s", err, basisRaw)
	}
	if basis.Version != v1.Version || basis.ContentHash != v1.ContentHash {
		t.Fatalf("frozen basis must match v1: %+v vs %+v", basis, v1)
	}

	// 归档后历史 run 的快照不变。
	env.mustJSON(t, "POST", base+"/1/archive", map[string]any{"archived": true}, nil)
	var basisAfter []byte
	if err := env.srv.db.QueryRow(context.Background(), `SELECT ops_standard_basis FROM check_run WHERE id=$1`, run.Run.ID).Scan(&basisAfter); err != nil {
		t.Fatal(err)
	}
	if string(basisAfter) != string(basisRaw) {
		t.Fatal("archive must not rewrite historical check_run basis")
	}
}
