package app

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

// REF41 I7：UTM 参数稳定、同 work+platform 幂等、禁止平台 422。
func TestI7ConversionLinksUTMAndForbiddenPlatforms(t *testing.T) {
	a := drAccount(t, "wechat_mp", "I7 UTM 验收号")
	wk := drWork(t, a, "I7 UTM 验收作品", "drafting", nil)
	path := "/api/v1/works/" + wk.ID.String() + "/conversion-links"

	var link conversionLink
	env.mustJSON(t, "POST", path, map[string]any{
		"platform": "wechat_mp", "target_url": "https://example.com/i7?from=ops",
	}, &link)
	if link.Code == "" || len(link.Code) != 12 || link.Status != "active" {
		t.Fatalf("link shape: %+v", link)
	}
	u, err := url.Parse(link.URL)
	if err != nil {
		t.Fatal(err)
	}
	q := u.Query()
	if q.Get("utm_source") != "wechat_mp" || q.Get("utm_medium") != "article" || q.Get("ops_code") != link.Code {
		t.Fatalf("utm query: %s", link.URL)
	}
	if q.Get("utm_campaign") == "" || !strings.HasPrefix(q.Get("utm_campaign"), "w-") {
		t.Fatalf("campaign must be stable and work-scoped: %s", link.URL)
	}
	if strings.Contains(link.URL, a.ID.String()) || strings.Contains(link.URL, wk.ID.String()) {
		t.Fatalf("URL must not expose internal ids: %s", link.URL)
	}

	var again conversionLink
	env.mustJSON(t, "POST", path, map[string]any{
		"platform": "wechat_mp", "target_url": "https://example.com/i7?from=ops",
	}, &again)
	if again.Code != link.Code || again.UTMCampaign != link.UTMCampaign {
		t.Fatalf("same work+platform must be idempotent: %+v vs %+v", link, again)
	}

	ae := env.expectErr(t, "POST", path, map[string]any{
		"platform": "wechat_mp", "target_url": "https://example.com/other",
	}, "conversion_link_exists")
	_ = ae

	var updated conversionLink
	env.mustJSON(t, "PUT", path+"/"+link.ID.String(), map[string]any{
		"target_url": "https://example.com/new",
	}, &updated)
	if updated.Code == link.Code || updated.TargetURL != "https://example.com/new" {
		t.Fatalf("PUT must create a new active link: %+v", updated)
	}
	var links struct {
		Links []conversionLink `json:"links"`
	}
	env.mustJSON(t, "GET", path, nil, &links)
	if len(links.Links) != 2 {
		t.Fatalf("old disabled link must be retained: %+v", links.Links)
	}
	var old, fresh conversionLink
	for _, l := range links.Links {
		if l.ID == link.ID {
			old = l
		}
		if l.ID == updated.ID {
			fresh = l
		}
	}
	if old.Status != "disabled" || fresh.Status != "active" {
		t.Fatalf("link statuses: old=%+v fresh=%+v", old, fresh)
	}

	xhs := drAccount(t, "xhs", "I7 禁止外链验收号")
	xwk := drWork(t, xhs, "I7 小红书作品", "drafting", nil)
	xpath := "/api/v1/works/" + xwk.ID.String() + "/conversion-links"
	env.expectErr(t, "POST", xpath, map[string]any{
		"platform": "wechat_mp", "target_url": "https://example.com/xhs",
	}, "conversion_platform_forbidden")
	env.expectErr(t, "POST", xpath, map[string]any{
		"platform": "xhs", "target_url": "https://example.com/xhs",
	}, "conversion_platform_forbidden")

	env.expectErr(t, "POST", path, map[string]any{
		"platform": "wechat_mp", "target_url": "javascript:alert(1)",
	}, "validation_failed")
}

// REF41 I7：签名、时间窗、幂等、PII 拒绝与复盘汇总。
func TestI7ConversionSignatureIdempotencyAndSummary(t *testing.T) {
	a := drAccount(t, "wechat_mp", "I7 回传验收号")
	pub := env.srv.today().AddDate(0, 0, -1)
	wk := drWork(t, a, "I7 回传验收作品", "published", &pub)
	path := "/api/v1/works/" + wk.ID.String() + "/conversion-links"
	var link conversionLink
	env.mustJSON(t, "POST", path, map[string]any{
		"platform": "wechat_mp", "target_url": "https://example.com/i7-sign",
	}, &link)
	env.mustJSON(t, "POST", "/api/v1/works/"+wk.ID.String()+"/metrics", map[string]any{
		"captured_at": time.Now().Format(time.RFC3339), "reads": 1000,
	}, nil)

	var token conversionIngestToken
	env.mustJSON(t, "POST", "/api/v1/conversion-ingest-tokens", map[string]any{"name": "I7 回传 token"}, &token)
	if token.Token == "" || len(token.Token) < 32 {
		t.Fatalf("raw token must be returned once: %+v", token)
	}

	body := []byte(`{"event":"register","external_id":"order-i7-1","occurred_at":"` + time.Now().Format(time.RFC3339) + `","value_cents":0,"currency":"CNY","payload":{"channel":"wechat","plan":"pro"}}`)
	sig := "sha256=" + conversionTestHMAC(token.Token, body)
	headers := map[string]string{conversionTokenHeader: token.Token, conversionSignatureHeader: sig}
	var resp struct {
		OK        bool `json:"ok"`
		Duplicate bool `json:"duplicate"`
	}
	env.mustJSONStatusHeader(t, "POST", "/api/v1/public/conversion/"+link.Code, json.RawMessage(body), &resp, 200, headers)
	if !resp.OK || resp.Duplicate {
		t.Fatalf("first event: %+v", resp)
	}
	env.mustJSONStatusHeader(t, "POST", "/api/v1/public/conversion/"+link.Code, json.RawMessage(body), &resp, 200, headers)
	if !resp.Duplicate {
		t.Fatalf("duplicate event must be flagged: %+v", resp)
	}

	env.mustJSONStatusHeader(t, "POST", "/api/v1/public/conversion/"+link.Code, json.RawMessage(body), nil, 401, map[string]string{
		conversionTokenHeader: token.Token, conversionSignatureHeader: "sha256=deadbeef",
	})
	oldBody := []byte(`{"event":"register","external_id":"order-i7-old","occurred_at":"` + time.Now().Add(-8*24*time.Hour).Format(time.RFC3339) + `"}`)
	env.mustJSONStatusHeader(t, "POST", "/api/v1/public/conversion/"+link.Code, json.RawMessage(oldBody), nil, 422, map[string]string{
		conversionTokenHeader: token.Token, conversionSignatureHeader: "sha256=" + conversionTestHMAC(token.Token, oldBody),
	})
	piiBody := []byte(`{"event":"register","external_id":"order-i7-pii","occurred_at":"` + time.Now().Format(time.RFC3339) + `","payload":{"email":"a@b.com"}}`)
	env.mustJSONStatusHeader(t, "POST", "/api/v1/public/conversion/"+link.Code, json.RawMessage(piiBody), nil, 422, map[string]string{
		conversionTokenHeader: token.Token, conversionSignatureHeader: "sha256=" + conversionTestHMAC(token.Token, piiBody),
	})

	// 缺 token 与撤销后的 token 都必须 401；不能把空 token 当成“跳过校验”。
	missingTokenBody := []byte(`{"event":"register","external_id":"order-i7-no-token","occurred_at":"` + time.Now().Format(time.RFC3339) + `"}`)
	env.mustJSONStatusHeader(t, "POST", "/api/v1/public/conversion/"+link.Code, json.RawMessage(missingTokenBody), nil, 401, map[string]string{
		conversionSignatureHeader: "sha256=deadbeef",
	})
	env.mustJSON(t, "DELETE", "/api/v1/conversion-ingest-tokens/"+token.ID.String(), nil, nil)
	revokedBody := []byte(`{"event":"register","external_id":"order-i7-revoked","occurred_at":"` + time.Now().Format(time.RFC3339) + `"}`)
	env.mustJSONStatusHeader(t, "POST", "/api/v1/public/conversion/"+link.Code, json.RawMessage(revokedBody), nil, 401, map[string]string{
		conversionTokenHeader: token.Token, conversionSignatureHeader: "sha256=" + conversionTestHMAC(token.Token, revokedBody),
	})

	var summary conversionSummary
	env.mustJSON(t, "GET", "/api/v1/accounts/"+a.ID.String()+"/conversions", nil, &summary)
	if !summary.Connected || len(summary.Works) != 1 {
		t.Fatalf("summary: %+v", summary)
	}
	x := summary.Works[0]
	if x.Register != 1 || x.Paid != 0 || x.Lead != 0 || x.Events != 1 {
		t.Fatalf("summary counts: %+v", x)
	}
	if x.Reads == nil || *x.Reads != 1000 || x.ConversionRate == nil || *x.ConversionRate != 0.1 {
		t.Fatalf("conversion rate must use reads: %+v", x)
	}

	var manual struct {
		OK bool `json:"ok"`
	}
	env.mustJSON(t, "POST", "/api/v1/conversion-links/"+link.ID.String()+"/manual-event", map[string]any{
		"event": "paid", "external_id": "manual-i7-1", "occurred_at": time.Now().Format(time.RFC3339),
		"value_cents": 9900, "currency": "CNY", "note": "线下成交补录",
	}, &manual)
	if !manual.OK {
		t.Fatalf("manual event: %+v", manual)
	}
	env.mustJSON(t, "GET", "/api/v1/accounts/"+a.ID.String()+"/conversions", nil, &summary)
	x = summary.Works[0]
	if x.Paid != 1 || x.AmountCents != 9900 {
		t.Fatalf("manual event must be counted: %+v", x)
	}
}

func conversionTestHMAC(token string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(token))
	_, _ = mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}

// REF41 I7-A3：跨工作区 code 统一 404，不泄露存在性。
func TestI7ConversionCrossWorkspaceNotFound(t *testing.T) {
	ctx := context.Background()
	a := drAccount(t, "wechat_mp", "I7 跨租户验收号")
	wk := drWork(t, a, "I7 跨租户作品", "drafting", nil)
	path := "/api/v1/works/" + wk.ID.String() + "/conversion-links"
	var linkA conversionLink
	env.mustJSON(t, "POST", path, map[string]any{
		"platform": "wechat_mp", "target_url": "https://example.com/tenant-a",
	}, &linkA)
	var tokenA conversionIngestToken
	env.mustJSON(t, "POST", "/api/v1/conversion-ingest-tokens", map[string]any{"name": "I7 跨租户 token A"}, &tokenA)

	var me struct {
		Workspace struct {
			ID uuid.UUID `json:"id"`
		} `json:"workspace"`
	}
	env.mustJSON(t, "GET", "/api/v1/auth/me", nil, &me)
	initial := me.Workspace.ID
	var created struct {
		ID uuid.UUID `json:"id"`
	}
	env.mustJSON(t, "POST", "/api/v1/workspaces", map[string]any{"name": "I7 第二工作区", "switch": false}, &created)
	defer func() {
		_, _ = env.srv.db.Exec(ctx, `UPDATE session SET current_workspace_id=$2 WHERE current_workspace_id=$1`, created.ID, initial)
		_, _ = env.srv.db.Exec(ctx, `DELETE FROM workspace WHERE id=$1`, created.ID)
	}()
	env.mustJSON(t, "POST", "/api/v1/workspaces/"+created.ID.String()+"/switch", nil, nil)
	bAccount := drAccount(t, "wechat_mp", "I7 第二工作区账号")
	bWork := drWork(t, bAccount, "I7 第二工作区作品", "drafting", nil)
	var linkB conversionLink
	env.mustJSON(t, "POST", "/api/v1/works/"+bWork.ID.String()+"/conversion-links", map[string]any{
		"platform": "wechat_mp", "target_url": "https://example.com/tenant-b",
	}, &linkB)
	env.mustJSON(t, "POST", "/api/v1/workspaces/"+initial.String()+"/switch", nil, nil)

	body := []byte(`{"event":"register","external_id":"cross-tenant-i7","occurred_at":"` + time.Now().Format(time.RFC3339) + `"}`)
	env.mustJSONStatusHeader(t, "POST", "/api/v1/public/conversion/"+linkB.Code, json.RawMessage(body), nil, 404, map[string]string{
		conversionTokenHeader: tokenA.Token, conversionSignatureHeader: "sha256=" + conversionTestHMAC(tokenA.Token, body),
	})
}

// REF41 I7 exception：人工补录每天第 101 条必须 429，前 100 条正常入库。
func TestI7ManualConversionDailyLimit(t *testing.T) {
	a := drAccount(t, "wechat_mp", "I7 补录上限验收号")
	wk := drWork(t, a, "I7 补录上限作品", "drafting", nil)
	var link conversionLink
	env.mustJSON(t, "POST", "/api/v1/works/"+wk.ID.String()+"/conversion-links", map[string]any{
		"platform": "wechat_mp", "target_url": "https://example.com/manual-limit",
	}, &link)
	// 同一测试包共享工作区，前面的 I7 用例可能已产生 manual 事件；只清理本工作区当天的
	// manual 记录，保证本用例能验证精确的 100/101 边界，不影响非 manual 回传与链接数据。
	var wsID uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(), `SELECT workspace_id FROM conversion_link WHERE id=$1`, link.ID).Scan(&wsID); err != nil {
		t.Fatal(err)
	}
	now := env.srv.now().In(env.srv.loc)
	dayStart := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, env.srv.loc)
	if _, err := env.srv.db.Exec(context.Background(), `DELETE FROM conversion_event
		WHERE workspace_id=$1 AND manual=true AND received_at >= $2`, wsID, dayStart); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < conversionManualDailyMax; i++ {
		var ack struct {
			OK bool `json:"ok"`
		}
		env.mustJSON(t, "POST", "/api/v1/conversion-links/"+link.ID.String()+"/manual-event", map[string]any{
			"event": "register", "external_id": fmt.Sprintf("manual-limit-%d", i), "occurred_at": time.Now().Format(time.RFC3339), "note": "补录上限测试",
		}, &ack)
		if !ack.OK {
			t.Fatalf("manual event %d must succeed: %+v", i, ack)
		}
	}
	var over struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	env.mustJSONStatus(t, "POST", "/api/v1/conversion-links/"+link.ID.String()+"/manual-event", map[string]any{
		"event": "register", "external_id": "manual-limit-over", "occurred_at": time.Now().Format(time.RFC3339), "note": "补录上限测试",
	}, &over, 429)
	if over.Error.Code != "conversion_manual_daily_limit" {
		t.Fatalf("manual daily limit error code: %+v", over)
	}
}

// REF41 I7-A3：同一 token 每分钟第 61 次回传必须 429。
func TestI7ConversionRateLimit(t *testing.T) {
	a := drAccount(t, "wechat_mp", "I7 限流验收号")
	wk := drWork(t, a, "I7 限流作品", "drafting", nil)
	var link conversionLink
	env.mustJSON(t, "POST", "/api/v1/works/"+wk.ID.String()+"/conversion-links", map[string]any{
		"platform": "wechat_mp", "target_url": "https://example.com/rate",
	}, &link)
	var token conversionIngestToken
	env.mustJSON(t, "POST", "/api/v1/conversion-ingest-tokens", map[string]any{"name": "I7 限流 token"}, &token)
	for i := 0; i < conversionRateLimit; i++ {
		body := []byte(`{"event":"register","external_id":"rate-` + fmt.Sprintf("%d", i) + `","occurred_at":"` + time.Now().Format(time.RFC3339) + `"}`)
		env.mustJSONStatusHeader(t, "POST", "/api/v1/public/conversion/"+link.Code, json.RawMessage(body), nil, 200, map[string]string{
			conversionTokenHeader: token.Token, conversionSignatureHeader: "sha256=" + conversionTestHMAC(token.Token, body),
		})
	}
	body := []byte(`{"event":"register","external_id":"rate-61","occurred_at":"` + time.Now().Format(time.RFC3339) + `"}`)
	env.mustJSONStatusHeader(t, "POST", "/api/v1/public/conversion/"+link.Code, json.RawMessage(body), nil, 429, map[string]string{
		conversionTokenHeader: token.Token, conversionSignatureHeader: "sha256=" + conversionTestHMAC(token.Token, body),
	})
}
