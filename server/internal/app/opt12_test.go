package app

import (
	"context"
	"crypto/md5"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"ops/internal/crawl"
)

func opt12Source(t *testing.T, ws *uuid.UUID) CrawlSource {
	t.Helper()
	ctx := context.Background()
	src := CrawlSource{Key: "opt12-" + uuid.NewString(), Kind: "rss", Name: "本地索引验收来源", WorkspaceID: ws}
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO crawl_source(key,kind,name,workspace_id) VALUES($1,$2,$3,$4)`, src.Key, src.Kind, src.Name, ws); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		var clusters []uuid.UUID
		if err := env.srv.db.QueryRow(ctx, `SELECT coalesce(array_agg(DISTINCT cluster_id) FILTER (WHERE cluster_id IS NOT NULL),'{}'::uuid[]) FROM hot_item WHERE source_key=$1`, src.Key).Scan(&clusters); err != nil {
			t.Error(err)
		}
		if _, err := env.srv.db.Exec(ctx, `DELETE FROM crawl_source WHERE key=$1`, src.Key); err != nil {
			t.Error(err)
		}
		if _, err := env.srv.db.Exec(ctx, `DELETE FROM hot_cluster c WHERE id=ANY($1) AND NOT EXISTS(SELECT 1 FROM hot_item h WHERE h.cluster_id=c.id)`, clusters); err != nil {
			t.Error(err)
		}
	})
	return src
}

func opt12Workspace(t *testing.T) uuid.UUID {
	t.Helper()
	var ws uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(), `INSERT INTO workspace(name) VALUES('本地索引验收工作区') RETURNING id`).Scan(&ws); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := env.srv.db.Exec(context.Background(), `DELETE FROM workspace WHERE id=$1`, ws); err != nil {
			t.Error(err)
		}
	})
	return ws
}

func TestOPT12HotClusteringThresholdAndScope(t *testing.T) {
	ctx := context.Background()
	cfg := env.srv.db.Config()
	cfg.MaxConns = 1
	cfg.ConnConfig.RuntimeParams["pg_trgm.similarity_threshold"] = "0.3"
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	srv := &Server{db: pool, now: env.srv.now}
	ws, other := opt12Workspace(t), opt12Workspace(t)
	publicA, publicB := opt12Source(t, nil), opt12Source(t, nil)
	privateA, privateB, privateOther := opt12Source(t, &ws), opt12Source(t, &ws), opt12Source(t, &other)
	store := func(src CrawlSource, title string) uuid.UUID {
		t.Helper()
		item := crawl.Item{Title: title, URL: "https://example.invalid/" + src.Key + "/" + title, Rank: 1}
		if err := srv.storeHotItem(ctx, src, item); err != nil {
			t.Fatal(err)
		}
		var cluster uuid.UUID
		if err := pool.QueryRow(ctx, `SELECT cluster_id FROM hot_item WHERE source_key=$1 AND title_norm=$2`, src.Key, normalizeHot(title)).Scan(&cluster); err != nil {
			t.Fatal(err)
		}
		var threshold float32
		if err := pool.QueryRow(ctx, `SELECT show_limit()`).Scan(&threshold); err != nil || threshold != .3 {
			t.Fatalf("池连接阈值被修改：%v %v", threshold, err)
		}
		return cluster
	}
	public := store(publicA, "abcdefg")
	if got := store(publicB, "ABCDEF-X"); got != public {
		t.Fatal("相似度恰为 0.6 的公开来源未合并")
	}
	if got := store(publicB, "abcdezz"); got == public {
		t.Fatal("低于 0.6 的标题被合并")
	}
	private := store(privateA, "abcdefg")
	if private == public || store(privateB, "abcdefx") != private {
		t.Fatal("私有来源未按工作区隔离或同工作区未合并")
	}
	if got := store(privateOther, "abcdefg"); got == private || got == public {
		t.Fatal("私有热点跨工作区合并")
	}
	before := store(privateA, "abcdefg")
	if again := store(privateA, "abcdefg"); again != before {
		t.Fatal("重复入库创建了新簇")
	}
	var n int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM hot_item WHERE source_key=$1`, privateA.Key).Scan(&n); err != nil || n != 1 {
		t.Fatalf("同来源查重失效：%d %v", n, err)
	}
	if err := srv.storeHotItem(ctx, CrawlSource{Key: "opt12-missing"}, crawl.Item{Title: "失败回滚验收", URL: "https://example.invalid/missing"}); err == nil {
		t.Fatal("不存在的来源写入成功")
	}
	var threshold float32
	if err := pool.QueryRow(ctx, `SELECT show_limit()`).Scan(&threshold); err != nil || threshold != .3 {
		t.Fatalf("回滚后阈值未恢复：%v %v", threshold, err)
	}
}

func opt12Explain(t *testing.T, q interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, index, sql string, args ...any) {
	t.Helper()
	var plan []byte
	if err := q.QueryRow(context.Background(), `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) `+sql, args...).Scan(&plan); err != nil {
		t.Fatal(err)
	}
	var plans []struct {
		Plan          map[string]any
		ExecutionTime float64 `json:"Execution Time"`
	}
	if err := json.Unmarshal(plan, &plans); err != nil || len(plans) != 1 {
		t.Fatalf("执行计划格式错误：%s %v", plan, err)
	}
	found := false
	var visit func(map[string]any)
	visit = func(node map[string]any) {
		if node["Index Name"] == index {
			found = true
			t.Logf("%s：%v，条件 %v，实际行 %v、循环 %v，完整查询 %.3fms", index, node["Node Type"], node["Index Cond"], node["Actual Rows"], node["Actual Loops"], plans[0].ExecutionTime)
		}
		if children, ok := node["Plans"].([]any); ok {
			for _, child := range children {
				visit(child.(map[string]any))
			}
		}
	}
	visit(plans[0].Plan)
	if !found {
		t.Fatalf("未使用 %s：%s", index, plan)
	}
}

func TestOPT12HotIndexAndBatchPerformance(t *testing.T) {
	ctx := context.Background()
	ws := opt12Workspace(t)
	src := opt12Source(t, &ws)
	_, err := env.srv.db.Exec(ctx, `WITH samples AS MATERIALIZED (
		SELECT gen_random_uuid() id, '热点验收'||md5('opt12-seed-'||i::text) title, i FROM generate_series(1,10000) i
	), clusters AS (
		INSERT INTO hot_cluster(id,title,sources) SELECT id,title,ARRAY[$1::text] FROM samples RETURNING id
	)
	INSERT INTO hot_item(source_key,title,title_norm,url,rank,cluster_id)
	SELECT $1,s.title,s.title,'https://example.invalid/opt12/seed/'||s.i,s.i,s.id FROM samples s JOIN clusters c ON c.id=s.id`, src.Key)
	if err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"hot_item", "hot_cluster", "crawl_source"} {
		if _, err := env.srv.db.Exec(ctx, `VACUUM (ANALYZE) `+table); err != nil {
			t.Fatal(err)
		}
	}
	var n int
	if err := env.srv.db.QueryRow(ctx, `SELECT count(*) FROM hot_item WHERE source_key=$1`, src.Key).Scan(&n); err != nil || n != 10000 {
		t.Fatalf("热点基数：%d %v", n, err)
	}
	tx, err := env.srv.db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SET LOCAL pg_trgm.similarity_threshold=0.6`); err != nil {
		t.Fatal(err)
	}
	title := fmt.Sprintf("热点验收%x", md5.Sum([]byte("opt12-seed-1")))
	opt12Explain(t, tx, "hot_item_title_trgm", hotClusterLookupSQL, title, ws)
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	for i := 1; i <= 200; i++ {
		kind := "new"
		if i%2 == 0 {
			kind = "seed"
		}
		item := crawl.Item{Title: fmt.Sprintf("热点验收%x", md5.Sum([]byte(fmt.Sprintf("opt12-%s-%d", kind, i)))), URL: fmt.Sprintf("https://example.invalid/opt12/%s/%d", kind, i), Rank: i}
		if err := env.srv.storeHotItem(ctx, src, item); err != nil {
			t.Fatal(err)
		}
	}
	elapsed := time.Since(started)
	t.Logf("10000 条热点，加载后 VACUUM/ANALYZE，单线程调用生产 storeHotItem 200 次（100 新增、100 已有）：%v", elapsed)
	if elapsed >= 2*time.Second {
		t.Fatalf("200 条入库未达到 <2s：%v", elapsed)
	}
	if err := env.srv.db.QueryRow(ctx, `SELECT count(*) FROM hot_item WHERE source_key=$1`, src.Key).Scan(&n); err != nil || n != 10100 {
		t.Fatalf("入库/查重数量错误：%d %v", n, err)
	}
}

func TestOPT12ListIndexesAndActivityP95(t *testing.T) {
	ctx := context.Background()
	guest := env.registerClient(t, "opt12-"+uuid.NewString(), testPassword)
	defer guest.restore(env)
	var account Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{"platform": "xhs", "name": "本地索引验收账号", "content_format": "image_note"}, &account)
	var work Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+account.ID.String()+"/works", map[string]string{"title": "作品动态验收"}, &work)
	marker := "opt12-" + uuid.NewString()
	t.Cleanup(func() {
		if _, err := env.srv.db.Exec(ctx, `DELETE FROM audit_log WHERE target_id LIKE $1||'%' OR (target_id=$2 AND actor_id IS NULL)`, marker, work.ID.String()); err != nil {
			t.Error(err)
		}
		if _, err := env.srv.db.Exec(ctx, `DELETE FROM work WHERE account_id=$1 AND id<>$2`, account.ID, work.ID); err != nil {
			t.Error(err)
		}
		if _, err := env.srv.db.Exec(ctx, `DELETE FROM topic WHERE account_id=$1`, account.ID); err != nil {
			t.Error(err)
		}
	})
	for _, sql := range []string{
		`INSERT INTO work(account_id,content_format,title,updated_at,deleted_at) SELECT $1,'image_note','索引作品'||i,now()-i*interval '1 second',CASE WHEN i%10=0 THEN now() END FROM generate_series(1,10000) i`,
		`INSERT INTO topic(account_id,title,created_at,pinned_at,deleted_at) SELECT $1,'索引选题'||i,now()-i*interval '1 second',CASE WHEN i%5=0 THEN now()-i*interval '1 second' END,CASE WHEN i%10=0 THEN now() END FROM generate_series(1,10000) i`,
	} {
		if _, err := env.srv.db.Exec(ctx, sql, account.ID); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO audit_log(action,target_type,target_id,result,created_at)
		SELECT 'work_create','work',CASE WHEN i%100=0 THEN $1 ELSE $2||i::text END,'ok',now()-i*interval '1 second' FROM generate_series(1,10000) i`, work.ID.String(), marker); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"work", "topic", "audit_log"} {
		if _, err := env.srv.db.Exec(ctx, `VACUUM (ANALYZE) `+table); err != nil {
			t.Fatal(err)
		}
	}
	opt12Explain(t, env.srv.db, "work_account_updated", `SELECT w.id,w.title FROM work w WHERE w.account_id=$1 AND w.deleted_at IS NULL ORDER BY w.updated_at DESC LIMIT 300`, account.ID)
	opt12Explain(t, env.srv.db, "topic_account_order", `SELECT `+topicCols+` FROM topic t WHERE t.account_id=$1 AND t.deleted_at IS NULL ORDER BY t.pinned_at DESC NULLS LAST,t.created_at DESC`, account.ID)
	opt12Explain(t, env.srv.db, "audit_log_target_created", `SELECT l.action,coalesce(u.username,'系统'),l.created_at FROM audit_log l LEFT JOIN app_user u ON u.id=l.actor_id WHERE l.target_id=$1 ORDER BY l.created_at DESC LIMIT 100`, work.ID.String())
	path := "/api/v1/works/" + work.ID.String() + "/activity"
	for i := 0; i < 5; i++ {
		if st, _ := env.do(http.MethodGet, path, nil); st != 200 {
			t.Fatalf("动态预热请求：%d", st)
		}
	}
	times := make([]time.Duration, 200)
	for i := range times {
		started := time.Now()
		st, body := env.do(http.MethodGet, path, nil)
		times[i] = time.Since(started)
		if st != 200 {
			t.Fatalf("动态接口：%d %s", st, body)
		}
	}
	sort.Slice(times, func(i, j int) bool { return times[i] < times[j] })
	p95 := times[189]
	t.Logf("10000 条操作日志；完整动态 HTTP 接口，预热 5 次、顺序测量 200 次，p95=%v", p95)
	if p95 >= 100*time.Millisecond {
		t.Fatalf("动态 p95 未达到 <100ms：%v", p95)
	}
	var list []WorkListItem
	env.mustJSON(t, "GET", "/api/v1/accounts/"+account.ID.String()+"/works", nil, &list)
	if len(list) != 300 {
		t.Fatalf("作品列表数量：%d", len(list))
	}
	for i := 1; i < len(list); i++ {
		if list[i].UpdatedAt.After(list[i-1].UpdatedAt) {
			t.Fatal("作品更新时间排序改变")
		}
	}
	var topics []Topic
	env.mustJSON(t, "GET", "/api/v1/accounts/"+account.ID.String()+"/topics", nil, &topics)
	if len(topics) != 9000 || !topics[0].Pinned {
		t.Fatalf("选题软删除过滤或星标优先失效：%d", len(topics))
	}
}
