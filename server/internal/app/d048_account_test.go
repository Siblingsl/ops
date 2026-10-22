package app

import (
	"context"
	"strings"
	"testing"

	"github.com/google/uuid"
)

// D-123（取代 D-048 第 5.2 节的类型锁定）：账号类型改为「同平台内可迁移，但必须显式确认」。
// 未确认时不得静默修改；矩阵外类型仍然拒绝；重复传同值是兼容行为，业务资料可继续修改。
func TestD048AccountTypeLocked(t *testing.T) {
	var a Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{"platform": "wechat_mp", "name": "类型锁定号", "content_format": "comic"}, &a)
	p := "/api/v1/accounts/" + a.ID.String()

	// 未带 confirm_type_change → 409 confirm_required
	ae := env.expectErr(t, "PATCH", p, map[string]string{"content_format": "long_article"}, "confirm_required")
	if !strings.Contains(ae.Error.Message, "确认") {
		t.Fatalf("message should require confirmation: %s", ae.Error.Message)
	}
	env.expectErr(t, "PATCH", p, map[string]any{"content_format": "long_article", "confirm": true}, "confirm_required")
	// 矩阵外类型（带确认）→ validation_failed
	env.expectErr(t, "PATCH", p, map[string]any{"content_format": "nonsense", "confirm_type_change": true}, "validation_failed")
	// 跨平台（xhs 专属类型）→ validation_failed
	env.expectErr(t, "PATCH", p, map[string]any{"content_format": "image_note", "confirm_type_change": true}, "validation_failed")

	var a2 Account
	env.mustJSON(t, "PATCH", p, map[string]any{"name": "改名不改类型", "content_format": "comic"}, &a2)
	if a2.ContentFormat != "comic" || a2.Name != "改名不改类型" {
		t.Fatalf("same-value update must keep type and apply name: %+v", a2)
	}

	var a3 Account
	env.mustJSON(t, "PATCH", p, map[string]any{"type_note": "面向转型工程师的实战复盘"}, &a3)
	if a3.TypeNote != "面向转型工程师的实战复盘" || a3.ContentFormat != "comic" {
		t.Fatalf("type_note update: %+v", a3)
	}
}

// D-048 迁移约束：代码类型矩阵与数据库 CHECK 必须一致——矩阵内组合可落库，平台不支持的组合被拒。
func TestD048FormatMatrixConstraints(t *testing.T) {
	_ = env.accounts(t)
	var a Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{"platform": "xhs", "name": "迁移约束测试", "content_format": "image_note"}, &a)
	ctx := context.Background()
	var ws uuid.UUID
	if e := env.srv.db.QueryRow(ctx, `SELECT workspace_id FROM platform_account WHERE id=$1`, a.ID).Scan(&ws); e != nil {
		t.Fatal(e)
	}
	for platform, formats := range formatMatrix {
		for _, f := range formats {
			var id uuid.UUID
			e := env.srv.db.QueryRow(ctx, `INSERT INTO platform_account(workspace_id,platform,name,content_format) VALUES($1,$2,'约束组合',$3) RETURNING id`, ws, platform, f).Scan(&id)
			if e != nil {
				t.Fatalf("valid combo %s/%s rejected by database: %v", platform, f, e)
			}
			_, _ = env.srv.db.Exec(ctx, `DELETE FROM platform_account WHERE id=$1`, id)
		}
	}
	for _, c := range [][2]string{{"wechat_mp", "image_note"}, {"wechat_mp", "list_note"}, {"xhs", "long_article"}, {"xhs", "qa_article"}, {"xhs", "briefing"}, {"wechat_mp", "bogus"}, {"toutiao", "comic"}, {"toutiao", "image_note"}} {
		if _, e := env.srv.db.Exec(ctx, `INSERT INTO platform_account(workspace_id,platform,name,content_format) VALUES($1,$2,'非法组合',$3)`, ws, c[0], c[1]); e == nil {
			t.Fatalf("invalid combo %s/%s accepted by database", c[0], c[1])
		}
	}
}
