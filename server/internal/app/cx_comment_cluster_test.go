package app

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

type i3ClusterSample struct {
	Content    string    `json:"content"`
	Platform   string    `json:"platform"`
	CapturedAt time.Time `json:"captured_at"`
}

type i3ClusterItem struct {
	ID           string            `json:"id"`
	QuestionText string            `json:"question_text"`
	MentionCount int               `json:"mention_count"`
	Status       string            `json:"status"`
	TopicID      *string           `json:"topic_id"`
	Revision     int               `json:"revision"`
	Samples      []i3ClusterSample `json:"samples"`
}

type i3ClusterPage struct {
	Items []i3ClusterItem `json:"items"`
}

func i3FreshAccount(t *testing.T) Account {
	t.Helper()
	var account Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{
		"platform": "xhs", "name": "I3 问题簇专用号 " + uuid.NewString()[:8], "content_format": "image_note",
	}, &account)
	return account
}

func i3QuestionComment(t *testing.T, account Account, content, alias string) commentInboxItem {
	t.Helper()
	var item commentInboxItem
	status, body := env.do("POST", "/api/v1/comments", map[string]any{
		"account_id": account.ID, "author_alias": alias, "content": content,
	})
	if status != 201 {
		t.Fatalf("create comment: %d %s", status, body)
	}
	if err := json.Unmarshal(body, &item); err != nil {
		t.Fatal(err)
	}
	status, body = env.do("PATCH", "/api/v1/comment-inbox/"+item.ID, map[string]any{
		"base_revision": item.Revision, "category": "question",
	})
	if status != 200 {
		t.Fatalf("mark question: %d %s", status, body)
	}
	if err := json.Unmarshal(body, &item); err != nil {
		t.Fatal(err)
	}
	return item
}

func i3Rebuild(t *testing.T, workspaceID uuid.UUID, account Account) {
	t.Helper()
	if err := env.srv.rebuildCommentClustersForAccount(context.Background(), workspaceID, account.ID); err != nil {
		t.Fatal(err)
	}
}

func i3ListClusters(t *testing.T, account Account, query string) (i3ClusterPage, []byte) {
	t.Helper()
	status, body := env.do("GET", "/api/v1/accounts/"+account.ID.String()+"/comment-clusters"+query, nil)
	if status != 200 {
		t.Fatalf("list clusters: %d %s", status, body)
	}
	var page i3ClusterPage
	if err := json.Unmarshal(body, &page); err != nil {
		t.Fatal(err)
	}
	return page, body
}

func TestI3NormalizationCanonicalKey(t *testing.T) {
	same := [][2]string{
		{"请问，第二步的依据是什么？", "第二步的依据是什么"},
		{"为啥这个价格这么高？", "为什么这个价格这么高"},
		{"在哪里可以购买？", "在哪可以购买"},
		{"怎么退款才能成功", "如何退款才能成功"},
		{"请问 https://example.com/x @读者甲 第二步的依据是什么？😊", "第二步的依据是什么"},
	}
	for _, pair := range same {
		if a, b := commentCanonicalKey(pair[0]), commentCanonicalKey(pair[1]); a != b || a == "" {
			t.Fatalf("normalization must converge %q vs %q: %q != %q", pair[0], pair[1], a, b)
		}
	}
	if commentCanonicalKey("怎么办") != "" {
		t.Fatal("short question below 6 runes must not form a cluster key")
	}
	if commentCanonicalKey("第二步的依据是什么") == commentCanonicalKey("第三步的依据是什么") {
		t.Fatal("different questions must not share a canonical key")
	}
	if got := normalizeCommentQuestion("  全角（标点）！  "); got != "全角标点" {
		t.Fatalf("full-width punctuation normalization = %q", got)
	}
	if got := commentClusterTopicTitle(strings.Repeat("题", 130)); len([]rune(got)) != commentClusterTitleMax {
		t.Fatalf("cluster topic title must truncate to %d runes: %d", commentClusterTitleMax, len([]rune(got)))
	}
}

func TestI3ClusterMentionCountDistinctAndSoftDelete(t *testing.T) {
	account := i3FreshAccount(t)
	workspaceID := uuid.MustParse(env.me(t).Workspace.ID)
	i3QuestionComment(t, account, "请问，第二步的依据是什么？", "读者甲")
	b := i3QuestionComment(t, account, "第二步的依据是什么", "读者乙")
	i3QuestionComment(t, account, "第三步的依据是什么", "读者丙")
	i3Rebuild(t, workspaceID, account)

	page, body := i3ListClusters(t, account, "?status=open")
	if len(page.Items) != 1 {
		t.Fatalf("two same questions must form exactly one cluster: %+v", page.Items)
	}
	cluster := page.Items[0]
	if cluster.MentionCount != 2 {
		t.Fatalf("mention_count must count distinct comments: %d", cluster.MentionCount)
	}
	if strings.Contains(string(body), "author_alias") || strings.Contains(string(body), "读者甲") ||
		strings.Contains(string(body), "读者乙") || strings.Contains(string(body), "读者丙") {
		t.Fatalf("cluster response must not expose reviewer identity: %s", body)
	}
	if len(cluster.Samples) != 2 || cluster.Samples[0].Platform == "" {
		t.Fatalf("samples must contain content/platform/time only: %+v", cluster.Samples)
	}

	// 第三条同题评论加入后计数升到 3；重复重算不改簇身份。
	i3QuestionComment(t, account, "第二步的依据是什么呢", "读者丁")
	i3Rebuild(t, workspaceID, account)
	page, _ = i3ListClusters(t, account, "?status=open")
	if len(page.Items) != 1 || page.Items[0].MentionCount != 3 || page.Items[0].ID != cluster.ID {
		t.Fatalf("cluster must be stable and count 3: %+v", page.Items)
	}
	i3Rebuild(t, workspaceID, account)
	page, _ = i3ListClusters(t, account, "?status=open")
	if page.Items[0].MentionCount != 3 {
		t.Fatalf("rebuild must be idempotent: %+v", page.Items)
	}

	// 软删只在下一次重算时降计数；删除后立即查询仍是旧快照。
	status, body := env.do("DELETE", "/api/v1/comment-inbox/"+b.ID, nil)
	if status != 200 {
		t.Fatalf("delete comment: %d %s", status, body)
	}
	page, _ = i3ListClusters(t, account, "?status=open")
	if page.Items[0].MentionCount != 3 {
		t.Fatalf("soft delete must not change historical count before rebuild: %+v", page.Items)
	}
	i3Rebuild(t, workspaceID, account)
	page, _ = i3ListClusters(t, account, "?status=open")
	if page.Items[0].MentionCount != 2 {
		t.Fatalf("rebuild must lower count after soft delete: %+v", page.Items)
	}

	// 一条评论不成簇（另建独立账号，避免已有簇干扰）。
	single := i3FreshAccount(t)
	i3QuestionComment(t, single, "有没有适合新手的记录方法", "读者戊")
	i3Rebuild(t, workspaceID, single)
	singlePage, _ := i3ListClusters(t, single, "")
	if len(singlePage.Items) != 0 {
		t.Fatalf("one question must not form a cluster: %+v", singlePage.Items)
	}
}

func TestI3ClusterConvertIdempotentAndKeepsSingleConvert(t *testing.T) {
	account := i3FreshAccount(t)
	workspaceID := uuid.MustParse(env.me(t).Workspace.ID)
	i3QuestionComment(t, account, "价格为什么比同类高这么多", "读者A")
	i3QuestionComment(t, account, "价格为什么比同类高这么多呢", "读者B")
	i3Rebuild(t, workspaceID, account)
	page, _ := i3ListClusters(t, account, "?status=open")
	if len(page.Items) != 1 {
		t.Fatalf("cluster missing: %+v", page.Items)
	}
	clusterID := page.Items[0].ID

	type convertResponse struct {
		Topic struct {
			ID     string `json:"id"`
			Source string `json:"source"`
			Title  string `json:"title"`
		} `json:"topic"`
		Cluster i3ClusterItem `json:"cluster"`
		Reused  bool          `json:"reused"`
	}
	var first convertResponse
	status, body := env.do("POST", "/api/v1/comment-clusters/"+clusterID+"/convert", map[string]any{})
	if status != 201 || json.Unmarshal(body, &first) != nil {
		t.Fatalf("convert cluster: %d %s", status, body)
	}
	if first.Topic.Source != "comment" || first.Cluster.Status != "converted" || first.Reused {
		t.Fatalf("cluster conversion must use source=comment and mark converted: %+v", first)
	}
	var second convertResponse
	status, body = env.do("POST", "/api/v1/comment-clusters/"+clusterID+"/convert", map[string]any{})
	if status != 200 || json.Unmarshal(body, &second) != nil {
		t.Fatalf("replay convert: %d %s", status, body)
	}
	if !second.Reused || second.Topic.ID != first.Topic.ID {
		t.Fatalf("cluster conversion must be idempotent: %+v vs %+v", second, first)
	}
	var source string
	if err := env.srv.db.QueryRow(context.Background(), `SELECT source FROM topic WHERE id=$1`, first.Topic.ID).Scan(&source); err != nil {
		t.Fatal(err)
	}
	if source != "comment" {
		t.Fatalf("topic source = %q", source)
	}

	// 单条评论转选题仍保持 source=manual，不因 I3 改成 comment。
	single := i3QuestionComment(t, account, "单条评论转选题仍然可用吗", "读者C")
	var singleConvert struct {
		Topic struct {
			ID     string `json:"id"`
			Source string `json:"source"`
		} `json:"topic"`
	}
	status, body = env.do("POST", "/api/v1/comment-inbox/"+single.ID+"/convert-topic", map[string]any{
		"title": "单条转选题回归", "idempotency_key": "i3-single-convert",
	})
	if status != 201 || json.Unmarshal(body, &singleConvert) != nil {
		t.Fatalf("single convert regression: %d %s", status, body)
	}
	if singleConvert.Topic.Source != "manual" {
		t.Fatalf("single comment conversion must stay manual: %+v", singleConvert)
	}
}

func TestI3ClusterIgnoreReopenAndCrossWorkspace(t *testing.T) {
	account := i3FreshAccount(t)
	workspaceID := uuid.MustParse(env.me(t).Workspace.ID)
	i3QuestionComment(t, account, "这个功能怎么使用", "读者X")
	i3QuestionComment(t, account, "这个功能如何使用", "读者Y")
	i3Rebuild(t, workspaceID, account)
	page, _ := i3ListClusters(t, account, "?status=open")
	if len(page.Items) != 1 {
		t.Fatalf("cluster missing: %+v", page.Items)
	}
	id := page.Items[0].ID

	status, body := env.do("POST", "/api/v1/comment-clusters/"+id+"/ignore", map[string]any{})
	if status != 200 {
		t.Fatalf("ignore: %d %s", status, body)
	}
	status, body = env.do("POST", "/api/v1/comment-clusters/"+id+"/convert", map[string]any{})
	if status != 409 || !strings.Contains(string(body), "cluster_ignored") {
		t.Fatalf("ignored cluster must not convert: %d %s", status, body)
	}
	status, body = env.do("POST", "/api/v1/comment-clusters/"+id+"/reopen", map[string]any{})
	if status != 200 {
		t.Fatalf("reopen: %d %s", status, body)
	}
	status, body = env.do("POST", "/api/v1/comment-clusters/"+id+"/convert", map[string]any{})
	if status != 201 {
		t.Fatalf("reopened cluster must convert: %d %s", status, body)
	}

	// 跨工作区不可见：访客会话访问原账号的簇列表必须 404。
	cross := env.registerClient(t, "i3_cross_"+uuid.NewString()[:8], testPassword)
	defer cross.restore(env)
	env.mustJSONStatus(t, "GET", "/api/v1/accounts/"+account.ID.String()+"/comment-clusters", nil, nil, 404)
}

func TestI3ReaderTermsDocFreqStopwordsAndTop50(t *testing.T) {
	account := i3FreshAccount(t)
	workspaceID := uuid.MustParse(env.me(t).Workspace.ID)
	for _, content := range []string{
		"这个价格为什么这么高？",
		"价格和同类相比合理吗",
		"请问价格还能优惠吗",
		"操作步骤能不能再详细一点",
		"步骤太多记不住怎么办",
		"退款流程在哪里",
	} {
		i3QuestionComment(t, account, content, "")
	}
	now := env.srv.today().In(env.srv.loc)
	terms, err := env.srv.recomputeReaderTerms(context.Background(), workspaceID, account.ID, now.AddDate(0, 0, -1), now)
	if err != nil {
		t.Fatal(err)
	}
	found := map[string]int{}
	for _, term := range terms {
		found[term.Term] = term.DocFreq
	}
	if found["价格"] != 3 || found["步骤"] != 2 {
		t.Fatalf("doc_freq must count distinct comments: %+v", found)
	}
	if found["什么"] != 0 || found["退款"] != 0 {
		t.Fatalf("stopwords and single-mention terms must be excluded: %+v", found)
	}

	// 直接写入 51 个两两共现的词，验证 top 50 截断。
	for i := 0; i < 51; i++ {
		term := fmt.Sprintf("测%02d", i)
		for j := 0; j < 2; j++ {
			if _, err := env.srv.db.Exec(context.Background(), `INSERT INTO comment_inbox
				(workspace_id,account_id,content,captured_at,category) VALUES ($1,$2,$3,now(),'question')`,
				workspaceID, account.ID, "关注"+term+"变化"); err != nil {
				t.Fatal(err)
			}
		}
	}
	terms, err = env.srv.recomputeReaderTerms(context.Background(), workspaceID, account.ID, now.AddDate(0, 0, -1), now)
	if err != nil {
		t.Fatal(err)
	}
	if len(terms) != readerTermTop {
		t.Fatalf("reader terms must truncate to top %d: %d", readerTermTop, len(terms))
	}
	for _, term := range terms {
		if term.DocFreq < 2 {
			t.Fatalf("top terms must have doc_freq >= 2: %+v", term)
		}
	}
}

func TestI3ReaderTermNGramsBoundaries(t *testing.T) {
	terms := readerTermNGrams("价格")
	if len(terms) != 1 || terms[0] != "价格" {
		t.Fatalf("2-rune term must be kept: %+v", terms)
	}
	if got := readerTermNGrams("什么"); len(got) != 0 {
		t.Fatalf("stopword must be removed: %+v", got)
	}
	if got := readerTermNGrams("1234"); len(got) != 0 {
		t.Fatalf("digits-only n-grams must be removed: %+v", got)
	}
}
