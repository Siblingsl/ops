package app

import (
	"encoding/json"
	"strings"
	"testing"
)

// DEV-CX12 / FR-CX-18 / T-CX14/18：对标账号库 API 行为——
// 额度 409、URL 查重 409、四问 fit_score 投影（yes=25/no=0、unknown 不算 no、不足 4 问为 NULL）、
// CAS 冲突、归档恢复、viewer 拒绝、列表只读不改行。
type benchmarkTargetResponse struct {
	ID            string           `json:"id"`
	AccountID     string           `json:"account_id"`
	Platform      string           `json:"platform"`
	Name          string           `json:"name"`
	URL           string           `json:"url"`
	NormalizedURL string           `json:"normalized_url"`
	Answers       map[string]struct {
		Answer string `json:"answer"`
		Reason string `json:"reason"`
	} `json:"answers"`
	FitScore      *int   `json:"fit_score"`
	AnsweredCount int    `json:"answered_count"`
	WeakFit       bool   `json:"weak_fit"`
	Status        string `json:"status"`
	Revision      int    `json:"revision"`
}

func benchmarkPath(accountID string) string { return "/api/v1/accounts/" + accountID + "/benchmarks" }

func TestCXBenchmarkTargetCRUDCASAndFitScoreProjection(t *testing.T) {
	account := env.accounts(t).xhs
	path := benchmarkPath(account.ID.String())

	// 创建：URL 规范化去 fragment 与默认端口。
	var created benchmarkTargetResponse
	status, body := env.do("POST", path, map[string]any{
		"platform": "xhs", "name": "对标甲", "url": "https://www.xiaohongshu.com:443/user/fit/example#frag",
	})
	if status != 201 || json.Unmarshal(body, &created) != nil {
		t.Fatalf("create benchmark: status=%d body=%s", status, body)
	}
	if created.NormalizedURL != "https://www.xiaohongshu.com/user/fit/example" {
		t.Fatalf("URL normalization must strip default port and fragment: %s", created.NormalizedURL)
	}
	if created.Status != "candidate" || created.FitScore != nil || created.Revision != 1 {
		t.Fatalf("new target must be candidate with no synthetic score: %+v", created)
	}

	// URL 查重：同账号同平台同 normalized_url 409。
	status, body = env.do("POST", path, map[string]any{
		"platform": "xhs", "name": "对标乙", "url": "https://www.xiaohongshu.com/user/fit/other#x",
	})
	if status != 201 {
		t.Fatalf("second distinct URL must pass: status=%d body=%s", status, body)
	}
	var second benchmarkTargetResponse
	_ = json.Unmarshal(body, &second)
	status, body = env.do("POST", path, map[string]any{
		"platform": "xhs", "name": "重复URL", "url": "https://www.xiaohongshu.com/user/fit/example?other=1",
	})
	var errBody struct {
		Error struct{ Code string `json:"code"` } `json:"error"`
	}
	_ = json.Unmarshal(body, &errBody)
	// 不同查询参数视为不同 URL（不得去掉可能识别内容的查询参数）。
	if status == 409 {
		t.Fatalf("distinct query strings must not collide: %d %s", status, body)
	}
	// 完全相同的 normalized URL 才冲突。
	var third benchmarkTargetResponse
	if status == 201 {
		_ = json.Unmarshal(body, &third)
		env.do("PATCH", "/api/v1/benchmarks/"+third.ID, map[string]any{"base_revision": third.Revision, "archived": true})
	}
	status, body = env.do("POST", path, map[string]any{"platform": "xhs", "name": "真重复", "url": "https://WWW.XIAOHONGSHU.com/user/fit/example"})
	if status != 409 || !strings.Contains(string(body), "benchmark_exists") {
		t.Fatalf("same host/path different case must still normalize-collide: status=%d body=%s", status, body)
	}
	_ = errBody

	// 四问：25/0/25/0=50 且 weak_fit。
	answers := map[string]any{
		"sustainable":      map[string]string{"answer": "yes", "reason": "内容方向可长期持续更新"},
		"beyond_single":    map[string]string{"answer": "no", "reason": "效果依赖单篇爆款"},
		"audience_match":   map[string]string{"answer": "yes", "reason": "读者与我方定位一致"},
		"material_support": map[string]string{"answer": "no", "reason": "我方材料暂不支持该形式"},
	}
	status, body = env.do("PATCH", "/api/v1/benchmarks/"+created.ID, map[string]any{"base_revision": created.Revision, "answers": answers})
	if status != 200 {
		t.Fatalf("answer four questions: status=%d body=%s", status, body)
	}
	var answered benchmarkTargetResponse
	_ = json.Unmarshal(body, &answered)
	if answered.FitScore == nil || *answered.FitScore != 50 {
		t.Fatalf("25+0+25+0 must project to 50: %+v", answered.FitScore)
	}
	if !answered.WeakFit {
		t.Fatal("fit_score=50 must flag weak_fit")
	}
	if answered.AnsweredCount != 4 {
		t.Fatalf("answered_count: %d", answered.AnsweredCount)
	}

	// unknown 不算 no：替换一问为 unknown 后 answered_count=3、fit_score 回到 NULL。
	partial := map[string]any{
		"sustainable":      map[string]string{"answer": "yes", "reason": "内容方向可长期持续更新"},
		"beyond_single":    map[string]string{"answer": "no", "reason": "效果依赖单篇爆款"},
		"audience_match":   map[string]string{"answer": "unknown", "reason": ""},
		"material_support": map[string]string{"answer": "no", "reason": "我方材料暂不支持该形式"},
	}
	status, body = env.do("PATCH", "/api/v1/benchmarks/"+created.ID, map[string]any{"base_revision": answered.Revision, "answers": partial})
	if status != 200 {
		t.Fatalf("set unknown answer: status=%d body=%s", status, body)
	}
	var partial3 benchmarkTargetResponse
	_ = json.Unmarshal(body, &partial3)
	if partial3.FitScore != nil || partial3.AnsweredCount != 3 {
		t.Fatalf("3 answers must yield NULL score: fit=%v count=%d", partial3.FitScore, partial3.AnsweredCount)
	}

	// yes 缺理由拒绝。
	badReason := map[string]any{
		"sustainable":      map[string]string{"answer": "yes", "reason": ""},
		"beyond_single":    map[string]string{"answer": "no", "reason": "x"},
		"audience_match":   map[string]string{"answer": "yes", "reason": "y"},
		"material_support": map[string]string{"answer": "no", "reason": "z"},
	}
	status, _ = env.do("PATCH", "/api/v1/benchmarks/"+created.ID, map[string]any{"base_revision": partial3.Revision, "answers": badReason})
	if status != 422 {
		t.Fatalf("yes without reason must be rejected: status=%d", status)
	}

	// CAS 冲突。
	status, body = env.do("PATCH", "/api/v1/benchmarks/"+created.ID, map[string]any{"base_revision": 1, "name": "过期改名"})
	if status != 409 || !strings.Contains(string(body), "version_conflict") {
		t.Fatalf("stale base_revision must 409: status=%d body=%s", status, body)
	}

	// 归档后列表不再返回；详情仍可读（历史不丢）。
	status, _ = env.do("PATCH", "/api/v1/benchmarks/"+created.ID, map[string]any{"base_revision": partial3.Revision, "archived": true})
	if status != 200 {
		t.Fatalf("archive: status=%d", status)
	}
	status, _ = env.do("GET", path+"?status=candidate", nil)
	var list struct {
		Items []benchmarkTargetResponse `json:"items"`
	}
	env.do("GET", path, nil)
	status, body = env.do("GET", path, nil)
	_ = status
	if strings.Contains(string(body), `"id":"`+created.ID+`"`) {
		t.Fatal("archived target must not appear in the active list")
	}
	status, _ = env.do("GET", "/api/v1/benchmarks/"+created.ID, nil)
	if status != 200 {
		t.Fatalf("archived detail must remain readable: status=%d", status)
	}
	_ = list

	// viewer 拒绝写入：临时把当前成员降级为 viewer，断言后恢复 owner（沿用既有测试模式）。
	var workspaceID, userID string
	if err := env.srv.db.QueryRow(t.Context(), `SELECT workspace_id FROM platform_account WHERE id=$1`, account.ID).Scan(&workspaceID); err != nil {
		t.Fatal(err)
	}
	if err := env.srv.db.QueryRow(t.Context(), `SELECT user_id FROM workspace_member WHERE workspace_id=$1 AND role='owner' LIMIT 1`, workspaceID).Scan(&userID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(t.Context(), `UPDATE workspace_member SET role='viewer' WHERE workspace_id=$1 AND user_id=$2`, workspaceID, userID); err != nil {
		t.Fatal(err)
	}
	status, _ = env.do("POST", path, map[string]any{"platform": "xhs", "name": "观察者"})
	if status != 403 {
		t.Fatalf("viewer must not create targets: status=%d", status)
	}
	status, _ = env.do("PATCH", "/api/v1/benchmarks/"+second.ID, map[string]any{"base_revision": second.Revision, "name": "观察者改"})
	if status != 403 {
		t.Fatalf("viewer must not patch targets: status=%d", status)
	}
	if _, err := env.srv.db.Exec(t.Context(), `UPDATE workspace_member SET role='owner' WHERE workspace_id=$1 AND user_id=$2`, workspaceID, userID); err != nil {
		t.Fatalf("恢复集成测试共享成员角色失败：%v", err)
	}

	// GET 列表零写入：连查两次行数一致。
	var rowCount int
	if err := env.srv.db.QueryRow(t.Context(), `SELECT count(*) FROM benchmark_target WHERE account_id=$1`, account.ID).Scan(&rowCount); err != nil {
		t.Fatal(err)
	}
	env.do("GET", path, nil)
	var rowCountAgain int
	if err := env.srv.db.QueryRow(t.Context(), `SELECT count(*) FROM benchmark_target WHERE account_id=$1`, account.ID).Scan(&rowCountAgain); err != nil {
		t.Fatal(err)
	}
	if rowCount != rowCountAgain {
		t.Fatalf("GET must not write rows: %d -> %d", rowCount, rowCountAgain)
	}
}

func TestCXBenchmarkNoteQuotaDuplicateURLAndCAS(t *testing.T) {
	account := env.accounts(t).xhs
	var created benchmarkTargetResponse
	status, body := env.do("POST", benchmarkPath(account.ID.String()), map[string]any{"platform": "xhs", "name": "笔记库目标"})
	if status != 201 {
		t.Fatalf("create target: status=%d body=%s", status, body)
	}
	_ = json.Unmarshal(body, &created)
	notesPath := "/api/v1/benchmarks/" + created.ID + "/notes"

	structure := map[string]any{"hook_type": "question", "hook_gist": "为什么坚持不下来", "sections": []any{}, "cta_type": "none", "rhythm": map[string]any{"paragraphs": 5, "avg_chars": 80}}
	var note benchmarkTargetResponse
	type noteResponse = map[string]any
	var first noteResponse
	status, body = env.do("POST", notesPath, map[string]any{
		"url": "https://www.xiaohongshu.com/explore/abc#top", "title": "拆解一",
		"structure": structure, "structure_hash": "ignored",
		"metrics_snapshot": map[string]any{"likes": 120, "comments": nil, "captured_at": "2026-10-31"},
		"takeaways":        []string{"钩子先给冲突"}, "not_borrowable": []string{"虚构数据"},
	})
	if status != 201 || json.Unmarshal(body, &first) != nil {
		t.Fatalf("create note: status=%d body=%s", status, body)
	}
	if first["structure_hash"] == nil || first["structure_hash"] == "" {
		t.Fatal("server must compute structure_hash itself")
	}

	// 同 URL 重复 409。
	status, _ = env.do("POST", notesPath, map[string]any{"url": "https://www.xiaohongshu.com/explore/abc", "title": "重复", "structure": structure})
	if status != 409 {
		t.Fatalf("duplicate note URL must 409: status=%d", status)
	}
	// 无 URL 允许多条。
	status, _ = env.do("POST", notesPath, map[string]any{"title": "无URL笔记", "structure": structure})
	if status != 201 {
		t.Fatalf("empty-URL note must be allowed: status=%d", status)
	}

	// notes CAS：只改手填字段；structure 不变。
	noteID := first["id"].(string)
	revision := int(first["revision"].(float64))
	status, body = env.do("PATCH", "/api/v1/benchmark-notes/"+noteID, map[string]any{
		"base_revision": revision, "takeaways": []string{"改为：钩子先立场景"}, "archived": false,
	})
	if status != 200 {
		t.Fatalf("patch note: status=%d body=%s", status, body)
	}
	var patched map[string]any
	_ = json.Unmarshal(body, &patched)
	if patched["structure_hash"] != first["structure_hash"] {
		t.Fatal("structure_hash must not change via the manual-note patch")
	}
	status, _ = env.do("PATCH", "/api/v1/benchmark-notes/"+noteID, map[string]any{"base_revision": revision, "title": "过期"})
	if status != 409 {
		t.Fatalf("stale note revision must 409: status=%d", status)
	}

	// 额度：把该 target 的未归档笔记灌到 30 后，第 31 篇 409 benchmark_limit。
	for i := 0; i < 28; i++ {
		status, body = env.do("POST", notesPath, map[string]any{"title": "填充笔记", "structure": structure})
		if status != 201 {
			t.Fatalf("bulk note %d: status=%d body=%s", i, status, body)
		}
	}
	status, body = env.do("POST", notesPath, map[string]any{"title": "超额", "structure": structure})
	if status != 409 || !strings.Contains(string(body), "benchmark_limit") {
		t.Fatalf("31st note must hit the quota: status=%d body=%s", status, body)
	}
	_ = note
}
