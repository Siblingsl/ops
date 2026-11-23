package app

import (
	"testing"

	"github.com/google/uuid"
)

// TL-03（38 文档）：权限与门槛——服务端拒绝路径可复验：
// 观察者执行/拒绝他人卡片走 403/404，本人卡片 gate 409；不因前端隐藏按钮放松。
func TestTL03ViewerCannotExecuteOrReject(t *testing.T) {
	pid := env.ensureToolModel(t)
	acc := env.accounts(t)
	wk := env.readyWork(t, acc.wechat, "TL03 权限守卫")
	defer agentDropWork(wk.ID)
	c := env.agentRunConversation(t, pid)
	defer deleteConversations(t, c.ID)

	// 真实 run 提出一张 H 类卡片（checks__complete，gate 人工确认）。
	evs := env.sse(t, agentRunPath(c, "messages"), map[string]any{"text": "完成检查项\n" +
		agentLoadDomain("publish") + "\n#tool checks__complete {\"id\":\"" + wk.ID.String() + "\"}"})
	card := findActionEvent(t, evs)
	if card == nil {
		t.Fatal("应提出 checks__complete 卡片")
	}

	// 观察者账号加入同一工作区后：执行与拒绝都被服务端拒绝（execute 不在 viewer 白名单）。
	var inv inviteDTO
	env.mustJSON(t, "POST", "/api/v1/workspaces/current/invites", map[string]any{"role": "viewer", "max_uses": 1, "days": 1}, &inv)
	viewer := env.registerClient(t, "tl03-viewer-"+uuid.NewString()[:8], testPassword)
	var vme meInfo
	viewer.mustJSON(t, "GET", "/api/v1/auth/me", nil, &vme)
	viewer.csrf = vme.CSRF
	viewer.mustJSON(t, "POST", "/api/v1/workspaces/join", map[string]any{"code": inv.Code, "switch": true}, nil)
	viewer.mustJSON(t, "GET", "/api/v1/auth/me", nil, &vme)
	viewer.csrf = vme.CSRF
	if vme.Role != "viewer" {
		t.Fatalf("want viewer, got %s", vme.Role)
	}

	if st, body := viewer.do("POST", agentActionPath(card.ID, "execute"),
		map[string]any{"confirm": true, "gate_ack": true}); st != 403 {
		t.Fatalf("观察者执行卡片应 403，得到 %d：%s", st, body)
	}
	viewer.restore(env)
	if st, body := viewer.do("POST", agentActionPath(card.ID, "reject"), map[string]any{}); st != 404 {
		t.Fatalf("观察者拒绝他人卡片应 404，得到 %d：%s", st, body)
	}
	viewer.restore(env)

	// 跨用户：另一工作区成员看不到该卡片 → 404，不泄露存在性。
	stranger := env.registerClient(t, "tl03-stranger-"+uuid.NewString()[:8], testPassword)
	var sme meInfo
	stranger.mustJSON(t, "GET", "/api/v1/auth/me", nil, &sme)
	stranger.csrf = sme.CSRF
	if st, _ := stranger.do("POST", agentActionPath(card.ID, "execute"), map[string]any{"confirm": true}); st != 404 {
		t.Fatalf("跨工作区执行应 404，得到 %d", st)
	}
	stranger.restore(env)

	// 本人卡片：缺 gate_ack 仍 409（权限链最内层不受影响）。
	env.expectErr(t, "POST", agentActionPath(card.ID, "execute"),
		map[string]any{"confirm": true}, "agent_gate_ack_required")
}
