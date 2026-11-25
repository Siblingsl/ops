package app

import (
	"net/http"
	"strings"
	"testing"
	"unicode/utf8"
)

// OPT-E02（docs/43 §5）：桌面端只读版本元数据接口。
// 这里覆盖三类边界：语义版本比较（0.10.0 > 0.2.0、正式版 > 预发布）、
// 下载地址与 SHA-256 的出口清洗、以及未配置/未传 current 时不臆断有更新。

func withDesktopReleaseConfig(t *testing.T, latest, notes, downloadURL, sha string) {
	t.Helper()
	prevLatest := env.srv.cfg.DesktopLatestVersion
	prevNotes := env.srv.cfg.DesktopReleaseNotes
	prevURL := env.srv.cfg.DesktopDownloadURL
	prevSHA := env.srv.cfg.DesktopDownloadSHA256
	env.srv.cfg.DesktopLatestVersion = latest
	env.srv.cfg.DesktopReleaseNotes = notes
	env.srv.cfg.DesktopDownloadURL = downloadURL
	env.srv.cfg.DesktopDownloadSHA256 = sha
	t.Cleanup(func() {
		env.srv.cfg.DesktopLatestVersion = prevLatest
		env.srv.cfg.DesktopReleaseNotes = prevNotes
		env.srv.cfg.DesktopDownloadURL = prevURL
		env.srv.cfg.DesktopDownloadSHA256 = prevSHA
	})
}

func readDesktopRelease(t *testing.T, query string) desktopReleaseInfo {
	t.Helper()
	var out desktopReleaseInfo
	path := "/api/v1/desktop/release"
	if query != "" {
		path += "?" + query
	}
	env.mustJSON(t, http.MethodGet, path, nil, &out)
	return out
}

func TestOPTE02DesktopSemverParsing(t *testing.T) {
	valid := map[string]string{
		"0.2.0":                  "0.2.0",
		"v1.2.3":                 "1.2.3",
		"  V0.10.0  ":            "0.10.0",
		"1.0.0-beta.1":           "1.0.0-beta.1",
		"1.0.0-rc.1+build.5":     "1.0.0-rc.1",
		"2.0.0+build.20261125":   "2.0.0",
		"01.002.0003":            "1.2.3",
		"1.0.0-alpha.beta-gamma": "1.0.0-alpha.beta-gamma",
	}
	for raw, want := range valid {
		got, ok := parseDesktopSemver(raw)
		if !ok {
			t.Fatalf("%q 应解析成功", raw)
		}
		if got.String() != want {
			t.Fatalf("%q 规范化应为 %q，实际 %q", raw, want, got.String())
		}
	}
	for _, raw := range []string{
		"", "v", "V ", "1", "1.2", "1.2.3.4", "1.2.x", "1..3", "1.2.3-", "1.2.3-+x",
		"1.2.3+build!", "1.2.3-beta_1", "1.2.3.4-beta", "abc",
	} {
		if _, ok := parseDesktopSemver(raw); ok {
			t.Fatalf("%q 必须解析失败", raw)
		}
	}
}

func TestOPTE02DesktopSemverCompare(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"0.10.0", "0.2.0", 1},
		{"0.2.0", "0.10.0", -1},
		{"1.0.0", "1.0.0", 0},
		{"1.0.0", "1.0.0-beta.1", 1}, // 正式版大于预发布
		{"1.0.0-beta.1", "1.0.0", -1},
		{"1.0.0-beta.2", "1.0.0-beta.1", 1},      // 数字段按数值比较
		{"1.0.0-beta.10", "1.0.0-beta.2", 1},     // 不是字典序
		{"1.0.0-beta.1", "1.0.0-beta.alpha", -1}, // 纯数字段小于字母段
		{"1.0.0-beta.alpha", "1.0.0-beta.beta", -1},
		{"1.0.0-alpha", "1.0.0-alpha.1", -1}, // 段数少者更小
		{"1.0.0-alpha.1", "1.0.0-alpha", 1},
		{"2.0.0", "1.99.99", 1},
	}
	for _, item := range cases {
		a, okA := parseDesktopSemver(item.a)
		b, okB := parseDesktopSemver(item.b)
		if !okA || !okB {
			t.Fatalf("比较用例版本非法：%q / %q", item.a, item.b)
			continue
		}
		if got := compareDesktopSemver(a, b); got != item.want {
			t.Fatalf("compare(%q, %q) = %d，应为 %d", item.a, item.b, got, item.want)
		}
	}
}

func TestOPTE02DesktopDownloadURLSanitizer(t *testing.T) {
	valid := []string{
		"https://downloads.example.com/ops/OPS-Desktop-Setup.exe",
		"https://cdn.example.com:8443/a/b.exe?token=public#sha",
	}
	for _, raw := range valid {
		if got := sanitizeDesktopDownloadURL(raw); got != raw {
			t.Fatalf("%q 应原样通过，实际 %q", raw, got)
		}
	}
	invalid := []string{
		"",
		"http://downloads.example.com/ops.exe",
		"ftp://downloads.example.com/ops.exe",
		"https://user:pass@downloads.example.com/ops.exe",
		"https://localhost/ops.exe",
		"https://app.localhost/ops.exe",
		"https://127.0.0.1/ops.exe",
		"https://127.1.2.3/ops.exe",
		"https://10.1.2.3/ops.exe",
		"https://172.16.0.9/ops.exe",
		"https://192.168.1.10/ops.exe",
		"https://169.254.1.1/ops.exe",
		"https://0.0.0.0/ops.exe",
		"https://100.64.1.1/ops.exe",
		"https://192.0.2.5/ops.exe",
		"https://198.51.100.7/ops.exe",
		"https://203.0.113.9/ops.exe",
		"https://[::1]/ops.exe",
		"https://[fe80::1]/ops.exe",
		"https://[fd00::1]/ops.exe",
		"https://releases/ops.exe",
		"https:///ops.exe",
	}
	for _, raw := range invalid {
		if got := sanitizeDesktopDownloadURL(raw); got != "" {
			t.Fatalf("%q 必须被清洗为空，实际 %q", raw, got)
		}
	}
}

func TestOPTE02DesktopSHA256Sanitizer(t *testing.T) {
	upper := strings.Repeat("AB", 32)
	if got := sanitizeDesktopSHA256(upper); got != strings.ToLower(upper) {
		t.Fatalf("大写 SHA-256 应转小写，实际 %q", got)
	}
	good := strings.Repeat("0a", 32)
	if got := sanitizeDesktopSHA256("  " + good + "  "); got != good {
		t.Fatalf("合法 SHA-256 应原样（去空白）通过，实际 %q", got)
	}
	for _, raw := range []string{
		"", "sha256:" + good, good[:63], good + "0", good[:63] + "z",
		strings.Repeat("g", 64),
	} {
		if got := sanitizeDesktopSHA256(raw); got != "" {
			t.Fatalf("%q 必须被清洗为空，实际 %q", raw, got)
		}
	}
}

func TestOPTE02DesktopReleaseUnconfigured(t *testing.T) {
	withDesktopReleaseConfig(t, "", "说明", "https://downloads.example.com/ops.exe", strings.Repeat("a", 64))
	out := readDesktopRelease(t, "current=0.1.0")
	if out.Configured || out.UpdateAvailable {
		t.Fatalf("未配置版本号时必须 configured=false / update_available=false：%+v", out)
	}
	for name, value := range map[string]string{
		"latest_version": out.LatestVersion,
		"release_notes":  out.ReleaseNotes,
		"download_url":   out.DownloadURL,
		"sha256":         out.SHA256,
	} {
		if value != "" {
			t.Fatalf("未配置时 %s 必须为空，实际 %q", name, value)
		}
	}
	if out.CurrentVersion != "0.1.0" {
		t.Fatalf("current_version 应回显客户端版本，实际 %q", out.CurrentVersion)
	}
}

func TestOPTE02DesktopReleaseUpdateAvailable(t *testing.T) {
	withDesktopReleaseConfig(t, "v0.10.0", "修复若干问题", "https://downloads.example.com/ops.exe", strings.Repeat("AB", 32))

	out := readDesktopRelease(t, "current=0.2.0")
	if !out.Configured || !out.UpdateAvailable {
		t.Fatalf("0.10.0 应判定为比 0.2.0 新：%+v", out)
	}
	if out.LatestVersion != "0.10.0" {
		t.Fatalf("latest_version 必须去掉前导 v：%q", out.LatestVersion)
	}
	if out.CurrentVersion != "0.2.0" {
		t.Fatalf("current_version = %q", out.CurrentVersion)
	}
	if out.ReleaseNotes != "修复若干问题" {
		t.Fatalf("release_notes = %q", out.ReleaseNotes)
	}
	if out.DownloadURL != "https://downloads.example.com/ops.exe" {
		t.Fatalf("download_url = %q", out.DownloadURL)
	}
	if out.SHA256 != strings.Repeat("ab", 32) {
		t.Fatalf("sha256 必须转小写：%q", out.SHA256)
	}

	// 同版本、客户端更新、预发布升级各一条。
	for _, item := range []struct {
		current string
		want    bool
	}{
		{"0.10.0", false},
		{"0.11.0", false},
		{"v0.9.9", true},
	} {
		got := readDesktopRelease(t, "current="+item.current)
		if got.UpdateAvailable != item.want {
			t.Fatalf("current=%s 时 update_available 应为 %v：%+v", item.current, item.want, got)
		}
	}
}

func TestOPTE02DesktopReleasePrereleaseAndMissingCurrent(t *testing.T) {
	withDesktopReleaseConfig(t, "1.0.0", "正式版", "", "")

	if out := readDesktopRelease(t, ""); out.UpdateAvailable {
		t.Fatalf("未传 current 时不得臆断有更新：%+v", out)
	}
	if out := readDesktopRelease(t, "current=not-a-version"); out.UpdateAvailable {
		t.Fatalf("current 非法时不得臆断有更新：%+v", out)
	}

	withDesktopReleaseConfig(t, "1.0.0-beta.1", "", "", "")
	if out := readDesktopRelease(t, "current=1.0.0"); out.UpdateAvailable {
		t.Fatalf("预发布版不应覆盖正式版：%+v", out)
	}
	if out := readDesktopRelease(t, "current=1.0.0-alpha.9"); !out.UpdateAvailable {
		t.Fatalf("beta.1 应比 alpha.9 新：%+v", out)
	}
}

func TestOPTE02DesktopReleaseFiltersAndTruncates(t *testing.T) {
	withDesktopReleaseConfig(t, "0.2.0", strings.Repeat("更", desktopReleaseNotesMaxRunes+100),
		"http://127.0.0.1/ops.exe", "not-a-sha")
	out := readDesktopRelease(t, "current=0.1.0")
	if out.DownloadURL != "" || out.SHA256 != "" {
		t.Fatalf("非法下载链接与 SHA 必须置空：%+v", out)
	}
	if utf8.RuneCountInString(out.ReleaseNotes) != desktopReleaseNotesMaxRunes {
		t.Fatalf("release_notes 必须截断到 %d 字符，实际 %d", desktopReleaseNotesMaxRunes, utf8.RuneCountInString(out.ReleaseNotes))
	}
	if !out.UpdateAvailable {
		t.Fatalf("非法下载链接不影响版本判断：%+v", out)
	}
}

func TestOPTE02DesktopReleaseNoStoreHeader(t *testing.T) {
	withDesktopReleaseConfig(t, "0.2.0", "", "", "")
	resp := env.request(http.MethodGet, "/api/v1/desktop/release?current=0.1.0", nil, "")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /desktop/release => %d", resp.StatusCode)
	}
	if got := resp.Header.Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control 应为 no-store，实际 %q", got)
	}
}
