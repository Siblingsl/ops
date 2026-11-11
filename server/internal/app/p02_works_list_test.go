package app

import (
	"context"
	"testing"
)

func TestP02WorkListAggregatesMatchSingleWorkDetail(t *testing.T) {
	account := env.accounts(t).wechat
	var source Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+account.ID.String()+"/works", map[string]string{"title": "P02 源作品"}, &source)
	if _, err := env.srv.db.Exec(context.Background(), `INSERT INTO work_section(work_id,position,heading,content_md)
		VALUES($1,1,'段','一二三四五六七八九十')`, source.ID); err != nil {
		t.Fatal(err)
	}
	var derivedID string
	if err := env.srv.db.QueryRow(context.Background(), `INSERT INTO work(account_id,content_format,title,source_work_id)
		VALUES($1,'long_article','P02 衍生',$2) RETURNING id::text`, account.ID, source.ID).Scan(&derivedID); err != nil {
		t.Fatal(err)
	}

	var list []WorkListItem
	env.mustJSON(t, "GET", "/api/v1/accounts/"+account.ID.String()+"/works?limit=50", nil, &list)
	var got *WorkListItem
	for i := range list {
		if list[i].ID == source.ID {
			got = &list[i]
			break
		}
	}
	if got == nil {
		t.Fatal("source work missing from list")
	}
	if got.DerivedCount != 1 {
		t.Fatalf("derived_count=%d, want 1 (derived=%s)", got.DerivedCount, derivedID)
	}
	if got.SectionCount != 1 || got.CharCount != 10 {
		t.Fatalf("section aggregates = sections=%d chars=%d, want 1/10", got.SectionCount, got.CharCount)
	}
}
