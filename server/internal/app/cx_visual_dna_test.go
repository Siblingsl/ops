package app

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/google/uuid"
)

type cxVisualDNAResponse struct {
	Version    int             `json:"version"`
	Tokens     json.RawMessage `json:"tokens"`
	TokensHash *string         `json:"tokens_hash"`
}

func TestCXVisualDNAHistoryCASRollbackAndReadIsReadOnly(t *testing.T) {
	// 乱序隔离（A22）：共享 xhs 夹具账号可能已被其它用例写入 visual DNA——
	// 本用例断言"未设置"起点，必须用独立账号。
	_ = env.accounts(t)
	var account Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{
		"platform": "xhs", "name": "视觉DNA隔离验收号", "content_format": "image_note",
	}, &account)
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(context.Background(), `DELETE FROM platform_account WHERE id=$1`, account.ID)
	})
	path := "/api/v1/accounts/" + account.ID.String() + "/visual-dna"
	var initial cxVisualDNAResponse
	for i := 0; i < 2; i++ {
		status, body := env.do("GET", path, nil)
		if status != 200 || json.Unmarshal(body, &initial) != nil {
			t.Fatalf("GET unset visual DNA: status=%d body=%s", status, body)
		}
		if initial.Version != 0 || string(initial.Tokens) != "null" || initial.TokensHash != nil {
			t.Fatalf("unset DNA should be returned without a synthetic v1: %+v", initial)
		}
	}
	var rowCount int
	if err := env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM account_visual_dna WHERE account_id=$1`, account.ID).Scan(&rowCount); err != nil || rowCount != 0 {
		t.Fatalf("GET must not create rows: count=%d err=%v", rowCount, err)
	}

	baseTokens := map[string]any{
		"schema":     "ops.visual-dna/v1",
		"palette":    map[string]string{"primary": "#1B5E20", "secondary": "#1565C0", "background": "#FFFFFF", "text": "#212121", "muted": "#555555"},
		"font_stack": "system-sans", "radius": 12, "spacing_scale": "1.00", "logo_asset_id": nil,
		"watermark":             map[string]string{"text": "", "position": "bottom-right", "opacity": "0.00"},
		"card_template_default": "editorial", "card_ratio_default": "3:4", "end_copy": "",
	}
	for version := 1; version <= 3; version++ {
		tokens := map[string]any{}
		for key, value := range baseTokens {
			tokens[key] = value
		}
		tokens["end_copy"] = strings.Repeat("终", version)
		status, body := env.do("PUT", path, map[string]any{"base_version": version - 1, "tokens": tokens})
		if status != 201 {
			t.Fatalf("save visual DNA v%d: status=%d body=%s", version, status, body)
		}
		var saved struct {
			Version    int    `json:"version"`
			TokensHash string `json:"tokens_hash"`
		}
		if err := json.Unmarshal(body, &saved); err != nil || saved.Version != version || len(saved.TokensHash) != 64 {
			t.Fatalf("unexpected save response: %+v err=%v body=%s", saved, err, body)
		}
	}
	status, body := env.do("POST", path+"/rollback", map[string]any{"base_version": 3, "target_version": 1})
	if status != 201 {
		t.Fatalf("rollback v1 should append v4: status=%d body=%s", status, body)
	}
	var rolled struct {
		Version int `json:"version"`
	}
	if err := json.Unmarshal(body, &rolled); err != nil || rolled.Version != 4 {
		t.Fatalf("rollback should create version 4, got %+v err=%v", rolled, err)
	}
	var current cxVisualDNAResponse
	env.mustJSON(t, "GET", path, nil, &current)
	if current.Version != 4 || !strings.Contains(string(current.Tokens), strings.Repeat("终", 1)) {
		t.Fatalf("rollback must copy the selected historical tokens into current: %+v", current)
	}
	env.expectErr(t, "PUT", path, map[string]any{"base_version": 3, "tokens": baseTokens}, "version_conflict")
	env.expectErr(t, "POST", path+"/rollback", map[string]any{"base_version": 4, "target_version": 99}, "not_found")

	var firstPage struct {
		Items      []cxVisualDNAResponse `json:"items"`
		NextCursor *string               `json:"next_cursor"`
	}
	env.mustJSON(t, "GET", path+"/versions?limit=2", nil, &firstPage)
	if len(firstPage.Items) != 2 || firstPage.Items[0].Version != 4 || firstPage.Items[1].Version != 3 || firstPage.NextCursor == nil {
		t.Fatalf("history should be newest-first and paginated: %+v", firstPage)
	}
	var secondPage struct {
		Items []cxVisualDNAResponse `json:"items"`
	}
	env.mustJSON(t, "GET", path+"/versions?limit=2&cursor="+*firstPage.NextCursor, nil, &secondPage)
	if len(secondPage.Items) != 2 || secondPage.Items[0].Version != 2 || secondPage.Items[1].Version != 1 {
		t.Fatalf("second history page should continue without gaps: %+v", secondPage)
	}
	var detail cxVisualDNAResponse
	env.mustJSON(t, "GET", path+"/versions/1", nil, &detail)
	if detail.Version != 1 || !strings.Contains(string(detail.Tokens), strings.Repeat("终", 1)) {
		t.Fatalf("version detail should retain the original token snapshot: %+v", detail)
	}
}

func TestCXVisualDNAConcurrentSavesUseAccountVersionCAS(t *testing.T) {
	account := env.accounts(t).xhs
	path := "/api/v1/accounts/" + account.ID.String() + "/visual-dna"
	var before cxVisualDNAVersion
	env.mustJSON(t, "GET", path, nil, &before)
	start := make(chan struct{})
	type result struct {
		status int
		body   []byte
	}
	results := make(chan result, 2)
	for _, copy := range []string{"并发窗口甲", "并发窗口乙"} {
		copy := copy
		go func() {
			<-start
			tokens := cxVisualDNATestTokens()
			tokens["end_copy"] = copy
			status, body := env.do("PUT", path, map[string]any{"base_version": before.Version, "tokens": tokens})
			results <- result{status: status, body: body}
		}()
	}
	close(start)

	created, conflicted := 0, 0
	for range 2 {
		got := <-results
		switch got.status {
		case 201:
			created++
		case 409:
			var failure apiError
			if err := json.Unmarshal(got.body, &failure); err != nil || failure.Error.Code != "version_conflict" {
				t.Fatalf("losing concurrent save should return version_conflict: status=%d body=%s err=%v", got.status, got.body, err)
			}
			conflicted++
		default:
			t.Fatalf("concurrent save should succeed or lose CAS: status=%d body=%s", got.status, got.body)
		}
	}
	if created != 1 || conflicted != 1 {
		t.Fatalf("same-base concurrent saves should produce one version and one conflict, got created=%d conflicted=%d", created, conflicted)
	}
	var current cxVisualDNAVersion
	env.mustJSON(t, "GET", path, nil, &current)
	if current.Version != before.Version+1 || current.Tokens == nil || (current.Tokens.EndCopy != "并发窗口甲" && current.Tokens.EndCopy != "并发窗口乙") {
		t.Fatalf("current DNA should contain exactly one winner: %+v", current)
	}
	var versions int
	if err := env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM account_visual_dna WHERE account_id=$1`, account.ID).Scan(&versions); err != nil || versions != before.Version+1 {
		t.Fatalf("concurrent CAS must persist exactly one new version: before=%d versions=%d err=%v", before.Version, versions, err)
	}
}

func TestCXVisualDNAAndAccountAssetScopeStayOutOfAgentTools(t *testing.T) {
	pageOnly := map[string]bool{
		"/accounts/{accountId}/visual-dna":                    true,
		"/accounts/{accountId}/visual-dna/versions":           true,
		"/accounts/{accountId}/visual-dna/versions/{version}": true,
		"/accounts/{accountId}/visual-dna/rollback":           true,
	}
	for _, tool := range agentCatalog() {
		if pageOnly[tool.Path] {
			t.Fatalf("visual DNA page route must not become an agent tool: %s %s", tool.Method, tool.Path)
		}
		if tool.Name == "assets__library" {
			for _, param := range tool.Params {
				if param.Name == "scope" {
					t.Fatal("account-level asset scope must remain unavailable to assets__library")
				}
			}
		}
	}
}

func TestCXVisualDNARejectsUnsafeTokensAndEnforcesAccountAndWorkspaceScope(t *testing.T) {
	account := env.accounts(t).xhs
	path := "/api/v1/accounts/" + account.ID.String() + "/visual-dna"
	valid := map[string]any{
		"schema":     "ops.visual-dna/v1",
		"palette":    map[string]string{"primary": "#1B5E20", "secondary": "#1565C0", "background": "#FFFFFF", "text": "#212121", "muted": "#555555"},
		"font_stack": "system-sans", "radius": 12, "spacing_scale": "1.00", "logo_asset_id": nil,
		"watermark":             map[string]string{"text": "", "position": "bottom-right", "opacity": "0.00"},
		"card_template_default": "editorial", "card_ratio_default": "3:4", "end_copy": "",
	}
	for name, change := range map[string]func(map[string]any){
		"unknown token field": func(v map[string]any) { v["custom_css"] = "color:red" },
		"CSS in copy":         func(v map[string]any) { v["end_copy"] = "url(https://example.test/x)" },
		"bad contrast":        func(v map[string]any) { v["palette"].(map[string]string)["text"] = "#BBBBBB" },
		"unsupported font":    func(v map[string]any) { v["font_stack"] = "Arial, sans-serif" },
		"scale precision":     func(v map[string]any) { v["spacing_scale"] = "1.0" },
	} {
		t.Run(name, func(t *testing.T) {
			tokens := map[string]any{}
			for key, value := range valid {
				tokens[key] = value
			}
			palette := map[string]string{}
			for key, value := range valid["palette"].(map[string]string) {
				palette[key] = value
			}
			tokens["palette"] = palette
			watermark := map[string]string{}
			for key, value := range valid["watermark"].(map[string]string) {
				watermark[key] = value
			}
			tokens["watermark"] = watermark
			change(tokens)
			env.expectErr(t, "PUT", path, map[string]any{"base_version": 0, "tokens": tokens}, "validation_failed")
		})
	}

	foreign := env.accounts(t).wechat
	status, body := env.do("GET", "/api/v1/accounts/"+uuid.NewString()+"/visual-dna", nil)
	if status != 404 {
		t.Fatalf("unknown account must be hidden: status=%d body=%s", status, body)
	}
	if foreign.ID == account.ID {
		t.Fatal("test accounts should be distinct")
	}
}

func TestCXVisualDNALogoIsScopedToAccountWorkspaceAndEnabledAccount(t *testing.T) {
	ctx := context.Background()
	fixture := env.accounts(t)
	account, foreignAccount := fixture.xhs, fixture.wechat
	var workspace uuid.UUID
	if err := env.srv.db.QueryRow(ctx, `SELECT workspace_id FROM platform_account WHERE id=$1`, account.ID).Scan(&workspace); err != nil {
		t.Fatal(err)
	}
	var actor uuid.UUID
	if err := env.srv.db.QueryRow(ctx, `SELECT user_id FROM workspace_member WHERE workspace_id=$1 AND role='owner' AND status='active' LIMIT 1`, workspace).Scan(&actor); err != nil {
		t.Fatal(err)
	}
	otherWorkspace := uuid.New()
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO workspace(id,name,created_by_user_id) VALUES($1,'CX08 logo scope',$2)`, otherWorkspace, actor); err != nil {
		t.Fatal(err)
	}
	insertAsset := func(accountID, workspaceID uuid.UUID) uuid.UUID {
		t.Helper()
		id := uuid.New()
		_, err := env.srv.db.Exec(ctx, `INSERT INTO asset(id,workspace_id,account_id,storage_path,mime,width,height,bytes,sha256,position,alt_text)
			VALUES($1,$2,$3,$4,'image/png',32,32,100,$5,0,'测试账号标识')`, id, workspaceID, accountID,
			"cx08-test/"+id.String()+".png", strings.Repeat("a", 64))
		if err != nil {
			t.Fatalf("insert test account image: %v", err)
		}
		return id
	}
	validLogo := insertAsset(account.ID, workspace)
	otherAccountLogo := insertAsset(foreignAccount.ID, workspace)
	wrongWorkspaceLogo := insertAsset(account.ID, otherWorkspace)
	var listed []AccountLibraryAsset
	env.mustJSON(t, "GET", "/api/v1/assets?scope=account&account_id="+account.ID.String(), nil, &listed)
	if len(listed) != 1 || listed[0].ID != validLogo {
		t.Fatalf("account logo listing must be limited to account-level images in the active workspace: %+v", listed)
	}

	tokens := cxVisualDNATestTokens()
	tokens["logo_asset_id"] = validLogo.String()
	path := "/api/v1/accounts/" + account.ID.String() + "/visual-dna"
	var current cxVisualDNAVersion
	env.mustJSON(t, "GET", path, nil, &current)
	baseVersion := current.Version
	status, body := env.do("PUT", path, map[string]any{"base_version": baseVersion, "tokens": tokens})
	if status != 201 {
		t.Fatalf("a same-account workspace logo should be accepted: %d %s", status, body)
	}
	for name, logoID := range map[string]uuid.UUID{"other account": otherAccountLogo, "other workspace": wrongWorkspaceLogo} {
		t.Run(name, func(t *testing.T) {
			candidate := cxVisualDNATestTokens()
			candidate["logo_asset_id"] = logoID.String()
			env.expectErr(t, "PUT", path, map[string]any{"base_version": baseVersion + 1, "tokens": candidate}, "validation_failed")
		})
	}

	if _, err := env.srv.db.Exec(ctx, `UPDATE platform_account SET status='disabled' WHERE id=$1`, account.ID); err != nil {
		t.Fatal(err)
	}
	defer env.srv.db.Exec(context.Background(), `UPDATE platform_account SET status='active' WHERE id=$1`, account.ID)
	env.expectErr(t, "PUT", path, map[string]any{"base_version": baseVersion + 1, "tokens": cxVisualDNATestTokens()}, "account_disabled")

	var userID uuid.UUID
	if err := env.srv.db.QueryRow(ctx, `SELECT user_id FROM workspace_member WHERE workspace_id=$1 AND role='owner' AND status='active' LIMIT 1`, workspace).Scan(&userID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(ctx, `UPDATE workspace_member SET role='viewer' WHERE workspace_id=$1 AND user_id=$2`, workspace, userID); err != nil {
		t.Fatal(err)
	}
	defer env.srv.db.Exec(context.Background(), `UPDATE workspace_member SET role='owner',status='active' WHERE workspace_id=$1 AND user_id=$2`, workspace, userID)
	env.expectErr(t, "PUT", path, map[string]any{"base_version": baseVersion + 1, "tokens": cxVisualDNATestTokens()}, "forbidden")
}

func cxVisualDNATestTokens() map[string]any {
	return map[string]any{
		"schema":     "ops.visual-dna/v1",
		"palette":    map[string]string{"primary": "#1B5E20", "secondary": "#1565C0", "background": "#FFFFFF", "text": "#212121", "muted": "#555555"},
		"font_stack": "system-sans", "radius": 12, "spacing_scale": "1.00", "logo_asset_id": nil,
		"watermark":             map[string]string{"text": "", "position": "bottom-right", "opacity": "0.00"},
		"card_template_default": "editorial", "card_ratio_default": "3:4", "end_copy": "",
	}
}
