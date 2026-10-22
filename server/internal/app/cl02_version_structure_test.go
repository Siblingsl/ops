package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func latestVersionNo(t *testing.T, workID string) int {
	t.Helper()
	var versions []struct {
		VersionNo int `json:"version_no"`
	}
	env.mustJSON(t, http.MethodGet, "/api/v1/works/"+workID+"/versions", nil, &versions)
	if len(versions) == 0 {
		t.Fatal("work has no version")
	}
	return versions[0].VersionNo
}

func TestCL02CardVersionSnapshotAndRestoreKeepAssociations(t *testing.T) {
	_, work := buildCardWork(t, "xhs")
	workID := work.ID.String()
	env.mustJSON(t, http.MethodPost, "/api/v1/works/"+workID+"/versions", nil, nil)
	versionNo := latestVersionNo(t, workID)

	var saved struct {
		Snapshot       map[string]json.RawMessage `json:"snapshot"`
		RestorePreview versionRestorePreview      `json:"restore_preview"`
	}
	env.mustJSON(t, http.MethodGet, fmt.Sprintf("/api/v1/works/%s/versions/%d", workID, versionNo), nil, &saved)
	if !saved.RestorePreview.Supported || saved.RestorePreview.CurrentRevision != work.Revision {
		t.Fatalf("current card version should be restorable: %+v", saved.RestorePreview)
	}
	var schemaVersion int
	if err := json.Unmarshal(saved.Snapshot["schema_version"], &schemaVersion); err != nil || schemaVersion != 2 {
		t.Fatalf("card work snapshot schema_version = %d, err=%v", schemaVersion, err)
	}
	var cards []struct {
		ID           uuid.UUID  `json:"id"`
		SectionID    uuid.UUID  `json:"section_id"`
		ImageAssetID *uuid.UUID `json:"image_asset_id"`
	}
	if err := json.Unmarshal(saved.Snapshot["cards"], &cards); err != nil || len(cards) != len(work.Cards) {
		t.Fatalf("card structure missing from snapshot: count=%d err=%v", len(cards), err)
	}
	extraAssetID := uuid.New()
	if _, err := env.srv.db.Exec(context.Background(), `INSERT INTO asset(id,workspace_id,account_id,work_id,storage_path,mime,width,height,bytes,sha256,position)
		SELECT $1,workspace_id,account_id,work_id,storage_path,mime,width,height,bytes,sha256,position+1 FROM asset WHERE id=$2`, extraAssetID, work.Assets[0].ID); err != nil {
		t.Fatal(err)
	}
	var previewAfterUpload versionRestorePreview
	env.mustJSON(t, http.MethodGet, fmt.Sprintf("/api/v1/works/%s/versions/%d", workID, versionNo), nil, &struct {
		RestorePreview *versionRestorePreview `json:"restore_preview"`
	}{RestorePreview: &previewAfterUpload})
	if previewAfterUpload.PreservedAdditionalAssets != 1 {
		t.Fatalf("preview should disclose the asset uploaded after the snapshot: %+v", previewAfterUpload)
	}

	sectionID := work.Sections[0].ID
	card := work.Cards[0]
	var author uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(), `SELECT id FROM app_user ORDER BY created_at LIMIT 1`).Scan(&author); err != nil {
		t.Fatal(err)
	}
	commentID := uuid.New()
	if _, err := env.srv.db.Exec(context.Background(), `INSERT INTO comment(id,work_id,section_id,author_id,body) VALUES($1,$2,$3,$4,'保留批注')`, commentID, work.ID, sectionID, author); err != nil {
		t.Fatal(err)
	}

	var current Work
	env.mustJSON(t, http.MethodGet, "/api/v1/works/"+workID, nil, &current)
	newTitle := "后续修改标题"
	env.mustJSON(t, http.MethodPatch, "/api/v1/works/"+workID, map[string]any{"title": newTitle, "base_revision": current.Revision}, &current)
	if _, err := env.srv.db.Exec(context.Background(), `UPDATE work_card SET image_asset_id=NULL WHERE id=$1`, card.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(context.Background(), `UPDATE asset SET position=position+20 WHERE work_id=$1`, work.ID); err != nil {
		t.Fatal(err)
	}
	baseRevision := current.Revision
	var restored Work
	env.mustJSON(t, http.MethodPost, fmt.Sprintf("/api/v1/works/%s/versions/%d/restore", workID, versionNo), map[string]int{"base_revision": baseRevision}, &restored)
	if restored.Title != work.Title || len(restored.Cards) != len(work.Cards) || restored.Cards[0].ID != card.ID || restored.Cards[0].ImageAssetID == nil || *restored.Cards[0].ImageAssetID != *card.ImageAssetID {
		t.Fatalf("card structure was not restored: title=%q cards=%+v", restored.Title, restored.Cards)
	}
	if restored.OutlineConfirmedAt == nil || work.OutlineConfirmedAt == nil || !restored.OutlineConfirmedAt.Equal(*work.OutlineConfirmedAt) {
		t.Fatalf("same outline should keep the current H-03 confirmation: before=%v after=%v", work.OutlineConfirmedAt, restored.OutlineConfirmedAt)
	}
	var commentSection *uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(), `SELECT section_id FROM comment WHERE id=$1`, commentID).Scan(&commentSection); err != nil {
		t.Fatal(err)
	}
	if commentSection == nil || *commentSection != sectionID {
		t.Fatalf("restore orphaned the existing comment: section_id=%v", commentSection)
	}
	var assetPosition int
	if err := env.srv.db.QueryRow(context.Background(), `SELECT position FROM asset WHERE id=$1`, work.Assets[0].ID).Scan(&assetPosition); err != nil {
		t.Fatal(err)
	}
	if assetPosition != work.Assets[0].Position {
		t.Fatalf("asset order was not restored: got %d, want %d", assetPosition, work.Assets[0].Position)
	}
	if err := env.srv.db.QueryRow(context.Background(), `SELECT position FROM asset WHERE id=$1 AND work_id=$2`, extraAssetID, work.ID).Scan(&assetPosition); err != nil {
		t.Fatal(err)
	}
	if assetPosition < len(work.Assets) {
		t.Fatalf("asset uploaded after snapshot should be preserved after historical assets, got position %d", assetPosition)
	}
}

func TestCL02RestoreRejectsMissingSnapshotAssetBeforeAnyChange(t *testing.T) {
	_, work := buildCardWork(t, "xhs")
	workID := work.ID.String()
	env.mustJSON(t, http.MethodPost, "/api/v1/works/"+workID+"/versions", nil, nil)
	versionNo := latestVersionNo(t, workID)
	missingAssetID := *work.Cards[0].ImageAssetID
	var storagePath string
	if err := env.srv.db.QueryRow(context.Background(), `SELECT storage_path FROM asset WHERE id=$1`, missingAssetID).Scan(&storagePath); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(context.Background(), `DELETE FROM asset WHERE id=$1`, missingAssetID); err != nil {
		t.Fatal(err)
	}
	removeAssetFiles(env.srv.cfg.DataDir, storagePath)
	var preview struct {
		RestorePreview versionRestorePreview `json:"restore_preview"`
	}
	env.mustJSON(t, http.MethodGet, fmt.Sprintf("/api/v1/works/%s/versions/%d", workID, versionNo), nil, &preview)
	if preview.RestorePreview.Supported || !strings.Contains(strings.Join(preview.RestorePreview.MissingDependencies, ","), missingAssetID.String()) {
		t.Fatalf("preview should identify the missing image: %+v", preview.RestorePreview)
	}
	var current Work
	env.mustJSON(t, http.MethodGet, "/api/v1/works/"+workID, nil, &current)
	newTitle := "不能被覆盖的当前稿"
	env.mustJSON(t, http.MethodPatch, "/api/v1/works/"+workID, map[string]any{"title": newTitle, "base_revision": current.Revision}, &current)
	var versionsBefore int
	if err := env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM work_version WHERE work_id=$1`, work.ID).Scan(&versionsBefore); err != nil {
		t.Fatal(err)
	}
	status, body := env.do(http.MethodPost, fmt.Sprintf("/api/v1/works/%s/versions/%d/restore", workID, versionNo), map[string]int{"base_revision": current.Revision})
	if status != http.StatusConflict || !strings.Contains(string(body), `"code":"version_restore_unsupported"`) || !strings.Contains(string(body), missingAssetID.String()) {
		t.Fatalf("restore with a missing snapshot image should explain the dependency and fail atomically: %d %s", status, body)
	}
	var title string
	var versionCount int
	var cardImageID *uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(), `SELECT w.title,
		(SELECT count(*) FROM work_version WHERE work_id=w.id),
		(SELECT image_asset_id FROM work_card WHERE id=$2)
		FROM work w WHERE w.id=$1`, work.ID, work.Cards[0].ID).Scan(&title, &versionCount, &cardImageID); err != nil {
		t.Fatal(err)
	}
	if title != newTitle || versionCount != versionsBefore || cardImageID == nil || *cardImageID != missingAssetID {
		t.Fatalf("missing dependency partially restored current work: title=%q versionCount=%d cardImage=%v", title, versionCount, cardImageID)
	}
}

func TestCL02ComicVersionSnapshotRestoresPanelsAndOnlyInvalidatesChangedOutline(t *testing.T) {
	var account Account
	env.mustJSON(t, http.MethodPost, "/api/v1/accounts", map[string]any{"platform": "xhs", "name": "版本漫画号", "content_format": "comic"}, &account)
	var work Work
	env.mustJSON(t, http.MethodPost, "/api/v1/accounts/"+account.ID.String()+"/works", map[string]string{"title": "漫画原题"}, &work)
	outline := []map[string]any{{"heading": "第一幕", "key_point": "保持语义", "material_ids": []string{}}}
	outlineJSON, _ := json.Marshal(outline)
	if _, err := env.srv.db.Exec(context.Background(), `UPDATE work SET outline=$2, outline_confirmed_at=now() WHERE id=$1`, work.ID, outlineJSON); err != nil {
		t.Fatal(err)
	}
	panelID := uuid.New()
	bubbles := []Bubble{{Text: "原台词", X: .1, Y: .2, W: .3, H: .2}}
	bubbleJSON, _ := json.Marshal(bubbles)
	if _, err := env.srv.db.Exec(context.Background(), `INSERT INTO comic_panel(id,work_id,position,scene,character_ids,action,shot,narration,dialogue,image_prompt,bubbles)
		VALUES($1,$2,0,'原场景','{}','原动作','近景','旁白','原对白','提示',$3)`, panelID, work.ID, bubbleJSON); err != nil {
		t.Fatal(err)
	}
	env.mustJSON(t, http.MethodPost, "/api/v1/works/"+work.ID.String()+"/versions", nil, nil)
	versionNo := latestVersionNo(t, work.ID.String())
	var saved struct {
		Snapshot map[string]json.RawMessage `json:"snapshot"`
	}
	env.mustJSON(t, http.MethodGet, fmt.Sprintf("/api/v1/works/%s/versions/%d", work.ID, versionNo), nil, &saved)
	var panels []ComicPanel
	if err := json.Unmarshal(saved.Snapshot["panels"], &panels); err != nil || len(panels) != 1 || panels[0].ID != panelID || len(panels[0].Bubbles) != 1 {
		t.Fatalf("comic snapshot lost panel/bubbles: panels=%+v err=%v", panels, err)
	}
	if _, err := env.srv.db.Exec(context.Background(), `UPDATE comic_panel SET dialogue='新对白' WHERE id=$1`, panelID); err != nil {
		t.Fatal(err)
	}
	var latest Work
	env.mustJSON(t, http.MethodGet, "/api/v1/works/"+work.ID.String(), nil, &latest)
	baseRevision := latest.Revision
	var restored Work
	env.mustJSON(t, http.MethodPost, fmt.Sprintf("/api/v1/works/%s/versions/%d/restore", work.ID, versionNo), map[string]int{"base_revision": baseRevision}, &restored)
	if len(restored.Panels) != 1 || restored.Panels[0].ID != panelID || restored.Panels[0].Dialogue != "原对白" || len(restored.Panels[0].Bubbles) != 1 || restored.OutlineConfirmedAt == nil {
		t.Fatalf("comic panel restore or unchanged-outline confirmation failed: %+v", restored)
	}

	changedOutline := []map[string]any{{"heading": "第一幕", "key_point": "语义已经改变", "material_ids": []string{}}}
	changedJSON, _ := json.Marshal(changedOutline)
	if _, err := env.srv.db.Exec(context.Background(), `UPDATE work SET outline=$2, revision=revision+1 WHERE id=$1`, work.ID, changedJSON); err != nil {
		t.Fatal(err)
	}
	env.mustJSON(t, http.MethodGet, "/api/v1/works/"+work.ID.String(), nil, &latest)
	env.mustJSON(t, http.MethodPost, fmt.Sprintf("/api/v1/works/%s/versions/%d/restore", work.ID, versionNo), map[string]int{"base_revision": latest.Revision}, &restored)
	if restored.OutlineConfirmedAt != nil {
		t.Fatalf("changed outline must require H-03 confirmation again, got %v", restored.OutlineConfirmedAt)
	}
}

func TestCL02RestoreRejectsStaleWorkRevision(t *testing.T) {
	work, _, _ := cl01CreateRestoreWork(t, false)
	workID := work.ID.String()
	env.mustJSON(t, http.MethodPost, "/api/v1/works/"+workID+"/versions", nil, nil)
	versionNo := latestVersionNo(t, workID)
	var current Work
	env.mustJSON(t, http.MethodGet, "/api/v1/works/"+workID, nil, &current)
	staleRevision := current.Revision
	newTitle := "并发修改后的标题"
	env.mustJSON(t, http.MethodPatch, "/api/v1/works/"+workID, map[string]any{"title": newTitle, "base_revision": current.Revision}, &current)
	var versionsBefore int
	if err := env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM work_version WHERE work_id=$1`, work.ID).Scan(&versionsBefore); err != nil {
		t.Fatal(err)
	}
	status, body := env.do(http.MethodPost, fmt.Sprintf("/api/v1/works/%s/versions/%d/restore", workID, versionNo), map[string]int{"base_revision": staleRevision})
	if status != http.StatusConflict || !strings.Contains(string(body), `"code":"version_conflict"`) {
		t.Fatalf("stale restore should conflict: %d %s", status, body)
	}
	var title string
	var versionsAfter int
	if err := env.srv.db.QueryRow(context.Background(), `SELECT w.title,(SELECT count(*) FROM work_version WHERE work_id=w.id) FROM work w WHERE w.id=$1`, work.ID).Scan(&title, &versionsAfter); err != nil {
		t.Fatal(err)
	}
	if title != newTitle || versionsAfter != versionsBefore {
		t.Fatalf("stale restore changed current work: title=%q versionCount=%d want %q/%d", title, versionsAfter, newTitle, versionsBefore)
	}
}

func TestCL02RestoreWaitsForSectionSaveBeforeCheckingWorkRevision(t *testing.T) {
	work, _, _ := cl01CreateRestoreWork(t, false)
	workID := work.ID.String()
	env.mustJSON(t, http.MethodPost, "/api/v1/works/"+workID+"/versions", nil, nil)
	versionNo := latestVersionNo(t, workID)
	var current Work
	env.mustJSON(t, http.MethodGet, "/api/v1/works/"+workID, nil, &current)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	writer, err := env.srv.db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Rollback(context.Background())
	var writerPID int
	if err := writer.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&writerPID); err != nil {
		t.Fatal(err)
	}
	if _, err := writer.Exec(ctx, `UPDATE work_section SET content_md='并发保存的新正文' WHERE id=$1`, current.Sections[0].ID); err != nil {
		t.Fatal(err)
	}
	type restoreResponse struct {
		status int
		body   []byte
	}
	finished := make(chan restoreResponse, 1)
	go func() {
		status, body := env.do(http.MethodPost, fmt.Sprintf("/api/v1/works/%s/versions/%d/restore", workID, versionNo), map[string]int{"base_revision": current.Revision})
		finished <- restoreResponse{status: status, body: body}
	}()
	for {
		var blocked bool
		if err := env.srv.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)))`, writerPID).Scan(&blocked); err != nil {
			t.Fatal(err)
		}
		if blocked {
			break
		}
		if ctx.Err() != nil {
			t.Fatal("restore did not wait on the in-flight section save")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := env.srv.touchContent(ctx, writer, work.ID); err != nil {
		t.Fatalf("section save could not acquire the work revision lock: %v", err)
	}
	if err := writer.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case result := <-finished:
		if result.status != http.StatusConflict || !strings.Contains(string(result.body), `"code":"version_conflict"`) {
			t.Fatalf("restore should reject the now-stale base revision: %d %s", result.status, result.body)
		}
	case <-ctx.Done():
		t.Fatal("restore did not finish after the section save committed")
	}
	var restored Work
	env.mustJSON(t, http.MethodGet, "/api/v1/works/"+workID, nil, &restored)
	if restored.Sections[0].ContentMD != "并发保存的新正文" {
		t.Fatalf("restore overwrote the concurrent section save: %q", restored.Sections[0].ContentMD)
	}
}
