package app

import (
	"context"
	"strings"
	"testing"
)

// DEV-U102（12 文档）：公众号发布链路预检——用 add_material 上传一张测试图，
// 验证 从 access_token 到素材上传 的完整链路；不写草稿、不产生 push_record。
func TestU102WechatLinkCheck(t *testing.T) {
	f := env.accounts(t)

	var before int
	_ = env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM push_record`).Scan(&before)

	var out struct {
		OK        bool   `json:"ok"`
		MediaID   string `json:"media_id"`
		LatencyMS int64  `json:"latency_ms"`
		Message   string `json:"message"`
	}
	env.mustJSON(t, "POST", "/api/v1/accounts/"+f.wechat.ID.String()+"/wechat/link-check", nil, &out)
	if !out.OK || out.MediaID == "" || out.Message == "" {
		t.Fatalf("link check: %+v", out)
	}

	var after int
	_ = env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM push_record`).Scan(&after)
	if before != after {
		t.Fatalf("link check created push_record: %d -> %d", before, after)
	}

	// 未配置凭证的公众号：明确提示先填凭证。
	var a Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{"platform": "wechat_mp", "name": "预检未配置", "content_format": "long_article"}, &a)
	env.expectErr(t, "POST", "/api/v1/accounts/"+a.ID.String()+"/wechat/link-check", nil, "validation_failed")

	// 小红书账号：不支持。
	env.expectErr(t, "POST", "/api/v1/accounts/"+f.xhs.ID.String()+"/wechat/link-check", nil, "validation_failed")

	// 坏凭证（IP 白名单未放行）：链路预检返回 ok=false 与可读错误，不泄露 secret。
	env.reauth(t)
	var a2 Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{"platform": "wechat_mp", "name": "预检坏凭证", "content_format": "long_article"}, &a2)
	env.mustJSON(t, "PUT", "/api/v1/accounts/"+a2.ID.String()+"/wechat-credential", map[string]string{"app_id": "wx-ip-blocked", "app_secret": "s3cret-link-check"}, nil)
	var bad struct {
		OK      bool   `json:"ok"`
		Message string `json:"message"`
	}
	env.mustJSON(t, "POST", "/api/v1/accounts/"+a2.ID.String()+"/wechat/link-check", nil, &bad)
	if bad.OK || !strings.Contains(bad.Message, "白名单") {
		t.Fatalf("bad credential link check: %+v", bad)
	}
	if strings.Contains(bad.Message, "s3cret-link-check") {
		t.Fatalf("link check leaked secret: %s", bad.Message)
	}
}
