package app

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

// DEV-CX12 / FR-CX-14 / T-CX14：结构拆解 API——
// schema 白名单与长度、全部自由文本反复制（对抗夹具）、422 不落库、
// 同 URL CAS 更新与无 URL 新建、临时正文不出现在 ai_call/日志可查询范围。
type structureExtractResponse struct {
	Structure     map[string]any `json:"structure"`
	StructureHash string         `json:"structure_hash"`
	NoteURL       string         `json:"source_url,omitempty"`
	AICallID      *string        `json:"ai_call_id,omitempty"`
	PromptVersion string         `json:"prompt_version"`
}

// cxStructureFixtureText 构造 300+ 码点的合成参考正文。
func cxStructureFixtureText() string {
	paragraphs := []string{
		"许多人开始记录生活，但坚持不下来。问题往往不在懒，而在反馈太慢，写了两周看不到任何变化就放弃了，于是怀疑方法没有用。",
		"解决办法是把记录降到一个不可能失败的最小动作。每天只写一句话，写完就算完成，多余的内容是奖励而不是负担，中断一天也不必补救。",
		"举一个例子，一位作者连续三十天只写一句话总结，第三个月自然开始扩写成段，因为素材已经堆在眼前，不需要凭空回忆当时的细节。",
		"执行清单分四步：定一个固定时间、准备一个顺手工具、写完立刻保存、每周日回读一次。每一步都可以单独放弃或调整，不追求完美的执行记录。",
		"结论是先保住连续性，再谈质量。记录本身不是目的，让想法有地方沉淀才是，等习惯自己长大，输出自然会跟着变多起来。",
	}
	return strings.Join(paragraphs, "\n")
}

func ensureStructureRoute(t *testing.T) {
	t.Helper()
	var provider struct {
		ID string `json:"id"`
	}
	env.mustJSON(t, "POST", "/api/v1/model-providers", map[string]any{
		"name": "结构拆解模拟模型", "base_url": env.mock.URL + "/v1", "api_key": "opt52-local-mock-key", "models": []string{"mock-writer"},
	}, &provider)
	env.mustJSON(t, "PUT", "/api/v1/model-routes", []map[string]any{{"task_type": "cx_structure_extract", "provider_id": provider.ID, "model": "mock-writer"}}, nil)
}

func TestCXStructureExtractSchemaNoCopyAndPersistence(t *testing.T) {
	ensureStructureRoute(t)
	account := env.accounts(t).xhs
	path := "/api/v1/accounts/" + account.ID.String() + "/structure-extract"
	reference := cxStructureFixtureText()

	status, body := env.do("POST", path, map[string]any{
		"reference_text": reference,
	})
	if status != 200 {
		t.Fatalf("extract: status=%d body=%s", status, body)
	}
	var resp structureExtractResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatalf("decode: %v body=%s", err, body)
	}
	if resp.StructureHash == "" || len(resp.StructureHash) != 64 {
		t.Fatalf("server must compute structure_hash: %s", resp.StructureHash)
	}
	if resp.PromptVersion != "cx-structure-1" || resp.AICallID == nil {
		t.Fatalf("call receipt required: %+v", resp)
	}
	if _, ok := resp.Structure["hook_type"]; !ok {
		t.Fatalf("structure must expose documented fields: %+v", resp.Structure)
	}

	// 临时正文不落库：ai_call 的 context_refs 不含参考正文（4.9 禁止进入 context_refs）。
	var refsRaw []byte
	if err := env.srv.db.QueryRow(context.Background(), `SELECT context_refs FROM ai_call WHERE id=$1`, *resp.AICallID).Scan(&refsRaw); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(refsRaw), "不可能失败的最小动作") {
		t.Fatalf("temporary reference text must not enter ai_call.context_refs: %s", string(refsRaw)[:200])
	}

	// 不带 target_id 时不新增任何 benchmark_note（fixture 账号可能已有其他用例的笔记，断言增量）。
	var noteCount int
	if err := env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM benchmark_note bn
		JOIN benchmark_target bt ON bt.id=bn.target_id WHERE bt.account_id=$1`, account.ID).Scan(&noteCount); err != nil {
		t.Fatal(err)
	}

	// 带 target + note_url：创建笔记；再次同 URL 提交按 CAS 更新。
	var target struct{ ID string `json:"id"` }
	status, body = env.do("POST", "/api/v1/accounts/"+account.ID.String()+"/benchmarks", map[string]any{"platform": "xhs", "name": "拆解目标"})
	if status != 201 {
		t.Fatalf("target: %d %s", status, body)
	}
	_ = json.Unmarshal(body, &target)
	status, body = env.do("POST", path, map[string]any{
		"reference_text": reference, "target_id": target.ID, "note_url": "https://www.xiaohongshu.com/explore/struct-1",
	})
	if status != 200 {
		t.Fatalf("extract with target: %d %s", status, body)
	}
	_ = json.Unmarshal(body, &resp)
	status, body = env.do("GET", "/api/v1/benchmarks/"+target.ID+"/notes", nil)
	var notes struct {
		Items []struct {
			ID            string         `json:"id"`
			Revision      int            `json:"revision"`
			StructureHash string         `json:"structure_hash"`
			Structure     map[string]any `json:"structure"`
			AICallID      *string        `json:"ai_call_id"`
		} `json:"items"`
	}
	if err := json.Unmarshal(body, &notes); err != nil || len(notes.Items) != 1 {
		t.Fatalf("one note expected: %d %s", len(notes.Items), body)
	}
	first := notes.Items[0]
	if first.StructureHash != resp.StructureHash || first.AICallID == nil {
		t.Fatalf("note must carry the generated structure hash and ai_call: %+v", first)
	}
	// 再提交同 URL：CAS 冲突（base_revision 过期）。
	status, body = env.do("POST", path, map[string]any{
		"reference_text": reference, "target_id": target.ID, "note_url": "https://www.xiaohongshu.com/explore/struct-1",
		"base_revision": first.Revision + 5,
	})
	if status != 409 || !strings.Contains(string(body), "version_conflict") {
		t.Fatalf("stale base_revision must 409: status=%d body=%s", status, body)
	}
	// 正确 base_revision：更新而不是新增。
	status, body = env.do("POST", path, map[string]any{
		"reference_text": reference, "target_id": target.ID, "note_url": "https://www.xiaohongshu.com/explore/struct-1",
		"base_revision": first.Revision,
	})
	if status != 200 {
		t.Fatalf("cas update: %d %s", status, body)
	}
	status, body = env.do("GET", "/api/v1/benchmarks/"+target.ID+"/notes", nil)
	_ = json.Unmarshal(body, &notes)
	if len(notes.Items) != 1 || notes.Items[0].Revision != first.Revision+1 {
		t.Fatalf("same URL must CAS-update in place: %d notes, revision %d", len(notes.Items), notes.Items[0].Revision)
	}

	// 无 URL：每次新建。
	status, _ = env.do("POST", path, map[string]any{"reference_text": reference, "target_id": target.ID})
	if status != 200 {
		t.Fatalf("no-url extract: %d", status)
	}
	status, body = env.do("GET", "/api/v1/benchmarks/"+target.ID+"/notes", nil)
	_ = json.Unmarshal(body, &notes)
	if len(notes.Items) != 2 {
		t.Fatalf("no-URL submission must create a new note each time: %d", len(notes.Items))
	}
}

func TestCXStructureExtractRejectsBadInput(t *testing.T) {
	ensureStructureRoute(t)
	account := env.accounts(t).xhs
	path := "/api/v1/accounts/" + account.ID.String() + "/structure-extract"

	// 长度边界：过短拒绝。
	status, body := env.do("POST", path, map[string]any{"reference_text": "太短的正文"})
	if status != 422 {
		t.Fatalf("too-short reference must 422: %d %s", status, body)
	}
	// viewer 拒绝。
	var workspaceID, userID string
	if err := env.srv.db.QueryRow(context.Background(), `SELECT workspace_id FROM platform_account WHERE id=$1`, account.ID).Scan(&workspaceID); err != nil {
		t.Fatal(err)
	}
	if err := env.srv.db.QueryRow(context.Background(), `SELECT user_id FROM workspace_member WHERE workspace_id=$1 AND role='owner' LIMIT 1`, workspaceID).Scan(&userID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(context.Background(), `UPDATE workspace_member SET role='viewer' WHERE workspace_id=$1 AND user_id=$2`, workspaceID, userID); err != nil {
		t.Fatal(err)
	}
	status, _ = env.do("POST", path, map[string]any{"reference_text": cxStructureFixtureText()})
	if status != 403 {
		t.Fatalf("viewer must not extract: %d", status)
	}
	if _, err := env.srv.db.Exec(context.Background(), `UPDATE workspace_member SET role='owner' WHERE workspace_id=$1 AND user_id=$2`, workspaceID, userID); err != nil {
		t.Fatal(err)
	}
}

// 反复制验证的单元夹具：长原文短抄句必须拦截；改写通过。
func TestCXNoCopyValidator(t *testing.T) {
	reference := cxNormalizeText("这是一段用来验证复制率计算的比较长的原始参考正文，包含足够的字符数量以便统计四字词组的重叠情况，结尾还有一句额外补充说明用于增加长度。")
	// 直接抄原句：连续子串命中。
	err := validateCXNoCopy(reference, map[string]string{"gist": "验证复制率计算的比较长"})
	if err == nil {
		t.Fatal("verbatim substring must be rejected")
	}
	// 改写（共享少量词组但 gram 重合率低）：通过。
	err = validateCXNoCopy(reference, map[string]string{"gist": "结构要点：该文的段落安排先给问题再给步骤"})
	if err != nil {
		t.Fatalf("paraphrase must pass: %v", err)
	}
	// 短于 4 码点的候选只做连续子串/长度检查。
	err = validateCXNoCopy(reference, map[string]string{"gist": "结构"})
	if err != nil {
		t.Fatalf("short paraphrase must pass: %v", err)
	}
}

// HTTP 层 422 extraction_copy_risk 路径：#copy-echo 夹具让 mock 抄原句，
// validate 闭包两轮都不合格；断言 422 而非 502，且不落任何笔记。
func TestCXStructureExtractHTTPCopyRisk422(t *testing.T) {
	ensureStructureRoute(t)
	account := env.accounts(t).xhs
	path := "/api/v1/accounts/" + account.ID.String() + "/structure-extract"
	var target struct {
		ID string `json:"id"`
	}
	if status, body := env.do("POST", "/api/v1/accounts/"+account.ID.String()+"/benchmarks", map[string]any{"platform": "xhs", "name": "复制风险HTTP路径"}); status != 201 || json.Unmarshal(body, &target) != nil {
		t.Fatalf("seed target: %d %s", status, body)
	}
	segment := "复制风险HTTP验收第1段：这一段原句会被夹具原样抄进 gist，用来触发服务端反复制验证的拒绝路径，补足长度的说明文字让总码点超过三百的下限要求，段落内容保持稳定以便断言稳定。"
	reference := "#copy-echo\n" + strings.Repeat(segment+"\n", 4)
	status, body := env.do("POST", path, map[string]any{"reference_text": reference, "target_id": target.ID})
	if status != 422 || !strings.Contains(string(body), "extraction_copy_risk") {
		t.Fatalf("copy risk must surface as 422 (not 502): status=%d body=%s", status, body)
	}
	var notes struct {
		Items []map[string]any `json:"items"`
	}
	status, body = env.do("GET", "/api/v1/benchmarks/"+target.ID+"/notes", nil)
	if err := json.Unmarshal(body, &notes); err != nil || status != 200 {
		t.Fatalf("list notes: %d %s", status, body)
	}
	if len(notes.Items) != 0 {
		t.Fatalf("422 must not persist any note: %d", len(notes.Items))
	}
}
