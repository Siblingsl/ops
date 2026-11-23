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
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"ops/internal/app"
	"ops/internal/config"
	"ops/internal/db"
	"ops/internal/documentparse"
	"ops/internal/mock"
)

func main() {
	if len(os.Args) == 2 && os.Args[1] == "__agent_document_parser" {
		if documentparse.RunWorker() != nil {
			os.Exit(1)
		}
		return
	}
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	// All databases remain fixed test-only names; custom listeners are loopback-only.
	desktopAIEnabled := os.Getenv("OPS_E2E_DESKTOP_AI_ENABLED") == "1"
	platformEnabled := os.Getenv("OPS_E2E_PLATFORM_ENABLED") == "1"
	// QA-B2（G3-07/09）：热点批次需要出站榜单走 mock（Dev=true 已把 crawl_source URL 重定向到
	// /mock/hot/*）。CrawlMode 默认 off 不发请求；仅当显式传 OPS_E2E_CRAWL_MODE=allow 才开放。
	crawlMode := os.Getenv("OPS_E2E_CRAWL_MODE")
	if crawlMode != "allow" {
		crawlMode = "off"
	}
	databaseName := "ops_e2e"
	if desktopAIEnabled {
		databaseName += "_desktop_ui"
	}
	if platformEnabled {
		databaseName += "_platform"
	}
	listenAddr, err := localListenAddr("OPS_E2E_LISTEN", "127.0.0.1:8180")
	if err != nil {
		return err
	}
	mockListenAddr, err := localListenAddr("OPS_E2E_MOCK_LISTEN", "127.0.0.1:8191")
	if err != nil {
		return err
	}
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
	err = conn.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=$1)`, databaseName).Scan(&exists)
	if err == nil && !exists {
		_, err = conn.Exec(ctx, `CREATE DATABASE `+databaseName)
	}
	conn.Close(ctx)
	if err != nil {
		return err
	}
	u.Path = "/" + databaseName
	// 显式配置所有出站服务为本地 mock，避免继承真实凭证或地址。
	cfg := &config.Config{Dev: true, Listen: listenAddr, DatabaseURL: u.String(),
		DataDir: filepath.Join(os.TempDir(), databaseName+"-assets"), MockListen: mockListenAddr,
		WechatBase: "http://" + mockListenAddr, MasterKey: make([]byte, 32), CrawlMode: crawlMode, AIWorkers: 3,
		DesktopAIEnabled: desktopAIEnabled, DesktopPlatformEnabled: platformEnabled,
		SystemAdminUser: "skyeder", SystemAdminPassword: "local-e2e-admin-pass-456"}
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
	if err := srv.EnsurePermanentAdmin(ctx); err != nil {
		return err
	}
	// REF41 A6/A7：E2E 服务同样回填内置角色/模板，避免新库空目录。
	if err := srv.SeedWorkspaceBuiltins(ctx); err != nil {
		return err
	}
	// D-160：OPS_E2E_DESKTOP_AI_ENABLED=1 通过一次性种子写入 desktop.ai_enabled；
	// 运行时闸门只读 DB，仅传 config 字段不会生效。
	srv.SeedDesktopAIFromConfig(ctx)
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
	httpServer := srv.HTTPServer(cfg.Listen)
	apiMux := http.NewServeMux()
	// REF41 I1：E2E 专用夹具，只在本测试服务注册；生产 cmd/ops 无此路由。
	apiMux.Handle("/__e2e/benchmark/seed", benchmarkSeedHandler(pool))
	apiMux.Handle("/__e2e/benchmark/queue", benchmarkQueueHandler(pool))
	apiMux.Handle("/__e2e/benchmark/public/profile", benchmarkPublicProfileHandler())
	apiMux.Handle("/__e2e/benchmark/public/note/e2e-note-1", benchmarkPublicNoteHandler())
	// REF41 I3：问题簇归并触发，仅测试服务。
	apiMux.Handle("/__e2e/comment-clusters/recompute", commentClusterRebuildHandler(srv))
	// REF41 F3：系统任务台账种子，仅测试服务。
	apiMux.Handle("/__e2e/job-runs/seed", app.SeedJobRunsHandler(srv))
	// REF41 F4：采集失败样本种子，仅测试服务。
	apiMux.Handle("/__e2e/parser-events/seed", app.SeedParserEventsHandler(srv))
	if platformEnabled {
		apiMux.Handle("/__e2e/platform/seed", platformFixtureHandler(pool))
	}
	apiMux.Handle("/", httpServer.Handler)
	httpServer.Handler = apiMux
	return httpServer.ListenAndServe()
}

func localListenAddr(name, fallback string) (string, error) {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback, nil
	}
	host, port, err := net.SplitHostPort(value)
	if err != nil || host != "127.0.0.1" {
		return "", fmt.Errorf("%s must be a 127.0.0.1 host:port", name)
	}
	portNumber, err := strconv.Atoi(port)
	if err != nil || portNumber < 1024 || portNumber > 65535 {
		return "", fmt.Errorf("%s must use a port from 1024 through 65535", name)
	}
	return net.JoinHostPort(host, strconv.Itoa(portNumber)), nil
}
