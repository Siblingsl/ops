package app

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"
)

type shotResp struct {
	ID   string          `json:"id"`
	Rows []metricShotRow `json:"rows"`
}

func uploadShots(t *testing.T, accountID string, n int, workID string) (int, []byte) {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	for range n {
		fw, _ := mw.CreateFormFile("files", "shot.png")
		_, _ = fw.Write(testPNG(40, 80))
	}
	if workID != "" {
		_ = mw.WriteField("work_id", workID)
	}
	_ = mw.Close()
	resp := env.request("POST", "/api/v1/accounts/"+accountID+"/metrics/screenshots", &buf, mw.FormDataContentType())
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, b
}

func TestDR05NumberFaithfulness(t *testing.T) {
	seen := rawNumbers("阅读 1.2w 点赞 1,234 收藏 3万 分享 10万+")
	for _, c := range []struct {
		in   string
		want int
		ok   bool
	}{{`"1.2w"`, 12000, true}, {`12000`, 12000, true}, {`"1234"`, 1234, true}, {`"3万"`, 30000, true}, {`"10万+"`, 100000, true}, {`"999"`, 999, false}} {
		v, _, valid := shotValue(json.RawMessage(c.in))
		if !valid || v != c.want || seen[v] != c.ok {
			t.Fatalf("%s: got %d valid=%v seen=%v", c.in, v, valid, seen[v])
		}
	}
}

// DEV-DR05（14 文档 4.4）：截图识别只返回待确认的行、不入库；原始文字里找不到的数字被丢弃；
// 单位换算由代码完成；逐行确认写入 source=screenshot；截图不带账号档案与记忆；7 天后连文件一起删除。
func TestDR05MetricScreenshot(t *testing.T) {
	ctx := context.Background()
	a := drAccount(t, "wechat_mp", "截图识别验收号")
	now := env.srv.now()
	p1, p2 := now.AddDate(0, 0, -2), now.AddDate(0, 0, -5)
	w1 := drWork(t, a, "截图识别作品甲", "published", &p1)
	w2 := drWork(t, a, "截图识别作品乙", "published", &p2)
	acc := a.ID.String()

	st, b := uploadShots(t, acc, 2, "")
	if st != 200 {
		t.Fatalf("recognize: %d %s", st, b)
	}
	var res shotResp
	_ = json.Unmarshal(b, &res)
	if len(res.Rows) != 2 {
		t.Fatalf("want 2 rows, got %s", b)
	}
	r0, r1 := res.Rows[0], res.Rows[1]
	if r0.WorkID == nil || *r0.WorkID != w1.ID || r0.MatchType != "exact" || r1.WorkID == nil || *r1.WorkID != w2.ID {
		t.Fatalf("rows not matched to works: %s", b)
	}
	if r0.Reads == nil || *r0.Reads != 12000 || r0.Likes == nil || *r0.Likes != 36 || r0.Favorites == nil || *r0.Favorites != 8 {
		t.Fatalf("unit conversion or values wrong: %s", b)
	}
	if r0.Comments != nil || !slices.Contains(r0.Dropped, "评论/留言") {
		t.Fatalf("number missing from raw_text must be dropped: %s", b)
	}
	if r1.Reads == nil || *r1.Reads != 3456 {
		t.Fatalf("thousands separator: %s", b)
	}
	if metricCount(t, w1.ID)+metricCount(t, w2.ID) != 0 {
		t.Fatal("recognition must not write metrics before confirmation")
	}
	var files []struct {
		Path string `json:"path"`
	}
	var raw []byte
	var profile *string
	if err := env.srv.db.QueryRow(ctx, `SELECT u.files, c.context_refs->>'profile' FROM metric_upload u JOIN ai_call c ON c.id=u.ai_call_id
		WHERE u.id=$1 AND c.task_type='metric_screenshot' AND c.account_id=$2`, res.ID, a.ID).Scan(&raw, &profile); err != nil {
		t.Fatal(err)
	}
	_ = json.Unmarshal(raw, &files)
	if len(files) != 2 || profile != nil {
		t.Fatalf("files %v profile %v", files, profile)
	}
	for _, f := range files {
		if _, err := os.Stat(filepath.Join(env.srv.cfg.DataDir, filepath.FromSlash(f.Path))); err != nil {
			t.Fatalf("screenshot not stored: %v", err)
		}
	}

	path := "/api/v1/metrics/screenshots/" + res.ID + "/rows/0/confirm"
	if st, _ := env.do("POST", path, []map[string]any{{"work_id": w1.ID, "reads": 1}}); st != 422 {
		t.Fatalf("array body must be rejected, got %d", st)
	}
	var got metricResp
	env.mustJSON(t, "POST", path, map[string]any{"work_id": w1.ID, "reads": 12000, "likes": 40, "favorites": 8}, &got)
	if got.Source != "screenshot" || got.Likes == nil || *got.Likes != 40 || got.Comments != nil || got.DayOffset == nil || *got.DayOffset != 2 {
		t.Fatalf("confirmed metric: %+v", got.Metric)
	}
	env.expectErr(t, "POST", path, map[string]any{"work_id": w1.ID, "reads": 1}, "state_invalid")
	if metricCount(t, w2.ID) != 0 {
		t.Fatal("unconfirmed row must stay out of metrics")
	}
	other := drAccount(t, "xhs", "截图识别其他号")
	longAgo := now.AddDate(0, 0, -60)
	foreign := drWork(t, other, "别的账号的作品", "published", &longAgo)
	env.expectErr(t, "POST", "/api/v1/metrics/screenshots/"+res.ID+"/rows/1/confirm", map[string]any{"work_id": foreign.ID, "reads": 1}, "validation_failed")
	env.expectErr(t, "POST", "/api/v1/metrics/screenshots/"+res.ID+"/rows/1/confirm", map[string]any{"work_id": w2.ID}, "validation_failed")

	st, b = uploadShots(t, other.ID.String(), 1, foreign.ID.String())
	if st != 200 {
		t.Fatalf("drawer recognize: %d %s", st, b)
	}
	var hinted shotResp
	_ = json.Unmarshal(b, &hinted)
	if len(hinted.Rows) != 1 || hinted.Rows[0].MatchType != "hint" || hinted.Rows[0].WorkID == nil || *hinted.Rows[0].WorkID != foreign.ID {
		t.Fatalf("drawer work should be used when the screenshot has no title: %s", b)
	}
	if st, _ := uploadShots(t, acc, 0, ""); st != 422 {
		t.Fatalf("no files: %d", st)
	}
	if st, _ := uploadShots(t, acc, 10, ""); st != 422 {
		t.Fatalf("10 files: %d", st)
	}

	if _, err := env.srv.db.Exec(ctx, `UPDATE metric_upload SET created_at=$2 WHERE id=$1`, res.ID, now.Add(-8*24*time.Hour)); err != nil {
		t.Fatal(err)
	}
	env.srv.purgeMetricUploads(ctx)
	var left int
	_ = env.srv.db.QueryRow(ctx, `SELECT count(*) FROM metric_upload WHERE id=$1`, res.ID).Scan(&left)
	if left != 0 {
		t.Fatal("upload older than 7 days must be deleted")
	}
	if _, err := os.Stat(filepath.Join(env.srv.cfg.DataDir, "metric_uploads", res.ID)); !os.IsNotExist(err) {
		t.Fatalf("screenshot files must be deleted: %v", err)
	}
	if metricCount(t, w1.ID) != 1 {
		t.Fatal("confirmed metric must survive screenshot cleanup")
	}
	env.expectErr(t, "POST", "/api/v1/metrics/screenshots/"+res.ID+"/rows/1/confirm", map[string]any{"work_id": w2.ID, "reads": 1}, "not_found")
}
