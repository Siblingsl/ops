package app

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
)

// drAccount creates a fresh account so node/dedupe counts are not affected by other tests.
func drAccount(t *testing.T, platform, name string) Account {
	t.Helper()
	_ = env.accounts(t)
	format := "long_article"
	if platform == "xhs" {
		format = "image_note"
	}
	var a Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{"platform": platform, "name": name, "content_format": format}, &a)
	return a
}

// drWork creates a work and moves it straight to the given status; published_at may be nil.
func drWork(t *testing.T, a Account, title, status string, publishedAt *time.Time) Work {
	t.Helper()
	var wk Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+a.ID.String()+"/works", map[string]string{"title": title}, &wk)
	if _, err := env.srv.db.Exec(context.Background(), `UPDATE work SET status=$2, published_at=$3 WHERE id=$1`, wk.ID, status, publishedAt); err != nil {
		t.Fatal(err)
	}
	return wk
}

type metricResp struct {
	Metric
	Merged bool `json:"merged"`
}

func metricCount(t *testing.T, workID uuid.UUID) int {
	t.Helper()
	var n int
	if err := env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM metric_snapshot WHERE work_id=$1`, workID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// DEV-DR01（14 文档 4.1）：来源与发布天数节点、同来源同节点去重合并、未提供字段保持 NULL、
// 发布时间回填后重算节点、同一节点冲突时给出可读错误。
func TestDR01MetricNodes(t *testing.T) {
	ctx := context.Background()
	a := drAccount(t, "wechat_mp", "数据质量验收号")
	pub := time.Date(2026, 10, 1, 20, 0, 0, 0, env.srv.loc)
	wk := drWork(t, a, "数据节点验收作品", "published", &pub)
	path := "/api/v1/works/" + wk.ID.String() + "/metrics"

	var m1 metricResp
	env.mustJSON(t, "POST", path, map[string]any{"captured_at": pub.Add(14 * time.Hour), "reads": 100}, &m1)
	if m1.Source != "manual" || m1.DayOffset == nil || *m1.DayOffset != 1 || m1.Merged {
		t.Fatalf("first write should be manual day 1: %+v", m1)
	}
	if m1.Likes != nil || m1.Wows != nil {
		t.Fatalf("fields not entered must stay NULL: %+v", m1)
	}
	var m2 metricResp
	env.mustJSON(t, "POST", path, map[string]any{"captured_at": pub.Add(20 * time.Hour), "likes": 5}, &m2)
	if !m2.Merged || m2.ID != m1.ID || m2.Reads == nil || *m2.Reads != 100 || m2.Likes == nil || *m2.Likes != 5 {
		t.Fatalf("same source + same node should merge into one row: %+v", m2)
	}
	if n := metricCount(t, wk.ID); n != 1 {
		t.Fatalf("want 1 row after merge, got %d", n)
	}
	var m3 metricResp
	env.mustJSON(t, "POST", path, map[string]any{"captured_at": pub.AddDate(0, 0, 3), "reads": 300}, &m3)
	if m3.DayOffset == nil || *m3.DayOffset != 3 || m3.Merged {
		t.Fatalf("day 3 should be a new node: %+v", m3)
	}
	env.expectErr(t, "PATCH", "/api/v1/metrics/"+m3.ID.String(), map[string]any{"base_revision": m3.Revision, "captured_at": pub.Add(14 * time.Hour), "reads": 300}, "validation_failed")

	// 粘贴回填与手动录入分开保存，同节点互不覆盖。
	var imp struct {
		Imported int `json:"imported"`
	}
	env.mustJSON(t, "POST", "/api/v1/accounts/"+a.ID.String()+"/metrics/import", map[string]any{"source": "paste",
		"rows": []map[string]any{{"title": wk.Title, "work_id": wk.ID.String(), "reads": 999}}}, &imp)
	var pasteSrc string
	if err := env.srv.db.QueryRow(ctx, `SELECT source FROM metric_snapshot WHERE work_id=$1 AND reads=999`, wk.ID).Scan(&pasteSrc); err != nil || pasteSrc != "paste" {
		t.Fatalf("paste import source: %q %v", pasteSrc, err)
	}

	// 发布时间未知时节点为空；人工标记已发布后按发布日重算。
	packed := drWork(t, a, "先录数据后标记发布", "packed", nil)
	var early metricResp
	env.mustJSON(t, "POST", "/api/v1/works/"+packed.ID.String()+"/metrics", map[string]any{"captured_at": pub.AddDate(0, 0, 7), "reads": 70}, &early)
	if early.DayOffset != nil {
		t.Fatalf("no published_at yet, day_offset should be NULL: %+v", early)
	}
	env.mustJSON(t, "POST", "/api/v1/works/"+packed.ID.String()+"/published", map[string]any{"published_at": pub}, nil)
	var off *int
	if err := env.srv.db.QueryRow(ctx, `SELECT day_offset FROM metric_snapshot WHERE id=$1`, early.ID).Scan(&off); err != nil || off == nil || *off != 7 {
		t.Fatalf("day_offset should be recomputed to 7 after marking published: %v %v", off, err)
	}

	// 日历日口径：同一天晚些时候仍是第 0 天，跨过零点为第 1 天。
	var d0, d1 int
	if err := env.srv.db.QueryRow(ctx, `SELECT metric_day_offset('2026-10-01 23:30+08', '2026-10-01 20:00+08'), metric_day_offset('2026-10-02 00:10+08', '2026-10-01 20:00+08')`).Scan(&d0, &d1); err != nil || d0 != 0 || d1 != 1 {
		t.Fatalf("calendar day offset: %d %d %v", d0, d1, err)
	}
}

func drWechatAccount(t *testing.T, name string) Account {
	t.Helper()
	a := drAccount(t, "wechat_mp", name)
	env.reauth(t)
	env.mustJSON(t, "PUT", "/api/v1/accounts/"+a.ID.String()+"/wechat-credential", map[string]string{"app_id": "wx1234567890", "app_secret": "s3cret-value-for-test"}, nil)
	return a
}

func detailRows(ref time.Time, reads ...int) []map[string]any {
	out := []map[string]any{}
	for i, r := range reads {
		out = append(out, map[string]any{"stat_date": ref.AddDate(0, 0, i).Format("2006-01-02"), "target_user": 1000,
			"int_page_read_user": r, "int_page_read_count": r + 10, "share_user": i + 1, "share_count": i + 2, "add_to_fav_user": i, "add_to_fav_count": i})
	}
	return out
}

// DEV-DR03（14 文档 4.2 第 1–3 条）：getarticletotal 回看 7 天、累计口径按天写节点；msgid 精确匹配，
// 标题规范化 + 发布日 ±1 天匹配；重名或对不上进入待匹配，由人逐条指定或忽略；能力检测记录到账号。
func TestDR03WechatDatacubeSync(t *testing.T) {
	ctx := context.Background()
	if got := parseWechatMsgID("https://mp.weixin.qq.com/s?__biz=MzA5&mid=2247480001&idx=2&sn=abc"); got != "2247480001_2" {
		t.Fatalf("long link msgid: %q", got)
	}
	if got := parseWechatMsgID("https://mp.weixin.qq.com/s/AbCdEf123"); got != "" {
		t.Fatalf("short link has no msgid: %q", got)
	}

	a := drWechatAccount(t, "数据接口验收号")
	var probe struct {
		OK            bool   `json:"ok"`
		DatacubeState string `json:"datacube_state"`
	}
	env.mustJSON(t, "POST", "/api/v1/accounts/"+a.ID.String()+"/wechat-credential/test", nil, &probe)
	if !probe.OK || probe.DatacubeState != "ok" {
		t.Fatalf("capability probe on a permitted account: %+v", probe)
	}
	env.mockWX.SetDatacubeDenied(true)
	env.mustJSON(t, "POST", "/api/v1/accounts/"+a.ID.String()+"/wechat-credential/test", nil, &probe)
	if probe.DatacubeState != "no_permission" {
		env.mockWX.SetDatacubeDenied(false)
		t.Fatalf("unverified account should be detected: %+v", probe)
	}
	env.expectErr(t, "POST", "/api/v1/accounts/"+a.ID.String()+"/metrics/sync-wechat", nil, "wechat_capability")
	env.mockWX.SetDatacubeDenied(false)

	ref := env.srv.today().AddDate(0, 0, -3)
	pub := ref.Add(20 * time.Hour)
	exact := drWork(t, a, "精确匹配的文章", "pushed", nil)
	env.mustJSON(t, "POST", "/api/v1/works/"+exact.ID.String()+"/published", map[string]any{
		"url": "https://mp.weixin.qq.com/s?__biz=MzA5&mid=2247480001&idx=1&sn=abc", "published_at": pub}, nil)
	byTitle := drWork(t, a, "标题匹配：同名文章", "published", &pub)
	twinA := drWork(t, a, "系列文章", "published", &pub)
	_ = drWork(t, a, "系列文章", "published", &pub)
	env.mockWX.SetArticleTotals(map[string][]map[string]any{ref.Format("2006-01-02"): {
		{"ref_date": ref.Format("2006-01-02"), "msgid": "2247480001_1", "title": "随便改过的标题", "details": detailRows(ref, 100, 180, 220)},
		{"ref_date": ref.Format("2006-01-02"), "msgid": "2247480002_1", "title": "标题匹配：同名文章！", "details": detailRows(ref, 50)},
		{"ref_date": ref.Format("2006-01-02"), "msgid": "2247480003_1", "title": "系列文章", "details": detailRows(ref, 30, 40)},
		{"ref_date": ref.Format("2006-01-02"), "msgid": "2247480004_1", "title": "不是用本工具写的", "details": detailRows(ref, 10)},
	}})
	defer env.mockWX.SetArticleTotals(nil)

	type syncOut struct {
		Result datacubeResult `json:"result"`
	}
	var s1 syncOut
	env.mustJSON(t, "POST", "/api/v1/accounts/"+a.ID.String()+"/metrics/sync-wechat", nil, &s1)
	// D-129：标题相同但编号未经确认的文章不再自动绑定，只落待确认（legacy_title）。
	if s1.Result.Days != 7 || s1.Result.Articles != 4 || s1.Result.Matched != 1 || s1.Result.Unmatched != 3 || s1.Result.Written != 3 {
		t.Fatalf("first sync: %+v", s1.Result)
	}
	var reads, day int
	var likes *int
	var ext string
	if err := env.srv.db.QueryRow(ctx, `SELECT reads, day_offset, likes, external_id FROM metric_snapshot WHERE work_id=$1 AND source='wechat_api' ORDER BY day_offset DESC LIMIT 1`, exact.ID).
		Scan(&reads, &day, &likes, &ext); err != nil || reads != 220 || day != 2 || likes != nil || ext != "2247480001_1" {
		t.Fatalf("cumulative node for exact match: reads=%d day=%d likes=%v ext=%s err=%v", reads, day, likes, ext, err)
	}
	// 标题匹配不再写编号：编号只能由精确链接、用户确认或官方审计建立。
	var msgid *string
	var bindingSource *string
	_ = env.srv.db.QueryRow(ctx, `SELECT wechat_msgid, platform_binding_source FROM work WHERE id=$1`, byTitle.ID).Scan(&msgid, &bindingSource)
	if msgid != nil || bindingSource != nil {
		t.Fatalf("title similarity must not create a binding: msgid=%v source=%v", msgid, bindingSource)
	}

	var s2 syncOut
	env.mustJSON(t, "POST", "/api/v1/accounts/"+a.ID.String()+"/metrics/sync-wechat", nil, &s2)
	if n := metricCount(t, exact.ID); n != 3 {
		t.Fatalf("re-sync must not duplicate nodes, got %d rows", n)
	}

	var pending []unmatchedRow
	env.mustJSON(t, "GET", "/api/v1/accounts/"+a.ID.String()+"/metrics/unmatched", nil, &pending)
	if len(pending) != 3 {
		t.Fatalf("pending list: %+v", pending)
	}
	var twin, outside, similar unmatchedRow
	for _, p := range pending {
		switch p.ExternalID {
		case "2247480003_1":
			twin = p
		case "2247480002_1":
			similar = p
		default:
			outside = p
		}
	}
	if twin.Reason != "ambiguous" || outside.Reason != "none" || twin.Reads == nil || *twin.Reads != 40 {
		t.Fatalf("pending reasons: %+v %+v", twin, outside)
	}
	if similar.Reason != "legacy_title" {
		t.Fatalf("title-only match must stay pending as legacy_title: %+v", similar)
	}
	env.mustJSON(t, "POST", "/api/v1/metrics/unmatched/"+twin.ID.String()+"/assign", map[string]any{"work_id": twinA.ID}, nil)
	env.mustJSON(t, "POST", "/api/v1/metrics/unmatched/"+outside.ID.String()+"/ignore", nil, nil)
	// 只靠标题相似的那一条也要人逐条确认后才绑定，不能被下一次同步自动收编。
	env.mustJSON(t, "POST", "/api/v1/metrics/unmatched/"+similar.ID.String()+"/assign", map[string]any{"work_id": byTitle.ID}, nil)
	env.expectErr(t, "POST", "/api/v1/metrics/unmatched/"+outside.ID.String()+"/ignore", nil, "state_invalid")
	if n := metricCount(t, twinA.ID); n != 2 {
		t.Fatalf("assigned work should get 2 nodes, got %d", n)
	}
	var s3 syncOut
	env.mustJSON(t, "POST", "/api/v1/accounts/"+a.ID.String()+"/metrics/sync-wechat", nil, &s3)
	if s3.Result.Matched != 3 || s3.Result.Unmatched != 0 || s3.Result.Ignored != 1 {
		t.Fatalf("after assign/ignore: %+v", s3.Result)
	}
	env.mustJSON(t, "GET", "/api/v1/accounts/"+a.ID.String()+"/metrics/unmatched", nil, &pending)
	if len(pending) != 0 {
		t.Fatalf("nothing should stay pending: %+v", pending)
	}
	var acc Account
	env.mustJSON(t, "GET", "/api/v1/accounts/"+a.ID.String(), nil, &acc)
	if acc.DatacubeState != "ok" {
		t.Fatalf("successful sync marks the account ok: %q", acc.DatacubeState)
	}
}

// DEV-DR04（14 文档 4.3）：提醒按 1/3/7 天节点直达快录（链接带 work 与 node）；节点已有数据、
// 或已获授权的公众号接口会覆盖的作品不提醒；工作台待办只提示当前所在节点。
func TestDR04NodeReminders(t *testing.T) {
	ctx := context.Background()
	orig := env.srv.now
	today := env.srv.today()
	env.srv.now = func() time.Time { return today.Add(10 * time.Hour) }
	defer func() { env.srv.now = orig }()

	x := drAccount(t, "xhs", "快录提醒验收号")
	pub := today.AddDate(0, 0, -3).Add(20 * time.Hour)
	empty := drWork(t, x, "第三天还没录", "published", &pub)
	done := drWork(t, x, "第三天已录", "published", &pub)
	drMetric(t, done.ID, "manual", 3, 80)

	wx := drAccount(t, "wechat_mp", "接口覆盖验收号")
	covered := drWork(t, wx, "接口会同步的文章", "published", &pub)
	if _, err := env.srv.db.Exec(ctx, `UPDATE work SET wechat_msgid='2247489999_1' WHERE id=$1`, covered.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(ctx, `UPDATE platform_account SET datacube_state='ok' WHERE id=$1`, wx.ID); err != nil {
		t.Fatal(err)
	}

	env.srv.metricRemindersJob(ctx)
	links := map[string]string{}
	rows, err := env.srv.db.Query(ctx, `SELECT dedupe_key, link FROM notification WHERE kind='metric' AND dedupe_key LIKE 'metric:%'`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var k, l string
		if rows.Scan(&k, &l) == nil {
			links[k] = l
		}
	}
	rows.Close()
	if l := links["metric:"+empty.ID.String()+":3"]; l != "/a/"+x.ID.String()+"/review?work="+empty.ID.String()+"&node=3" {
		t.Fatalf("empty node should be reminded with a quick-entry link, got %q", l)
	}
	if _, ok := links["metric:"+done.ID.String()+":3"]; ok {
		t.Fatal("node with data must not be reminded")
	}
	if _, ok := links["metric:"+covered.ID.String()+":3"]; ok {
		t.Fatal("works covered by the datacube sync must not be reminded")
	}

	var dash struct {
		Todos []struct {
			WorkID uuid.UUID `json:"work_id"`
			Kind   string    `json:"kind"`
			Node   *int      `json:"node"`
		} `json:"todos"`
	}
	env.mustJSON(t, "GET", "/api/v1/accounts/"+x.ID.String()+"/dashboard", nil, &dash)
	seen := map[uuid.UUID]*int{}
	for _, td := range dash.Todos {
		if td.Kind == "metric" {
			seen[td.WorkID] = td.Node
		}
	}
	if n := seen[empty.ID]; n == nil || *n != 3 {
		t.Fatalf("dashboard should ask for the day-3 node: %+v", dash.Todos)
	}
	if _, ok := seen[done.ID]; ok {
		t.Fatal("work whose current node has data should not be a todo")
	}
	// 第 6 天的接口数据计入第 7 天节点（getarticletotal 只到第 6 天）。
	var node int
	if err := env.srv.db.QueryRow(ctx, `SELECT metric_node(6)`).Scan(&node); err != nil || node != 7 {
		t.Fatalf("day 6 should belong to the 7-day node: %d %v", node, err)
	}
}

func drMetric(t *testing.T, workID uuid.UUID, source string, day int, reads int) {
	t.Helper()
	if _, err := env.srv.db.Exec(context.Background(), `INSERT INTO metric_snapshot (work_id, captured_at, source, day_offset, reads, likes)
		VALUES ($1, now(), $2, $3, $4, 1)`, workID, source, day, reads); err != nil {
		t.Fatal(err)
	}
}

// DEV-DR02（14 文档 4.1 第 3–4 条）：统计统一取第 7 天口径——老作品不因"最新快照"被高估；
// 没有第 7 天时取 ≤ 7 的最近节点；同节点多来源按优先级取；节点完整度与账号健康度按到期节点计分。
func TestDR02DaySevenBasis(t *testing.T) {
	ctx := context.Background()
	a := drAccount(t, "wechat_mp", "第七天口径验收号")
	pub := env.srv.now().AddDate(0, 0, -40)
	old := drWork(t, a, "老作品：30 天后数字很大", "published", &pub)
	drMetric(t, old.ID, "manual", 1, 100)
	drMetric(t, old.ID, "manual", 7, 700)
	drMetric(t, old.ID, "manual", 30, 3000)
	early := drWork(t, a, "只有第 3 天数据", "published", &pub)
	drMetric(t, early.ID, "manual", 3, 300)
	multi := drWork(t, a, "第 7 天两个来源", "published", &pub)
	drMetric(t, multi.ID, "manual", 7, 500)
	drMetric(t, multi.ID, "wechat_api", 7, 600)

	want := map[uuid.UUID][2]int{old.ID: {700, 7}, early.ID: {300, 3}, multi.ID: {600, 7}}
	for id, w := range want {
		var reads, day int
		if err := env.srv.db.QueryRow(ctx, `SELECT reads, day_offset FROM work_metric_d7 WHERE work_id=$1`, id).Scan(&reads, &day); err != nil || reads != w[0] || day != w[1] {
			t.Fatalf("d7 for %s: reads=%d day=%d err=%v, want %v", id, reads, day, err, w)
		}
	}
	samples, err := env.srv.perfSamples(ctx, a.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range samples {
		if p.WorkID == old.ID && p.Reads != 700 {
			t.Fatalf("attribution must use the day-7 figure, got %d", p.Reads)
		}
	}

	var board []BoardRow
	env.mustJSON(t, "GET", "/api/v1/accounts/"+a.ID.String()+"/board", nil, &board)
	found := false
	for _, b := range board {
		if b.ID == old.ID {
			found = true
			if b.D7 == nil || b.D7.Reads == nil || *b.D7.Reads != 700 || len(b.Nodes) != 3 || b.Nodes[0] != 1 || b.Nodes[2] != 30 {
				t.Fatalf("board row should carry d7 and nodes [1 7 30]: %+v d7=%+v", b.Nodes, b.D7)
			}
		}
	}
	if !found {
		t.Fatal("old work missing from board")
	}

	recent := env.srv.now().AddDate(0, 0, -10)
	fresh := drWork(t, a, "十天前发布", "published", &recent)
	drMetric(t, fresh.ID, "manual", 1, 50)
	var nv struct {
		Nodes []metricNodeView `json:"nodes"`
		D7    *Metric          `json:"d7"`
	}
	env.mustJSON(t, "GET", "/api/v1/works/"+fresh.ID.String()+"/metrics?view=nodes", nil, &nv)
	if len(nv.Nodes) != 4 || !nv.Nodes[0].Due || nv.Nodes[0].Metric == nil || !nv.Nodes[2].Due || nv.Nodes[2].Metric != nil || nv.Nodes[3].Due {
		t.Fatalf("nodes view: %+v", nv.Nodes)
	}
	if nv.D7 == nil || *nv.D7.DayOffset != 1 {
		t.Fatalf("d7 should fall back to day 1: %+v", nv.D7)
	}
	due, covered, err := env.srv.metricNodeCoverage(ctx, a.ID, 30)
	if err != nil || due != 3 || covered != 1 {
		t.Fatalf("coverage for the 10-day-old work: due=%d covered=%d err=%v", due, covered, err)
	}
}
