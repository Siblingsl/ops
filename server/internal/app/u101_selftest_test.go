package app

import (
	"context"
	"strings"
	"testing"
)

// DEV-U101（12 文档）：模型供应商能力自检——一次探测 对话/JSON/流式/出图/联网搜索，
// 结果可读、密钥不泄露；自检不写入 ai_call，避免污染用量统计与质量看板。
func TestU101ProviderSelfTest(t *testing.T) {
	var p Provider
	env.reauth(t)
	env.mustJSON(t, "POST", "/api/v1/model-providers", map[string]any{
		"name": "自检供应商", "base_url": env.mock.URL + "/v1", "api_key": "selftest-key",
		"models": []string{"mock-chat", "mock-image"},
	}, &p)

	var before int
	_ = env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM ai_call`).Scan(&before)

	var out struct {
		Model   string `json:"model"`
		Summary string `json:"summary"`
		OK      bool   `json:"ok"`
		Results []struct {
			Key       string `json:"key"`
			Label     string `json:"label"`
			OK        bool   `json:"ok"`
			Skipped   bool   `json:"skipped"`
			LatencyMS int64  `json:"latency_ms"`
			Detail    string `json:"detail"`
		} `json:"results"`
	}
	env.mustJSON(t, "POST", "/api/v1/model-providers/"+p.ID.String()+"/selftest", nil, &out)

	byKey := map[string]struct {
		ok, skipped bool
		detail      string
	}{}
	for _, r := range out.Results {
		byKey[r.Key] = struct {
			ok, skipped bool
			detail      string
		}{r.OK, r.Skipped, r.Detail}
	}
	for _, k := range []string{"chat", "json", "stream", "image", "search"} {
		v, okK := byKey[k]
		if !okK {
			t.Fatalf("missing probe %s in %+v", k, out.Results)
		}
		if !v.ok || v.skipped {
			t.Fatalf("probe %s should pass on mock: %+v", k, v)
		}
	}
	if out.Model != "mock-chat" {
		t.Fatalf("model %s", out.Model)
	}
	if !out.OK || out.Summary == "" {
		t.Fatalf("summary: %+v", out)
	}

	var after int
	_ = env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM ai_call`).Scan(&after)
	if before != after {
		t.Fatalf("selftest polluted ai_call: %d -> %d", before, after)
	}

	var list []Provider
	env.mustJSON(t, "GET", "/api/v1/model-providers", nil, &list)
	for _, x := range list {
		if x.ID != p.ID {
			continue
		}
		if x.LastTestOK == nil || !*x.LastTestOK || x.LastTestResult == "" {
			t.Fatalf("provider last_test not updated: %+v", x)
		}
	}

	// 不支持原生搜索契约的接口地址：search 探测跳过而非失败（用本机拒绝端口，避免访问外网）。
	var p2 Provider
	env.reauth(t)
	env.mustJSON(t, "POST", "/api/v1/model-providers", map[string]any{
		"name": "无搜索供应商", "base_url": "http://127.0.0.1:1/v1", "api_key": "k2", "models": []string{"m"},
	}, &p2)
	var out2 struct {
		Results []struct {
			Key     string `json:"key"`
			OK      bool   `json:"ok"`
			Skipped bool   `json:"skipped"`
		} `json:"results"`
	}
	env.mustJSON(t, "POST", "/api/v1/model-providers/"+p2.ID.String()+"/selftest", nil, &out2)
	byKey2 := map[string]struct {
		ok, skipped bool
	}{}
	for _, r := range out2.Results {
		byKey2[r.Key] = struct {
			ok, skipped bool
		}{r.OK, r.Skipped}
	}
	if v := byKey2["search"]; !v.skipped {
		t.Fatalf("search should be skipped for unsupported base_url: %+v", byKey2)
	}
	if v := byKey2["chat"]; v.ok || v.skipped {
		t.Fatalf("chat should fail on unreachable host: %+v", byKey2)
	}

	// 坏密钥：探测失败且错误信息不泄露密钥（mock 对字面量 bad-key 返回 401）。
	var p3 Provider
	env.reauth(t)
	env.mustJSON(t, "POST", "/api/v1/model-providers", map[string]any{
		"name": "坏密钥自检", "base_url": env.mock.URL + "/v1", "api_key": "bad-key", "models": []string{"m1"},
	}, &p3)
	var out3 struct {
		OK      bool `json:"ok"`
		Results []struct {
			Key    string `json:"key"`
			OK     bool   `json:"ok"`
			Detail string `json:"detail"`
		} `json:"results"`
	}
	env.mustJSON(t, "POST", "/api/v1/model-providers/"+p3.ID.String()+"/selftest", nil, &out3)
	if out3.OK {
		t.Fatal("selftest should not pass with bad key")
	}
	for _, r := range out3.Results {
		if strings.Contains(r.Detail, "super-secret-bad-key") {
			t.Fatalf("probe %s leaked the api key: %s", r.Key, r.Detail)
		}
	}
	if byKey3 := out3.Results[0]; byKey3.OK {
		t.Fatal("chat probe should fail with bad key")
	}
}
