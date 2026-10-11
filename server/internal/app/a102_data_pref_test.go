package app

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

// DEV-A102（13 文档）：归因分组统计沉淀为"读者数据偏好"（样本量达标才收）；
// 学习源扩展：被拒原因聚合（≥3 次）与大幅修改样本进入每日提炼。
// DEV-A103：数据偏好按任务注入生成提示词，refs 可断言。
func TestA102A103DataPreferences(t *testing.T) {
	f := env.accounts(t)
	ctx := context.Background()
	var ws uuid.UUID
	if err := env.srv.db.QueryRow(ctx, `SELECT workspace_id FROM platform_account WHERE id=$1`, f.wechat.ID).Scan(&ws); err != nil {
		t.Fatal(err)
	}

	// 12 篇有数据的作品：含数字标题阅读 2000，不含数字阅读 800。
		for i := 0; i < 12; i++ {
		title := fmt.Sprintf("运营实战的%d个习惯", i+3)
		reads := 2000
		if i >= 6 {
			title = "运营实战的习惯清单"
			reads = 800
		}
		var wid uuid.UUID
		if err := env.srv.db.QueryRow(ctx, `INSERT INTO work (account_id, title, content_format, status, published_at) VALUES ($1,$2,'long_article','published',now()) RETURNING id`,
			f.wechat.ID, title).Scan(&wid); err != nil {
			t.Fatal(err)
		}
		if _, err := env.srv.db.Exec(ctx, `INSERT INTO metric_snapshot (work_id, captured_at, reads, likes) VALUES ($1, now(), $2, 10)`, wid, reads); err != nil {
			t.Fatal(err)
		}
	}

	// 共享 fixture 清理：本测试写入的数据不得影响其他用例的上下文断言。
	t.Cleanup(func() {
		env.srv.db.Exec(context.Background(), `DELETE FROM account_data_preference WHERE account_id=$1`, f.wechat.ID)
		env.srv.db.Exec(context.Background(), `DELETE FROM account_memory WHERE account_id=$1 AND (text LIKE '「%」类输出常因%' OR source IN ('edit_diff','rejection'))`, f.wechat.ID)
		env.srv.db.Exec(context.Background(), `DELETE FROM ai_feedback WHERE workspace_id=$1 AND note IN ('标题太夸张了','删掉了开头设问')`, ws)
		env.srv.db.Exec(context.Background(), `DELETE FROM ai_call WHERE workspace_id=$1 AND task_type='topic_suggest' AND provider='mock'`, ws)
		env.srv.db.Exec(context.Background(), `DELETE FROM work WHERE account_id=$1 AND title LIKE '运营实战%'`, f.wechat.ID)
	})

	var res struct {
		Enough bool `json:"enough"`
	}
	env.mustJSON(t, "POST", "/api/v1/accounts/"+f.wechat.ID.String()+"/reviews/attribution", nil, &res)
	if !res.Enough {
		t.Fatal("attribution should have enough samples")
	}
	var feature, conclusion, basis string
	var sample int
	if e := env.srv.db.QueryRow(ctx, `SELECT feature, conclusion, basis, sample_size FROM account_data_preference WHERE account_id=$1 AND feature='title_digit'`,
		f.wechat.ID).Scan(&feature, &conclusion, &basis, &sample); e != nil {
		t.Fatalf("title_digit preference missing: %v", e)
	}
	if sample != 12 || !strings.Contains(conclusion, "含数字") || !strings.Contains(basis, "不含数字") {
		t.Fatalf("preference: %s %s %d", conclusion, basis, sample)
	}

	// DEV-A103：title 任务注入偏好，refs 可见；未列任务不注入。
	jctx := context.WithValue(ctx, ctxMember, &identity{WorkspaceID: ws})
	a, err := env.srv.account(jctx, f.wechat.ID)
	if err != nil {
		t.Fatal(err)
	}
	pack, err := env.srv.buildContext(jctx, aiTask{Type: "title", Account: a, User: "x"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(pack.System, "读者数据偏好") || !strings.Contains(pack.System, "含数字") {
		t.Fatal("title prompt missing data preferences")
	}
	if len(pack.DataPrefIDs) != 1 {
		t.Fatalf("data pref ids: %v", pack.DataPrefIDs)
	}
	if _, ok := pack.refs()["data_pref_ids"]; !ok {
		t.Fatal("refs missing data_pref_ids")
	}
	pack2, err := env.srv.buildContext(jctx, aiTask{Type: "section_edit", Account: a, User: "x"})
	if err != nil {
		t.Fatal(err)
	}
	if len(pack2.DataPrefIDs) != 0 || strings.Contains(pack2.System, "读者数据偏好") {
		t.Fatal("section_edit should not receive data preferences")
	}

	// DEV-A102：被拒原因聚合（同标签 ≥3 次）→ 记忆候选；大幅修改样本进入提炼提示词。
	insertFeedback := func(outcome string, ratio float64, tags []string, note string) {
		var call uuid.UUID
		if e := env.srv.db.QueryRow(ctx, `INSERT INTO ai_call (workspace_id, account_id, task_type, provider, model, status) VALUES ($1,$2,'topic_suggest','mock','m','ok') RETURNING id`,
			ws, f.wechat.ID).Scan(&call); e != nil {
			t.Fatal(e)
		}
		if _, e := env.srv.db.Exec(ctx, `INSERT INTO ai_feedback (ai_call_id, workspace_id, task_type, outcome, edit_ratio, reason_tags, note) VALUES ($1,$2,'topic_suggest',$3,$4,$5,$6)`,
			call, ws, outcome, ratio, tags, note); e != nil {
			t.Fatal(e)
		}
	}
	for i := 0; i < 5; i++ {
		insertFeedback("rejected", 0, []string{"太夸张"}, "标题太夸张了")
	}
	insertFeedback("edited", 0.5, []string{}, "删掉了开头设问")

	added, _, err := env.srv.distillMemories(jctx, a, time.Now().AddDate(0, 0, -60))
	if err != nil {
		t.Fatal(err)
	}
	if added < 1 {
		t.Fatalf("aggregation should add candidates, added %d", added)
	}
	var list []Memory
	env.mustJSON(t, "GET", "/api/v1/accounts/"+f.wechat.ID.String()+"/memories", nil, &list)
	foundTag := false
	for _, m := range list {
		if m.Status == "suggested" && strings.Contains(m.Text, "太夸张") && strings.Contains(m.Text, "选题建议") {
			foundTag = true
			if !strings.Contains(string(m.Evidence), `"count":5`) {
				t.Fatalf("tag evidence: %s", m.Evidence)
			}
		}
	}
	if !foundTag {
		t.Fatalf("tag aggregation candidate missing: %+v", list)
	}

	// 大幅修改样本进入提炼提示词。
	snapV, ok := env.srv.lastPacks.Load(ws.String() + "/memory_distill")
	if !ok {
		t.Fatal("no memory_distill snapshot")
	}
	snap := snapV.(evalSnapshot)
	if !strings.Contains(snap.UserRest, "作者大幅修改过的 AI 输出") || !strings.Contains(snap.UserRest, "作者修改了 50%") {
		t.Fatalf("edited lines missing from distill prompt: %s", truncate(snap.UserRest, 300))
	}
}
