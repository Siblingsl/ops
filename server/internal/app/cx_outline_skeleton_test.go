package app

import (
	"encoding/json"
	"strings"
	"testing"
)

// DEV-CX12 / FR-CX-14：骨架引用供大纲使用——
// 用户显式选择同账号拆解骨架；只注入受限字段；跨账号/未知 ID 拒绝；
// cx_basis v1 无该来源类型 → omitted 登记并指向 refs。
func TestCXOutlineSkeletonReference(t *testing.T) {
	ensureStructureRoute(t)
	account := env.accounts(t).xhs
	var target struct {
		ID string `json:"id"`
	}
	status, body := env.do("POST", "/api/v1/accounts/"+account.ID.String()+"/benchmarks", map[string]any{"platform": "xhs", "name": "骨架引用目标"})
	if status != 201 {
		t.Fatalf("target: %d %s", status, body)
	}
	_ = json.Unmarshal(body, &target)
	var note struct {
		ID string `json:"id"`
	}
	status, body = env.do("POST", "/api/v1/benchmarks/"+target.ID+"/notes", map[string]any{
		"title": "引用用骨架", "structure": map[string]any{
			"hook_type": "contrast", "hook_gist": "对比式开场",
			"sections": []map[string]any{{"role": "problem"}, {"role": "method"}, {"role": "conclusion"}},
			"cta_type": "save", "rhythm": map[string]any{"paragraphs": 5, "avg_chars": 100},
		},
	})
	if status != 201 || json.Unmarshal(body, &note) != nil {
		t.Fatalf("note: status=%d body=%s", status, body)
	}

	// 建一个可生成大纲的作品（viewpoint 必填）。
	var work Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+account.ID.String()+"/works", map[string]string{"title": "骨架引用大纲"}, &work)
	env.mustJSON(t, "PATCH", "/api/v1/works/"+work.ID.String(), map[string]any{
		"viewpoint": "拆解骨架只提供结构参考，观点与事实仍来自作者。", "base_revision": work.Revision,
	}, nil)

	// 携带骨架引用生成大纲：成功且 refs 登记骨架、cx_basis.omitted 说明来源类型缺失。
	status, body = env.do("POST", "/api/v1/works/"+work.ID.String()+"/outline/generate", map[string]any{
		"skeleton_note_ids": []string{note.ID},
	})
	if status != 200 {
		t.Fatalf("outline with skeleton: status=%d body=%s", status, body)
	}
	var outline struct {
		Refs   map[string]any `json:"refs"`
		CXBasis *struct {
			Omitted []struct {
				Ref    string `json:"ref"`
				Reason string `json:"reason"`
			} `json:"omitted"`
		} `json:"cx_basis"`
	}
	if err := json.Unmarshal(body, &outline); err != nil {
		t.Fatalf("decode: %v body=%s", err, body)
	}
	refsJSON, _ := json.Marshal(outline.Refs["benchmark_skeletons"])
	if !strings.Contains(string(refsJSON), note.ID) {
		t.Fatalf("refs must record the skeleton note: %s", refsJSON)
	}
	if outline.CXBasis == nil {
		t.Fatalf("outline cx_basis missing: %s", body)
	}
	found := false
	for _, omission := range outline.CXBasis.Omitted {
		if omission.Ref == "benchmark_skeleton" && strings.Contains(omission.Reason, "refs.benchmark_skeletons") {
			found = true
		}
	}
	if !found {
		t.Fatalf("cx_basis.omitted must explain the skeleton source: %+v", outline.CXBasis.Omitted)
	}

	// 跨账号骨架 ID 拒绝。
	otherAccount := env.accounts(t).wechat
	var otherWork Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+otherAccount.ID.String()+"/works", map[string]string{"title": "别家大纲"}, &otherWork)
	env.mustJSON(t, "PATCH", "/api/v1/works/"+otherWork.ID.String(), map[string]any{
		"viewpoint": "别家账号也要有观点才能触达骨架校验。", "base_revision": otherWork.Revision,
	}, nil)
	status, body = env.do("POST", "/api/v1/works/"+otherWork.ID.String()+"/outline/generate", map[string]any{
		"skeleton_note_ids": []string{note.ID},
	})
	if status != 422 || !strings.Contains(string(body), "不在当前账号范围内") {
		t.Fatalf("foreign skeleton must be rejected: status=%d body=%s", status, body)
	}
	// 超过 5 条拒绝。
	status, body = env.do("POST", "/api/v1/works/"+work.ID.String()+"/outline/generate", map[string]any{
		"skeleton_note_ids": []string{note.ID, note.ID, note.ID, note.ID, note.ID, note.ID},
	})
	if status != 422 {
		t.Fatalf("more than 5 skeletons must 422: %d", status)
	}
}
