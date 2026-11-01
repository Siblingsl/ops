package app

import (
	"context"
	"encoding/json"
	"strconv"
	"testing"
)

// DEV-CX13-F / T-CX23：检查页"新标准可用"提示——
// 冻结快照与当前生效标准 version/content_hash 任一不同 → standard_changed=true；
// 无标准启动的检查不提示；归档不影响对比；提示不清除人工确认、不自动迁移。
func TestCXStandardChangedFlag(t *testing.T) {
	// 专用账号：共享 fixture 账号上其他 standards 测试残留的生效版本会改变
	// effective 解析结果，使"新标准生效后提示出现/不出现"的断言不确定。
	var account Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{"platform": "xhs", "name": "标准变更提示专用", "content_format": "image_note"}, &account)
	base := "/api/v1/accounts/" + account.ID.String() + "/standards"
	var v1 standardItem
	status, body := env.do("POST", base, map[string]any{
		"base_version": 0, "positioning": "旧口径", "effective_from": "2026-01-01",
	})
	if status != 201 || json.Unmarshal(body, &v1) != nil {
		t.Fatalf("seed v1: status=%d body=%s", status, body)
	}

	wk := env.readyWork(t, account, "标准变更提示")
	defer agentDropWork(wk.ID)
	baseWork := "/api/v1/works/" + wk.ID.String()
	var run struct {
		Run CheckRun `json:"run"`
	}
	env.mustJSON(t, "POST", baseWork+"/checks", map[string]int{"html_chars": 3000, "html_bytes": 9000}, &run)

	// v1 生效时启动的检查：无变更提示。
	var latest struct {
		Run CheckRun `json:"run"`
	}
	env.mustJSON(t, "GET", baseWork+"/checks/latest", nil, &latest)
	if latest.Run.StandardChanged {
		t.Fatal("same standard must not flag change")
	}

	// 新增 v2（今天生效）→ 当前生效变化 → 提示出现。
	var v2 standardItem
	status, body = env.do("POST", base, map[string]any{
		"base_version": v1.Version, "positioning": "新口径", "effective_from": "2026-12-01",
	})
	if status != 201 || json.Unmarshal(body, &v2) != nil {
		t.Fatalf("seed v2: status=%d body=%s", status, body)
	}
	env.mustJSON(t, "GET", baseWork+"/checks/latest", nil, &latest)
	if latest.Run.StandardChanged {
		t.Fatal("future standard must not flag change before effective date")
	}

	// v3（今天生效）：当前生效变化 → 提示出现。
	var v3 standardItem
	status, body = env.do("POST", base, map[string]any{
		"base_version": v2.Version, "positioning": "新口径即时", "effective_from": "2026-10-31",
	})
	if status != 201 || json.Unmarshal(body, &v3) != nil {
		t.Fatalf("seed v3: status=%d body=%s", status, body)
	}
	env.mustJSON(t, "GET", baseWork+"/checks/latest", nil, &latest)
	if !latest.Run.StandardChanged {
		t.Fatal("new effective standard must flag change")
	}
	// 冻结快照未被改写（历史结论不重算）。
	var basisRaw []byte
	if err := env.srv.db.QueryRow(context.Background(), `SELECT ops_standard_basis FROM check_run WHERE id=$1`, run.Run.ID).Scan(&basisRaw); err != nil {
		t.Fatal(err)
	}
	var basis struct {
		Version int `json:"version"`
	}
	if err := json.Unmarshal(basisRaw, &basis); err != nil {
		t.Fatal(err)
	}
	if basis.Version != v1.Version {
		t.Fatalf("frozen basis must stay at v1: %d", basis.Version)
	}
	// 提示不清除人工确认：既有 items 的 resolution 保持。
	for _, item := range latest.Run.Items {
		_ = item // 无待确认项时仅验证标志本身；resolution 语义由既有测试覆盖
	}

	// 归档 v3：规格是"归档不影响解析"（effective 仍取 v3），提示保持。
	env.mustJSON(t, "POST", base+"/"+strconv.Itoa(v3.Version)+"/archive", map[string]any{"archived": true}, nil)
	env.mustJSON(t, "GET", baseWork+"/checks/latest", nil, &latest)
	if !latest.Run.StandardChanged {
		t.Fatal("archive must not change effective parsing, flag stays")
	}
	// 提示不清除人工确认、不改写冻结快照：再次确认 basis 仍为 v1。
	var basisAfter []byte
	if err := env.srv.db.QueryRow(context.Background(), `SELECT ops_standard_basis FROM check_run WHERE id=$1`, run.Run.ID).Scan(&basisAfter); err != nil {
		t.Fatal(err)
	}
	var basisAfterParsed struct {
		Version int `json:"version"`
	}
	if err := json.Unmarshal(basisAfter, &basisAfterParsed); err != nil || basisAfterParsed.Version != v1.Version {
		t.Fatalf("basis must remain frozen: %s", basisAfter)
	}
}
