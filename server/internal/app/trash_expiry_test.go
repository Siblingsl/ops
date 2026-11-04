package app

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestPurgeExpiredTrashHonorsThirtyDayBoundary(t *testing.T) {
	account := env.accounts(t).xhs
	workspaceID, err := uuid.Parse(env.me(t).Workspace.ID)
	if err != nil {
		t.Fatal(err)
	}

	originalNow := env.srv.now
	fixedNow := originalNow().Truncate(time.Second)
	env.srv.now = func() time.Time { return fixedNow }
	t.Cleanup(func() { env.srv.now = originalNow })

	var retained, expired struct {
		Topic struct {
			ID uuid.UUID `json:"id"`
		} `json:"topic"`
	}
	env.mustJSON(t, "POST", "/api/v1/accounts/"+account.ID.String()+"/topics", map[string]string{
		"title": "QA26 保留在 30 天边界的选题 " + uuid.NewString(), "angle": "时间边界验收",
	}, &retained)
	env.mustJSON(t, "POST", "/api/v1/accounts/"+account.ID.String()+"/topics", map[string]string{
		"title": "QA26 超过 30 天清理的选题 " + uuid.NewString(), "angle": "时间边界验收",
	}, &expired)
	env.mustJSON(t, "DELETE", "/api/v1/topics/"+retained.Topic.ID.String(), nil, nil)
	env.mustJSON(t, "DELETE", "/api/v1/topics/"+expired.Topic.ID.String(), nil, nil)

	ctx := context.WithValue(context.Background(), ctxMember, &identity{WorkspaceID: workspaceID})
	cutoff := fixedNow.AddDate(0, 0, -trashDays)
	if _, err := env.srv.db.Exec(ctx, `UPDATE topic SET deleted_at=$2 WHERE id=$1`, retained.Topic.ID, cutoff); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(ctx, `UPDATE topic SET deleted_at=$2 WHERE id=$1`, expired.Topic.ID, cutoff.Add(-time.Second)); err != nil {
		t.Fatal(err)
	}
	var overdueBefore int64
	for _, definition := range trashTables {
		var tableCount int64
		if err := env.srv.db.QueryRow(ctx, `SELECT count(*) FROM `+definition.table+` WHERE deleted_at IS NOT NULL AND deleted_at < $1`, cutoff).Scan(&tableCount); err != nil {
			t.Fatal(err)
		}
		overdueBefore += tableCount
	}

	count, err := env.srv.PurgeExpiredTrash(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if int64(count) != overdueBefore {
		t.Fatalf("purge count = %d, want all %d items strictly older than 30 days", count, overdueBefore)
	}
	var retainedExists, expiredExists bool
	if err := env.srv.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM topic WHERE id=$1), EXISTS(SELECT 1 FROM topic WHERE id=$2)`, retained.Topic.ID, expired.Topic.ID).Scan(&retainedExists, &expiredExists); err != nil {
		t.Fatal(err)
	}
	if !retainedExists || expiredExists {
		t.Fatalf("boundary item exists=%v, expired item exists=%v; want true/false", retainedExists, expiredExists)
	}
}
