package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/google/uuid"
)

func cl01CreateRestoreWork(t *testing.T, withCard bool) (Work, uuid.UUID, uuid.UUID) {
	t.Helper()
	f := env.accounts(t)
	var work Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+f.wechat.ID.String()+"/works", map[string]string{"title": "当前标题"}, &work)

	sectionID, cardID := uuid.New(), uuid.New()
	_, err := env.srv.db.Exec(context.Background(), `INSERT INTO work_section (id, work_id, position, heading, content_md)
		VALUES ($1, $2, 0, '当前段落', '当前正文')`, sectionID, work.ID)
	if err != nil {
		t.Fatal(err)
	}
	if withCard {
		if _, err := env.srv.db.Exec(context.Background(), `INSERT INTO work_card (id, work_id, section_id, position)
			VALUES ($1, $2, $3, 0)`, cardID, work.ID, sectionID); err != nil {
			t.Fatal(err)
		}
	}
	return work, sectionID, cardID
}

func cl01SaveVersion(t *testing.T, workID uuid.UUID, versionNo int, snapshot any) {
	t.Helper()
	raw, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(context.Background(), `INSERT INTO work_version (work_id, version_no, snapshot, reason)
		VALUES ($1, $2, $3::jsonb, 'manual')`, workID, versionNo, string(raw)); err != nil {
		t.Fatal(err)
	}
}

func TestCL01RestoreRejectsUnsupportedSnapshotBeforeDeletingStructures(t *testing.T) {
	work, sectionID, cardID := cl01CreateRestoreWork(t, true)
	oldSection := Section{ID: uuid.New(), Position: 0, Heading: "旧段落", ContentMD: "旧正文", Origin: "human", SourceSectionIDs: []uuid.UUID{}, MaterialIDs: []uuid.UUID{}}
	snapshots := []any{
		map[string]any{"title": "缺少段落字段", "summary": "旧摘要", "viewpoint": "旧观点", "outline": []any{}},
		map[string]any{"schema_version": 2, "title": "未知结构版本", "summary": "旧摘要", "viewpoint": "旧观点", "outline": []any{}, "sections": []any{}},
		map[string]any{"title": "旧文字快照", "summary": "旧摘要", "viewpoint": "旧观点", "outline": []any{}, "sections": []Section{oldSection}},
	}

	for i, snapshot := range snapshots {
		versionNo := i + 1
		cl01SaveVersion(t, work.ID, versionNo, snapshot)
		path := fmt.Sprintf("/api/v1/works/%s/versions/%d/restore", work.ID, versionNo)
		status, body := env.do(http.MethodPost, path, nil)
		var failure apiError
		if err := json.Unmarshal(body, &failure); err != nil {
			t.Fatalf("decode restore error: %v (%s)", err, body)
		}
		if status != http.StatusConflict || failure.Error.Code != "version_restore_unsupported" {
			t.Fatalf("restore version %d: want unsupported conflict, got %d %s", versionNo, status, body)
		}

		var title, content string
		var sectionCount, cardCount, versionCount int
		if err := env.srv.db.QueryRow(context.Background(), `SELECT w.title,
			(SELECT count(*) FROM work_section WHERE work_id=w.id),
			coalesce((SELECT content_md FROM work_section WHERE id=$2), ''),
			(SELECT count(*) FROM work_card WHERE work_id=w.id AND id=$3),
			(SELECT count(*) FROM work_version WHERE work_id=w.id)
			FROM work w WHERE w.id=$1`, work.ID, sectionID, cardID).Scan(&title, &sectionCount, &content, &cardCount, &versionCount); err != nil {
			t.Fatal(err)
		}
		if title != "当前标题" || sectionCount != 1 || content != "当前正文" || cardCount != 1 || versionCount != versionNo {
			t.Fatalf("unsupported restore changed current work: title=%q sections=%d content=%q cards=%d versions=%d",
				title, sectionCount, content, cardCount, versionCount)
		}
	}
}

func TestCL01RestoreKeepsCompleteV1TextSnapshotCompatibility(t *testing.T) {
	work, _, _ := cl01CreateRestoreWork(t, false)
	oldSection := Section{ID: uuid.New(), Position: 0, Heading: "旧段落", ContentMD: "旧正文", Origin: "human", SourceSectionIDs: []uuid.UUID{}, MaterialIDs: []uuid.UUID{}}
	cl01SaveVersion(t, work.ID, 1, map[string]any{
		"title": "旧标题", "summary": "旧摘要", "viewpoint": "旧观点", "outline": []any{}, "sections": []Section{oldSection},
	})

	var restored Work
	env.mustJSON(t, http.MethodPost, fmt.Sprintf("/api/v1/works/%s/versions/1/restore", work.ID), nil, &restored)
	if restored.Title != "旧标题" || len(restored.Sections) != 1 || restored.Sections[0].ID != oldSection.ID || restored.Sections[0].ContentMD != "旧正文" {
		t.Fatalf("complete v1 text snapshot not restored: %+v", restored)
	}
}
