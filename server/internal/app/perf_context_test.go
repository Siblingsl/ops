package app

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/google/uuid"
)

// 高表现样本注入：本号阅读最高的 3 篇作品（标题 + 开头）进入起草提示词；
// 不足 3 篇不注入；只给起草类任务；排除当前作品。
func TestPerfContextInjectsTopSamples(t *testing.T) {
	f := env.accounts(t)
	ctx := context.Background()

	var workIDs []uuid.UUID
	for i := 0; i < 3; i++ {
		var wid uuid.UUID
		title := fmt.Sprintf("高表现样本标题%d", i+1)
		if err := env.srv.db.QueryRow(ctx, `INSERT INTO work (account_id, title, content_format, status, published_at)
			VALUES ($1,$2,'long_article','published',now()) RETURNING id`, f.xhs.ID, title).Scan(&wid); err != nil {
			t.Fatal(err)
		}
		if _, err := env.srv.db.Exec(ctx, `INSERT INTO work_section (work_id, position, heading, content_md)
			VALUES ($1, 0, '开头', $2)`, wid, fmt.Sprintf("## 小标题\n\n这是第%d篇的开头段落，用来说明写作方式。", i+1)); err != nil {
			t.Fatal(err)
		}
		if _, err := env.srv.db.Exec(ctx, `INSERT INTO metric_snapshot (work_id, captured_at, reads, likes, favorites)
			VALUES ($1, now(), $2, 10, 5)`, wid, 1000*(i+1)); err != nil {
			t.Fatal(err)
		}
		workIDs = append(workIDs, wid)
	}
	t.Cleanup(func() {
		env.srv.db.Exec(context.Background(), `DELETE FROM work WHERE account_id=$1 AND title LIKE '高表现样本标题%'`, f.xhs.ID)
	})

	var ws uuid.UUID
	if err := env.srv.db.QueryRow(ctx, `SELECT workspace_id FROM platform_account WHERE id=$1`, f.xhs.ID).Scan(&ws); err != nil {
		t.Fatal(err)
	}
	jctx := context.WithValue(ctx, ctxMember, &identity{WorkspaceID: ws})
	a, err := env.srv.account(jctx, f.xhs.ID)
	if err != nil {
		t.Fatal(err)
	}
	pack, err := env.srv.buildContext(jctx, aiTask{Type: "section_draft", Account: a, User: "x"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(pack.System, "本号表现较好的作品") {
		t.Fatalf("section_draft prompt missing performance block:\n%s", pack.System)
	}
	// 阅读最高的那篇必须出现，且标题被剥离 markdown 标记。
	if !strings.Contains(pack.System, "高表现样本标题3") {
		t.Fatal("top sample title missing")
	}
	if !strings.Contains(pack.System, "这是第3篇的开头段落") {
		t.Fatal("top sample opening missing")
	}
	if strings.Contains(pack.System, "## 小标题") {
		t.Fatal("opening excerpt should strip markdown heading markers")
	}
	found := false
	for _, sl := range pack.Slots {
		if sl.Name == "performance" {
			found = true
			if len(sl.Items) != 3 {
				t.Fatalf("performance slot items: %d", len(sl.Items))
			}
		}
	}
	if !found {
		t.Fatal("performance slot missing from refs")
	}

	// 事实核查类任务不注入。
	factPack, err := env.srv.buildContext(jctx, aiTask{Type: "fact_flag", Account: a, User: "x"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(factPack.System, "本号表现较好的作品") {
		t.Fatal("fact_flag should not receive performance samples")
	}

	// 排除当前作品：把最高分那篇作为当前作品时，它不应出现在样本里。
	exclude := workIDs[2]
	pack2, err := env.srv.buildContext(jctx, aiTask{Type: "section_draft", Account: a, User: "x", WorkID: &exclude})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(pack2.System, "高表现样本标题3") {
		t.Fatal("current work should be excluded from performance samples")
	}
}

// 样本不足 3 篇时不注入，避免用一两条数据误导模型。
func TestPerfContextSkipsWhenTooFewSamples(t *testing.T) {
	f := env.accounts(t)
	ctx := context.Background()

	var wid uuid.UUID
	if err := env.srv.db.QueryRow(ctx, `INSERT INTO work (account_id, title, content_format, status, published_at)
		VALUES ($1,'唯一一篇有数据的作品','long_article','published',now()) RETURNING id`, f.xhs.ID).Scan(&wid); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO metric_snapshot (work_id, captured_at, reads, likes) VALUES ($1, now(), 500, 3)`, wid); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		env.srv.db.Exec(context.Background(), `DELETE FROM work WHERE account_id=$1 AND title='唯一一篇有数据的作品'`, f.xhs.ID)
	})

	var ws uuid.UUID
	if err := env.srv.db.QueryRow(ctx, `SELECT workspace_id FROM platform_account WHERE id=$1`, f.xhs.ID).Scan(&ws); err != nil {
		t.Fatal(err)
	}
	jctx := context.WithValue(ctx, ctxMember, &identity{WorkspaceID: ws})
	a, err := env.srv.account(jctx, f.xhs.ID)
	if err != nil {
		t.Fatal(err)
	}
	pack, err := env.srv.buildContext(jctx, aiTask{Type: "section_draft", Account: a, User: "x"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(pack.System, "本号表现较好的作品") {
		t.Fatal("should not inject performance samples with fewer than 3 works")
	}
}
