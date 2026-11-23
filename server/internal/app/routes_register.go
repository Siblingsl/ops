package app

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

// DEV-S01 / docs/33 §5.2：从 buildRouter 抽出的路由分组注册。
// 路径与相对顺序必须与拆分前一致；HC-28 依赖路由清单稳定。

func (s *Server) registerDesktopRoutes(r chi.Router) {
	r.Get("/desktop/policy", s.h(s.desktopGetPolicy))
	r.Put("/desktop/policy", s.h(s.desktopPutPolicy))
	r.Post("/desktop/challenges", s.h(s.desktopCreateChallenge))
	r.Post("/desktop/devices", s.h(s.desktopRegisterDevice))
	// 平台采集一律走 /desktop/platform/*，与 AI 的 /desktop/* 命名分开；
	// 首个端点只做设备登记，任务/连接端点在 DEV-PS04/07 接入。
	r.Post("/desktop/platform/devices", s.h(s.desktopPlatformRegisterDevice))
	// 平台采集的连接与任务端点（DEV-PS07）：全部要求设备证明，见 PS02 的 operation 白名单。
	r.Post("/desktop/platform/connections", s.h(s.desktopCreatePlatformConnection))
	r.Post("/desktop/platform/connections/{id}/verify", s.h(s.desktopVerifyPlatformConnection))
	r.Post("/desktop/platform/presence", s.h(s.desktopPlatformPresence))
	r.Post("/desktop/platform/runs/claim", s.h(s.desktopClaimPlatformRun))
	// P0-4（CF-P2-CXEF-06）：评论单条上报（设备证明；复用本地 comment 结果类型，
	// 单条幂等写入 comment_inbox；不扩 v2 白名单——授权文案未拍板）。
	r.Post("/desktop/platform/comments", s.h(s.desktopIngestPlatformComment))
	// REF41 F4：采集失败样本上报（设备证明在 handler 内校验；与评论上报同组/同守卫）。
	r.Post("/desktop/parser-events", s.h(s.parserEventsIngest))
	// REF41 F5：桌面发布执行器 Preflight 的浏览器策略三道闸检查（签名、只读、拒绝写审计）。
	r.Post("/desktop/platform/browser-policy/check", s.h(s.browserPolicyCheckHTTP))
	r.Post("/desktop/platform/publish/tasks/claim", s.h(s.publishTaskClaim))
	r.Post("/desktop/platform/publish/tasks/{id}/heartbeat", s.h(s.publishTaskHeartbeat))
	r.Post("/desktop/platform/publish/tasks/{id}/results", s.h(s.publishTaskResult))
	r.Post("/desktop/platform/runs/{id}/heartbeat", s.h(s.desktopHeartbeatPlatformRun))
	r.Post("/desktop/platform/runs/{id}/results", s.h(s.desktopSubmitPlatformResults))
	r.Get("/desktop/platform/runs/{id}/receipts/{seq}", s.h(s.desktopGetPlatformRunReceipt))
	r.Get("/platform-collection/policy", s.h(s.platformGetPolicy))
	r.Put("/platform-collection/policy", s.h(s.platformPutPolicy))
	// 运营诊断（20 文档 §14）：owner 查看本工作区近 7 天计数，不含业务内容。
	r.Get("/platform-collection/diagnostics", s.h(s.platformDiagnosticsHandler))

	r.Get("/desktop/models", s.h(s.desktopListModels))
	r.Post("/desktop/models", s.h(s.desktopCreateModel))
	r.Put("/desktop/models/{id}", s.h(s.desktopUpdateModel))
	r.Delete("/desktop/models/{id}", s.h(s.desktopDeleteModel))
	r.Post("/desktop/models/{id}/test", s.h(s.desktopStartModelTest))
	r.Get("/desktop/model-tests/{id}", s.h(s.desktopGetModelTest))
	r.Get("/desktop/routes", s.h(s.desktopGetRoutes))
	r.Put("/desktop/routes", s.h(s.desktopPutRoutes))
	r.Post("/desktop/connections", s.h(s.desktopCreateConnectionTicket))
}

func (s *Server) registerCXRoutes(r chi.Router) {
	r.Post("/works/{id}/builds", s.h(s.createCXBuild))
	r.Get("/works/{id}/builds", s.h(s.listCXBuilds))
	r.Get("/builds/{id}", s.h(s.getCXBuild))
	r.Post("/builds/{id}/artifacts", s.h(s.uploadCXBuildArtifact))
	r.Post("/builds/{id}/office-render", s.h(s.renderCXBuildOffice))
	r.Get("/builds/{id}/artifacts/{artifactID}", s.h(s.downloadCXBuildArtifact))
	r.Get("/builds/{id}/manifest.json", s.h(s.downloadCXBuildManifest))
	r.Get("/builds/{id}/evidence.csv", s.h(s.downloadCXBuildEvidenceCSV))
	r.Post("/builds/{id}/privacy-ack", s.h(s.ackCXBuildPrivacy))
	r.Post("/builds/{id}/complete", s.h(s.completeCXBuild))
	r.Post("/builds/{id}/cancel", s.h(s.cancelCXBuild))
}

func (s *Server) registerPublishRoutes(r chi.Router) {
	r.Get("/works/{id}/wechat/push-preview", s.h(s.pushPreview))
	r.Post("/works/{id}/wechat/push", s.h(s.pushWechat))
	r.Post("/works/{id}/xhs/pack", s.h(s.createPack))
	r.Get("/works/{id}/xhs/pack", s.h(s.getPack))
	r.Get("/works/{id}/xhs/pack.zip", s.h(s.packZip))
	r.Post("/works/{id}/toutiao/pack", s.h(s.toutiaoPackCreate))
	r.Get("/works/{id}/toutiao/pack", s.h(s.toutiaoPackGet))
	r.Get("/works/{id}/toutiao/pack.zip", s.h(s.toutiaoPackZip))
	r.Get("/cover-presets", s.h(s.coverPresetsHandler))
	r.Get("/browser-task-policies", s.h(s.listBrowserPolicies))
	r.Post("/browser-task-policies", s.h(s.createBrowserPolicy))
	r.Patch("/browser-task-policies/{policyID}", s.h(s.patchBrowserPolicy))
	r.Post("/browser-task-policies/{policyID}/renew", s.h(s.renewBrowserPolicy))
	r.Get("/accounts/{accountId}/deactivation-preview", s.h(s.accountDeactivationPreviewHandler))
	r.Post("/accounts/{accountId}/merge", s.h(s.accountMerge))
	r.Get("/accounts/{accountId}/merge-logs", s.h(s.mergeLogList))
	r.Get("/alert-rules", s.h(s.listAlertRules))
	r.Put("/alert-rules/{key}", s.h(s.upsertAlertRule))
	r.Get("/alert-events", s.h(s.listAlertEvents))
	r.Get("/mcp/tokens", s.h(s.listMCPTokens))
	r.Post("/mcp/tokens", s.h(s.createMCPtoken))
	r.Delete("/mcp/tokens/{tokenID}", s.h(s.revokeMCPtoken))
	r.Post("/mcp/call", s.h(s.mcpCall))
	r.Post("/works/{id}/published", s.h(s.markPublished))
	r.Post("/works/{id}/panel-review", s.h(s.createPanelReview))
	r.Get("/works/{id}/panel-reviews", s.h(s.listPanelReviews))
	r.Get("/works/{id}/panel-reviews/{reviewID}", s.h(s.getPanelReview))
	r.Post("/works/{id}/panel-reviews/{reviewID}/adopt", s.h(s.adoptPanelSuggestion))
	r.Get("/works/{id}/publish-state", s.h(s.getPublishState))
	r.Post("/works/{id}/publish-state/transition", s.h(s.transitionPublishState))

	// REF41 P1/P2：manifest 快照与发布任务（P2 先落最小 create/guard，供 P1-A4/A5 验收）。
	r.Get("/works/{id}/publish-manifests", s.h(s.listPublishManifestsHandler))
	r.Post("/works/{id}/publish-manifests/{platform}", s.h(s.createOrRebuildPublishManifest))
	r.Get("/works/{id}/publish-manifests/{platform}", s.h(s.getPublishManifest))
	r.Post("/works/{id}/publish-manifests/{platform}/validate", s.h(s.validatePublishManifestHandler))
	r.Patch("/works/{id}/publish-manifests/{platform}", s.h(s.patchPublishManifest))
	r.Get("/works/{id}/publish-tasks", s.h(s.listPublishTasksHandler))
	r.Post("/works/{id}/publish-tasks", s.h(s.createPublishTasks))
	r.Get("/publish/capabilities", s.h(s.publishCapabilities))
	r.Get("/publish/labels", s.h(s.publishLabels))
	// REF41 P5：发布通道体检（只读；结果写 publish_channel_state.detail.last_health）。
	r.Post("/accounts/{accountId}/publish-health/check", s.h(s.requestPublishHealthCheck))
	r.Get("/accounts/{accountId}/publish-health", s.h(s.listPublishHealth))
	r.Post("/desktop/platform/publish/health/claim", s.h(s.publishHealthClaim))
	r.Post("/desktop/platform/publish/health/checks/{checkID}/heartbeat", s.h(s.publishHealthHeartbeat))
	r.Post("/desktop/platform/publish/health/checks/{checkID}/results", s.h(s.publishHealthResult))
	// REF41 I1：竞对观测领取/心跳/结果（设备证明复用平台采集）。
	r.Post("/desktop/benchmark/tasks/claim", s.h(s.benchmarkObserveClaim))
	r.Post("/desktop/benchmark/tasks/{taskID}/heartbeat", s.h(s.benchmarkObserveHeartbeat))
	r.Post("/desktop/benchmark/tasks/{taskID}/results", s.h(s.benchmarkObserveResults))
	r.Get("/publish-tasks", s.h(s.listPublishTaskBoard))
	r.Get("/publish-tasks/{id}/events", s.h(s.getPublishTaskEventsHandler))
	r.Post("/publish-tasks/{id}/transition", s.h(s.publishTaskTransitionHandler))
	r.Post("/publish-tasks/{id}/queue", s.h(func(w http.ResponseWriter, r *http.Request) error { return s.publishTaskActionHandler(w, r, "queued") }))
	r.Post("/publish-tasks/{id}/stop", s.h(func(w http.ResponseWriter, r *http.Request) error { return s.publishTaskActionHandler(w, r, "stopped") }))
	r.Post("/publish-tasks/{id}/retry", s.h(func(w http.ResponseWriter, r *http.Request) error { return s.publishTaskActionHandler(w, r, "queued") }))
	r.Post("/publish-tasks/{id}/manual", s.h(s.publishTaskSetManual))
	// REF41 P6：adopt/mark/submit-now 人工兜底；published 仍只走既有 /works/{id}/published。
	r.Post("/publish-tasks/{id}/adopt", s.h(s.publishTaskAdopt))
	r.Post("/publish-tasks/{id}/mark", s.h(s.publishTaskMark))
	r.Post("/publish-tasks/{id}/submit-now", s.h(s.publishTaskSubmitNow))
	r.Post("/publish-tasks/{id}/skip", s.h(func(w http.ResponseWriter, r *http.Request) error { return s.publishTaskActionHandler(w, r, "skipped") }))
	// REF41 I1：竞对监控开关/观测/趋势/覆盖（只读公开页；竞对数据仅本工作区）。
	r.Patch("/benchmark/targets/{id}/monitor", s.h(s.benchmarkMonitorToggleHandler))
	r.Get("/benchmark/targets/{id}/observations", s.h(s.benchmarkObservationsHandler))
	r.Get("/benchmark/targets/{id}/trend", s.h(s.benchmarkTrendHandler))
	r.Get("/benchmark/targets/{id}/coverage", s.h(s.benchmarkCoverageHandler))
	// REF41 A6：角色 bot 与工具白名单（内置三角色可停用不可删；不改变 D-117）。
	r.Get("/agent-roles", s.h(s.listAgentRoles))
	r.Post("/agent-roles", s.h(s.createAgentRole))
	r.Patch("/agent-roles/{roleID}", s.h(s.patchAgentRole))
	r.Delete("/agent-roles/{roleID}", s.h(s.deleteAgentRole))
	// REF41 A7：工作流模板（启动只建 run+plan 预览，确认后才执行；内置三模板）。
	r.Get("/workflows", s.h(s.listWorkflowTemplates))
	r.Post("/workflows", s.h(s.createWorkflowTemplate))
	r.Patch("/workflows/{templateID}", s.h(s.patchWorkflowTemplate))
	r.Delete("/workflows/{templateID}", s.h(s.deleteWorkflowTemplate))
	r.Post("/workflows/{templateID}/start", s.h(s.workflowStartHandler))
	r.Get("/publish-batches", s.h(s.listPublishBatches))
	r.Post("/publish-batches", s.h(s.createPublishBatch))
	r.Get("/publish-batches/{id}", s.h(s.getPublishBatch))
}

func (s *Server) registerPlatformRoutes(r chi.Router) {
	// 平台作品绑定逐篇确认（20 文档 §7.2）：没有批量接口，每次只处理一篇。
	r.Put("/works/{id}/platform-binding", s.h(s.putPlatformBinding))
	r.Delete("/works/{id}/platform-binding", s.h(s.deletePlatformBinding))

	r.Get("/accounts/{accountId}/board", s.h(s.board))
	// 平台连接摘要与撤销（20 文档 §11.2）。创建/验证连接由本机证明在 PS07 接入。
	r.Get("/accounts/{accountId}/platform-connection", s.h(s.getPlatformConnection))
	r.Delete("/accounts/{accountId}/platform-connection", s.h(s.deletePlatformConnection))
	r.Patch("/accounts/{accountId}/platform-connection", s.h(s.patchPlatformConnection))
	// 手动采集只建待办，且仅连接保管人可发起（20 文档 §10.1.1）。
	r.Post("/accounts/{accountId}/platform-sync", s.h(s.requestPlatformSync))
	r.Post("/accounts/{accountId}/platform-account-sync", s.h(s.requestPlatformAccountSync))
	r.Post("/accounts/{accountId}/platform-metrics-refresh", s.h(s.requestPlatformMetricsRefresh))
	r.Get("/accounts/{accountId}/platform-sync-operations", s.h(s.listPlatformSyncOperations))
	r.Get("/accounts/{accountId}/platform-sync-operations/{operationId}", s.h(s.getPlatformSyncOperation))
	r.Get("/accounts/{accountId}/platform-sync-operations/{operationId}/items", s.h(s.listPlatformSyncOperationItems))
	r.Post("/accounts/{accountId}/platform-sync-operations/{operationId}/actions", s.h(s.platformSyncOperationAction))
	r.Get("/accounts/{accountId}/platform-profile", s.h(s.getPlatformAccountSnapshot))
	r.Get("/accounts/{accountId}/platform-works", s.h(s.listPlatformWorkMirrors))
	r.Get("/accounts/{accountId}/platform-works/{platformWorkId}", s.h(s.getPlatformWorkMirror))
	r.Post("/accounts/{accountId}/platform-works/{platformWorkId}/draft", s.h(s.createDraftFromPlatformMirror))
}
