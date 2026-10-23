package app

import (
	"context"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// DEV-PS32 定向测试：会话失效通知（20 文档 §6.4）。
//
// 规范原文："会话失效时连接转 `login_required`，同一失效只通知保管人一次，
// 通知说明'需要谁扫码'；不在后台反复拉起二维码。"
//
// 这条路径原来完全没实现——只改了 availability，不发任何通知。
// 用户看不到"登录失效了"，连接就静默停在 login_required 上。

// pendingReauthNotifications 读该用户收到的平台重连通知。
func pendingReauthNotifications(t *testing.T, userID uuid.UUID) []struct{ Title, Body, Dedupe, Link string } {
	t.Helper()
	rows, err := env.srv.db.Query(context.Background(), `SELECT title, body, coalesce(dedupe_key,''), coalesce(link,'')
		FROM notification WHERE user_id=$1 AND kind='platform_reauth' ORDER BY created_at`, userID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []struct{ Title, Body, Dedupe, Link string }
	for rows.Next() {
		var item struct{ Title, Body, Dedupe, Link string }
		if err := rows.Scan(&item.Title, &item.Body, &item.Dedupe, &item.Link); err != nil {
			t.Fatal(err)
		}
		out = append(out, item)
	}
	return out
}

func cleanupReauthNotifications(t *testing.T, userID uuid.UUID) {
	t.Helper()
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(context.Background(),
			`DELETE FROM notification WHERE user_id=$1 AND kind='platform_reauth'`, userID)
	})
}

func TestPlatformLoginRequiredNotifiesHolder(t *testing.T) {
	f := newPlatformRunFixture(t, "xhs", "xhs_user_id:fixture_reauth_"+uuid.New().String()[:8])
	cleanupReauthNotifications(t, f.UserID)

	code := "platform_login_required"
	if err := env.srv.withTx(context.Background(), func(tx pgx.Tx) error {
		return env.srv.applyRunFailureAction(context.Background(), tx, f.Connection, &code)
	}); err != nil {
		t.Fatal(err)
	}

	// 连接转为 login_required。
	var availability string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT availability FROM platform_connection WHERE id=$1`, f.Connection).Scan(&availability); err != nil {
		t.Fatal(err)
	}
	if availability != "login_required" {
		t.Fatalf("连接应为 login_required，实际 %q", availability)
	}

	// 必须通知到保管人，且说清"需要谁扫码"。
	items := pendingReauthNotifications(t, f.UserID)
	if len(items) != 1 {
		t.Fatalf("应恰好收到 1 条重连通知，实际 %d 条", len(items))
	}
	if !strings.Contains(items[0].Body, "扫码") {
		t.Fatalf("通知正文应说明需要扫码，实际 %q", items[0].Body)
	}
	if !strings.Contains(items[0].Body, "保管人") {
		t.Fatalf("通知正文应说明需要谁扫码，实际 %q", items[0].Body)
	}
	if !strings.HasPrefix(items[0].Link, "/settings/accounts?id=") {
		t.Fatalf("通知链接应指向账号设置，实际 %q", items[0].Link)
	}
}

func TestPlatformLoginRequiredNotifiesOnce(t *testing.T) {
	f := newPlatformRunFixture(t, "xhs", "xhs_user_id:fixture_once_"+uuid.New().String()[:8])
	cleanupReauthNotifications(t, f.UserID)

	code := "platform_login_required"
	// 连续三次失败：同一次失效只应通知一次，否则用户会被同一件事反复打扰。
	for i := 0; i < 3; i++ {
		if err := env.srv.withTx(context.Background(), func(tx pgx.Tx) error {
			return env.srv.applyRunFailureAction(context.Background(), tx, f.Connection, &code)
		}); err != nil {
			t.Fatal(err)
		}
	}
	items := pendingReauthNotifications(t, f.UserID)
	if len(items) != 1 {
		t.Fatalf("同一次失效只能通知一次，实际 %d 条", len(items))
	}

	// 重新验证成功后（last_verified_at 变化），再次失效应能再提醒一次——
	// 否则用户第一次处理完，以后再失效就永远收不到通知了。
	if _, err := env.srv.db.Exec(context.Background(),
		`UPDATE platform_connection SET last_verified_at=now() + interval '1 minute',
		 availability='ready' WHERE id=$1`, f.Connection); err != nil {
		t.Fatal(err)
	}
	if err := env.srv.withTx(context.Background(), func(tx pgx.Tx) error {
		return env.srv.applyRunFailureAction(context.Background(), tx, f.Connection, &code)
	}); err != nil {
		t.Fatal(err)
	}
	items = pendingReauthNotifications(t, f.UserID)
	if len(items) != 2 {
		t.Fatalf("新一轮失效应再通知一次，实际共 %d 条", len(items))
	}
}

func TestPlatformChallengeRequiredHasItsOwnNotice(t *testing.T) {
	f := newPlatformRunFixture(t, "wechat_mp", "wechat_biz:fixture_challenge_"+uuid.New().String()[:8])
	cleanupReauthNotifications(t, f.UserID)

	code := "platform_challenge_required"
	if err := env.srv.withTx(context.Background(), func(tx pgx.Tx) error {
		return env.srv.applyRunFailureAction(context.Background(), tx, f.Connection, &code)
	}); err != nil {
		t.Fatal(err)
	}
	items := pendingReauthNotifications(t, f.UserID)
	if len(items) != 1 {
		t.Fatalf("安全验证应通知一次，实际 %d 条", len(items))
	}
	// 不能说成"登录失效"——那是另一种情况，处置方式不同。
	if !strings.Contains(items[0].Title, "安全验证") {
		t.Fatalf("标题应指明是安全验证，实际 %q", items[0].Title)
	}
	// 必须明确不会自动重试或绕过（§12：不轮换代理、不尝试绕过）。
	if !strings.Contains(items[0].Body, "不会自动重试") {
		t.Fatalf("正文应说明不会自动重试，实际 %q", items[0].Body)
	}
}
