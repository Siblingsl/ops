package app

import (
	"context"
	"os"
	"path/filepath"
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

func TestRunJobsPurgesExpiredWorkAndAssetDirectory(t *testing.T) {
	originalNow := env.srv.now
	fixedNow := time.Date(2026, time.November, 5, 2, 30, 0, 0, env.srv.loc)
	env.srv.now = func() time.Time { return fixedNow }
	t.Cleanup(func() { env.srv.now = originalNow })

	var account Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{
		"platform": "xhs", "name": "QA26 回收站调度验收",
		"content_format": "image_note",
	}, &account)
	var work Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+account.ID.String()+"/works", map[string]string{
		"title": "QA26 到期清理调度作品",
	}, &work)
	var topic struct {
		Topic struct {
			ID uuid.UUID `json:"id"`
		} `json:"topic"`
	}
	env.mustJSON(t, "POST", "/api/v1/accounts/"+account.ID.String()+"/topics", map[string]string{
		"title": "QA26 到期清理调度选题", "angle": "调度入口验收",
	}, &topic)

	env.upload(t, work.ID.String(), testPNG(48, 32))
	assetDir := filepath.Join(env.srv.cfg.DataDir, "assets", work.ID.String())
	assets, err := os.ReadDir(assetDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(assets) == 0 {
		t.Fatal("test image upload did not create an asset file")
	}

	cutoff := fixedNow.AddDate(0, 0, -trashDays)
	if _, err := env.srv.db.Exec(t.Context(), `UPDATE work SET deleted_at=$2 WHERE id=$1`, work.ID, cutoff.Add(-time.Second)); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(t.Context(), `UPDATE topic SET deleted_at=$2 WHERE id=$1`, topic.Topic.ID, cutoff.Add(-time.Second)); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		env.srv.RunJobs(ctx)
		close(done)
	}()
	defer func() {
		cancel()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Error("RunJobs did not stop after context cancellation")
		}
	}()

	deadline := time.NewTimer(10 * time.Second)
	defer deadline.Stop()
	poll := time.NewTicker(20 * time.Millisecond)
	defer poll.Stop()
	for {
		var exists bool
		if err := env.srv.db.QueryRow(t.Context(), `SELECT EXISTS(SELECT 1 FROM work WHERE id=$1) OR EXISTS(SELECT 1 FROM topic WHERE id=$2)`, work.ID, topic.Topic.ID).Scan(&exists); err != nil {
			t.Fatal(err)
		}
		if !exists {
			break
		}
		select {
		case <-deadline.C:
			t.Fatal("RunJobs did not purge the expired work on its startup pass")
		case <-poll.C:
		}
	}

	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("RunJobs did not finish its startup pass after cancellation")
	}
	if _, err := os.Stat(assetDir); !os.IsNotExist(err) {
		t.Fatalf("expired work asset directory still exists: err=%v", err)
	}
}

// This opt-in integration test waits for RunJobs' real 10-minute ticker.
// Keep it out of the normal package suite because it intentionally takes over ten minutes.
func TestRunJobsPurgesExpiredTrashOnTenMinuteTick(t *testing.T) {
	if os.Getenv("OPS_TEST_TRASH_REAL_TICK") != "1" {
		t.Skip("set OPS_TEST_TRASH_REAL_TICK=1 to wait for the real 10-minute trash cleanup tick")
	}

	originalNow := env.srv.now
	fixedNow := time.Date(2026, time.November, 5, 2, 30, 0, 0, env.srv.loc)
	env.srv.now = func() time.Time { return fixedNow }
	t.Cleanup(func() { env.srv.now = originalNow })

	var account Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{
		"platform": "xhs", "name": "QA26 回收站十分钟周期验收",
		"content_format": "image_note",
	}, &account)
	type target struct {
		workID   uuid.UUID
		topicID  uuid.UUID
		assetDir string
	}
	createTarget := func(prefix string) target {
		var work Work
		env.mustJSON(t, "POST", "/api/v1/accounts/"+account.ID.String()+"/works", map[string]string{
			"title": "QA26 " + prefix + " 到期清理作品",
		}, &work)
		var topic struct {
			Topic struct {
				ID uuid.UUID `json:"id"`
			} `json:"topic"`
		}
		env.mustJSON(t, "POST", "/api/v1/accounts/"+account.ID.String()+"/topics", map[string]string{
			"title": "QA26 " + prefix + " 到期清理选题", "angle": "10 分钟调度验收",
		}, &topic)
		env.upload(t, work.ID.String(), testPNG(48, 32))
		return target{workID: work.ID, topicID: topic.Topic.ID, assetDir: filepath.Join(env.srv.cfg.DataDir, "assets", work.ID.String())}
	}
	expireTarget := func(item target) {
		cutoff := fixedNow.AddDate(0, 0, -trashDays).Add(-time.Second)
		if _, err := env.srv.db.Exec(t.Context(), `UPDATE work SET deleted_at=$2 WHERE id=$1`, item.workID, cutoff); err != nil {
			t.Fatal(err)
		}
		if _, err := env.srv.db.Exec(t.Context(), `UPDATE topic SET deleted_at=$2 WHERE id=$1`, item.topicID, cutoff); err != nil {
			t.Fatal(err)
		}
	}
	targetExists := func(item target) bool {
		var exists bool
		if err := env.srv.db.QueryRow(t.Context(), `SELECT EXISTS(SELECT 1 FROM work WHERE id=$1) OR EXISTS(SELECT 1 FROM topic WHERE id=$2)`, item.workID, item.topicID).Scan(&exists); err != nil {
			t.Fatal(err)
		}
		return exists
	}
	waitPurged := func(item target, timeout time.Duration) {
		t.Helper()
		deadline := time.NewTimer(timeout)
		defer deadline.Stop()
		poll := time.NewTicker(100 * time.Millisecond)
		defer poll.Stop()
		for {
			if !targetExists(item) {
				if _, err := os.Stat(item.assetDir); !os.IsNotExist(err) {
					t.Fatalf("expired work asset directory still exists: %s (err=%v)", item.assetDir, err)
				}
				return
			}
			select {
			case <-deadline.C:
				t.Fatalf("RunJobs did not purge expired work/topic before timeout: work=%s topic=%s", item.workID, item.topicID)
			case <-poll.C:
			}
		}
	}

	startupTarget := createTarget("启动轮")
	expireTarget(startupTarget)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	startedAt := time.Now()
	go func() {
		env.srv.RunJobs(ctx)
		close(done)
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Error("RunJobs did not stop after context cancellation")
		}
	})

	waitPurged(startupTarget, 30*time.Second)
	tickTarget := createTarget("周期轮")
	expireTarget(tickTarget)
	if !targetExists(tickTarget) {
		t.Fatal("periodic target must be created after the startup pass")
	}
	waitPurged(tickTarget, 12*time.Minute)
	if elapsed := time.Since(startedAt); elapsed < 9*time.Minute+45*time.Second {
		t.Fatalf("periodic purge arrived too early to prove the 10-minute tick: elapsed=%s", elapsed.Round(time.Second))
	}
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("RunJobs did not finish after context cancellation")
	}
}
