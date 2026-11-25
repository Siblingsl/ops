package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

type SearchResult struct {
	Title    string `json:"title"`
	URL      string `json:"url"`
	SiteName string `json:"site_name"`
	Summary  string `json:"summary,omitempty"`
}

type SearchHTTPError struct{ Status int }

func (e *SearchHTTPError) Error() string {
	if e.Status == 402 || e.Status == 429 {
		return fmt.Sprintf("联网搜索服务额度耗尽或触发限流（HTTP %d）", e.Status)
	}
	if e.Status == 401 || e.Status == 403 {
		return fmt.Sprintf("联网搜索服务认证失败或被拒绝（HTTP %d）", e.Status)
	}
	return fmt.Sprintf("联网搜索服务返回 HTTP %d", e.Status)
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
		return nil, Usage{}, &SearchHTTPError{Status: res.StatusCode}
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

// ExternalSearchRequest 描述一次第三方联网搜索调用。Endpoint 由服务端固定或严格校验，
// APIKey 只作为请求头使用，不写入错误信息。
type ExternalSearchRequest struct {
	Engine    string
	Endpoint  string
	APIKey    string
	Query     string
	UserAgent string
}

// SearchExternal 调用 Tavily / 博查 / SearXNG 并返回带真实链接的结果。
// 非 200 一律返回 *SearchHTTPError，绝不读取或拼接上游响应体。
func SearchExternal(ctx context.Context, hc *http.Client, req ExternalSearchRequest) ([]SearchResult, error) {
	switch req.Engine {
	case "tavily", "bocha":
		return searchExternalPost(ctx, hc, req)
	case "searxng":
		return searchExternalSearxng(ctx, hc, req)
	default:
		return nil, fmt.Errorf("不支持的联网搜索方式：%s", req.Engine)
	}
}

func searchExternalPost(ctx context.Context, hc *http.Client, req ExternalSearchRequest) ([]SearchResult, error) {
	body := map[string]any{"query": req.Query}
	if req.Engine == "tavily" {
		body["search_depth"] = "basic"
		body["max_results"] = 10
		body["include_answer"] = false
	} else {
		body["freshness"] = "oneWeek"
		body["summary"] = false
		body["count"] = 10
	}
	b, e := json.Marshal(body)
	if e != nil {
		return nil, e
	}
	hreq, e := http.NewRequestWithContext(ctx, http.MethodPost, req.Endpoint, bytes.NewReader(b))
	if e != nil {
		return nil, e
	}
	hreq.Header.Set("Authorization", "Bearer "+req.APIKey)
	hreq.Header.Set("Content-Type", "application/json")
	res, e := hc.Do(hreq)
	if e != nil {
		return nil, e
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, &SearchHTTPError{Status: res.StatusCode}
	}
	results := []SearchResult{}
	if req.Engine == "tavily" {
		var out struct {
			Results []struct {
				Title   string `json:"title"`
				URL     string `json:"url"`
				Content string `json:"content"`
			} `json:"results"`
		}
		if e = json.NewDecoder(io.LimitReader(res.Body, 4<<20)).Decode(&out); e != nil {
			return nil, e
		}
		for _, r := range out.Results {
			results = append(results, SearchResult{Title: r.Title, URL: r.URL, Summary: r.Content})
		}
	} else {
		var out struct {
			Data struct {
				WebPages struct {
					Value []struct {
						Name     string `json:"name"`
						URL      string `json:"url"`
						Snippet  string `json:"snippet"`
						SiteName string `json:"siteName"`
					} `json:"value"`
				} `json:"webPages"`
			} `json:"data"`
		}
		if e = json.NewDecoder(io.LimitReader(res.Body, 4<<20)).Decode(&out); e != nil {
			return nil, e
		}
		for _, r := range out.Data.WebPages.Value {
			results = append(results, SearchResult{Title: r.Name, URL: r.URL, SiteName: r.SiteName, Summary: r.Snippet})
		}
	}
	if len(results) == 0 {
		return nil, errors.New("搜索服务未返回有效公开链接结果")
	}
	return results, nil
}

func searchExternalSearxng(ctx context.Context, hc *http.Client, req ExternalSearchRequest) ([]SearchResult, error) {
	u, e := url.Parse(req.Endpoint)
	if e != nil {
		return nil, e
	}
	q := u.Query()
	q.Set("q", req.Query)
	q.Set("format", "json")
	u.RawQuery = q.Encode()
	hreq, e := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if e != nil {
		return nil, e
	}
	hreq.Header.Set("Accept", "application/json")
	if req.UserAgent != "" {
		hreq.Header.Set("User-Agent", req.UserAgent)
	}
	if req.APIKey != "" {
		hreq.Header.Set("Authorization", "Bearer "+req.APIKey)
	}
	res, e := hc.Do(hreq)
	if e != nil {
		return nil, e
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, &SearchHTTPError{Status: res.StatusCode}
	}
	var out struct {
		Results []struct {
			Title   string `json:"title"`
			URL     string `json:"url"`
			Content string `json:"content"`
		} `json:"results"`
	}
	if e = json.NewDecoder(io.LimitReader(res.Body, 4<<20)).Decode(&out); e != nil {
		return nil, e
	}
	results := []SearchResult{}
	for _, r := range out.Results {
		results = append(results, SearchResult{Title: r.Title, URL: r.URL, Summary: r.Content})
	}
	if len(results) == 0 {
		return nil, errors.New("搜索服务未返回有效公开链接结果")
	}
	return results, nil
}
