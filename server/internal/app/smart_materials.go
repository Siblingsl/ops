package app

import (
	"context"
	"net/http"
	"strings"

	"github.com/google/uuid"
)

func splitChunks(text string, size int) []string {
	rs := []rune(text)
	var out []string
	for start := 0; start < len(rs); {
		end := min(start+size, len(rs))
		if end < len(rs) {
			for k := end; k > start+size/2; k-- {
				if rs[k-1] == '\n' || rs[k-1] == '。' {
					end = k
					break
				}
			}
		}
		out = append(out, string(rs[start:end]))
		start = end
	}
	return out
}

func (s *Server) extractMaterialsFrom(ctx context.Context, a *Account, text string) ([]MaterialCandidate, *uuid.UUID, error) {
	var all []MaterialCandidate
	var lastCall *uuid.UUID
	for _, chunk := range splitChunks(text, 6000) {
		user := `## 原文
` + externalBlock("提炼原文", "chunk", chunk) + `

## 任务说明
从原文中拆出可复用的原子素材，类型只能是 experience（亲身经历）、opinion（观点）、case（案例）、data（数据）。
只摘录原文中有的信息，不改写事实；数据类必须保留原文中的数字和出处；每条素材独立成意，不超过 300 字；每条最多 5 个标签。

## 输出格式
只输出 JSON：{"items":[{"kind":"experience|opinion|case|data","content":"素材内容","source_hint":"出处线索","tags":["标签"]}]}`
		var out struct {
			Items []MaterialCandidate `json:"items"`
		}
		res, err := s.runAIJSON(ctx, aiTask{Type: "material_extract", Account: a, User: user, SkipStyle: true}, &out, nil)
		if err != nil {
			return nil, nil, err
		}
		lastCall = &res.CallID
		all = append(all, keepFaithfulNumbers(out.Items, chunk)...)
	}
	return all, lastCall, nil
}

func (s *Server) extractMaterials(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		AccountID *uuid.UUID `json:"account_id"`
		Text      string     `json:"text"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	ctx := r.Context()
	text := strings.TrimSpace(in.Text)
	if text == "" {
		return validation("请粘贴要提炼的文本")
	}
	if runeLen(text) > 20000 {
		return validation("文本最多 2 万字，请分段提炼")
	}
	var a *Account
	if in.AccountID != nil {
		acc, err := s.account(ctx, *in.AccountID)
		if err != nil {
			return err
		}
		a = acc
	}
	if runeLen(text) <= 6000 {
		items, callID, err := s.extractMaterialsFrom(ctx, a, text)
		if err != nil {
			return err
		}
		return ok(w, map[string]any{"items": items, "ai_call_id": callID})
	}
	spec := jobSpec{TaskType: "material_extract", Label: "素材提炼", Link: "/materials?extract=1"}
	if a != nil {
		spec.AccountID = &a.ID
		spec.Link = "/a/" + a.ID.String() + "/materials?extract=1"
	}
	jobID, err := s.startBackgroundJob(ctx, spec, func(jctx context.Context) (any, error) {
		items, callID, err := s.extractMaterialsFrom(jctx, a, text)
		if err != nil {
			return nil, err
		}
		res := map[string]any{"items": items}
		if callID != nil {
			res["ai_call_id"] = *callID
		}
		return res, nil
	})
	if err != nil {
		return err
	}
	return ok(w, map[string]any{"job_id": jobID})
}
