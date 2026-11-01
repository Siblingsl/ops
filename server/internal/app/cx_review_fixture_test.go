package app

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
)

func cxReviewSeedWork(t *testing.T, accountID uuid.UUID, title, format string, publishedAt time.Time) struct {
	ID          uuid.UUID
	PublishedAt time.Time
} {
	t.Helper()
	workID := uuid.New()
	if _, err := env.srv.db.Exec(context.Background(), `INSERT INTO work(id,account_id,title,content_format,status,published_at)
		VALUES($1,$2,$3,$4,'published',$5)`, workID, accountID, title, format, publishedAt); err != nil {
		t.Fatalf("seed CX review work: %v", err)
	}
	return struct {
		ID          uuid.UUID
		PublishedAt time.Time
	}{ID: workID, PublishedAt: publishedAt}
}

func cxReviewInsertMetric(t *testing.T, workID uuid.UUID, capturedAt time.Time, source, readUnit, shareUnit string,
	reads, likes, favorites, comments, shares, follows int, quality string) Metric {
	t.Helper()
	var metric Metric
	var id uuid.UUID
	err := env.srv.db.QueryRow(context.Background(), `INSERT INTO metric_snapshot(work_id,captured_at,source,reads,read_unit,
		likes,favorites,comments,shares,share_unit,follows_gained,quality_state)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
		workID, capturedAt, source, reads, readUnit, likes, favorites, comments, shares, shareUnit, follows, quality).Scan(&id)
	if err != nil {
		t.Fatalf("seed CX review metric: %v", err)
	}
	err = env.srv.db.QueryRow(context.Background(), `SELECT `+metricCols+` FROM metric_snapshot WHERE id=$1`, id).Scan(metricDest(&metric)...)
	if err != nil {
		t.Fatalf("read CX review metric fixture: %v", err)
	}
	return metric
}

func cxReviewCreateAccount(t *testing.T, platform, contentFormat string) Account {
	t.Helper()
	var account Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{"platform": platform, "name": "CX21复盘测试" + uuid.NewString()[:8], "content_format": contentFormat}, &account)
	return account
}
