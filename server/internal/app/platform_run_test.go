package app

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
)

// DEV-PS07 定向测试：任务与幂等入站（20 文档 §10、§11.3、§12）。
// 覆盖 PS-T23、T28、T29、T30、T31、T42、T43、T53。全部使用伪造的平台身份与虚构编号。

// platformRunFixture 是一套「账号 + 连接 + 已绑定作品」的完整前置条件。
type platformRunFixture struct {
	Account    Account
	Workspace  uuid.UUID
	UserID     uuid.UUID
	DeviceID   uuid.UUID
	PrivateKey ed25519.PrivateKey
	Connection uuid.UUID
}

// newPlatformRunFixture 直接落库建连接（绕过 HTTP 握手），只让被测的任务路径走真实代码。
func newPlatformRunFixture(t *testing.T, platform, externalKey string) *platformRunFixture {
	t.Helper()
	oldLocation := env.srv.loc
	localHourOffset := (10 - env.srv.now().UTC().Hour()) * 60 * 60
	env.srv.loc = time.FixedZone("platform-run-test", localHourOffset)
	t.Cleanup(func() { env.srv.loc = oldLocation })
	a := platformTestAccount(t, platform, "任务验收号 "+uuid.New().String()[:8])
	wsID := accountWorkspace(t, a.ID)
	userID := workspaceOwner(t, wsID)

	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	deviceID := uuid.New()
	if _, err := env.srv.db.Exec(context.Background(), `INSERT INTO desktop_device
		(id, user_id, public_key, name, platform, version) VALUES ($1,$2,$3,'平台任务测试设备','windows-x64','1.0.0')`,
		deviceID, userID, []byte(pub)); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(context.Background(), `INSERT INTO platform_collection_policy
		(workspace_id, enabled) VALUES ($1,true)
		ON CONFLICT (workspace_id) DO UPDATE SET enabled=true`, wsID); err != nil {
		t.Fatal(err)
	}
	var connID uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(), `INSERT INTO platform_connection
		(workspace_id, account_id, platform, user_id, device_id, external_account_key, state, availability,
		 auto_collect, last_seen_at, capabilities)
		VALUES ($1,$2,$3,$4,$5,$6,'active','ready',true,now(),$7) RETURNING id`,
		wsID, a.ID, platform, userID, deviceID, externalKey,
		[]byte(`{"adapter_version":"fixture-1","mapping_version":1,"browser_version":"155.0.0.0"}`)).Scan(&connID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		bg := context.Background()
		_, _ = env.srv.db.Exec(bg, `DELETE FROM platform_metric_observation WHERE account_id=$1`, a.ID)
		_, _ = env.srv.db.Exec(bg, `DELETE FROM platform_sync_run WHERE connection_id=$1`, connID)
		_, _ = env.srv.db.Exec(bg, `DELETE FROM platform_connection WHERE id=$1`, connID)
		_, _ = env.srv.db.Exec(bg, `DELETE FROM desktop_device WHERE id=$1`, deviceID)
		_, _ = env.srv.db.Exec(bg, `DELETE FROM platform_collection_policy WHERE workspace_id=$1`, wsID)
	})
	withDesktopPlatformEnabled(t, true)
	return &platformRunFixture{
		Account: a, Workspace: wsID, UserID: userID, DeviceID: deviceID,
		PrivateKey: priv, Connection: connID,
	}
}

// bindWork 让作品进入「已精确绑定」状态，使调度器愿意把它当作目标。
func (f *platformRunFixture) bindWork(t *testing.T, title, externalID string) Work {
	t.Helper()
	pub := env.srv.today().AddDate(0, 0, -1).Add(20 * time.Hour)
	wk := drWork(t, f.Account, title, "published", &pub)
	column := "wechat_msgid"
	if f.Account.Platform == "xhs" {
		column = "xhs_note_id"
	}
	if _, err := env.srv.db.Exec(context.Background(), `UPDATE work SET `+column+`=$2,
		platform_binding_source='user_link', platform_binding_verified_at=now() WHERE id=$1`,
		wk.ID, externalID); err != nil {
		t.Fatal(err)
	}
	return wk
}

// signedPlatform 用当前会话与设备发起一次带证明的平台请求。
func (f *platformRunFixture) signedPlatform(t *testing.T, operation, method, path string, body []byte) (int, []byte) {
	t.Helper()
	sum := sha256.Sum256(body)
	in := map[string]any{
		"device_id": f.DeviceID, "operation": operation, "method": method, "path": path,
		"body_sha256": fmt.Sprintf("%x", sum[:]),
	}
	st, resp := env.do("POST", "/api/v1/desktop/challenges", in)
	if st != http.StatusOK {
		t.Fatalf("challenge %s: %d %s", operation, st, resp)
	}
	var out struct {
		ChallengeID string `json:"challenge_id"`
		Payload     string `json:"payload"`
		Signature   string `json:"signature_payload"`
	}
	if err := json.Unmarshal(resp, &out); err != nil {
		t.Fatal(err)
	}
	payload, err := base64.StdEncoding.DecodeString(out.Signature)
	if err != nil {
		t.Fatal(err)
	}
	return xpDoRaw(t, env.client, env.csrf, method, path, body, map[string]string{
		"X-OPS-Desktop-Device":    f.DeviceID.String(),
		"X-OPS-Desktop-Challenge": out.ChallengeID,
		"X-OPS-Desktop-Signature": base64.StdEncoding.EncodeToString(ed25519.Sign(f.PrivateKey, payload)),
	})
}

// claim 领取一条 run 并返回其 ID 与租约版本；没有任务时返回 ok=false。
func (f *platformRunFixture) claim(t *testing.T) (runID uuid.UUID, generation int64, ok bool) {
	t.Helper()
	st, resp := f.signedPlatform(t, "platform.run.claim", http.MethodPost,
		"/api/v1/desktop/platform/runs/claim", []byte(`{}`))
	if st != http.StatusOK {
		t.Fatalf("claim: %d %s", st, resp)
	}
	var out struct {
		Run *struct {
			ID              uuid.UUID `json:"id"`
			LeaseGeneration int64     `json:"lease_generation"`
			AccountID       uuid.UUID `json:"account_id"`
			Platform        string    `json:"platform"`
			TaskKind        string    `json:"task_kind"`
			BindingSnapshot []struct {
				ExternalID      string `json:"external_id"`
				BindingRevision int    `json:"binding_revision"`
				PublishRevision int    `json:"publish_revision"`
			} `json:"binding_snapshot"`
		} `json:"run"`
	}
	if err := json.Unmarshal(resp, &out); err != nil {
		t.Fatal(err)
	}
	if out.Run == nil {
		return uuid.Nil, 0, false
	}
	return out.Run.ID, out.Run.LeaseGeneration, true
}

// TestPlatformRunManualTriggerIsSingleAndIdempotent 对应 PS-T42 的 manual 部分：
// 手动采集只建一条待办，已有未结束任务时 409，且不代替 owner 开启自动采用。
func TestPlatformRunManualTriggerIsSingleAndIdempotent(t *testing.T) {
	f := newPlatformRunFixture(t, "xhs", "xhs_user_id:fixture-self")
	f.bindWork(t, "手动采集样本", "6f0000000000000000000001")

	path := "/api/v1/accounts/" + f.Account.ID.String() + "/platform-sync"
	var first struct {
		RunID  uuid.UUID `json:"run_id"`
		Status string    `json:"status"`
	}
	env.mustJSON(t, "POST", path, nil, &first)
	if first.RunID == uuid.Nil || first.Status != platformRunStatusQueued {
		t.Fatalf("手动采集应建一条 queued 任务：%+v", first)
	}
	// 已有未结束任务时再点一次必须 409，不排队堆积。
	env.expectErr(t, "POST", path, nil, "platform_result_conflict")

	// 不因为手动采集而开启自动采用。
	var autoAdopt bool
	if err := env.srv.db.QueryRow(context.Background(), `SELECT auto_adopt FROM platform_connection WHERE id=$1`,
		f.Connection).Scan(&autoAdopt); err != nil {
		t.Fatal(err)
	}
	if autoAdopt {
		t.Fatal("手动采集不得开启 auto_adopt")
	}
}

// TestPlatformRunNonHolderCannotTriggerCollect 对应 PS-T54 的保管人限制：
// owner 也不能替别人保管的连接发起手动采集。
func TestPlatformRunNonHolderCannotTriggerCollect(t *testing.T) {
	f := newPlatformRunFixture(t, "xhs", "xhs_user_id:fixture-self")
	// 把连接改为由另一位成员保管。
	other := env.registerClient(t, "holder-"+uuid.New().String()[:8], testPassword)
	var otherMe struct {
		UserID string `json:"user_id"`
	}
	other.mustJSON(t, "GET", "/api/v1/auth/me", nil, &otherMe)
	other.restore(env)
	otherID, err := uuid.Parse(otherMe.UserID)
	if err != nil {
		t.Fatal(err)
	}
	// 设备的保管人与连接保管人必须一致，因此换一台属于新保管人的设备。
	otherDevice := platformTestDevice(t, otherID)
	if _, err := env.srv.db.Exec(context.Background(), `UPDATE platform_connection
		SET user_id=$2, device_id=$3 WHERE id=$1`, f.Connection, otherID, otherDevice); err != nil {
		t.Fatal(err)
	}
	env.expectErr(t, "POST", "/api/v1/accounts/"+f.Account.ID.String()+"/platform-sync", nil, "platform_not_holder")
}

// TestPlatformRunClaimLeaseAndResult 是主链路：调度建单 → 领取 → 提交终批 → 回执与连接状态。
func TestPlatformRunClaimLeaseAndResult(t *testing.T) {
	f := newPlatformRunFixture(t, "xhs", "xhs_user_id:fixture-self")
	wk := f.bindWork(t, "主链路样本", "6f0000000000000000000002")
	connRev := connectionAuthRevision(t, f.Connection)
	bindingRev, publishRev := workRevisions(t, wk.ID)

	// 调度：处于日常窗口内时按需建单。
	env.srv.schedulePlatformRuns(context.Background())
	runID, generation, ok := f.claim(t)
	if !ok {
		t.Fatal("调度后应能领到一条任务")
	}

	body := map[string]any{
		"protocol_version":       desktopPlatformProtocolVersion,
		"lease_generation":       generation,
		"authorization_revision": connRev,
		"batch_seq":              0,
		"final_batch":            true,
		"run_status":             platformRunStatusSuccess,
		"coverage":               map[string]any{"pages_read": 1, "has_more": false, "details_attempted": 1},
		"observations": []map[string]any{{
			"row_no": 0, "scope": "work", "external_account_key": "xhs_user_id:fixture-self",
			"external_id":      "6f0000000000000000000002",
			"binding_revision": bindingRev, "publish_revision": publishRev,
			"source": "xhs_browser", "temporal_kind": "cumulative",
			"observed_at":     time.Now().UTC().Format(time.RFC3339),
			"as_of_at":        time.Now().UTC().Truncate(time.Second).Format(time.RFC3339),
			"adapter_version": "fixture-1", "mapping_version": 1,
			"values":      map[string]any{"view_times": map[string]any{"value": 320, "precision": "exact", "unit": "times"}},
			"field_paths": map[string]any{"view_times": "fixture.note.view_count"},
		}},
	}
	raw, _ := json.Marshal(body)
	path := "/api/v1/desktop/platform/runs/" + runID.String() + "/results"
	st, resp := f.signedPlatform(t, "platform.run.result", http.MethodPost, path, raw)
	if st != http.StatusOK {
		t.Fatalf("提交终批应成功：%d %s", st, resp)
	}
	var receipt struct {
		Accepted  int    `json:"accepted"`
		RunStatus string `json:"run_status"`
	}
	if err := json.Unmarshal(resp, &receipt); err != nil {
		t.Fatal(err)
	}
	if receipt.Accepted != 1 || receipt.RunStatus != platformRunStatusSuccess {
		t.Fatalf("回执应接收 1 行并置 succeeded：%s", resp)
	}
	// 新来源只写观测，不写正式指标。
	if n := metricCount(t, wk.ID); n != 0 {
		t.Fatalf("观测不应投影正式指标，实际 %d 行", n)
	}
	var obsCount int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM platform_metric_observation WHERE run_id=$1`, runID).Scan(&obsCount); err != nil || obsCount != 1 {
		t.Fatalf("应写入 1 条观测：%d %v", obsCount, err)
	}
	// 成功后连接清零失败计数并顺延下次到期。
	var failureCount int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT failure_count FROM platform_connection WHERE id=$1`, f.Connection).Scan(&failureCount); err != nil || failureCount != 0 {
		t.Fatalf("成功后失败计数应清零：%d %v", failureCount, err)
	}
}

// workspaceOwner 返回工作区的所有者用户，作为「当前登录用户」的稳定替代。
func workspaceOwner(t *testing.T, workspaceID uuid.UUID) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(), `SELECT user_id FROM workspace_member
		WHERE workspace_id=$1 AND role='owner' AND status='active' LIMIT 1`, workspaceID).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

// connectionAuthRevision 读出连接当前授权版本，作为提交时的期望值。
func connectionAuthRevision(t *testing.T, connectionID uuid.UUID) int64 {
	t.Helper()
	var rev int64
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT authorization_revision FROM platform_connection WHERE id=$1`, connectionID).Scan(&rev); err != nil {
		t.Fatal(err)
	}
	return rev
}
