package app

import (
	"context"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestSkillInstructionOverlapScoreDetectsSharedTokens(t *testing.T) {
	shared := strings.Repeat("先写痛点再给三步做法并附案例验证。", 8)
	high := skillInstructionOverlapScore(shared+"收尾提问。", shared+"补充清单。")
	if high < skillComboOverlapThreshold {
		t.Fatalf("high overlap expected ≥%.2f, got %.4f", skillComboOverlapThreshold, high)
	}
	low := skillInstructionOverlapScore(
		"用数据对比说明产品差异并给出购买建议。",
		"整理会议纪要时按议题分组并标出待办负责人。",
	)
	if low >= skillComboOverlapThreshold {
		t.Fatalf("unrelated instructions must stay below threshold, got %.4f", low)
	}
}

func TestSuggestedExcludeSkillIDPrefersHigherAdoptRate(t *testing.T) {
	a := uuid.MustParse("11111111-1111-1111-1111-111111111111")
	b := uuid.MustParse("22222222-2222-2222-2222-222222222222")
	got := suggestedExcludeSkillID(a, b,
		skillOutcomeBrief{Uses: 10, Adopted: 2, AdoptRate: 0.2},
		skillOutcomeBrief{Uses: 10, Adopted: 8, AdoptRate: 0.8})
	if got != a {
		t.Fatalf("weaker adopt_rate should be excluded: got %s want %s", got, a)
	}
	got = suggestedExcludeSkillID(a, b,
		skillOutcomeBrief{Uses: 3, Adopted: 1, AdoptRate: 0.5},
		skillOutcomeBrief{Uses: 10, Adopted: 5, AdoptRate: 0.5})
	if got != a {
		t.Fatalf("tie adopt_rate → lower uses excluded: got %s want %s", got, a)
	}
	got = suggestedExcludeSkillID(a, b,
		skillOutcomeBrief{Uses: 0, Adopted: 0, AdoptRate: 0},
		skillOutcomeBrief{Uses: 0, Adopted: 0, AdoptRate: 0})
	if got != b {
		t.Fatalf("stable id order excludes larger UUID: got %s want %s", got, b)
	}
}

// TestDEEP03ComboOverlapImpactAndResolveCardinality：
// 高重叠公共技能出现 combo_warnings；个人技能不进警告；suggested_exclude 偏向高 adopt_rate；
// resolve 入选基数不受警告影响。
func TestDEEP03ComboOverlapImpactAndResolveCardinality(t *testing.T) {
	fx := env.accounts(t)
	ws := ownerWS(t)
	suffix := uuid.NewString()[:8]
	ctx := context.Background()

	body := strings.Repeat("标题先抛冲突再给三步解法并引用真实案例验证效果。", 10)
	inA := skillBaseFields("重叠甲-" + suffix)
	inA["instructions"] = body + "甲收尾。"
	inA["scope"] = "workspace"
	inA["publish_confirmation"] = map[string]any{"confirmed": true, "digest": skillDigest(t, "create", nil, "workspace", nil, inA)}
	a := skillCreateSkill(t, inA)

	inB := skillBaseFields("重叠乙-" + suffix)
	inB["instructions"] = body + "乙收尾。"
	inB["scope"] = "workspace"
	inB["publish_confirmation"] = map[string]any{"confirmed": true, "digest": skillDigest(t, "create", nil, "workspace", nil, inB)}
	b := skillCreateSkill(t, inB)

	aid, bid := skillIDOf(t, a), skillIDOf(t, b)

	personalBody := body + "个人收尾。"
	inP := skillBaseFields("重叠个人-" + suffix)
	inP["instructions"] = personalBody
	inP["scope"] = "personal"
	personal := skillCreateSkill(t, inP)
	pid := skillIDOf(t, personal)

	var bind struct {
		Public struct {
			BaseRevision string `json:"base_revision"`
		} `json:"public"`
		Mine struct {
			BaseRevision string `json:"base_revision"`
		} `json:"mine"`
	}
	env.mustJSON(t, "GET", "/api/v1/accounts/"+fx.wechat.ID.String()+"/skill-bindings", nil, &bind)
	env.mustJSON(t, "PUT", "/api/v1/accounts/"+fx.wechat.ID.String()+"/skill-bindings/public/"+aid.String(),
		map[string]any{"enabled": true, "base_revision": bind.Public.BaseRevision}, nil)
	env.mustJSON(t, "GET", "/api/v1/accounts/"+fx.wechat.ID.String()+"/skill-bindings", nil, &bind)
	env.mustJSON(t, "PUT", "/api/v1/accounts/"+fx.wechat.ID.String()+"/skill-bindings/public/"+bid.String(),
		map[string]any{"enabled": true, "base_revision": bind.Public.BaseRevision}, nil)
	env.mustJSON(t, "GET", "/api/v1/accounts/"+fx.wechat.ID.String()+"/skill-bindings", nil, &bind)
	env.mustJSON(t, "PUT", "/api/v1/accounts/"+fx.wechat.ID.String()+"/skill-bindings/personal/"+pid.String(),
		map[string]any{"enabled": true, "base_revision": bind.Mine.BaseRevision}, nil)

	callStrong := uuid.New()
	callWeak := uuid.New()
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO ai_call (id, workspace_id, account_id, task_type, provider, model, template_version, status)
		VALUES ($1,$2,$3,'title','mock','mock',1,'ok'), ($4,$2,$3,'title','mock','mock',1,'ok')`,
		callStrong, ws, fx.wechat.ID, callWeak); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(ctx, `DELETE FROM skill_outcome WHERE skill_id=ANY($1)`, []uuid.UUID{aid, bid, pid})
		_, _ = env.srv.db.Exec(ctx, `DELETE FROM ai_call WHERE id=ANY($1)`, []uuid.UUID{callStrong, callWeak})
	})
	// A 采用率更高 → 建议排除 B。
	if _, err := env.srv.db.Exec(ctx, `
		INSERT INTO skill_outcome (workspace_id, skill_id, task_type, ai_call_id, adopted)
		VALUES ($1,$2,'title',$3,true), ($1,$4,'title',$5,false)`,
		ws, aid, callStrong, bid, callWeak); err != nil {
		t.Fatal(err)
	}

	var impact struct {
		History       skillOutcomeHistory `json:"history"`
		ComboWarnings []skillComboWarning `json:"combo_warnings"`
	}
	env.mustJSON(t, "GET", "/api/v1/skills/"+aid.String()+"/impact?action=update", nil, &impact)
	if impact.History.Uses < 1 {
		t.Fatalf("history still required: %+v", impact.History)
	}
	if len(impact.ComboWarnings) == 0 {
		t.Fatal("expected combo_warnings for high-overlap public pair")
	}
	foundB, foundPersonal := false, false
	for _, w := range impact.ComboWarnings {
		if w.OtherSkillID == bid {
			foundB = true
			if w.Score < skillComboOverlapThreshold {
				t.Fatalf("overlap score too low: %+v", w)
			}
			if w.AccountID != fx.wechat.ID {
				t.Fatalf("account_id: %+v", w)
			}
			if w.OtherName == "" || w.Reason == "" {
				t.Fatalf("name/reason required: %+v", w)
			}
			if w.SuggestedExcludeSkillID != bid {
				t.Fatalf("suggested_exclude should prefer higher adopt_rate (exclude B): got %s", w.SuggestedExcludeSkillID)
			}
			if w.OutcomeSelf.AdoptRate < w.OutcomeOther.AdoptRate {
				t.Fatalf("outcome advisory inverted: %+v", w)
			}
			if strings.Contains(w.Reason, body) || strings.Contains(w.OtherName, body) {
				t.Fatalf("must not leak instruction body: %+v", w)
			}
		}
		if w.OtherSkillID == pid {
			foundPersonal = true
		}
	}
	if !foundB {
		t.Fatalf("missing warning vs skill B: %+v", impact.ComboWarnings)
	}
	if foundPersonal {
		t.Fatal("personal skills must be excluded from combo_warnings")
	}

	var personalImpact struct {
		ComboWarnings []skillComboWarning `json:"combo_warnings"`
	}
	env.mustJSON(t, "GET", "/api/v1/skills/"+pid.String()+"/impact?action=update", nil, &personalImpact)
	if len(personalImpact.ComboWarnings) != 0 {
		t.Fatalf("personal subject must not emit combo_warnings: %+v", personalImpact.ComboWarnings)
	}

	uid := uuidOf(env.me(t).UserID)
	res, err := env.srv.resolveSkillSet(ctx, SkillResolveInput{
		WorkspaceID: ws, Account: &fx.wechat, ActorKind: "user", ActorUserID: &uid,
		Surface: "task", TaskType: "title", TargetFormat: fx.wechat.ContentFormat,
	})
	if err != nil {
		t.Fatal(err)
	}
	selected := 0
	for _, it := range res.Selected {
		if it.Def.ID == aid || it.Def.ID == bid {
			selected++
		}
	}
	if selected != 2 {
		t.Fatalf("warnings must not change resolve cardinality of overlapping pair: selected=%d n=%d", selected, len(res.Selected))
	}
	if len(res.Selected) > skillEffectiveLimit {
		t.Fatalf("cardinality must stay ≤%d, got %d", skillEffectiveLimit, len(res.Selected))
	}
}
