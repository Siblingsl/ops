package app

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func wechatAPITestRequest(t *testing.T, token string, cover []byte) PublishFillRequest {
	t.Helper()
	payload := PublishManifestPayload{
		SchemaVersion: 1, Platform: "wechat_mp",
		Fields: PublishManifestFields{
			Title: "P8 公众号 API 草稿", BodyMD: "第一段正文\n\n第二段正文",
			BodyText:       "第一段正文\n第二段正文",
			PlatformFields: map[string]any{"author": "测试作者"},
		},
		Assets: []PublishManifestAsset{},
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	return PublishFillRequest{
		TaskID: uuid.New(), WorkspaceID: uuid.New(), AccountID: uuid.New(), WorkID: uuid.New(),
		Platform: "wechat_mp", Mode: "api", Manifest: raw,
		WechatToken: token, WechatCover: cover, WechatCoverName: "cover.png",
	}
}

func TestP8WechatAPIExecutorDraftOnly(t *testing.T) {
	a := drWechatAccount(t, "P8 公众号 API")
	ctx := context.Background()
	token, err := env.srv.accessToken(ctx, a.ID, false)
	if err != nil {
		t.Fatalf("accessToken: %v", err)
	}
	exec := newWechatMPAPIExecutor(env.srv.wx)
	req := wechatAPITestRequest(t, token, testPNG(900, 1200))
	result, err := RunPublishExecutor(ctx, exec, req, DefaultPublishExecutorTimeouts())
	if err != nil {
		t.Fatalf("RunPublishExecutor: %v", err)
	}
	if result.State != "submitted" {
		t.Fatalf("state = %q, want submitted; result=%+v", result.State, result)
	}
	if result.Evidence["draft_media_id"] == "" || result.Evidence["publish_mode"] != "draft" || result.Evidence["auto_publish"] != false {
		t.Fatalf("evidence = %+v", result.Evidence)
	}
	calls := env.mockWX.Calls()
	for _, want := range []string{"/cgi-bin/material/add_material", "/cgi-bin/draft/add", "/cgi-bin/draft/get"} {
		found := false
		for _, call := range calls {
			if call == want {
				found = true
			}
		}
		if !found {
			t.Fatalf("missing %s in calls %v", want, calls)
		}
	}
	for _, call := range calls {
		if strings.Contains(call, "mass") || strings.Contains(call, "freepublish") || strings.Contains(call, "publish") {
			t.Fatalf("API executor must not publish/mass-send: %s", call)
		}
	}

	// 同一 TaskID 再跑一次 Fill 复用已建草稿，不重复 draft/add；避免网络重试造出两篇草稿。
	before := 0
	for _, call := range calls {
		if call == "/cgi-bin/draft/add" {
			before++
		}
	}
	replay, err := exec.Fill(ctx, req)
	if err != nil {
		t.Fatalf("replay Fill: %v", err)
	}
	if replay.Evidence["idempotent_reuse"] != true {
		t.Fatalf("replay evidence = %+v", replay.Evidence)
	}
	after := 0
	for _, call := range env.mockWX.Calls() {
		if call == "/cgi-bin/draft/add" {
			after++
		}
	}
	if after != before {
		t.Fatalf("replay created another draft: before=%d after=%d", before, after)
	}
}

func TestP8WechatAPIExecutorRequiresTokenAndCover(t *testing.T) {
	exec := newWechatMPAPIExecutor(env.srv.wx)
	req := wechatAPITestRequest(t, "token", testPNG(900, 1200))
	req.WechatToken = ""
	if _, err := exec.Preflight(context.Background(), req); PublishExecutorErrorCode(err) != "wechat_token_missing" {
		t.Fatalf("missing token code = %q err=%v", PublishExecutorErrorCode(err), err)
	}
	req.WechatToken = "token"
	req.WechatCover = nil
	if _, err := exec.Preflight(context.Background(), req); PublishExecutorErrorCode(err) != "wechat_cover_missing" {
		t.Fatalf("missing cover code = %q err=%v", PublishExecutorErrorCode(err), err)
	}
}

func TestP8WechatAPIExecutorNilClientIsNotConfigured(t *testing.T) {
	exec := newWechatMPAPIExecutor(nil)
	req := wechatAPITestRequest(t, "token", testPNG(900, 1200))
	if _, err := exec.Preflight(context.Background(), req); PublishExecutorErrorCode(err) != "executor_not_configured" {
		t.Fatalf("nil client code = %q err=%v", PublishExecutorErrorCode(err), err)
	}
}
