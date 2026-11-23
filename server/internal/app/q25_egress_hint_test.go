package app

import (
	"strings"
	"testing"

	"ops/internal/config"
)

// Q-25（docs/41）：40164 提示里的 OPS_PUBLIC_IP 只是参考值——真实出口取决于是否
// 配置了 HTTP(S)_PROXY。两个分支（已配置/未配置）都必须带“以服务器实际网络为准”。
func TestQ25EgressHintQualifiesPublicIP(t *testing.T) {
	configured := &Server{cfg: &config.Config{PublicIP: "120.27.20.115"}}
	got := configured.egressHint()
	if !strings.Contains(got, "120.27.20.115") {
		t.Fatalf("已配置分支应包含 OPS_PUBLIC_IP，得到 %q", got)
	}
	if !strings.Contains(got, "以服务器实际网络为准") || !strings.Contains(got, "HTTP(S)_PROXY") {
		t.Fatalf("已配置分支缺少代理口径说明，得到 %q", got)
	}

	unconfigured := &Server{cfg: &config.Config{}}
	got = unconfigured.egressHint()
	if !strings.Contains(got, "未配置") || !strings.Contains(got, "以服务器实际网络为准") {
		t.Fatalf("未配置分支缺少口径说明，得到 %q", got)
	}

	dev := &Server{cfg: &config.Config{Dev: true}}
	if got := dev.egressHint(); !strings.Contains(got, "本地开发") {
		t.Fatalf("开发分支应说明模拟微信，得到 %q", got)
	}
}
