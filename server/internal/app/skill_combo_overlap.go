package app

import (
	"context"
	"fmt"
	"math"
	"sort"

	"github.com/google/uuid"
)

// DEEP-03 第二刀：同账号已启用公共技能的只读语义重叠提示；不改绑定、不改 resolve 入选基数。

const skillComboOverlapThreshold = 0.45

type skillOutcomeBrief struct {
	Uses      int     `json:"uses"`
	Adopted   int     `json:"adopted"`
	AdoptRate float64 `json:"adopt_rate"`
}

type skillComboWarning struct {
	AccountID               uuid.UUID         `json:"account_id"`
	AccountName             string            `json:"account_name,omitempty"`
	OtherSkillID            uuid.UUID         `json:"other_skill_id"`
	OtherName               string            `json:"other_name"`
	Score                   float64           `json:"score"`
	Reason                  string            `json:"reason"`
	OutcomeSelf             skillOutcomeBrief `json:"outcome_self"`
	OutcomeOther            skillOutcomeBrief `json:"outcome_other"`
	SuggestedExcludeSkillID uuid.UUID         `json:"suggested_exclude_skill_id"`
}

// skillInstructionOverlapScore：规范化 token Jaccard，仅用指令正文；确定性、无 IO。
func skillInstructionOverlapScore(a, b string) float64 {
	return jaccard(terms(a), terms(b))
}

// suggestedExcludeSkillID：较弱者 = 更低 adopt_rate；平手看更少 uses；再平手按 UUID 字典序较大者。
func suggestedExcludeSkillID(selfID, otherID uuid.UUID, selfOut, otherOut skillOutcomeBrief) uuid.UUID {
	if selfOut.AdoptRate < otherOut.AdoptRate {
		return selfID
	}
	if otherOut.AdoptRate < selfOut.AdoptRate {
		return otherID
	}
	if selfOut.Uses < otherOut.Uses {
		return selfID
	}
	if otherOut.Uses < selfOut.Uses {
		return otherID
	}
	if selfID.String() > otherID.String() {
		return selfID
	}
	return otherID
}

func skillOutcomeToBrief(h skillOutcomeHistory) skillOutcomeBrief {
	return skillOutcomeBrief{Uses: h.Uses, Adopted: h.Adopted, AdoptRate: h.AdoptRate}
}

type skillComboPeer struct {
	ID           uuid.UUID
	Name         string
	Instructions string
}

// loadSkillComboWarnings 扫描当前技能在公共分区绑定的账号上，与其他已启用公共技能的指令重叠。
// 个人技能不参与（既不作主体提示，也不作 peer）；响应不含任何指令正文。
func (s *Server) loadSkillComboWarnings(ctx context.Context, workspaceID uuid.UUID, d *skillDef, bindings []skillImpactBinding) ([]skillComboWarning, error) {
	out := []skillComboWarning{}
	if d == nil || d.Scope == "personal" || d.Fields.Instructions == "" {
		return out, nil
	}
	accounts := map[uuid.UUID]string{}
	for _, b := range bindings {
		if b.AudienceUID != nil {
			continue // 个人分区绑定不参与组合体检
		}
		if _, ok := accounts[b.AccountID]; ok {
			continue
		}
		var name string
		_ = s.db.QueryRow(ctx, `SELECT name FROM platform_account WHERE id=$1`, b.AccountID).Scan(&name)
		accounts[b.AccountID] = name
	}
	if len(accounts) == 0 {
		return out, nil
	}
	selfHist, err := s.loadSkillOutcomeHistory(ctx, workspaceID, d.ID)
	if err != nil {
		return nil, err
	}
	selfBrief := skillOutcomeToBrief(selfHist)
	selfTokens := terms(d.Fields.Instructions)

	accIDs := make([]uuid.UUID, 0, len(accounts))
	for id := range accounts {
		accIDs = append(accIDs, id)
	}
	sort.Slice(accIDs, func(i, j int) bool { return accIDs[i].String() < accIDs[j].String() })

	for _, accID := range accIDs {
		peers, err := s.loadPublicEnabledSkillPeers(ctx, accID, d.ID)
		if err != nil {
			return nil, err
		}
		for _, peer := range peers {
			score := jaccard(selfTokens, terms(peer.Instructions))
			if score < skillComboOverlapThreshold {
				continue
			}
			otherHist, err := s.loadSkillOutcomeHistory(ctx, workspaceID, peer.ID)
			if err != nil {
				return nil, err
			}
			otherBrief := skillOutcomeToBrief(otherHist)
			score = math.Round(score*10000) / 10000
			out = append(out, skillComboWarning{
				AccountID:               accID,
				AccountName:             accounts[accID],
				OtherSkillID:            peer.ID,
				OtherName:               peer.Name,
				Score:                   score,
				Reason:                  fmt.Sprintf("指令正文 token 重叠 %.0f%%，可能方法冲突", score*100),
				OutcomeSelf:             selfBrief,
				OutcomeOther:            otherBrief,
				SuggestedExcludeSkillID: suggestedExcludeSkillID(d.ID, peer.ID, selfBrief, otherBrief),
			})
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].AccountID != out[j].AccountID {
			return out[i].AccountID.String() < out[j].AccountID.String()
		}
		if out[i].Score != out[j].Score {
			return out[i].Score > out[j].Score
		}
		return out[i].OtherSkillID.String() < out[j].OtherSkillID.String()
	})
	return out, nil
}

// loadPublicEnabledSkillPeers：同账号公共分区已启用、且非个人定义的技能（不含主体）。
func (s *Server) loadPublicEnabledSkillPeers(ctx context.Context, accountID, selfID uuid.UUID) ([]skillComboPeer, error) {
	rows, err := s.db.Query(ctx, `
		SELECT s.id, s.name, s.instructions
		FROM skill_binding b
		JOIN skill s ON s.id = b.skill_id
		WHERE b.account_id=$1
		  AND b.audience_user_id IS NULL
		  AND b.skill_id IS NOT NULL
		  AND b.skill_id <> $2
		  AND s.user_id IS NULL
		  AND s.status = 'active'
		ORDER BY s.id`, accountID, selfID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var peers []skillComboPeer
	for rows.Next() {
		var p skillComboPeer
		if err := rows.Scan(&p.ID, &p.Name, &p.Instructions); err != nil {
			return nil, err
		}
		peers = append(peers, p)
	}
	return peers, rows.Err()
}
