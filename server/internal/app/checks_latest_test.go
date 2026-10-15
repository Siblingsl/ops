package app

// 「最新检查」排序加固回归（2026-10-15）。
// 数据库时钟回拨（WSL2/Docker 容器时钟漂移）会让 check_run.created_at 倒挂；
// checks/latest 与 checks/report 必须按修订号优先取到新修订的运行。

import (
	"context"
	"testing"

	"github.com/google/uuid"
)

func TestChecksLatestPrefersHigherRevisionOnClockSkew(t *testing.T) {
	acc := env.accounts(t)
	wk := env.readyWork(t, acc.wechat, "排序加固")
	defer agentDropWork(wk.ID)
	base := "/api/v1/works/" + wk.ID.String()

	// 检查一次（run A）→ 改一段内容（修订 +1）→ 再检查一次（run B）：两个运行修订不同。
	var a, b struct {
		Run CheckRun `json:"run"`
	}
	env.mustJSON(t, "POST", base+"/checks", map[string]int{"html_chars": 3000, "html_bytes": 9000}, &a)
	var full Work
	env.mustJSON(t, "GET", base, nil, &full)
	if len(full.Sections) == 0 {
		t.Fatal("前置作品应有段落")
	}
	sec := full.Sections[0]
	env.mustJSON(t, "PATCH", "/api/v1/sections/"+sec.ID.String(),
		map[string]any{"content_md": sec.ContentMD + "\n\n补充一句用于排序加固测试。", "base_revision": sec.Revision}, nil)
	env.mustJSON(t, "POST", base+"/checks", map[string]int{"html_chars": 3000, "html_bytes": 9000}, &b)
	if b.Run.Revision <= a.Run.Revision {
		t.Fatalf("两次检查应修订递增：A=rev%d B=rev%d", a.Run.Revision, b.Run.Revision)
	}

	// 模拟数据库时钟回拨：让新修订运行（B）的 created_at 早于 A（正常时钟下不会发生）。
	if _, err := env.srv.db.Exec(context.Background(),
		`UPDATE check_run SET created_at = created_at - interval '10 minutes' WHERE id=$1`, b.Run.ID); err != nil {
		t.Fatal(err)
	}

	// checks/latest 应按修订号取到 B（加固前会因 created_at 倒挂返回 A）。
	var latest struct {
		Run *CheckRun `json:"run"`
	}
	env.mustJSON(t, "GET", base+"/checks/latest", nil, &latest)
	if latest.Run == nil || latest.Run.ID != b.Run.ID {
		t.Fatalf("latest 应按修订号取新运行：want %s(rev=%d)，got %+v", b.Run.ID, b.Run.Revision, latest.Run)
	}

	// checks/report 同口径。
	var report struct {
		Run struct {
			ID       uuid.UUID `json:"id"`
			Revision int       `json:"revision"`
		} `json:"run"`
	}
	env.mustJSON(t, "GET", base+"/checks/report", nil, &report)
	if report.Run.ID != b.Run.ID {
		t.Fatalf("report 应按修订号取新运行：want %s，got %+v", b.Run.ID, report.Run)
	}
}
