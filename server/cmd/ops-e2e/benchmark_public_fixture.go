package main

// REF41 I1-A5 E2E 夹具：仅 ops-e2e 注册。
//
// - /__e2e/benchmark/queue：插入一条真实 benchmark_observe_task，让桌面 worker
//   真正走 claim → 公开页读取 → results，而不是把观测直接写进数据库。
// - /__e2e/benchmark/public/profile 与 /note/e2e-note-1：本地公开页样本，
//   模拟「主页发现作品链接 → 作品页公开 JSON」；不含登录态、Cookie、私信或粉丝数据。

import (
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type benchmarkQueueRequest struct {
	TargetID uuid.UUID `json:"target_id"`
}

func benchmarkQueueHandler(pool *pgxpool.Pool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var in benchmarkQueueRequest
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&in); err != nil {
			http.Error(w, "invalid json", http.StatusBadRequest)
			return
		}
		if in.TargetID == uuid.Nil {
			http.Error(w, "target_id is required", http.StatusBadRequest)
			return
		}
		ctx := r.Context()
		var wsID uuid.UUID
		if err := pool.QueryRow(ctx, `SELECT workspace_id FROM benchmark_target WHERE id=$1`, in.TargetID).Scan(&wsID); err != nil {
			http.Error(w, "target not found", http.StatusNotFound)
			return
		}
		// 同一测试内重复 queue 时只保留最新一条 queued，避免 worker 领到旧任务。
		if _, err := pool.Exec(ctx, `DELETE FROM benchmark_observe_task
			WHERE target_id=$1 AND workspace_id=$2 AND state='queued'`, in.TargetID, wsID); err != nil {
			http.Error(w, "reset queue failed: "+err.Error(), http.StatusInternalServerError)
			return
		}
		var taskID uuid.UUID
		if err := pool.QueryRow(ctx, `INSERT INTO benchmark_observe_task (workspace_id,target_id,state,requested_at)
			VALUES ($1,$2,'queued',now()) RETURNING id`, wsID, in.TargetID).Scan(&taskID); err != nil {
			http.Error(w, "queue task failed: "+err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"task_id": taskID})
	})
}

func benchmarkPublicProfileHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		fmt.Fprint(w, `<!doctype html><html><head><meta charset="utf-8">
<title>公开主页样本 - 小红书</title>
<meta property="og:title" content="公开主页样本">
</head><body>
<h1>公开主页样本</h1>
<a href="/__e2e/benchmark/public/note/e2e-note-1">公开作品</a>
<script>window.__INITIAL_STATE__ = {"user":{"nickname":"公开主页样本","noteCount":1}};</script>
</body></html>`)
	})
}

func benchmarkPublicNoteHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		fmt.Fprint(w, `<!doctype html><html><head><meta charset="utf-8">
<title>I1 公开页只读样本 - 小红书</title>
<meta property="og:title" content="I1 公开页只读样本">
<meta property="article:published_time" content="2026-11-10T09:12:00+08:00">
</head><body>
<h1>I1 公开页只读样本</h1>
<p>这是公开主页上的作品页样本，不包含登录态、私信或粉丝数据。</p>
<p>21 赞 · 3 评论 · 8 收藏 · 1 分享 · 120 浏览</p>
<script>window.__INITIAL_STATE__ = {"note":{"noteId":"e2e-note-1","title":"I1 公开页只读样本","desc":"公开作品页样本","time":1762737120000,"interactInfo":{"likedCount":21,"commentCount":3,"collectedCount":8,"shareCount":1,"viewCount":120}}};</script>
</body></html>`)
	})
}
