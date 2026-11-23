package main

import (
	"encoding/json"
	"net/http"

	"github.com/google/uuid"

	"ops/internal/app"
)

// REF41 I3：E2E 专用归并触发，只在本测试服务注册；生产 cmd/ops 无此路由。
// 测试通过真实 API 逐条入库并把评论标为 question，再调用此入口触发与每小时 job 相同的重算。
func commentClusterRebuildHandler(srv *app.Server) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var in struct {
			AccountID string `json:"account_id"`
		}
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		accountID, err := uuid.Parse(in.AccountID)
		if err != nil {
			http.Error(w, "invalid account_id", http.StatusBadRequest)
			return
		}
		if err := srv.RebuildCommentClustersForAccountID(r.Context(), accountID); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
	})
}
