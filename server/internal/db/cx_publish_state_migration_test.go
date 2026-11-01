package db

import (
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/pressly/goose/v3"
)

func TestCXPublishStateMigrationImportsOnlyPublishedFactsAndProtectsHistory(t *testing.T) {
	goose.SetBaseFS(migrations)
	goose.SetLogger(goose.NopLogger())
	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatal(err)
	}
	database, _ := newToutiaoMigrationTestDB(t)
	if err := goose.UpTo(database, "migrations", 77); err != nil {
		t.Fatal(err)
	}
	legacy := seedLegacyPlatformData(t, database)
	withDate, withoutDate, draft := uuid.New(), uuid.New(), uuid.New()
	if _, err := database.Exec(`INSERT INTO work(id,account_id,title,content_format,status,published_at,published_url)
		VALUES($1,$4,'已公开且有时间','long_article','published',now()-interval '2 days','https://example.test/with-date'),
		      ($2,$4,'已公开但时间未知','long_article','published',NULL,NULL),
		      ($3,$4,'仍在草稿','long_article','drafting',NULL,NULL)`, withDate, withoutDate, draft, legacy.accountIDs[0]); err != nil {
		t.Fatal(err)
	}
	if err := goose.UpTo(database, "migrations", 78); err != nil {
		t.Fatalf("upgrade: %v", err)
	}
	var stateCount, eventCount int
	if err := database.QueryRow(`SELECT count(*) FROM work_publish_state`).Scan(&stateCount); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRow(`SELECT count(*) FROM work_publish_state_event`).Scan(&eventCount); err != nil {
		t.Fatal(err)
	}
	if stateCount != 2 || eventCount != 2 {
		t.Fatalf("expected one state and one import per published work, got states=%d events=%d", stateCount, eventCount)
	}
	var importedDate, importedUnknown int
	if err := database.QueryRow(`SELECT count(*) FILTER (WHERE work_id=$1), count(*) FILTER (WHERE work_id=$2)
		FROM work_publish_state_event WHERE event_kind='import' AND from_state IS NULL AND to_state='public'`, withDate, withoutDate).
		Scan(&importedDate, &importedUnknown); err != nil {
		t.Fatal(err)
	}
	if importedDate != 1 || importedUnknown != 1 {
		t.Fatalf("each historical publication must have exactly one null->public import: dated=%d unknown=%d", importedDate, importedUnknown)
	}
	var storedPublishedAt *string
	if err := database.QueryRow(`SELECT published_at::text FROM work WHERE id=$1`, withoutDate).Scan(&storedPublishedAt); err != nil {
		t.Fatal(err)
	}
	if storedPublishedAt != nil {
		t.Fatalf("migration must not invent a publication time: %v", *storedPublishedAt)
	}
	var draftStates int
	if err := database.QueryRow(`SELECT count(*) FROM work_publish_state WHERE work_id=$1`, draft).Scan(&draftStates); err != nil || draftStates != 0 {
		t.Fatalf("draft must remain without a ledger row: count=%d err=%v", draftStates, err)
	}
	if err := goose.DownTo(database, "migrations", 77); err == nil || !strings.Contains(err.Error(), "拒绝回滚") {
		t.Fatalf("migration must refuse to discard imported publish history: %v", err)
	}
}
