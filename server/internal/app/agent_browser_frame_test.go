package app

import (
	"net/http"
	"testing"

	"github.com/google/uuid"
)

// A7（27 §14.3 表格行 2）：frame 级 click/type/observe。
// 约束：只有 observe/click/type 接受 frame_id；带 frame_id 必须同时带 frame_origin；
// frame_origin 必须是 http/https 源且落在租约 origins 内（未授权的第三方 iframe 不提取、不操作）；
// 不带 frame 参数的命令保持旧行为（payload 不变、幂等语义不变）。

func wa7Setup(t *testing.T) (grantID string, runID uuid.UUID, conv agentConversation) {
	t.Helper()
	clearAgentFeatureSettings(t)
	t.Setenv(agentWorkbenchFeatureEnv, "chrome_connect,browser_workspace,event_resume")
	providerID := env.ensureToolModel(t)
	conv = env.agentRunConversation(t, providerID)
	t.Cleanup(func() { deleteConversations(t, conv.ID) })

	var pairing browserPairingView
	env.mustJSON(t, http.MethodPost, "/api/v1/agent/browser/pairings", map[string]any{"request_id": uuid.NewString()}, &pairing)
	var confirmed struct {
		BindingID string `json:"binding_id"`
	}
	env.mustJSON(t, http.MethodPost, "/api/v1/agent/browser/pairings/"+pairing.ID+"/confirm", w04ConfirmBody(t, pairing.Revision), &confirmed)
	runID = agentInsertRun(t, conv.ID, uuid.MustParse(env.me(t).Workspace.ID), uuid.MustParse(env.me(t).UserID), uuid.MustParse(providerID), "running", "message")
	var grant browserGrantView
	env.mustJSON(t, http.MethodPost, "/api/v1/agent/conversations/"+conv.ID.String()+"/browser-grants", map[string]any{
		"binding_id": confirmed.BindingID, "run_id": runID.String(),
		"tab_handle": "tab-1", "origins": []string{"https://example.com"},
	}, &grant)
	return grant.ID, runID, conv
}

func wa7Body(grantID string, runID uuid.UUID, action string, payload map[string]any) map[string]any {
	return map[string]any{
		"grant_id": grantID, "run_id": runID.String(), "request_id": uuid.NewString(),
		"action": action, "payload": payload,
	}
}

func TestA7BrowserFrameTargetValidation(t *testing.T) {
	grantID, runID, _ := wa7Setup(t)
	const path = "/api/v1/agent/browser/commands"

	click := func(payload map[string]any) map[string]any {
		return wa7Body(grantID, runID, "click", payload)
	}

	// 顶层旧行为：不带 frame 参数，仍可登记（回归）。
	var top browserCommandView
	env.mustJSON(t, http.MethodPost, path, click(map[string]any{
		"tab_id": 1, "ref": "f1", "doc_rev": "r1",
	}), &top)
	if top.State != "queued" || top.ActionKind != "click" {
		t.Fatalf("不带 frame 参数应保持旧行为：%+v", top)
	}

	// 同源子 frame：frame_id + 已授权 origin → 登记成功。
	var sameOrigin browserCommandView
	env.mustJSON(t, http.MethodPost, path, click(map[string]any{
		"tab_id": 1, "ref": "f2", "doc_rev": "r2", "frame_id": 2, "frame_origin": "https://example.com",
	}), &sameOrigin)
	if sameOrigin.State != "queued" {
		t.Fatalf("已授权 origin 的 frame 命令应 queued：%+v", sameOrigin)
	}

	// origin 归一化：带路径与大小写的写法仍应视为同一 origin。
	var normalized browserCommandView
	env.mustJSON(t, http.MethodPost, path, click(map[string]any{
		"tab_id": 1, "ref": "f3", "doc_rev": "r3", "frame_id": 2, "frame_origin": "HTTPS://Example.COM/some/path",
	}), &normalized)
	if normalized.State != "queued" {
		t.Fatalf("origin 未归一化：%+v", normalized)
	}

	// 未授权的第三方 iframe → 422 browser_origin_not_granted（不提取、不操作）。
	env.expectErr(t, http.MethodPost, path, click(map[string]any{
		"tab_id": 1, "ref": "f4", "doc_rev": "r4", "frame_id": 3, "frame_origin": "https://widget.other.com",
	}), "browser_origin_not_granted")

	// 只给 frame_id、缺 frame_origin → 无法核验授权，拒绝。
	env.expectErr(t, http.MethodPost, path, click(map[string]any{
		"tab_id": 1, "ref": "f5", "doc_rev": "r5", "frame_id": 2,
	}), "browser_frame_invalid")

	// 只给 frame_origin、没有 frame_id → 参数错误。
	env.expectErr(t, http.MethodPost, path, click(map[string]any{
		"tab_id": 1, "ref": "f6", "doc_rev": "r6", "frame_origin": "https://example.com",
	}), "browser_frame_invalid")

	// frame_id 非法值：0 / 超上限 / 小数 / 字符串。
	for _, bad := range []any{0, 4097, 1.5, "1"} {
		env.expectErr(t, http.MethodPost, path, click(map[string]any{
			"tab_id": 1, "ref": "f7", "doc_rev": "r7", "frame_id": bad, "frame_origin": "https://example.com",
		}), "browser_frame_invalid")
	}

	// frame_origin 非法：非 http/https、带用户信息。
	for _, badOrigin := range []string{"file:///c:/tmp/a.html", "https://user:pass@example.com", "not-a-url"} {
		env.expectErr(t, http.MethodPost, path, click(map[string]any{
			"tab_id": 1, "ref": "f8", "doc_rev": "r8", "frame_id": 2, "frame_origin": badOrigin,
		}), "browser_frame_invalid")
	}

	// 不支持 frame 的动作拒绝：navigate / extract / observe_frames。
	for _, action := range []string{"navigate", "extract", "observe_frames"} {
		env.expectErr(t, http.MethodPost, path, wa7Body(grantID, runID, action, map[string]any{
			"tab_id": 1, "frame_id": 2, "frame_origin": "https://example.com",
		}), "browser_frame_unsupported")
	}

	// observe / type 同样接受已授权 frame（三个动作口径一致）。
	for _, action := range []string{"observe", "type"} {
		payload := map[string]any{"tab_id": 1, "frame_id": 2, "frame_origin": "https://example.com"}
		if action == "type" {
			payload["ref"], payload["text"], payload["doc_rev"] = "f9", "hi", "r9"
		}
		var cmd browserCommandView
		env.mustJSON(t, http.MethodPost, path, wa7Body(grantID, runID, action, payload), &cmd)
		if cmd.State != "queued" {
			t.Fatalf("%s 带已授权 frame 应 queued：%+v", action, cmd)
		}
	}

	// 幂等：同 request_id 同载荷（含 frame 参数）返回同一命令；改 frame_id 视为异载荷。
	stable := wa7Body(grantID, runID, "click", map[string]any{
		"tab_id": 1, "ref": "f10", "doc_rev": "r10", "frame_id": 2, "frame_origin": "https://example.com",
	})
	var first browserCommandView
	env.mustJSON(t, http.MethodPost, path, stable, &first)
	var replay browserCommandView
	env.mustJSON(t, http.MethodPost, path, stable, &replay)
	if replay.ID != first.ID {
		t.Fatalf("同载荷应幂等：%+v vs %+v", first, replay)
	}
	changed := wa7Body(grantID, runID, "click", map[string]any{
		"tab_id": 1, "ref": "f10", "doc_rev": "r10", "frame_id": 3, "frame_origin": "https://example.com",
	})
	changed["request_id"] = stable["request_id"]
	env.expectErr(t, http.MethodPost, path, changed, "browser_request_conflict")
}

func TestA7NormalizeBrowserOrigin(t *testing.T) {
	cases := []struct {
		in   string
		want string
		ok   bool
	}{
		{"https://example.com", "https://example.com", true},
		{"https://example.com/", "https://example.com", true},
		{"HTTPS://Example.COM/path?q=1#f", "https://example.com", true},
		{"http://example.com:8080/x", "http://example.com:8080", true},
		{"  https://example.com  ", "https://example.com", true},
		{"file:///c:/tmp/a.html", "", false},
		{"javascript:void(0)", "", false},
		{"https://user:pass@example.com", "", false},
		{"not a url", "", false},
		{"", "", false},
	}
	for _, c := range cases {
		got, ok := normalizeBrowserOrigin(c.in)
		if ok != c.ok || got != c.want {
			t.Fatalf("normalizeBrowserOrigin(%q)=(%q,%v)，期望 (%q,%v)", c.in, got, ok, c.want, c.ok)
		}
	}
	if !browserOriginGranted("https://example.com", []string{"HTTPS://Example.com/"}) {
		t.Fatal("已授权 origin 应命中（两侧归一化）")
	}
	if browserOriginGranted("https://widget.other.com", []string{"https://example.com"}) {
		t.Fatal("未授权 origin 不应命中")
	}
}
