package app

import (
	"strings"
	"testing"
)

// OPT-U06（docs/43 §4）：能力接口在平台采集关闭时如实透出禁用原因与可读提示；
// 开启时必须完全省略两个键，避免客户端把“可用”误读成“被禁用”。
func TestDesktopCapabilitiesPlatformDisabledHint(t *testing.T) {
	readPlatformCollection := func(t *testing.T) map[string]any {
		t.Helper()
		var raw map[string]any
		env.mustJSON(t, "GET", "/api/v1/desktop/capabilities", nil, &raw)
		collection, ok := raw["platform_collection"].(map[string]any)
		if !ok {
			t.Fatalf("platform_collection 必须是 JSON 对象，实际 %T", raw["platform_collection"])
		}
		return collection
	}

	t.Run("启用时省略禁用字段", func(t *testing.T) {
		withDesktopPlatformEnabled(t, true)
		collection := readPlatformCollection(t)
		if collection["enabled"] != true {
			t.Fatalf("启用态 enabled 应为 true：%v", collection["enabled"])
		}
		for _, key := range []string{"disabled_reason", "disabled_hint"} {
			if _, exists := collection[key]; exists {
				t.Fatalf("启用态不应出现 %s 键：%v", key, collection[key])
			}
		}
	})

	t.Run("环境变量显式关闭", func(t *testing.T) {
		withDesktopPlatformEnabled(t, false)
		collection := readPlatformCollection(t)
		if collection["enabled"] != false {
			t.Fatalf("环境变量关闭时 enabled 应为 false：%v", collection["enabled"])
		}
		if collection["disabled_reason"] != "server_env_disabled" {
			t.Fatalf("disabled_reason 应为 server_env_disabled：%v", collection["disabled_reason"])
		}
		hint, _ := collection["disabled_hint"].(string)
		if !strings.Contains(hint, "OPS_DESKTOP_PLATFORM_ENABLED=1") {
			t.Fatalf("disabled_hint 应说明需要开启的环境变量：%q", hint)
		}
	})

	t.Run("kill switch 关闭", func(t *testing.T) {
		withDesktopPlatformEnabled(t, true)
		setKillSwitch(t, true)
		collection := readPlatformCollection(t)
		if collection["enabled"] != false {
			t.Fatalf("kill switch 开启时 enabled 应为 false：%v", collection["enabled"])
		}
		if collection["disabled_reason"] != "kill_switch_enabled" {
			t.Fatalf("disabled_reason 应为 kill_switch_enabled：%v", collection["disabled_reason"])
		}
		hint, _ := collection["disabled_hint"].(string)
		if !strings.Contains(hint, "kill switch") {
			t.Fatalf("disabled_hint 应明确说明全局总闸：%q", hint)
		}
		if strings.Contains(hint, "OPS_DESKTOP_PLATFORM_ENABLED") {
			t.Fatalf("kill switch 提示不应与环境变量关闭混淆：%q", hint)
		}
	})
}
