package app

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"
)

// DEV-SK2 回归复现：另一个超管用户经 /admin/workspaces/{id}/enter 代访
// 工作区（不是 workspace_member）后，在该工作区账号上跑任何 AI 任务。
// 快照复核按「用户执行须成员资格」检查 → 代访者不是成员 → 409
// skill_context_changed，包括零技能账号。23 文档 6.1 节：AdminOverride
// 不构成个人绑定或用户执行的成员资格——代访应按公共分区口径解析，不阻断。
func TestSkillAdminOverrideDoesNotBlockAI(t *testing.T) {
	env.accounts(t)
	ownerWS := uuid.MustParse(env.me(t).Workspace.ID)

	// 全新账号确保零绑定，排除其他测试影响。
	var fresh Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{"platform": "xhs", "name": "代访零技能账号", "content_format": "image_note"}, &fresh)

	// 第二个用户提为超管，代访进入 owner 工作区。
	admin := env.registerClient(t, "sk-override-"+uuid.NewString()[:8], testPassword)
	var me2 struct {
		UserID string `json:"user_id"`
		CSRF   string `json:"csrf_token"`
	}
	gMustJSON(t, admin, "GET", "/api/v1/auth/me", nil, &me2)
	if _, err := env.srv.db.Exec(context.Background(), `UPDATE app_user SET is_system_admin=true WHERE id=$1`, me2.UserID); err != nil {
		t.Fatal(err)
	}
	gMustJSON(t, admin, "POST", "/api/v1/admin/workspaces/"+ownerWS.String()+"/enter", nil, nil)
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(context.Background(), `UPDATE app_user SET is_system_admin=false WHERE id=$1`, me2.UserID)
		admin.restore(env)
	})

	// 代访会话下跑标题生成（该端点直接返回 JSON）：不得 409；refs 应按
	// 公共分区口径记录 actor_kind=system（AdminOverride 无成员资格）。
	var wk struct {
		ID string `json:"id"`
	}
	gMustJSON(t, admin, "POST", "/api/v1/accounts/"+fresh.ID.String()+"/works", map[string]string{"title": "代访作品"}, &wk)
	st, body := admin.do("POST", "/api/v1/works/"+wk.ID+"/titles", nil)
	if st != 200 {
		t.Fatalf("admin override must not block AI tasks: %d %s", st, body)
	}
	var out struct {
		Refs struct {
			Skills *struct {
				Context struct {
					ActorKind string `json:"actor_kind"`
				} `json:"context"`
			} `json:"skills"`
		} `json:"refs"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatal(err)
	}
	if out.Refs.Skills == nil || out.Refs.Skills.Context.ActorKind != "system" {
		t.Fatalf("override must resolve skills as the public-only actor: %+v", out.Refs.Skills)
	}
}

// guestSSE 在 guest 客户端上执行 SSE 请求并返回事件序列。
func guestSSE(t *testing.T, g *guestClient, path string, in any) []sseEvent {
	t.Helper()
	g.use()
	defer g.restore(env)
	body, _ := json.Marshal(in)
	req, _ := http.NewRequest("POST", env.http.URL+path, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-CSRF-Token", g.csrf)
	resp, err := g.client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/event-stream") {
		raw, _ := io.ReadAll(resp.Body)
		t.Fatalf("POST %s: not SSE: %d %s", path, resp.StatusCode, raw)
	}
	var out []sseEvent
	var cur sseEvent
	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 1<<20), 8<<20)
	for sc.Scan() {
		line := sc.Text()
		switch {
		case strings.HasPrefix(line, "event: "):
			cur.Name = strings.TrimPrefix(line, "event: ")
		case strings.HasPrefix(line, "data: "):
			cur.Data = json.RawMessage(strings.TrimPrefix(line, "data: "))
		case line == "":
			if cur.Name != "" {
				out = append(out, cur)
			}
			cur = sseEvent{}
		}
	}
	return out
}
