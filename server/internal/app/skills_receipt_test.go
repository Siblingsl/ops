package app

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/google/uuid"
	"ops/internal/ai"
)

func TestSkillSnapshotReceiptKeepsCharsAndBudgetReason(t *testing.T) {
	ctx, fx := skillAIEnv(t)
	for i := 0; i < 3; i++ {
		in := skillBaseFields("预算回执-" + uuid.NewString()[:6])
		in["scope"] = "personal"
		in["instructions"] = strings.Repeat("字", 1200)
		def := skillCreateSkill(t, in)
		skillBindPersonal(t, fx.wechat.ID, skillIDOf(t, def))
	}
	uid := uuidOf(ownerUserID(t))
	snap, err := env.srv.loadSkillSnapshot(ctx, SkillResolveInput{WorkspaceID: ownerWS(t), Account: &fx.wechat, ActorKind: "user", ActorUserID: &uid, Surface: "task", TaskType: "title"})
	if err != nil {
		t.Fatal(err)
	}
	used, excluded := 0, 0
	for _, item := range snap.Items {
		if item.Used {
			used++
			if item.Chars <= 1200 {
				t.Error("已装入项缺少实际正文及包装字数")
			}
		} else if item.Reason != nil && *item.Reason == skillReasonBudget {
			excluded++
			if item.Chars != 0 {
				t.Error("未使用项字数应为0")
			}
		}
	}
	if used != 2 || excluded != 1 {
		t.Fatalf("used=%d budget_excluded=%d", used, excluded)
	}
}

func TestSkillAgentCallReceiptSurvivesRunCleanupAndStaysPrivate(t *testing.T) {
	st, account := skillRunState(t)
	privateID := skillAgentBind(t, account.ID, 1, true)[0]
	ctx := context.WithValue(context.Background(), ctxMember, &identity{UserID: st.UserID, WorkspaceID: st.WorkspaceID, Role: "owner"})
	catalog, err := env.srv.agentSkillEnsureContext(ctx, st, account, nil, account.ContentFormat)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = env.srv.agentSkillLoad(ctx, st, account, map[string]any{"catalog_id": catalog.CatalogID.String(), "skill_ref": "s1"}); err != nil {
		t.Fatal(err)
	}
	_, expectedChars := agentSkillLoadedText(catalog)
	callID, err := env.srv.writeAgentAICall(ctx, st, &route{ProviderName: "回执合成测试", Model: "mock-writer"}, agentModelPayload{Round: 2}, "ok", "", ai.Usage{}, false)
	if err != nil {
		t.Fatal(err)
	}
	agentReleaseSkillState(st.RunID)
	var refs, private []byte
	var owner *uuid.UUID
	if err = env.srv.db.QueryRow(ctx, `SELECT context_refs,private_context_refs,context_owner_user_id FROM ai_call WHERE id=$1`, callID).Scan(&refs, &private, &owner); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(refs), privateID.String()) {
		t.Error("公共引用含私人ID")
	}
	if owner == nil || *owner != st.UserID || !strings.Contains(string(private), privateID.String()) {
		t.Error("本人元数据或归属未持久化")
	}
	var mine struct {
		Items        []SkillUseItem `json:"items"`
		PersonalUsed int            `json:"personal_used_count"`
		Chars        int            `json:"assembled_chars"`
		Context      struct {
			Surface string `json:"surface"`
		} `json:"context"`
	}
	env.mustJSON(t, "GET", "/api/v1/ai-calls/"+callID.String()+"/skill-context", nil, &mine)
	if mine.PersonalUsed != 1 || mine.Chars != expectedChars || mine.Context.Surface != "agent" || len(mine.Items) != 1 || !mine.Items[0].Used || mine.Items[0].Chars == 0 {
		t.Fatalf("本人历史回执不完整：%+v", mine)
	}
	editor := skillJoinMember(t, "editor")
	defer editor.restore(env)
	var theirs json.RawMessage
	gMustJSON(t, editor, "GET", "/api/v1/ai-calls/"+callID.String()+"/skill-context?owner_user_id="+st.UserID.String(), nil, &theirs)
	if strings.Contains(string(theirs), privateID.String()) || !strings.Contains(string(theirs), `"personal_used_count":1`) {
		t.Fatalf("协作者只能看到匿名数量：%s", theirs)
	}
}

func TestSkillUnusedPersonalReceiptIsOwnerOnly(t *testing.T) {
	ctx, fx := skillAIEnv(t)
	in := skillBaseFields("未使用私有回执-" + uuid.NewString()[:6])
	in["scope"] = "personal"
	in["platforms"] = []string{"toutiao"}
	def := skillCreateSkill(t, in)
	id := skillIDOf(t, def)
	skillBindPersonal(t, fx.wechat.ID, id)
	res, err := env.srv.runAI(ctx, aiTask{Type: "title", Account: &fx.wechat, User: "给一个读书标题"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	var mine struct {
		Items        []SkillUseItem `json:"items"`
		PersonalUsed int            `json:"personal_used_count"`
	}
	env.mustJSON(t, "GET", "/api/v1/ai-calls/"+res.CallID.String()+"/skill-context", nil, &mine)
	if len(mine.Items) != 1 || mine.Items[0].ID != id || mine.Items[0].Used || mine.Items[0].Reason == nil || *mine.Items[0].Reason != skillReasonPlatform || mine.PersonalUsed != 0 {
		t.Fatalf("本人应能读未使用项及原因：%+v", mine)
	}
}
