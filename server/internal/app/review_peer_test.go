package app

import (
	"context"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func i5Pub(daysAgo int) time.Time {
	return env.srv.today().AddDate(0, 0, daysAgo).Add(20 * time.Hour)
}

func i5Work(t *testing.T, a Account, title string, pub time.Time) Work {
	t.Helper()
	return drWork(t, a, title, "published", &pub)
}

func i5Metric(t *testing.T, workID uuid.UUID, captured time.Time, reads int, likes, favorites, comments, shares, follows int) metricResp {
	t.Helper()
	var m metricResp
	env.mustJSON(t, "POST", "/api/v1/works/"+workID.String()+"/metrics", map[string]any{
		"captured_at": captured, "reads": reads, "likes": likes, "favorites": favorites,
		"comments": comments, "shares": shares, "follows_gained": follows,
	}, &m)
	return m
}

func i5Card(t *testing.T, workID uuid.UUID, node int) peerCompareCard {
	t.Helper()
	var card peerCompareCard
	env.mustJSON(t, "GET", "/api/v1/works/"+workID.String()+"/peer-compare?node="+strconv.Itoa(node), nil, &card)
	return card
}

func TestI5MetricNodeMapping(t *testing.T) {
	cases := []struct{ day, node int }{
		{0, 0}, {1, 1}, {2, 1}, {3, 3}, {5, 3}, {6, 7}, {7, 7}, {29, 7}, {30, 30}, {31, 30},
	}
	for _, c := range cases {
		if got := metricNodeForDay(c.day); got != c.node {
			t.Fatalf("day %d -> node %d, got %d", c.day, c.node, got)
		}
	}
}

func TestI5PeerCompareNodesMedianAndFiltering(t *testing.T) {
	x := drAccount(t, "xhs", "I5 同龄对比主账号")
	other := drAccount(t, "xhs", "I5 同龄对比别的账号")
	currentPub := i5Pub(-7)
	current := i5Work(t, x, "I5 本期作品", currentPub)
	i5Metric(t, current.ID, env.srv.now(), 100, 10, 5, 2, 1, 8)

	p1 := i5Work(t, x, "I5 同批作品一", i5Pub(-8))
	i5Metric(t, p1.ID, i5Pub(-8).AddDate(0, 0, 7).Add(30*time.Minute), 80, 8, 4, 2, 1, 5)
	p2 := i5Work(t, x, "I5 同批作品二", i5Pub(-9))
	i5Metric(t, p2.ID, i5Pub(-9).AddDate(0, 0, 7).Add(30*time.Minute), 60, 6, 3, 1, 0, 3)
	p3 := i5Work(t, x, "I5 同批作品三", i5Pub(-10))
	i5Metric(t, p3.ID, i5Pub(-10).AddDate(0, 0, 7).Add(30*time.Minute), 120, 12, 6, 2, 2, 7)
	outside := i5Work(t, other, "I5 别的账号作品", i5Pub(-8))
	i5Metric(t, outside.ID, i5Pub(-8).AddDate(0, 0, 7).Add(30*time.Minute), 999, 99, 9, 9, 9, 99)

	card := i5Card(t, current.ID, 7)
	if card.SampleSize != 3 || !card.SampleSufficient || !card.NodeExact {
		t.Fatalf("sample/exact = %d/%v/%v, want 3/true/true", card.SampleSize, card.SampleSufficient, card.NodeExact)
	}
	if len(card.Peers) != 3 {
		t.Fatalf("peers = %d, want 3 (cross-account must be excluded): %+v", len(card.Peers), card.Peers)
	}
	for _, peer := range card.Peers {
		if peer.WorkID == outside.ID {
			t.Fatalf("cross-account work leaked into peers: %+v", peer)
		}
	}
	byKey := map[string]peerCompareMetricRow{}
	for _, m := range card.Metrics {
		byKey[m.Key] = m
	}
	reads := byKey["reads"]
	if reads.Current == nil || *reads.Current != 100 || reads.Median == nil || *reads.Median != 80 {
		t.Fatalf("reads current/median = %v/%v, want 100/80", reads.Current, reads.Median)
	}
	if reads.CompareLabel != "高于中位数 25.0%" || reads.SampleSize != 3 {
		t.Fatalf("reads compare = %q sample=%d", reads.CompareLabel, reads.SampleSize)
	}
	rate := byKey["interaction_rate"]
	if rate.Current == nil || rate.Median == nil || rate.CompareLabel != "低 0.3 个百分点" {
		t.Fatalf("interaction rate current/median/label = %v/%v/%q", rate.Current, rate.Median, rate.CompareLabel)
	}
	follows := byKey["follows_gained"]
	if follows.Current == nil || follows.Median == nil || *follows.Median != 5 || follows.CompareLabel != "高于中位数 60.0%" {
		t.Fatalf("follows current/median/label = %v/%v/%q", follows.Current, follows.Median, follows.CompareLabel)
	}
	if imp := byKey["impressions"]; imp.Current != nil || imp.Median != nil || imp.CompareLabel != "该节点未采集" {
		t.Fatalf("missing impressions must stay null, got %+v", imp)
	}

	var all peerCompareAll
	env.mustJSON(t, "GET", "/api/v1/works/"+current.ID.String()+"/peer-compare", nil, &all)
	if len(all.Nodes) != 4 || all.Nodes[0].Node != 1 || all.Nodes[3].Node != 30 {
		t.Fatalf("all-node endpoint = %+v, want 1/3/7/30", all.Nodes)
	}
	env.expectErr(t, "GET", "/api/v1/works/"+current.ID.String()+"/peer-compare?node=2", nil, "validation_failed")
}

func TestI5PeerCompareMissingNodeAndNonExact(t *testing.T) {
	x := drAccount(t, "xhs", "I5 缺失节点账号")
	pub := i5Pub(-7)
	w := i5Work(t, x, "I5 只有第 6 天数据", pub)
	// 第 6 天进入第 7 天节点，但 node_exact=false；第 1 天节点没有任何记录。
	i5Metric(t, w.ID, pub.AddDate(0, 0, 6).Add(2*time.Hour), 40, 4, 1, 0, 0, 2)

	card := i5Card(t, w.ID, 7)
	if card.NodeExact || card.Notice == "" || !strings.Contains(card.Notice, "非精确节点") {
		t.Fatalf("day 6 should be non-exact node 7: %+v", card)
	}
	reads := card.Metrics[0]
	if reads.Current == nil || *reads.Current != 40 {
		t.Fatalf("non-exact day 6 reads = %v, want 40", reads.Current)
	}

	missing := i5Card(t, w.ID, 1)
	if missing.NodeExact || missing.Notice == "" || !strings.Contains(missing.Notice, "未采集") {
		t.Fatalf("missing node 1 must say 未采集: %+v", missing)
	}
	for _, m := range missing.Metrics {
		if m.Current != nil {
			t.Fatalf("missing node must not be 0-filled: %+v", m)
		}
	}
}

func TestI5PeerCompareRecentFiveLimit(t *testing.T) {
	x := drAccount(t, "xhs", "I5 最近五篇账号")
	current := i5Work(t, x, "I5 最近五篇本期", i5Pub(-7))
	i5Metric(t, current.ID, env.srv.now(), 100, 10, 2, 1, 1, 3)
	var peers []Work
	for i := 1; i <= 7; i++ {
		peer := i5Work(t, x, "I5 最近五篇样本"+strconv.Itoa(i), i5Pub(-7-i))
		i5Metric(t, peer.ID, i5Pub(-7-i).AddDate(0, 0, 7).Add(30*time.Minute), 100-i, 5, 1, 1, 1, 2)
		peers = append(peers, peer)
	}
	card := i5Card(t, current.ID, 7)
	if card.SampleSize != 5 || len(card.Peers) != 5 {
		t.Fatalf("sample/peers = %d/%d, want 5/5", card.SampleSize, len(card.Peers))
	}
	// 只保留发布时间最近的 5 篇；最老两篇不能进入对比。
	for _, peer := range card.Peers {
		if peer.WorkID == peers[5].ID || peer.WorkID == peers[6].ID {
			t.Fatalf("older peer leaked into top-5: %+v", peer)
		}
	}
}

func TestI5PeerCompareSampleInsufficient(t *testing.T) {
	x := drAccount(t, "xhs", "I5 样本不足账号")
	pub := i5Pub(-7)
	current := i5Work(t, x, "I5 样本不足本期", pub)
	i5Metric(t, current.ID, env.srv.now(), 50, 5, 2, 0, 0, 3)
	peer := i5Work(t, x, "I5 唯一样本", i5Pub(-8))
	i5Metric(t, peer.ID, i5Pub(-8).AddDate(0, 0, 7).Add(30*time.Minute), 70, 7, 2, 0, 0, 4)

	card := i5Card(t, current.ID, 7)
	if card.SampleSize != 1 || card.SampleSufficient {
		t.Fatalf("sample = %d/%v, want 1/false", card.SampleSize, card.SampleSufficient)
	}
	reads := card.Metrics[0]
	if reads.CompareLabel != "样本不足，仅供参考" || reads.SampleSize != 1 {
		t.Fatalf("read compare/sample = %q/%d", reads.CompareLabel, reads.SampleSize)
	}
	if reads.Median == nil || *reads.Median != 70 {
		t.Fatalf("median should still be reference-only 70, got %v", reads.Median)
	}
}

func TestI5PeerCompareNotificationDedupe(t *testing.T) {
	orig := env.srv.now
	today := env.srv.today()
	env.srv.now = func() time.Time { return today.Add(9*time.Hour + 10*time.Minute) }
	defer func() { env.srv.now = orig }()

	x := drAccount(t, "xhs", "I5 通知去重账号")
	pub := today.AddDate(0, 0, -7).Add(20 * time.Hour)
	w := i5Work(t, x, "I5 通知作品", pub)
	i5Metric(t, w.ID, env.srv.now(), 30, 3, 1, 0, 0, 2)

	ctx := context.Background()
	env.srv.reviewPeerJob(ctx)
	env.srv.reviewPeerJob(ctx)

	// owner 是本用例创建的账号；组跑时其他用例泄漏进主 workspace 的 editor
	// 成员会按成员各落一行（dedupe 索引含 user_id），这里限定 owner 行验证
	// 两次 job 只落一条（dedupe 幂等）+ job_marker 守卫，不受成员泄漏影响。
	me := env.me(t)
	var ownerID uuid.UUID
	if err := env.srv.db.QueryRow(ctx,
		`SELECT id FROM app_user WHERE username=$1`, me.Username).Scan(&ownerID); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := env.srv.db.QueryRow(ctx, `SELECT count(*) FROM notification WHERE kind='review_peer' AND dedupe_key=$1
		AND user_id=$2`,
		"peer:"+w.ID.String()+":7", ownerID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("review_peer notifications = %d, want 1 (job_marker + dedupe_key)", count)
	}
	var link string
	if err := env.srv.db.QueryRow(ctx, `SELECT link FROM notification WHERE kind='review_peer' AND dedupe_key=$1
		AND user_id=$2`,
		"peer:"+w.ID.String()+":7", ownerID).Scan(&link); err != nil {
		t.Fatal(err)
	}
	want := "/a/" + x.ID.String() + "/review?work=" + w.ID.String() + "&node=7"
	if link != want {
		t.Fatalf("notification link = %q, want %q", link, want)
	}
	var marker bool
	if err := env.srv.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM job_marker WHERE key=$1)`,
		"peer:"+w.ID.String()+":7").Scan(&marker); err != nil || !marker {
		t.Fatalf("job_marker missing: %v %v", marker, err)
	}
}
