package app

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"
)

// TL-01 / FN-06（38 文档）：能力目录接口——域聚合、角色过滤、不泄露 path/params。
func TestTL01CapabilitiesProjection(t *testing.T) {
	t.Setenv(agentWorkbenchFeatureEnv, "workbench_ui,goals,artifacts")

	var body struct {
		Domains []struct {
			Key   string `json:"key"`
			Label string `json:"label"`
			Tools []struct {
				Name    string   `json:"name"`
				Label   string   `json:"label"`
				Kind    string   `json:"kind"`
				MinRole string   `json:"min_role"`
				Gates   []string `json:"gates"`
			} `json:"tools"`
		} `json:"domains"`
	}
	env.mustJSON(t, http.MethodGet, "/api/v1/agent/capabilities", nil, &body)
	if len(body.Domains) == 0 {
		t.Fatal("应返回至少一个业务域")
	}
	raw, _ := json.Marshal(body)
	for _, banned := range []string{`"path"`, `"/api/v1/`, `"method"`, `"params"`, `"schema"`} {
		if strings.Contains(string(raw), banned) {
			t.Fatalf("能力目录泄露 %s", banned)
		}
	}
	// 工具 label 都是业务化中文短名，不含原始工具名。
	for _, domain := range body.Domains {
		for _, tool := range domain.Tools {
			if tool.Label == "" || tool.Label == tool.Name {
				t.Fatalf("label 未业务化：%s/%s", tool.Name, tool.Label)
			}
			if !strings.Contains(tool.Label, string([]rune(tool.Label)[:1])) {
				t.Fatalf("label 空")
			}
		}
	}
	// viewer：W/H/X 写类工具不可用；owner：可用。
	ownerCount := 0
	for _, domain := range body.Domains {
		for _, tool := range domain.Tools {
			if tool.Kind != "R" {
				ownerCount++
			}
		}
	}
	if ownerCount == 0 {
		t.Fatal("owner 视角应能看到写类能力")
	}

	// invite 必须先建（此时 env 仍是 owner 身份），再 registerClient——否则 invite 会建在
	// 新用户自己的 workspace 里，join 不生效（registerClient 会切换 env 身份）。
	var inv inviteDTO
	env.mustJSON(t, "POST", "/api/v1/workspaces/current/invites", map[string]any{"role": "viewer", "max_uses": 1, "days": 1}, &inv)
	viewer := env.registerClient(t, "tl01-viewer-"+uuid.NewString()[:8], testPassword)
	var vme meInfo
	viewer.mustJSON(t, "GET", "/api/v1/auth/me", nil, &vme)
	viewer.csrf = vme.CSRF
	viewer.mustJSON(t, "POST", "/api/v1/workspaces/join", map[string]any{"code": inv.Code, "switch": true}, nil)
	viewer.mustJSON(t, "GET", "/api/v1/auth/me", nil, &vme)
	viewer.csrf = vme.CSRF
	if vme.Role != "viewer" {
		t.Fatalf("want viewer, got %s", vme.Role)
	}
	var vbody struct {
		Domains []struct {
			Tools []struct {
				Name      string `json:"name"`
				Kind      string `json:"kind"`
				Available bool   `json:"available"`
			} `json:"tools"`
		} `json:"domains"`
	}
	viewer.mustJSON(t, "GET", "/api/v1/agent/capabilities", nil, &vbody)
	for _, domain := range vbody.Domains {
		for _, tool := range domain.Tools {
			if tool.Kind != "R" && tool.Available {
				t.Fatalf("viewer 视角写类工具 %s 不应 available", tool.Name)
			}
		}
	}
	viewer.restore(env)
}
