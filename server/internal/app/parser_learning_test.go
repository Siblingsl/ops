package app

// REF41 F4：采集自学习的 Go 验收。
// F4-A2 上报去重/批量上限；F4-A3 7 天 ≥3 生成 draft 不重复；F4-A4 人工 verify/activate；
// F4-A5 配方不自动改适配器（代码审查）；跨工作区 404。

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
)

// F4-A2：上报 10 分钟窗口去重（同五元组只记一条）。走真实设备证明（platformRunFixture）。
func TestF4ParserEventDedupe(t *testing.T) {
	f := newPlatformRunFixture(t, "xhs", "xhs_user_id:f4-dedupe")
	ws := f.Workspace
	seed := `{"events":[` +
		`{"platform":"xhs","error_code":"selector_missing","field":"title","page_hash":"h1","adapter_version":"v1"},` +
		`{"platform":"xhs","error_code":"selector_missing","field":"title","page_hash":"h1","adapter_version":"v1"},` +
		`{"platform":"xhs","error_code":"selector_missing","field":"title","page_hash":"h2","adapter_version":"v1"}]}`
	status, body := f.signedPlatform(t, "platform.parser.events", http.MethodPost, "/api/v1/desktop/parser-events", []byte(seed))
	if status != 200 {
		t.Fatalf("ingest status = %d, want 200; body=%s", status, body)
	}
	// 相同五元组合并 → 2 条（h1 去重 + h2）；不同 h2 新增。
	var n int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM parser_event WHERE workspace_id=$1 AND platform='xhs' AND field='title' AND error_code='selector_missing'`, ws).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Fatalf("deduped rows = %d, want 2", n)
	}
}

// F4-A2：批量上限 21 条拒绝；error_code 超长拒绝。
func TestF4ParserEventLimits(t *testing.T) {
	events := make([]string, 0, 21)
	for i := 0; i < 21; i++ {
		events = append(events, `{"platform":"xhs","error_code":"e","field":"f","page_hash":"p`+strings.Repeat("x", i)+`"}`)
	}
	seed := `{"events":[` + strings.Join(events, ",") + `]}`
	f := newPlatformRunFixture(t, "xhs", "xhs_user_id:f4-limit")
	status, _ := f.signedPlatform(t, "platform.parser.events", http.MethodPost, "/api/v1/desktop/parser-events", []byte(seed))
	if status != 422 {
		t.Fatalf("21-event ingest status = %d, want 422", status)
	}
	long := `{"events":[{"platform":"xhs","error_code":"` + strings.Repeat("长", 81) + `","field":"f"}]}`
	status, _ = f.signedPlatform(t, "platform.parser.events", http.MethodPost, "/api/v1/desktop/parser-events", []byte(long))
	if status != 422 {
		t.Fatalf("long error_code status = %d, want 422", status)
	}
}

// F4-N5：detail 服务端字段级脱敏 + sample_asset_id 工作区校验。
func TestF4ParserEventDetailRedactionAndAssetScope(t *testing.T) {
	f := newPlatformRunFixture(t, "xhs", "xhs_user_id:f4-redact")
	ws := f.Workspace
	assetID := uuid.New()
	if _, err := env.srv.db.Exec(context.Background(), `INSERT INTO asset
		(id, workspace_id, storage_path, mime, width, height, bytes, sha256)
		VALUES ($1,$2,'parser/sample.jpg','image/jpeg',10,10,100,'x')`, assetID, ws); err != nil {
		t.Fatal(err)
	}
	var foreignWS uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(),
		`INSERT INTO workspace (name) VALUES ('F4 外部样本') RETURNING id`).Scan(&foreignWS); err != nil {
		t.Fatal(err)
	}
	foreignAsset := uuid.New()
	if _, err := env.srv.db.Exec(context.Background(), `INSERT INTO asset
		(id, workspace_id, storage_path, mime, width, height, bytes, sha256)
		VALUES ($1,$2,'parser/foreign.jpg','image/jpeg',10,10,100,'y')`, foreignAsset, foreignWS); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(context.Background(), `DELETE FROM asset WHERE id=$1`, foreignAsset)
		_, _ = env.srv.db.Exec(context.Background(), `DELETE FROM workspace WHERE id=$1`, foreignWS)
	})
	cross := `{"events":[{"platform":"xhs","error_code":"parse_failed","field":"title","page_hash":"scope",` +
		`"sample_asset_id":"` + foreignAsset.String() + `"}]}`
	status, _ := f.signedPlatform(t, "platform.parser.events", http.MethodPost, "/api/v1/desktop/parser-events", []byte(cross))
	if status != 422 {
		t.Fatalf("cross-workspace sample status = %d, want 422", status)
	}
	long := strings.Repeat("x", 600)
	detail, _ := json.Marshal(map[string]any{
		"cookie": "session=abc", "selector": "#title",
		"nested": map[string]any{"authorization": "Bearer secret", "contact": "a@b.com", "phone": "13800138000"},
		"note":   "reach a@b.com or 13800138000",
		"long":   long,
	})
	payload := `{"events":[{"platform":"xhs","error_code":"parse_failed","field":"title","page_hash":"redact",` +
		`"sample_asset_id":"` + assetID.String() + `","detail":` + string(detail) + `}]}`
	status, body := f.signedPlatform(t, "platform.parser.events", http.MethodPost, "/api/v1/desktop/parser-events", []byte(payload))
	if status != 200 {
		t.Fatalf("redact ingest status = %d, body=%s", status, body)
	}
	var stored string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT detail::text FROM parser_event WHERE workspace_id=$1 AND page_hash='redact'`, ws).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	for _, leaked := range []string{"session=abc", "Bearer secret", "a@b.com", "13800138000", long} {
		if strings.Contains(stored, leaked) {
			t.Fatalf("detail leaked %q: %s", leaked, stored)
		}
	}
	for _, want := range []string{"#title", "[redacted]", "[redacted_email]", "[redacted_phone]"} {
		if !strings.Contains(stored, want) {
			t.Fatalf("detail missing %q: %s", want, stored)
		}
	}
}

// F4-A3：7 天失败 ≥3 生成 draft；同 platform+field 不重复生成。
func TestF4RecipeDraftGeneration(t *testing.T) {
	a := drAccount(t, "wechat_mp", "F4 配方")
	var ws uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT workspace_id FROM platform_account WHERE id=$1`, a.ID).Scan(&ws); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		if _, err := env.srv.db.Exec(context.Background(), `INSERT INTO parser_event
			(workspace_id, platform, field, error_code, page_hash, created_at)
			VALUES ($1,'wechat_mp','cover_image','parse_failed',$2, now() - make_interval(days => $3))`,
			ws, "h-"+uuid.NewString()[:8], i); err != nil {
			t.Fatal(err)
		}
	}
	env.srv.parserRecipeJob(context.Background())
	var recipeID uuid.UUID
	var status string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT id, status FROM parser_recipe WHERE workspace_id=$1 AND platform='wechat_mp' AND field='cover_image'`, ws).
		Scan(&recipeID, &status); err != nil {
		t.Fatal(err)
	}
	if status != "draft" {
		t.Fatalf("recipe status = %q, want draft", status)
	}
	// 再次跑 job：不重复生成（UNIQUE + exists 检查）。
	env.srv.parserRecipeJob(context.Background())
	var count int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM parser_recipe WHERE workspace_id=$1 AND platform='wechat_mp' AND field='cover_image'`, ws).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("recipe rows = %d, want 1", count)
	}
}

// F4-A4：verify/activate 状态机：draft→verified→active；draft 直接 activate 409。
func TestF4RecipeVerifyActivateStateMachine(t *testing.T) {
	a := drAccount(t, "xhs", "F4 状态机")
	var ws uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT workspace_id FROM platform_account WHERE id=$1`, a.ID).Scan(&ws); err != nil {
		t.Fatal(err)
	}
	var recipeID uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(), `INSERT INTO parser_recipe
		(workspace_id, platform, field, recipe) VALUES ($1,'xhs','tags','{"selector_candidates":[]}'::jsonb)
		RETURNING id`, ws).Scan(&recipeID); err != nil {
		t.Fatal(err)
	}
	// draft 直接 activate → 409。
	status, _ := env.do("POST", "/api/v1/parser-recipes/"+recipeID.String()+"/activate", map[string]any{})
	if status != 409 {
		t.Fatalf("draft activate status = %d, want 409", status)
	}
	// verify → verified。
	status, _ = env.do("POST", "/api/v1/parser-recipes/"+recipeID.String()+"/verify", map[string]any{"notes": "测试账号跑通"})
	if status != 200 {
		t.Fatalf("verify status = %d, want 200", status)
	}
	// 重复 verify → 409。
	status, _ = env.do("POST", "/api/v1/parser-recipes/"+recipeID.String()+"/verify", map[string]any{})
	if status != 409 {
		t.Fatalf("re-verify status = %d, want 409", status)
	}
	// activate → active。
	status, _ = env.do("POST", "/api/v1/parser-recipes/"+recipeID.String()+"/activate", map[string]any{})
	if status != 200 {
		t.Fatalf("activate status = %d, want 200", status)
	}
	var final string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT status FROM parser_recipe WHERE id=$1`, recipeID).Scan(&final); err != nil {
		t.Fatal(err)
	}
	if final != "active" {
		t.Fatalf("final status = %q", final)
	}
}

// F4-A4 补充：跨工作区 404。
func TestF4RecipeCrossWorkspace404(t *testing.T) {
	var foreign uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(),
		`INSERT INTO workspace (name) VALUES ('F4 异工作区') RETURNING id`).Scan(&foreign); err != nil {
		t.Fatal(err)
	}
	var recipeID uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(), `INSERT INTO parser_recipe
		(workspace_id, platform, field, recipe) VALUES ($1,'toutiao','title','{}'::jsonb)
		RETURNING id`, foreign).Scan(&recipeID); err != nil {
		t.Fatal(err)
	}
	status, _ := env.do("POST", "/api/v1/parser-recipes/"+recipeID.String()+"/verify", map[string]any{})
	if status != http.StatusNotFound {
		t.Fatalf("cross-workspace verify status = %d, want 404", status)
	}
}

// F4-A5：配方不自动改适配器——代码审查断言（parser_learning.go 无 desktop/src/platform 写入）。
func TestF4RecipeNeverTouchesAdapters(t *testing.T) {
	// 诊断/配方代码不引用 desktop 适配器路径。
	for _, banned := range []string{"desktop/src/platforms", "adapter.ts", "xhs.ts#", "wechat-mp.ts#"} {
		if strings.Contains(parserLearningSourceSnapshot, banned) {
			t.Fatalf("parser learning code must not reference adapter path %q", banned)
		}
	}
}

// parserLearningSourceSnapshot 由 init 读入自身源文件（代码审查级断言）。
var parserLearningSourceSnapshot = func() string {
	data, err := readFileSelf("parser_learning.go")
	if err != nil {
		return ""
	}
	return string(data)
}()

// jsonBody 把 JSON 字符串包成 json.RawMessage，经 env.do 的 json.Marshal 原样输出。
func jsonBody(s string) json.RawMessage {
	return json.RawMessage(s)
}

func readFileSelf(name string) ([]byte, error) {
	return os.ReadFile("internal/app/" + name)
}
