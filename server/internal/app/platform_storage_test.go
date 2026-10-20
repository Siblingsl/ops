package app

import (
	"context"
	"encoding/json"
	"net/http"
	"regexp"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// DEV-PS03 定向测试：存储与绑定（20 文档 §7、§8.1～§8.3、§11.2）。
// 覆盖 PS-T11、PS-T12、PS-T36、PS-T47、PS-T48 与观测去重。所有编号均为虚构。

// platformTestAccount 建一个带可用凭证的账号：公众号同步需要 AppID/AppSecret，否则只测到凭证错误。
func platformTestAccount(t *testing.T, platform, name string) Account {
	t.Helper()
	a := drAccount(t, platform, name)
	if platform == "wechat_mp" {
		env.mustJSON(t, "PUT", "/api/v1/accounts/"+a.ID.String()+"/wechat-credential",
			map[string]string{"app_id": "wx-fixture-app", "app_secret": "fixture-secret-value"}, nil)
		var probe struct {
			OK            bool   `json:"ok"`
			DatacubeState string `json:"datacube_state"`
		}
		env.mustJSON(t, "POST", "/api/v1/accounts/"+a.ID.String()+"/wechat-credential/test", nil, &probe)
		if probe.DatacubeState != "ok" {
			t.Fatalf("测试公众号账号应具备数据接口能力：%+v", probe)
		}
	}
	return a
}

// workRevisions 读取作品的绑定版本与发布修订，用作 CAS 的正确期望值。
func workRevisions(t *testing.T, workID uuid.UUID) (int, int) {
	t.Helper()
	var binding, publish int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT metric_binding_revision, publish_revision FROM work WHERE id=$1`, workID).Scan(&binding, &publish); err != nil {
		t.Fatal(err)
	}
	return binding, publish
}

// TestPlatformBindingRejectsTitleSimilarity 对应 PS-T11：同名/改标题/标点变化都不能自动
// 建立绑定；稳定编号一旦确认，改标题不影响既有绑定。
func TestPlatformBindingRejectsTitleSimilarity(t *testing.T) {
	ctx := context.Background()
	a := platformTestAccount(t, "wechat_mp", "绑定同名验收号")
	pub := env.srv.today().AddDate(0, 0, -2).Add(20 * time.Hour)
	first := drWork(t, a, "同名文章：标题一模一样", "published", &pub)
	second := drWork(t, a, "同名文章：标题一模一样", "published", &pub)
	// 只差标点：规范化后会相等，更不能当作同一篇。
	third := drWork(t, a, "同名文章：标题一模一样！", "published", &pub)

	ref := env.srv.today().AddDate(0, 0, -2)
	env.mockWX.SetArticleTotals(map[string][]map[string]any{ref.Format("2006-01-02"): {
		{"ref_date": ref.Format("2006-01-02"), "msgid": "2247400001_1", "title": "同名文章：标题一模一样", "details": detailRows(ref, 10)},
	}})
	defer env.mockWX.SetArticleTotals(nil)
	env.mustJSON(t, "POST", "/api/v1/accounts/"+a.ID.String()+"/metrics/sync-wechat", nil, nil)

	for _, w := range []Work{first, second, third} {
		var msgid *string
		if err := env.srv.db.QueryRow(ctx, `SELECT wechat_msgid FROM work WHERE id=$1`, w.ID).Scan(&msgid); err != nil {
			t.Fatal(err)
		}
		if msgid != nil {
			t.Fatalf("标题相似的作品 %s 不应被自动写入编号：%s", w.Title, *msgid)
		}
	}
	var pendingCount int
	if err := env.srv.db.QueryRow(ctx, `SELECT count(*) FROM metric_unmatched
		WHERE account_id=$1 AND external_id='2247400001_1' AND status='pending' AND reason='ambiguous'`,
		a.ID).Scan(&pendingCount); err != nil || pendingCount != 1 {
		t.Fatalf("多篇同名应只进入一条待确认（ambiguous）：count=%d err=%v", pendingCount, err)
	}

	// 单篇唯一同名（最容易误配的场景）：即使标题唯一，也不能自动绑定。
	solo := drWork(t, a, "独一份的标题", "published", &pub)
	env.mockWX.SetArticleTotals(map[string][]map[string]any{ref.Format("2006-01-02"): {
		{"ref_date": ref.Format("2006-01-02"), "msgid": "2247400009_1", "title": "独一份的标题", "details": detailRows(ref, 7)},
	}})
	defer env.mockWX.SetArticleTotals(nil)
	env.mustJSON(t, "POST", "/api/v1/accounts/"+a.ID.String()+"/metrics/sync-wechat", nil, nil)
	var soloID *string
	if err := env.srv.db.QueryRow(ctx, `SELECT wechat_msgid FROM work WHERE id=$1`, solo.ID).Scan(&soloID); err != nil {
		t.Fatal(err)
	}
	if soloID != nil {
		t.Fatalf("标题唯一也不能自动绑定，实际写入 %s", *soloID)
	}
	var soloPending string
	if err := env.srv.db.QueryRow(ctx, `SELECT reason FROM metric_unmatched
		WHERE account_id=$1 AND external_id='2247400009_1' AND status='pending'`,
		a.ID).Scan(&soloPending); err != nil || soloPending != "legacy_title" {
		t.Fatalf("单篇同名应进待确认且标 legacy_title：%q err=%v", soloPending, err)
	}
	// 用户逐条确认第一稿后，改标题也不影响已确认的稳定编号。
	bindingRev, publishRev := workRevisions(t, first.ID)
	body, _ := json.Marshal(map[string]any{
		"external_id": "2247400001_1", "metric_binding_revision": bindingRev, "publish_revision": publishRev,
		"binding_source": "user_link",
	})
	st, resp := xpDoRaw(t, env.client, env.csrf, http.MethodPut,
		"/api/v1/works/"+first.ID.String()+"/platform-binding", body, nil)
	if st != 200 {
		t.Fatalf("用户确认编号应成功：%d %s", st, resp)
	}
	env.mustJSON(t, "PATCH", "/api/v1/works/"+first.ID.String(), map[string]string{"title": "改名之后的新标题"}, nil)
	var bound struct {
		ExternalID            *string `json:"external_id"`
		PlatformBindingSource *string `json:"platform_binding_source"`
		MetricBindingRevision int     `json:"metric_binding_revision"`
	}
	env.mustJSON(t, "GET", "/api/v1/works/"+first.ID.String(), nil, &bound)
	if bound.ExternalID == nil || *bound.ExternalID != "2247400001_1" {
		t.Fatalf("改标题不应影响已确认的编号：%+v", bound)
	}
	if bound.PlatformBindingSource == nil || *bound.PlatformBindingSource != bindingSourceUserLink {
		t.Fatalf("绑定来源应保留用户确认：%+v", bound)
	}
	if bound.MetricBindingRevision != 2 {
		t.Fatalf("确认绑定应递增 metric_binding_revision，实际 %d", bound.MetricBindingRevision)
	}
}

// TestPlatformBindingWechatMultiArticleIndex 对应 PS-T12：同一 mid 的多图文必须按 idx 独立，
// 不能相互覆盖；只给 mid 不带 idx 的编号形态直接拒绝。
func TestPlatformBindingWechatMultiArticleIndex(t *testing.T) {
	a := platformTestAccount(t, "wechat_mp", "多图文验收号")
	pub := env.srv.today().AddDate(0, 0, -1).Add(20 * time.Hour)
	one := drWork(t, a, "多图文第一位置", "published", &pub)
	two := drWork(t, a, "多图文第二位置", "published", &pub)
	three := drWork(t, a, "多图文第二位置的另一篇", "published", &pub)

	bind := func(w Work, externalID string, rev, publishRev int) (int, []byte) {
		body, _ := json.Marshal(map[string]any{
			"external_id": externalID, "metric_binding_revision": rev, "publish_revision": publishRev,
		})
		return xpDoRaw(t, env.client, env.csrf, http.MethodPut,
			"/api/v1/works/"+w.ID.String()+"/platform-binding", body, nil)
	}

	bindRevOne, pubRevOne := workRevisions(t, one.ID)
	bindRevTwo, pubRevTwo := workRevisions(t, two.ID)
	bindRevThree, pubRevThree := workRevisions(t, three.ID)
	// 只给 mid（没有 itemidx）不是稳定编号：发表记录的 msgid 是内部序号，不能当编号。
	if st, resp := bind(one, "2247400002", bindRevOne, pubRevOne); st != http.StatusUnprocessableEntity {
		t.Fatalf("缺少 itemidx 的编号必须拒绝：%d %s", st, resp)
	}
	if st, resp := bind(one, "2247400002_1", bindRevOne, pubRevOne); st != 200 {
		t.Fatalf("第一篇应按 idx=1 绑定：%d %s", st, resp)
	}
	if st, resp := bind(two, "2247400002_2", bindRevTwo, pubRevTwo); st != 200 {
		t.Fatalf("第二篇应按 idx=2 独立绑定：%d %s", st, resp)
	}

	ctx := context.Background()
	var oneID, twoID *string
	if err := env.srv.db.QueryRow(ctx, `SELECT wechat_msgid FROM work WHERE id=$1`, one.ID).Scan(&oneID); err != nil {
		t.Fatal(err)
	}
	if err := env.srv.db.QueryRow(ctx, `SELECT wechat_msgid FROM work WHERE id=$1`, two.ID).Scan(&twoID); err != nil {
		t.Fatal(err)
	}
	if oneID == nil || *oneID != "2247400002_1" || twoID == nil || *twoID != "2247400002_2" {
		t.Fatalf("同 mid 不同 idx 必须各自保留：%v %v", oneID, twoID)
	}

	// 第三篇再绑 idx=2 必须 409 且指出冲突作品，不能静默覆盖。
	st, resp := bind(three, "2247400002_2", bindRevThree, pubRevThree)
	if st != http.StatusConflict {
		t.Fatalf("重复绑定应返回 409：%d %s", st, resp)
	}
	var conflict struct {
		Error struct {
			Code   string `json:"code"`
			Detail struct {
				WorkID uuid.UUID `json:"work_id"`
			} `json:"detail"`
		} `json:"error"`
	}
	if err := json.Unmarshal(resp, &conflict); err != nil {
		t.Fatal(err)
	}
	if conflict.Error.Code != "platform_binding_conflict" || conflict.Error.Detail.WorkID != two.ID {
		t.Fatalf("409 必须带冲突对象摘要：%s", resp)
	}
	// 被拒绝的一方不能被动写入任何编号。
	var threeID *string
	if err := env.srv.db.QueryRow(ctx, `SELECT wechat_msgid FROM work WHERE id=$1`, three.ID).Scan(&threeID); err != nil {
		t.Fatal(err)
	}
	if threeID != nil {
		t.Fatalf("冲突时不得写入编号：%s", *threeID)
	}
}

// TestPlatformBindingRevisionCAS 对应 PS-T47 与 §7.2：改绑/解除都要同时比较绑定版本与发布修订，
// 版本不符返回 409，重复点击同一请求幂等失败而不是悄悄覆盖。
func TestPlatformBindingRevisionCAS(t *testing.T) {
	a := platformTestAccount(t, "xhs", "绑定版本验收号")
	wk := drWork(t, a, "小红书笔记", "published", nil)
	noteID := "6f0000000000000000000abc"

	put := func(externalID string, bindingRev, publishRev int) (int, []byte) {
		body, _ := json.Marshal(map[string]any{
			"external_id": externalID, "metric_binding_revision": bindingRev, "publish_revision": publishRev,
		})
		return xpDoRaw(t, env.client, env.csrf, http.MethodPut,
			"/api/v1/works/"+wk.ID.String()+"/platform-binding", body, nil)
	}
	bindingRev, publishRev := workRevisions(t, wk.ID)
	if st, resp := put(noteID, bindingRev, publishRev); st != 200 {
		t.Fatalf("首次绑定应成功：%d %s", st, resp)
	}
	bindingRev, publishRev = workRevisions(t, wk.ID)
	// 用旧绑定版本再改绑：期间已递增，必须 409。
	if st, resp := put("6f0000000000000000000def", bindingRev-1, publishRev); st != http.StatusConflict {
		t.Fatalf("旧绑定版本改绑应 409：%d %s", st, resp)
	}
	// 发布修订不符同样拒绝。
	if st, resp := put("6f0000000000000000000def", bindingRev, publishRev+99); st != http.StatusConflict {
		t.Fatalf("发布修订不符应 409：%d %s", st, resp)
	}
	// 编号形态错误：不是 24 位十六进制。
	if st, resp := put("not-a-note-id", bindingRev, publishRev); st != http.StatusUnprocessableEntity {
		t.Fatalf("非法小红书编号应 422：%d %s", st, resp)
	}

	// 解除绑定：只清绑定，不删历史指标。
	drMetric(t, wk.ID, "manual", 1, 66)
	bindingRev, publishRev = workRevisions(t, wk.ID)
	body, _ := json.Marshal(map[string]any{"metric_binding_revision": bindingRev, "publish_revision": publishRev})
	if st, resp := xpDoRaw(t, env.client, env.csrf, http.MethodDelete,
		"/api/v1/works/"+wk.ID.String()+"/platform-binding", body, nil); st != 200 {
		t.Fatalf("解除绑定应成功：%d %s", st, resp)
	}
	var ext *string
	if err := env.srv.db.QueryRow(context.Background(), `SELECT xhs_note_id FROM work WHERE id=$1`, wk.ID).Scan(&ext); err != nil {
		t.Fatal(err)
	}
	if ext != nil {
		t.Fatalf("解除后编号应为空：%s", *ext)
	}
	if n := metricCount(t, wk.ID); n == 0 {
		t.Fatal("解除绑定不得删除已有指标")
	}
}

// TestPlatformStorageConstraints 对应 PS-T36：库层约束要能挡住重复编号、重复活动连接与重复活动 run，
// 且账号必须属于同一工作区、平台一致。
func TestPlatformStorageConstraints(t *testing.T) {
	ctx := context.Background()
	a := platformTestAccount(t, "wechat_mp", "存储约束验收号")
	one := drWork(t, a, "约束样本一", "published", nil)
	two := drWork(t, a, "约束样本二", "published", nil)

	if _, err := env.srv.db.Exec(ctx, `UPDATE work SET wechat_msgid='2247401111_1' WHERE id=$1`, one.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(ctx, `UPDATE work SET wechat_msgid='2247401111_1' WHERE id=$1`, two.ID); err == nil {
		t.Fatal("同一账号下重复 wechat_msgid 必须被唯一索引拒绝")
	}

	// 连接：账号必须属于同一工作区且平台一致（复合外键）。
	userID := env.srv.mustUserID(t)
	deviceID := platformTestDevice(t, userID)
	wsID := accountWorkspace(t, a.ID)
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO platform_connection
		(workspace_id, account_id, platform, user_id, device_id, external_account_key)
		VALUES ($1,$2,'xhs',$3,$4,'xhs_user_id:fixture-self')`, wsID, a.ID, userID, deviceID); err == nil {
		t.Fatal("账号平台与连接平台不一致时必须被复合外键拒绝")
	}
	var connID uuid.UUID
	if err := env.srv.db.QueryRow(ctx, `INSERT INTO platform_connection
		(workspace_id, account_id, platform, user_id, device_id, external_account_key, state, availability)
		VALUES ($1,$2,'wechat_mp',$3,$4,'wechat_biz:fixture-self','active','ready') RETURNING id`,
		wsID, a.ID, userID, deviceID).Scan(&connID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(context.Background(), `DELETE FROM platform_connection WHERE id=$1`, connID)
	})
	// 同账号第二条未撤销连接被拒绝（paused 仍占位）。
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO platform_connection
		(workspace_id, account_id, platform, user_id, device_id, external_account_key, state)
		VALUES ($1,$2,'wechat_mp',$3,$4,'wechat_biz:fixture-other','paused')`,
		wsID, a.ID, userID, deviceID); err == nil {
		t.Fatal("同账号已有 paused 连接时再建连接必须被拒绝")
	}
	// 外部账号键必须带身份种类。
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO platform_connection
		(workspace_id, account_id, platform, user_id, device_id, external_account_key)
		VALUES ($1,$2,'xhs',$3,$4,'deadbeef')`, wsID, a.ID, userID, deviceID); err == nil {
		t.Fatal("缺少身份种类的外部账号键必须被拒绝")
	}

	// 同一连接同一时刻只允许一条未结束 run。
	var runID uuid.UUID
	if err := env.srv.db.QueryRow(ctx, `INSERT INTO platform_sync_run
		(connection_id, workspace_id, account_id, trigger, task_kind, authorization_revision,
		 workspace_authorization_revision) VALUES ($1,$2,$3,'daily','collect',1,1) RETURNING id`,
		connID, wsID, a.ID).Scan(&runID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO platform_sync_run
		(connection_id, workspace_id, account_id, trigger, task_kind, authorization_revision,
		 workspace_authorization_revision) VALUES ($1,$2,$3,'manual','collect',1,1)`,
		connID, wsID, a.ID); err == nil {
		t.Fatal("同连接已有未结束 run 时必须拒绝新的 run")
	}
	// 原 run 结束后可以再建。
	if _, err := env.srv.db.Exec(ctx, `UPDATE platform_sync_run SET status='succeeded', finished_at=now() WHERE id=$1`, runID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO platform_sync_run
		(connection_id, workspace_id, account_id, trigger, task_kind, authorization_revision,
		 workspace_authorization_revision) VALUES ($1,$2,$3,'manual','collect',1,1)`,
		connID, wsID, a.ID); err != nil {
		t.Fatalf("前一条 run 结束后应能建新 run：%v", err)
	}
}

// mustUserID 返回当前测试会话的用户 ID。
func (s *Server) mustUserID(t *testing.T) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := s.db.QueryRow(context.Background(), `SELECT user_id FROM session WHERE expires_at > now()
		ORDER BY created_at DESC LIMIT 1`).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

// platformTestDevice 直接登记一台测试设备：存储约束测试只关心外键，不需要走设备证明。
func platformTestDevice(t *testing.T, userID uuid.UUID) uuid.UUID {
	t.Helper()
	deviceID := uuid.New()
	key := make([]byte, 32)
	key[0] = byte(len(t.Name()) % 256)
	if _, err := env.srv.db.Exec(context.Background(), `INSERT INTO desktop_device
		(id, user_id, public_key, name, platform, version) VALUES ($1,$2,$3,'存储约束测试设备','windows-x64','1.0.0')`,
		deviceID, userID, key); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(context.Background(), `DELETE FROM desktop_device WHERE id=$1`, deviceID)
	})
	return deviceID
}

// TestPlatformObservationPayloadHashIgnoresVolatileFields 对应 PS-T23 的存储部分：
// payload_hash 不含 observed_at/row_no/batch_seq，同一数据重复读取必须去重。
func TestPlatformObservationPayloadHashIgnoresVolatileFields(t *testing.T) {
	asOf := time.Date(2026, 10, 20, 10, 4, 0, 0, time.FixedZone("CST", 8*3600))
	base := platformObservationInput{
		Scope: observationScopeWork, ExternalAccountKey: "xhs_user_id:fixture-self",
		ExternalID: ptrString("6f0000000000000000000001"), TemporalKind: observationTemporalCumulative,
		AsOfAt: &asOf, MappingVersion: 1,
		Values: map[string]json.RawMessage{
			"view_times": json.RawMessage(`320`),
			"like_count": json.RawMessage(`0`),
		},
	}
	first, err := observationPayloadHash(base)
	if err != nil {
		t.Fatal(err)
	}
	if !regexp.MustCompile(`^[0-9a-f]{64}$`).MatchString(first) {
		t.Fatalf("payload_hash 必须是 64 位十六进制：%s", first)
	}

	// 读取时刻、行号、批次号、客户端版本都不影响指纹。
	changed := base
	observed := time.Date(2026, 10, 20, 10, 5, 30, 0, time.FixedZone("CST", 8*3600))
	row, batch := 3, 7
	changed.ObservedAt = observed
	changed.RowNo = &row
	changed.BatchSeq = &batch
	changed.AdapterVersion = "xhs-fixture-2"
	second, err := observationPayloadHash(changed)
	if err != nil {
		t.Fatal(err)
	}
	if first != second {
		t.Fatalf("易变字段不应改变 payload_hash：%s vs %s", first, second)
	}

	// 数值写法不同但含义相同：1.0 与 1 必须同哈希。
	numA := base
	numA.Values = map[string]json.RawMessage{"like_count": json.RawMessage(`1.0`)}
	numB := base
	numB.Values = map[string]json.RawMessage{"like_count": json.RawMessage(`1`)}
	hashA, _ := observationPayloadHash(numA)
	hashB, _ := observationPayloadHash(numB)
	if hashA != hashB {
		t.Fatal("同一数值的不同写法必须得到同一指纹")
	}

	// 数值确实不同就必须不同指纹。
	numC := base
	numC.Values = map[string]json.RawMessage{"like_count": json.RawMessage(`2`)}
	hashC, _ := observationPayloadHash(numC)
	if hashC == hashA {
		t.Fatal("不同数值不能共用指纹")
	}

	// 键顺序不影响指纹。
	reordered := base
	reordered.Values = map[string]json.RawMessage{
		"like_count": json.RawMessage(`0`),
		"view_times": json.RawMessage(`320`),
	}
	hashD, _ := observationPayloadHash(reordered)
	if hashD != first {
		t.Fatal("键顺序不应改变指纹")
	}
}

func ptrString(s string) *string { return &s }

// TestPlatformObservationRejectsUnattributedRows 对应 §8.1/§9.2：缺少归属或时间语义不完整的
// 观测整行拒绝，不能写进去再由下游猜。
func TestPlatformObservationRejectsUnattributedRows(t *testing.T) {
	asOf := time.Date(2026, 10, 20, 10, 4, 0, 0, time.UTC)
	cases := map[string]platformObservationInput{
		"作品观测缺外部编号": {Scope: observationScopeWork, Source: "xhs_browser", TemporalKind: observationTemporalCumulative},
		"累计缺截止时点": {Scope: observationScopeWork, Source: "xhs_browser", TemporalKind: observationTemporalCumulative,
			ExternalID: ptrString("6f0000000000000000000002")},
		"未知来源": {Scope: observationScopeWork, Source: "browser", TemporalKind: observationTemporalCumulative,
			ExternalID: ptrString("6f0000000000000000000002"), AsOfAt: &asOf},
		"账号观测带作品匹配状态": {Scope: observationScopeAccount, Source: "wechat_browser",
			TemporalKind: observationTemporalCurrentTotal, MatchState: observationMatchUnmatched, AsOfAt: &asOf},
		"区间起止颠倒": {Scope: observationScopeWork, Source: "wechat_browser", TemporalKind: observationTemporalInterval,
			ExternalID: ptrString("2247400003_1"), WindowStart: &asOf,
			WindowEnd: timePtr(asOf.Add(-time.Hour))},
	}
	for name, in := range cases {
		in.ExternalAccountKey = "xhs_user_id:fixture-self"
		in.MappingVersion = 1
		in.Values = map[string]json.RawMessage{"view_times": json.RawMessage(`1`)}
		if err := validatePlatformObservation(&in); err == nil {
			t.Errorf("%s 应被拒绝", name)
		}
	}
}

func timePtr(t time.Time) *time.Time { return &t }

// TestPlatformBindingRejectsForeignWork 对应 PS-T36 的跨租户部分：他人的作品不能通过
// 绑定接口写入自己的账号编号。
func TestPlatformBindingRejectsForeignWork(t *testing.T) {
	a := platformTestAccount(t, "xhs", "跨租户绑定验收号")
	own := drWork(t, a, "自己的作品", "published", nil)

	guest := env.registerClient(t, "binding-guest-"+uuid.New().String()[:8], testPassword)
	body, _ := json.Marshal(map[string]any{
		"external_id": "6f0000000000000000000fff", "metric_binding_revision": 1, "publish_revision": 1,
	})
	guest.use()
	st, resp := xpDoRaw(t, guest.client, guest.csrf, http.MethodPut,
		"/api/v1/works/"+own.ID.String()+"/platform-binding", body, nil)
	guest.restore(env)
	if st != http.StatusNotFound {
		t.Fatalf("跨租户绑定应按既有 404 语义拒绝：%d %s", st, resp)
	}
	var ext *string
	if err := env.srv.db.QueryRow(context.Background(), `SELECT xhs_note_id FROM work WHERE id=$1`, own.ID).Scan(&ext); err != nil {
		t.Fatal(err)
	}
	if ext != nil {
		t.Fatalf("被拒绝的跨租户请求不得写入编号：%s", *ext)
	}
}

// TestPlatformObservationRunDedupe 对应 §8.1：同一 run 内同一行重复提交判 duplicate，
// 换 batch_seq 重发同一内容也不新增第二条。
func TestPlatformObservationRunDedupe(t *testing.T) {
	ctx := context.Background()
	a := platformTestAccount(t, "xhs", "观测去重验收号")
	userID := env.srv.mustUserID(t)
	deviceID := platformTestDevice(t, userID)
	wsID := accountWorkspace(t, a.ID)
	var connID, runID uuid.UUID
	if err := env.srv.db.QueryRow(ctx, `INSERT INTO platform_connection
		(workspace_id, account_id, platform, user_id, device_id, external_account_key, state, availability)
		VALUES ($1,$2,'xhs',$3,$4,'xhs_user_id:fixture-self','active','ready') RETURNING id`,
		wsID, a.ID, userID, deviceID).Scan(&connID); err != nil {
		t.Fatal(err)
	}
	if err := env.srv.db.QueryRow(ctx, `INSERT INTO platform_sync_run
		(connection_id, workspace_id, account_id, trigger, task_kind, authorization_revision,
		 workspace_authorization_revision) VALUES ($1,$2,$3,'manual','collect',1,1) RETURNING id`,
		connID, wsID, a.ID).Scan(&runID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(context.Background(), `DELETE FROM platform_metric_observation WHERE run_id=$1`, runID)
		_, _ = env.srv.db.Exec(context.Background(), `DELETE FROM platform_sync_run WHERE id=$1`, runID)
		_, _ = env.srv.db.Exec(context.Background(), `DELETE FROM platform_connection WHERE id=$1`, connID)
	})

	asOf := time.Date(2026, 10, 20, 10, 4, 0, 0, time.UTC)
	observed := time.Date(2026, 10, 20, 10, 5, 0, 0, time.UTC)
	seq, row := 0, 0
	in := platformObservationInput{
		RunID: &runID, BatchSeq: &seq, RowNo: &row,
		WorkspaceID: wsID, AccountID: a.ID, ExternalAccountKey: "xhs_user_id:fixture-self",
		ExternalID: ptrString("6f0000000000000000000001"), Scope: observationScopeWork,
		Source: "xhs_browser", TemporalKind: observationTemporalCumulative,
		ObservedAt: observed, AsOfAt: &asOf, MappingVersion: 1,
		Values:     map[string]json.RawMessage{"view_times": json.RawMessage(`320`)},
		FieldPaths: map[string]string{"view_times": "fixture.note.view_count"},
	}

	var firstID uuid.UUID
	var duplicated bool
	err := env.srv.withTx(ctx, func(tx pgx.Tx) error {
		var e error
		firstID, duplicated, e = insertPlatformObservation(ctx, tx, in)
		return e
	})
	if err != nil || duplicated {
		t.Fatalf("首次写入应成功且不是重复：%v dup=%v", err, duplicated)
	}

	// 同一行再发一次：duplicate，不新增。
	err = env.srv.withTx(ctx, func(tx pgx.Tx) error {
		var e error
		var dup bool
		var id uuid.UUID
		id, dup, e = insertPlatformObservation(ctx, tx, in)
		if e == nil && (!dup || id != firstID) {
			t.Fatalf("同位置重发应判 duplicate 并回原行：dup=%v id=%s", dup, id)
		}
		return e
	})
	if err != nil {
		t.Fatal(err)
	}

	// 换 batch_seq 重发同一内容：仍按 payload_hash 去重。
	nextSeq, nextRow := 1, 0
	same := in
	same.BatchSeq, same.RowNo = &nextSeq, &nextRow
	err = env.srv.withTx(ctx, func(tx pgx.Tx) error {
		var e error
		var dup bool
		_, dup, e = insertPlatformObservation(ctx, tx, same)
		if e == nil && !dup {
			t.Fatal("换 batch_seq 重发同一内容必须判 duplicate")
		}
		return e
	})
	if err != nil {
		t.Fatal(err)
	}

	var count int
	if err := env.srv.db.QueryRow(ctx, `SELECT count(*) FROM platform_metric_observation WHERE run_id=$1`, runID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("同一内容只应有一条观测，实际 %d", count)
	}
	// 观测不进入正式指标。
	if n := metricCount(t, uuid.Nil); n != 0 {
		t.Fatalf("观测不应写入正式指标，%d", n)
	}
}

// accountWorkspace 从账号行读工作区，避免依赖“当前会话”而取错租户。
func accountWorkspace(t *testing.T, accountID uuid.UUID) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT workspace_id FROM platform_account WHERE id=$1`, accountID).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}
