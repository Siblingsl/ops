package app

import (
	"context"
	"strings"
	"testing"

	"github.com/google/uuid"
)

// D-048 复现：账号类型创建后必须固定——普通更新、confirm=true 二次确认都不能改类型；
// 重复传入同值是兼容行为，业务资料（名称等）可以继续修改。
func TestD048AccountTypeLocked(t *testing.T) {
	var a Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{"platform": "wechat_mp", "name": "类型锁定号", "content_format": "comic"}, &a)
	p := "/api/v1/accounts/" + a.ID.String()

	ae := env.expectErr(t, "PATCH", p, map[string]string{"content_format": "long_article"}, "validation_failed")
	if !strings.Contains(ae.Error.Message, "不可修改") {
		t.Fatalf("message should say type is locked: %s", ae.Error.Message)
	}
	env.expectErr(t, "PATCH", p, map[string]any{"content_format": "long_article", "confirm": true}, "validation_failed")
	env.expectErr(t, "PATCH", p, map[string]string{"content_format": "nonsense"}, "validation_failed")

	var a2 Account
	env.mustJSON(t, "PATCH", p, map[string]any{"name": "改名不改类型", "content_format": "comic"}, &a2)
	if a2.ContentFormat != "comic" || a2.Name != "改名不改类型" {
		t.Fatalf("same-value update must keep type and apply name: %+v", a2)
	}
	var got Account
	env.mustJSON(t, "GET", p, nil, &got)
	if got.ContentFormat != "comic" {
		t.Fatalf("type changed after lock: %s", got.ContentFormat)
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
	for _, c := range [][2]string{{"wechat_mp", "image_note"}, {"wechat_mp", "list_note"}, {"xhs", "long_article"}, {"xhs", "qa_article"}, {"xhs", "briefing"}, {"wechat_mp", "bogus"}} {
		if _, e := env.srv.db.Exec(ctx, `INSERT INTO platform_account(workspace_id,platform,name,content_format) VALUES($1,$2,'非法组合',$3)`, ws, c[0], c[1]); e == nil {
			t.Fatalf("invalid combo %s/%s accepted by database", c[0], c[1])
		}
	}
}
