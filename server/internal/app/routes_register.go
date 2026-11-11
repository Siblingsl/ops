package app

import "github.com/go-chi/chi/v5"

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
	r.Post("/works/{id}/published", s.h(s.markPublished))
	r.Get("/works/{id}/publish-state", s.h(s.getPublishState))
	r.Post("/works/{id}/publish-state/transition", s.h(s.transitionPublishState))
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
