package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"
)

// IX-04（38 文档 §11）：划选“引用追问”——message 引用类型的 resolve 校验。
// 合法 anchor、错 hash、错 range、跨对话、用户消息拒绝、超长拒绝。
func TestIX04MessageReferenceResolution(t *testing.T) {
	t.Setenv(agentWorkbenchFeatureEnv, "context_refs")
	pid := env.ensureToolModel(t)
	c := env.agentRunConversation(t, pid)
	defer deleteConversations(t, c.ID)

	// 真实 run 产生 assistant 消息（含可划选正文）；SSE 实时流不含落库事件，
	// 直接从 agent_message 取本人本对话最新 assistant 正文。
	evs := env.sse(t, agentRunPath(c, "messages"), map[string]any{"text": "请解释一下什么是内容日历。"})
	_ = evs
	var assistant, content string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT id::text, content FROM agent_message
		 WHERE conversation_id=$1 AND role='assistant' AND content<>'' ORDER BY seq DESC LIMIT 1`, c.ID).Scan(&assistant, &content); err != nil {
		t.Fatalf("run 应产生 assistant 消息：%v", err)
	}
	runes := []rune(content)
	end := 10
	if end > len(runes) {
		end = len(runes)
	}
	quote := string(runes[:end])
	hash := sha256.Sum256([]byte(quote))
	quoteHash := hex.EncodeToString(hash[:])

	var preview struct {
		Items []struct {
			ID      string `json:"id"`
			Type    string `json:"type"`
			Status  string `json:"status"`
			Content string `json:"content"`
		} `json:"items"`
	}
	refBody := func(anchor map[string]any) map[string]any {
		return map[string]any{
			"conversation_id": c.ID.String(),
			"account_id":      c.AccountID.String(),
			"context_refs":    []map[string]any{{"type": "message", "id": assistant, "scope": "turn", "anchor": anchor}},
			"skill_requests":  []any{}, "attachment_ids": []any{},
		}
	}

	// 合法 anchor：available 且 Content 为选段引用。
	env.mustJSON(t, http.MethodPost, "/api/v1/agent/context-preview", refBody(map[string]any{
		"start": 0, "end": len([]rune(quote)), "quote": quote, "quote_hash": quoteHash,
	}), &preview)
	if len(preview.Items) != 1 || preview.Items[0].Type != "message" || preview.Items[0].Status != "available" {
		t.Fatalf("合法 anchor 未解析：%+v", preview.Items)
	}
	if !strings.Contains(preview.Items[0].Content, "选段引用") || !strings.Contains(preview.Items[0].Content, quote) {
		t.Fatalf("Content 应为选段引用：%s", preview.Items[0].Content)
	}

	// 错 hash：422。
	env.expectErr(t, http.MethodPost, "/api/v1/agent/context-preview", refBody(map[string]any{
		"start": 0, "end": len([]rune(quote)), "quote": quote, "quote_hash": strings.Repeat("0", 64),
	}), "agent_context_unavailable")

	// 错 range（end 越界）：422。
	env.expectErr(t, http.MethodPost, "/api/v1/agent/context-preview", refBody(map[string]any{
		"start": 0, "end": len(runes) + 5, "quote": quote, "quote_hash": quoteHash,
	}), "agent_context_unavailable")

	// 用户消息拒绝：role='assistant' 过滤使 user 消息 id 解析不到（ErrNoRows → 422）。
	var userID string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT id::text FROM agent_message WHERE conversation_id=$1 AND role='user' ORDER BY seq DESC LIMIT 1`, c.ID).Scan(&userID); err != nil {
		t.Fatal(err)
	}
	env.expectErr(t, http.MethodPost, "/api/v1/agent/context-preview", map[string]any{
		"account_id":     c.AccountID.String(),
		"context_refs":   []map[string]any{{"type": "message", "id": userID, "scope": "turn"}},
		"skill_requests": []any{}, "attachment_ids": []any{},
	}, "agent_context_unavailable")

	// 跨对话：另一个用户/工作区无法引用该消息（归属隔离 → 422）。
	stranger := env.registerClient(t, "ix04-stranger-"+uuid.NewString()[:8], testPassword)
	var sme meInfo
	stranger.mustJSON(t, "GET", "/api/v1/auth/me", nil, &sme)
	stranger.csrf = sme.CSRF
	if st, _ := stranger.do("POST", "/api/v1/agent/context-preview", map[string]any{
		"account_id":     nil,
		"context_refs":   []map[string]any{{"type": "message", "id": assistant, "scope": "turn"}},
		"skill_requests": []any{}, "attachment_ids": []any{},
	}); st < 400 {
		t.Fatalf("跨对话引用应拒绝，得到 %d", st)
	}
	stranger.restore(env)

	// 超长选段（>2000 码点）拒绝：anchor validator 上限。
	longQuote := strings.Repeat("长", 2001)
	env.expectErr(t, http.MethodPost, "/api/v1/agent/context-preview", refBody(map[string]any{
		"start": 0, "end": 2001, "quote": longQuote, "quote_hash": quoteHash,
	}), "agent_context_unavailable")
}
