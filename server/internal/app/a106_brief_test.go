package app

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

// DEV-A106（13 文档）：今日智能简报——无数据时空态不编造；有推荐/待办时生成 1–5 条解读，
// 数字只能来自输入；每账号每天至多一条（幂等）。
func TestA106DailyBrief(t *testing.T) {
	_, path := v4Account(t, "简报账号")
	ctx := context.Background()
	var ws uuid.UUID
	if e := env.srv.db.QueryRow(ctx, `SELECT workspace_id FROM platform_account WHERE name='简报账号' LIMIT 1`).Scan(&ws); e != nil {
		t.Fatal(e)
	}
	jctx := context.WithValue(ctx, ctxMember, &identity{WorkspaceID: ws})

	// 空态：没有推荐、没有数据 → 不生成，界面显示空态。
	var empty struct {
		Brief *struct {
			Items []string `json:"items"`
		} `json:"brief"`
	}
	env.mustJSON(t, "GET", path+"/brief", nil, &empty)
	if empty.Brief != nil {
		t.Fatalf("empty account should have no brief: %+v", empty.Brief)
	}

	// 有今日推荐与待回填作品 → 生成简报。
	a, err := env.srv.account(jctx, uuid.MustParse(strings.SplitN(path, "/", -1)[4]))
	if err != nil {
		t.Fatal(err)
	}
	var wid uuid.UUID
	if e := env.srv.db.QueryRow(ctx, `INSERT INTO work (account_id, title, content_format, status, published_at) VALUES ($1,'已发布的作品','image_note','published', now() - interval '2 days') RETURNING id`, a.ID).Scan(&wid); e != nil {
		t.Fatal(e)
	}
	items := `[{"title":"今日该写的一条","angle":"角度","reason":"理由","format":"image_note","basis":[{"type":"pillar","name":"实战复盘"}]}]`
	if _, e := env.srv.db.Exec(ctx, `INSERT INTO daily_recommendation (account_id, date, version, items, trigger) VALUES ($1, current_date, 1, $2, 'manual')`, a.ID, items); e != nil {
		t.Fatal(e)
	}
	if e := env.srv.generateBrief(jctx, a.ID); e != nil {
		t.Fatal(e)
	}
	var out struct {
		Brief *struct {
			Items []string `json:"items"`
		} `json:"brief"`
	}
	env.mustJSON(t, "GET", path+"/brief", nil, &out)
	if out.Brief == nil || len(out.Brief.Items) == 0 {
		t.Fatalf("brief missing: %+v", out.Brief)
	}
	all := strings.Join(out.Brief.Items, " ")
	if !strings.Contains(all, "回填") {
		t.Fatalf("brief should mention pending metrics: %s", all)
	}

	// 幂等：同一天再次生成不追加。
	var n, n2 int
	_ = env.srv.db.QueryRow(ctx, `SELECT count(*) FROM account_daily_brief WHERE account_id=$1`, a.ID).Scan(&n)
	if e := env.srv.generateBrief(jctx, a.ID); e != nil {
		t.Fatal(e)
	}
	_ = env.srv.db.QueryRow(ctx, `SELECT count(*) FROM account_daily_brief WHERE account_id=$1`, a.ID).Scan(&n2)
	if n != 1 || n2 != 1 {
		t.Fatalf("brief rows %d -> %d", n, n2)
	}
	_ = time.Now
}
