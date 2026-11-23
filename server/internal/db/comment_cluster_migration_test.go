package db

import (
	"strings"
	"testing"

	"github.com/pressly/goose/v3"
)

func TestCommentClusterMigrationStructureAndRollback(t *testing.T) {
	goose.SetBaseFS(migrations)
	goose.SetLogger(goose.NopLogger())
	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatal(err)
	}
	database, _ := newToutiaoMigrationTestDB(t)
	if err := goose.UpTo(database, "migrations", 122); err != nil {
		t.Fatal(err)
	}

	var clusterTable, termTable, canonicalIndex, openIndex int
	if err := database.QueryRow(`SELECT
		(SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='comment_question_cluster'),
		(SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='reader_term'),
		(SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND indexname='comment_inbox_canonical'),
		(SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND indexname='comment_cluster_open')`).
		Scan(&clusterTable, &termTable, &canonicalIndex, &openIndex); err != nil {
		t.Fatal(err)
	}
	if clusterTable != 1 || termTable != 1 || canonicalIndex != 1 || openIndex != 1 {
		t.Fatalf("I3 schema missing: cluster=%d term=%d canonical_index=%d open_index=%d",
			clusterTable, termTable, canonicalIndex, openIndex)
	}

	var commentColumns int
	if err := database.QueryRow(`SELECT count(*) FROM information_schema.columns
		WHERE table_schema='public' AND table_name='comment_inbox'
		AND column_name IN ('canonical_key','cluster_id','intent_confidence')`).Scan(&commentColumns); err != nil {
		t.Fatal(err)
	}
	if commentColumns != 3 {
		t.Fatalf("I3 comment_inbox columns incomplete: %d/3", commentColumns)
	}

	var seenColumns int
	if err := database.QueryRow(`SELECT count(*) FROM information_schema.columns
		WHERE table_schema='public' AND table_name='comment_question_cluster'
		AND column_name IN ('first_seen_at','last_seen_at') AND is_nullable='NO'`).Scan(&seenColumns); err != nil {
		t.Fatal(err)
	}
	if seenColumns != 2 {
		t.Fatalf("I3 cluster first/last seen must be NOT NULL: %d/2", seenColumns)
	}

	var sourceCheck string
	if err := database.QueryRow(`SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
		JOIN pg_class t ON t.oid=c.conrelid
		WHERE t.relname='topic' AND c.conname='topic_source_check'`).Scan(&sourceCheck); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(sourceCheck, "'comment'") || !strings.Contains(sourceCheck, "'daily'") || !strings.Contains(sourceCheck, "'manual'") {
		t.Fatalf("I3 topic source check must keep existing values and add comment: %s", sourceCheck)
	}

	if err := goose.DownTo(database, "migrations", 121); err != nil {
		t.Fatalf("I3 rollback must remove only I3 schema: %v", err)
	}
	if err := database.QueryRow(`SELECT
		(SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('comment_question_cluster','reader_term')),
		(SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='comment_inbox' AND column_name IN ('canonical_key','cluster_id','intent_confidence'))`).
		Scan(&clusterTable, &commentColumns); err != nil {
		t.Fatal(err)
	}
	if clusterTable != 0 || commentColumns != 0 {
		t.Fatalf("I3 rollback left schema behind: tables=%d columns=%d", clusterTable, commentColumns)
	}
}
