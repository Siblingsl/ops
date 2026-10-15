// ops-e2e starts an isolated local mock server for web browser tests.
package main

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"

	"github.com/jackc/pgx/v5"
	"ops/internal/app"
	"ops/internal/config"
	"ops/internal/db"
	"ops/internal/mock"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	// 固定独立库，不接受生产或 Go API 测试库，也不执行 DROP。
	adminURL := os.Getenv("OPS_E2E_ADMIN_URL")
	if adminURL == "" {
		adminURL = "postgres://ops:ops_dev_password@127.0.0.1:5440/ops?sslmode=disable"
	}
	u, err := url.Parse(adminURL)
	if err != nil {
		return err
	}
	if (u.Hostname() != "127.0.0.1" && u.Hostname() != "localhost") || u.Path != "/ops" {
		return fmt.Errorf("冒烟仅允许连接本地开发 ops 库以创建独立 ops_e2e 库")
	}
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, adminURL)
	if err != nil {
		return err
	}
	var exists bool
	err = conn.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname='ops_e2e')`).Scan(&exists)
	if err == nil && !exists {
		_, err = conn.Exec(ctx, `CREATE DATABASE ops_e2e`)
	}
	conn.Close(ctx)
	if err != nil {
		return err
	}
	u.Path = "/ops_e2e"
	// 显式配置所有出站服务为本地 mock，避免继承真实凭证或地址。
	cfg := &config.Config{Dev: true, Listen: "127.0.0.1:8180", DatabaseURL: u.String(),
		DataDir: filepath.Join(os.TempDir(), "ops-e2e-assets"), MockListen: "127.0.0.1:8191",
		WechatBase: "http://127.0.0.1:8191", MasterKey: make([]byte, 32), CrawlMode: "off", AIWorkers: 3}
	if err := db.Migrate(cfg.DatabaseURL); err != nil {
		return err
	}
	pool, err := db.Connect(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()
	srv, err := app.New(cfg, pool)
	if err != nil {
		return err
	}
	if err := srv.SeedDevModel(ctx); err != nil {
		return err
	}
	mux := http.NewServeMux()
	mux.Handle("/v1/", (&mock.LLM{}).Handler())
	mux.Handle("/robots.txt", mock.HotHandler())
	mux.Handle("/mock/hot/", mock.HotHandler())
	mux.Handle("/mock/page/", mock.HotHandler())
	mux.Handle("/", mock.NewWechat().Handler())
	mockServer := &http.Server{Addr: cfg.MockListen, Handler: mux}
	// 先确认 mock 端口能绑定，不能误用已有真实服务。
	listener, err := net.Listen("tcp", cfg.MockListen)
	if err != nil {
		return err
	}
	defer mockServer.Close()
	go mockServer.Serve(listener)
	return srv.HTTPServer(cfg.Listen).ListenAndServe()
}
