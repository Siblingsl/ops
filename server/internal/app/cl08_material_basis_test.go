package app

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func checkedCardWorkWithMaterials(t *testing.T, validUntil string) (Work, Material) {
	wk, material := cardWorkWithMaterialsOnPlatform(t, "xhs", validUntil)
	env.confirmChecks(t, wk.ID.String())
	env.mustJSON(t, "GET", "/api/v1/works/"+wk.ID.String(), nil, &wk)
	return wk, material
}

func cardWorkWithMaterials(t *testing.T, validUntil string) (Work, Material) {
	return cardWorkWithMaterialsOnPlatform(t, "xhs", validUntil)
}

func cardWorkWithMaterialsOnPlatform(t *testing.T, platform, validUntil string) (Work, Material) {
	t.Helper()
	_, wk := buildCardWork(t, platform)
	var material Material
	env.mustJSON(t, "POST", "/api/v1/materials", map[string]any{
		"account_id":  wk.AccountID,
		"kind":        "data",
		"content":     "用户调查中，多数受访者偏好简短步骤。",
		"source":      "内部用户调查",
		"valid_until": validUntil,
	}, &material)
	env.mustJSON(t, "GET", "/api/v1/works/"+wk.ID.String(), nil, &wk)
	env.mustJSON(t, "PATCH", "/api/v1/works/"+wk.ID.String(), map[string]any{
		"material_ids":  []uuid.UUID{material.ID},
		"base_revision": wk.Revision,
	}, &wk)
	env.mustJSON(t, "PUT", "/api/v1/sections/"+wk.Sections[0].ID.String()+"/materials", map[string]any{
		"material_ids": []uuid.UUID{material.ID},
	}, nil)
	return wk, material
}

func TestCL08XhsPackRejectsChangedMaterialBasis(t *testing.T) {
	wk, material := checkedCardWorkWithMaterials(t, env.srv.today().AddDate(0, 0, 5).Format("2006-01-02"))
	validUntil := env.srv.today().AddDate(0, 0, 5).Format("2006-01-02")
	env.mustJSON(t, "PATCH", "/api/v1/materials/"+material.ID.String(), map[string]any{
		"account_id":  wk.AccountID,
		"kind":        "data",
		"content":     "用户调查更新后，更多受访者偏好简短步骤。",
		"source":      "更新后的内部用户调查",
		"valid_until": validUntil,
	}, nil)

	env.expectErr(t, "POST", "/api/v1/works/"+wk.ID.String()+"/xhs/pack", map[string]int{"basis_revision": wk.Revision}, "material_basis_stale")
	env.mustJSON(t, "GET", "/api/v1/works/"+wk.ID.String(), nil, &wk)
	if wk.Status != "ready" {
		t.Fatalf("stale material basis changed work status: %s", wk.Status)
	}
}

func TestCL08XhsPackAllowsTagOnlyMaterialChange(t *testing.T) {
	wk, material := checkedCardWorkWithMaterials(t, env.srv.today().AddDate(0, 0, 5).Format("2006-01-02"))
	env.mustJSON(t, "PATCH", "/api/v1/materials/"+material.ID.String(), map[string]any{
		"account_id":  wk.AccountID,
		"kind":        material.Kind,
		"content":     material.Content,
		"source":      material.Source,
		"tags":        []string{"reclassified"},
		"valid_until": material.ValidUntil,
	}, nil)
	env.mustJSON(t, "POST", "/api/v1/works/"+wk.ID.String()+"/xhs/pack", map[string]int{"basis_revision": wk.Revision}, &wk)
	if wk.Status != "packed" {
		t.Fatalf("tag-only edit should preserve checked basis, got status %s", wk.Status)
	}
}

func TestCL08XhsPackRejectsExpiredMaterialAtShanghaiMidnight(t *testing.T) {
	today := env.srv.today()
	wk, _ := checkedCardWorkWithMaterials(t, today.Format("2006-01-02"))
	originalNow := env.srv.now
	t.Cleanup(func() { env.srv.now = originalNow })
	tomorrow := today.AddDate(0, 0, 1)
	env.srv.now = func() time.Time { return tomorrow.Add(time.Hour) }
	env.expectErr(t, "POST", "/api/v1/works/"+wk.ID.String()+"/xhs/pack", map[string]int{"basis_revision": wk.Revision}, "material_basis_stale")
}

func TestCL08XhsPackRejectsChangedSectionMaterialReferences(t *testing.T) {
	wk, _ := checkedCardWorkWithMaterials(t, env.srv.today().AddDate(0, 0, 5).Format("2006-01-02"))
	env.mustJSON(t, "PUT", "/api/v1/sections/"+wk.Sections[0].ID.String()+"/materials", map[string]any{
		"material_ids": []uuid.UUID{},
	}, nil)
	// The material remains linked to the work as a whole, so remove that reference too.
	env.mustJSON(t, "PATCH", "/api/v1/works/"+wk.ID.String(), map[string]any{
		"material_ids":  []uuid.UUID{},
		"base_revision": wk.Revision,
	}, &wk)
	env.expectErr(t, "POST", "/api/v1/works/"+wk.ID.String()+"/xhs/pack", map[string]int{"basis_revision": wk.Revision}, "material_basis_stale")
}

func TestCL08XhsPackRejectsDeletedMaterial(t *testing.T) {
	wk, material := checkedCardWorkWithMaterials(t, env.srv.today().AddDate(0, 0, 5).Format("2006-01-02"))
	env.mustJSON(t, "DELETE", "/api/v1/materials/"+material.ID.String(), nil, nil)
	env.expectErr(t, "POST", "/api/v1/works/"+wk.ID.String()+"/xhs/pack", map[string]int{"basis_revision": wk.Revision}, "material_basis_stale")
	run := env.latestCheck(t, wk.ID.String())
	if !run.MaterialBasisStale || run.MaterialBasisUnavailable != 2 {
		t.Fatalf("deleted work and section references should be reported without source text: %+v", run)
	}
}

func TestCL08InvisibleMaterialIsNotIncludedInFactContext(t *testing.T) {
	wk, material := checkedCardWorkWithMaterials(t, env.srv.today().AddDate(0, 0, 5).Format("2006-01-02"))
	var other Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{
		"platform": "xhs", "name": "另一账号", "content_format": "image_note",
	}, &other)
	env.mustJSON(t, "PATCH", "/api/v1/materials/"+material.ID.String(), map[string]any{
		"account_id":  other.ID,
		"kind":        material.Kind,
		"content":     material.Content,
		"source":      material.Source,
		"valid_until": material.ValidUntil,
	}, nil)
	run := env.latestCheck(t, wk.ID.String())
	if !run.MaterialBasisStale || run.MaterialBasisUnavailable != 2 {
		t.Fatalf("cross-account references should be stale and counted, got %+v", run)
	}
	var workspaceID uuid.UUID
	ctx := context.Background()
	if err := env.srv.db.QueryRow(ctx, `SELECT workspace_id FROM platform_account WHERE id=$1`, wk.AccountID).Scan(&workspaceID); err != nil {
		t.Fatal(err)
	}
	memberCtx := context.WithValue(ctx, ctxMember, &identity{WorkspaceID: workspaceID})
	account, err := env.srv.account(memberCtx, wk.AccountID)
	if err != nil {
		t.Fatal(err)
	}
	text, slot, _, err := env.srv.materialsSlot(memberCtx, &account.ID, []uuid.UUID{material.ID})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(text, material.Content) || len(slot.Items) != 0 {
		t.Fatalf("invisible material content leaked to the fact-check context: text=%q slot=%+v", text, slot)
	}
	env.expectErr(t, "POST", "/api/v1/works/"+wk.ID.String()+"/xhs/pack", map[string]int{"basis_revision": wk.Revision}, "material_basis_stale")
}

func TestCL08AsyncFactResultIsDiscardedAfterMaterialChange(t *testing.T) {
	wk, material := cardWorkWithMaterials(t, env.srv.today().AddDate(0, 0, 5).Format("2006-01-02"))
	originalDelay := env.llm.Delay
	env.llm.Delay = 10 * time.Millisecond
	t.Cleanup(func() { env.llm.Delay = originalDelay })
	env.llm.ResetRequests()
	env.mustJSON(t, "POST", "/api/v1/works/"+wk.ID.String()+"/checks", map[string]int{"html_chars": 3000, "html_bytes": 9000}, nil)
	deadline := time.Now().Add(5 * time.Second)
	for len(env.llm.Requests()) == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if len(env.llm.Requests()) == 0 {
		t.Fatal("fact-check model request did not start")
	}
	if _, err := env.srv.db.Exec(context.Background(), `UPDATE material SET content=content || '（更新）', updated_at=now() WHERE id=$1`, material.ID); err != nil {
		t.Fatal(err)
	}
	run := env.latestCheck(t, wk.ID.String())
	if run.FactStatus != "failed" || !run.MaterialBasisStale {
		t.Fatalf("stale async result should be discarded and require a new check: %+v", run)
	}
	for _, item := range run.Items {
		if item.Category == "fact" {
			t.Fatalf("fact items were saved after the material basis changed: %+v", item)
		}
	}
}

func TestCL08WechatPreviewAndPushRejectChangedMaterialBasis(t *testing.T) {
	wk, material := cardWorkWithMaterialsOnPlatform(t, "wechat_mp", env.srv.today().AddDate(0, 0, 5).Format("2006-01-02"))
	env.reauth(t)
	env.mustJSON(t, "PUT", "/api/v1/accounts/"+wk.AccountID.String()+"/wechat-credential", map[string]string{
		"app_id": "wx1234567890", "app_secret": "cl08-test-secret",
	}, nil)
	var credentialTest map[string]any
	env.mustJSON(t, "POST", "/api/v1/accounts/"+wk.AccountID.String()+"/wechat-credential/test", nil, &credentialTest)
	env.confirmChecks(t, wk.ID.String())
	env.mustJSON(t, "GET", "/api/v1/works/"+wk.ID.String(), nil, &wk)
	env.mustJSON(t, "PATCH", "/api/v1/materials/"+material.ID.String(), map[string]any{
		"account_id":  wk.AccountID,
		"kind":        material.Kind,
		"content":     material.Content,
		"source":      material.Source + " 更新",
		"valid_until": material.ValidUntil,
	}, nil)
	var preview struct {
		CanPush            bool `json:"can_push"`
		MaterialBasisStale bool `json:"material_basis_stale"`
	}
	env.mustJSON(t, "GET", "/api/v1/works/"+wk.ID.String()+"/wechat/push-preview", nil, &preview)
	if preview.CanPush || !preview.MaterialBasisStale {
		t.Fatalf("push preview did not show stale material basis: %+v", preview)
	}
	env.expectErr(t, "POST", "/api/v1/works/"+wk.ID.String()+"/wechat/push", map[string]any{
		"revision": wk.Revision,
		"fields":   WechatDefaults{},
	}, "material_basis_stale")
}

func TestCL08ReviewApprovalRejectsChangedMaterialBasis(t *testing.T) {
	wk, material := cardWorkWithMaterials(t, env.srv.today().AddDate(0, 0, 5).Format("2006-01-02"))
	env.mustJSON(t, "PATCH", "/api/v1/works/"+wk.ID.String(), map[string]any{
		"review_required": true,
		"base_revision":   wk.Revision,
	}, &wk)
	env.confirmChecks(t, wk.ID.String())
	env.mustJSON(t, "GET", "/api/v1/works/"+wk.ID.String(), nil, &wk)
	if wk.Status != "reviewing" {
		t.Fatalf("review should be required, got status %s", wk.Status)
	}
	env.mustJSON(t, "PATCH", "/api/v1/materials/"+material.ID.String(), map[string]any{
		"account_id":  wk.AccountID,
		"kind":        material.Kind,
		"content":     material.Content,
		"source":      material.Source + " 更新",
		"valid_until": material.ValidUntil,
	}, nil)
	env.expectErr(t, "POST", "/api/v1/works/"+wk.ID.String()+"/review/approve", nil, "material_basis_stale")
	env.mustJSON(t, "GET", "/api/v1/works/"+wk.ID.String(), nil, &wk)
	if wk.Status != "reviewing" {
		t.Fatalf("stale approval changed work status: %s", wk.Status)
	}
}

func TestCL08ChangedBasisDoesNotCarryFactConfirmations(t *testing.T) {
	wk, material := checkedCardWorkWithMaterials(t, env.srv.today().AddDate(0, 0, 5).Format("2006-01-02"))
	run := env.latestCheck(t, wk.ID.String())
	fp := fingerprint("fact", "cl08-preserve-check", "synthetic fact claim")
	if _, err := env.srv.db.Exec(context.Background(), `INSERT INTO check_item
		(check_run_id, category, fingerprint, matched_text, message, resolution, resolved_at)
		VALUES ($1,'fact',$2,'synthetic fact claim','测试事实','verified',now())`, run.ID, fp); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(context.Background(), `UPDATE material SET content=content || '（新依据）' WHERE id=$1`, material.ID); err != nil {
		t.Fatal(err)
	}
	tx, err := env.srv.db.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	var lockedID uuid.UUID
	if err := tx.QueryRow(context.Background(), `SELECT id FROM work WHERE id=$1 FOR UPDATE`, wk.ID).Scan(&lockedID); err != nil {
		t.Fatal(err)
	}
	basis, err := env.srv.materialBasisHash(context.Background(), tx, wk.ID, true)
	if err != nil {
		t.Fatal(err)
	}
	var nextRun uuid.UUID
	if err := tx.QueryRow(context.Background(), `INSERT INTO check_run(work_id,revision,target_platform,fact_status,material_basis_hash)
		VALUES ($1,$2,'xhs','done',$3) RETURNING id`, wk.ID, wk.Revision, basis).Scan(&nextRun); err != nil {
		t.Fatal(err)
	}
	item := CheckItem{Category: "fact", Message: "测试事实", MatchedText: "synthetic fact claim", Location: map[string]any{}, fingerprint: fp}
	if err := env.srv.insertItems(context.Background(), tx, wk.ID, nextRun, []CheckItem{item}); err != nil {
		t.Fatal(err)
	}
	var resolutionIsNull bool
	if err := tx.QueryRow(context.Background(), `SELECT resolution IS NULL FROM check_item WHERE check_run_id=$1 AND fingerprint=$2`, nextRun, fp).Scan(&resolutionIsNull); err != nil {
		t.Fatal(err)
	}
	if !resolutionIsNull {
		t.Fatal("a fact confirmation from a different material basis was carried to the new check")
	}
	if err := tx.Commit(context.Background()); err != nil {
		t.Fatal(err)
	}
}
