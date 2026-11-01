package app

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestRenderCheckReportsUnsupportedSyntaxAgainstCurrentRevision(t *testing.T) {
	account := env.accounts(t).wechat
	var work Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+account.ID.String()+"/works", map[string]any{"title": "语法检查"}, &work)
	env.mustJSON(t, "PATCH", "/api/v1/works/"+work.ID.String(), map[string]any{"viewpoint": "引用应保留可核对来源。", "base_revision": work.Revision}, nil)
	env.mustJSON(t, "GET", "/api/v1/works/"+work.ID.String(), nil, &work)
	env.mustJSON(t, "PUT", "/api/v1/works/"+work.ID.String()+"/outline", map[string]any{
		"confirm": true, "base_revision": work.Revision,
		"items": []map[string]any{{"heading": "引用", "key_point": "检查脚注标记", "material_ids": []string{}}},
	}, &work)
	section := work.Sections[0]
	content := "引用事实[^1]。\n\n[^1]: 资料来源。"
	env.mustJSON(t, "PATCH", "/api/v1/sections/"+section.ID.String(), map[string]any{
		"content_md": content, "base_revision": section.Revision,
	}, nil)
	env.mustJSON(t, "GET", "/api/v1/works/"+work.ID.String(), nil, &work)
	staleStatus, staleBody := env.do("POST", "/api/v1/works/"+work.ID.String()+"/render-check", map[string]any{"basis_revision": work.Revision - 1})
	if staleStatus != 409 || !strings.Contains(string(staleBody), `"version_conflict"`) {
		t.Fatalf("stale basis must be rejected with version_conflict: status=%d body=%s", staleStatus, staleBody)
	}

	status, body := env.do("POST", "/api/v1/works/"+work.ID.String()+"/render-check", map[string]any{"basis_revision": work.Revision})
	if status != 422 {
		t.Fatalf("render-check status = %d, want 422; body=%s", status, body)
	}
	var response struct {
		Error struct {
			Code   string          `json:"code"`
			Detail json.RawMessage `json:"detail"`
		} `json:"error"`
	}
	if err := json.Unmarshal(body, &response); err != nil {
		t.Fatal(err)
	}
	if response.Error.Code != "render_unsupported_syntax" {
		t.Fatalf("error code = %q, body=%s", response.Error.Code, body)
	}
	var report struct {
		BasisRevision int `json:"basis_revision"`
		Issues        []struct {
			SectionID string `json:"section_id"`
			Line      int    `json:"line"`
			Column    int    `json:"column"`
			Syntax    string `json:"syntax"`
		} `json:"issues"`
	}
	if err := json.Unmarshal(response.Error.Detail, &report); err != nil {
		t.Fatalf("decode syntax report: %v; detail=%s", err, response.Error.Detail)
	}
	if report.BasisRevision != work.Revision || len(report.Issues) == 0 {
		t.Fatalf("report does not carry current basis and issue: %+v", report)
	}
	found := false
	for _, issue := range report.Issues {
		if issue.SectionID == section.ID.String() && issue.Line == 1 && issue.Column == 5 && issue.Syntax == "footnote" {
			found = true
		}
	}
	if !found {
		t.Fatalf("report must locate the real footnote at line 1, column 5: %+v", report.Issues)
	}
	if allowed := viewerMutateAllowed("/api/v1/works/" + work.ID.String() + "/render-check"); !allowed {
		t.Fatal("viewer must be allowed to call the read-only render-check route")
	}
}
