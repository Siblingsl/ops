package app

import (
	"bytes"
	"context"
	"encoding/json"
	"math"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

// DEV-CX13-C / FR-CX-19：选题库存五态与 Q-CX-06 渐进核验。
// 存量 unknown（idea 且 verified_at=NULL）逐题核验后才进新排期；
// 采用事实（used）不可逆；水位统计不伪造历史时间。

func cx13CreateTopic(t *testing.T, accountID uuid.UUID, title string) Topic {
	t.Helper()
	var out struct {
		Topic Topic `json:"topic"`
	}
	env.mustJSON(t, "POST", "/api/v1/accounts/"+accountID.String()+"/topics", map[string]string{"title": title}, &out)
	return out.Topic
}

func cx13Verify(t *testing.T, id uuid.UUID, note string) (int, []byte) {
	t.Helper()
	var updated time.Time
	if err := env.srv.db.QueryRow(t.Context(), `SELECT updated_at FROM topic WHERE id=$1`, id).Scan(&updated); err != nil {
		t.Fatal(err)
	}
	return env.do("POST", "/api/v1/topics/"+id.String()+"/verify", map[string]any{"note": note, "basis_updated_at": updated})
}

func cx13StartWork(t *testing.T, id uuid.UUID) (int, []byte) {
	t.Helper()
	return env.do("POST", "/api/v1/topics/"+id.String()+"/works", nil)
}

func cx13StartWorkOK(t *testing.T, id uuid.UUID) Work {
	t.Helper()
	st, body := cx13StartWork(t, id)
	if st != 200 {
		t.Fatalf("start work: %d %s", st, body)
	}
	var wk Work
	if err := json.Unmarshal(body, &wk); err != nil {
		t.Fatalf("decode work: %v body=%s", err, body)
	}
	return wk
}

// cx13PatchTopic sends a PATCH and decodes {"ok","topic"}.
func cx13PatchTopic(t *testing.T, id uuid.UUID, in map[string]any) (int, []byte, Topic) {
	t.Helper()
	if _, ok := in["stock_transition"]; ok {
		if _, supplied := in["basis_updated_at"]; !supplied {
			var updated time.Time
			if err := env.srv.db.QueryRow(t.Context(), `SELECT updated_at FROM topic WHERE id=$1`, id).Scan(&updated); err != nil {
				t.Fatal(err)
			}
			in["basis_updated_at"] = updated
		}
	}
	st, body := env.do("PATCH", "/api/v1/topics/"+id.String(), in)
	var out struct {
		Topic Topic `json:"topic"`
	}
	if st == 200 {
		if err := json.Unmarshal(body, &out); err != nil {
			t.Fatalf("decode patch: %v body=%s", err, body)
		}
	}
	return st, body, out.Topic
}

// cx13VerifyNote builds a note with exactly n runes (码点).
func cx13VerifyNote(n int) string {
	return strings.Repeat("核", n)
}

func TestCX13TopicStockRejectsStaleBasis(t *testing.T) {
	tp := cx13CreateTopic(t, env.accounts(t).xhs.ID, "CX13并发核验依据")
	path := "/api/v1/topics/" + tp.ID.String()
	if _, err := env.srv.db.Exec(t.Context(), `UPDATE topic SET updated_at=updated_at + interval '1 second' WHERE id=$1`, tp.ID); err != nil {
		t.Fatal(err)
	}
	for _, req := range []struct {
		method, path string
		body         map[string]any
	}{
		{"POST", path + "/verify", map[string]any{"basis_updated_at": tp.UpdatedAt, "note": cx13VerifyNote(20)}},
		{"PATCH", path, map[string]any{"basis_updated_at": tp.UpdatedAt, "stock_transition": "dropped"}},
	} {
		status, body := env.do(req.method, req.path, req.body)
		if status != 409 || !bytes.Contains(body, []byte("version_conflict")) {
			t.Fatalf("过期依据应冲突: %s %d %s", req.method, status, body)
		}
	}
}

func TestCX13TopicStockRequiresBasis(t *testing.T) {
	tp := cx13CreateTopic(t, env.accounts(t).xhs.ID, "CX13缺失核验依据")
	path := "/api/v1/topics/" + tp.ID.String()
	for _, req := range []struct {
		method, path string
		body         map[string]any
	}{
		{"POST", path + "/verify", map[string]any{"note": cx13VerifyNote(20)}},
		{"PATCH", path, map[string]any{"stock_transition": "dropped"}},
	} {
		status, body := env.do(req.method, req.path, req.body)
		if status != 422 {
			t.Fatalf("缺少依据应拒绝: %s %d %s", req.method, status, body)
		}
	}
}

func TestCX13TopicStockStatusUpdateRollsBack(t *testing.T) {
	tp := cx13CreateTopic(t, env.accounts(t).xhs.ID, "CX13事务回滚")
	_, err := env.srv.db.Exec(t.Context(), `CREATE FUNCTION cx13_test_reject_adoption() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN IF NEW.id = TG_ARGV[0]::uuid AND NEW.status = 'adopted' THEN RAISE EXCEPTION 'test rejection'; END IF; RETURN NEW; END $$;
		CREATE TRIGGER cx13_test_reject_adoption BEFORE UPDATE ON topic FOR EACH ROW EXECUTE FUNCTION cx13_test_reject_adoption('`+tp.ID.String()+`')`)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(context.Background(), `DROP TRIGGER IF EXISTS cx13_test_reject_adoption ON topic; DROP FUNCTION IF EXISTS cx13_test_reject_adoption()`)
	})
	status, _, _ := cx13PatchTopic(t, tp.ID, map[string]any{"status": "adopted"})
	if status < 400 {
		t.Fatalf("拒绝写入时应失败: %d", status)
	}
	stock, usedAt, _ := cx13ReadStock(t, tp.ID)
	if stock != "idea" || usedAt != nil {
		t.Fatalf("失败必须回滚库存: %s %v", stock, usedAt)
	}
}

func TestCX13TopicStockInvalidFieldsRollBack(t *testing.T) {
	tp := cx13CreateTopic(t, env.accounts(t).xhs.ID, "CX13无效字段回滚")
	status, _, _ := cx13PatchTopic(t, tp.ID, map[string]any{"stock_transition": "dropped", "series_id": uuid.NewString()})
	if status != 422 {
		t.Fatalf("无效系列必须拒绝: %d", status)
	}
	stock, _, _ := cx13ReadStock(t, tp.ID)
	if stock != "idea" {
		t.Fatalf("失败必须回滚库存: %s", stock)
	}
}

func TestCX13TopicStockLegacyCreateWorkPath(t *testing.T) {
	account := env.accounts(t).xhs
	path := "/api/v1/accounts/" + account.ID.String() + "/works"
	tp := cx13CreateTopic(t, account.ID, "旧客户端创建作品")
	var first, second Work
	env.mustJSON(t, "POST", path, map[string]any{"topic_id": tp.ID}, &first)
	stock, usedAt, verifiedAt := cx13ReadStock(t, tp.ID)
	if stock != "used" || usedAt == nil || verifiedAt != nil {
		t.Fatalf("旧客户端采用应同步库存且不伪造核验: %s %v %v", stock, usedAt, verifiedAt)
	}
	env.mustJSON(t, "POST", path, map[string]any{"topic_id": tp.ID}, &second)
	if first.ID != second.ID {
		t.Fatal("重复采用不应创建第二篇作品")
	}
	dropped := cx13CreateTopic(t, account.ID, "不能采用的放弃选题")
	if st, body, _ := cx13PatchTopic(t, dropped.ID, map[string]any{"stock_transition": "dropped"}); st != 200 {
		t.Fatalf("放弃失败: %d %s", st, body)
	}
	if st, body := env.do("POST", path, map[string]any{"topic_id": dropped.ID}); st != 422 {
		t.Fatalf("放弃选题必须拒绝创建作品: %d %s", st, body)
	}
}

func TestCX13TopicStockConcurrentCreateWorkPaths(t *testing.T) {
	account := env.accounts(t).xhs
	tp := cx13CreateTopic(t, account.ID, "并发采用选题")
	type result struct {
		status int
		body   []byte
	}
	results := make(chan result, 2)
	start := make(chan struct{})
	go func() {
		<-start
		st, body := env.do("POST", "/api/v1/topics/"+tp.ID.String()+"/works", nil)
		results <- result{st, body}
	}()
	go func() {
		<-start
		st, body := env.do("POST", "/api/v1/accounts/"+account.ID.String()+"/works", map[string]any{"topic_id": tp.ID})
		results <- result{st, body}
	}()
	close(start)
	var ids []uuid.UUID
	for range 2 {
		got := <-results
		if got.status != 200 {
			t.Fatalf("并发建稿失败: %d %s", got.status, got.body)
		}
		var work Work
		if err := json.Unmarshal(got.body, &work); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, work.ID)
	}
	if ids[0] != ids[1] {
		t.Fatalf("并发建稿返回不同作品: %v", ids)
	}
	var count int
	if err := env.srv.db.QueryRow(t.Context(), `SELECT count(*) FROM work WHERE topic_id=$1 AND deleted_at IS NULL`, tp.ID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("并发后作品数应为 1，实际 %d", count)
	}
}

func TestCX13TopicStockExcludesUndatedHistoricalDrop(t *testing.T) {
	var acc Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{"platform": "xhs", "name": "CX13历史放弃", "content_format": "image_note"}, &acc)
	if _, err := env.srv.db.Exec(t.Context(), `INSERT INTO topic(account_id,title,source,status,stock_status) VALUES ($1,'历史放弃','manual','dropped','dropped')`, acc.ID); err != nil {
		t.Fatal(err)
	}
	var sum topicStockSummary
	env.mustJSON(t, "GET", "/api/v1/accounts/"+acc.ID.String()+"/topic-stock", nil, &sum)
	if sum.AdoptionRate != nil || sum.SampleCount != 0 || sum.ExcludedCount != 1 {
		t.Fatalf("无事件时间的历史放弃应排除: %+v", sum)
	}
	if _, err := env.srv.db.Exec(t.Context(), `INSERT INTO topic(account_id,title,source,status,stock_status,used_at,stock_changed_at) VALUES
		($1,'本月采用','manual','adopted','used',now(),now()),
		($1,'上月采用','manual','adopted','used',date_trunc('month',now()) - interval '1 second',date_trunc('month',now()) - interval '1 second'),
		($1,'本月放弃','manual','dropped','dropped',NULL,now()),
		($1,'上月放弃','manual','dropped','dropped',NULL,date_trunc('month',now()) - interval '1 second')`, acc.ID); err != nil {
		t.Fatal(err)
	}
	env.mustJSON(t, "GET", "/api/v1/accounts/"+acc.ID.String()+"/topic-stock", nil, &sum)
	if sum.AdoptionRate == nil || *sum.AdoptionRate != 0.5 || sum.SampleCount != 2 || sum.ExcludedCount != 1 {
		t.Fatalf("采用率只统计本月事件: %+v", sum)
	}
}

// 存量 unknown 语义（Q-CX-06）：新/迁移选题默认 idea 且 verified_at=NULL，
// 未核验不能进新排期，但旧采用路径保持原行为（可直接建作品），采用是事实终态。
func TestCX13TopicStockLegacyUnknownAdoption(t *testing.T) {
	account := env.accounts(t).xhs
	tp := cx13CreateTopic(t, account.ID, "CX13存量未核验选题")
	if tp.StockStatus != "idea" || tp.VerifiedAt != nil || tp.UsedAt != nil {
		t.Fatalf("新选题应为 unknown idea（verified_at=NULL）: stock=%s verified=%v used=%v", tp.StockStatus, tp.VerifiedAt, tp.UsedAt)
	}

	// 未核验 idea 不能进新排期（转换矩阵只在 verified→ready 开放 ready 目标）。
	st, body, _ := cx13PatchTopic(t, tp.ID, map[string]any{"stock_transition": "ready", "planned_date": "2030-01-02"})
	if st != 422 || !bytes.Contains(body, []byte("不能转换")) {
		t.Fatalf("未核验 idea→ready 必须拒绝: %d %s", st, body)
	}

	// 旧采用路径保持原行为：未核验 idea 直接建作品成功（过渡期不设豁免标记）。
	wk := cx13StartWorkOK(t, tp.ID)

	// 采用是库存事实：used + used_at；不伪造核验时间。
	stock, usedAt, verifiedAt := cx13ReadStock(t, tp.ID)
	if stock != "used" || usedAt == nil {
		t.Fatalf("采用后库存应为 used 且记录 used_at: stock=%s used_at=%v", stock, usedAt)
	}
	if verifiedAt != nil {
		t.Fatalf("存量未核验即采用不得伪造核验时间: %v", verifiedAt)
	}

	// 采用事实不可逆：used 无任何 PATCH 出边。
	for _, in := range []map[string]any{
		{"status": "pending"},
		{"status": "dropped"},
		{"stock_transition": "dropped"},
		{"stock_transition": "idea"},
	} {
		st, body, _ := cx13PatchTopic(t, tp.ID, in)
		if st != 422 {
			t.Fatalf("used 必须拒绝 %v: %d %s", in, st, body)
		}
	}

	// 幂等：再次开工返回同一篇作品，不重复创建、不报错。
	wk2 := cx13StartWorkOK(t, tp.ID)
	if wk2.ID != wk.ID {
		t.Fatalf("重复开工应返回同一作品: %s vs %s", wk.ID, wk2.ID)
	}
}

func cx13ReadStock(t *testing.T, id uuid.UUID) (string, *time.Time, *time.Time) {
	t.Helper()
	var stock string
	var usedAt, verifiedAt *time.Time
	if err := env.srv.db.QueryRow(t.Context(),
		`SELECT stock_status, used_at, verified_at FROM topic WHERE id=$1`, id).Scan(&stock, &usedAt, &verifiedAt); err != nil {
		t.Fatal(err)
	}
	return stock, usedAt, verifiedAt
}

// 核验端点：note 20..500 码点；idea/verified 可核验；ready/used/dropped 拒绝。
func TestCX13TopicStockVerifyEndpoint(t *testing.T) {
	account := env.accounts(t).xhs
	tp := cx13CreateTopic(t, account.ID, "CX13核验边界")

	// 19 码点拒绝，20 码点通过。
	if st, body := cx13Verify(t, tp.ID, cx13VerifyNote(19)); st != 422 || !bytes.Contains(body, []byte("20..500")) {
		t.Fatalf("note 19 码点必须拒绝: %d %s", st, body)
	}
	st, body := cx13Verify(t, tp.ID, cx13VerifyNote(20))
	if st != 200 {
		t.Fatalf("note 20 码点应通过: %d %s", st, body)
	}
	var vr struct {
		Topic Topic `json:"topic"`
	}
	if err := json.Unmarshal(body, &vr); err != nil {
		t.Fatalf("decode verify: %v %s", err, body)
	}
	if vr.Topic.StockStatus != "verified" || vr.Topic.VerifiedAt == nil || vr.Topic.VerifyNote != cx13VerifyNote(20) {
		t.Fatalf("核验后应 verified 且记录 note: %+v", vr.Topic)
	}

	// verified 可重核（刷新有效期）。
	if st, body := cx13Verify(t, tp.ID, cx13VerifyNote(21)); st != 200 {
		t.Fatalf("verified 重核应允许: %d %s", st, body)
	}

	// 501 码点拒绝。
	if st, body := cx13Verify(t, tp.ID, cx13VerifyNote(501)); st != 422 {
		t.Fatalf("note 501 码点必须拒绝: %d %s", st, body)
	}

	// ready 须先取消排期再核验。
	if st, body, _ := cx13PatchTopic(t, tp.ID, map[string]any{"stock_transition": "ready", "planned_date": "2030-01-02"}); st != 200 {
		t.Fatalf("verified→ready: %d %s", st, body)
	}
	if st, body := cx13Verify(t, tp.ID, cx13VerifyNote(22)); st != 422 || !bytes.Contains(body, []byte("取消排期")) {
		t.Fatalf("ready 直接核验必须拒绝: %d %s", st, body)
	}

	// dropped 须先恢复再核验。
	tp2 := cx13CreateTopic(t, account.ID, "CX13放弃后核验")
	if st, body, _ := cx13PatchTopic(t, tp2.ID, map[string]any{"stock_transition": "dropped", "reason": "暂不写"}); st != 200 {
		t.Fatalf("idea→dropped: %d %s", st, body)
	}
	if st, body := cx13Verify(t, tp2.ID, cx13VerifyNote(23)); st != 422 || !bytes.Contains(body, []byte("只有想法或已核验")) {
		t.Fatalf("dropped 直接核验必须拒绝: %d %s", st, body)
	}
}

// 转换矩阵与必填条件：ready 须计划日期、verified→idea 须原因且清除核验、
// used 不可经由 PATCH 触达、转换与状态直改不得混用。
func TestCX13TopicStockTransitionMatrix(t *testing.T) {
	account := env.accounts(t).xhs
	tp := cx13CreateTopic(t, account.ID, "CX13转换矩阵")

	// PATCH 不能触达 used（只由采用事务触发）。
	if st, body, _ := cx13PatchTopic(t, tp.ID, map[string]any{"stock_transition": "used"}); st != 422 || !bytes.Contains(body, []byte("目标无效")) {
		t.Fatalf("PATCH stock_transition=used 必须拒绝: %d %s", st, body)
	}
	// 无意义自转换拒绝（idea 的出边只有 dropped）。
	if st, body, _ := cx13PatchTopic(t, tp.ID, map[string]any{"stock_transition": "idea"}); st != 422 {
		t.Fatalf("idea→idea 必须拒绝: %d %s", st, body)
	}
	// 转换与状态直改混用拒绝。
	if st, body, _ := cx13PatchTopic(t, tp.ID, map[string]any{"stock_transition": "dropped", "status": "dropped"}); st != 422 || !bytes.Contains(body, []byte("混用")) {
		t.Fatalf("混用必须拒绝: %d %s", st, body)
	}

	// idea→dropped，status 同步 dropped。
	if st, body, got := cx13PatchTopic(t, tp.ID, map[string]any{"stock_transition": "dropped", "reason": "不符合近期定位"}); st != 200 {
		t.Fatalf("idea→dropped: %d %s", st, body)
	} else if got.StockStatus != "dropped" || got.Status != "dropped" || got.StockReason != "不符合近期定位" {
		t.Fatalf("dropped 同步: stock=%s status=%s reason=%s", got.StockStatus, got.Status, got.StockReason)
	}

	// dropped→idea 显式恢复，status 回 pending。
	if st, body, got := cx13PatchTopic(t, tp.ID, map[string]any{"stock_transition": "idea"}); st != 200 {
		t.Fatalf("dropped→idea: %d %s", st, body)
	} else if got.StockStatus != "idea" || got.Status != "pending" {
		t.Fatalf("恢复: stock=%s status=%s", got.StockStatus, got.Status)
	}

	// 核验后 verified→ready 缺计划日期拒绝；带日期通过并同步 status=pending。
	if st, body := cx13Verify(t, tp.ID, cx13VerifyNote(30)); st != 200 {
		t.Fatalf("恢复后核验: %d %s", st, body)
	}
	if st, body, _ := cx13PatchTopic(t, tp.ID, map[string]any{"stock_transition": "ready"}); st != 422 || !bytes.Contains(body, []byte("计划日期")) {
		t.Fatalf("verified→ready 缺计划日期必须拒绝: %d %s", st, body)
	}
	if st, body, got := cx13PatchTopic(t, tp.ID, map[string]any{"stock_transition": "ready", "planned_date": "2030-01-02"}); st != 200 {
		t.Fatalf("verified→ready: %d %s", st, body)
	} else if got.StockStatus != "ready" || got.PlannedDate == nil || *got.PlannedDate != "2030-01-02" || got.Status != "pending" {
		t.Fatalf("ready 落库: stock=%s planned=%v status=%s", got.StockStatus, got.PlannedDate, got.Status)
	}

	// ready→verified 取消排期：保留核验记录，清计划日期。
	if st, body, got := cx13PatchTopic(t, tp.ID, map[string]any{"stock_transition": "verified", "reason": "排期调整"}); st != 200 {
		t.Fatalf("ready→verified: %d %s", st, body)
	} else if got.StockStatus != "verified" || got.PlannedDate != nil || got.VerifiedAt == nil {
		t.Fatalf("取消排期保留核验: stock=%s planned=%v verified=%v", got.StockStatus, got.PlannedDate, got.VerifiedAt)
	}

	// verified→idea 退回：缺原因拒绝；带原因清除全部核验痕迹。
	if st, body, _ := cx13PatchTopic(t, tp.ID, map[string]any{"stock_transition": "idea"}); st != 422 || !bytes.Contains(body, []byte("原因")) {
		t.Fatalf("verified→idea 缺原因必须拒绝: %d %s", st, body)
	}
	if st, body, got := cx13PatchTopic(t, tp.ID, map[string]any{"stock_transition": "idea", "reason": "核验后判断不再值得写"}); st != 200 {
		t.Fatalf("verified→idea: %d %s", st, body)
	} else if got.StockStatus != "idea" || got.VerifiedAt != nil || got.VerifyNote != "" || got.PlannedDate != nil || got.Status != "pending" {
		t.Fatalf("退回后核验痕迹必须清除: stock=%s verified=%v note=%q planned=%v status=%s",
			got.StockStatus, got.VerifiedAt, got.VerifyNote, got.PlannedDate, got.Status)
	}
}

// 状态直改与库存同步（旧客户端兼容路径）：dropped 与 adopted 的历史事实不被伪造。
func TestCX13TopicStockStatusDirectSync(t *testing.T) {
	account := env.accounts(t).xhs
	tp := cx13CreateTopic(t, account.ID, "CX13状态直改同步")

	// status=dropped 走同一服务校验，库存同步 dropped。
	if st, body, got := cx13PatchTopic(t, tp.ID, map[string]any{"status": "dropped"}); st != 200 {
		t.Fatalf("status→dropped: %d %s", st, body)
	} else if got.StockStatus != "dropped" || got.Status != "dropped" {
		t.Fatalf("status=dropped 应同步库存: stock=%s status=%s", got.StockStatus, got.Status)
	}

	// dropped 不能直改 adopted / pending。
	if st, body, _ := cx13PatchTopic(t, tp.ID, map[string]any{"status": "adopted"}); st != 422 || !bytes.Contains(body, []byte("先恢复为想法")) {
		t.Fatalf("dropped→adopted 必须拒绝: %d %s", st, body)
	}
	if st, body, _ := cx13PatchTopic(t, tp.ID, map[string]any{"status": "pending"}); st != 422 || !bytes.Contains(body, []byte("显式恢复")) {
		t.Fatalf("dropped→pending 必须拒绝: %d %s", st, body)
	}

	// dropped 不能直接建作品。
	if st, body := cx13StartWork(t, tp.ID); st != 422 || !bytes.Contains(body, []byte("恢复为想法")) {
		t.Fatalf("dropped 建作品必须拒绝: %d %s", st, body)
	}

	// 显式恢复后采用路径畅通。
	if st, body, _ := cx13PatchTopic(t, tp.ID, map[string]any{"stock_transition": "idea"}); st != 200 {
		t.Fatalf("恢复: %d %s", st, body)
	}
	wk := cx13StartWorkOK(t, tp.ID)
	stock, usedAt, _ := cx13ReadStock(t, tp.ID)
	if stock != "used" || usedAt == nil {
		t.Fatalf("采用后库存: stock=%s used_at=%v", stock, usedAt)
	}
	var final struct {
		Topic Topic `json:"topic"`
	}
	env.mustJSON(t, "PATCH", "/api/v1/topics/"+tp.ID.String(), map[string]any{}, &final)
	if final.Topic.Status != "adopted" {
		t.Fatalf("status 应 adopted: %s", final.Topic.Status)
	}
	if final.Topic.WorkID == nil || *final.Topic.WorkID != wk.ID {
		t.Fatalf("topic.work_id 应指向新作品: %v want %s", final.Topic.WorkID, wk.ID)
	}
}

// 水位统计：effective_ready 排除过期核验；周转天数取真实样本均值；
// 采用率排除缺 used_at 的历史采用并计数（不伪造）。
func TestCX13TopicStockWaterline(t *testing.T) {
	var acc Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{"platform": "xhs", "name": "CX13水位统计专用", "content_format": "image_note"}, &acc)
	ctx := t.Context()

	// verified/used 距今天数，-1 表示 NULL。
	seed := []struct {
		stock, status   string
		verifiedDaysAgo int
		usedDaysAgo     int
	}{
		{"ready", "pending", 10, -1},
		{"ready", "pending", 12, -1},
		{"ready", "pending", 20, -1},
		{"ready", "pending", 61, -1}, // 过期核验 → stale
		{"used", "adopted", 3, 0},    // 周转 3 天
		{"used", "adopted", 7, 0},    // 周转 7 天
		{"used", "adopted", -1, -1},  // 迁移历史采用：缺 used_at
		{"dropped", "dropped", -1, -1},
		{"idea", "pending", -1, -1},
	}
	for i, s := range seed {
		verified, used := "NULL", "NULL"
		if s.verifiedDaysAgo >= 0 {
			verified = "now() - interval '" + strconv.Itoa(s.verifiedDaysAgo) + " days'"
		}
		if s.usedDaysAgo >= 0 {
			used = "now() - interval '" + strconv.Itoa(s.usedDaysAgo) + " days'"
		}
		changed := "NULL"
		if s.stock == "dropped" {
			changed = "now()"
		}
		sql := `INSERT INTO topic (account_id, title, source, status, stock_status, verified_at, used_at, stock_changed_at)
			VALUES ($1, $2, 'manual', $3, $4, ` + verified + `, ` + used + `, ` + changed + `)`
		if _, err := env.srv.db.Exec(ctx, sql, acc.ID, "CX13水位样本"+strconv.Itoa(i), s.status, s.stock); err != nil {
			t.Fatalf("seed %d: %v", i, err)
		}
	}

	var sum topicStockSummary
	env.mustJSON(t, "GET", "/api/v1/accounts/"+acc.ID.String()+"/topic-stock", nil, &sum)
	if sum.Counts["ready"] != 4 || sum.Counts["used"] != 3 || sum.Counts["dropped"] != 1 || sum.Counts["idea"] != 1 {
		t.Fatalf("counts: %+v", sum.Counts)
	}
	if sum.StaleReady != 1 || sum.EffectiveReady != 3 {
		t.Fatalf("stale/effective: %d/%d", sum.StaleReady, sum.EffectiveReady)
	}
	if sum.Target != 12 || sum.Warn != 6 {
		t.Fatalf("默认水位: target=%d warn=%d", sum.Target, sum.Warn)
	}
	if sum.NeedRefill != 9 {
		t.Fatalf("need_refill=12-3 应为 9: %d", sum.NeedRefill)
	}
	if sum.TurnoverDays == nil || math.Abs(*sum.TurnoverDays-5.0) > 1e-6 {
		t.Fatalf("周转天数 3+7 均值应为 5: %v", sum.TurnoverDays)
	}
	if sum.AdoptionRate == nil || math.Abs(*sum.AdoptionRate-2.0/3.0) > 1e-6 {
		t.Fatalf("采用率 2/(2+1) 应为 0.6667: %v", sum.AdoptionRate)
	}
	if sum.SampleCount != 3 || sum.ExcludedCount != 1 {
		t.Fatalf("样本/排除: %d/%d", sum.SampleCount, sum.ExcludedCount)
	}
}

// 库存水位配置：owner 专属，1 ≤ warn ≤ target ≤ 100，配置后生效。
func TestCX13TopicStockPolicy(t *testing.T) {
	var acc Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{"platform": "xhs", "name": "CX13策略专用", "content_format": "image_note"}, &acc)
	path := "/api/v1/accounts/" + acc.ID.String() + "/profile"

	var profile Profile
	env.mustJSON(t, "GET", path, nil, &profile)
	if profile.TopicStockPolicy != nil {
		t.Fatalf("新账号不应有库存配置: %+v", profile.TopicStockPolicy)
	}

	put := func(policy map[string]int) (int, []byte) {
		t.Helper()
		in := map[string]any{}
		if policy != nil {
			in["topic_stock_policy"] = policy
		}
		return env.do("PUT", path, in)
	}

	// 合法配置写入并回读。
	if st, body := put(map[string]int{"target_ready": 20, "warn_ready": 8}); st != 200 {
		t.Fatalf("合法配置: %d %s", st, body)
	}
	var after Profile
	env.mustJSON(t, "GET", path, nil, &after)
	if after.TopicStockPolicy == nil || after.TopicStockPolicy.TargetReady != 20 || after.TopicStockPolicy.WarnReady != 8 {
		t.Fatalf("配置回读: %+v", after.TopicStockPolicy)
	}
	var sum topicStockSummary
	env.mustJSON(t, "GET", "/api/v1/accounts/"+acc.ID.String()+"/topic-stock", nil, &sum)
	if sum.Target != 20 || sum.Warn != 8 {
		t.Fatalf("水位应用配置: target=%d warn=%d", sum.Target, sum.Warn)
	}

	// 边界：warn==target 合法；越界全部拒绝。
	if st, _ := put(map[string]int{"target_ready": 6, "warn_ready": 6}); st != 200 {
		t.Fatalf("warn==target 应合法")
	}
	if st, _ := put(map[string]int{"target_ready": 1, "warn_ready": 1}); st != 200 {
		t.Fatalf("下界 1 应合法")
	}
	for _, bad := range []map[string]int{
		{"target_ready": 101, "warn_ready": 6},
		{"target_ready": 5, "warn_ready": 6},
		{"target_ready": 6, "warn_ready": 0},
		{"target_ready": 0, "warn_ready": 0},
	} {
		if st, body := put(bad); st != 422 {
			t.Fatalf("非法配置 %v 必须拒绝: %d %s", bad, st, body)
		}
	}

	// editor 不能改库存水位配置（owner 专属），普通档案字段不受限。
	var inv struct {
		Code string `json:"code"`
	}
	env.mustJSON(t, "POST", "/api/v1/workspaces/current/invites", map[string]any{"role": "editor", "max_uses": 1, "days": 1}, &inv)
	editor := env.registerClient(t, "cx13-editor", testPassword)
	defer editor.restore(env)
	if st, body := editor.do("POST", "/api/v1/workspaces/join", map[string]any{"code": inv.Code, "switch": true}); st != 200 {
		t.Fatalf("join: %d %s", st, body)
	}
	var me struct {
		CSRF string `json:"csrf_token"`
	}
	editor.mustJSON(t, "GET", "/api/v1/auth/me", nil, &me)
	editor.csrf = me.CSRF
	editor.mustJSON(t, "POST", "/api/v1/auth/reauth", map[string]string{"password": testPassword}, nil)
	editor.mustJSON(t, "GET", "/api/v1/auth/me", nil, &me)
	editor.csrf = me.CSRF

	if st, body := editor.do("PUT", path, map[string]any{"topic_stock_policy": map[string]int{"target_ready": 10, "warn_ready": 5}}); st != 403 || !bytes.Contains(body, []byte("owner")) {
		t.Fatalf("editor 改水位配置必须 403: %d %s", st, body)
	}
	var editorProfile Profile
	editor.mustJSON(t, "GET", path, nil, &editorProfile)
	editorProfile.TargetAudience = "档案往返保存"
	if st, body := editor.do("PUT", path, editorProfile); st != 200 {
		t.Fatalf("editor 原样回传库存配置时应能保存档案: %d %s", st, body)
	}
	// editor 不带 policy 的普通档案更新不受影响。
	if st, body := editor.do("PUT", path, map[string]any{"target_audience": "关注效率的创作者"}); st != 200 {
		t.Fatalf("editor 普通档案: %d %s", st, body)
	}
	var final Profile
	env.mustJSON(t, "GET", path, nil, &final)
	if final.TargetAudience != "关注效率的创作者" {
		t.Fatalf("普通档案应被 editor 更新: %q", final.TargetAudience)
	}
	// editor 的普通档案更新不得清除或篡改 owner 已配置的库存水位（无 policy 分支不动该列）。
	if final.TopicStockPolicy == nil || final.TopicStockPolicy.TargetReady != 1 || final.TopicStockPolicy.WarnReady != 1 {
		t.Fatalf("owner 配置必须原样保留: %+v", final.TopicStockPolicy)
	}
}
