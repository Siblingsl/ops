package app

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func digitPref(t *testing.T, accountID uuid.UUID) string {
	t.Helper()
	var c string
	_ = env.srv.db.QueryRow(context.Background(), `SELECT conclusion FROM account_data_preference WHERE account_id=$1 AND feature='title_digit'`, accountID).Scan(&c)
	return c
}

func weeklyDrafts(t *testing.T, accountID uuid.UUID) int {
	t.Helper()
	var n int
	_ = env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM review_report WHERE account_id=$1 AND origin='weekly_draft'`, accountID).Scan(&n)
	return n
}

// DEV-DR08（14 文档 4.6）：偏好输入变化时自动确定性重算（不调模型；样本不足保留旧行但暂停注入）；
// 每周复盘草稿默认关闭，打开后每周一用经济档生成一次，第 7 天数据不足 3 篇时只提示先补数据。
func TestDR08ReviewLoop(t *testing.T) {
	ctx := context.Background()
	a := drAccount(t, "wechat_mp", "分析闭环验收号")
	pub := env.srv.now().AddDate(0, 0, -5)
	var plain []uuid.UUID
	for i := range 5 {
		w := drWork(t, a, fmt.Sprintf("%d 个让阅读翻倍的习惯 %d", i+3, i), "published", &pub)
		drMetric(t, w.ID, "manual", 7, 1000+i)
		p := drWork(t, a, "写给新手的内容运营心得"+strings.Repeat("！", i), "published", &pub)
		drMetric(t, p.ID, "manual", 7, 100+i)
		plain = append(plain, p.ID)
	}
	env.srv.day7PrefsJob(ctx)
	if c := digitPref(t, a.ID); !strings.HasPrefix(c, "含数字") {
		t.Fatalf("day-7 data should derive the title-digit preference, got %q", c)
	}
	if _, err := env.srv.db.Exec(ctx, `UPDATE metric_snapshot SET reads=5000 WHERE work_id=ANY($1) AND day_offset=7`, plain); err != nil {
		t.Fatal(err)
	}
	env.srv.day7PrefsJob(ctx)
	if c := digitPref(t, a.ID); !strings.HasPrefix(c, "不含数字") {
		t.Fatalf("editing day-7 values must refresh the preference, got %q", c)
	}
	small := drAccount(t, "xhs", "分析闭环样本不足号")
	for i := range 3 {
		w := drWork(t, small, fmt.Sprintf("样本不足 %d", i), "published", &pub)
		drMetric(t, w.ID, "manual", 7, 100)
	}
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO account_data_preference (account_id, feature, conclusion, sample_size) VALUES ($1,'hour','保留的旧结论',6)`, small.ID); err != nil {
		t.Fatal(err)
	}
	env.srv.day7PrefsJob(ctx)
	var kept int
	_ = env.srv.db.QueryRow(ctx, `SELECT count(*) FROM account_data_preference WHERE account_id=$1`, small.ID).Scan(&kept)
	if kept != 1 {
		t.Fatal("below the sample floor existing preferences stay untouched")
	}

	var st struct {
		WeeklyDraft string `json:"review_weekly_draft"`
	}
	env.mustJSON(t, "GET", "/api/v1/settings", nil, &st)
	if st.WeeklyDraft != "off" {
		t.Fatalf("weekly draft defaults off, got %q", st.WeeklyDraft)
	}
	orig := env.srv.now
	defer func() { env.srv.now = orig }()
	now := orig().In(env.srv.loc)
	monday := time.Date(now.Year(), now.Month(), now.Day(), 9, 0, 0, 0, env.srv.loc).AddDate(0, 0, (8-int(now.Weekday()))%7)
	if monday.Weekday() != time.Monday {
		t.Fatalf("bad monday %v", monday)
	}
	env.srv.now = func() time.Time { return monday }
	env.srv.weeklyReviewDraftJob(ctx)
	env.srv.now = orig
	if weeklyDrafts(t, a.ID) != 0 {
		t.Fatal("no draft while the setting is off")
	}

	env.expectErr(t, "PUT", "/api/v1/settings", map[string]any{"review_weekly_draft": "always"}, "validation_failed")
	env.mustJSON(t, "PUT", "/api/v1/settings", map[string]any{"review_weekly_draft": "on"}, &st)
	defer env.mustJSON(t, "PUT", "/api/v1/settings", map[string]any{"review_weekly_draft": "off"}, nil)
	if st.WeeklyDraft != "on" {
		t.Fatalf("setting not saved: %q", st.WeeklyDraft)
	}
	thin := drAccount(t, "wechat_mp", "分析闭环数据不足号")
	tw := drWork(t, thin, "只有一篇有第 7 天", "published", &pub)
	drMetric(t, tw.ID, "manual", 7, 100)

	env.srv.now = func() time.Time { return monday.AddDate(0, 0, 1) }
	env.srv.weeklyReviewDraftJob(ctx)
	env.srv.now = func() time.Time { return monday }
	env.srv.weeklyReviewDraftJob(ctx)
	env.srv.weeklyReviewDraftJob(ctx)
	env.srv.now = orig
	if n := weeklyDrafts(t, a.ID); n != 1 {
		t.Fatalf("exactly one draft per account per Monday, got %d", n)
	}
	if weeklyDrafts(t, thin.ID) != 0 {
		t.Fatal("fewer than 3 day-7 works must not produce a draft")
	}
	var tier string
	_ = env.srv.db.QueryRow(ctx, `SELECT c.context_refs->>'origin' FROM review_report r JOIN ai_call c ON c.id=r.ai_call_id WHERE r.account_id=$1 AND r.origin='weekly_draft'`, a.ID).Scan(&tier)
	if tier != "weekly_draft" {
		t.Fatalf("ai_call refs should record the draft origin, got %q", tier)
	}
	week := weekStart(monday).Format("2006-01-02")
	var made, skipped int
	_ = env.srv.db.QueryRow(ctx, `SELECT count(*) FROM notification WHERE dedupe_key=$1`, "review-draft:"+a.ID.String()+":"+week).Scan(&made)
	_ = env.srv.db.QueryRow(ctx, `SELECT count(*) FROM notification WHERE dedupe_key=$1`, "review-draft-skip:"+thin.ID.String()+":"+week).Scan(&skipped)
	if made == 0 || skipped == 0 {
		t.Fatalf("notifications: made=%d skipped=%d", made, skipped)
	}
	var list []ReviewReport
	env.mustJSON(t, "GET", "/api/v1/accounts/"+a.ID.String()+"/reviews", nil, &list)
	if len(list) == 0 || list[0].Origin != "weekly_draft" || len(list[0].Adopted) != 0 {
		t.Fatalf("draft should list as weekly_draft with nothing adopted: %+v", list)
	}
}
