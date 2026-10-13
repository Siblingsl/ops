package app

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestOPT49FactCheckUsesWorkAndSectionMaterialsAndValidatesCitations(t *testing.T) {
	guest := env.registerClient(t, "opt49-"+uuid.NewString()[:8], testPassword)
	t.Cleanup(func() { guest.restore(env) })
	var account Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{"platform": "wechat_mp", "content_format": "long_article", "name": "事实核查素材模拟号"}, &account)
	work := outlinedWork(t, account, "事实核查引用素材")
	var workMaterial, sectionMaterial Material
	env.mustJSON(t, "POST", "/api/v1/materials", map[string]any{"account_id": account.ID, "kind": "data", "content": "年度记录：去年团队完成18个项目。"}, &workMaterial)
	env.mustJSON(t, "POST", "/api/v1/materials", map[string]any{"account_id": account.ID, "kind": "data", "content": "项目统计表：今年服务42个客户。"}, &sectionMaterial)
	env.mustJSON(t, "GET", "/api/v1/works/"+work.ID.String(), nil, &work)
	env.mustJSON(t, "PATCH", "/api/v1/works/"+work.ID.String(), map[string]any{"material_ids": []uuid.UUID{workMaterial.ID}, "base_revision": work.Revision}, &work)
	section := work.Sections[0]
	env.mustJSON(t, "PUT", "/api/v1/sections/"+section.ID.String()+"/materials", map[string][]uuid.UUID{"material_ids": {sectionMaterial.ID}}, nil)
	content := "去年团队完成18个项目。今年服务42个客户。转化率提升37%。"
	env.mustJSON(t, "PATCH", "/api/v1/sections/"+section.ID.String(), map[string]any{"content_md": content, "base_revision": section.Revision}, &section)

	received := make(chan string, 1)
	model := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			Messages []struct {
				Role    string `json:"role"`
				Content string `json:"content"`
			} `json:"messages"`
		}
		if json.NewDecoder(r.Body).Decode(&request) != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		for _, message := range request.Messages {
			if message.Role == "user" {
				received <- message.Content
			}
		}
		reply := fmt.Sprintf(`{"items":[{"section_id":%q,"quote":"去年团队完成18个项目。","claim_type":"data","reason":"","support_status":"supported","material_id":%q,"material_quote":"去年团队完成18个项目。"},{"section_id":%q,"quote":"今年服务42个客户。","claim_type":"data","reason":"","support_status":"supported","material_id":%q,"material_quote":"不存在于素材中的引句。"},{"section_id":%q,"quote":"转化率提升37%%。","claim_type":"data","reason":"缺少出处","support_status":"unverified"}]}`,
			section.ID, workMaterial.ID, section.ID, sectionMaterial.ID, section.ID)
		frame, _ := json.Marshal(map[string]any{"choices": []map[string]any{{"delta": map[string]string{"content": reply}}}})
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = fmt.Fprintf(w, "data: %s\n\ndata: [DONE]\n\n", frame)
	}))
	t.Cleanup(model.Close)
	var provider Provider
	env.mustJSON(t, "POST", "/api/v1/model-providers", map[string]any{"name": "OPT-49 事实核查模拟模型", "base_url": model.URL + "/v1", "api_key": "opt49-local-mock-key", "models": []string{"mock-writer"}}, &provider)
	env.mustJSON(t, "PUT", "/api/v1/model-routes", []map[string]any{{"task_type": "fact_flag", "provider_id": provider.ID, "model": "mock-writer"}}, nil)
	env.mustJSON(t, "POST", "/api/v1/works/"+work.ID.String()+"/checks", map[string]int{"html_chars": 100, "html_bytes": 300}, nil)
	run := env.latestCheck(t, work.ID.String())
	prompt := <-received
	for _, id := range []uuid.UUID{workMaterial.ID, sectionMaterial.ID} {
		if !strings.Contains(prompt, "<<<素材 id="+id.String()+">>>") {
			t.Fatalf("fact_flag request omitted associated material %s", id)
		}
	}
	facts := []CheckItem{}
	for _, item := range run.Items {
		if item.Category == "fact" && item.MatchedText != "" {
			facts = append(facts, item)
		}
	}
	if len(facts) != 3 {
		t.Fatalf("want three fact items, got %#v", facts)
	}
	supported := 0
	for _, item := range facts {
		_, hasSupport := item.Location["material_support"]
		if item.MatchedText == "去年团队完成18个项目。" && hasSupport {
			supported++
		}
		if item.MatchedText != "去年团队完成18个项目。" && hasSupport {
			t.Fatalf("unmatched citation incorrectly marked as supported: %#v", item)
		}
		if item.Resolution != nil {
			t.Fatalf("fact item was auto-confirmed: %#v", item)
		}
	}
	if supported != 1 {
		t.Fatalf("want one source-supported item, got %#v", facts)
	}
}
