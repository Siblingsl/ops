package app

import (
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"
)

// REF41 I2：竞对作品半自动拆解。
// 覆盖 A1（迁移由 db 包单独测试）、A2 草稿/确认、A3 失败/丢弃不覆盖、A4 批量上限与无批量确认、A5 输出校验。

func ensureBenchmarkDecomposeRoute(t *testing.T) {
	t.Helper()
	var provider struct {
		ID string `json:"id"`
	}
	env.mustJSON(t, "POST", "/api/v1/model-providers", map[string]any{
		"name": "I2 竞对拆解模拟模型", "base_url": env.mock.URL + "/v1", "api_key": "i2-local-mock-key", "models": []string{"mock-writer"},
	}, &provider)
	env.mustJSON(t, "PUT", "/api/v1/model-routes", []map[string]any{
		{"task_type": benchmarkDecomposeTaskType, "provider_id": provider.ID, "model": "mock-writer"},
	}, nil)
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(t.Context(), `DELETE FROM model_route WHERE task_type=$1 AND provider_id=$2`, benchmarkDecomposeTaskType, provider.ID)
		_, _ = env.srv.db.Exec(t.Context(), `DELETE FROM model_provider WHERE id=$1`, provider.ID)
	})
}

func createI2Note(t *testing.T, title string, metrics map[string]any) benchmarkNote {
	t.Helper()
	account := env.accounts(t).xhs
	var target struct {
		ID string `json:"id"`
	}
	env.mustJSONStatus(t, "POST", "/api/v1/accounts/"+account.ID.String()+"/benchmarks", map[string]any{
		"platform": "xhs", "name": "I2 对标 " + title,
	}, &target, http.StatusCreated)
	var note benchmarkNote
	body := map[string]any{
		"title":           title,
		"content_summary": "开头用一个具体问题；中段拆成三步方法；结尾给可验证结果。",
		"structure":       map[string]any{"manual": "keep"},
	}
	if metrics != nil {
		body["metrics_snapshot"] = metrics
	}
	env.mustJSONStatus(t, "POST", "/api/v1/benchmarks/"+target.ID+"/notes", body, &note, http.StatusCreated)
	return note
}

func i2PostDecompose(t *testing.T, noteID string) benchmarkDecomposeResponse {
	t.Helper()
	var res benchmarkDecomposeResponse
	env.mustJSON(t, "POST", "/api/v1/benchmark/notes/"+noteID+"/decompose", nil, &res)
	return res
}

func TestI2RequiresContentSummaryForDecompose(t *testing.T) {
	ensureBenchmarkDecomposeRoute(t)
	account := env.accounts(t).xhs
	var target struct {
		ID string `json:"id"`
	}
	env.mustJSONStatus(t, "POST", "/api/v1/accounts/"+account.ID.String()+"/benchmarks", map[string]any{
		"platform": "xhs", "name": "I2 缺摘要",
	}, &target, http.StatusCreated)
	var note benchmarkNote
	env.mustJSONStatus(t, "POST", "/api/v1/benchmarks/"+target.ID+"/notes", map[string]any{
		"title": "没有原文摘要的笔记", "structure": map[string]any{"manual": "keep"},
	}, &note, http.StatusCreated)
	if note.ContentSummary != "" {
		t.Fatalf("new note should default to empty content_summary: %q", note.ContentSummary)
	}
	status, body := env.do("POST", "/api/v1/benchmark/notes/"+note.ID.String()+"/decompose", nil)
	if status != http.StatusUnprocessableEntity || !strings.Contains(string(body), "benchmark_content_required") {
		t.Fatalf("decompose without content_summary must be rejected: %d %s", status, body)
	}
	var after benchmarkNote
	env.mustJSON(t, "GET", "/api/v1/benchmark-notes/"+note.ID.String(), nil, &after)
	if after.DecomposeState != "none" || after.StructureHash != note.StructureHash {
		t.Fatalf("rejected decompose must not mutate note: %+v", after)
	}
}

func TestI2ContentSummaryPersistsAndIsLimited(t *testing.T) {
	note := createI2Note(t, "I2 摘要长度", map[string]any{"likes": 8})
	if note.ContentSummary == "" {
		t.Fatal("created note must persist content_summary")
	}
	tooLong := strings.Repeat("长", 4001)
	status, body := env.do("PATCH", "/api/v1/benchmark-notes/"+note.ID.String(), map[string]any{
		"base_revision": note.Revision, "content_summary": tooLong,
	})
	if status != http.StatusUnprocessableEntity || !strings.Contains(string(body), "原文摘要最多 4000 码点") {
		t.Fatalf("4001-codepoint summary must be rejected: %d %s", status, body)
	}
	var updated benchmarkNote
	env.mustJSON(t, "PATCH", "/api/v1/benchmark-notes/"+note.ID.String(), map[string]any{
		"base_revision": note.Revision, "content_summary": "更新后的摘要唯一标记",
	}, &updated)
	if updated.ContentSummary != "更新后的摘要唯一标记" {
		t.Fatalf("content_summary update not persisted: %q", updated.ContentSummary)
	}
}

func TestI2PromptUsesContentSummary(t *testing.T) {
	prompt := (&Server{}).benchmarkDecomposePrompt(benchmarkNote{
		Title:           "摘要输入测试",
		ContentSummary:  "摘要唯一标记：先抛问题，再拆三步，最后给结果。",
		URL:             "https://example.com/note",
		MetricsSnapshot: map[string]any{"likes": 12},
	}, "xhs")
	if !strings.Contains(prompt, "摘要唯一标记：先抛问题，再拆三步，最后给结果。") {
		t.Fatalf("decompose prompt must include user-provided content_summary: %s", prompt)
	}
	if strings.Contains(prompt, "不保存全文") {
		t.Fatalf("prompt should treat content_summary as the input, not claim no content: %s", prompt)
	}
}

func TestI2DraftDoesNotWriteStructureUntilConfirm(t *testing.T) {
	ensureBenchmarkDecomposeRoute(t)
	note := createI2Note(t, "I2 草稿不写结构", map[string]any{"followers": 1200, "likes": 340})
	originalStructure := note.Structure
	originalHash := note.StructureHash
	originalRevision := note.Revision

	res := i2PostDecompose(t, note.ID.String())
	if res.Reused {
		t.Fatal("first decompose must not be reused")
	}
	if res.Note.DecomposeState != "ai_draft" {
		t.Fatalf("state=%s, want ai_draft", res.Note.DecomposeState)
	}
	if res.Note.DecomposeAICallID == nil || res.Note.AICallID != nil {
		t.Fatalf("draft must carry decompose_ai_call_id and leave note.ai_call_id untouched: %+v", res.Note)
	}
	if res.Note.StructureHash != originalHash || res.Note.Revision != originalRevision {
		t.Fatalf("AI draft must not change structure/hash/revision: %+v", res.Note)
	}
	if stringMustMatchJSON(res.Note.Structure) != stringMustMatchJSON(originalStructure) {
		t.Fatalf("AI draft changed structure: before=%v after=%v", originalStructure, res.Note.Structure)
	}
	if res.Note.DecomposeDraft["hook"] == "" {
		t.Fatalf("draft missing hook: %+v", res.Note.DecomposeDraft)
	}

	// 重复请求在 ai_draft 上复用，不再调用模型。
	beforeCalls := countI2Calls(t)
	again := i2PostDecompose(t, note.ID.String())
	if !again.Reused || again.Note.DecomposeAICallID == nil ||
		*again.Note.DecomposeAICallID != *res.Note.DecomposeAICallID {
		t.Fatalf("repeat decompose must reuse same draft: %+v", again)
	}
	if afterCalls := countI2Calls(t); afterCalls != beforeCalls {
		t.Fatalf("repeat decompose must not create ai_call: before=%d after=%d", beforeCalls, afterCalls)
	}

	edited := benchmarkDecomposeDraft{
		Hook:          "编辑后的钩子",
		Structure:     []string{"编辑后的第一段", "编辑后的第二段"},
		Rhythm:        "编辑后的节奏",
		Takeaways:     []string{"编辑后的可借鉴点"},
		NotBorrowable: []string{"编辑后的不可借鉴点"},
		Confidence:    0.65,
	}
	var confirmed benchmarkNote
	env.mustJSON(t, "POST", "/api/v1/benchmark/notes/"+note.ID.String()+"/decompose/confirm", map[string]any{"draft": edited}, &confirmed)
	if confirmed.DecomposeState != "confirmed" || confirmed.DecomposeRevision != 1 {
		t.Fatalf("confirm state/revision wrong: %+v", confirmed)
	}
	if confirmed.Revision != originalRevision+1 {
		t.Fatalf("confirm must bump note revision: before=%d after=%d", originalRevision, confirmed.Revision)
	}
	if confirmed.AICallID == nil || *confirmed.AICallID != *res.Note.DecomposeAICallID {
		t.Fatalf("confirmed note must carry the draft ai_call_id: %+v", confirmed)
	}
	if confirmed.DecomposeConfirmedAt == nil {
		t.Fatal("confirmed_at missing")
	}
	if confirmed.Structure["hook"] != edited.Hook || confirmed.StructureHash == originalHash {
		t.Fatalf("confirm must write edited structure and new hash: %+v", confirmed)
	}
	if len(confirmed.Takeaways) != 1 || confirmed.Takeaways[0] != edited.Takeaways[0] ||
		len(confirmed.NotBorrowable) != 1 || confirmed.NotBorrowable[0] != edited.NotBorrowable[0] {
		t.Fatalf("confirm must write takeaways/not_borrowable: %+v", confirmed)
	}
}

func TestI2DiscardAndFailureKeepOldStructure(t *testing.T) {
	ensureBenchmarkDecomposeRoute(t)
	note := createI2Note(t, "I2 丢弃与失败", nil)
	originalHash := note.StructureHash

	res := i2PostDecompose(t, note.ID.String())
	if res.Note.DecomposeState != "ai_draft" {
		t.Fatalf("draft state=%s", res.Note.DecomposeState)
	}
	var discarded benchmarkNote
	env.mustJSON(t, "POST", "/api/v1/benchmark/notes/"+note.ID.String()+"/decompose/discard", nil, &discarded)
	if discarded.DecomposeState != "none" || discarded.StructureHash != originalHash ||
		stringMustMatchJSON(discarded.Structure) != stringMustMatchJSON(note.Structure) {
		t.Fatalf("discard must preserve old structure: %+v", discarded)
	}
	if discarded.DecomposeDraft["hook"] != nil {
		t.Fatalf("discard must clear draft: %+v", discarded.DecomposeDraft)
	}

	failed := createI2Note(t, "#invalid-json 失败用例", nil)
	failedHash := failed.StructureHash
	status, body := env.do("POST", "/api/v1/benchmark/notes/"+failed.ID.String()+"/decompose", nil)
	if status == http.StatusOK {
		t.Fatalf("invalid model JSON must fail: %d %s", status, body)
	}
	var after benchmarkNote
	env.mustJSON(t, "GET", "/api/v1/benchmark-notes/"+failed.ID.String(), nil, &after)
	if after.DecomposeState != "failed" {
		t.Fatalf("failure state=%s body=%s", after.DecomposeState, body)
	}
	if after.StructureHash != failedHash || stringMustMatchJSON(after.Structure) != stringMustMatchJSON(failed.Structure) {
		t.Fatalf("failure must not overwrite structure: %+v", after)
	}
	if len([]rune(after.DecomposeError)) == 0 || len([]rune(after.DecomposeError)) > 200 {
		t.Fatalf("failure reason must be 1..200 chars: %q", after.DecomposeError)
	}
}

func TestI2BatchLimitAndNoBatchConfirm(t *testing.T) {
	ensureBenchmarkDecomposeRoute(t)
	notes := make([]benchmarkNote, 6)
	for i := range notes {
		notes[i] = createI2Note(t, "I2 批量 "+string(rune('A'+i)), map[string]any{"followers": 100 + i})
	}
	ids := make([]string, len(notes))
	for i := range notes {
		ids[i] = notes[i].ID.String()
	}
	status, body := env.do("POST", "/api/v1/benchmark/decompose-batch", map[string]any{"note_ids": ids})
	if status != http.StatusUnprocessableEntity {
		t.Fatalf("6 notes must be rejected: %d %s", status, body)
	}
	var batch struct {
		Items []struct {
			NoteID         string `json:"note_id"`
			DecomposeState string `json:"decompose_state"`
			Reused         bool   `json:"reused"`
		} `json:"items"`
	}
	env.mustJSON(t, "POST", "/api/v1/benchmark/decompose-batch", map[string]any{"note_ids": ids[:5]}, &batch)
	if len(batch.Items) != 5 {
		t.Fatalf("batch items=%d", len(batch.Items))
	}
	for i, item := range batch.Items {
		if item.NoteID != ids[i] || item.DecomposeState != "ai_draft" {
			t.Fatalf("batch item %d = %+v", i, item)
		}
		var note benchmarkNote
		env.mustJSON(t, "GET", "/api/v1/benchmark-notes/"+ids[i], nil, &note)
		if note.StructureHash != notes[i].StructureHash ||
			stringMustMatchJSON(note.Structure) != stringMustMatchJSON(notes[i].Structure) {
			t.Fatalf("batch must not write structure %d", i)
		}
	}

	// 逐条确认仍然有效；没有批量确认入口。
	var one benchmarkNote
	env.mustJSON(t, "POST", "/api/v1/benchmark/notes/"+ids[0]+"/decompose/confirm", nil, &one)
	if one.DecomposeState != "confirmed" {
		t.Fatalf("single confirm failed: %+v", one)
	}
	status, _ = env.do("POST", "/api/v1/benchmark/decompose-batch/confirm", map[string]any{"note_ids": ids[:5]})
	if status < 400 {
		t.Fatalf("batch confirm route must not exist/accept, status=%d", status)
	}
}

func TestI2DecomposeOutputValidation(t *testing.T) {
	valid := benchmarkDecomposeDraft{
		Hook: "钩子", Structure: []string{"结构"}, Rhythm: "节奏",
		Takeaways: []string{"借鉴"}, NotBorrowable: []string{"不借鉴"}, Confidence: 0.8,
	}
	if err := validateBenchmarkDecomposeDraft(&valid, true); err != nil {
		t.Fatalf("valid draft rejected: %v", err)
	}
	cases := []struct {
		name      string
		draft     benchmarkDecomposeDraft
		hasMetric bool
	}{
		{"hook too long", func() benchmarkDecomposeDraft { d := valid; d.Hook = strings.Repeat("长", 201); return d }(), true},
		{"structure empty", func() benchmarkDecomposeDraft { d := valid; d.Structure = nil; return d }(), true},
		{"structure too many", func() benchmarkDecomposeDraft {
			d := valid
			d.Structure = make([]string, 9)
			for i := range d.Structure {
				d.Structure[i] = "项"
			}
			return d
		}(), true},
		{"item too long", func() benchmarkDecomposeDraft {
			d := valid
			d.Structure = []string{strings.Repeat("长", 201)}
			return d
		}(), true},
		{"confidence out of range", func() benchmarkDecomposeDraft { d := valid; d.Confidence = 1.1; return d }(), true},
		{"no metrics high confidence", func() benchmarkDecomposeDraft { d := valid; d.Confidence = 0.5; return d }(), false},
	}
	for _, tc := range cases {
		if err := validateBenchmarkDecomposeDraft(&tc.draft, tc.hasMetric); err == nil {
			t.Fatalf("%s must be rejected", tc.name)
		}
	}
}

func TestI2ConcurrentDecomposeReusesOneDraft(t *testing.T) {
	ensureBenchmarkDecomposeRoute(t)
	note := createI2Note(t, "I2 并发复用", map[string]any{"followers": 500})
	before := countI2Calls(t)
	type result struct {
		status int
		body   []byte
	}
	results := make(chan result, 2)
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			status, body := env.do("POST", "/api/v1/benchmark/notes/"+note.ID.String()+"/decompose", nil)
			results <- result{status: status, body: body}
		}()
	}
	wg.Wait()
	close(results)
	var callIDs []string
	reused := 0
	for result := range results {
		if result.status != http.StatusOK {
			t.Fatalf("concurrent decompose status=%d body=%s", result.status, result.body)
		}
		var res benchmarkDecomposeResponse
		if err := json.Unmarshal(result.body, &res); err != nil {
			t.Fatal(err)
		}
		if res.Reused {
			reused++
		}
		if res.Note.DecomposeAICallID == nil {
			t.Fatalf("missing ai call: %+v", res.Note)
		}
		callIDs = append(callIDs, res.Note.DecomposeAICallID.String())
	}
	if after := countI2Calls(t); after != before+1 {
		t.Fatalf("concurrent decompose must create exactly one ai_call: before=%d after=%d", before, after)
	}
	if len(callIDs) != 2 || callIDs[0] != callIDs[1] {
		t.Fatalf("concurrent requests must reuse same call: %v", callIDs)
	}
	if reused != 1 {
		t.Fatalf("exactly one request should be reused, got %d", reused)
	}
}

func countI2Calls(t *testing.T) int {
	t.Helper()
	var count int
	if err := env.srv.db.QueryRow(t.Context(), `SELECT count(*) FROM ai_call WHERE task_type=$1`, benchmarkDecomposeTaskType).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

// TestI2ModelCallDoesNotHoldRowLock 对应 I2-D3：模型调用期间不得持有 benchmark_note 行锁。
// 用 mock 延迟把 AI 拖住，同时 PATCH 同 note 的摘要；旧实现会阻塞到模型返回，新实现应立即成功，
// 随后拆解在短事务复核时返回 409 benchmark_decompose_conflict，不覆盖已变化的笔记。
func TestI2ModelCallDoesNotHoldRowLock(t *testing.T) {
	ensureBenchmarkDecomposeRoute(t)
	note := createI2Note(t, "I2 模型不持锁", map[string]any{"followers": 700})
	oldDelay := env.llm.Delay
	env.llm.Delay = 600 * time.Millisecond
	t.Cleanup(func() { env.llm.Delay = oldDelay })

	done := make(chan struct{})
	var decomposeStatus int
	var decomposeBody []byte
	go func() {
		defer close(done)
		decomposeStatus, decomposeBody = env.do("POST", "/api/v1/benchmark/notes/"+note.ID.String()+"/decompose", nil)
	}()

	// 等模型真正开始（ai_call 已落账）再发 PATCH，避免只测到排队阶段。
	deadline := time.Now().Add(2 * time.Second)
	for countI2Calls(t) == 0 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	started := time.Now()
	status, body := env.do("PATCH", "/api/v1/benchmark-notes/"+note.ID.String(), map[string]any{
		"base_revision": note.Revision, "content_summary": "模型运行期间更新的摘要标记",
	})
	elapsed := time.Since(started)
	if status != http.StatusOK {
		t.Fatalf("PATCH during AI call status=%d body=%s", status, body)
	}
	if elapsed > 250*time.Millisecond {
		t.Fatalf("PATCH blocked on decompose row lock: %s", elapsed)
	}
	<-done
	if decomposeStatus != http.StatusConflict || !strings.Contains(string(decomposeBody), "benchmark_decompose_conflict") {
		t.Fatalf("decompose after content change = %d %s, want 409 benchmark_decompose_conflict", decomposeStatus, decomposeBody)
	}

	var after benchmarkNote
	env.mustJSON(t, "GET", "/api/v1/benchmark-notes/"+note.ID.String(), nil, &after)
	if after.ContentSummary != "模型运行期间更新的摘要标记" {
		t.Fatalf("summary update lost: %+v", after)
	}
	if after.DecomposeState == "ai_draft" {
		t.Fatalf("stale AI draft must not be written after content changed: %+v", after)
	}
}


func stringMustMatchJSON(value any) string {
	raw, _ := json.Marshal(value)
	return string(raw)
}
