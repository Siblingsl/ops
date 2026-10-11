package app

import (
	"context"
	"strings"
	"testing"

	"github.com/google/uuid"
)

// DEV-A101（13 文档）："AI 学到了什么"——三类来源（指令复用/采纳差异/被拒记录）的记忆
// 候选都带证据进入待确认列表并排在最前；确认后按作用范围注入生成提示词。
func TestA101MemoryEvidencePanel(t *testing.T) {
	f := env.accounts(t)
	ctx := context.Background()
	var ws uuid.UUID
	if err := env.srv.db.QueryRow(ctx, `SELECT workspace_id FROM platform_account WHERE id=$1`, f.wechat.ID).Scan(&ws); err != nil {
		t.Fatal(err)
	}
	jctx := context.WithValue(ctx, ctxMember, &identity{WorkspaceID: ws})

	_, e1 := env.srv.suggestMemory(jctx, f.wechat.ID, "wording", "all", "A101 指令来源：句子控制在 25 字以内", "instruction",
		map[string]any{"count": 5, "note": "你在 5 次生成中都提出了这条要求"})
	_, e2 := env.srv.suggestMemory(jctx, f.wechat.ID, "structure", "draft", "A101 改动来源：先写结论再展开论据", "edit_diff",
		map[string]any{"note": "多组改动都把结论提前", "pairs": 6, "rejections": 2})
	_, e3 := env.srv.suggestMemory(jctx, f.wechat.ID, "avoid", "title", "A101 被拒来源：标题不要用夸张数字", "rejection",
		map[string]any{"note": "标题类建议多次被拒", "pairs": 0, "rejections": 7})
	if e1 != nil || e2 != nil || e3 != nil {
		t.Fatalf("suggest: %v %v %v", e1, e2, e3)
	}

	var list []Memory
	env.mustJSON(t, "GET", "/api/v1/accounts/"+f.wechat.ID.String()+"/memories", nil, &list)
	seenOther := false
	for _, m := range list {
		if m.Status == "suggested" && seenOther {
			t.Fatal("suggested candidates must sort before other statuses")
		}
		if m.Status != "suggested" {
			seenOther = true
		}
	}
	find := func(text string) *Memory {
		for i := range list {
			if list[i].Text == text {
				return &list[i]
			}
		}
		return nil
	}
	m1, m2, m3 := find("A101 指令来源：句子控制在 25 字以内"), find("A101 改动来源：先写结论再展开论据"), find("A101 被拒来源：标题不要用夸张数字")
	if m1 == nil || m2 == nil || m3 == nil {
		t.Fatalf("candidates missing: %+v", list)
	}
	if m1.Evidence == nil || !strings.Contains(string(m1.Evidence), `"count":5`) || !strings.Contains(string(m1.Evidence), "5 次") {
		t.Fatalf("instruction evidence: %s", m1.Evidence)
	}
	if m2.Evidence == nil || !strings.Contains(string(m2.Evidence), `"pairs":6`) || !strings.Contains(string(m2.Evidence), `"rejections":2`) {
		t.Fatalf("edit_diff evidence: %s", m2.Evidence)
	}
	if m3.Evidence == nil || !strings.Contains(string(m3.Evidence), `"rejections":7`) {
		t.Fatalf("rejection evidence: %s", m3.Evidence)
	}

	// 确认后按作用范围注入：scope=title 的记忆进入 title 任务的提示词。
	env.mustJSON(t, "PATCH", "/api/v1/memories/"+m3.ID.String(), map[string]string{"status": "active"}, nil)
	a, err := env.srv.account(jctx, f.wechat.ID)
	if err != nil {
		t.Fatal(err)
	}
	pack, err := env.srv.buildContext(jctx, aiTask{Type: "title", Account: a, User: "x"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(pack.System, "A101 被拒来源：标题不要用夸张数字") {
		t.Fatal("confirmed title-scope memory should be injected")
	}
}
