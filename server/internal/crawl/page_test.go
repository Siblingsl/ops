package crawl

import (
	"strings"
	"testing"
)

func TestPagePublicFieldsExcludeComments(t *testing.T) {
	p, err := ParsePage([]byte(`<html><head><title>单篇公开文章</title><meta name="author" content="作者昵称"><meta property="article:published_time" content="2026-10-10"></head><body><article data-like-count="12" data-collect-count="3" data-comment-count="2">公开正文 #实践<img src="https://example.com/a"><div class="comments">评论者隐私内容<img src="https://example.com/avatar"></div></article></body></html>`))
	if err != nil || p.Author != "作者昵称" || p.PublishedAt != "2026-10-10" || strings.Contains(p.Body, "评论者") || p.Metrics["like_count"] != 12 {
		t.Fatalf("page fields: %+v %v", p, err)
	}
	if p.Metrics["image_count"] != 1 {
		t.Fatalf("comment avatar counted: %+v", p.Metrics)
	}
}
