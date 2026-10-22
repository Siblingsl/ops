package app

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"
)

func cl04PublishedWork(t *testing.T, a Account, title string, publishedAt *time.Time, publishedURL string) Work {
	t.Helper()
	var id uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(), `INSERT INTO work
		(account_id, content_format, title, status, published_at, published_url, locked)
		VALUES ($1,'long_article',$2,'published',$3,nullif($4,''),true) RETURNING id`,
		a.ID, title, publishedAt, publishedURL).Scan(&id); err != nil {
		t.Fatal(err)
	}
	var wk Work
	env.mustJSON(t, "GET", "/api/v1/works/"+id.String(), nil, &wk)
	return wk
}

func cl04PublishRevision(t *testing.T, workID uuid.UUID) int {
	t.Helper()
	var revision int
	if err := env.srv.db.QueryRow(context.Background(), `SELECT publish_revision FROM work WHERE id=$1`, workID).Scan(&revision); err != nil {
		t.Fatal(err)
	}
	return revision
}

func cl04MetricOffsets(t *testing.T, workID uuid.UUID) map[string]*int {
	t.Helper()
	rows, err := env.srv.db.Query(context.Background(), `SELECT source || ':' || captured_at::date::text, day_offset
		FROM metric_snapshot WHERE work_id=$1 ORDER BY captured_at`, workID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	out := map[string]*int{}
	for rows.Next() {
		var key string
		var offset *int
		if err := rows.Scan(&key, &offset); err != nil {
			t.Fatal(err)
		}
		out[key] = offset
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

func cl04CorrectionBody(revision int, publishedAt *time.Time, url *string, reason string) map[string]any {
	body := map[string]any{
		"mode":                  "correction",
		"base_publish_revision": revision,
		"reason":                reason,
		"confirm_published":     true,
	}
	if publishedAt != nil {
		body["published_at"] = publishedAt.Format(time.RFC3339Nano)
	}
	if url != nil {
		body["url"] = *url
	}
	return body
}

func TestCL04PublishCorrectionPreviewAndAtomicNodeShift(t *testing.T) {
	ctx := context.Background()
	a := drAccount(t, "wechat_mp", "发布更正节点换位号")
	oldAt := time.Date(2026, 10, 1, 23, 50, 0, 0, env.srv.loc)
	wk := cl04PublishedWork(t, a, "发布更正节点换位作品", &oldAt, "https://mp.weixin.qq.com/s/old")
	if _, err := env.srv.db.Exec(ctx, `UPDATE work SET locked=false WHERE id=$1`, wk.ID); err != nil {
		t.Fatal(err)
	}
	path := "/api/v1/works/" + wk.ID.String() + "/published"
	for i, day := range []int{1, 2} {
		var m metricResp
		env.mustJSON(t, "POST", "/api/v1/works/"+wk.ID.String()+"/metrics", map[string]any{
			"captured_at": oldAt.Add(20*time.Minute).AddDate(0, 0, day-1), "reads": 100 + i,
		}, &m)
		if m.Merged || m.DayOffset == nil || *m.DayOffset != day {
			t.Fatalf("metric %d before correction = %+v", day, m)
		}
	}
	baseRevision := cl04PublishRevision(t, wk.ID)
	beforeContentRevision := wk.Revision
	var versionsBefore, auditsBefore int
	if err := env.srv.db.QueryRow(ctx, `SELECT count(*) FROM work_version WHERE work_id=$1`, wk.ID).Scan(&versionsBefore); err != nil {
		t.Fatal(err)
	}
	if err := env.srv.db.QueryRow(ctx, `SELECT count(*) FROM audit_log WHERE target_type='work' AND target_id=$1 AND action='publish_metadata_corrected'`, wk.ID.String()).Scan(&auditsBefore); err != nil {
		t.Fatal(err)
	}

	newAt := time.Date(2026, 9, 30, 20, 0, 0, 0, env.srv.loc)
	url := "https://mp.weixin.qq.com/s/old"
	body := cl04CorrectionBody(baseRevision, &newAt, &url, "核对原文页面后更正发布时间")
	var preview struct {
		Mode            string `json:"mode"`
		PublishRevision int    `json:"publish_revision"`
		Changed         bool   `json:"changed"`
		Metrics         []struct {
			Source          string `json:"source"`
			BeforeDayOffset *int   `json:"before_day_offset"`
			AfterDayOffset  *int   `json:"after_day_offset"`
		} `json:"metrics"`
	}
	env.mustJSON(t, "POST", path+"?preview=true", body, &preview)
	if preview.Mode != "correction" || preview.PublishRevision != baseRevision || !preview.Changed || len(preview.Metrics) != 2 {
		t.Fatalf("correction preview = %+v", preview)
	}
	for i, want := range []int{2, 3} {
		m := preview.Metrics[i]
		if m.Source != "manual" || m.BeforeDayOffset == nil || *m.BeforeDayOffset != i+1 || m.AfterDayOffset == nil || *m.AfterDayOffset != want {
			t.Fatalf("preview metric %d = %+v, want %d -> %d", i, m, i+1, want)
		}
	}
	if got := cl04PublishRevision(t, wk.ID); got != baseRevision {
		t.Fatalf("preview changed publish_revision to %d", got)
	}
	if got := cl04MetricOffsets(t, wk.ID); len(got) != 2 || *got["manual:2026-10-02"] != 1 || *got["manual:2026-10-03"] != 2 {
		t.Fatalf("preview changed metric offsets: %+v", got)
	}

	var corrected Work
	env.mustJSON(t, "POST", path, body, &corrected)
	if corrected.Status != "published" || corrected.Locked || corrected.Revision != beforeContentRevision {
		t.Fatalf("correction changed state/lock/content revision: status=%s locked=%v revision=%d", corrected.Status, corrected.Locked, corrected.Revision)
	}
	if corrected.PublishedAt == nil || !corrected.PublishedAt.Equal(newAt) || corrected.PublishedURL == nil || *corrected.PublishedURL != url {
		t.Fatalf("corrected publish metadata = %v %v", corrected.PublishedAt, corrected.PublishedURL)
	}
	if got := cl04PublishRevision(t, wk.ID); got != baseRevision+1 {
		t.Fatalf("publish_revision after correction = %d, want %d", got, baseRevision+1)
	}
	if got := cl04MetricOffsets(t, wk.ID); len(got) != 2 || *got["manual:2026-10-02"] != 2 || *got["manual:2026-10-03"] != 3 {
		t.Fatalf("metric offsets after atomic key shift = %+v", got)
	}
	var versionsAfter, auditCount int
	if err := env.srv.db.QueryRow(ctx, `SELECT count(*) FROM work_version WHERE work_id=$1`, wk.ID).Scan(&versionsAfter); err != nil {
		t.Fatal(err)
	}
	if err := env.srv.db.QueryRow(ctx, `SELECT count(*) FROM audit_log WHERE target_type='work' AND target_id=$1 AND action='publish_metadata_corrected'`, wk.ID.String()).Scan(&auditCount); err != nil {
		t.Fatal(err)
	}
	if versionsAfter != versionsBefore || auditCount != auditsBefore+1 {
		t.Fatalf("correction versions/audits = %d/%d, before %d/%d", versionsAfter, auditCount, versionsBefore, auditsBefore)
	}
	var detailRaw []byte
	if err := env.srv.db.QueryRow(ctx, `SELECT detail FROM audit_log WHERE target_type='work' AND target_id=$1 AND action='publish_metadata_corrected' ORDER BY created_at DESC LIMIT 1`, wk.ID.String()).Scan(&detailRaw); err != nil {
		t.Fatal(err)
	}
	var detail map[string]any
	if err := json.Unmarshal(detailRaw, &detail); err != nil {
		t.Fatal(err)
	}
	if detail["reason"] != "核对原文页面后更正发布时间" || detail["publish_revision_before"] != float64(baseRevision) || detail["publish_revision_after"] != float64(baseRevision+1) {
		t.Fatalf("publication audit detail = %+v", detail)
	}
	var actor *uuid.UUID
	if err := env.srv.db.QueryRow(ctx, `SELECT actor_id FROM audit_log WHERE target_type='work' AND target_id=$1 AND action='publish_metadata_corrected'`, wk.ID.String()).Scan(&actor); err != nil {
		t.Fatal(err)
	}
	if actor == nil {
		t.Fatal("publication correction audit has no user actor")
	}

	noOp := cl04CorrectionBody(baseRevision+1, &newAt, &url, "重复提交相同更正")
	env.mustJSON(t, "POST", path, noOp, &corrected)
	if cl04PublishRevision(t, wk.ID) != baseRevision+1 {
		t.Fatal("identical correction advanced publish_revision")
	}
	if err := env.srv.db.QueryRow(ctx, `SELECT count(*) FROM audit_log WHERE target_type='work' AND target_id=$1 AND action='publish_metadata_corrected'`, wk.ID.String()).Scan(&auditCount); err != nil {
		t.Fatal(err)
	}
	if auditCount != auditsBefore+1 {
		t.Fatalf("identical correction wrote another audit: %d", auditCount)
	}
}

func TestCL04LegacyPublishedReplayRequiresCorrectionForChanges(t *testing.T) {
	a := drAccount(t, "wechat_mp", "旧客户端发布回填号")
	oldAt := time.Date(2026, 10, 1, 12, 0, 0, 0, env.srv.loc)
	url := "https://mp.weixin.qq.com/s/old"
	wk := cl04PublishedWork(t, a, "旧客户端发布回填作品", &oldAt, url)
	path := "/api/v1/works/" + wk.ID.String() + "/published"
	baseRevision := cl04PublishRevision(t, wk.ID)
	var versionsBefore int
	if err := env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM work_version WHERE work_id=$1`, wk.ID).Scan(&versionsBefore); err != nil {
		t.Fatal(err)
	}

	var replay Work
	env.mustJSON(t, "POST", path, map[string]any{"url": url, "published_at": oldAt.Format(time.RFC3339Nano)}, &replay)
	if replay.Status != "published" || cl04PublishRevision(t, wk.ID) != baseRevision {
		t.Fatalf("unchanged legacy replay changed publication metadata: %+v", replay)
	}
	var versionsAfter int
	if err := env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM work_version WHERE work_id=$1`, wk.ID).Scan(&versionsAfter); err != nil {
		t.Fatal(err)
	}
	if versionsAfter != versionsBefore {
		t.Fatalf("unchanged legacy replay created a version: %d -> %d", versionsBefore, versionsAfter)
	}

	changedAt := oldAt.AddDate(0, 0, 1)
	env.expectErr(t, "POST", path, map[string]any{"url": url, "published_at": changedAt.Format(time.RFC3339Nano)}, "publish_correction_required")
	if cl04PublishRevision(t, wk.ID) != baseRevision {
		t.Fatal("legacy change request modified publish_revision")
	}
}

func TestCL04CollidingTargetsRollbackPublicationAndMetrics(t *testing.T) {
	ctx := context.Background()
	a := drAccount(t, "wechat_mp", "发布更正碰撞号")
	oldAt := time.Date(2026, 10, 1, 12, 0, 0, 0, env.srv.loc)
	wk := cl04PublishedWork(t, a, "发布更正碰撞作品", &oldAt, "https://mp.weixin.qq.com/s/old")
	for _, offset := range []int{1, 9} {
		if _, err := env.srv.db.Exec(ctx, `INSERT INTO metric_snapshot(work_id,captured_at,source,day_offset,reads)
			VALUES ($1,$2,'manual',$3,100)`, wk.ID, oldAt.AddDate(0, 0, 1), offset); err != nil {
			t.Fatal(err)
		}
	}
	baseRevision := cl04PublishRevision(t, wk.ID)
	newAt := oldAt.AddDate(0, 0, 1)
	url := "https://mp.weixin.qq.com/s/old"
	path := "/api/v1/works/" + wk.ID.String() + "/published"
	env.expectErr(t, "POST", path, cl04CorrectionBody(baseRevision, &newAt, &url, "更正错误发布日期"), "publish_metric_node_conflict")
	if got := cl04PublishRevision(t, wk.ID); got != baseRevision {
		t.Fatalf("failed date correction changed publish_revision to %d", got)
	}
	var gotAt time.Time
	if err := env.srv.db.QueryRow(ctx, `SELECT published_at FROM work WHERE id=$1`, wk.ID).Scan(&gotAt); err != nil {
		t.Fatal(err)
	}
	if !gotAt.Equal(oldAt) {
		t.Fatalf("failed date correction changed published_at to %s", gotAt)
	}
	var metricCount, minOffset, maxOffset int
	if err := env.srv.db.QueryRow(ctx, `SELECT count(*), min(day_offset), max(day_offset) FROM metric_snapshot WHERE work_id=$1`, wk.ID).
		Scan(&metricCount, &minOffset, &maxOffset); err != nil {
		t.Fatal(err)
	}
	if metricCount != 2 || minOffset != 1 || maxOffset != 9 {
		t.Fatalf("failed date correction left partial metric updates: count=%d min=%d max=%d", metricCount, minOffset, maxOffset)
	}
	var auditCount int
	if err := env.srv.db.QueryRow(ctx, `SELECT count(*) FROM audit_log WHERE target_type='work' AND target_id=$1 AND action='publish_metadata_corrected'`, wk.ID.String()).Scan(&auditCount); err != nil {
		t.Fatal(err)
	}
	if auditCount != 0 {
		t.Fatalf("failed date correction wrote %d publication audit rows", auditCount)
	}
}

func TestCL04UnknownWechatMetricBasisBlocksDateButAllowsLinkOnly(t *testing.T) {
	ctx := context.Background()
	a := drAccount(t, "wechat_mp", "API统计依据未知号")
	oldAt := time.Date(2026, 10, 1, 12, 0, 0, 0, env.srv.loc)
	oldURL := "https://mp.weixin.qq.com/s?__biz=MzA5&mid=2247480001&idx=1&sn=abc"
	wk := cl04PublishedWork(t, a, "API统计依据未知作品", &oldAt, oldURL)
	if _, err := env.srv.db.Exec(ctx, `UPDATE work SET wechat_msgid='2247480001_1' WHERE id=$1`, wk.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO metric_snapshot(work_id,captured_at,source,day_offset,external_id,reads)
		VALUES ($1,$2,'wechat_api',7,'2247480001_1',250)`, wk.ID, oldAt.AddDate(0, 0, 2)); err != nil {
		t.Fatal(err)
	}
	baseRevision := cl04PublishRevision(t, wk.ID)
	changedAt := oldAt.AddDate(0, 0, 1)
	url := oldURL
	path := "/api/v1/works/" + wk.ID.String() + "/published"
	env.expectErr(t, "POST", path, cl04CorrectionBody(baseRevision, &changedAt, &url, "更正错误发布日期"), "publish_metric_basis_unknown")

	newURL := "https://mp.weixin.qq.com/s/correct-link"
	env.mustJSON(t, "POST", path, cl04CorrectionBody(baseRevision, nil, &newURL, "修正原文链接"), &wk)
	if wk.PublishedAt == nil || !wk.PublishedAt.Equal(oldAt) || wk.PublishedURL == nil || *wk.PublishedURL != newURL {
		t.Fatalf("link-only correction = %v %v", wk.PublishedAt, wk.PublishedURL)
	}
	var msgid *string
	if err := env.srv.db.QueryRow(ctx, `SELECT wechat_msgid FROM work WHERE id=$1`, wk.ID).Scan(&msgid); err != nil {
		t.Fatal(err)
	}
	if msgid != nil {
		t.Fatalf("changed URL reused mismatched wechat_msgid %q", *msgid)
	}
	if cl04PublishRevision(t, wk.ID) != baseRevision+1 {
		t.Fatal("link-only correction did not advance publish_revision once")
	}
}

func TestCL04StalePublishRevisionCannotOverwriteCorrection(t *testing.T) {
	a := drAccount(t, "wechat_mp", "发布更正确认竞争号")
	oldAt := time.Date(2026, 10, 1, 12, 0, 0, 0, env.srv.loc)
	wk := cl04PublishedWork(t, a, "发布更正确认竞争作品", &oldAt, "https://mp.weixin.qq.com/s/old")
	baseRevision := cl04PublishRevision(t, wk.ID)
	path := "/api/v1/works/" + wk.ID.String() + "/published"
	firstURL := "https://mp.weixin.qq.com/s/first"
	env.mustJSON(t, "POST", path, cl04CorrectionBody(baseRevision, nil, &firstURL, "更新为核验后的链接"), &wk)
	secondURL := "https://mp.weixin.qq.com/s/stale"
	env.expectErr(t, "POST", path, cl04CorrectionBody(baseRevision, nil, &secondURL, "使用旧数据覆盖"), "publish_revision_conflict")
	var got string
	if err := env.srv.db.QueryRow(context.Background(), `SELECT published_url FROM work WHERE id=$1`, wk.ID).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if got != firstURL || cl04PublishRevision(t, wk.ID) != baseRevision+1 {
		t.Fatalf("stale correction changed current value: url=%s revision=%d", got, cl04PublishRevision(t, wk.ID))
	}
}

func TestCL04InitialBackfillCollisionRollsBackStatusAndVersion(t *testing.T) {
	ctx := context.Background()
	a := drAccount(t, "wechat_mp", "首次回填冲突号")
	wk := drWork(t, a, "首次回填冲突作品", "packed", nil)
	captured := time.Date(2026, 10, 2, 12, 0, 0, 0, env.srv.loc)
	for _, offset := range []int{1, 9} {
		if _, err := env.srv.db.Exec(ctx, `INSERT INTO metric_snapshot(work_id,captured_at,source,day_offset,reads)
			VALUES ($1,$2,'manual',$3,100)`, wk.ID, captured, offset); err != nil {
			t.Fatal(err)
		}
	}
	newAt := time.Date(2026, 10, 1, 12, 0, 0, 0, env.srv.loc)
	env.expectErr(t, "POST", "/api/v1/works/"+wk.ID.String()+"/published", map[string]any{
		"url": "https://mp.weixin.qq.com/s/first", "published_at": newAt.Format(time.RFC3339Nano),
	}, "publish_metric_node_conflict")
	var status string
	var publishedAt *time.Time
	var locked bool
	if err := env.srv.db.QueryRow(ctx, `SELECT status,published_at,locked FROM work WHERE id=$1`, wk.ID).
		Scan(&status, &publishedAt, &locked); err != nil {
		t.Fatal(err)
	}
	if status != "packed" || publishedAt != nil || locked {
		t.Fatalf("failed first backfill changed work state: %s %v %v", status, publishedAt, locked)
	}
	var metricCount, minOffset, maxOffset, versionCount int
	if err := env.srv.db.QueryRow(ctx, `SELECT count(*),min(day_offset),max(day_offset) FROM metric_snapshot WHERE work_id=$1`, wk.ID).
		Scan(&metricCount, &minOffset, &maxOffset); err != nil {
		t.Fatal(err)
	}
	if err := env.srv.db.QueryRow(ctx, `SELECT count(*) FROM work_version WHERE work_id=$1`, wk.ID).Scan(&versionCount); err != nil {
		t.Fatal(err)
	}
	if metricCount != 2 || minOffset != 1 || maxOffset != 9 || versionCount != 0 {
		t.Fatalf("failed first backfill left partial metrics/versions: metrics=%d offsets=%d..%d versions=%d", metricCount, minOffset, maxOffset, versionCount)
	}
}

func TestCL04RejectsMissingConfirmationFutureDateAndCredentialURL(t *testing.T) {
	a := drAccount(t, "wechat_mp", "发布更正校验号")
	oldAt := time.Date(2026, 10, 1, 12, 0, 0, 0, env.srv.loc)
	wk := cl04PublishedWork(t, a, "发布更正校验作品", &oldAt, "https://mp.weixin.qq.com/s/old")
	baseRevision := cl04PublishRevision(t, wk.ID)
	path := "/api/v1/works/" + wk.ID.String() + "/published"
	newURL := "https://mp.weixin.qq.com/s/new"
	body := cl04CorrectionBody(baseRevision, nil, &newURL, "修正链接")
	body["confirm_published"] = false
	env.expectErr(t, "POST", path, body, "human_step_required")

	body = cl04CorrectionBody(baseRevision, ptrTime(env.srv.now().Add(time.Hour)), &newURL, "修正发布时间")
	env.expectErr(t, "POST", path, body, "validation_failed")
	credentialURL := "https://user:password@example.invalid/article"
	body = cl04CorrectionBody(baseRevision, nil, &credentialURL, "修正链接")
	env.expectErr(t, "POST", path, body, "validation_failed")
	if cl04PublishRevision(t, wk.ID) != baseRevision {
		t.Fatal("invalid correction changed publish_revision")
	}
}

func ptrTime(value time.Time) *time.Time { return &value }
