package app

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"ops/internal/db"
)

func TestOPT03PoolConfig(t *testing.T) {
	t.Setenv("OPS_DB_MAX_CONNS", "")
	var logs bytes.Buffer
	oldLogger := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(oldLogger) })
	ctx := context.Background()
	pool, err := db.Connect(ctx, env.srv.cfg.DatabaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	cfg := pool.Config()
	if cfg.MaxConns != 20 || cfg.MaxConnIdleTime != 5*time.Minute || cfg.MaxConnLifetime != time.Hour {
		t.Fatalf("pool settings: max=%d idle=%s lifetime=%s", cfg.MaxConns, cfg.MaxConnIdleTime, cfg.MaxConnLifetime)
	}
	for name, want := range map[string]string{
		"statement_timeout": "30s", "idle_in_transaction_session_timeout": "1min", "timezone": "Asia/Shanghai",
	} {
		var got string
		if err := pool.QueryRow(ctx, "SHOW "+name).Scan(&got); err != nil || got != want {
			t.Fatalf("%s: got %q want %q err=%v", name, got, want, err)
		}
	}
	for _, key := range []string{"max_conns=20", "max_conn_idle_time=5m0s", "max_conn_lifetime=1h0m0s", "statement_timeout=30s", "idle_in_transaction_session_timeout=60s", "timezone=Asia/Shanghai"} {
		if !strings.Contains(logs.String(), key) {
			t.Fatalf("startup log missing %s: %s", key, logs.String())
		}
	}
	if strings.Contains(logs.String(), "postgres://") || strings.Contains(logs.String(), "password") {
		t.Fatal("startup log contains connection credentials")
	}
	t.Setenv("OPS_DB_MAX_CONNS", "7")
	override, err := db.Connect(ctx, env.srv.cfg.DatabaseURL)
	if err != nil {
		t.Fatal(err)
	}
	if override.Config().MaxConns != 7 {
		t.Error("environment did not override pool size")
	}
	override.Close()
	for _, invalid := range []string{"0", "-1", "not-a-number"} {
		t.Setenv("OPS_DB_MAX_CONNS", invalid)
		p, err := db.Connect(ctx, env.srv.cfg.DatabaseURL)
		if p != nil {
			p.Close()
		}
		if err == nil || !strings.Contains(err.Error(), "正整数") {
			t.Fatalf("invalid pool size %q: %v", invalid, err)
		}
	}
}

func TestOPT03StatementTimeoutKeepsHealthzAvailable(t *testing.T) {
	const slowSQL = "SELECT pg_sleep(40) /* OPT03 slow request */"
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	probe := httptest.NewServer(env.srv.h(func(w http.ResponseWriter, r *http.Request) error {
		_, err := env.srv.db.Exec(ctx, slowSQL)
		return err
	}))
	defer probe.Close()
	type result struct {
		status  int
		body    []byte
		elapsed time.Duration
		err     error
	}
	done := make(chan result, 1)
	start := time.Now()
	go func() {
		rsp, err := env.client.Get(probe.URL)
		if err != nil {
			done <- result{err: err}
			return
		}
		defer rsp.Body.Close()
		body, err := io.ReadAll(rsp.Body)
		done <- result{status: rsp.StatusCode, body: body, elapsed: time.Since(start), err: err}
	}()
	deadline := time.Now().Add(3 * time.Second)
	for {
		var active bool
		if err := env.srv.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND state='active' AND query=$1)`, slowSQL).Scan(&active); err != nil {
			t.Fatal(err)
		}
		if active {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("slow SQL did not start")
		}
		time.Sleep(10 * time.Millisecond)
	}
	checks := 0
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	for {
		select {
		case got := <-done:
			if got.err != nil || got.status != http.StatusGatewayTimeout {
				t.Fatalf("timeout response: %d %s err=%v", got.status, got.body, got.err)
			}
			var ae apiError
			if err := json.Unmarshal(got.body, &ae); err != nil || ae.Error.Code != "database_timeout" || ae.Error.Message != "数据库操作超时，请稍后重试" {
				t.Fatalf("timeout error: %s err=%v", got.body, err)
			}
			// PoolConfig separately asserts 30s; allow 5s for local database and scheduler observation latency.
			if got.elapsed < 29*time.Second || got.elapsed > 35*time.Second || checks < 25 {
				t.Fatalf("duration=%s health checks=%d", got.elapsed, checks)
			}
			t.Logf("pg_sleep(40) cancelled after %s; healthz remained 200 for %d checks", got.elapsed, checks)
			return
		case <-tick.C:
			if st, body := env.do("GET", "/healthz", nil); st != http.StatusOK || string(body) != "ok" {
				t.Fatalf("healthz during slow SQL: %d %s", st, body)
			}
			checks++
		case <-ctx.Done():
			t.Fatal("SQL was not cancelled within the configured timeout")
		}
	}
}

func TestOPT03LongSQLTimeoutIsTransactionLocal(t *testing.T) {
	ctx := context.Background()
	conn, err := env.srv.db.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Release()
	tx, err := conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, "SET LOCAL statement_timeout='5min'"); err != nil {
		t.Fatal(err)
	}
	var timeout string
	if err := tx.QueryRow(ctx, "SHOW statement_timeout").Scan(&timeout); err != nil || timeout != "5min" {
		t.Fatalf("long SQL timeout: %s %v", timeout, err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := conn.QueryRow(ctx, "SHOW statement_timeout").Scan(&timeout); err != nil || timeout != "30s" {
		t.Fatalf("timeout leaked after transaction: %s %v", timeout, err)
	}
}
