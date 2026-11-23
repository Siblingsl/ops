package app

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

// OT-04：按工作区聚合 run/tool/browser 指标；只含计数、比例、时长，不含 prompt 内容。
func TestOT04AgentObservabilityAggregatesByWorkspace(t *testing.T) {
	clearAgentFeatureSettings(t)
	t.Setenv(agentWorkbenchFeatureEnv, "workbench_ui")

	owner := env.registerClient(t, fmt.Sprintf("ot04-owner-%d", time.Now().UnixNano()), testPassword)
	owner.use()
	t.Cleanup(func() { owner.restore(env) })

	me := env.me(t)
	workspaceID := uuid.MustParse(me.Workspace.ID)
	userID := uuid.MustParse(me.UserID)
	conv := env.createConversation(t, map[string]any{"title": "OT-04 指标"})
	t.Cleanup(func() { deleteConversations(t, conv.ID) })

	// 3 条已完成 run：2 成功 + 1 失败，平均 2 秒；失败率 1/3。
	completedA := agentInsertRun(t, conv.ID, workspaceID, userID, uuid.Nil, "completed", "message")
	completedB := agentInsertRun(t, conv.ID, workspaceID, userID, uuid.Nil, "completed", "message")
	failed := agentInsertRun(t, conv.ID, workspaceID, userID, uuid.Nil, "failed", "message")
	for _, runID := range []uuid.UUID{completedA, completedB, failed} {
		if _, err := env.srv.db.Exec(context.Background(), `UPDATE agent_run
			SET started_at=now()-interval '10 minutes',
			    finished_at=(now()-interval '10 minutes')+interval '2 seconds'
			WHERE id=$1`, runID); err != nil {
			t.Fatal(err)
		}
	}

	// 3 次工具执行：2 成功 + 1 失败；失败率 1/3。
	for i, status := range []string{"succeeded", "succeeded", "failed"} {
		runID := completedA
		if status == "failed" {
			runID = failed
		}
		if _, err := env.srv.db.Exec(context.Background(), `INSERT INTO agent_action
			(conversation_id,run_id,batch_id,workspace_id,user_id,tool_call_id,tool_name,kind,target_type,target_id,target_key,status,params,expires_at)
			VALUES ($1,$2,$3,$4,$5,$6,'ot04_tool','W','work','target',$7,$8,'{}'::jsonb,now())`,
			conv.ID, runID, uuid.New(), workspaceID, userID, fmt.Sprintf("ot04-call-%d", i), fmt.Sprintf("ot04-key-%d", i), status); err != nil {
			t.Fatal(err)
		}
	}

	bindingID := uuid.New()
	if _, err := env.srv.db.Exec(context.Background(), `INSERT INTO agent_browser_binding
		(id,workspace_id,user_id,device_id,extension_instance_id,connection_name)
		VALUES ($1,$2,$3,$4,$5,'OT04 浏览器')`,
		bindingID, workspaceID, userID, uuid.New(), uuid.New()); err != nil {
		t.Fatal(err)
	}
	grantID := uuid.New()
	if _, err := env.srv.db.Exec(context.Background(), `INSERT INTO agent_browser_grant
		(id,binding_id,workspace_id,user_id,conversation_id,tab_handle,expires_at)
		VALUES ($1,$2,$3,$4,$5,'ot04-tab',now()+interval '1 hour')`,
		grantID, bindingID, workspaceID, userID, conv.ID); err != nil {
		t.Fatal(err)
	}
	// 4 条浏览器命令：2 成功 + 1 失败 + 1 unknown；失败率按 (failed+unknown)/total=1/2。
	for _, state := range []string{"succeeded", "succeeded", "failed", "unknown_outcome"} {
		if _, err := env.srv.db.Exec(context.Background(), `INSERT INTO agent_browser_command
			(id,grant_id,request_id,action_kind,input_hash,state)
			VALUES ($1,$2,$3,'ot04',$4,$5)`, uuid.New(), grantID, uuid.New(), uuid.NewString(), state); err != nil {
			t.Fatal(err)
		}
	}

	var logBuf bytes.Buffer
	oldLogger := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logBuf, &slog.HandlerOptions{Level: slog.LevelInfo})))
	t.Cleanup(func() { slog.SetDefault(oldLogger) })

	var got agentObservabilityView
	env.mustJSON(t, "GET", "/api/v1/agent/observability?days=7", nil, &got)
	if got.WindowDays != 7 || got.RunsTotal != 3 || got.RunsFailed != 1 ||
		got.ToolCalls != 3 || got.ToolFailures != 1 ||
		got.BrowserCommands != 4 || got.BrowserFailures != 1 || got.BrowserUnknown != 1 {
		t.Fatalf("聚合计数不符：%+v", got)
	}
	if math.Abs(got.RunFailureRate-1.0/3.0) > 1e-9 || math.Abs(got.ToolFailureRate-1.0/3.0) > 1e-9 || math.Abs(got.BrowserFailureRate-0.5) > 1e-9 {
		t.Fatalf("失败率不符：%+v", got)
	}
	if math.Abs(got.AvgRunDurationMs-2000) > 1 {
		t.Fatalf("平均时长不符：%v", got.AvgRunDurationMs)
	}
	logText := logBuf.String()
	if !strings.Contains(logText, "agent_observability_read") || strings.Contains(logText, "prompt") {
		t.Fatalf("缺少可观测日志样例或泄露 prompt：%s", logText)
	}
	t.Logf("日志样例: %s", strings.TrimSpace(logText))

	// 另一个工作区调用同一接口只能看到自己的 0，不能读到本工作区计数。
	other := env.registerClient(t, fmt.Sprintf("ot04-other-%d", time.Now().UnixNano()), testPassword)
	other.use()
	var otherView agentObservabilityView
	env.mustJSON(t, "GET", "/api/v1/agent/observability?days=7", nil, &otherView)
	other.restore(env)
	if otherView.RunsTotal != 0 || otherView.ToolCalls != 0 || otherView.BrowserCommands != 0 {
		t.Fatalf("跨工作区聚合泄漏：%+v", otherView)
	}
}
