package app

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"ops/internal/config"
	"ops/internal/crawl"
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

	firstTokenTimeout time.Duration

	jobMu      sync.Mutex
	jobCancels map[uuid.UUID]context.CancelFunc
	jobSems    map[uuid.UUID]chan struct{}

	notifySubs map[uuid.UUID][]chan struct{}

	presenceMu sync.Mutex
	presence   map[uuid.UUID]map[uuid.UUID]presenceEntry

	// lastPacks keeps the latest context per workspace/task in memory only, for saving prompt regression cases.
	lastPacks sync.Map
	crawlMu   sync.Mutex
	crawler   *crawl.Client
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

		firstTokenTimeout: 15 * time.Second,
		jobCancels:        map[uuid.UUID]context.CancelFunc{},
		jobSems:           map[uuid.UUID]chan struct{}{},
		notifySubs:        map[uuid.UUID][]chan struct{}{},
		presence:          map[uuid.UUID]map[uuid.UUID]presenceEntry{},
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
		r.Post("/auth/register", s.h(s.authRegister))
		r.Post("/auth/login", s.h(s.authLogin))

		r.Group(func(r chi.Router) {
			r.Use(s.requireSession)
			r.Use(s.requireCSRF)
			r.Use(s.blockMaintenance)
			r.Use(s.blockViewerWrites)
			r.Use(preferFallback)

			r.Get("/auth/me", s.h(s.authMe))
			r.Post("/auth/logout", s.h(s.authLogout))
			r.Post("/auth/reauth", s.h(s.authReauth))
			r.Put("/auth/password", s.h(s.authChangePassword))
			r.Get("/system/info", s.h(s.systemInfo))

			r.Get("/admin/users", s.h(s.adminListUsers))
			r.Patch("/admin/users/{id}", s.h(s.adminPatchUser))
			r.Post("/admin/users/{id}/reset-password", s.h(s.adminResetPassword))
			r.Post("/admin/users/{id}/revoke-sessions", s.h(s.adminRevokeSessions))
			r.Get("/admin/workspaces", s.h(s.adminListWorkspaces))
			r.Post("/admin/workspaces/{id}/enter", s.h(s.adminEnterWorkspace))
			r.Post("/admin/workspaces/exit", s.h(s.adminExitWorkspace))
			r.Get("/admin/audit-logs", s.h(s.adminAuditLogs))
			r.Get("/admin/usage", s.h(s.adminUsage))
			r.Get("/admin/system-settings", s.h(s.adminGetSystemSettings))
			r.Put("/admin/system-settings", s.h(s.adminPutSystemSettings))
			r.Get("/admin/crawl", s.h(s.adminGetCrawl))
			r.Put("/admin/crawl", s.h(s.adminPutCrawl))
			r.Put("/admin/crawl/sources/{key}", s.h(s.adminPutCrawlSource))
			r.Post("/admin/crawl/sources/{key}/test", s.h(s.adminTestCrawlSource))
			r.Get("/admin/crawl/runs", s.h(s.adminCrawlRuns))
			r.Get("/hot-sources", s.h(s.getHotSources))
			r.Put("/hot-sources", s.h(s.putHotSources))
			r.Get("/hot-items", s.h(s.listHotItems))
			r.Get("/accounts/{accountId}/hot", s.h(s.getAccountHot))
			r.Post("/accounts/{accountId}/hot/refresh", s.h(s.refreshAccountHot))
			r.Post("/hot-matches/{id}/convert", s.h(s.convertHotMatch))
			r.Post("/hot-matches/{id}/dismiss", s.h(s.dismissHotMatch))

			r.Get("/workspaces", s.h(s.listWorkspaces))
			r.Post("/workspaces", s.h(s.createWorkspace))
			r.Post("/workspaces/join", s.h(s.joinWorkspace))
			r.Get("/workspaces/current/members", s.h(s.listMembers))
			r.Patch("/workspaces/current/members/{userId}", s.h(s.patchMember))
			r.Post("/workspaces/current/transfer", s.h(s.transferOwnership))
			r.Post("/workspaces/current/leave", s.h(s.leaveWorkspace))
			r.Get("/workspaces/current/invites", s.h(s.listInvites))
			r.Post("/workspaces/current/invites", s.h(s.createInvite))
			r.Post("/workspaces/current/invites/{id}/send-email", s.h(s.sendInviteEmail))
			r.Post("/workspaces/current/invites/{id}/revoke", s.h(s.revokeInvite))
			r.Patch("/workspaces/{id}", s.h(s.patchWorkspace))
			r.Post("/workspaces/{id}/switch", s.h(s.switchWorkspace))

			r.Get("/accounts", s.h(s.listAccounts))
			r.Post("/accounts", s.h(s.createAccount))
			r.Get("/accounts/{accountId}", s.h(s.getAccount))
			r.Patch("/accounts/{accountId}", s.h(s.updateAccount))
			r.Post("/accounts/{accountId}/disable", s.h(s.setAccountStatus("disabled")))
			r.Post("/accounts/{accountId}/enable", s.h(s.setAccountStatus("active")))
			r.Delete("/accounts/{accountId}", s.h(s.deleteAccount))
			r.Put("/accounts/{accountId}/wechat-credential", s.h(s.saveWechatCredential))
			r.Post("/accounts/{accountId}/wechat-credential/test", s.h(s.testWechatCredential))

			r.Get("/accounts/{accountId}/profile", s.h(s.getProfile))
			r.Put("/accounts/{accountId}/profile", s.h(s.putProfile))
			r.Get("/accounts/{accountId}/style-samples", s.h(s.listStyleSamples))
			r.Post("/accounts/{accountId}/style-samples", s.h(s.createStyleSample))
			r.Patch("/style-samples/{id}", s.h(s.updateStyleSample))
			r.Delete("/style-samples/{id}", s.h(s.deleteStyleSample))
			r.Post("/accounts/{accountId}/style-summary", s.h(s.styleSummary))
			r.Get("/accounts/{accountId}/characters", s.h(s.listCharacters))
			r.Post("/accounts/{accountId}/characters", s.h(s.createCharacter))
			r.Patch("/characters/{id}", s.h(s.updateCharacter))
			r.Delete("/characters/{id}", s.h(s.deleteCharacter))
			r.Post("/characters/{id}/ref", s.h(s.uploadCharacterRef))
			r.Delete("/characters/{id}/ref", s.h(s.deleteCharacterRef))
			r.Get("/materials", s.h(s.listMaterials))
			r.Post("/materials", s.h(s.createMaterial))
			r.Patch("/materials/{id}", s.h(s.updateMaterial))
			r.Delete("/materials/{id}", s.h(s.deleteMaterial))
			r.Post("/accounts/{accountId}/metrics/import", s.h(s.importMetrics))
			r.Post("/accounts/{accountId}/metrics/sync-wechat", s.h(s.syncWechatMetrics))

			r.Get("/accounts/{accountId}/topics", s.h(s.listTopics))
			r.Post("/accounts/{accountId}/topics", s.h(s.createTopic))
			r.Post("/accounts/{accountId}/topics/suggest", s.h(s.suggestTopics))
			r.Post("/accounts/{accountId}/topics/hot-suggest", s.h(s.suggestHotTopics))
			r.Patch("/topics/{id}", s.h(s.updateTopic))
			r.Delete("/topics/{id}", s.h(s.deleteTopic))
			r.Post("/topics/{id}/works", s.h(s.startWorkFromTopic))

			r.Get("/accounts/{accountId}/works", s.h(s.listWorks))
			r.Post("/accounts/{accountId}/works", s.h(s.createWork))
			r.Get("/works/{id}", s.h(s.getWork))
			r.Patch("/works/{id}", s.h(s.updateWork))
			r.Put("/works/{id}/post-push-todos", s.h(s.setPostPushTodos))
			r.Put("/works/{id}/title-favorites", s.h(s.setTitleFavorites))
			r.Delete("/works/{id}", s.h(s.deleteWork))
			r.Post("/works/{id}/outline/generate", s.h(s.generateOutline))
			r.Put("/works/{id}/outline", s.h(s.saveOutline))
			r.Post("/works/{id}/storyboard/generate", s.h(s.generateStoryboard))
			r.Put("/works/{id}/storyboard", s.h(s.saveStoryboard))
			r.Patch("/panels/{id}", s.h(s.updatePanel))
			r.Post("/panels/{id}/text", s.h(s.generatePanelText))
			r.Post("/panels/{id}/generate-image", s.h(s.generatePanelImage))
			r.Put("/panels/{id}/bubbles", s.h(s.putPanelBubbles))
			r.Post("/works/{id}/generate-image", s.h(s.generateWorkImage))
			r.Post("/works/{id}/sections", s.h(s.createSection))
			r.Put("/works/{id}/sections/order", s.h(s.reorderSections))
			r.Patch("/sections/{id}", s.h(s.updateSection))
			r.Delete("/sections/{id}", s.h(s.deleteSection))
			r.Post("/sections/{id}/draft", s.h(s.draftSection))
			r.Post("/sections/{id}/edit", s.h(s.editSection))
			r.Post("/sections/{id}/rewrite", s.h(s.rewriteSection))
			r.Post("/sections/{id}/image-suggest", s.h(s.suggestImages))
			r.Post("/works/{id}/titles", s.h(s.generateTitles))
			r.Post("/works/{id}/summary", s.h(s.generateSummary))
			r.Post("/works/{id}/organize-notes", s.h(s.organizeNotes))
			r.Post("/works/{id}/organize-notes/apply", s.h(s.applyOrganizedNotes))
			r.Post("/works/{id}/xhs/pages", s.h(s.suggestXHSPages))
			r.Post("/works/{id}/wechat/sync-draft", s.h(s.syncDraftStatus))
			r.Get("/works/{id}/versions", s.h(s.listVersions))
			r.Post("/works/{id}/versions", s.h(s.createManualVersion))
			r.Get("/works/{id}/versions/{no}", s.h(s.getVersion))
			r.Post("/works/{id}/versions/{no}/restore", s.h(s.restoreVersion))
			r.Post("/works/{id}/derive", s.h(s.deriveWork))
			r.Post("/works/{id}/unlock", s.h(s.unlockWork))

			r.Post("/works/{id}/assets", s.h(s.uploadAsset))
			r.Patch("/assets/{id}", s.h(s.updateAsset))
			r.Post("/assets/{id}/crop", s.h(s.cropAsset))
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
			r.Get("/prompt-templates", s.h(s.listPromptTemplates))
			r.Put("/prompt-templates/{taskType}", s.h(s.putPromptTemplate))
			r.Post("/exports", s.h(s.exportData))

			s.v3Routes(r)
			s.v4Routes(r)
			r.Put("/admin/crawl/platforms/{platform}", s.h(s.adminPutPlatform))
		})
	})

	if s.cfg.StaticDir != "" {
		r.Handle("/*", spaHandler(s.cfg.StaticDir))
	}
	return r
}

// v3Routes registers the D-046 endpoints (10 文档第 7 节).
func (s *Server) v3Routes(r chi.Router) {
	// 智能底座：反馈、检索、记忆、任务中心、通知、偏好
	r.Post("/ai-calls/{id}/feedback", s.h(s.postFeedback))
	r.Post("/accounts/{accountId}/retrieve", s.h(s.retrieve))
	r.Get("/accounts/{accountId}/memories", s.h(s.listMemories))
	r.Post("/accounts/{accountId}/memories", s.h(s.createMemory))
	r.Post("/accounts/{accountId}/memories/distill", s.h(s.startDistill))
	r.Patch("/memories/{id}", s.h(s.patchMemory))
	r.Delete("/memories/{id}", s.h(s.deleteMemory))
	r.Get("/ai-jobs", s.h(s.listJobs))
	r.Get("/ai-jobs/{id}", s.h(s.getJob))
	r.Post("/ai-jobs/{id}/cancel", s.h(s.cancelJob))
	r.Get("/notifications", s.h(s.listNotifications))
	r.Get("/notifications/stream", s.h(s.streamNotifications))
	r.Post("/notifications/read-all", s.h(s.readAllNotifications))
	r.Post("/notifications/{id}/read", s.h(s.readNotification))
	r.Get("/me/preferences", s.h(s.getPrefs))
	r.Put("/me/preferences", s.h(s.putPrefs))
	r.Post("/ux-events", s.h(s.postUXEvents))
	r.Post("/client-errors", s.h(s.postClientError))

	// 冷启动与工作台
	r.Post("/accounts/{accountId}/profile/bootstrap", s.h(s.profileBootstrap))
	r.Get("/accounts/{accountId}/health", s.h(s.accountHealth))
	r.Get("/accounts/{accountId}/next-actions", s.h(s.getNextActions))
	r.Get("/accounts/{accountId}/rhythm", s.h(s.accountRhythm))
	r.Get("/calendar", s.h(s.calendar))
	r.Post("/demo", s.h(s.importDemo))
	r.Delete("/demo", s.h(s.clearDemo))

	// 选题与收件箱
	r.Post("/accounts/{accountId}/topics/score", s.h(s.scoreTopics))
	r.Get("/accounts/{accountId}/series", s.h(s.listSeries))
	r.Post("/accounts/{accountId}/series", s.h(s.createSeries))
	r.Patch("/series/{id}", s.h(s.updateSeries))
	r.Delete("/series/{id}", s.h(s.deleteSeries))
	r.Post("/series/{id}/suggest", s.h(s.suggestSeriesTopics))
	r.Get("/inbox", s.h(s.listInbox))
	r.Post("/inbox", s.h(s.createInbox))
	r.Post("/inbox/{id}/triage", s.h(s.triageInbox))
	r.Post("/inbox/{id}/convert", s.h(s.convertInbox))
	r.Delete("/inbox/{id}", s.h(s.deleteInbox))

	// 素材
	r.Post("/materials/extract", s.h(s.extractMaterials))
	r.Post("/materials/tag-suggest", s.h(s.materialTagSuggest))
	r.Get("/materials/duplicates", s.h(s.materialDuplicates))
	r.Post("/materials/merge", s.h(s.mergeMaterials))
	r.Get("/materials/{id}/usage", s.h(s.materialUsage))

	// 编辑器 v3
	r.Post("/sections/{id}/restore", s.h(s.restoreSection))
	r.Put("/sections/{id}/materials", s.h(s.setSectionMaterials))
	r.Post("/sections/{id}/hooks", s.h(s.suggestHooks))
	r.Post("/sections/{id}/continue", s.h(s.continueSection))
	r.Get("/sections/{id}/revisions", s.h(s.listSectionRevisions))
	r.Post("/sections/{id}/revisions/{rid}/restore", s.h(s.restoreSectionRevision))
	r.Get("/works/{id}/source-diff", s.h(s.sourceDiff))
	r.Get("/works/{id}/family", s.h(s.workFamily))
	r.Get("/works/{id}/series-context", s.h(s.workSeriesContext))
	r.Get("/outline-templates", s.h(s.listOutlineTemplates))
	r.Put("/outline-templates", s.h(s.putOutlineTemplates))
	r.Post("/works/{id}/outline/review", s.h(s.reviewOutline))
	r.Get("/works/{id}/copilot", s.h(s.listCopilot))
	r.Post("/works/{id}/copilot", s.h(s.chatCopilot))
	r.Delete("/works/{id}/copilot", s.h(s.clearCopilot))
	r.Post("/works/{id}/lint", s.h(s.lintWork))
	r.Post("/works/{id}/polish-check", s.h(s.polishCheck))
	r.Post("/works/{id}/polish-ignore", s.h(s.ignorePolish))
	r.Post("/works/{id}/tag-suggest", s.h(s.workTagSuggest))
	r.Post("/works/{id}/layout-suggest", s.h(s.layoutSuggest))
	r.Post("/works/{id}/golden-sentences", s.h(s.saveGoldenSentence))

	// 检查 v2、审阅与发布衔接
	r.Post("/check-items/{id}/fix-suggest", s.h(s.fixSuggest))
	r.Post("/works/{id}/review/approve", s.h(s.approveReview))
	r.Get("/works/{id}/checks/report", s.h(s.checkReport))
	r.Post("/publish-link/parse", s.h(s.parsePublishLinkHandler))

	// 排版与图片
	r.Get("/accounts/{accountId}/custom-theme", s.h(s.getCustomTheme))
	r.Put("/accounts/{accountId}/custom-theme", s.h(s.putCustomTheme))
	r.Get("/assets/{id}/smart-crop", s.h(s.smartCrop))
	r.Get("/assets", s.h(s.listLibrary))
	r.Post("/works/{id}/assets/reuse", s.h(s.reuseAsset))

	// 复盘 v2
	r.Post("/review-reports/{id}/insights/{index}/remember", s.h(s.rememberInsight))
	r.Post("/review-reports/{id}/insights/{index}/ignore", s.h(s.ignoreInsight))
	r.Post("/accounts/{accountId}/reviews/attribution", s.h(s.attribution))
	r.Get("/accounts/{accountId}/top-works", s.h(s.topWorks))
	r.Post("/works/{id}/breakdown", s.h(s.breakdownWork))
	r.Get("/accounts/{accountId}/digests", s.h(s.listDigests))

	// 协作
	r.Get("/works/{id}/comments", s.h(s.listComments))
	r.Post("/works/{id}/comments", s.h(s.createComment))
	r.Patch("/comments/{id}", s.h(s.patchComment))
	r.Get("/works/{id}/presence", s.h(s.getPresence))
	r.Post("/works/{id}/presence", s.h(s.postPresence))
	r.Get("/works/{id}/activity", s.h(s.workActivity))

	// 全局效率
	r.Get("/search", s.h(s.globalSearch))
	r.Get("/stars", s.h(s.listStars))
	r.Post("/stars", s.h(s.addStar))
	r.Delete("/stars/{type}/{id}", s.h(s.removeStar))

	// AI 质量保障
	r.Get("/quality", s.h(s.qualityBoard))
	r.Get("/quality/calls", s.h(s.qualityCalls))
	r.Get("/prompt-eval/cases", s.h(s.listEvalCases))
	r.Post("/prompt-eval/cases", s.h(s.createEvalCase))
	r.Delete("/prompt-eval/cases/{id}", s.h(s.deleteEvalCase))
	r.Get("/prompt-eval/cases/{id}/runs", s.h(s.listEvalRuns))
	r.Post("/prompt-eval/runs", s.h(s.createEvalRun))
	r.Patch("/prompt-eval/runs/{id}", s.h(s.patchEvalRun))
}

// v4Routes registers the D-047 account operations endpoints (11 文档第 8 节).
func (s *Server) v4Routes(r chi.Router) {
	r.Get("/accounts/{accountId}/references", s.h(s.getReferences))
	r.Post("/accounts/{accountId}/references", s.h(s.addReferences))
	r.Post("/references/{id}/paste", s.h(s.pasteReference))
	r.Delete("/references/{id}", s.h(s.deleteReference))
	r.Get("/accounts/{accountId}/strategy", s.h(s.getStrategy))
	r.Post("/accounts/{accountId}/strategy/options", s.h(s.strategyOptions))
	r.Post("/accounts/{accountId}/strategy", s.h(s.activateStrategy))
	r.Post("/accounts/{accountId}/strategy/versions/{v}/restore", s.h(s.restoreStrategy))
	r.Post("/accounts/{accountId}/strategy/revise", s.h(s.reviseStrategy))
	r.Get("/accounts/{accountId}/plan", s.h(s.getPlan))
	r.Post("/accounts/{accountId}/plan/suggest", s.h(s.suggestPlan))
	r.Post("/plan-slots/{id}/adopt", s.h(s.adoptSlot))
	r.Post("/plan-slots/{id}/regenerate", s.h(s.regenerateSlot))
	r.Post("/plan-slots/{id}/clear", s.h(s.clearSlot))
}

func spaHandler(dir string) http.Handler {
	fs := http.FileServer(http.Dir(dir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			http.NotFound(w, r)
			return
		}
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
		actor = &id.UserID
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
