package app

import (
	"context"
	"testing"

	"github.com/google/uuid"
)

// DEV-PS62 定向测试：auto_adopt 的接线（20 文档 §9.3、§11.2、D-129）。
//
// 这一轮**不打开**闸门，只把"打开之后要能生效"的部分补实：
//   - 闸门改成进程配置 `OPS_DESKTOP_PLATFORM_AUTO_ADOPT`，默认关闭；
//   - 闸门之上的 PATCH 真正写 auto_adopt，并在变化时递增 adoption_revision；
//   - "只开采用不开采集"返回 422，而不是撞 CHECK 变成 500。

func withPlatformAutoAdopt(t *testing.T, enabled bool) {
	t.Helper()
	old := env.srv.cfg.DesktopPlatformAutoAdopt
	env.srv.cfg.DesktopPlatformAutoAdopt = enabled
	t.Cleanup(func() { env.srv.cfg.DesktopPlatformAutoAdopt = old })
}

func connectionAdoptionRevision(t *testing.T, connectionID uuid.UUID) int64 {
	t.Helper()
	var revision int64
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT adoption_revision FROM platform_connection WHERE id=$1`, connectionID).Scan(&revision); err != nil {
		t.Fatal(err)
	}
	return revision
}

// 闸门关闭时（默认），开启自动采用仍然是 409；关掉已经开启的采用则不该被闸门拦。
func TestPlatformAutoAdoptGateDefaultsClosed(t *testing.T) {
	f := newPlatformRunFixture(t, "xhs", "xhs_user_id:fixture-self")
	path := "/api/v1/accounts/" + f.Account.ID.String() + "/platform-connection"
	ctx := context.Background()

	if _, err := env.srv.db.Exec(ctx, `UPDATE platform_connection SET auto_collect=true, auto_adopt=true
		WHERE id=$1`, f.Connection); err != nil {
		t.Fatal(err)
	}
	env.reauth(t)

	// 开启：闸门关着，409。
	env.expectErr(t, "PATCH", path, map[string]any{"auto_adopt": true}, "platform_consent_required")

	// 关闭：不是增权，闸门不该拦它。
	var updated platformConnection
	env.mustJSON(t, "PATCH", path, map[string]any{"auto_adopt": false}, &updated)
	if updated.AutoAdopt {
		t.Fatalf("关闭自动采用后应为 false：%+v", updated)
	}
	if rev := connectionAdoptionRevision(t, f.Connection); rev <= 1 {
		t.Fatalf("关闭自动采用应递增 adoption_revision，实际 %d", rev)
	}
}

// 闸门打开时（验收通过后的部署形态），PATCH 必须真的落库并递增版本号。
func TestPlatformAutoAdoptEnablePersistsAndBumpsRevision(t *testing.T) {
	f := newPlatformRunFixture(t, "xhs", "xhs_user_id:fixture-self")
	path := "/api/v1/accounts/" + f.Account.ID.String() + "/platform-connection"
	withPlatformAutoAdopt(t, true)
	env.reauth(t)

	// 先开自动采集。
	var withCollect platformConnection
	env.mustJSON(t, "PATCH", path, map[string]any{
		"auto_collect": true, "authorization_revision": connectionAuthRevision(t, f.Connection),
	}, &withCollect)
	if !withCollect.AutoCollect {
		t.Fatalf("应已开启自动采集：%+v", withCollect)
	}
	before := connectionAdoptionRevision(t, f.Connection)

	// 再开自动采用。
	var adopted platformConnection
	env.mustJSON(t, "PATCH", path, map[string]any{
		"auto_adopt": true, "adoption_revision": before,
	}, &adopted)
	if !adopted.AutoAdopt {
		t.Fatalf("响应应显示 auto_adopt=true：%+v", adopted)
	}
	if adopted.AdoptionRevision != before+1 {
		t.Fatalf("adoption_revision 应递增：before=%d after=%d", before, adopted.AdoptionRevision)
	}

	// 落库核实，不能只信响应。
	var storedAdopt, storedCollect bool
	var storedRevision int64
	if err := env.srv.db.QueryRow(context.Background(), `SELECT auto_adopt, auto_collect, adoption_revision
		FROM platform_connection WHERE id=$1`, f.Connection).Scan(&storedAdopt, &storedCollect, &storedRevision); err != nil {
		t.Fatal(err)
	}
	if !storedAdopt || !storedCollect {
		t.Fatalf("库里应为 auto_adopt=true、auto_collect=true：adopt=%v collect=%v", storedAdopt, storedCollect)
	}
	if storedRevision != adopted.AdoptionRevision {
		t.Fatalf("库里的 revision 与响应不一致：%d vs %d", storedRevision, adopted.AdoptionRevision)
	}
}

// 版本号不匹配要拒绝：这是 adoption_revision 递增之后才真正成立的语义。
func TestPlatformAutoAdoptStaleAdoptionRevisionRejected(t *testing.T) {
	f := newPlatformRunFixture(t, "xhs", "xhs_user_id:fixture-self")
	path := "/api/v1/accounts/" + f.Account.ID.String() + "/platform-connection"
	withPlatformAutoAdopt(t, true)
	env.reauth(t)

	var withCollect platformConnection
	env.mustJSON(t, "PATCH", path, map[string]any{
		"auto_collect": true, "authorization_revision": connectionAuthRevision(t, f.Connection),
	}, &withCollect)
	stale := connectionAdoptionRevision(t, f.Connection)
	env.mustJSON(t, "PATCH", path, map[string]any{"auto_adopt": true, "adoption_revision": stale}, &platformConnection{})

	// 拿着上一个版本号再改一次，应被拒绝。
	env.expectErr(t, "PATCH", path, map[string]any{
		"auto_adopt": false, "adoption_revision": stale,
	}, "platform_authorization_changed")
}

// 只开采用、不开采集：给可读的 422，而不是让 CHECK 约束把请求打成 500。
func TestPlatformAutoAdoptRequiresCollectFirst(t *testing.T) {
	f := newPlatformRunFixture(t, "xhs", "xhs_user_id:fixture-self")
	path := "/api/v1/accounts/" + f.Account.ID.String() + "/platform-connection"
	withPlatformAutoAdopt(t, true)
	env.reauth(t)
	// 先把自动采集关掉（fixture 的默认值就是开）。
	var collectedOff platformConnection
	env.mustJSON(t, "PATCH", path, map[string]any{
		"auto_collect": false, "authorization_revision": connectionAuthRevision(t, f.Connection),
	}, &collectedOff)
	if collectedOff.AutoCollect {
		t.Fatalf("应已关闭自动采集：%+v", collectedOff)
	}

	env.expectErr(t, "PATCH", path, map[string]any{"auto_adopt": true}, "validation_failed")
}
