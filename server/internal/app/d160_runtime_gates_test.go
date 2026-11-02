package app

import (
	"context"
	"net/http"
	"testing"
)

// D-160：方案 C — DB 日常真源 + env 紧急全关。

func TestD160PlatformGlobalEnabledUsesKillSwitchWithoutProcessEnv(t *testing.T) {
	ctx := context.Background()
	t.Setenv("OPS_DESKTOP_PLATFORM_ENABLED", "")
	env.srv.cfg.DesktopPlatformEnabled = false
	setKillSwitch(t, false)
	if !env.srv.platformCollectionGloballyEnabled(ctx) {
		t.Fatal("env 未设且 kill_switch=false 时平台进程闸应放行")
	}
	setKillSwitch(t, true)
	if env.srv.platformCollectionGloballyEnabled(ctx) {
		t.Fatal("kill_switch=true 必须关闭")
	}
	setKillSwitch(t, false)
	t.Setenv("OPS_DESKTOP_PLATFORM_ENABLED", "0")
	if env.srv.platformCollectionGloballyEnabled(ctx) {
		t.Fatal("env 紧急关必须强制不可用")
	}
}

func TestD160DesktopAIAndAutoAdoptFollowDBUnlessEnvEmergency(t *testing.T) {
	ctx := context.Background()
	t.Setenv("OPS_DESKTOP_AI_ENABLED", "")
	t.Setenv("OPS_DESKTOP_PLATFORM_AUTO_ADOPT", "")
	_ = env.srv.putSystemBool(ctx, desktopAIEnabledKey, false)
	_ = env.srv.putSystemBool(ctx, desktopPlatformAutoAdoptKey, false)
	t.Cleanup(func() {
		_ = env.srv.putSystemBool(ctx, desktopAIEnabledKey, false)
		_ = env.srv.putSystemBool(ctx, desktopPlatformAutoAdoptKey, false)
	})
	if env.srv.desktopAIEnabled(ctx) || env.srv.desktopPlatformAutoAdoptEnabled(ctx) {
		t.Fatal("DB 默认关时不应启用")
	}
	if err := env.srv.putSystemBool(ctx, desktopAIEnabledKey, true); err != nil {
		t.Fatal(err)
	}
	if err := env.srv.putSystemBool(ctx, desktopPlatformAutoAdoptKey, true); err != nil {
		t.Fatal(err)
	}
	if !env.srv.desktopAIEnabled(ctx) || !env.srv.desktopPlatformAutoAdoptEnabled(ctx) {
		t.Fatal("DB 打开后应启用")
	}
	t.Setenv("OPS_DESKTOP_AI_ENABLED", "0")
	t.Setenv("OPS_DESKTOP_PLATFORM_AUTO_ADOPT", "false")
	if env.srv.desktopAIEnabled(ctx) || env.srv.desktopPlatformAutoAdoptEnabled(ctx) {
		t.Fatal("env 紧急关应压过 DB")
	}
}

func TestD160AgentFeaturesDBAndEnvSeedAndEmergency(t *testing.T) {
	ctx := context.Background()
	clearAgentFeatureSettings(t)
	t.Setenv(agentWorkbenchFeatureEnv, "")
	feats := env.srv.agentWorkbenchFeatures(ctx)
	if feats["workbench_ui"] {
		t.Fatal("无 env、无 DB 时应全关")
	}

	t.Setenv(agentWorkbenchFeatureEnv, "workbench_ui,context_refs")
	feats = env.srv.agentWorkbenchFeatures(ctx)
	if !feats["workbench_ui"] || !feats["context_refs"] || feats["artifacts"] {
		t.Fatalf("env 列表应种子缺失键：%#v", feats)
	}
	// 超管关闭后 env 不得再次顶开（键已存在）。
	if err := env.srv.putSystemBool(ctx, agentFeatureKey("workbench_ui"), false); err != nil {
		t.Fatal(err)
	}
	feats = env.srv.agentWorkbenchFeatures(ctx)
	if feats["workbench_ui"] || !feats["context_refs"] {
		t.Fatalf("已有 DB 行不被 env 覆盖：%#v", feats)
	}

	t.Setenv(agentWorkbenchFeatureEnv, "off")
	feats = env.srv.agentWorkbenchFeatures(ctx)
	if feats["context_refs"] {
		t.Fatal("env 紧急全关必须压过 DB")
	}
}

func TestD160AdminSystemSettingsRuntimeGates(t *testing.T) {
	ctx := context.Background()
	clearAgentFeatureSettings(t)
	t.Setenv("OPS_DESKTOP_PLATFORM_ENABLED", "")
	t.Setenv("OPS_DESKTOP_AI_ENABLED", "")
	t.Setenv("OPS_DESKTOP_PLATFORM_AUTO_ADOPT", "")
	t.Setenv(agentWorkbenchFeatureEnv, "")

	st, body := env.do("POST", "/api/v1/auth/login", map[string]string{"username": "skyeder", "password": testAdminPassword})
	if st != 200 {
		t.Fatalf("登录超管失败：%d %s", st, body)
	}
	defer func() {
		st, body := env.do("POST", "/api/v1/auth/login", map[string]string{"username": "owner", "password": testPassword})
		if st != 200 {
			t.Fatalf("恢复 owner 失败：%d %s", st, body)
		}
		env.csrf = env.me(t).CSRF
	}()
	env.csrf = env.me(t).CSRF

	var got map[string]any
	env.mustJSON(t, http.MethodGet, "/api/v1/admin/system-settings", nil, &got)
	if _, ok := got["desktop_ai_enabled"]; !ok {
		t.Fatalf("GET 应含 desktop_ai_enabled: %#v", got)
	}
	if _, ok := got["agent_features"]; !ok {
		t.Fatalf("GET 应含 agent_features: %#v", got)
	}

	env.mustJSON(t, http.MethodPut, "/api/v1/admin/system-settings", map[string]any{
		"desktop_ai_enabled":          true,
		"desktop_platform_auto_adopt": true,
		"agent_feature":               map[string]any{"name": "workbench_ui", "enabled": true},
	}, &got)
	t.Cleanup(func() {
		_ = env.srv.putSystemBool(ctx, desktopAIEnabledKey, false)
		_ = env.srv.putSystemBool(ctx, desktopPlatformAutoAdoptKey, false)
		_ = env.srv.putSystemBool(ctx, agentFeatureKey("workbench_ui"), false)
	})
	if got["desktop_ai_enabled"] != true {
		t.Fatalf("PUT desktop_ai_enabled: %#v", got["desktop_ai_enabled"])
	}
	af, _ := got["agent_features"].(map[string]any)
	if af == nil || af["workbench_ui"] != true {
		t.Fatalf("PUT agent feature: %#v", got["agent_features"])
	}
	if !env.srv.desktopAIEnabled(ctx) || !env.srv.agentWorkbenchFeatures(ctx)["workbench_ui"] {
		t.Fatal("PUT 后运行时应生效")
	}

	guest := env.registerClient(t, "d160gate"+t.Name()[len(t.Name())-6:], testPassword)
	defer guest.restore(env)
	guest.expectErr(t, http.MethodPut, "/api/v1/admin/system-settings", map[string]any{
		"desktop_ai_enabled": false,
	}, "forbidden")
}

func clearAgentFeatureSettings(t *testing.T) {
	t.Helper()
	ctx := context.Background()
	for _, name := range agentWorkbenchFeatureNames {
		_, _ = env.srv.db.Exec(ctx, `DELETE FROM system_setting WHERE key=$1`, agentFeatureKey(name))
	}
	t.Cleanup(func() {
		for _, name := range agentWorkbenchFeatureNames {
			_, _ = env.srv.db.Exec(ctx, `DELETE FROM system_setting WHERE key=$1`, agentFeatureKey(name))
		}
	})
}
