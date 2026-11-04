package app

import (
	"context"
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

func TestOPT36PublishedWorkTagsCanUpdateWithoutUnlocking(t *testing.T) {
	var account Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{
		"platform": "wechat_mp", "name": "OPT36 已发布作品标签", "content_format": "long_article",
	}, &account)
	var work Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+account.ID.String()+"/works", map[string]string{"title": "已发布作品"}, &work)
	if _, err := env.srv.db.Exec(context.Background(), `UPDATE work SET status='published',locked=true,published_at=now() WHERE id=$1`, work.ID); err != nil {
		t.Fatalf("lock published work: %v", err)
	}

	revision := work.Revision
	tag := "published-opt36-" + uuid.NewString()
	env.mustJSON(t, "PATCH", "/api/v1/works/"+work.ID.String(), map[string][]string{"tags": {tag}}, &work)
	if len(work.Tags) != 1 || work.Tags[0] != tag {
		t.Fatalf("published work tags = %#v, want %#v", work.Tags, tag)
	}
	if work.Revision != revision || !work.Locked || work.Status != "published" {
		t.Fatalf("metadata update changed published content state: revision=%d locked=%v status=%s", work.Revision, work.Locked, work.Status)
	}

	env.expectErr(t, "PATCH", "/api/v1/works/"+work.ID.String(), map[string]any{
		"tags": []string{"must-not-apply"}, "title": "不应绕过已发布锁定",
	}, "state_invalid")
	var after Work
	env.mustJSON(t, "GET", "/api/v1/works/"+work.ID.String(), nil, &after)
	if after.Title != "已发布作品" || len(after.Tags) != 1 || after.Tags[0] != tag || after.Revision != revision || !after.Locked {
		t.Fatalf("mixed content update changed published work: %+v", after)
	}
}
