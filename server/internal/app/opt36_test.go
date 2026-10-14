package app

import (
	"net/url"
	"testing"

	"github.com/google/uuid"
)

func TestOPT36WorkTagsUpdateListAndGlobalSearch(t *testing.T) {
	var account Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{
		"platform": "wechat_mp", "name": "OPT36 作品标签", "content_format": "long_article",
	}, &account)
	var work Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+account.ID.String()+"/works", map[string]string{"title": "作品标签回归"}, &work)
	revision := work.Revision

	tag := "opt36-" + uuid.NewString()
	env.mustJSON(t, "PATCH", "/api/v1/works/"+work.ID.String(), map[string][]string{
		"tags": {" " + tag + " ", "主题", "主题"},
	}, &work)
	if len(work.Tags) != 2 || work.Tags[0] != tag || work.Tags[1] != "主题" {
		t.Fatalf("updated tags = %#v, want trimmed, unique tags", work.Tags)
	}
	if work.Revision != revision {
		t.Fatalf("metadata-only tag update changed revision from %d to %d", revision, work.Revision)
	}

	var list []WorkListItem
	env.mustJSON(t, "GET", "/api/v1/accounts/"+account.ID.String()+"/works", nil, &list)
	if len(list) != 1 || list[0].ID != work.ID || len(list[0].Tags) != 2 || list[0].Tags[0] != tag {
		t.Fatalf("work list tags = %#v", list)
	}
	var search struct {
		Items []SearchHit `json:"items"`
	}
	env.mustJSON(t, "GET", "/api/v1/search?q="+url.QueryEscape(tag)+"&types=work", nil, &search)
	if len(search.Items) != 1 || search.Items[0].ID != work.ID {
		t.Fatalf("tag search items = %#v", search.Items)
	}

	env.mustJSON(t, "PATCH", "/api/v1/works/"+work.ID.String(), map[string][]string{"tags": {}}, &work)
	if len(work.Tags) != 0 {
		t.Fatalf("removed tags = %#v, want empty", work.Tags)
	}
	search = struct {
		Items []SearchHit `json:"items"`
	}{}
	env.mustJSON(t, "GET", "/api/v1/search?q="+url.QueryEscape(tag)+"&types=work", nil, &search)
	if len(search.Items) != 0 {
		t.Fatalf("removed tag still returned search results: %#v", search.Items)
	}
}
