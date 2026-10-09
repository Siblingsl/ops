package app

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"ops/internal/config"
	"ops/internal/secure"
	"ops/internal/wechat"
)

const Version = "0.1.0-mvp"

type Server struct {
	cfg    *config.Config
	db     *pgxpool.Pool
	box    *secure.Box
	wx     *wechat.Client
	now    func() time.Time
	loc    *time.Location
	aiHTTP *http.Client
}

func New(cfg *config.Config, pool *pgxpool.Pool) (*Server, error) {
	box, err := secure.NewBox(cfg.MasterKey)
	if err != nil {
		return nil, err
	}
	loc, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		loc = time.FixedZone("CST", 8*3600)
	}
	if err := os.MkdirAll(filepath.Join(cfg.DataDir, "assets"), 0o755); err != nil {
		return nil, err
	}
	return &Server{
		cfg:    cfg,
		db:     pool,
		box:    box,
		wx:     wechat.New(cfg.WechatBase),
		now:    time.Now,
		loc:    loc,
		aiHTTP: &http.Client{Timeout: 5 * time.Minute},
	}, nil
}

func (s *Server) Router() http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.RealIP)
	r.Use(middleware.Recoverer)

	r.Get("/healthz", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("ok")) })

	r.Route("/api/v1", func(r chi.Router) {
		r.Get("/healthz", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("ok")) })
		r.Get("/auth/status", s.h(s.authStatus))
		r.Post("/auth/setup", s.h(s.authSetup))
		r.Post("/auth/login", s.h(s.authLogin))

		r.Group(func(r chi.Router) {
			r.Use(s.requireSession)
			r.Use(s.requireCSRF)

			r.Get("/auth/me", s.h(s.authMe))
			r.Post("/auth/logout", s.h(s.authLogout))
			r.Post("/auth/reauth", s.h(s.authReauth))
			r.Put("/auth/password", s.h(s.authChangePassword))
			r.Get("/system/info", s.h(s.systemInfo))

			r.Get("/accounts", s.h(s.listAccounts))
			r.Post("/accounts", s.h(s.createAccount))
			r.Get("/accounts/{accountId}", s.h(s.getAccount))
			r.Patch("/accounts/{accountId}", s.h(s.updateAccount))
			r.Post("/accounts/{accountId}/disable", s.h(s.setAccountStatus("disabled")))
			r.Post("/accounts/{accountId}/enable", s.h(s.setAccountStatus("active")))
			r.Put("/accounts/{accountId}/wechat-credential", s.h(s.saveWechatCredential))
			r.Post("/accounts/{accountId}/wechat-credential/test", s.h(s.testWechatCredential))

			r.Get("/accounts/{accountId}/profile", s.h(s.getProfile))
			r.Put("/accounts/{accountId}/profile", s.h(s.putProfile))
			r.Get("/accounts/{accountId}/style-samples", s.h(s.listStyleSamples))
			r.Post("/accounts/{accountId}/style-samples", s.h(s.createStyleSample))
			r.Patch("/style-samples/{id}", s.h(s.updateStyleSample))
			r.Delete("/style-samples/{id}", s.h(s.deleteStyleSample))
			r.Get("/materials", s.h(s.listMaterials))
			r.Post("/materials", s.h(s.createMaterial))
			r.Patch("/materials/{id}", s.h(s.updateMaterial))
			r.Delete("/materials/{id}", s.h(s.deleteMaterial))

			r.Get("/accounts/{accountId}/topics", s.h(s.listTopics))
			r.Post("/accounts/{accountId}/topics", s.h(s.createTopic))
			r.Post("/accounts/{accountId}/topics/suggest", s.h(s.suggestTopics))
			r.Patch("/topics/{id}", s.h(s.updateTopic))
			r.Delete("/topics/{id}", s.h(s.deleteTopic))
			r.Post("/topics/{id}/works", s.h(s.startWorkFromTopic))

			r.Get("/accounts/{accountId}/works", s.h(s.listWorks))
			r.Post("/accounts/{accountId}/works", s.h(s.createWork))
			r.Get("/works/{id}", s.h(s.getWork))
			r.Patch("/works/{id}", s.h(s.updateWork))
			r.Delete("/works/{id}", s.h(s.deleteWork))
			r.Post("/works/{id}/outline/generate", s.h(s.generateOutline))
			r.Put("/works/{id}/outline", s.h(s.saveOutline))
			r.Post("/works/{id}/sections", s.h(s.createSection))
			r.Put("/works/{id}/sections/order", s.h(s.reorderSections))
			r.Patch("/sections/{id}", s.h(s.updateSection))
			r.Delete("/sections/{id}", s.h(s.deleteSection))
			r.Post("/sections/{id}/draft", s.h(s.draftSection))
			r.Post("/sections/{id}/edit", s.h(s.editSection))
			r.Post("/sections/{id}/rewrite", s.h(s.rewriteSection))
			r.Post("/works/{id}/titles", s.h(s.generateTitles))
			r.Post("/works/{id}/summary", s.h(s.generateSummary))
			r.Get("/works/{id}/versions", s.h(s.listVersions))
			r.Post("/works/{id}/versions", s.h(s.createManualVersion))
			r.Get("/works/{id}/versions/{no}", s.h(s.getVersion))
			r.Post("/works/{id}/versions/{no}/restore", s.h(s.restoreVersion))
			r.Post("/works/{id}/derive", s.h(s.deriveWork))
			r.Post("/works/{id}/unlock", s.h(s.unlockWork))

			r.Post("/works/{id}/assets", s.h(s.uploadAsset))
			r.Patch("/assets/{id}", s.h(s.updateAsset))
			r.Delete("/assets/{id}", s.h(s.deleteAsset))
			r.Get("/assets/{id}/file", s.h(s.assetFile))

			r.Post("/works/{id}/checks", s.h(s.startCheck))
			r.Get("/works/{id}/checks/latest", s.h(s.latestCheck))
			r.Patch("/check-items/{id}", s.h(s.resolveCheckItem))
			r.Post("/works/{id}/checks/complete", s.h(s.completeCheck))

			r.Get("/works/{id}/wechat/push-preview", s.h(s.pushPreview))
			r.Post("/works/{id}/wechat/push", s.h(s.pushWechat))
			r.Post("/works/{id}/xhs/pack", s.h(s.createPack))
			r.Get("/works/{id}/xhs/pack", s.h(s.getPack))
			r.Get("/works/{id}/xhs/pack.zip", s.h(s.packZip))
			r.Post("/works/{id}/published", s.h(s.markPublished))

			r.Get("/accounts/{accountId}/board", s.h(s.board))
			r.Get("/works/{id}/metrics", s.h(s.listMetrics))
			r.Post("/works/{id}/metrics", s.h(s.createMetric))
			r.Patch("/metrics/{id}", s.h(s.updateMetric))
			r.Delete("/metrics/{id}", s.h(s.deleteMetric))
			r.Post("/accounts/{accountId}/reviews", s.h(s.createReview))
			r.Get("/accounts/{accountId}/reviews", s.h(s.listReviews))
			r.Post("/review-reports/{id}/suggestions/{index}/adopt", s.h(s.adoptSuggestion))
			r.Get("/accounts/{accountId}/dashboard", s.h(s.dashboard))

			r.Get("/model-providers", s.h(s.listProviders))
			r.Post("/model-providers", s.h(s.createProvider))
			r.Patch("/model-providers/{id}", s.h(s.updateProvider))
			r.Delete("/model-providers/{id}", s.h(s.deleteProvider))
			r.Post("/model-providers/{id}/test", s.h(s.testProvider))
			r.Get("/model-routes", s.h(s.getRoutes))
			r.Put("/model-routes", s.h(s.putRoutes))
			r.Get("/usage", s.h(s.usage))
			r.Get("/settings", s.h(s.getSettings))
			r.Put("/settings", s.h(s.putSettings))
			r.Get("/sensitive-words", s.h(s.listWords))
			r.Post("/sensitive-words", s.h(s.createWord))
			r.Delete("/sensitive-words/{id}", s.h(s.deleteWord))
			r.Get("/audit-logs", s.h(s.auditLogs))
			r.Get("/trash", s.h(s.listTrash))
			r.Post("/trash/{type}/{id}/restore", s.h(s.restoreTrash))
			r.Delete("/trash/{type}/{id}", s.h(s.purgeTrash))
		})
	})

	if s.cfg.StaticDir != "" {
		r.Handle("/*", spaHandler(s.cfg.StaticDir))
	}
	return r
}

func spaHandler(dir string) http.Handler {
	fs := http.FileServer(http.Dir(dir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := filepath.Join(dir, filepath.Clean(r.URL.Path))
		if st, err := os.Stat(p); err != nil || st.IsDir() {
			if !strings.HasPrefix(r.URL.Path, "/assets/") {
				http.ServeFile(w, r, filepath.Join(dir, "index.html"))
				return
			}
		}
		fs.ServeHTTP(w, r)
	})
}

func (s *Server) audit(ctx context.Context, action, targetType, targetID, result string, detail map[string]any) {
	var actor *uuid.UUID
	if id := ident(ctx); id != nil {
		actor = &id.MemberID
	}
	if detail == nil {
		detail = map[string]any{}
	}
	b, _ := json.Marshal(detail)
	if _, err := s.db.Exec(context.WithoutCancel(ctx),
		`INSERT INTO audit_log (actor_id, action, target_type, target_id, result, detail) VALUES ($1,$2,$3,$4,$5,$6)`,
		actor, action, targetType, targetID, result, b); err != nil {
		slog.Error("写操作日志失败", "err", err)
	}
}

// today returns the start of the current day in China time.
func (s *Server) today() time.Time {
	n := s.now().In(s.loc)
	return time.Date(n.Year(), n.Month(), n.Day(), 0, 0, 0, 0, s.loc)
}
