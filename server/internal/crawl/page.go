package crawl

import (
	"context"
	"errors"
	"golang.org/x/net/html"
	"strconv"
	"strings"
)

// ParseMetadata stops at the head; no article, comment, or personal text is extracted.
func ParseMetadata(b []byte) (Page, error) {
	p := Page{}
	z := html.NewTokenizer(strings.NewReader(string(b)))
	title := false
	for {
		tt := z.Next()
		if tt == html.ErrorToken {
			break
		}
		token := z.Token()
		switch tt {
		case html.StartTagToken, html.SelfClosingTagToken:
			if token.Data == "body" {
				if p.Title == "" {
					return p, errors.New("原文没有标题元数据")
				}
				return p, nil
			}
			if token.Data == "title" {
				title = true
			}
			if token.Data == "meta" {
				a := map[string]string{}
				for _, v := range token.Attr {
					a[v.Key] = v.Val
				}
				switch a["name"] + a["property"] {
				case "description", "og:description":
					p.Summary = cut(a["content"], 500)
				case "og:title":
					p.Title = cut(a["content"], 200)
				}
			}
		case html.EndTagToken:
			if token.Data == "title" {
				title = false
			}
			if token.Data == "head" {
				if p.Title == "" {
					return p, errors.New("原文没有标题元数据")
				}
				return p, nil
			}
		case html.TextToken:
			if title {
				p.Title += cut(token.Data, 200)
			}
		}
	}
	if p.Title == "" {
		return p, errors.New("原文没有标题元数据")
	}
	return p, nil
}

func (a Adapter) FetchPage(ctx context.Context, l Limits) (Page, Outcome, error) {
	var page Page
	if a.Source.Kind != "xhs_page" && a.Source.Kind != "wechat_page" {
		return page, Outcome{}, errors.New("页面须进入敏感平台队列")
	}
	_, out, err := a.Client.ReadValidated(ctx, a.Source, l, func(b []byte) error { var e error; page, e = ParsePage(b); return e })
	return page, out, err
}

type Page struct {
	Title       string         `json:"title"`
	Author      string         `json:"author"`
	PublishedAt string         `json:"published_at"`
	Summary     string         `json:"summary"`
	Body        string         `json:"-"`
	Metrics     map[string]int `json:"metrics"`
}

// ParsePage extracts only the visible article subtree. Comments, scripts, and profile links are ignored.
func ParsePage(b []byte) (Page, error) {
	p := Page{Metrics: map[string]int{}}
	root, e := html.Parse(strings.NewReader(string(b)))
	if e != nil {
		return p, e
	}
	var article *html.Node
	var text func(*html.Node) string
	text = func(n *html.Node) string {
		if n.Type == html.ElementNode && (n.Data == "script" || n.Data == "style" || n.Data == "noscript" || n.Data == "aside" || n.Data == "nav") {
			return ""
		}
		for _, attr := range n.Attr {
			if (attr.Key == "class" || attr.Key == "id") && strings.Contains(strings.ToLower(attr.Val), "comment") {
				return ""
			}
		}
		if n.Type == html.TextNode {
			return n.Data + " "
		}
		var s strings.Builder
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			s.WriteString(text(c))
		}
		return s.String()
	}
	var visit func(*html.Node)
	visit = func(n *html.Node) {
		if n.Type == html.ElementNode {
			attrs := map[string]string{}
			for _, a := range n.Attr {
				attrs[a.Key] = a.Val
			}
			if n.Data == "title" {
				p.Title = strings.TrimSpace(text(n))
			}
			if n.Data == "meta" {
				switch attrs["name"] + attrs["property"] {
				case "description", "og:description":
					p.Summary = attrs["content"]
				case "author":
					p.Author = attrs["content"]
				case "article:published_time":
					p.PublishedAt = attrs["content"]
				case "og:title":
					p.Title = attrs["content"]
				}
			}
			if n.Data == "article" || attrs["id"] == "js_content" || attrs["id"] == "detail-desc" {
				if article == nil {
					article = n
				}
			}
			for _, key := range []string{"like", "collect", "comment"} {
				if count, err := strconv.Atoi(attrs["data-"+key+"-count"]); err == nil && count >= 0 {
					p.Metrics[key+"_count"] = count
				}
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			visit(c)
		}
	}
	visit(root)
	if article != nil {
		p.Body = cut(strings.TrimSpace(text(article)), 20000)
		var images func(*html.Node)
		images = func(n *html.Node) {
			for _, attr := range n.Attr {
				if (attr.Key == "class" || attr.Key == "id") && strings.Contains(strings.ToLower(attr.Val), "comment") {
					return
				}
			}
			if n.Type == html.ElementNode && n.Data == "img" {
				p.Metrics["image_count"]++
			}
			for c := n.FirstChild; c != nil; c = c.NextSibling {
				images(c)
			}
		}
		images(article)
	}
	p.Title = cut(p.Title, 200)
	p.Summary = cut(p.Summary, 500)
	p.Author = cut(p.Author, 100)
	if p.Title == "" || p.Body == "" {
		return p, errors.New("页面没有免登录可见的文章正文")
	}
	return p, nil
}
