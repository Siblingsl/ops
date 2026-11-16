package app

import (
	"os"
	"testing"
	"time"
)

// TestRLoginWindow：同一 go test 进程内先跑本用例，给桌面执行器一个登录+待命窗口
// （TestMain 的库只在本进程生命周期有效；R 系列随后在同进程执行，owner 会话保持有效）。
// OPS_R_WINDOW_SECONDS 控制时长；未设置直接跳过（不影响 CI）。
func TestRLoginWindow(t *testing.T) {
	secs := 0
	if v := os.Getenv("OPS_R_WINDOW_SECONDS"); v != "" {
		for _, c := range v {
			if c < '0' || c > '9' {
				t.Fatalf("OPS_R_WINDOW_SECONDS 必须是整数秒")
			}
			secs = secs*10 + int(c-'0')
		}
	}
	if secs <= 0 {
		t.Skip("未设置 OPS_R_WINDOW_SECONDS，跳过登录窗口")
	}
	t.Logf("登录窗口开启 %d 秒（API=%s）；请在 OPS 桌面用 owner 登录", secs, env.http.URL)
	deadline := time.Now().Add(time.Duration(secs) * time.Second)
	for time.Now().Before(deadline) {
		time.Sleep(2 * time.Second)
	}
}
