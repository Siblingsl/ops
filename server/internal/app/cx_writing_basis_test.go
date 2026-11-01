package app

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func cxBasisHasSource(basis cxBasisReceipt, kind string) bool {
	for _, source := range basis.Sources {
		if source.Kind == kind {
			return true
		}
	}
	return false
}

func cxBasisHasOmission(basis cxBasisReceipt, ref string) bool {
	for _, omission := range basis.Omitted {
		if omission.Ref == ref {
			return true
		}
	}
	return false
}

func TestCXExistingWritingBasisRevalidatesMaterials(t *testing.T) {
	f := env.accounts(t)
	me := env.me(t)
	workspaceID := uuid.MustParse(me.Workspace.ID)
	userID := uuid.MustParse(me.UserID)
	var sessionID uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(), `SELECT id FROM session WHERE user_id=$1 AND current_workspace_id=$2 AND expires_at>now()
		ORDER BY last_seen_at DESC LIMIT 1`, userID, workspaceID).Scan(&sessionID); err != nil {
		t.Fatal(err)
	}
	ctx := context.WithValue(context.Background(), ctxMember, &identity{SessionID: sessionID, UserID: userID, WorkspaceID: workspaceID, Role: "owner"})
	materialID := uuid.New()
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO material (id,workspace_id,account_id,kind,content,source) VALUES ($1,$2,$3,'experience','本人提供的经历','测试')`, materialID, workspaceID, f.wechat.ID); err != nil {
		t.Fatal(err)
	}
	var workID uuid.UUID
	if err := env.srv.db.QueryRow(ctx, `INSERT INTO work (account_id,content_format,title,viewpoint) VALUES ($1,'long_article','来源回执测试','先说明本人观点') RETURNING id`, f.wechat.ID).Scan(&workID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO work_material (work_id,material_id) VALUES ($1,$2)`, workID, materialID); err != nil {
		t.Fatal(err)
	}
	var strategyID uuid.UUID
	err := env.srv.db.QueryRow(ctx, `SELECT id FROM account_strategy WHERE account_id=$1 AND status='active'`, f.wechat.ID).Scan(&strategyID)
	if errors.Is(err, pgx.ErrNoRows) {
		var version int
		if err := env.srv.db.QueryRow(ctx, `SELECT COALESCE(MAX(version),0)+1 FROM account_strategy WHERE account_id=$1`, f.wechat.ID).Scan(&version); err != nil {
			t.Fatal(err)
		}
		if err := env.srv.db.QueryRow(ctx, `INSERT INTO account_strategy (account_id,version,status) VALUES ($1,$2,'active') RETURNING id`, f.wechat.ID, version).Scan(&strategyID); err != nil {
			t.Fatal(err)
		}
	} else if err != nil {
		t.Fatal(err)
	}
	m, err := env.srv.workMeta(ctx, workID)
	if err != nil {
		t.Fatal(err)
	}
	mids, err := env.srv.workMaterialIDs(ctx, workID)
	if err != nil {
		t.Fatal(err)
	}
	work, err := env.srv.workBrief(ctx, m)
	if err != nil {
		t.Fatal(err)
	}
	task := aiTask{Type: "outline", Account: m.Account, WorkID: &workID, Work: work, User: "生成一份只基于本人材料的大纲", Materials: mids,
		CXBasisEnabled: true, CXExpectedWorkRev: cxExpectedWorkRevision(m.Revision)}
	pack, err := env.srv.buildContext(ctx, task)
	if err != nil {
		t.Fatal(err)
	}
	legacyTask := task
	legacyTask.CXBasisEnabled = false
	legacyPack, err := env.srv.buildContext(ctx, legacyTask)
	if err != nil {
		t.Fatal(err)
	}
	for _, slot := range legacyPack.Slots {
		for _, item := range slot.Items {
			if item.SourceKind != "" || item.AsOfAt != nil || item.ContentHash != "" || item.State != "" || item.Purpose != "" {
				t.Fatalf("legacy task refs must not gain CX-only source metadata: %+v", item)
			}
		}
	}
	basis, err := env.srv.cxWritingBasis(ctx, task, pack)
	if err != nil {
		t.Fatal(err)
	}
	if basis.ProfileHash == "" || basis.InputHash == "" || !cxBasisHasSource(*basis, "material") {
		t.Fatalf("expected profile and selected material sources: %+v", basis)
	}
	if basis.StrategyRef == nil || *basis.StrategyRef != "strategy:"+strategyID.String() || !cxBasisHasSource(*basis, "strategy") {
		t.Fatalf("expected strategy_ref to point to the selected strategy source: %+v", basis)
	}
	if _, err := env.srv.db.Exec(ctx, `UPDATE material SET content='已修改的本人经历',updated_at=updated_at+interval '1 second' WHERE id=$1`, materialID); err != nil {
		t.Fatal(err)
	}
	if err := env.srv.verifyCXWritingBasis(ctx, workID, basis); err == nil {
		t.Fatal("changed material should invalidate the assembled basis")
	} else if apiErr := err.(*APIError); apiErr.Code != "version_conflict" {
		t.Fatalf("expected version_conflict, got %v", err)
	}
}
