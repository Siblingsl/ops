package app

import (
	"context"
	"strings"
	"testing"

	"github.com/google/uuid"
)

// OPT-A03：账号定位 → 旧作风格 → 勾选素材 → 作品核心 → 任务规则。
func TestOPTA03ContextPriorityOrder(t *testing.T) {
	f := env.accounts(t)
	wid := f.wechat.ID.String()
	env.mustJSON(t, "PUT", "/api/v1/accounts/"+wid+"/profile", map[string]any{
		"positioning_tags": []string{"效率", "职场"}, "target_audience": "工作三年左右的人",
		"persona_tone": "真诚、克制", "banned_words": []string{"颠覆"},
	}, nil)
	env.mustJSON(t, "POST", "/api/v1/accounts/"+wid+"/style-samples", map[string]string{
		"title": "旧文风格样本", "content_md": strings.Repeat("我习惯先给结论，再讲一段亲历。", 20),
	}, nil)
	var mat map[string]any
	env.mustJSON(t, "POST", "/api/v1/materials", map[string]any{
		"account_id": wid, "kind": "experience", "content": "第一份工作每天加班到十点", "source": "亲身经历",
	}, &mat)
	var topicRes struct {
		Topic Topic `json:"topic"`
	}
	env.mustJSON(t, "POST", "/api/v1/accounts/"+wid+"/topics", map[string]string{"title": "加班不等于努力", "angle": "从亲身经历切入"}, &topicRes)
	env.mustJSON(t, "PATCH", "/api/v1/topics/"+topicRes.Topic.ID.String(), map[string]string{"status": "adopted"}, nil)
	var wk Work
	env.mustJSON(t, "POST", "/api/v1/topics/"+topicRes.Topic.ID.String()+"/works", nil, &wk)
	env.mustJSON(t, "PATCH", "/api/v1/works/"+wk.ID.String(), map[string]any{
		"viewpoint": "加班时长不能证明努力，产出才能", "material_ids": []any{mat["id"]},
	}, nil)
	env.mustJSON(t, "POST", "/api/v1/works/"+wk.ID.String()+"/outline/generate", nil, nil)

	ctx := context.WithValue(context.Background(), ctxMember, &identity{
		UserID: uuid.New(), WorkspaceID: ownerWS(t), Role: "owner",
	})
	acc, err := env.srv.account(ctx, f.wechat.ID)
	if err != nil {
		t.Fatal(err)
	}
	mid := uuid.MustParse(mat["id"].(string))
	pack, err := env.srv.buildContext(ctx, aiTask{
		Type: "outline", Account: acc, WorkID: &wk.ID, Materials: []uuid.UUID{mid},
		TaskPrompt: &taskPromptSnapshot{Content: "输出三到五个大纲项", Version: 1},
		Work:       "## 作品核心\n核心观点：加班时长不能证明努力，产出才能\n", User: "请生成大纲",
	})
	if err != nil {
		t.Fatal(err)
	}
	iProfile := strings.Index(pack.System, "## 账号定位档案")
	iStyle := strings.Index(pack.System, "## 风格参考")
	if iProfile < 0 || iStyle < 0 || iProfile > iStyle {
		t.Fatalf("系统提示应先定位后风格：profile=%d style=%d", iProfile, iStyle)
	}
	iMat := strings.Index(pack.User, "作者提供的素材")
	iWork := strings.Index(pack.User, "## 作品核心")
	iTask := strings.Index(pack.User, "## 任务指令")
	if iMat < 0 || iWork < 0 || iTask < 0 {
		t.Fatalf("用户提示缺少素材/作品核心/任务指令：mat=%d work=%d task=%d", iMat, iWork, iTask)
	}
	if !(iMat < iWork && iWork < iTask) {
		t.Fatalf("用户提示顺序应为素材→作品核心→任务指令：mat=%d work=%d task=%d", iMat, iWork, iTask)
	}
	if !strings.Contains(pack.User[iWork:iTask], "核心观点：加班时长不能证明努力") {
		t.Fatalf("作品核心应包含用户观点：%s", truncate(pack.User[iWork:iTask], 200))
	}
}

// OPT-A03：作品简报把核心观点放在标题/角度之前。
func TestOPTA03WorkBriefViewpointFirst(t *testing.T) {
	f := env.accounts(t)
	var wk Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+f.wechat.ID.String()+"/works", map[string]string{"title": "观点优先"}, &wk)
	env.mustJSON(t, "PATCH", "/api/v1/works/"+wk.ID.String(), map[string]string{"viewpoint": "先给结论，再讲依据"}, nil)
	ctx := context.WithValue(context.Background(), ctxMember, &identity{
		UserID: uuid.New(), WorkspaceID: ownerWS(t), Role: "owner",
	})
	m, err := env.srv.workMeta(ctx, wk.ID)
	if err != nil {
		t.Fatal(err)
	}
	brief, err := env.srv.workBriefForSection(ctx, m, nil)
	if err != nil {
		t.Fatal(err)
	}
	iView := strings.Index(brief, "核心观点：")
	iTitle := strings.Index(brief, "标题：")
	if iView < 0 || iTitle < 0 || iView > iTitle {
		t.Fatalf("核心观点应先于标题：view=%d title=%d\n%s", iView, iTitle, brief)
	}
}
