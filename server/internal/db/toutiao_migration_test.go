package db

import (
	"bytes"
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/pressly/goose/v3"
)

// Run explicitly with a built pre-Toutiao binary; never point it at a user's database.
func TestToutiaoLegacyBinaryRollbackCapability(t *testing.T) {
	binary := os.Getenv("OPS_TT_LEGACY_BINARY")
	if binary == "" {
		t.Skip("set OPS_TT_LEGACY_BINARY to evaluate an actual rollback binary")
	}
	database, databaseURL := newToutiaoMigrationTestDB(t)
	if err := Migrate(databaseURL); err != nil {
		t.Fatal(err)
	}
	initialVersion, err := goose.GetDBVersion(database)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	_ = listener.Close()
	command := exec.CommandContext(ctx, binary, "serve")
	command.Env = append(os.Environ(), "OPS_DEV=0", "OPS_COOKIE_SECURE=0", "OPS_MASTER_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", "OPS_LISTEN="+address, "OPS_DATABASE_URL="+databaseURL, "OPS_DATA_DIR="+t.TempDir(), "OPS_SYSTEM_ADMIN_PASSWORD=local-rollback-test-password")
	var output bytes.Buffer
	command.Stdout = &output
	command.Stderr = &output
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = command.Process.Kill(); _ = command.Wait() }()
	jar, _ := cookiejar.New(nil)
	client := &http.Client{Jar: jar, Timeout: time.Second}
	base := "http://" + address
	for {
		response, err := client.Get(base + "/healthz")
		if err == nil {
			response.Body.Close()
			if response.StatusCode == 200 {
				break
			}
		}
		select {
		case <-ctx.Done():
			t.Fatal("legacy service did not start")
		case <-time.After(25 * time.Millisecond):
		}
	}
	username := "tt-rollback-" + uuid.NewString()[:8]
	response, err := client.Post(base+"/api/v1/auth/register", "application/json", strings.NewReader(fmt.Sprintf(`{"username":%q,"password":"local-rollback-password-123"}`, username)))
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatalf("legacy register: %d", response.StatusCode)
	}
	response, err = client.Get(base + "/api/v1/auth/me")
	if err != nil {
		t.Fatal(err)
	}
	var me struct {
		CSRF      string `json:"csrf_token"`
		Workspace struct {
			ID string `json:"id"`
		} `json:"workspace"`
	}
	if err := json.NewDecoder(response.Body).Decode(&me); err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	accountID, workID := uuid.NewString(), uuid.NewString()
	if _, err := database.Exec(`INSERT INTO platform_account(id,workspace_id,platform,content_format,name) VALUES($1,$2,'toutiao','micro_post','旧版本读枚举验收')`, accountID, me.Workspace.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`INSERT INTO work(id,account_id,content_format,title) VALUES($1,$2,'micro_post','旧应用回退保护')`, workID, accountID); err != nil {
		t.Fatal(err)
	}
	response, err = client.Get(base + "/api/v1/accounts")
	if err != nil {
		t.Fatal(err)
	}
	var accounts []struct {
		Platform string `json:"platform"`
		Format   string `json:"content_format"`
	}
	if err := json.NewDecoder(response.Body).Decode(&accounts); err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if len(accounts) != 1 || accounts[0].Platform != "toutiao" || accounts[0].Format != "micro_post" {
		t.Fatalf("legacy enum read unexpected: %+v", accounts)
	}
	req, _ := http.NewRequest("POST", base+"/api/v1/works/"+workID+"/toutiao/pack", strings.NewReader(`{"basis_revision":1}`))
	req.Header.Set("X-CSRF-Token", me.CSRF)
	req.Header.Set("Content-Type", "application/json")
	response, err = client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 404 {
		t.Fatalf("baseline package capability changed: %d", response.StatusCode)
	}
	var count int
	if err := database.QueryRow(`SELECT count(*) FROM work WHERE id=$1 AND content_format='micro_post'`, workID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("legacy attempt changed new work: count=%d err=%v", count, err)
	}
	if version, err := goose.GetDBVersion(database); err != nil || version != initialVersion {
		t.Fatalf("legacy attempt changed schema version: initial=%d current=%d err=%v", initialVersion, version, err)
	}
	t.Log("actual HEAD legacy binary can read unknown enum strings but lacks the Toutiao package route (404): it is not an acceptable rollback target; data and schema were preserved")
}

func TestToutiaoMigrationUpgradeAndDataPreservingRollback(t *testing.T) {
	ctx := context.Background()
	goose.SetBaseFS(migrations)
	goose.SetLogger(goose.NopLogger())
	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatal(err)
	}

	freshDB, freshURL := newToutiaoMigrationTestDB(t)
	if err := Migrate(freshURL); err != nil {
		t.Fatalf("migrate fresh database: %v", err)
	}
	if version, err := goose.GetDBVersion(freshDB); err != nil || version != 70 {
		t.Fatalf("fresh migration version: got %d, err=%v", version, err)
	}
	assertToutiaoAccountFormat(t, freshDB, "long_article")
	assertToutiaoAccountFormat(t, freshDB, "micro_post")
	if err := insertToutiaoAccount(freshDB, "image_note"); err == nil {
		t.Fatal("fresh schema accepted an unsupported Toutiao format")
	}

	upgradeDB, upgradeURL := newToutiaoMigrationTestDB(t)
	if err := goose.UpTo(upgradeDB, "migrations", 45); err != nil {
		t.Fatalf("migrate legacy schema to v45: %v", err)
	}
	legacy := seedLegacyPlatformData(t, upgradeDB)
	if err := Migrate(upgradeURL); err != nil {
		t.Fatalf("upgrade existing two-platform database: %v", err)
	}
	if version, err := goose.GetDBVersion(upgradeDB); err != nil || version != 70 {
		t.Fatalf("upgraded migration version: got %d, err=%v", version, err)
	}
	assertLegacyPlatformData(t, upgradeDB, legacy)

	toutiaoAccount := insertToutiaoAccountWithID(t, upgradeDB, uuid.NewString(), "micro_post")
	toutiaoWork := uuid.NewString()
	if _, err := upgradeDB.ExecContext(ctx, `INSERT INTO work (id, account_id, content_format, title) VALUES ($1, $2, 'micro_post', '回退保护样本')`, toutiaoWork, toutiaoAccount); err != nil {
		t.Fatal(err)
	}
	toutiaoMetric := uuid.NewString()
	if _, err := upgradeDB.ExecContext(ctx, `INSERT INTO metric_snapshot (id, work_id, captured_at, reads, impressions) VALUES ($1, $2, $3, 120, 450)`, toutiaoMetric, toutiaoWork, time.Now()); err != nil {
		t.Fatal(err)
	}
	if _, err := upgradeDB.ExecContext(ctx, `UPDATE metric_snapshot SET impressions=451 WHERE id=$1`, toutiaoMetric); err != nil {
		t.Fatal(err)
	}
	var revision int
	var d7Impressions sql.NullInt64
	if err := upgradeDB.QueryRowContext(ctx, `SELECT revision FROM metric_snapshot WHERE id=$1`, toutiaoMetric).Scan(&revision); err != nil || revision != 2 {
		t.Fatalf("impressions update revision: got %d, err=%v", revision, err)
	}
	if err := upgradeDB.QueryRowContext(ctx, `SELECT impressions FROM work_metric_d7 WHERE work_id=$1`, toutiaoWork).Scan(&d7Impressions); err != nil || !d7Impressions.Valid || d7Impressions.Int64 != 451 {
		t.Fatalf("D7 view impressions: got %+v, err=%v", d7Impressions, err)
	}

	if err := goose.DownTo(upgradeDB, "migrations", 45); err == nil || !strings.Contains(err.Error(), "cannot roll back Toutiao impressions while metric values exist") {
		t.Fatalf("rollback with impressions should refuse and preserve data: %v", err)
	}
	if version, err := goose.GetDBVersion(upgradeDB); err != nil || version != 47 {
		t.Fatalf("version after refused impressions rollback: got %d, err=%v", version, err)
	}
	var impressions int64
	if err := upgradeDB.QueryRowContext(ctx, `SELECT impressions FROM metric_snapshot WHERE id=$1`, toutiaoMetric).Scan(&impressions); err != nil || impressions != 451 {
		t.Fatalf("impressions changed after refused rollback: got %d, err=%v", impressions, err)
	}

	if _, err := upgradeDB.ExecContext(ctx, `UPDATE metric_snapshot SET impressions=NULL WHERE id=$1`, toutiaoMetric); err != nil {
		t.Fatal(err)
	}
	if err := goose.DownTo(upgradeDB, "migrations", 45); err == nil || !strings.Contains(err.Error(), "cannot roll back Toutiao platform migration while Toutiao accounts exist") {
		t.Fatalf("rollback with Toutiao account should refuse and preserve data: %v", err)
	}
	if version, err := goose.GetDBVersion(upgradeDB); err != nil || version != 46 {
		t.Fatalf("version after refused platform rollback: got %d, err=%v", version, err)
	}
	var accountCount, workCount int
	if err := upgradeDB.QueryRowContext(ctx, `SELECT count(*) FROM platform_account WHERE id=$1`, toutiaoAccount).Scan(&accountCount); err != nil || accountCount != 1 {
		t.Fatalf("Toutiao account lost after refused rollback: count=%d, err=%v", accountCount, err)
	}
	if err := upgradeDB.QueryRowContext(ctx, `SELECT count(*) FROM work WHERE id=$1`, toutiaoWork).Scan(&workCount); err != nil || workCount != 1 {
		t.Fatalf("Toutiao work lost after refused rollback: count=%d, err=%v", workCount, err)
	}
	assertLegacyPlatformData(t, upgradeDB, legacy)

	if _, err := upgradeDB.ExecContext(ctx, `DELETE FROM work WHERE id=$1`, toutiaoWork); err != nil {
		t.Fatal(err)
	}
	if _, err := upgradeDB.ExecContext(ctx, `DELETE FROM platform_account WHERE id=$1`, toutiaoAccount); err != nil {
		t.Fatal(err)
	}
	if err := goose.DownTo(upgradeDB, "migrations", 45); err != nil {
		t.Fatalf("rollback without Toutiao data: %v", err)
	}
	assertLegacyPlatformData(t, upgradeDB, legacy)
}

type legacyMigrationData struct {
	accountIDs []string
	workIDs    []string
	metricIDs  []string
}

func newToutiaoMigrationTestDB(t *testing.T) (*sql.DB, string) {
	t.Helper()
	adminURL := os.Getenv("OPS_TEST_ADMIN_URL")
	if adminURL == "" {
		adminURL = "postgres://ops:ops_dev_password@localhost:5440/ops?sslmode=disable"
	}
	ctx := context.Background()
	admin, err := pgx.Connect(ctx, adminURL)
	if err != nil {
		t.Fatalf("connect migration test admin database: %v", err)
	}
	t.Cleanup(func() { _ = admin.Close(ctx) })
	var suffix [8]byte
	if _, err := rand.Read(suffix[:]); err != nil {
		t.Fatal(err)
	}
	name := "ops_tt_" + hex.EncodeToString(suffix[:])
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+name); err != nil {
		t.Fatalf("create isolated migration database: %v", err)
	}
	t.Cleanup(func() {
		if _, err := admin.Exec(ctx, "DROP DATABASE IF EXISTS "+name+" WITH (FORCE)"); err != nil {
			t.Errorf("drop isolated migration database: %v", err)
		}
	})
	u, err := url.Parse(adminURL)
	if err != nil {
		t.Fatal(err)
	}
	u.Path = "/" + name
	database, err := sql.Open("pgx", u.String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := database.PingContext(ctx); err != nil {
		t.Fatalf("connect isolated migration database: %v", err)
	}
	return database, u.String()
}

func seedLegacyPlatformData(t *testing.T, database *sql.DB) legacyMigrationData {
	t.Helper()
	ctx := context.Background()
	workspaceID := uuid.NewString()
	if _, err := database.ExecContext(ctx, `INSERT INTO workspace (id, name) VALUES ($1, '迁移验收工作区')`, workspaceID); err != nil {
		t.Fatal(err)
	}
	data := legacyMigrationData{}
	for _, account := range []struct{ platform, format string }{{"wechat_mp", "long_article"}, {"xhs", "image_note"}} {
		accountID, workID, metricID := uuid.NewString(), uuid.NewString(), uuid.NewString()
		if _, err := database.ExecContext(ctx, `INSERT INTO platform_account (id, workspace_id, platform, name, content_format) VALUES ($1, $2, $3, $4, $5)`, accountID, workspaceID, account.platform, account.platform+" 历史账号", account.format); err != nil {
			t.Fatal(err)
		}
		if _, err := database.ExecContext(ctx, `INSERT INTO work (id, account_id, content_format, title) VALUES ($1, $2, $3, $4)`, workID, accountID, account.format, account.platform+" 历史作品"); err != nil {
			t.Fatal(err)
		}
		if _, err := database.ExecContext(ctx, `INSERT INTO metric_snapshot (id, work_id, captured_at, reads, likes, source, day_offset) VALUES ($1, $2, $3, 120, 7, 'manual', 7)`, metricID, workID, time.Now()); err != nil {
			t.Fatal(err)
		}
		data.accountIDs = append(data.accountIDs, accountID)
		data.workIDs = append(data.workIDs, workID)
		data.metricIDs = append(data.metricIDs, metricID)
	}
	return data
}

func assertLegacyPlatformData(t *testing.T, database *sql.DB, data legacyMigrationData) {
	t.Helper()
	ctx := context.Background()
	for i, metricID := range data.metricIDs {
		var workID string
		var reads, likes, revision int
		var source string
		var dayOffset int
		if err := database.QueryRowContext(ctx, `SELECT work_id::text, reads, likes, revision, source, day_offset FROM metric_snapshot WHERE id=$1`, metricID).Scan(&workID, &reads, &likes, &revision, &source, &dayOffset); err != nil {
			t.Fatalf("legacy metric %s missing: %v", metricID, err)
		}
		if workID != data.workIDs[i] || reads != 120 || likes != 7 || revision != 1 || source != "manual" || dayOffset != 7 {
			t.Fatalf("legacy metric changed: work=%s reads=%d likes=%d revision=%d source=%s day=%d", workID, reads, likes, revision, source, dayOffset)
		}
	}
	var accountCount, workCount int
	if err := database.QueryRowContext(ctx, `SELECT count(*) FROM platform_account WHERE id = ANY($1::uuid[])`, pqUUIDArray(data.accountIDs)).Scan(&accountCount); err != nil || accountCount != len(data.accountIDs) {
		t.Fatalf("legacy accounts changed: count=%d err=%v", accountCount, err)
	}
	if err := database.QueryRowContext(ctx, `SELECT count(*) FROM work WHERE id = ANY($1::uuid[])`, pqUUIDArray(data.workIDs)).Scan(&workCount); err != nil || workCount != len(data.workIDs) {
		t.Fatalf("legacy works changed: count=%d err=%v", workCount, err)
	}
}

func assertToutiaoAccountFormat(t *testing.T, database *sql.DB, format string) {
	t.Helper()
	if err := insertToutiaoAccount(database, format); err != nil {
		t.Fatalf("Toutiao %s account rejected: %v", format, err)
	}
}

func insertToutiaoAccount(database *sql.DB, format string) error {
	workspaceID := uuid.NewString()
	if _, err := database.Exec(`INSERT INTO workspace (id, name) VALUES ($1, '迁移形态验收工作区')`, workspaceID); err != nil {
		return err
	}
	_, err := database.Exec(`INSERT INTO platform_account (workspace_id, platform, name, content_format) VALUES ($1, 'toutiao', '迁移形态验收', $2)`, workspaceID, format)
	return err
}

func insertToutiaoAccountWithID(t *testing.T, database *sql.DB, id, format string) string {
	t.Helper()
	workspaceID := uuid.NewString()
	if _, err := database.Exec(`INSERT INTO workspace (id, name) VALUES ($1, '头条回退验收工作区')`, workspaceID); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`INSERT INTO platform_account (id, workspace_id, platform, name, content_format) VALUES ($1, $2, 'toutiao', '回退保护账号', $3)`, id, workspaceID, format); err != nil {
		t.Fatal(err)
	}
	return id
}

func pqUUIDArray(values []string) string { return "{" + strings.Join(values, ",") + "}" }
