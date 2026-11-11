package app

import (
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

// BE-07（docs/33 §11.8）：结构化错误字段 + 审计 + 脱敏。
// 抽样断言：Error 级失败路径 audit detail 含 error_code/route/workspace_id/duration_ms；
// 敏感键（正文/密钥/技能正文）不进 audit 也不进 slog。

func TestBE07ObserveFailureWritesAuditFields(t *testing.T) {
	sink := opt15Capture(t)
	me := env.me(t)
	ws := mustParse(t, me.Workspace.ID)
	user := mustParse(t, me.UserID)
	ctx := context.WithValue(context.Background(), ctxMember, &identity{UserID: user, WorkspaceID: ws, Role: "owner"})
	target := uuid.New()
	marker := "be07-" + target.String()
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(context.Background(), `DELETE FROM audit_log WHERE action=$1 AND target_id=$2`, "memory_usage_write", target.String())
	})

	started := time.Now().Add(-15 * time.Millisecond)
	env.srv.observeFailure(ctx, slog.LevelError, "记忆用量记账失败", observeFields{
		Action: "memory_usage_write", TargetType: "agent_run", TargetID: target.String(),
		ErrorCode: "memory_usage_write_failed", Route: "internal/agent/personal_memory/usage",
		Started: started,
		Extras: map[string]any{
			"run_id": target.String(), "rows": 2, "err": "forced",
			"text": "BE07-BODY-SENTINEL", "password": "BE07-SECRET", "skill_body": "BE07-SKILL",
			"marker": marker,
		},
	})

	var detailRaw []byte
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT detail FROM audit_log WHERE action='memory_usage_write' AND target_id=$1 ORDER BY created_at DESC LIMIT 1`,
		target.String()).Scan(&detailRaw); err != nil {
		t.Fatal(err)
	}
	var detail map[string]any
	if err := json.Unmarshal(detailRaw, &detail); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"error_code", "route", "workspace_id", "duration_ms"} {
		if detail[k] == nil || detail[k] == "" {
			t.Fatalf("audit missing %s: %+v", k, detail)
		}
	}
	if detail["error_code"] != "memory_usage_write_failed" {
		t.Fatalf("error_code=%v", detail["error_code"])
	}
	if detail["route"] != "internal/agent/personal_memory/usage" {
		t.Fatalf("route=%v", detail["route"])
	}
	if detail["workspace_id"] != ws.String() {
		t.Fatalf("workspace_id=%v want %s", detail["workspace_id"], ws)
	}
	if _, ok := detail["duration_ms"].(float64); !ok {
		t.Fatalf("duration_ms type: %T", detail["duration_ms"])
	}
	encoded := string(detailRaw)
	for _, bad := range []string{"BE07-BODY-SENTINEL", "BE07-SECRET", "BE07-SKILL"} {
		if strings.Contains(encoded, bad) {
			t.Fatalf("sensitive value leaked into audit: %s", encoded)
		}
	}
	if _, ok := detail["text"]; ok {
		t.Fatal("text key must be stripped from audit")
	}

	matched := false
	for _, record := range sink.records(t) {
		if record["msg"] != "记忆用量记账失败" {
			continue
		}
		matched = true
		if record["error_code"] != "memory_usage_write_failed" || record["route"] != "internal/agent/personal_memory/usage" {
			t.Fatalf("log fields: %+v", record)
		}
		if record["workspace_id"] != ws.String() || record["duration_ms"] == nil {
			t.Fatalf("log workspace/duration: %+v", record)
		}
		line, _ := json.Marshal(record)
		for _, bad := range []string{"BE07-BODY-SENTINEL", "BE07-SECRET", "BE07-SKILL"} {
			if strings.Contains(string(line), bad) {
				t.Fatalf("sensitive value leaked into slog: %s", line)
			}
		}
	}
	if !matched {
		t.Fatal("no matching slog record")
	}
}

func TestBE07ObserveWarnRateLimitedNoAudit(t *testing.T) {
	sink := opt15Capture(t)
	code := "be07_warn_" + uuid.NewString()
	me := env.me(t)
	ctx := context.WithValue(context.Background(), ctxMember, &identity{
		UserID: mustParse(t, me.UserID), WorkspaceID: mustParse(t, me.Workspace.ID), Role: "owner",
	})
	observeWarnLast.Delete(code)

	env.srv.observeFailure(ctx, slog.LevelWarn, "be07 warn sample", observeFields{
		ErrorCode: code, Route: "internal/be07/warn", Extras: map[string]any{"n": 1},
	})
	env.srv.observeFailure(ctx, slog.LevelWarn, "be07 warn sample", observeFields{
		ErrorCode: code, Route: "internal/be07/warn", Extras: map[string]any{"n": 2},
	})

	n := 0
	for _, record := range sink.records(t) {
		if record["msg"] == "be07 warn sample" && record["error_code"] == code {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("warn rate limit: got %d logs, want 1", n)
	}
	var audits int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM audit_log WHERE detail->>'error_code'=$1`, code).Scan(&audits); err != nil {
		t.Fatal(err)
	}
	if audits != 0 {
		t.Fatalf("warn must not write audit, got %d", audits)
	}
}
