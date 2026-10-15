package app

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestOPT43EditIncludesBoundMaterialsViewpointAndHeadings(t *testing.T) {
	for _, mode := range []string{"rewrite", "expand", "shorten"} {
		for _, variants := range []int{1, 3} {
			t.Run(mode+string(rune('0'+variants)), func(t *testing.T) {
				guest := env.registerClient(t, "opt43-"+uuid.NewString()[:8], testPassword)
				t.Cleanup(func() { guest.restore(env) })
				var a Account
				env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{"platform": "wechat_mp", "content_format": "long_article", "name": "段落编辑模拟号"}, &a)
				work := outlinedWork(t, a, "全文观点：先验证手上的事实，再解释行动步骤")
				var bound, fallback Material
				env.mustJSON(t, "POST", "/api/v1/materials", map[string]any{"account_id": a.ID, "kind": "data", "content": "本段作者事实：参与者总计十二人，分成三个小组。"}, &bound)
				env.mustJSON(t, "POST", "/api/v1/materials", map[string]any{"account_id": a.ID, "kind": "case", "content": "作品回退素材：作者先组织一次小范围验证。"}, &fallback)
				env.mustJSON(t, "PATCH", "/api/v1/works/"+work.ID.String(), map[string]any{"material_ids": []uuid.UUID{fallback.ID}, "base_revision": work.Revision}, &work)
				work.Sections[0] = setSection(t, work.Sections[0], "本段原文只陈述已知事实。")
				env.mustJSON(t, "PUT", "/api/v1/sections/"+work.Sections[0].ID.String()+"/materials", map[string]any{"material_ids": []uuid.UUID{bound.ID}}, nil)
				received := make(chan string, 2)
				model := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					raw, err := io.ReadAll(r.Body)
					if err != nil {
						w.WriteHeader(400)
						return
					}
					var request struct {
						Messages []struct{ Role, Content string }
					}
					if json.Unmarshal(raw, &request) != nil {
						w.WriteHeader(400)
						return
					}
					for _, message := range request.Messages {
						if message.Role == "user" {
							received <- message.Content
						}
					}
					r.Body = io.NopCloser(bytes.NewReader(raw))
					env.llm.Handler().ServeHTTP(w, r)
				}))
				t.Cleanup(model.Close)
				var provider Provider
				env.mustJSON(t, "POST", "/api/v1/model-providers", map[string]any{"name": "段落素材模拟模型", "base_url": model.URL + "/v1", "api_key": "opt43-local-mock-key", "models": []string{"mock-writer"}}, &provider)
				env.mustJSON(t, "PUT", "/api/v1/model-routes", []map[string]any{{"task_type": "section_edit", "provider_id": provider.ID, "model": "mock-writer"}}, nil)
				edit := func() []Slot {
					body := map[string]any{"mode": mode, "variants": variants}
					path := "/api/v1/sections/" + work.Sections[0].ID.String() + "/edit"
					var refs struct {
						Slots []Slot `json:"slots"`
					}
					if variants == 3 {
						var response struct {
							Refs json.RawMessage `json:"refs"`
						}
						env.mustJSON(t, "POST", path, body, &response)
						if err := json.Unmarshal(response.Refs, &refs); err != nil {
							t.Fatal(err)
						}
					} else {
						event := lastEvent(t, env.sse(t, path, body))
						if event.Name != "done" {
							t.Fatalf("edit: %s %s", event.Name, event.Data)
						}
						var response struct {
							Refs json.RawMessage `json:"refs"`
						}
						if err := json.Unmarshal(event.Data, &response); err != nil {
							t.Fatal(err)
						}
						if err := json.Unmarshal(response.Refs, &refs); err != nil {
							t.Fatal(err)
						}
					}
					return refs.Slots
				}
				for _, material := range []Material{bound, fallback} {
					if material.ID == fallback.ID {
						env.mustJSON(t, "PUT", "/api/v1/sections/"+work.Sections[0].ID.String()+"/materials", map[string]any{"material_ids": []uuid.UUID{}}, nil)
					}
					slots := edit()
					prompt := <-received
					if !slotHas(slots, "materials", material.ID.String()) || !strings.Contains(prompt, material.Content) || !strings.Contains(prompt, work.Viewpoint) {
						t.Fatal("model request or refs missing selected material/viewpoint")
					}
					for _, item := range work.Outline {
						if !strings.Contains(prompt, item.Heading) {
							t.Fatal("outline heading missing")
						}
					}
					if mode == "expand" && !strings.Contains(prompt, "只用素材中的事实展开") {
						t.Fatal("expand must restrict factual sources")
					}
					if material.ID == bound.ID && strings.Contains(prompt, fallback.Content) {
						t.Fatal("bound section materials must take precedence")
					}
				}
			})
		}
	}
}
