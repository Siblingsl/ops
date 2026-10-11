package app

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// DEV-U105（12 文档）：/healthz 检查数据库连通——数据库不可用时返回 503，
// 让 compose healthcheck 与升级脚本在切换流量前发现问题。
func TestU105HealthzChecksDatabase(t *testing.T) {
	if st, body := env.do("GET", "/healthz", nil); st != 200 {
		t.Fatalf("healthz: %d %s", st, body)
	}
	if st, body := env.do("GET", "/api/v1/healthz", nil); st != 200 {
		t.Fatalf("api healthz: %d %s", st, body)
	}

	orig := env.srv.db
	broken, err := pgxpool.New(context.Background(), "postgres://ops:none@127.0.0.1:1/none?sslmode=disable&connect_timeout=1")
	if err != nil {
		t.Fatal(err)
	}
	defer broken.Close()
	env.srv.db = broken
	defer func() { env.srv.db = orig }()

	if st, body := env.do("GET", "/healthz", nil); st != 503 {
		t.Fatalf("healthz with broken db: %d %s", st, body)
	}
	if st, body := env.do("GET", "/api/v1/healthz", nil); st != 503 {
		t.Fatalf("api healthz with broken db: %d %s", st, body)
	}

	env.srv.db = orig
	if st, _ := env.do("GET", "/healthz", nil); st != 200 {
		t.Fatalf("healthz after restore: %d", st)
	}
}
