package app

// REF41 P4：能力表/禁用原因/四态文案/通道校准的纯函数与 HTTP 覆盖。
// 不连接真实平台；真实桌面在线仍由既有 platform_connection 事实判断。

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestP4CapabilityTableCoversThreePlatformsThreeChannels(t *testing.T) {
	if len(publishCapabilitySpecs) != 9 {
		t.Fatalf("want 9 specs, got %d", len(publishCapabilitySpecs))
	}
	seen := map[string]bool{}
	for _, spec := range publishCapabilitySpecs {
		key := spec.Platform + "/" + spec.Channel
		if seen[key] {
			t.Fatalf("duplicate capability %s", key)
		}
		seen[key] = true
		if !strings.Contains(publishCapabilityPlatforms, spec.Platform) {
			t.Fatalf("unknown platform %s", spec.Platform)
		}
		if !strings.Contains(publishCapabilityChannels, spec.Channel) {
			t.Fatalf("unknown channel %s", spec.Channel)
		}
		if strings.TrimSpace(spec.Why) == "" {
			t.Fatalf("%s why 不能为空", key)
		}
		if spec.Requires == nil {
			t.Fatalf("%s requires 必须是数组而不是 nil", key)
		}
	}
	for _, platform := range []string{"wechat_mp", "xhs", "toutiao"} {
		for _, channel := range []string{"api", "desktop", "manual"} {
			if _, ok := publishCapabilitySpecFor(platform, channel); !ok {
				t.Fatalf("能力表缺少 %s/%s", platform, channel)
			}
		}
	}
}

func TestP4CapabilityDisabledReasonsExplainAllThreeCases(t *testing.T) {
	wechatAPI, _ := publishCapabilitySpecFor("wechat_mp", "api")
	output := buildPublishCapability(wechatAPI, publishCapabilitySignals{})
	if output.Available {
		t.Fatal("缺少公众号凭证时 API 通道必须不可用")
	}
	if !strings.Contains(output.DisabledReason, "缺少公众号 AppID/Secret") {
		t.Fatalf("缺少凭证原因不明确: %s", output.DisabledReason)
	}

	xhsDesktop, _ := publishCapabilitySpecFor("xhs", "desktop")
	offline := buildPublishCapability(xhsDesktop, publishCapabilitySignals{CalibrationReason: "calibration_missing"})
	if offline.Available {
		t.Fatal("桌面离线时必须不可用")
	}
	if !strings.Contains(offline.DisabledReason, "桌面客户端未连接") ||
		!strings.Contains(offline.DisabledReason, "该账号尚未完成一次成功填写") {
		t.Fatalf("桌面离线+未校准原因不完整: %s", offline.DisabledReason)
	}
	for _, item := range []string{"desktop_online", "account_login", "adapter_calibrated"} {
		found := false
		for _, missing := range offline.Missing {
			if missing == item {
				found = true
			}
		}
		if !found {
			t.Fatalf("missing 缺少 %s: %#v", item, offline.Missing)
		}
	}

	onlineButUncalibrated := buildPublishCapability(xhsDesktop, publishCapabilitySignals{
		DesktopOnline: true, AccountLogin: true, CalibrationReason: "calibration_missing",
	})
	if onlineButUncalibrated.Available || !strings.Contains(onlineButUncalibrated.DisabledReason, "尚未完成一次成功填写") {
		t.Fatalf("在线未校准原因不正确: %#v", onlineButUncalibrated)
	}

	versionChanged := buildPublishCapability(xhsDesktop, publishCapabilitySignals{
		DesktopOnline: true, AccountLogin: true, AdapterVersion: "xhs-fill-v0",
		CurrentVersion: "xhs-fill-v1", CalibrationReason: "adapter_version_changed",
	})
	if versionChanged.Available || !strings.Contains(versionChanged.DisabledReason, "适配器版本已变化") {
		t.Fatalf("版本失效原因不正确: %#v", versionChanged)
	}

	manual, _ := publishCapabilitySpecFor("xhs", "manual")
	if !buildPublishCapability(manual, publishCapabilitySignals{}).Available {
		t.Fatal("manual 通道必须始终可用")
	}
	unsupported, _ := publishCapabilitySpecFor("wechat_mp", "desktop")
	if buildPublishCapability(unsupported, publishCapabilitySignals{}).Available {
		t.Fatal("unsupported 组合不能显示可用")
	}
}

func TestP4StateLabelsNeverFakePublished(t *testing.T) {
	for key, label := range PublishStateLabels {
		if key != "published" && strings.Contains(label, "已发布") {
			t.Fatalf("非 published 文案 %s 含“已发布”: %s", key, label)
		}
	}
	cases := []struct {
		platform      string
		taskState     string
		workPublished bool
		want          string
		// workPlatform 缺省等于 platform（同一平台）；跨平台用例显式给出。
		workPlatform string
	}{
		{"xhs", "", false, "素材已备好", ""},
		{"xhs", "packed", false, "素材已备好", ""},
		{"xhs", "filling", false, "素材已备好", ""},
		{"xhs", "filled", false, "已填入后台", ""},
		{"xhs", "awaiting_user", false, "已填入后台（待你点发布）", ""},
		{"xhs", "submitted", false, "已交接", ""},
		{"wechat_mp", "submitted", false, "已提交草稿箱", ""},
		{"xhs", "published", false, "已交接", ""},
		{"xhs", "submitted", true, "已发布", ""},
		{"xhs", "", true, "已发布", ""},
		// workPublished=true 但任务平台 ≠ 作品平台：不得出现“已发布”（P4-A3）。
		{"wechat_mp", "submitted", true, "已提交草稿箱", "xhs"},
		{"toutiao", "submitted", true, "已交接", "xhs"},
		{"toutiao", "", true, "素材已备好", "xhs"},
		// 作品平台未知（空）时按旧语义兜底。
		{"xhs", "submitted", true, "已发布", ""},
	}
	for _, c := range cases {
		workPlatform := c.workPlatform
		if workPlatform == "" {
			workPlatform = c.platform
		}
		got := PublishStateLabel(c.platform, c.taskState, c.workPublished, workPlatform)
		if got != c.want {
			t.Fatalf("%s/%s workPublished=%v workPlatform=%s => %q, want %q", c.platform, c.taskState, c.workPublished, workPlatform, got, c.want)
		}
	}
}

func TestP4WechatDraftIsNotPublished(t *testing.T) {
	if got := PublishStateLabel("wechat_mp", "submitted", false, "wechat_mp"); got == "已发布" {
		t.Fatal("公众号草稿不能显示已发布")
	}
	if got := PublishStateLabel("wechat_mp", "submitted", false, "wechat_mp"); got != "已提交草稿箱" {
		t.Fatalf("公众号草稿文案错误: %q", got)
	}
	// xhs 已发布不影响 wechat_mp submitted 文案（P4-A5 跨平台口径）。
	if got := PublishStateLabel("wechat_mp", "submitted", true, "xhs"); got == "已发布" {
		t.Fatal("xhs 发布后公众号 submitted 任务不得显示已发布")
	}
	if got := PublishStateLabel("wechat_mp", "submitted", true, "xhs"); got != "已提交草稿箱" {
		t.Fatalf("xhs 发布后公众号 submitted 文案错误: %q", got)
	}
}

func TestP4ChannelStateVersionInvalidation(t *testing.T) {
	now := time.Now()
	ok, reason := PublishChannelCalibrated(nil, "", "xhs-fill-v1")
	if ok || reason != "calibration_missing" {
		t.Fatalf("未成功不应校准: %v %s", ok, reason)
	}
	stored := now
	ok, reason = PublishChannelCalibrated(&stored, "xhs-fill-v1", "xhs-fill-v2")
	if ok || reason != "adapter_version_changed" {
		t.Fatalf("版本变化应失效: %v %s", ok, reason)
	}
	ok, reason = PublishChannelCalibrated(&stored, "xhs-fill-v1", "xhs-fill-v1")
	if !ok || reason != "" {
		t.Fatalf("同版本成功应校准: %v %s", ok, reason)
	}
}

func TestP4ChannelStateWriteOnSuccessAndFailure(t *testing.T) {
	ctx := context.Background()
	var account Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{
		"platform": "xhs", "name": "P4 通道写库", "content_format": "image_note",
	}, &account)
	userID := uuid.MustParse(env.me(t).UserID)
	task := &PublishTask{AccountID: account.ID, Platform: "xhs", Mode: "desktop"}

	successEvidence := map[string]any{"readback": map[string]any{
		"ok": true, "adapter_version": "xhs-fill-v1",
	}}
	if err := env.srv.withTx(ctx, func(tx pgx.Tx) error {
		return env.srv.recordPublishChannelSuccess(ctx, tx, task, successEvidence, userID)
	}); err != nil {
		t.Fatal(err)
	}
	var adapterVersion string
	var lastSuccess, lastFailure *time.Time
	if err := env.srv.db.QueryRow(ctx, `SELECT adapter_version,last_success_at,last_failure_at
		FROM publish_channel_state WHERE account_id=$1 AND platform='xhs' AND channel='desktop'`,
		account.ID).Scan(&adapterVersion, &lastSuccess, &lastFailure); err != nil {
		t.Fatal(err)
	}
	if adapterVersion != "xhs-fill-v1" || lastSuccess == nil || lastFailure != nil {
		t.Fatalf("成功校准未落账: version=%q success=%v failure=%v", adapterVersion, lastSuccess, lastFailure)
	}

	if err := env.srv.withTx(ctx, func(tx pgx.Tx) error {
		return env.srv.recordPublishChannelFailure(ctx, tx, task, "readback_mismatch", "回读不一致")
	}); err != nil {
		t.Fatal(err)
	}
	if err := env.srv.db.QueryRow(ctx, `SELECT adapter_version,last_success_at,last_failure_at
		FROM publish_channel_state WHERE account_id=$1 AND platform='xhs' AND channel='desktop'`,
		account.ID).Scan(&adapterVersion, &lastSuccess, &lastFailure); err != nil {
		t.Fatal(err)
	}
	if lastSuccess == nil || lastFailure == nil {
		t.Fatalf("失败不得清掉 last_success: success=%v failure=%v", lastSuccess, lastFailure)
	}
	// 缺 adapter_version 的旧 evidence 不能把账号伪造成已校准。
	var empty Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{
		"platform": "xhs", "name": "P4 空回读", "content_format": "image_note",
	}, &empty)
	emptyTask := &PublishTask{AccountID: empty.ID, Platform: "xhs", Mode: "desktop"}
	if err := env.srv.withTx(ctx, func(tx pgx.Tx) error {
		return env.srv.recordPublishChannelSuccess(ctx, tx, emptyTask,
			map[string]any{"readback": map[string]any{"ok": true}}, userID)
	}); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := env.srv.db.QueryRow(ctx, `SELECT count(*) FROM publish_channel_state WHERE account_id=$1`, empty.ID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("缺版本的成功不能写校准: count=%d err=%v", count, err)
	}
}

func TestP4CapabilitiesHTTPAndDisabledReasons(t *testing.T) {
	ctx := context.Background()
	createAccount := func(platform, name string) Account {
		var a Account
		env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{
			"platform": platform, "name": name, "content_format": map[string]string{
				"wechat_mp": "long_article", "xhs": "image_note", "toutiao": "long_article",
			}[platform],
		}, &a)
		return a
	}
	load := func(accountID uuid.UUID) []PublishCapabilityPlatform {
		var out []PublishCapabilityPlatform
		env.mustJSON(t, "GET", "/api/v1/publish/capabilities?account_id="+accountID.String(), nil, &out)
		return out
	}
	find := func(out []PublishCapabilityPlatform, platform, channel string) PublishCapabilityChannel {
		for _, p := range out {
			if p.Platform != platform {
				continue
			}
			for _, c := range p.Channels {
				if c.Channel == channel {
					return c
				}
			}
		}
		t.Fatalf("能力表缺少 %s/%s", platform, channel)
		return PublishCapabilityChannel{}
	}

	wechatNoCred := createAccount("wechat_mp", "P4 无凭证公众号")
	caps := load(wechatNoCred.ID)
	if len(caps) != 3 {
		t.Fatalf("want 3 platforms, got %d", len(caps))
	}
	for _, p := range caps {
		if len(p.Channels) != 3 {
			t.Fatalf("%s want 3 channels, got %d", p.Platform, len(p.Channels))
		}
	}
	api := find(caps, "wechat_mp", "api")
	if api.Available || !strings.Contains(api.DisabledReason, "缺少公众号 AppID/Secret") {
		t.Fatalf("无凭证公众号 API 能力错误: %#v", api)
	}
	if api.Requires[0] != "app_id_secret" || api.Why != "仅加草稿，不群发" || !api.DefaultOn {
		t.Fatalf("公众号 API 字段不完整: %#v", api)
	}

	xhsOffline := createAccount("xhs", "P4 离线小红书")
	caps = load(xhsOffline.ID)
	desktop := find(caps, "xhs", "desktop")
	if desktop.Available ||
		!strings.Contains(desktop.DisabledReason, "桌面客户端未连接") ||
		!strings.Contains(desktop.DisabledReason, "该账号尚未完成一次成功填写") {
		t.Fatalf("离线小红书能力错误: %#v", desktop)
	}
	if len(desktop.Requires) != 3 || desktop.Why != "网页无官方发布接口，只填不点" {
		t.Fatalf("小红书桌面字段不完整: %#v", desktop)
	}

	// 在线且登录但未成功填写：仍不可用，原因是未校准而不是离线。
	userID := uuid.MustParse(env.me(t).UserID)
	deviceID := platformTestDevice(t, userID)
	wsID := accountWorkspace(t, xhsOffline.ID)
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO platform_connection
		(workspace_id, account_id, platform, user_id, device_id, external_account_key, state, availability, last_seen_at)
		VALUES ($1,$2,'xhs',$3,$4,'xhs_user_id:p4-fixture','active','ready',now())`,
		wsID, xhsOffline.ID, userID, deviceID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(context.Background(), `DELETE FROM platform_connection WHERE account_id=$1`, xhsOffline.ID)
	})
	caps = load(xhsOffline.ID)
	desktop = find(caps, "xhs", "desktop")
	if desktop.Available || !strings.Contains(desktop.DisabledReason, "尚未完成一次成功填写") {
		t.Fatalf("在线未校准能力错误: %#v", desktop)
	}

	// 旧适配器版本成功过：版本变化后自动失效。
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO publish_channel_state
		(account_id,platform,channel,adapter_version,last_success_at)
		VALUES ($1,'xhs','desktop','xhs-fill-v0',now())`, xhsOffline.ID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(context.Background(), `DELETE FROM publish_channel_state WHERE account_id=$1`, xhsOffline.ID)
	})
	caps = load(xhsOffline.ID)
	desktop = find(caps, "xhs", "desktop")
	if desktop.Available || !strings.Contains(desktop.DisabledReason, "适配器版本已变化") {
		t.Fatalf("版本失效能力错误: %#v", desktop)
	}

	// labels 是唯一文案来源。
	var labels struct {
		Labels map[string]string `json:"labels"`
	}
	env.mustJSON(t, "GET", "/api/v1/publish/labels", nil, &labels)
	for _, key := range []string{"packed", "filled", "submitted", "published", "submitted_wechat_mp"} {
		if strings.TrimSpace(labels.Labels[key]) == "" {
			t.Fatalf("labels 缺少 %s", key)
		}
	}

	// 跨工作区账号必须 404，不能借能力接口读别人的账号。
	guest := env.registerClient(t, "p4-guest", "p4-guest-password-123")
	defer guest.restore(env)
	var guestAccount Account
	guest.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{
		"platform": "xhs", "name": "P4 他人工作区", "content_format": "image_note",
	}, &guestAccount)
	guest.restore(env)
	status, body := env.do("GET", "/api/v1/publish/capabilities?account_id="+guestAccount.ID.String(), nil)
	if status != http.StatusNotFound {
		t.Fatalf("跨工作区能力接口应 404，got %d %s", status, body)
	}
}
