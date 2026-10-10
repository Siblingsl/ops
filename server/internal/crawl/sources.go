package crawl

import (
	"context"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"html"
	"net/url"
	"regexp"
	"strings"
)

type Item struct {
	Title    string `json:"title"`
	URL      string `json:"url"`
	Rank     int    `json:"rank"`
	Heat     string `json:"heat"`
	Category string `json:"category"`
	Summary  string `json:"summary"`
}
type HotSource interface {
	Key() string
	Kind() string
	Fetch(context.Context, Limits) ([]Item, Outcome, error)
}
type Adapter struct {
	Client *Client
	Source Source
}

func (a Adapter) Key() string  { return a.Source.Key }
func (a Adapter) Kind() string { return a.Source.Kind }
func (a Adapter) Fetch(ctx context.Context, l Limits) ([]Item, Outcome, error) {
	var clean []Item
	_, out, err := a.Client.ReadValidated(ctx, a.Source, l, func(b []byte) error {
		var err error
		var items []Item
		if a.Source.Kind == "rss" {
			items, err = ParseRSS(b, a.Source.URL)
		} else if a.Source.Key == "baidu" {
			items, err = ParseBaidu(b)
		} else if a.Source.Key == "toutiao" {
			items, err = ParseToutiao(b)
		} else if a.Source.Kind == "aggregator" {
			err = json.Unmarshal(b, &items)
		} else {
			err = errors.New("未知榜单来源")
		}
		if err != nil {
			return err
		}
		clean = []Item{}
		seen := map[string]bool{}
		for _, item := range items {
			item.Title = strings.TrimSpace(item.Title)
			u, e := url.Parse(item.URL)
			if e != nil || u.Host == "" || u.User != nil || u.Scheme != "https" && u.Scheme != "http" || item.Title == "" || seen[item.Title+item.URL] {
				continue
			}
			seen[item.Title+item.URL] = true
			item.Title = cut(item.Title, 200)
			item.Summary = cut(plain(item.Summary), 500)
			clean = append(clean, item)
			if len(clean) >= l.MaxItems {
				break
			}
		}
		if len(clean) == 0 {
			return errors.New("榜单未返回有效标题和链接，请检查来源页面结构")
		}
		return nil
	})
	return clean, out, err
}
func cut(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n])
	}
	return s
}

var tags = regexp.MustCompile(`<[^>]*>`)

func plain(s string) string {
	return strings.TrimSpace(html.UnescapeString(tags.ReplaceAllString(s, " ")))
}

func ParseBaidu(b []byte) ([]Item, error) {
	// Baidu embeds its public board payload in an s-data HTML comment.
	re := regexp.MustCompile(`(?s)<!--\s*s-data:(.*?)-->`)
	for _, m := range re.FindAllSubmatch(b, -1) {
		var root any
		if json.Unmarshal(m[1], &root) == nil {
			items := jsonBoard(root, "baidu")
			if len(items) > 0 {
				return items, nil
			}
		}
	}
	var root any
	if err := json.Unmarshal(b, &root); err == nil {
		return jsonBoard(root, "baidu"), nil
	}
	return nil, errors.New("百度榜单数据结构已变化")
}
func ParseToutiao(b []byte) ([]Item, error) {
	var root any
	if err := json.Unmarshal(b, &root); err != nil {
		return nil, errors.New("头条榜单不是有效 JSON")
	}
	items := jsonBoard(root, "toutiao")
	if len(items) == 0 {
		return nil, errors.New("头条榜单数据结构已变化")
	}
	return items, nil
}
func jsonBoard(root any, key string) []Item {
	out := []Item{}
	var visit func(any)
	visit = func(v any) {
		switch x := v.(type) {
		case []any:
			for _, a := range x {
				visit(a)
			}
		case map[string]any:
			title, link, heat := "", "", ""
			if key == "baidu" {
				title, _ = x["query"].(string)
				link, _ = x["rawUrl"].(string)
				if link == "" {
					link, _ = x["url"].(string)
				}
				if h, ok := x["hotScore"]; ok {
					heat = fmt.Sprint(h)
				}
			} else {
				title, _ = x["Title"].(string)
				link, _ = x["Url"].(string)
				if h, ok := x["HotValue"]; ok {
					heat = fmt.Sprint(h)
				}
			}
			if title != "" && link != "" {
				out = append(out, Item{Title: title, URL: link, Rank: len(out) + 1, Heat: heat})
				return
			}
			// Keep traversal order deterministic: only known public board container fields.
			for _, k := range []string{"data", "cards", "content", "component", "list", "items"} {
				if value, ok := x[k]; ok {
					visit(value)
				}
			}
		}
	}
	visit(root)
	return out
}

func ParseRSS(b []byte, base string) ([]Item, error) {
	type entry struct {
		Title       string `xml:"title"`
		Link        string `xml:"link"`
		Description string `xml:"description"`
	}
	var rss struct {
		Channel struct {
			Items []entry `xml:"item"`
		} `xml:"channel"`
	}
	if err := xml.Unmarshal(b, &rss); err != nil {
		return nil, errors.New("无效 RSS / Atom")
	}
	out := []Item{}
	for _, e := range rss.Channel.Items {
		out = append(out, Item{Title: e.Title, URL: absolute(base, e.Link), Rank: len(out) + 1, Summary: e.Description})
	}
	if len(out) > 0 {
		return out, nil
	}
	var atom struct {
		Entries []struct {
			Title string `xml:"title"`
			Links []struct {
				Href string `xml:"href,attr"`
				Rel  string `xml:"rel,attr"`
			} `xml:"link"`
			Summary string `xml:"summary"`
		} `xml:"entry"`
	}
	if err := xml.Unmarshal(b, &atom); err != nil {
		return nil, err
	}
	for _, e := range atom.Entries {
		link := ""
		for _, l := range e.Links {
			if l.Rel == "" || l.Rel == "alternate" {
				link = l.Href
				break
			}
		}
		out = append(out, Item{Title: e.Title, URL: absolute(base, link), Rank: len(out) + 1, Summary: e.Summary})
	}
	return out, nil
}
func absolute(base, link string) string {
	b, e := url.Parse(base)
	if e != nil {
		return ""
	}
	u, e := url.Parse(strings.TrimSpace(link))
	if e != nil || link == "" {
		return ""
	}
	return b.ResolveReference(u).String()
}
