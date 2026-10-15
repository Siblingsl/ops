package db

import (
	"context"
	"database/sql"
	"embed"
	"fmt"
	"log/slog"
	"os"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
)

//go:embed migrations/*.sql
var migrations embed.FS

func Migrate(databaseURL string) error {
	sqlDB, err := sql.Open("pgx", databaseURL)
	if err != nil {
		return err
	}
	defer sqlDB.Close()
	goose.SetBaseFS(migrations)
	goose.SetLogger(goose.NopLogger())
	if err := goose.SetDialect("postgres"); err != nil {
		return err
	}
	if err := goose.Up(sqlDB, "migrations"); err != nil {
		return fmt.Errorf("执行数据库迁移失败: %w", err)
	}
	return nil
}

func Connect(ctx context.Context, databaseURL string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, err
	}
	cfg.MaxConns = 20
	if v := os.Getenv("OPS_DB_MAX_CONNS"); v != "" {
		n, err := strconv.ParseInt(v, 10, 32)
		if err != nil || n <= 0 {
			return nil, fmt.Errorf("OPS_DB_MAX_CONNS 必须为正整数")
		}
		cfg.MaxConns = int32(n)
	}
	cfg.MaxConnIdleTime = 5 * time.Minute
	cfg.MaxConnLifetime = time.Hour
	cfg.ConnConfig.RuntimeParams["statement_timeout"] = "30s"
	cfg.ConnConfig.RuntimeParams["idle_in_transaction_session_timeout"] = "60s"
	cfg.ConnConfig.RuntimeParams["timezone"] = "Asia/Shanghai"
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("无法连接数据库: %w", err)
	}
	slog.Info("数据库连接池已配置", "max_conns", cfg.MaxConns,
		"max_conn_idle_time", cfg.MaxConnIdleTime, "max_conn_lifetime", cfg.MaxConnLifetime,
		"statement_timeout", "30s", "idle_in_transaction_session_timeout", "60s", "timezone", "Asia/Shanghai")
	return pool, nil
}
