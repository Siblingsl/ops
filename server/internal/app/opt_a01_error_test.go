package app

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"strings"
	"testing"

	"ops/internal/ai"
)

// OPT-A01：上游 403/429/超时必须映射成桌面端可行动的错误码，而不是统一 502。
func TestOPTA01UpstreamFailureMapping(t *testing.T) {
	cases := []struct {
		name     string
		err      error
		wantCode string
		wantHTTP int
	}{
		{"403", &ai.UpstreamError{Status: http.StatusForbidden, Body: `{"error":{"message":"forbidden"}}`}, "ai_key_invalid", 502},
		{"401", &ai.UpstreamError{Status: http.StatusUnauthorized, Body: `{"error":{"message":"unauthorized"}}`}, "ai_key_invalid", 502},
		{"429", &ai.UpstreamError{Status: http.StatusTooManyRequests, Body: `{"error":{"message":"rate limited"}}`}, "ai_rate_limited", 429},
		{"first-token", errFirstToken, "ai_timeout", 504},
		{"deadline", context.DeadlineExceeded, "ai_timeout", 504},
		{"other", errors.New("connection reset"), "ai_upstream_error", 502},
		{"500", &ai.UpstreamError{Status: 500, Body: "boom"}, "ai_upstream_error", 502},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ae := upstreamFailureAPIError(tc.err, "测试供应商")
			if ae.Code != tc.wantCode || ae.Status != tc.wantHTTP {
				t.Fatalf("want %d/%s, got %d/%s (%s)", tc.wantHTTP, tc.wantCode, ae.Status, ae.Code, ae.Message)
			}
			if ae.Code != "ai_upstream_error" && ae.Message == "" {
				t.Fatal("可读错误必须有中文说明")
			}
		})
	}
	if !modelTimeout(errFirstToken) {
		t.Fatal("errFirstToken 应判定为超时")
	}
}

// OPT-A01：自检响应必须单独给出 chat/tools/vision 三项核心结论，供桌面端三槽位展示。
func TestOPTA01SelftestCoreFlags(t *testing.T) {
	env.reauth(t)
	var created Provider
	env.mustJSON(t, "POST", "/api/v1/model-providers", map[string]any{
		"name": "OPT-A01 核心自检", "base_url": env.mock.URL + "/v1", "api_key": "local-dev-key",
		"models": []string{"mock-writer"},
	}, &created)
	t.Cleanup(func() {
		env.do("DELETE", "/api/v1/model-providers/"+created.ID.String(), map[string]any{"confirm": true})
	})
	var res struct {
		ChatOK   bool `json:"chat_ok"`
		ToolsOK  bool `json:"tools_ok"`
		VisionOK bool `json:"vision_ok"`
		CoreOK   bool `json:"core_ok"`
	}
	env.mustJSON(t, "POST", "/api/v1/model-providers/"+created.ID.String()+"/selftest", map[string]any{"model": "mock-writer"}, &res)
	if !res.ChatOK || !res.ToolsOK || !res.VisionOK || !res.CoreOK {
		t.Fatalf("mock-writer 核心三项应全通过：%+v", res)
	}
}

// OPT-A01：文生图/原生搜索等可选探针失败，不能把 chat/tools/vision 全通过的
// 写作/智能体/识图供应商标成“测试未通过”（2026-11-24 WorkBuddy 真实自检回归）。
func TestOPTA01SelftestOptionalProbeFailureNotCoreFailure(t *testing.T) {
	env.reauth(t)
	target, err := url.Parse(env.mock.URL)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httputil.NewSingleHostReverseProxy(target)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/v1/images/") {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":{"message":"image endpoint not supported"}}`))
			return
		}
		proxy.ServeHTTP(w, r)
	}))
	t.Cleanup(upstream.Close)

	var created Provider
	env.mustJSON(t, "POST", "/api/v1/model-providers", map[string]any{
		"name": "OPT-A01 可选探针失败", "base_url": upstream.URL + "/v1", "api_key": "local-dev-key",
		"models": []string{"mock-writer"},
	}, &created)
	t.Cleanup(func() {
		env.do("DELETE", "/api/v1/model-providers/"+created.ID.String(), map[string]any{"confirm": true})
	})
	var res struct {
		OK       bool   `json:"ok"`
		Summary  string `json:"summary"`
		ChatOK   bool   `json:"chat_ok"`
		ToolsOK  bool   `json:"tools_ok"`
		VisionOK bool   `json:"vision_ok"`
		CoreOK   bool   `json:"core_ok"`
		Results  []struct {
			Key string `json:"key"`
			OK  bool   `json:"ok"`
		} `json:"results"`
	}
	env.mustJSON(t, "POST", "/api/v1/model-providers/"+created.ID.String()+"/selftest", map[string]any{"model": "mock-writer"}, &res)
	if !res.ChatOK || !res.ToolsOK || !res.VisionOK || !res.CoreOK {
		t.Fatalf("核心三项应通过：%+v", res)
	}
	if !res.OK {
		t.Fatalf("可选探针失败不应把核心可用供应商判为未通过：%+v", res)
	}
	// 永假条件修复后的回归点：核心通过 + 可选探针失败必须真的走入“核心 3 项通过”摘要分支。
	if !strings.Contains(res.Summary, "核心 3 项通过") {
		t.Fatalf("核心通过、可选探针失败时摘要应说明核心 3 项通过，实际：%q", res.Summary)
	}
	var imageOK *bool
	for _, p := range res.Results {
		if p.Key == "image" {
			v := p.OK
			imageOK = &v
		}
	}
	if imageOK == nil || *imageOK {
		t.Fatalf("文生图探针应在该上游失败，results=%+v", res.Results)
	}
}
