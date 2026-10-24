package app

import (
	"context"
	"testing"
)

// DEV-AS15 定向测试：每平台同步能力开关（20 文档 §21.15）此前只能由 e2e fixture
// 直写 system_setting，超管没有任何启用入口。本测试锁定两件事：
//  1. 超管设置页写入的键（platformFeatureKey）与调度读取的键完全一致；
//  2. 默认全部关闭，打开后 platformSyncFeatureEnabled 才放行。
func TestPlatformFeatureFlagAdminRoundTrip(t *testing.T) {
	withDesktopPlatformEnabled(t, true)
	ctx := context.Background()
	for _, feature := range []string{"account_sync", "metrics_refresh"} {
		for _, platform := range []string{"xhs", "wechat_mp"} {
			key := platformFeatureKey(feature, platform)
			if env.srv.platformSyncFeatureEnabled(ctx, feature, platform) {
				t.Fatalf("%s 默认应为关闭", key)
			}
			if err := env.srv.putSystemBool(ctx, key, true); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = env.srv.putSystemBool(ctx, key, false) })
			if !env.srv.platformSyncFeatureEnabled(ctx, feature, platform) {
				t.Fatalf("写入 %s=true 后 platformSyncFeatureEnabled 应放行", key)
			}
		}
	}
	flags, err := env.srv.adminPlatformFeatureFlags(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, feature := range []string{"account_sync", "metrics_refresh"} {
		for _, platform := range []string{"xhs", "wechat_mp"} {
			if !flags[feature][platform] {
				t.Fatalf("adminPlatformFeatureFlags 应如实回报 %s/%s 为开启", feature, platform)
			}
		}
	}
}

func TestPlatformFeatureFlagDisabledWhenGloballyOff(t *testing.T) {
	withDesktopPlatformEnabled(t, false)
	ctx := context.Background()
	key := platformFeatureKey("account_sync", "xhs")
	if err := env.srv.putSystemBool(ctx, key, true); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = env.srv.putSystemBool(ctx, key, false) })
	if env.srv.platformSyncFeatureEnabled(ctx, "account_sync", "xhs") {
		t.Fatal("进程配置关闭时每平台开关不得单独放行")
	}
}
