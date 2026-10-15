package app

import (
	"context"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestOPT42DropsSeriesBeforeCompressingOutline(t *testing.T) {
	a := opt42Account(t)
	path := "/api/v1/accounts/" + a.ID.String()
	var series Series
	env.mustJSON(t, "POST", path+"/series", map[string]string{"name": "系列预算验收", "outline": strings.Repeat("系列相邻观点", 60)}, &series)
	var topic struct {
		Topic Topic `json:"topic"`
	}
	env.mustJSON(t, "POST", path+"/topics", map[string]any{"title": "系列当前作品", "series_id": series.ID.String()}, &topic)
	env.mustJSON(t, "PATCH", "/api/v1/topics/"+topic.Topic.ID.String(), map[string]string{"status": "adopted"}, nil)
	var work Work
	env.mustJSON(t, "POST", "/api/v1/topics/"+topic.Topic.ID.String()+"/works", nil, &work)
	viewpoint := strings.Repeat("作者观点", 675)
	env.mustJSON(t, "PATCH", "/api/v1/works/"+work.ID.String(), map[string]any{"viewpoint": viewpoint, "base_revision": work.Revision}, &work)
	items := []OutlineItem{{Heading: "当前段", KeyPoint: strings.Repeat("本段要点", 20)}, {Heading: "另一段", KeyPoint: strings.Repeat("其他要点", 20)}}
	env.mustJSON(t, "PUT", "/api/v1/works/"+work.ID.String()+"/outline", map[string]any{"items": items, "confirm": true, "base_revision": work.Revision}, &work)
	ctx := context.Background()
	var ws uuid.UUID
	if err := env.srv.db.QueryRow(ctx, `SELECT workspace_id FROM platform_account WHERE id=$1`, a.ID).Scan(&ws); err != nil {
		t.Fatal(err)
	}
	ctx = context.WithValue(ctx, ctxMember, &identity{WorkspaceID: ws})
	meta, err := env.srv.workMeta(ctx, work.ID)
	if err != nil {
		t.Fatal(err)
	}
	brief, err := env.srv.workBriefForSection(ctx, meta, &work.Sections[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(brief, "系列上下文") || strings.Contains(brief, "其他段仅保留小标题") || !strings.Contains(brief, items[1].KeyPoint) || !strings.Contains(brief, viewpoint) {
		t.Fatalf("series must be dropped before outline details: %s", brief)
	}
}
