package app

import (
	"testing"
	"time"
)

// TestPlatformWithinDailyWindow 钉住采集窗口 09:00（含）–21:00（不含），按 Asia/Shanghai 算。
//
// 这个判断决定三件事：调度器是否派任务、预算不足时 `next_allowed_at` 落到什么时候、
// 心跳里的预算申请是否直接返回 `daily_window`。时区写错的话，"早上 9 点自动采集"
// 在 UTC 机器上会提前或推迟 8 小时；边界写成 `<=` 则 21:00 整还会多派一单。
func TestPlatformWithinDailyWindow(t *testing.T) {
	loc, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		t.Fatalf("本地时区加载失败：%v", err)
	}
	cases := []struct {
		name string
		at   time.Time
		want bool
	}{
		{"窗口前 08:59", time.Date(2026, 10, 23, 8, 59, 0, 0, loc), false},
		{"窗口起点 09:00", time.Date(2026, 10, 23, 9, 0, 0, 0, loc), true},
		{"窗口内 13:30", time.Date(2026, 10, 23, 13, 30, 0, 0, loc), true},
		{"窗口末 20:59", time.Date(2026, 10, 23, 20, 59, 59, 0, loc), true},
		{"窗口终点 21:00", time.Date(2026, 10, 23, 21, 0, 0, 0, loc), false},
		{"深夜 00:30", time.Date(2026, 10, 23, 0, 30, 0, 0, loc), false},
		// 同一时刻用 UTC 表示也必须判对：服务器时钟可能是 UTC。
		{"UTC 01:00 等于北京 09:00", time.Date(2026, 10, 23, 1, 0, 0, 0, time.UTC), true},
		{"UTC 22:00 等于北京次日 06:00", time.Date(2026, 10, 22, 22, 0, 0, 0, time.UTC), false},
	}
	for _, c := range cases {
		if got := platformWithinDailyWindow(c.at, loc); got != c.want {
			t.Errorf("%s（%s）：期望 %v，实际 %v", c.name, c.at.In(loc).Format(time.RFC3339), c.want, got)
		}
	}
}
