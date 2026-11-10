package app

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// TestW16V08RealtimeProxyRelays：A2 服务端 realtime WS 代理端到端。
// 供应商密钥只在服务端（假上游校验 Authorization）；桌面只拿短期令牌；双向透传不改信封。
func TestW16V08RealtimeProxyRelays(t *testing.T) {
	clearAgentFeatureSettings(t)
	t.Setenv(agentWorkbenchFeatureEnv, "run_control,event_resume,plans,goals,artifacts,voice_dictation,voice_realtime")
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer asr-test-placeholder-not-a-secret" {
			t.Errorf("代理应以服务端密钥连上游，实际 Authorization=%q", got)
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if r.URL.Path != "/v1/realtime" || r.URL.Query().Get("model") != "realtime-test-model" {
			t.Errorf("上游路径/模型不符：path=%s model=%s", r.URL.Path, r.URL.Query().Get("model"))
		}
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer func() { _ = conn.Close(websocket.StatusNormalClosure, "") }()
		typ, data, err := conn.Read(r.Context())
		if err != nil {
			return
		}
		_ = conn.Write(r.Context(), typ, []byte("echo:"+string(data)))
	}))
	defer upstream.Close()
	seedVoiceRoute(t, "realtime", upstream.URL+"/v1", "realtime-test-model")

	conv := w16CreateConv(t)
	t.Cleanup(func() { deleteConversations(t, conv.ID) })
	session := w16CreateSession(t, conv, "realtime")
	var issued struct {
		Token         string `json:"token"`
		ProxyEndpoint string `json:"proxy_endpoint"`
	}
	env.mustJSON(t, "POST", "/api/v1/agent/voice-sessions/"+session.ID+"/realtime-token", map[string]any{}, &issued)
	if issued.Token == "" || !strings.HasSuffix(issued.ProxyEndpoint, "/realtime-ws") {
		t.Fatalf("凭据/代理端点不符：%+v", issued)
	}

	wsURL := "ws" + strings.TrimPrefix(env.http.URL, "http") + issued.ProxyEndpoint + "?token=" + url.QueryEscape(issued.Token)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{HTTPClient: env.client})
	if err != nil {
		t.Fatalf("连接代理失败：%v", err)
	}
	defer func() { _ = conn.Close(websocket.StatusNormalClosure, "") }()
	if err := conn.Write(ctx, websocket.MessageText, []byte("hello")); err != nil {
		t.Fatalf("发送失败：%v", err)
	}
	_, reply, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("读取回包失败：%v", err)
	}
	if string(reply) != "echo:hello" {
		t.Fatalf("代理透传内容不符：%q", reply)
	}
	env.mustJSON(t, "PATCH", "/api/v1/agent/voice-sessions/"+session.ID, map[string]any{"state": "ended"}, nil)
}

// TestW16V08RealtimeProxyRejectsBadToken：令牌错误 403、过期 401、缺 token 422。
func TestW16V08RealtimeProxyRejectsBadToken(t *testing.T) {
	clearAgentFeatureSettings(t)
	t.Setenv(agentWorkbenchFeatureEnv, "run_control,event_resume,plans,goals,artifacts,voice_dictation,voice_realtime")
	seedVoiceRoute(t, "realtime", "http://127.0.0.1:1/v1", "realtime-test-model")
	conv := w16CreateConv(t)
	t.Cleanup(func() { deleteConversations(t, conv.ID) })
	session := w16CreateSession(t, conv, "realtime")
	var issued struct {
		Token string `json:"token"`
	}
	env.mustJSON(t, "POST", "/api/v1/agent/voice-sessions/"+session.ID+"/realtime-token", map[string]any{}, &issued)

	base := "/api/v1/agent/voice-sessions/" + session.ID + "/realtime-ws"
	env.expectErr(t, "GET", base, nil, "validation_failed")
	env.expectErr(t, "GET", base+"?token=wrong-token", nil, "realtime_token_invalid")

	if _, err := env.srv.db.Exec(t.Context(), `UPDATE agent_voice_session
		SET route_snapshot = jsonb_set(route_snapshot, '{realtime_token_exp}', to_jsonb($2::text))
		WHERE id=$1`, session.ID, time.Now().Add(-time.Minute).UTC().Format(time.RFC3339)); err != nil {
		t.Fatal(err)
	}
	env.expectErr(t, "GET", base+"?token="+url.QueryEscape(issued.Token), nil, "realtime_token_expired")
	env.mustJSON(t, "PATCH", "/api/v1/agent/voice-sessions/"+session.ID, map[string]any{"state": "ended"}, nil)
}
