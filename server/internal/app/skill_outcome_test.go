package app

import (
	"context"
	"testing"

	"github.com/google/uuid"
)

// TestDEEP03SkillOutcomeWeightSecondarySortAndHistory：
// 同层同 priority 时权重高者靠前；入选基数仍 ≤20；个人技能不进采样；impact 含 history。
func TestDEEP03SkillOutcomeWeightSecondarySortAndHistory(t *testing.T) {
	fx := env.accounts(t)
	ws := ownerWS(t)
	suffix := uuid.NewString()[:8]
	ctx := context.Background()

	a := skillWorkspaceCreate(t, "归因高-"+suffix)
	b := skillWorkspaceCreate(t, "归因低-"+suffix)
	aid, bid := skillIDOf(t, a), skillIDOf(t, b)

	var bind struct {
		Public struct {
			BaseRevision string `json:"base_revision"`
		} `json:"public"`
	}
	env.mustJSON(t, "GET", "/api/v1/accounts/"+fx.wechat.ID.String()+"/skill-bindings", nil, &bind)
	env.mustJSON(t, "PUT", "/api/v1/accounts/"+fx.wechat.ID.String()+"/skill-bindings/public/"+aid.String(),
		map[string]any{"enabled": true, "base_revision": bind.Public.BaseRevision}, nil)
	env.mustJSON(t, "GET", "/api/v1/accounts/"+fx.wechat.ID.String()+"/skill-bindings", nil, &bind)
	env.mustJSON(t, "PUT", "/api/v1/accounts/"+fx.wechat.ID.String()+"/skill-bindings/public/"+bid.String(),
		map[string]any{"enabled": true, "base_revision": bind.Public.BaseRevision}, nil)
	if _, err := env.srv.db.Exec(ctx, `UPDATE skill_binding SET priority=50 WHERE skill_id=ANY($1)`,
		[]uuid.UUID{aid, bid}); err != nil {
		t.Fatal(err)
	}

	callA := uuid.New()
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO ai_call (id, workspace_id, account_id, task_type, provider, model, template_version, status)
		VALUES ($1,$2,$3,'title','mock','mock',1,'ok')`, callA, ws, fx.wechat.ID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(ctx, `DELETE FROM skill_outcome WHERE skill_id=ANY($1)`, []uuid.UUID{aid, bid})
		_, _ = env.srv.db.Exec(ctx, `DELETE FROM ai_call WHERE id=$1`, callA)
	})
	if _, err := env.srv.db.Exec(ctx, `
		INSERT INTO skill_outcome (workspace_id, skill_id, task_type, ai_call_id, adopted, published)
		VALUES ($1,$2,'title',$3,true,true)`, ws, aid, callA); err != nil {
		t.Fatal(err)
	}

	uid := uuidOf(env.me(t).UserID)
	res, err := env.srv.resolveSkillSet(ctx, SkillResolveInput{
		WorkspaceID: ws, Account: &fx.wechat, ActorKind: "user", ActorUserID: &uid,
		Surface: "task", TaskType: "title", TargetFormat: fx.wechat.ContentFormat,
	})
	if err != nil {
		t.Fatal(err)
	}
	posA, posB := -1, -1
	for i, it := range res.Selected {
		if it.Def.ID == aid {
			posA = i
		}
		if it.Def.ID == bid {
			posB = i
		}
	}
	if posA < 0 || posB < 0 {
		t.Fatalf("both skills must be selected: A=%d B=%d n=%d", posA, posB, len(res.Selected))
	}
	if posA >= posB {
		t.Fatalf("higher outcome weight must sort earlier: A@%d B@%d", posA, posB)
	}
	if len(res.Selected) > skillEffectiveLimit {
		t.Fatalf("cardinality must stay ≤%d, got %d", skillEffectiveLimit, len(res.Selected))
	}

	var impact struct {
		History skillOutcomeHistory `json:"history"`
	}
	env.mustJSON(t, "GET", "/api/v1/skills/"+aid.String()+"/impact?action=update", nil, &impact)
	if impact.History.Uses < 1 || impact.History.Adopted < 1 || impact.History.Published < 1 {
		t.Fatalf("history expected uses/adopted/published: %+v", impact.History)
	}

	// 个人技能不得写入 skill_outcome（即使 snap 误带 Used）。
	personalID := uuid.New()
	fake := &SkillSnapshot{
		Input: SkillResolveInput{WorkspaceID: ws},
		PublicItems: []SkillUseItem{
			{ID: aid, Scope: "workspace", Used: true},
		},
		PrivateItems: []SkillUseItem{
			{ID: personalID, Scope: "personal", Used: true},
		},
	}
	callP := uuid.New()
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO ai_call (id, workspace_id, account_id, task_type, provider, model, template_version, status)
		VALUES ($1,$2,$3,'title','mock','mock',1,'ok')`, callP, ws, fx.wechat.ID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = env.srv.db.Exec(ctx, `DELETE FROM ai_call WHERE id=$1`, callP) })
	env.srv.recordSkillOutcomesFromSnap(ctx, callP, nil, "title", fake)
	var personalRows, publicRows int
	if err := env.srv.db.QueryRow(ctx, `SELECT count(*) FROM skill_outcome WHERE skill_id=$1`, personalID).Scan(&personalRows); err != nil {
		t.Fatal(err)
	}
	if personalRows != 0 {
		t.Fatalf("personal skill must not appear in skill_outcome, got %d", personalRows)
	}
	if err := env.srv.db.QueryRow(ctx, `SELECT count(*) FROM skill_outcome WHERE ai_call_id=$1 AND skill_id=$2`, callP, aid).Scan(&publicRows); err != nil || publicRows != 1 {
		t.Fatalf("public used skill must be sampled once: count=%d err=%v", publicRows, err)
	}

	// 采用旁路：accepted 打 adopted。
	o := "accepted"
	if err := env.srv.recordFeedback(ctx, callP, feedbackInput{Outcome: &o}); err != nil {
		t.Fatal(err)
	}
	var adopted bool
	if err := env.srv.db.QueryRow(ctx, `SELECT adopted FROM skill_outcome WHERE ai_call_id=$1 AND skill_id=$2`, callP, aid).Scan(&adopted); err != nil || !adopted {
		t.Fatalf("accepted feedback must mark adopted: %v %v", adopted, err)
	}
}
