package app

import (
	"context"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestOPT72ListsUseTimeCursorPagination(t *testing.T) {
	ctx := context.Background()
	marker := "opt72-pagination-" + uuid.NewString()
	var userID, workspaceID uuid.UUID
	var me struct {
		UserID    uuid.UUID `json:"user_id"`
		Workspace struct {
			ID uuid.UUID `json:"id"`
		} `json:"workspace"`
	}
	env.mustJSON(t, "GET", "/api/v1/auth/me", nil, &me)
	userID, workspaceID = me.UserID, me.Workspace.ID
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(ctx, `DELETE FROM notification WHERE title LIKE $1`, marker+"%")
		_, _ = env.srv.db.Exec(ctx, `DELETE FROM inbox_item WHERE content LIKE $1`, marker+"%")
	})

	createdAt := time.Now().UTC().Add(time.Hour)
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO notification (workspace_id,user_id,kind,title,created_at)
		SELECT $1,$2,'test',$3||'-'||n::text,$4 FROM generate_series(1,55) n`, workspaceID, userID, marker, createdAt); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO inbox_item (workspace_id,content,created_by,created_at)
		SELECT $1,$2||'-'||n::text,$3,$4 FROM generate_series(1,300) n`, workspaceID, marker, userID, createdAt); err != nil {
		t.Fatal(err)
	}

	t.Run("notifications", func(t *testing.T) {
		type page struct {
			Items      []Notification `json:"items"`
			Unread     int            `json:"unread"`
			NextCursor *string        `json:"next_cursor"`
		}
		seen := map[uuid.UUID]bool{}
		matched := 0
		cursor := ""
		for pageNo := 0; pageNo < 5; pageNo++ {
			path := "/api/v1/notifications"
			if cursor != "" {
				path += "?cursor=" + url.QueryEscape(cursor)
			}
			var result page
			env.mustJSON(t, "GET", path, nil, &result)
			if len(result.Items) > 50 {
				t.Fatalf("page %d returned %d notifications", pageNo+1, len(result.Items))
			}
			if pageNo == 0 && (len(result.Items) != 50 || result.NextCursor == nil || result.Unread < 55) {
				t.Fatalf("first page metadata: items=%d unread=%d next=%v", len(result.Items), result.Unread, result.NextCursor)
			}
			for _, item := range result.Items {
				if seen[item.ID] {
					t.Fatalf("duplicate notification %s", item.ID)
				}
				seen[item.ID] = true
				if strings.HasPrefix(item.Title, marker) {
					matched++
				}
			}
			if result.NextCursor == nil {
				break
			}
			cursor = *result.NextCursor
		}
		if matched != 55 {
			t.Fatalf("read %d of 55 seeded notifications", matched)
		}
	})

	t.Run("inbox", func(t *testing.T) {
		type page struct {
			Items      []InboxItem `json:"items"`
			Total      int         `json:"total"`
			NextCursor *string     `json:"next_cursor"`
		}
		seen := map[uuid.UUID]bool{}
		matched := 0
		cursor := ""
		for pageNo := 0; pageNo < 10; pageNo++ {
			path := "/api/v1/inbox"
			if cursor != "" {
				path += "?cursor=" + url.QueryEscape(cursor)
			}
			var result page
			env.mustJSON(t, "GET", path, nil, &result)
			if len(result.Items) > 50 || result.Total < 300 {
				t.Fatalf("page %d metadata: items=%d total=%d", pageNo+1, len(result.Items), result.Total)
			}
			if pageNo == 0 && (len(result.Items) != 50 || result.NextCursor == nil) {
				t.Fatalf("first page did not expose a continuation cursor: items=%d next=%v", len(result.Items), result.NextCursor)
			}
			for _, item := range result.Items {
				if seen[item.ID] {
					t.Fatalf("duplicate inbox item %s", item.ID)
				}
				seen[item.ID] = true
				if strings.HasPrefix(item.Content, marker) {
					matched++
				}
			}
			if matched == 300 {
				break
			}
			if result.NextCursor == nil {
				break
			}
			cursor = *result.NextCursor
		}
		if matched != 300 {
			t.Fatalf("read %d of 300 seeded inbox items", matched)
		}
	})

	var account Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{"platform": "xhs", "name": marker, "content_format": "image_note"}, &account)
	t.Cleanup(func() { _, _ = env.srv.db.Exec(ctx, `DELETE FROM platform_account WHERE id=$1`, account.ID) })
	var work Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+account.ID.String()+"/works", map[string]string{"title": marker}, &work)
	t.Cleanup(func() { _, _ = env.srv.db.Exec(ctx, `DELETE FROM work WHERE id=$1`, work.ID) })
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO comment (work_id,body,author_id,created_at)
		SELECT $1,$2||'-'||n::text,$3,$4 FROM generate_series(1,55) n`, work.ID, marker, userID, createdAt); err != nil {
		t.Fatal(err)
	}
	t.Run("comments", func(t *testing.T) {
		type page struct {
			Items      []Comment `json:"items"`
			OpenCount  int       `json:"open_count"`
			NextCursor *string   `json:"next_cursor"`
		}
		seen := map[uuid.UUID]bool{}
		matched := 0
		cursor := ""
		for pageNo := 0; pageNo < 5; pageNo++ {
			path := "/api/v1/works/" + work.ID.String() + "/comments"
			if cursor != "" {
				path += "?cursor=" + url.QueryEscape(cursor)
			}
			var result page
			env.mustJSON(t, "GET", path, nil, &result)
			if len(result.Items) > 50 {
				t.Fatalf("page %d returned %d comments", pageNo+1, len(result.Items))
			}
			if pageNo == 0 && (len(result.Items) != 50 || result.NextCursor == nil || result.OpenCount != 55) {
				t.Fatalf("first page metadata: items=%d open_count=%d next=%v", len(result.Items), result.OpenCount, result.NextCursor)
			}
			for _, item := range result.Items {
				if seen[item.ID] {
					t.Fatalf("duplicate comment %s", item.ID)
				}
				seen[item.ID] = true
				if strings.HasPrefix(item.Body, marker) {
					matched++
				}
			}
			if result.NextCursor == nil {
				break
			}
			cursor = *result.NextCursor
		}
		if matched != 55 {
			t.Fatalf("read %d of 55 seeded comments", matched)
		}
	})

}
