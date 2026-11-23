package app

import (
	"bytes"
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestF1RedactCoversEightClasses(t *testing.T) {
	// F1-A1 表驱动：8 类脱敏 + 误伤用例。
	cases := []struct{ name, in, want string }{
		{"sk 密钥", "key=sk-abc123XYZdef456", "key=sk-a…[REDACTED]…f456"},
		{"Bearer", "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9", "Authorization: Bearer eyJh…[REDACTED]…NiJ9"},
		{"Cookie", "Cookie: session=abcdef123456789; path=/", "Cookie: " + redactToken("session=abcdef123456789") + "; path=/"},
		{"手机号", "联系 13812345678 确认", "联系 " + redactToken("13812345678") + " 确认"},
		{"邮箱", "发送到 user.name@example.com 即可", ""},
		{"open_id", `open_id: "oABCD1234567890"`, ""},
		{"chat_id", `chat_id=12345678901`, ""},
		{"Authorization 头", "x-api-key: abcdef1234567890", ""},
		// 误伤：普通数字、普通单词、短值。
		{"普通数字", "订单 98765432101 共 3 件", "订单 98765432101 共 3 件"},
		{"普通单词", "authorization failed for request", "authorization failed for request"},
		{"空串", "", ""},
	}
	for _, tc := range cases {
		got := redactString(tc.in)
		if tc.name == "邮箱" {
			// 邮箱用户名脱敏、@域名保留（可排查性口径）。
			if got == tc.in || !bytes.HasSuffix([]byte(got), []byte("@example.com 即可")) {
				t.Fatalf("邮箱: in=%q out=%q", tc.in, got)
			}
			continue
		}
		if tc.name == "open_id" || tc.name == "chat_id" || tc.name == "Authorization 头" {
			if got == tc.in {
				t.Fatalf("%s: 未脱敏 in=%q out=%q", tc.name, tc.in, got)
			}
			continue
		}
		if got != tc.want {
			t.Fatalf("%s: want %q got %q", tc.name, tc.want, got)
		}
	}
	// 嵌套 map 递归。
	m := redactMap(map[string]any{
		"token": "sk-abc123XYZdef456",
		"nested": map[string]any{"phone": "13812345678"},
		"list":   []any{"Bearer abcdefgh12345678", 42},
		"plain":  12345,
	})
	if m["token"] == "sk-abc123XYZdef456" {
		t.Fatal("nested token not redacted")
	}
	if m["plain"] != 12345 {
		t.Fatal("plain int must stay")
	}
	nested := m["nested"].(map[string]any)
	if nested["phone"] == "13812345678" {
		t.Fatal("nested phone not redacted")
	}
}

func containsFullEmail(s string) bool {
	for _, part := range splitSpaces(s) {
		if isEmail(part) {
			return true
		}
	}
	return false
}

func splitSpaces(s string) []string {
	out := []string{}
	cur := ""
	for _, r := range s {
		if r == ' ' {
			out = append(out, cur)
			cur = ""
		} else {
			cur += string(r)
		}
	}
	out = append(out, cur)
	return out
}

func isEmail(s string) bool {
	at := -1
	for i, r := range s {
		if r == '@' {
			at = i
		}
	}
	return at > 0
}

func TestF1RulesThresholdWindowAndDedupe(t *testing.T) {
	// F1-A2/A3/A4：规则 CRUD、窗口评估、去重（同窗口一次）、恢复。
	a := drAccount(t, "xhs", "F1 告警小红书")
	var wsID uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT workspace_id FROM platform_account WHERE id=$1`, a.ID).Scan(&wsID); err != nil {
		t.Fatal(err)
	}
	// 规则 upsert：阈值/窗口/启停。
	enabled := true
	var out map[string]any
	env.mustJSON(t, "PUT", "/api/v1/alert-rules/publish_failure_count",
		map[string]any{"threshold": 0, "window_minutes": 60, "enabled": enabled}, &out)
	// 非法值拒绝。
	env.mustJSONStatus(t, "PUT", "/api/v1/alert-rules/publish_failure_count",
		map[string]any{"threshold": -1}, nil, http.StatusUnprocessableEntity)
	env.mustJSONStatus(t, "PUT", "/api/v1/alert-rules/publish_failure_count",
		map[string]any{"threshold": 1, "window_minutes": 2}, nil, http.StatusUnprocessableEntity)
	env.mustJSONStatus(t, "PUT", "/api/v1/alert-rules/unknown_rule",
		map[string]any{"threshold": 1}, nil, http.StatusUnprocessableEntity)
	// 事件列表初始为空。
	var events struct {
		Events []alertEvent `json:"events"`
	}
	env.mustJSON(t, "GET", "/api/v1/alert-events", nil, &events)
	if len(events.Events) != 0 {
		t.Fatalf("events should be empty, got %d", len(events.Events))
	}
	// 建作品（publish_task.work_id 需要账号下存在作品），再注入 failed 任务。
	wk := publishTestWork(t, a, "F1 告警作品", 900, 1200, []string{"测试"})
	_ = wk
	_, err := env.srv.db.Exec(context.Background(),
		`INSERT INTO publish_task (workspace_id, account_id, work_id, platform, state, mode, state_version)
		 SELECT pa.workspace_id, pa.id, w.id, pa.platform, 'failed', 'manual', 1
		 FROM platform_account pa
		 JOIN LATERAL (SELECT id FROM work WHERE account_id=pa.id AND deleted_at IS NULL LIMIT 1) w ON true
		 WHERE pa.id=$1`,
		a.ID)
	if err != nil {
		t.Fatal(err)
	}
	var rule alertRule
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT id, key, threshold, window_minutes, enabled FROM alert_rule WHERE workspace_id=$1 AND key='publish_failure_count'`,
		wsID).Scan(&rule.ID, &rule.Key, &rule.Threshold, &rule.WindowMinutes, &rule.Enabled); err != nil {
		t.Fatal(err)
	}
	var injected int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM publish_task WHERE workspace_id=$1 AND state='failed'`, wsID).Scan(&injected); err != nil {
		t.Fatal(err)
	}
	if injected == 0 {
		t.Fatal("injection failed: no failed publish_task row")
	}
	if v, ok := env.srv.alertEvaluate(context.Background(), wsID, rule, time.Now()); !ok {
		t.Fatalf("evaluate should fire: value=%v threshold=%v", v, rule.Threshold)
	}
	env.srv.alertCheckJob(context.Background())
	env.mustJSON(t, "GET", "/api/v1/alert-events", nil, &events)
	if len(events.Events) == 0 {
		t.Fatal("expected firing event after failed publish")
	}
	first := events.Events[0]
	if first.State != "firing" {
		t.Fatalf("state = %s", first.State)
	}
	// 去重：同窗口再跑不新增事件。
	env.srv.alertCheckJob(context.Background())
	env.mustJSON(t, "GET", "/api/v1/alert-events", nil, &events)
	if len(events.Events) != 1 {
		t.Fatalf("dedupe broken: %d events", len(events.Events))
	}
	// 消息不含正文/密钥：只含计数与规则标签。
	if containsAnySecret(events.Events[0].Message) {
		t.Fatalf("message must not contain secrets: %s", events.Events[0].Message)
	}
	// 恢复：窗口内失败清零后（删除注入行），跨窗口评估 resolved + 通知。
	_, err = env.srv.db.Exec(context.Background(), `DELETE FROM publish_task WHERE workspace_id=$1 AND state='failed'`, wsID)
	if err != nil {
		t.Fatal(err)
	}
	// 把事件 created_at 拨回窗口外，模拟上一窗口遗留 firing。
	_, err = env.srv.db.Exec(context.Background(),
		`UPDATE alert_event SET created_at=now()-interval '3 hours' WHERE workspace_id=$1`, wsID)
	if err != nil {
		t.Fatal(err)
	}
	env.srv.alertCheckJob(context.Background())
	env.mustJSON(t, "GET", "/api/v1/alert-events", nil, &events)
	if len(events.Events) == 0 || events.Events[0].State != "resolved" {
		t.Fatalf("expect resolved, got %+v", events.Events)
	}
	// 规则关闭后不评估：禁用 + 注入失败 → 无新 firing。
	disabled := false
	env.mustJSON(t, "PUT", "/api/v1/alert-rules/publish_failure_count",
		map[string]any{"threshold": 0, "window_minutes": 60, "enabled": disabled}, &out)
	_, err = env.srv.db.Exec(context.Background(),
		`INSERT INTO publish_task (workspace_id, account_id, work_id, platform, state, mode, state_version)
		 SELECT pa.workspace_id, pa.id, w.id, pa.platform, 'failed', 'manual', 1
		 FROM platform_account pa
		 JOIN LATERAL (SELECT id FROM work WHERE account_id=pa.id AND deleted_at IS NULL LIMIT 1) w ON true
		 WHERE pa.id=$1`,
		a.ID)
	if err != nil {
		t.Fatal(err)
	}
	env.srv.alertCheckJob(context.Background())
	env.mustJSON(t, "GET", "/api/v1/alert-events", nil, &events)
	for _, ev := range events.Events {
		if ev.State == "firing" {
			t.Fatalf("disabled rule must not fire: %+v", ev)
		}
	}
}

func containsAnySecret(s string) bool {
	for _, bad := range []string{"sk-", "Bearer ", "BEGIN PRIVATE", "password="} {
		if len(s) >= len(bad) && indexOf(s, bad) >= 0 {
			return true
		}
	}
	return false
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}

func TestF1NoDataNoAlert(t *testing.T) {
	// F1-A5：job_failure_rate 0/0（无 job_run 表或空窗口）不告警。
	a := drAccount(t, "xhs", "F1 零除小红书")
	var wsID uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT workspace_id FROM platform_account WHERE id=$1`, a.ID).Scan(&wsID); err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	env.mustJSON(t, "PUT", "/api/v1/alert-rules/job_failure_rate",
		map[string]any{"threshold": 0.5, "window_minutes": 60}, &out)
	rule := alertRule{Key: "job_failure_rate", Threshold: 0.5, WindowMinutes: 60, Enabled: true}
	value, firing := env.srv.alertEvaluate(context.Background(), wsID, rule, time.Now())
	if firing {
		t.Fatalf("0/0 must not alert, value=%v", value)
	}
}
