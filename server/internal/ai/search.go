package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
)

type SearchResult struct {
	Title    string `json:"title"`
	URL      string `json:"url"`
	SiteName string `json:"site_name"`
}

// Search uses the verified DashScope native contract. Generated prose is never treated as search evidence.
func Search(ctx context.Context, hc *http.Client, endpoint, key, model, query string) ([]SearchResult, Usage, error) {
	body := map[string]any{"model": model, "input": map[string]any{"messages": []Message{{Role: "user", Content: query}}}, "parameters": map[string]any{"enable_search": true, "result_format": "message", "search_options": map[string]bool{"enable_source": true, "forced_search": true}}}
	responses := strings.HasSuffix(endpoint, "/responses")
	if responses {
		body = map[string]any{"model": model, "stream": false, "input": []Message{{Role: "user", Content: query}}, "tools": []map[string]any{{"type": "web_search", "sources": []string{"doubao"}, "limit": 10}}, "max_tool_calls": 1}
	}
	b, _ := json.Marshal(body)
	req, e := http.NewRequestWithContext(ctx, "POST", endpoint, bytes.NewReader(b))
	if e != nil {
		return nil, Usage{}, e
	}
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Content-Type", "application/json")
	res, e := hc.Do(req)
	if e != nil {
		return nil, Usage{}, e
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return nil, Usage{}, fmt.Errorf("联网搜索服务返回 HTTP %d", res.StatusCode)
	}
	if responses {
		var out struct {
			Output []struct {
				Type    string `json:"type"`
				Status  string `json:"status"`
				Content []struct {
					Annotations []struct {
						Type  string `json:"type"`
						Title string `json:"title"`
						URL   string `json:"url"`
					} `json:"annotations"`
				} `json:"content"`
			} `json:"output"`
			Usage struct {
				Input  int `json:"input_tokens"`
				Output int `json:"output_tokens"`
			} `json:"usage"`
		}
		if e = json.NewDecoder(io.LimitReader(res.Body, 4<<20)).Decode(&out); e != nil {
			return nil, Usage{}, e
		}
		ran := false
		results := []SearchResult{}
		for _, x := range out.Output {
			if x.Type == "web_search_call" && x.Status == "completed" {
				ran = true
			}
			for _, c := range x.Content {
				for _, a := range c.Annotations {
					if a.Type == "url_citation" {
						results = append(results, SearchResult{Title: a.Title, URL: a.URL})
					}
				}
			}
		}
		usage := Usage{PromptTokens: out.Usage.Input, CompletionTokens: out.Usage.Output}
		if !ran || len(results) == 0 {
			return nil, usage, errors.New("服务没有已完成的搜索调用与来源引用，不能使用普通回答作为热点")
		}
		return results, usage, nil
	}
	var out struct {
		Output struct {
			SearchInfo struct {
				Results []SearchResult `json:"search_results"`
			} `json:"search_info"`
		} `json:"output"`
		Usage struct {
			Input  int `json:"input_tokens"`
			Output int `json:"output_tokens"`
		} `json:"usage"`
	}
	if e = json.NewDecoder(io.LimitReader(res.Body, 4<<20)).Decode(&out); e != nil {
		return nil, Usage{}, e
	}
	usage := Usage{PromptTokens: out.Usage.Input, CompletionTokens: out.Usage.Output}
	if len(out.Output.SearchInfo.Results) == 0 {
		return nil, usage, errors.New("服务未返回可核验搜索来源，不能使用模型回答代替真实热点")
	}
	return out.Output.SearchInfo.Results, usage, nil
}
