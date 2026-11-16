package app

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// DEV-P07：*Server 生产路径禁止直接 wall-clock time.Now()，统一走可注入 s.now()。
// 片1–3：agent / publish / 打包 / platform_sync_v2 Server 方法
// 片4：其余全部 *Server 方法（contextpack/aicore/CX/桌面/爬取打点等）
func TestP07PreferInjectedClock(t *testing.T) {
	dir := "."
	names := []string{
		"agent_run.go", "publish.go",
		"agent_browser_commands.go", "agent_delegation_dispatch.go",
		"agent_voice.go", "agent_questions.go", "agent_continue.go", "agent_events.go",
		"agent_goals.go", "agent_computer.go", "agent_execute.go",
		"agent_propose.go", "agent_personal_memory.go",
		"publish_xhs_pack.go", "publish_toutiao_pack.go",
		"r4.go", "imagegen.go", "contextpack.go", "benchmark.go", "desktop_connection.go",
		"aicore.go", "accounts.go", "rewrite.go", "cx_review_windows_http.go", "crawl_platform.go",
		"cx_visual_plan_http.go", "hot_search.go", "desktop_model_check.go", "ops_standard.go",
		"quality.go", "prompt_batch.go", "selftest.go", "hot_summary.go", "cx_account_basis.go",
		"model_settings.go", "media.go", "retention.go", "cx_structure_extract.go",
	}
	for _, name := range names {
		src, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		body := string(src)
		if strings.Contains(body, "time.Now()") {
			t.Fatalf("%s 仍含 time.Now()，应改为 s.now()", name)
		}
	}

	// 混合文件：仅允许登记的自由函数保留 wall clock。
	for _, tc := range []struct {
		name string
		want int
	}{
		{"platform_sync_v2_results.go", 1}, // validatePlatformV2Control
		{"cx_review_ai.go", 1},             // cxReviewWindowKey
		{"crawl.go", 1},                    // crawlStore.Finish
	} {
		src, err := os.ReadFile(filepath.Join(dir, tc.name))
		if err != nil {
			t.Fatalf("read %s: %v", tc.name, err)
		}
		got := strings.Count(string(src), "time.Now()")
		if got != tc.want {
			t.Fatalf("%s 期望 %d 处 time.Now()，实际 %d", tc.name, tc.want, got)
		}
	}
}
