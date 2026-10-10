package app

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/google/uuid"
)

// D-048 复现：图文账号收到漫画推荐——生成必须明确失败而不是静默改成账号类型；
// 历史跨类型推荐不能采用或直接开写；跨类型选题开写前必须校验。
func TestD048DailyTypeConstraint(t *testing.T) {
	var a Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{"platform": "wechat_mp", "name": "图文约束号", "content_format": "long_article"}, &a)
	p := "/api/v1/accounts/" + a.ID.String()
	opts, call := positioningOptions(t, p)
	f := opts[0].StrategyFields
	f.DailySettings = map[string]any{"generate": "off"}
	env.mustJSON(t, "POST", p+"/strategy", map[string]any{"niche": f.Niche, "audience": f.Audience, "differentiation": f.Differentiation,
		"persona": f.Persona, "pillars": f.Pillars, "cadence": f.Cadence, "stage": "cold_start", "keywords": f.Keywords,
		"daily_settings": f.DailySettings, "ai_call_id": call}, nil)

	// 1) 模型返回跨类型（漫画）输出：重试后明确失败，错误里说明类型不一致。
	env.llm.ForceDailyFormat = "comic"
	t.Cleanup(func() { env.llm.ForceDailyFormat = "" })
	ae := env.expectErr(t, "POST", p+"/daily/regenerate", nil, "ai_output_invalid")
	if !strings.Contains(ae.Error.Message+string(ae.Error.Detail), "类型") {
		t.Fatalf("error should mention type mismatch: %s %s", ae.Error.Message, ae.Error.Detail)
	}

	// 2) 历史跨类型推荐（升级前生成）：采用与直接开写被阻断并提示原因，不创建跨类型作品。
	ctx := context.Background()
	var rec uuid.UUID
	items := `[{"title":"跨类型历史推荐","angle":"角度","audience":"读者","hook":"钩子","needed_materials":[],"format":"comic","reason":"理由","basis":[{"type":"pillar","name":"实战复盘"}],"primary":true}]`
	if e := env.srv.db.QueryRow(ctx, `INSERT INTO daily_recommendation(account_id,date,version,items,trigger) VALUES($1,current_date,1,$2,'manual') RETURNING id`, a.ID, items).Scan(&rec); e != nil {
		t.Fatal(e)
	}
	base := fmt.Sprintf("/api/v1/daily/%s/items/0", rec)
	ae = env.expectErr(t, "POST", base+"/adopt", map[string]any{}, "state_invalid")
	if !strings.Contains(ae.Error.Message, "类型") {
		t.Fatalf("adopt message: %s", ae.Error.Message)
	}
	env.expectErr(t, "POST", base+"/start", nil, "state_invalid")
	var n int
	if e := env.srv.db.QueryRow(ctx, `SELECT count(*) FROM work WHERE account_id=$1 AND content_format='comic'`, a.ID).Scan(&n); e != nil || n != 0 {
		t.Fatalf("cross-type works created on long_article account: %d %v", n, e)
	}

	// 3) 已入库的漫画体选题：开写被阻断并提示，不按账号类型强行生成。
	var topic uuid.UUID
	if e := env.srv.db.QueryRow(ctx, `INSERT INTO topic(account_id,title,angle,format) VALUES($1,'漫画体选题','角度','comic') RETURNING id`, a.ID).Scan(&topic); e != nil {
		t.Fatal(e)
	}
	ae = env.expectErr(t, "POST", "/api/v1/topics/"+topic.String()+"/works", nil, "state_invalid")
	if !strings.Contains(ae.Error.Message, "类型") {
		t.Fatalf("topic start message: %s", ae.Error.Message)
	}
}
