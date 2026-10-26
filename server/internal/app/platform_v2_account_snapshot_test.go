package app

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"
)

// accountSnapshotBatch 造一批 account_snapshot 结果。
//
// profile 阶段只收 account_snapshot 与 control，且 account_snapshot 的行数上限是 1，
// 所以这里没有"一批多行"的形态——它的失败粒度是整批，而不是行。
func accountSnapshotBatch(run platformV2TestRun, seq int, data map[string]any) map[string]any {
	return map[string]any{
		"protocol_version": 2, "lease_generation": run.LeaseGeneration,
		"authorization_revision": run.AuthorizationRevision, "batch_seq": seq, "final_batch": false,
		"run_status": "succeeded", "result_type": "account_snapshot", "data": data,
	}
}

// startProfileStageFixture 把一条 account_sync 操作推进到 profile 阶段并领到 run。
//
// 复用 startMetricsStageFixture 建操作与调度，只是这里停在 profile 领单状态：
// account_snapshot 只在这个阶段被接受。
func startProfileStageFixture(t *testing.T) (*platformRunFixture, platformV2TestRun) {
	t.Helper()
	f := startMetricsStageFixture(t, `{"adapterVersion":"fixture-1","mappingVersion":1,`+
		`"browserVersion":"155.0.0.0","workList":"supported","perNoteMetrics":"unknown","noteContent":"unsupported"}`)
	profile := claimPlatformV2Run(t, f, "account_sync", "fixture-1")
	if profile.Stage != "profile" {
		t.Fatalf("initial stage must be profile, got %q", profile.Stage)
	}
	return f, profile
}

// snapshotData 造一份最小可用的平台资料观测。
func snapshotData(externalKey string, observedAt time.Time) map[string]any {
	return map[string]any{
		"identity_external_account_key": externalKey,
		"display_name":                  "巡检号",
		"field_states":                  map[string]string{"display_name": "present", "bio": "unknown"},
		"observed_at":                   observedAt,
	}
}

func accountSnapshotCount(t *testing.T, f *platformRunFixture) int {
	t.Helper()
	var count int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM platform_account_snapshot WHERE account_id=$1`, f.Account.ID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

// TestPlatformV2AccountSnapshotRejectsPresentFieldWithoutValue 验证：field_states 声明
// present 却没有对应值时，整批被 422 拒绝、一行都不写，且这次 run 仍然可用——
// 客户端改正后还能在同一 run 里补交。
//
// 为什么重要：account_snapshot 没有 SAVEPOINT，失败粒度是整批。若拒绝之后 run 也废了，
// 用户就只能等下一次同步；这条测试钉住"拒绝是局部的、可重试的"。
func TestPlatformV2AccountSnapshotRejectsPresentFieldWithoutValue(t *testing.T) {
	f, profile := startProfileStageFixture(t)

	broken := snapshotData(f.ExternalKey(), time.Now().UTC())
	delete(broken, "display_name")
	status, response := submitV2BatchRaw(t, f, profile.ID, accountSnapshotBatch(profile, 0, broken))
	if status != http.StatusUnprocessableEntity {
		t.Fatalf("present 但没有值的字段必须被拒: %d %s", status, response)
	}
	if code := apiCode(response); code != "validation_failed" {
		t.Fatalf("expected validation_failed, got %q body=%s", code, response)
	}
	if !strings.Contains(string(response), "资料声明 present 但缺少字段值") {
		t.Fatalf("拒绝原因必须说明是 present 缺值: %s", response)
	}
	if count := accountSnapshotCount(t, f); count != 0 {
		t.Fatalf("被拒的批次不能写进资料快照，实际写了 %d 行", count)
	}

	// 同一个 run 里补交正确的一批：拒绝只影响那一批。
	submitPlatformV2Batch(t, f, profile.ID, accountSnapshotBatch(profile, 1, snapshotData(f.ExternalKey(), time.Now().UTC())))
	submitPlatformV2Batch(t, f, profile.ID, platformV2ControlBatch(profile, 2, "complete", nil, "succeeded"))

	var displayName string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT display_name FROM platform_account_snapshot WHERE account_id=$1`, f.Account.ID).Scan(&displayName); err != nil {
		t.Fatalf("改正后的批次必须写进资料快照: %v", err)
	}
	if displayName != "巡检号" {
		t.Fatalf("display_name 不符: %q", displayName)
	}
}

// TestPlatformV2AccountSnapshotRejectsForeignIdentity 验证：资料里的主体键与已核验连接
// 不一致时返回 409 platform_identity_mismatch，且不落库。
//
// 这是"平台页面切到了另一个账号"的兜底：宁可整批拒绝，也不能把别人的资料写进来。
func TestPlatformV2AccountSnapshotRejectsForeignIdentity(t *testing.T) {
	f, profile := startProfileStageFixture(t)

	status, response := submitV2BatchRaw(t, f, profile.ID,
		accountSnapshotBatch(profile, 0, snapshotData("xhs_user_id:someone-else", time.Now().UTC())))
	if status != http.StatusConflict {
		t.Fatalf("主体不一致必须 409: %d %s", status, response)
	}
	if code := apiCode(response); code != "platform_identity_mismatch" {
		t.Fatalf("expected platform_identity_mismatch, got %q body=%s", code, response)
	}
	if count := accountSnapshotCount(t, f); count != 0 {
		t.Fatalf("主体不一致的批次不能落库，实际写了 %d 行", count)
	}

	submitPlatformV2Batch(t, f, profile.ID, accountSnapshotBatch(profile, 1, snapshotData(f.ExternalKey(), time.Now().UTC())))
	if count := accountSnapshotCount(t, f); count != 1 {
		t.Fatalf("改正主体后必须能写进快照，实际 %d 行", count)
	}
}

// TestPlatformV2AccountSnapshotKeepsNewestObservation 验证：资料快照按 observed_at
// 单调合并——更旧的观测不能覆盖更新的值，也不能把 revision 往前推。
//
// 这条合并逻辑写在 ON CONFLICT 的 CASE 里，一旦写错就会让"平台页面上的旧缓存"
// 覆盖掉刚读到的新资料，而且不会报任何错。
func TestPlatformV2AccountSnapshotKeepsNewestObservation(t *testing.T) {
	f, profile := startProfileStageFixture(t)
	key := f.ExternalKey()
	now := time.Now().UTC().Truncate(time.Second)

	newer := snapshotData(key, now)
	newer["display_name"] = "新名字"
	submitPlatformV2Batch(t, f, profile.ID, accountSnapshotBatch(profile, 0, newer))

	var revision int64
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT revision FROM platform_account_snapshot WHERE account_id=$1`, f.Account.ID).Scan(&revision); err != nil {
		t.Fatal(err)
	}
	if revision != 1 {
		t.Fatalf("首条快照的 revision 应为 1，实际 %d", revision)
	}

	older := snapshotData(key, now.Add(-2*time.Hour))
	older["display_name"] = "旧名字"
	submitPlatformV2Batch(t, f, profile.ID, accountSnapshotBatch(profile, 1, older))

	var displayName string
	var afterRevision int64
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT display_name,revision FROM platform_account_snapshot WHERE account_id=$1`, f.Account.ID).
		Scan(&displayName, &afterRevision); err != nil {
		t.Fatal(err)
	}
	if displayName != "新名字" {
		t.Fatalf("更旧的观测不能覆盖更新的资料，实际 %q", displayName)
	}
	if afterRevision != 1 {
		t.Fatalf("更旧的观测不能让 revision 递增，实际 %d", afterRevision)
	}

	// 只带 bio 的新观测：合并而不是覆盖，display_name 要保留。
	partial := map[string]any{
		"identity_external_account_key": key,
		"bio":                           "新的简介",
		"field_states":                  map[string]string{"bio": "present"},
		"observed_at":                   now.Add(time.Minute),
	}
	submitPlatformV2Batch(t, f, profile.ID, accountSnapshotBatch(profile, 2, partial))

	var keptName, bio string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT display_name,bio FROM platform_account_snapshot WHERE account_id=$1`, f.Account.ID).
		Scan(&keptName, &bio); err != nil {
		t.Fatal(err)
	}
	if keptName != "新名字" || bio != "新的简介" {
		t.Fatalf("字段必须按 field_states 逐个合并: display_name=%q bio=%q", keptName, bio)
	}
}

// TestPlatformV2AccountSnapshotRejectsUnsafeAvatarRef 验证：头像必须是平台白名单内的
// HTTPS 公开地址，非 https、外域、带凭据查询串的一律拒绝。
//
// 头像会被前端直接渲染成 <img src>，所以这里放宽就等于让平台数据决定浏览器去请求谁。
func TestPlatformV2AccountSnapshotRejectsUnsafeAvatarRef(t *testing.T) {
	f, profile := startProfileStageFixture(t)
	key := f.ExternalKey()

	for _, avatar := range []string{
		"http://xhscdn.com/avatar.png",
		"https://evil.example.com/avatar.png",
		"https://xhscdn.com/avatar.png?token=abc",
	} {
		data := snapshotData(key, time.Now().UTC())
		data["avatar_ref"] = avatar
		data["field_states"] = map[string]string{"display_name": "present", "avatar_ref": "present"}
		status, response := submitV2BatchRaw(t, f, profile.ID, accountSnapshotBatch(profile, 0, data))
		if status != http.StatusUnprocessableEntity {
			t.Fatalf("不安全头像必须被拒 %q: %d %s", avatar, status, response)
		}
		if !strings.Contains(string(response), "头像引用不是允许的公开 HTTPS 地址") {
			t.Fatalf("拒绝原因必须指向头像引用 %q: %s", avatar, response)
		}
	}
	if count := accountSnapshotCount(t, f); count != 0 {
		t.Fatalf("被拒的头像批次不能落库，实际 %d 行", count)
	}

	data := snapshotData(key, time.Now().UTC())
	data["avatar_ref"] = "https://xhscdn.com/avatar.png"
	data["field_states"] = map[string]string{"display_name": "present", "avatar_ref": "present"}
	submitPlatformV2Batch(t, f, profile.ID, accountSnapshotBatch(profile, 1, data))

	var avatar *string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT avatar_ref FROM platform_account_snapshot WHERE account_id=$1`, f.Account.ID).Scan(&avatar); err != nil {
		t.Fatal(err)
	}
	if avatar == nil || *avatar != "https://xhscdn.com/avatar.png" {
		t.Fatalf("合法头像必须落库，实际 %v", avatar)
	}
}

// TestPlatformV2AccountSnapshotRejectsStaleRun 验证：run 结束之后再提交资料批次会被
// 409 platform_operation_stale 拒绝，不会在操作结束后继续改快照。
func TestPlatformV2AccountSnapshotRejectsStaleRun(t *testing.T) {
	f, profile := startProfileStageFixture(t)
	submitPlatformV2Batch(t, f, profile.ID, accountSnapshotBatch(profile, 0, snapshotData(f.ExternalKey(), time.Now().UTC())))
	submitPlatformV2Batch(t, f, profile.ID, platformV2ControlBatch(profile, 1, "complete", nil, "succeeded"))

	status, response := submitV2BatchRaw(t, f, profile.ID,
		accountSnapshotBatch(profile, 2, snapshotData(f.ExternalKey(), time.Now().UTC())))
	if status != http.StatusConflict {
		t.Fatalf("已结束的 run 不能再收结果: %d %s", status, response)
	}
	// 具体码可能是 lease_stale（run 已结束）或 operation_stale（操作已推进），
	// 两者都表示"这次 run 不再可用"，不把措辞固化成契约。
	if code := apiCode(response); code != "platform_lease_stale" && code != "platform_operation_stale" {
		t.Fatalf("expected a stale rejection, got %q body=%s", code, response)
	}
	if count := accountSnapshotCount(t, f); count != 1 {
		t.Fatalf("结束后的提交不能改动快照，实际 %d 行", count)
	}
}
