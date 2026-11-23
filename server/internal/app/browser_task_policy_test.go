package app

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestF5URLPatternValidation(t *testing.T) {
	// F5-A2 表驱动：全站模式拒绝；合法域名+路径前缀通过。
	cases := []struct {
		pattern string
		want    bool
	}{
		{"*", false},
		{"https://*", false},
		{"https://*.mp.weixin.qq.com", false},
		{"*mp.weixin.qq.com", false},
		{"https://mp.weixin.qq.com/cgi-bin/home", true},
		{"http://localhost:8091/xhs/pack", true},
		{"ftp://example.com/x", false},
		{"mp.weixin.qq.com/x", false},
		{"", false},
	}
	for _, tc := range cases {
		if got := browserPolicyValidatePattern(tc.pattern); got != tc.want {
			t.Fatalf("pattern %q: want %v got %v", tc.pattern, tc.want, got)
		}
	}
	// 匹配语义：前缀命中、未命中。
	if !browserPolicyURLMatch("https://mp.weixin.qq.com/cgi-bin/home", "https://mp.weixin.qq.com/cgi-bin/home?t=1") {
		t.Fatal("prefix should match")
	}
	if browserPolicyURLMatch("https://mp.weixin.qq.com/cgi-bin/home", "https://evil.com/cgi-bin/home") {
		t.Fatal("different host must not match")
	}
	// 用户信息不能借字符串前缀穿过 host 校验；路径必须按段匹配。
	if browserPolicyURLMatch("https://creator.xiaohongshu.com/publish/publish",
		"https://creator.xiaohongshu.com@evil.example.com/publish/publish") {
		t.Fatal("userinfo URL must not match")
	}
	if browserPolicyURLMatch("https://creator.xiaohongshu.com/publish", "https://creator.xiaohongshu.com/publisher") {
		t.Fatal("path segment prefix must not match")
	}
	if !browserPolicyURLMatch("https://creator.xiaohongshu.com/publish/publish",
		"https://creator.xiaohongshu.com/publish/publish?source=official") {
		t.Fatal("query string should not break match")
	}
}

func TestF5CreatePolicyLimitsAndOwner(t *testing.T) {
	// F5-A1：owner 创建、48h 上限、全站模式 422 policy_pattern_too_broad、未知 purpose 422。
	a := drAccount(t, "xhs", "F5 策略小红书")
	env.ensureToolModel(t)
	// 全站模式拒绝。
	env.mustJSONStatus(t, "POST", "/api/v1/browser-task-policies",
		map[string]any{"purpose": "publish_health", "url_patterns": []string{"https://*"}, "expires_in_minutes": 60},
		nil, http.StatusUnprocessableEntity)
	// 未知 purpose。
	env.mustJSONStatus(t, "POST", "/api/v1/browser-task-policies",
		map[string]any{"purpose": "world_domination", "url_patterns": []string{"https://mp.example.com/x"}, "expires_in_minutes": 60},
		nil, http.StatusUnprocessableEntity)
	// 超过 48h。
	env.mustJSONStatus(t, "POST", "/api/v1/browser-task-policies",
		map[string]any{"purpose": "publish_health", "url_patterns": []string{"https://mp.weixin.qq.com/x"}, "expires_in_minutes": 2900},
		nil, http.StatusUnprocessableEntity)
	// 合法创建。
	var out struct {
		ID string `json:"id"`
	}
	env.mustJSON(t, "POST", "/api/v1/browser-task-policies",
		map[string]any{"purpose": "publish_health", "account_id": a.ID.String(),
			"url_patterns": []string{"https://mp.weixin.qq.com/cgi-bin/health"}, "expires_in_minutes": 60}, &out)
	if out.ID == "" {
		t.Fatal("create failed")
	}
	// 非(owner/editor 语义按 requireOwner) 禁管理：editor 403。
}

func TestF5ThreeGatesAndAudit(t *testing.T) {
	// F5-A3/A5：策略闸（缺/过期）、账号闸、标签页闸、动作闸；拒绝写审计。
	a := drAccount(t, "xhs", "F5 三闸小红书")
	other := drAccount(t, "xhs", "F5 他人小红书")
	env.ensureToolModel(t)
	var out struct {
		ID string `json:"id"`
	}
	env.mustJSON(t, "POST", "/api/v1/browser-task-policies",
		map[string]any{"purpose": "benchmark_observe", "account_id": a.ID.String(),
			"url_patterns":    []string{"https://www.xiaohongshu.com/user/profile"},
			"allowed_actions": []string{"observe"}, "expires_in_minutes": 30}, &out)
	policyID, _ := uuid.Parse(out.ID)
	// 策略闸：无策略的 purpose → policy_missing_or_expired。
	ok, reason := env.srv.checkBrowserPolicy(context.Background(), workspaceOfAccount(t, a.ID), a.ID,
		"publish_fill", "https://mp.weixin.qq.com/x", 1, "")
	if ok || reason != "policy_missing_or_expired" {
		t.Fatalf("gate1: ok=%v reason=%s", ok, reason)
	}
	// 白名单闸：有策略但 URL 不命中。
	ok, reason = env.srv.checkBrowserPolicy(context.Background(), workspaceOfAccount(t, a.ID), a.ID,
		"benchmark_observe", "https://evil.example.com/user", 1, "observe")
	if ok || reason != "policy_url_not_allowed" {
		t.Fatalf("gate2: ok=%v reason=%s", ok, reason)
	}
	// 账号闸：他人账号。
	ok, reason = env.srv.checkBrowserPolicy(context.Background(), workspaceOfAccount(t, a.ID), other.ID,
		"benchmark_observe", "https://www.xiaohongshu.com/user/profile", 1, "observe")
	if ok || reason != "policy_account_mismatch" {
		t.Fatalf("gate3: ok=%v reason=%s", ok, reason)
	}
	// 标签页闸：多标签。
	ok, reason = env.srv.checkBrowserPolicy(context.Background(), workspaceOfAccount(t, a.ID), a.ID,
		"benchmark_observe", "https://www.xiaohongshu.com/user/profile", 2, "observe")
	if ok || reason != "single_tab_required" {
		t.Fatalf("gate4: ok=%v reason=%s", ok, reason)
	}
	// 动作闸：未声明动作。
	ok, reason = env.srv.checkBrowserPolicy(context.Background(), workspaceOfAccount(t, a.ID), a.ID,
		"benchmark_observe", "https://www.xiaohongshu.com/user/profile", 1, "publish")
	if ok || reason != "policy_action_not_allowed" {
		t.Fatalf("gate5: ok=%v reason=%s", ok, reason)
	}
	// 全部通过。
	ok, _ = env.srv.checkBrowserPolicy(context.Background(), workspaceOfAccount(t, a.ID), a.ID,
		"benchmark_observe", "https://www.xiaohongshu.com/user/profile", 1, "observe")
	if !ok {
		t.Fatal("all gates should pass")
	}
	// 过期闸：把策略 expires_at 拨到过去 → policy_missing_or_expired（不自动续期）。
	_, err := env.srv.db.Exec(context.Background(),
		`UPDATE browser_task_policy SET expires_at=now()-interval '1 minute' WHERE id=$1`, policyID)
	if err != nil {
		t.Fatal(err)
	}
	ok, reason = env.srv.checkBrowserPolicy(context.Background(), workspaceOfAccount(t, a.ID), a.ID,
		"benchmark_observe", "https://www.xiaohongshu.com/user/profile", 1, "observe")
	if ok || reason != "policy_missing_or_expired" {
		t.Fatalf("expired: ok=%v reason=%s", ok, reason)
	}
	// 过期归档 job → status='expired'。
	env.srv.browserPolicyExpireJob(context.Background())
	var status string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT status FROM browser_task_policy WHERE id=$1`, policyID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "expired" {
		t.Fatalf("status = %s, want expired", status)
	}
	// 拒绝写审计由真实 HTTP 端点用例
	// TestF5BrowserPolicyCheckEndpointAuditsDeny 覆盖；这里不再手写 audit 伪造通过。
	// 续期：renew 48h 内合法；2900 分钟拒绝。
	env.mustJSONStatus(t, "POST", "/api/v1/browser-task-policies/"+policyID.String()+"/renew",
		map[string]any{"expires_in_minutes": 2900}, nil, http.StatusUnprocessableEntity)
	env.mustJSON(t, "POST", "/api/v1/browser-task-policies/"+policyID.String()+"/renew",
		map[string]any{"expires_in_minutes": 60}, nil)
	var expires time.Time
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT expires_at FROM browser_task_policy WHERE id=$1`, policyID).Scan(&expires); err != nil {
		t.Fatal(err)
	}
	if !expires.After(time.Now().Add(59 * time.Minute)) {
		t.Fatalf("renew not applied: %v", expires)
	}
}

func TestF5BrowserPolicyCheckEndpointAuditsDeny(t *testing.T) {
	// F5-A3/A5：桌面 Preflight 的签名检查端点必须真实返回三道闸结果，并把拒绝写审计。
	// 不再用“手写 audit”证明契约：这里走真实的 desktopReadAndVerifyProof + handler。
	p := newPlatformAccount(t, "f5-check")
	withDesktopPlatformEnabled(t, true)
	p.setPolicy(true, false)
	ctx := context.Background()
	accountID := uuid.New()
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO platform_account
		(id,workspace_id,platform,name,content_format) VALUES ($1,$2,'xhs','F5 检查账号','image_note')`,
		accountID, p.workspaceID); err != nil {
		t.Fatal(err)
	}
	path := "/api/v1/desktop/platform/browser-policy/check"
	call := func(body []byte) map[string]any {
		t.Helper()
		c := p.challenge("browser.policy.check", http.MethodPost, path, body, "")
		sig := ed25519.Sign(p.privateKey, desktopSignaturePayload(c))
		req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(body))
		req = req.WithContext(context.WithValue(req.Context(), ctxMember, p.identity("owner")))
		req.Header.Set("X-OPS-Desktop-Challenge", c.ID.String())
		req.Header.Set("X-OPS-Desktop-Signature", base64.StdEncoding.EncodeToString(sig))
		rec := httptest.NewRecorder()
		if err := env.srv.browserPolicyCheckHTTP(rec, req); err != nil {
			t.Fatalf("check handler: %v", err)
		}
		var out map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatalf("decode: %v (%s)", err, rec.Body.String())
		}
		return out
	}
	checkBody := func(purpose, targetURL string, tabCount int, action string) []byte {
		t.Helper()
		raw, err := json.Marshal(map[string]any{
			"account_id": accountID.String(), "purpose": purpose, "url": targetURL,
			"tab_count": tabCount, "action": action,
		})
		if err != nil {
			t.Fatal(err)
		}
		return raw
	}

	var before int
	if err := env.srv.db.QueryRow(ctx, `SELECT count(*) FROM audit_log
		WHERE action='browser_policy_denied' AND workspace_id=$1`, p.workspaceID).Scan(&before); err != nil {
		t.Fatal(err)
	}
	// 无 publish_fill 策略：拒绝，且 handler 自己写审计。
	out := call(checkBody("publish_fill", "https://creator.xiaohongshu.com/publish/publish", 1, "fill"))
	if out["ok"] != false || out["reason"] != "policy_missing_or_expired" {
		t.Fatalf("missing policy: %+v", out)
	}
	var after int
	if err := env.srv.db.QueryRow(ctx, `SELECT count(*) FROM audit_log
		WHERE action='browser_policy_denied' AND workspace_id=$1`, p.workspaceID).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if after != before+1 {
		t.Fatalf("deny audit: before=%d after=%d", before, after)
	}

	// 建一条 benchmark_observe 策略后：错 URL 拒绝并审计；正确 URL + 单标签通过。
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO browser_task_policy
		(workspace_id, purpose, url_patterns, allowed_actions, expires_at)
		VALUES ($1,'benchmark_observe',ARRAY['https://www.xiaohongshu.com/user/profile'],ARRAY['observe'],now()+interval '30 minutes')`,
		p.workspaceID); err != nil {
		t.Fatal(err)
	}
	out = call(checkBody("benchmark_observe", "https://evil.example.com/user/profile", 1, "observe"))
	if out["ok"] != false || out["reason"] != "policy_url_not_allowed" {
		t.Fatalf("wrong url: %+v", out)
	}
	if err := env.srv.db.QueryRow(ctx, `SELECT count(*) FROM audit_log
		WHERE action='browser_policy_denied' AND workspace_id=$1`, p.workspaceID).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if after != before+2 {
		t.Fatalf("second deny audit: after=%d", after)
	}
	out = call(checkBody("benchmark_observe", "https://www.xiaohongshu.com/user/profile/abc", 1, "observe"))
	if out["ok"] != true || out["reason"] != "" {
		t.Fatalf("allowed: %+v", out)
	}
	// 多标签拒绝，且 reason 是单标签闸。
	out = call(checkBody("benchmark_observe", "https://www.xiaohongshu.com/user/profile/abc", 2, "observe"))
	if out["ok"] != false || out["reason"] != "single_tab_required" {
		t.Fatalf("multi tab: %+v", out)
	}
}

func workspaceOfAccount(t *testing.T, accountID uuid.UUID) uuid.UUID {
	t.Helper()
	var ws uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT workspace_id FROM platform_account WHERE id=$1`, accountID).Scan(&ws); err != nil {
		t.Fatal(err)
	}
	return ws
}
