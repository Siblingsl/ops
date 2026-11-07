package app

import (
	"context"
	"log/slog"
	"os"
	"strings"
)

// D-160 运行时闸门：system_setting 为日常真源，env 显式关闭为紧急全关。

const (
	desktopAIEnabledKey          = "desktop.ai_enabled"
	desktopPlatformAutoAdoptKey  = "desktop.platform_auto_adopt"
)

func envExplicitFalse(key string) bool {
	v := strings.ToLower(strings.TrimSpace(os.Getenv(key)))
	return v == "0" || v == "false"
}

func agentEnvEmergencyOff() bool {
	v := strings.ToLower(strings.TrimSpace(os.Getenv(agentWorkbenchFeatureEnv)))
	return v == "0" || v == "false" || v == "off"
}

func agentFeatureKey(name string) string {
	return "agent.feature." + name
}

func (s *Server) desktopAIEnabled(ctx context.Context) bool {
	if envExplicitFalse("OPS_DESKTOP_AI_ENABLED") {
		return false
	}
	on, err := s.systemBool(ctx, desktopAIEnabledKey, false)
	if err != nil {
		slog.Error("读取桌面 AI 开关失败，按关闭处理", "err", err)
		return false
	}
	return on
}

func (s *Server) desktopPlatformAutoAdoptEnabled(ctx context.Context) bool {
	if envExplicitFalse("OPS_DESKTOP_PLATFORM_AUTO_ADOPT") {
		return false
	}
	on, err := s.systemBool(ctx, desktopPlatformAutoAdoptKey, false)
	if err != nil {
		slog.Error("读取平台自动采用开关失败，按关闭处理", "err", err)
		return false
	}
	return on
}

func (s *Server) systemSettingExists(ctx context.Context, key string) (bool, error) {
	var n int
	err := s.db.QueryRow(ctx, `SELECT count(*) FROM system_setting WHERE key=$1`, key).Scan(&n)
	if err != nil {
		if strings.Contains(err.Error(), "system_setting") {
			return false, nil
		}
		return false, err
	}
	return n > 0, nil
}

// SeedDesktopAIFromConfig 仅在 desktop.ai_enabled 键尚不存在时，把启动配置
// OPS_DESKTOP_AI_ENABLED=true 写入 DB（一次性种子，启动时调用；之后以超管 DB 为准，
// env 显式 0/false 仍是紧急全关）。D-160 闸门化后 config 字段不再被读路径消费，
// 缺这个种子会让 OPS_DESKTOP_AI_ENABLED=1 / OPS_E2E_DESKTOP_AI_ENABLED=1 静默失效。
func (s *Server) SeedDesktopAIFromConfig(ctx context.Context) {
	if envExplicitFalse("OPS_DESKTOP_AI_ENABLED") || !s.cfg.DesktopAIEnabled {
		return
	}
	exists, err := s.systemSettingExists(ctx, desktopAIEnabledKey)
	if err != nil || exists {
		return
	}
	if err := s.putSystemBool(ctx, desktopAIEnabledKey, true); err != nil {
		slog.Error("种子写入桌面 AI 开关失败", "err", err)
	}
}

// SeedAgentFeaturesFromEnv 仅在对应键尚不存在时把 env 逗号列表写入 DB（一次性种子，启动时调用）。
func (s *Server) SeedAgentFeaturesFromEnv(ctx context.Context) {
	if agentEnvEmergencyOff() {
		return
	}
	raw := strings.TrimSpace(os.Getenv(agentWorkbenchFeatureEnv))
	if raw == "" {
		return
	}
	known := make(map[string]bool, len(agentWorkbenchFeatureNames))
	for _, name := range agentWorkbenchFeatureNames {
		known[name] = true
	}
	for _, name := range strings.Split(raw, ",") {
		name = strings.TrimSpace(name)
		if !known[name] {
			continue
		}
		exists, err := s.systemSettingExists(ctx, agentFeatureKey(name))
		if err != nil || exists {
			continue
		}
		if err := s.putSystemBool(ctx, agentFeatureKey(name), true); err != nil {
			slog.Error("种子写入智能体特性失败", "feature", name, "err", err)
		}
	}
}

func applyAgentFeatureDeps(features map[string]bool) map[string]bool {
	// 27 §15.3：browser_workspace（配对/授权/工作区浏览）依赖 chrome_connect；
	// 浏览器控制（后续 browser_control/租约派发）才依赖 event_resume 与 run_control。
	if features["browser_workspace"] && !features["chrome_connect"] {
		features["browser_workspace"] = false
	}
	if features["goals"] && (!features["event_resume"] || !features["run_control"] || !features["plans"]) {
		features["goals"] = false
	}
	if features["routines"] && (!features["event_resume"] || !features["run_control"] || !features["plans"] || !features["goals"] || !features["artifacts"]) {
		features["routines"] = false
	}
	return features
}

func (s *Server) agentWorkbenchFeatures(ctx context.Context) map[string]bool {
	features := make(map[string]bool, len(agentWorkbenchFeatureNames))
	for _, name := range agentWorkbenchFeatureNames {
		features[name] = false
	}
	if agentEnvEmergencyOff() {
		return applyAgentFeatureDeps(features)
	}
	// 非空逗号列表：进程内以 env 为准（兼容既有单测 Setenv；生产应留空，改走超管 DB）。
	// 不在读路径写库，避免污染共享测试库；一次性种子只在 Serve 启动时执行。
	if raw := strings.TrimSpace(os.Getenv(agentWorkbenchFeatureEnv)); raw != "" {
		return applyAgentFeatureDeps(agentFeaturesFromList(raw))
	}
	for _, name := range agentWorkbenchFeatureNames {
		on, err := s.systemBool(ctx, agentFeatureKey(name), false)
		if err != nil {
			slog.Error("读取智能体特性失败，按关闭处理", "feature", name, "err", err)
			continue
		}
		features[name] = on
	}
	return applyAgentFeatureDeps(features)
}
