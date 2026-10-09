package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"golang.org/x/term"

	"ops/internal/app"
	"ops/internal/config"
	"ops/internal/db"
	"ops/internal/mock"
)

func main() {
	cmd := "serve"
	if len(os.Args) > 1 {
		cmd = os.Args[1]
	}
	var err error
	switch cmd {
	case "serve":
		err = serve()
	case "migrate":
		err = migrate()
	case "reset-password":
		err = resetPassword()
	case "version":
		fmt.Println(app.Version)
	default:
		fmt.Fprintf(os.Stderr, "用法：ops [serve|migrate|reset-password <username>|version]\n")
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "错误：", err)
		os.Exit(1)
	}
}

func migrate() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	return db.Migrate(cfg.DatabaseURL)
}

func serve() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	if err := db.Migrate(cfg.DatabaseURL); err != nil {
		return fmt.Errorf("数据库迁移失败：%w", err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	pool, err := db.Connect(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()
	srv, err := app.New(cfg, pool)
	if err != nil {
		return err
	}
	if cfg.Dev {
		go serveMock(cfg.MockListen)
		if err := srv.SeedDevModel(ctx); err != nil {
			slog.Warn("添加本地模拟模型失败", "err", err)
		}
		slog.Warn("开发模式：微信接口和模型都使用本地模拟服务器", "mock", "http://"+cfg.MockListen, "drafts", "http://"+cfg.MockListen+"/mock/drafts")
	}
	go srv.RunJobs(ctx)
	hs := &http.Server{Addr: cfg.Listen, Handler: srv.Router(), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = hs.Shutdown(sctx)
	}()
	slog.Info("服务已启动", "listen", cfg.Listen, "version", app.Version, "dev", cfg.Dev)
	if err := hs.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

func serveMock(addr string) {
	wx := mock.NewWechat()
	llm := &mock.LLM{Delay: 25 * time.Millisecond}
	mux := http.NewServeMux()
	mux.Handle("/v1/", llm.Handler())
	mux.Handle("/", wx.Handler())
	if err := http.ListenAndServe(addr, mux); err != nil {
		slog.Error("模拟服务器启动失败", "err", err)
	}
}

func readPassword(prompt string) (string, error) {
	fmt.Print(prompt)
	if term.IsTerminal(int(os.Stdin.Fd())) {
		b, err := term.ReadPassword(int(os.Stdin.Fd()))
		fmt.Println()
		return string(b), err
	}
	line, err := bufio.NewReader(os.Stdin).ReadString('\n')
	return strings.TrimRight(line, "\r\n"), err
}

// resetPassword is the only way to recover a forgotten password (FR-M1-08); it never takes the password as an argument.
func resetPassword() error {
	if len(os.Args) < 3 || strings.TrimSpace(os.Args[2]) == "" {
		return errors.New("用法：ops reset-password <username>")
	}
	username := strings.TrimSpace(os.Args[2])
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	ctx := context.Background()
	pool, err := db.Connect(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()
	srv, err := app.New(cfg, pool)
	if err != nil {
		return err
	}
	p1, err := readPassword("新密码（至少 12 位）：")
	if err != nil {
		return err
	}
	p2, err := readPassword("再次输入：")
	if err != nil {
		return err
	}
	if p1 != p2 {
		return errors.New("两次输入不一致")
	}
	name, err := app.ResetPassword(ctx, srv, username, p1)
	if err != nil {
		return err
	}
	fmt.Printf("用户 %s 的密码已重置，所有已登录的会话都已退出。\n", name)
	return nil
}
