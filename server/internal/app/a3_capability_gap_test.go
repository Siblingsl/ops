package app

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/google/uuid"

	"ops/internal/ai"
)

// REF41 A3-A2/A3-A3：本地元工具记录缺口、同 key 累加，且不生成 agent_action 卡片。
func TestA3ReportCapabilityGapLocalToolDedupesWithoutCard(t *testing.T) {
	ctx, st := aw06ToolRun(t)
	call := ai.ToolCall{ID: "a3-gap-1"}
	call.Function.Name = "report_capability_gap"
	args, _ := json.Marshal(map[string]any{
		"gap_key":    "bulk-export-v1",
		"title":      "缺少批量导出作品能力",
		"detail":     "用户希望一次导出 100 篇作品的正文与指标",
		"need":       "按筛选条件批量导出 CSV",
		"workaround": "逐篇复制正文并手工汇总",
	})
	call.Function.Arguments = string(args)
	if err := env.srv.agentHandleToolCall(ctx, st, ident(ctx), call, nil); err != nil {
		t.Fatalf("report gap: %v", err)
	}

	var cards int
	if err := env.srv.db.QueryRow(ctx, `SELECT count(*) FROM agent_action WHERE run_id=$1`, st.RunID).Scan(&cards); err != nil {
		t.Fatal(err)
	}
	if cards != 0 {
		t.Fatalf("capability gap must not create an action card, got %d", cards)
	}
	var toolResult string
	if err := env.srv.db.QueryRow(ctx, `SELECT content FROM agent_message
		WHERE run_id=$1 AND role='tool' AND tool_name='report_capability_gap' ORDER BY seq DESC LIMIT 1`,
		st.RunID).Scan(&toolResult); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(toolResult, `"recorded":true`) || strings.Contains(toolResult, "gap_id") {
		t.Fatalf("tool receipt must only be recorded=true: %s", toolResult)
	}

	var count int
	var status, detail string
	if err := env.srv.db.QueryRow(ctx, `SELECT request_count, status, detail FROM agent_capability_gap
		WHERE workspace_id=$1 AND gap_key=$2`, st.WorkspaceID, "bulk-export-v1").Scan(&count, &status, &detail); err != nil {
		t.Fatal(err)
	}
	if count != 1 || status != "open" || !strings.Contains(detail, "按筛选条件批量导出 CSV") ||
		!strings.Contains(detail, "逐篇复制正文并手工汇总") {
		t.Fatalf("gap row: count=%d status=%s detail=%q", count, status, detail)
	}

	// 同一 run 再次记录同 key：只累加 request_count，不插入第二行，也不把已标记状态重置回 open。
	if _, err := env.srv.db.Exec(ctx, `UPDATE agent_capability_gap SET status='planned'
		WHERE workspace_id=$1 AND gap_key=$2`, st.WorkspaceID, "bulk-export-v1"); err != nil {
		t.Fatal(err)
	}
	call2 := ai.ToolCall{ID: "a3-gap-2"}
	call2.Function.Name = "report_capability_gap"
	call2.Function.Arguments = string(args)
	if err := env.srv.agentHandleToolCall(ctx, st, ident(ctx), call2, nil); err != nil {
		t.Fatalf("report gap again: %v", err)
	}
	var rows, total int
	var statusAfter string
	if err := env.srv.db.QueryRow(ctx, `SELECT count(*), max(request_count), max(status) FROM agent_capability_gap
		WHERE workspace_id=$1 AND gap_key=$2`, st.WorkspaceID, "bulk-export-v1").Scan(&rows, &total, &statusAfter); err != nil {
		t.Fatal(err)
	}
	if rows != 1 || total != 2 || statusAfter != "planned" {
		t.Fatalf("dedupe/status failed: rows=%d total=%d status=%s", rows, total, statusAfter)
	}
}

// REF41 A3-A4：列表与状态修改仅所有者可用，编辑者/观察者 403。
func TestA3CapabilityGapOwnerOnlyAPI(t *testing.T) {
	ctx, st := aw06ToolRun(t)
	call := ai.ToolCall{ID: "a3-gap-api"}
	call.Function.Name = "report_capability_gap"
	call.Function.Arguments = `{"gap_key":"image-batch-export","title":"缺少批量导出图片","detail":"需要一次导出 50 张图"}`
	if err := env.srv.agentHandleToolCall(ctx, st, ident(ctx), call, nil); err != nil {
		t.Fatalf("seed gap: %v", err)
	}

	var list struct {
		Gaps []agentCapabilityGap `json:"gaps"`
	}
	env.mustJSON(t, "GET", "/api/v1/agent-capability-gaps?status=open", nil, &list)
	var target *agentCapabilityGap
	for i := range list.Gaps {
		if list.Gaps[i].GapKey == "image-batch-export" {
			target = &list.Gaps[i]
		}
	}
	if target == nil || target.RequestCount != 1 {
		t.Fatalf("owner list missing target: %+v", list.Gaps)
	}
	var patched agentCapabilityGap
	env.mustJSON(t, "PATCH", "/api/v1/agent-capability-gaps/"+target.ID.String(),
		map[string]any{"status": "planned"}, &patched)
	if patched.Status != "planned" {
		t.Fatalf("patch status: %+v", patched)
	}
	env.expectErr(t, "PATCH", "/api/v1/agent-capability-gaps/"+target.ID.String(),
		map[string]any{"status": "done"}, "validation_failed")

	var inv struct {
		Code string `json:"code"`
	}
	env.mustJSON(t, "POST", "/api/v1/workspaces/current/invites", map[string]any{
		"role": "editor", "max_uses": 1, "days": 1,
	}, &inv)
	editor := env.registerClient(t, "a3-capability-editor", testPassword)
	editor.mustJSON(t, "POST", "/api/v1/workspaces/join", map[string]any{"code": inv.Code, "switch": true}, nil)
	// editor join(switch=true) 后留在主 workspace 的 member 行会让后续用例
	// （如 I5 review_peer 通知按成员落行）多出一份；Cleanup 时移除成员关系。
	var editorUserID uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT id FROM app_user WHERE username=$1`, "a3-capability-editor").Scan(&editorUserID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, err := env.srv.db.Exec(context.Background(),
			`DELETE FROM workspace_member WHERE user_id=$1 AND workspace_id=$2`, editorUserID, st.WorkspaceID)
		if err != nil {
			t.Fatalf("cleanup a3 editor membership: %v", err)
		}
	})
	editor.expectErr(t, "GET", "/api/v1/agent-capability-gaps", nil, "forbidden")
	editor.expectErr(t, "PATCH", "/api/v1/agent-capability-gaps/"+target.ID.String(),
		map[string]any{"status": "declined"}, "forbidden")
	editor.restore(env)
}

// REF41 A3-A5：没有真实工具记录时声称“已记录能力缺口”被 A1 拦截；
// 真实调用工具并落库后，同一句话不再被误伤。
func TestA3CapabilityGapFabricationGate(t *testing.T) {
	env.ensureToolModel(t)
	a1UseRealModelName(t)
	ctx, st := aw06ToolRun(t)
	claim := "已记录能力缺口：批量导出作品。"
	final, check := env.srv.agentFinalizeTruth(context.Background(), &agentRunState{
		RunID: uuid.New(), ConversationID: st.ConversationID, WorkspaceID: st.WorkspaceID,
		UserID: st.UserID, FabricationNudges: 1,
	}, claim, false)
	if !strings.Contains(final, "不代表已完成") || len(check.Blocked) == 0 {
		t.Fatalf("claim without tool must be blocked: %q %+v", final, check)
	}

	call := ai.ToolCall{ID: "a3-gap-fabrication"}
	call.Function.Name = "report_capability_gap"
	call.Function.Arguments = `{"gap_key":"bulk-export-fabrication","title":"缺少批量导出","detail":"需要批量导出"}`
	if err := env.srv.agentHandleToolCall(ctx, st, ident(ctx), call, nil); err != nil {
		t.Fatalf("record gap: %v", err)
	}
	final, check = env.srv.agentFinalizeTruth(ctx, st, claim, false)
	if final != claim || len(check.Blocked) != 0 || check.Evidence != 1 {
		t.Fatalf("real tool evidence must prevent rewrite: %q %+v", final, check)
	}
}

// 防止测试辅助被误删：确保 schema 中的工具名与参数保持一致。
func TestA3CapabilityGapToolSchema(t *testing.T) {
	tool := agentTool("report_capability_gap")
	if tool == nil || tool.Path != "" || tool.MinRole != roleEditor {
		t.Fatalf("tool schema missing/local/role: %+v", tool)
	}
	names := map[string]bool{}
	for _, p := range tool.Params {
		names[p.Name] = true
	}
	for _, want := range []string{"gap_key", "title", "detail", "need", "workaround"} {
		if !names[want] {
			t.Fatalf("tool schema missing %s", want)
		}
	}
}
