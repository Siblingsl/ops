package db

import (
	"testing"

	"github.com/pressly/goose/v3"
)

// CF-P2-CXEF-04：account_profile.timezone 可逆迁移。
// 升级加列默认 ''（空=缺省 Asia/Shanghai，既有数据不动）；down 删列。
// 有效值由应用层 time.LoadLocation 校验，库层只存文本。
func TestCXAccountTimezoneMigrationReversible(t *testing.T) {
	goose.SetBaseFS(migrations)
	goose.SetLogger(goose.NopLogger())
	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatal(err)
	}
	database, _ := newToutiaoMigrationTestDB(t)
	if err := goose.UpTo(database, "migrations", 104); err != nil {
		t.Fatalf("upgrade to 104: %v", err)
	}
	legacy := seedLegacyPlatformData(t, database)
	accountID := legacy.accountIDs[0]
	if _, err := database.Exec(`INSERT INTO account_profile(account_id) VALUES ($1)`, accountID); err != nil {
		t.Fatalf("seed profile: %v", err)
	}
	if err := goose.UpTo(database, "migrations", latestMigrationVersion(t)); err != nil {
		t.Fatalf("upgrade to 105: %v", err)
	}
	// 旧行保持空串（=缺省上海，应用层语义）。
	var tz string
	if err := database.QueryRow(`SELECT timezone FROM account_profile WHERE account_id=$1`, accountID).Scan(&tz); err != nil {
		t.Fatalf("timezone column must exist after up: %v", err)
	}
	if tz != "" {
		t.Fatalf("existing rows must keep empty timezone (default Asia/Shanghai): %q", tz)
	}
	if _, err := database.Exec(`UPDATE account_profile SET timezone='Pacific/Chatham' WHERE account_id=$1`, accountID); err != nil {
		t.Fatalf("text timezone must be storable: %v", err)
	}
	// down：有非空值也允许（列级迁移无业务数据丢失面）。
	// 按版本号回退到 104，而不是「回退一步」——DEV-CU P1-4 引入 106 后，单步 Down
	// 只会撤 106，本用例会假红。断言不变，仍要求 timezone 列被真正删掉。
	if err := goose.DownTo(database, "migrations", 104); err != nil {
		t.Fatalf("down to 104: %v", err)
	}
	var exists int
	if err := database.QueryRow(`SELECT count(*) FROM information_schema.columns WHERE table_name='account_profile' AND column_name='timezone'`).Scan(&exists); err != nil {
		t.Fatal(err)
	}
	if exists != 0 {
		t.Fatal("timezone column must be dropped after down")
	}
	if err := goose.Up(database, "migrations"); err != nil {
		t.Fatalf("re-up: %v", err)
	}
}
