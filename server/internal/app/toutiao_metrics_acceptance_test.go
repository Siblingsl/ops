package app

import (
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func ttMetricWork(t *testing.T, a Account, format, title string, published time.Time) Work {
	t.Helper()
	var w Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+a.ID.String()+"/works", map[string]string{"title": title, "content_format": format}, &w)
	if _, err := env.srv.db.Exec(context.Background(), `UPDATE work SET status='published',published_at=$2 WHERE id=$1`, w.ID, published); err != nil {
		t.Fatal(err)
	}
	return w
}

func ttCSVPreview(t *testing.T, account uuid.UUID, csv string) []metricPreviewRow {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	f, err := mw.CreateFormFile("file", "metrics.csv")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = io.WriteString(f, csv); err != nil {
		t.Fatal(err)
	}
	if err = mw.Close(); err != nil {
		t.Fatal(err)
	}
	resp := env.request("POST", "/api/v1/accounts/"+account.String()+"/metrics/import", &buf, mw.FormDataContentType())
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("CSV preview: status=%d err=%v body=%s", resp.StatusCode, err, body)
	}
	var out struct {
		Preview []metricPreviewRow `json:"preview"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatal(err)
	}
	return out.Preview
}

// TT-T37: NULL and zero remain different in API JSON; no node/source combines a numerator and denominator.
func TestToutiaoT37NullableZeroAndSnapshotLocalCTR(t *testing.T) {
	a := drAccount(t, "toutiao", "T37快照CTR")
	pub := env.srv.now().AddDate(0, 0, -12)
	cases := []struct {
		name               string
		reads, impressions any
		ctr                *float64
	}{
		{"both_unknown", nil, nil, nil}, {"reads_unknown", nil, 100, nil}, {"impressions_unknown", 20, nil, nil},
		{"zero_denominator", 20, 0, nil}, {"both_zero", 0, 0, nil}, {"zero_reads", 0, 100, ttFloat(0)},
		{"ratio_above_one", 200, 100, ttFloat(2)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w := ttMetricWork(t, a, "long_article", tc.name, pub)
			path := "/api/v1/works/" + w.ID.String() + "/metrics"
			var m Metric
			env.mustJSON(t, "POST", path, map[string]any{"captured_at": pub.AddDate(0, 0, 7), "likes": 1, "reads": tc.reads, "impressions": tc.impressions}, &m)
			var rows []map[string]any
			env.mustJSON(t, "GET", path, nil, &rows)
			if len(rows) != 1 || rows[0]["reads"] != ttJSONNumber(tc.reads) || rows[0]["impressions"] != ttJSONNumber(tc.impressions) {
				t.Fatalf("NULL/zero changed: %+v", rows)
			}
			if tc.ctr == nil {
				if m.CTR != nil || rows[0]["ctr"] != nil {
					t.Fatalf("undefined CTR became a number: %+v", rows)
				}
			} else if m.CTR == nil || *m.CTR != *tc.ctr {
				t.Fatalf("CTR=%v want=%v", m.CTR, *tc.ctr)
			}
		})
	}
	w := ttMetricWork(t, a, "micro_post", "来源不拼接", pub)
	path := "/api/v1/works/" + w.ID.String() + "/metrics"
	env.mustJSON(t, "POST", path, map[string]any{"captured_at": pub.AddDate(0, 0, 7), "reads": 50}, nil)
	env.mustJSON(t, "POST", "/api/v1/accounts/"+a.ID.String()+"/metrics/import", map[string]any{"rows": []map[string]any{{"work_id": w.ID, "captured_at": pub.AddDate(0, 0, 7), "impressions": 100}}}, nil)
	env.mustJSON(t, "POST", path, map[string]any{"captured_at": pub.AddDate(0, 0, 3), "impressions": 200}, nil)
	var nodes struct {
		D7    *Metric          `json:"d7"`
		Nodes []metricNodeView `json:"nodes"`
	}
	env.mustJSON(t, "GET", path+"?view=nodes", nil, &nodes)
	if nodes.D7 == nil || nodes.D7.Source != "paste" || nodes.D7.Reads != nil || nodes.D7.Impressions == nil || *nodes.D7.Impressions != 100 || nodes.D7.CTR != nil {
		t.Fatalf("D7 mixed source values: %+v", nodes.D7)
	}
	for _, node := range nodes.Nodes {
		if node.Metric != nil && node.Metric.CTR != nil {
			t.Fatalf("node combined snapshots: %+v", node)
		}
	}
}

func ttFloat(v float64) *float64 { return &v }
func ttJSONNumber(v any) any {
	if v == nil {
		return nil
	}
	return float64(v.(int))
}

// TT-T38/39: impression-only writes participate in optimistic revision, audit, node reads and delete.
func TestToutiaoT38T39ImpressionLifecycleAuditAndNodes(t *testing.T) {
	a := drAccount(t, "toutiao", "T38T39全链路")
	pub := env.srv.now().AddDate(0, 0, -12)
	w := ttMetricWork(t, a, "long_article", "展现全链路", pub)
	path := "/api/v1/works/" + w.ID.String() + "/metrics"
	var m metricResp
	env.mustJSON(t, "POST", path, map[string]any{"captured_at": pub.AddDate(0, 0, 7), "reads": 50, "impressions": 100}, &m)
	assertMetricAudit(t, m.ID.String(), "metric_create", "manual", nil, map[string]any{"impressions": float64(100)})
	env.mustJSON(t, "POST", path, map[string]any{"captured_at": pub.AddDate(0, 0, 7), "likes": 2}, &m)
	if !m.Merged || m.Impressions == nil || *m.Impressions != 100 {
		t.Fatalf("merge lost impressions: %+v", m)
	}
	assertMetricAudit(t, m.ID.String(), "metric_merge", "manual", map[string]any{"impressions": float64(100)}, map[string]any{"impressions": float64(100)})
	old := m.Revision
	env.mustJSON(t, "PATCH", "/api/v1/metrics/"+m.ID.String(), map[string]any{"base_revision": old, "reads": 50, "likes": 2, "impressions": 200}, &m)
	if m.Revision != old+1 {
		t.Fatalf("impression-only revision=%d want=%d", m.Revision, old+1)
	}
	assertMetricAudit(t, m.ID.String(), "metric_update", "manual", map[string]any{"impressions": float64(100)}, map[string]any{"impressions": float64(200)})
	for _, method := range []string{"PATCH", "DELETE"} {
		st, body := env.do(method, "/api/v1/metrics/"+m.ID.String()+"?base_revision="+strconv.Itoa(old), map[string]any{"base_revision": old, "reads": 999, "impressions": 999})
		if st != 409 {
			t.Fatalf("stale %s: %d %s", method, st, body)
		}
	}
	var nodes struct {
		D7    *Metric          `json:"d7"`
		Nodes []metricNodeView `json:"nodes"`
	}
	env.mustJSON(t, "GET", path+"?view=nodes", nil, &nodes)
	if nodes.D7 == nil || nodes.D7.Impressions == nil || *nodes.D7.Impressions != 200 || nodes.D7.Revision != m.Revision {
		t.Fatalf("stale write/node projection: %+v", nodes)
	}
	for _, n := range nodes.Nodes {
		if n.Node == 7 && (n.Metric == nil || n.Metric.ID != m.ID || n.Metric.Impressions == nil || *n.Metric.Impressions != 200) {
			t.Fatalf("D7 node: %+v", n)
		}
	}
	env.mustJSON(t, "DELETE", "/api/v1/metrics/"+m.ID.String()+"?base_revision="+strconv.Itoa(m.Revision), nil, nil)
	assertMetricAudit(t, m.ID.String(), "metric_delete", "manual", map[string]any{"impressions": float64(200)}, nil)
	if metricCount(t, w.ID) != 0 {
		t.Fatal("delete did not remove snapshot")
	}
	legacy := ttMetricWork(t, a, "micro_post", "历史空展现", pub)
	drMetric(t, legacy.ID, "manual", 7, 12)
	var rows []Metric
	env.mustJSON(t, "GET", "/api/v1/works/"+legacy.ID.String()+"/metrics", nil, &rows)
	if len(rows) != 1 || rows[0].Impressions != nil || rows[0].CTR != nil {
		t.Fatalf("historical row fabricated impressions: %+v", rows)
	}
	var exported Metric
	env.mustJSON(t, "POST", path, map[string]any{"captured_at": pub.AddDate(0, 0, 7), "reads": 33, "impressions": 66}, &exported)
	env.reauth(t)
	st, body := env.do("POST", "/api/v1/exports", map[string]string{"kind": "works", "account_id": a.ID.String()})
	if st != 200 {
		t.Fatalf("export: %d %s", st, body)
	}
	records, err := csv.NewReader(bytes.NewReader(body)).ReadAll()
	if err != nil || len(records) != 3 || len(records[0]) != 9 || records[0][7] != "指标快照JSON" || records[0][8] != "平台" {
		t.Fatalf("export layout: %v %s", err, body)
	}
	for _, record := range records[1:] {
		if record[8] != "今日头条" {
			t.Fatalf("export platform label: %+v", record)
		}
		var snapshots []Metric
		if err := json.Unmarshal([]byte(record[7]), &snapshots); err != nil || len(snapshots) != 1 {
			t.Fatalf("export snapshots: %v %+v", err, record)
		}
		m := snapshots[0]
		if record[1] == w.Title && (m.ID != exported.ID || m.Impressions == nil || *m.Impressions != 66 || m.Source != "manual" || m.DayOffset == nil || *m.DayOffset != 7 || m.Revision != exported.Revision) {
			t.Fatalf("export lost impression facts: %+v", m)
		}
		if record[1] == legacy.Title && m.Impressions != nil {
			t.Fatalf("export fabricated historical impressions: %+v", m)
		}
	}
}

func TestToutiaoT40InvalidImpressionsAndAnomaliesPreserveNumbers(t *testing.T) {
	a := drAccount(t, "toutiao", "T40输入边界")
	pub := env.srv.now().AddDate(0, 0, -10)
	w := ttMetricWork(t, a, "micro_post", "数值边界", pub)
	path := "/api/v1/works/" + w.ID.String() + "/metrics"
	var m Metric
	env.mustJSON(t, "POST", path, map[string]any{"captured_at": pub.AddDate(0, 0, 1), "reads": 200, "impressions": 1000}, &m)
	for _, raw := range []string{"-1", "0.1", "9223372036854775808", `"abc"`, `"100"`, `true`, `{}`} {
		t.Run(raw, func(t *testing.T) {
			for _, method := range []string{"POST", "PATCH"} {
				p := path
				if method == "PATCH" {
					p = "/api/v1/metrics/" + m.ID.String()
				}
				resp := env.request(method, p, strings.NewReader(fmt.Sprintf(`{"base_revision":%d,"reads":1,"impressions":%s}`, m.Revision, raw)), "application/json")
				b, _ := io.ReadAll(resp.Body)
				resp.Body.Close()
				if resp.StatusCode != 422 {
					t.Fatalf("%s %s => %d %s", method, raw, resp.StatusCode, b)
				}
			}
		})
	}
	if metricCount(t, w.ID) != 1 {
		t.Fatal("invalid inputs wrote snapshots")
	}
	var anomaly Metric
	env.mustJSON(t, "POST", path, map[string]any{"captured_at": pub.AddDate(0, 0, 7), "reads": 150, "impressions": 100}, &anomaly)
	if anomaly.Reads == nil || *anomaly.Reads != 150 || anomaly.Impressions == nil || *anomaly.Impressions != 100 || anomaly.CTR == nil || *anomaly.CTR != 1.5 {
		t.Fatalf("anomalous cumulative values were clamped: %+v", anomaly)
	}
	var all []Metric
	env.mustJSON(t, "GET", path, nil, &all)
	if len(all) != 2 || all[0].Impressions == nil || *all[0].Impressions != 1000 || all[1].Impressions == nil || *all[1].Impressions != 100 {
		t.Fatalf("readback mutated cumulative decrease: %+v", all)
	}
}

func TestToutiaoT42CSVThreeAliasesAndUnforgeableEntrySource(t *testing.T) {
	a := drAccount(t, "toutiao", "T42别名来源")
	pub := env.srv.now().AddDate(0, 0, -10)
	for _, alias := range []string{"展现量", "展现", "impressions"} {
		t.Run(alias, func(t *testing.T) {
			w := ttMetricWork(t, a, "long_article", alias, pub)
			rows := ttCSVPreview(t, a.ID, "work_id,"+alias+",reads\n"+w.ID.String()+",1000,200\n")
			if len(rows) != 1 || rows[0].WorkID == nil || *rows[0].WorkID != w.ID || rows[0].Impressions == nil || *rows[0].Impressions != 1000 || rows[0].Reads == nil || *rows[0].Reads != 200 {
				t.Fatalf("alias preview: %+v", rows)
			}
			if metricCount(t, w.ID) != 0 {
				t.Fatal("CSV preview wrote metrics")
			}
			env.mustJSON(t, "POST", "/api/v1/accounts/"+a.ID.String()+"/metrics/import", map[string]any{"source": "file", "rows": []map[string]any{{"work_id": w.ID, "impressions": 1000, "reads": 200}}}, nil)
			var saved []Metric
			env.mustJSON(t, "GET", "/api/v1/works/"+w.ID.String()+"/metrics", nil, &saved)
			if len(saved) != 1 || saved[0].Source != "file" {
				t.Fatalf("CSV source: %+v", saved)
			}
		})
	}
	for _, source := range []string{"manual", "wechat_api", "screenshot", "forged"} {
		w := ttMetricWork(t, a, "micro_post", source, pub)
		env.mustJSON(t, "POST", "/api/v1/accounts/"+a.ID.String()+"/metrics/import", map[string]any{"source": source, "rows": []map[string]any{{"work_id": w.ID, "impressions": 100, "source": source}}}, nil)
		var saved []Metric
		env.mustJSON(t, "GET", "/api/v1/works/"+w.ID.String()+"/metrics", nil, &saved)
		if len(saved) != 1 || saved[0].Source != "paste" {
			t.Fatalf("JSON source spoofed: %+v", saved)
		}
	}
	for _, platform := range []string{"wechat_mp", "xhs"} {
		old := drAccount(t, platform, "T42旧顺序"+platform)
		var out struct {
			Preview []metricPreviewRow `json:"preview"`
		}
		env.mustJSON(t, "POST", "/api/v1/accounts/"+old.ID.String()+"/metrics/import", map[string]string{"text": "旧标题\t10\t2\t3\t4\t5\t6\t7"}, &out)
		if len(out.Preview) != 1 {
			t.Fatalf("old preview: %+v", out)
		}
		r := out.Preview[0]
		if r.Reads == nil || *r.Reads != 10 || r.Likes == nil || *r.Likes != 2 || r.Wows == nil || *r.Wows != 3 || r.Favorites == nil || *r.Favorites != 4 || r.Comments == nil || *r.Comments != 5 || r.Shares == nil || *r.Shares != 6 || r.FollowsGained == nil || *r.FollowsGained != 7 || r.Impressions != nil {
			t.Fatalf("legacy order changed: %+v", r)
		}
	}
}

func TestToutiaoT43T44ImportManualMatchingAndOwnershipRecheck(t *testing.T) {
	ctx := context.Background()
	a := drAccount(t, "toutiao", "T43T44当前号")
	other := drAccount(t, "toutiao", "T44其他号")
	pub := env.srv.now().AddDate(0, 0, -10)
	w := ttMetricWork(t, a, "micro_post", "无外部标题", pub)
	foreign := ttMetricWork(t, other, "micro_post", "其他账号作品", pub)
	foreignURL := "https://www.toutiao.com/w/" + strings.ReplaceAll(foreign.ID.String(), "-", "")
	if _, err := env.srv.db.Exec(ctx, `UPDATE work SET published_url=$2 WHERE id=$1`, foreign.ID, foreignURL); err != nil {
		t.Fatal(err)
	}
	path := "/api/v1/accounts/" + a.ID.String() + "/metrics/import"
	for _, csv := range []string{"work_id,impressions\n" + foreign.ID.String() + ",100\n", "url,impressions\n" + foreignURL + ",100\n"} {
		rows := ttCSVPreview(t, a.ID, csv)
		if len(rows) != 1 || rows[0].WorkID != nil || rows[0].Matched {
			t.Fatalf("foreign candidate matched: %+v", rows)
		}
	}
	for _, row := range []map[string]any{{"work_id": foreign.ID, "impressions": 100}, {"work_id": w.ID, "url": foreignURL, "impressions": 100}, {"work_id": w.ID, "content_format": "long_article", "impressions": 100}, {"work_id": w.ID, "published_at": pub.Add(-time.Hour), "impressions": 100}} {
		env.expectErr(t, "POST", path, map[string]any{"rows": []map[string]any{row}}, "validation_failed")
	}
	rows := ttCSVPreview(t, a.ID, "impressions,reads\n100,20\n")
	if len(rows) != 1 || rows[0].WorkID != nil || rows[0].Title != "" {
		t.Fatalf("titleless auto matched: %+v", rows)
	}
	env.mustJSON(t, "POST", path, map[string]any{"rows": []map[string]any{{"work_id": w.ID, "content_format": "micro_post", "impressions": 100, "reads": 20}}}, nil)
	if metricCount(t, w.ID) != 1 || metricCount(t, foreign.ID) != 0 {
		t.Fatal("manual selection wrote wrong account")
	}
	moved := ttMetricWork(t, a, "long_article", "确认前归属改变", pub)
	preview := ttCSVPreview(t, a.ID, "work_id,impressions\n"+moved.ID.String()+",300\n")
	if len(preview) != 1 || preview[0].WorkID == nil {
		t.Fatalf("setup preview: %+v", preview)
	}
	if _, err := env.srv.db.Exec(ctx, `UPDATE work SET account_id=$2 WHERE id=$1`, moved.ID, other.ID); err != nil {
		t.Fatal(err)
	}
	env.expectErr(t, "POST", path, map[string]any{"rows": []map[string]any{{"work_id": moved.ID, "impressions": 300}}}, "validation_failed")
	if metricCount(t, moved.ID) != 0 {
		t.Fatal("confirmation trusted obsolete preview ownership")
	}
	for i := 0; i < 2; i++ {
		ttMetricWork(t, a, "micro_post", "相同标题", pub)
	}
	dups := ttCSVPreview(t, a.ID, "title,content_format,impressions\n相同标题,micro_post,500\n")
	if len(dups) != 1 || dups[0].WorkID != nil || dups[0].Matched {
		t.Fatalf("duplicate title picked first: %+v", dups)
	}
}
