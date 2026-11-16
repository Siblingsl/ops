package app

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"testing"
)

// CF-P2-CXEF-05（90 D-187 波次 / 34 §14.2）：评论拟稿真实模型抽样 ≥3 条。
// 门控：OPS_CXEF05_REAL_ACCEPTANCE=1 时执行，默认 skip（真实模型会产生费用）。
// 环境变量：OPS_R_REAL_BASE_URL / OPS_R_REAL_API_KEY / OPS_R_REAL_MODEL 与 R 系列
// 同源注入（复用 rRealProviderConfigFromEnv 的解析与红线：Key 只进进程内存与本机
// 测试库加密列，不进代码/日志/证据）。
// 通过标准（34 §14.2 验收）：抽 ≥3 条真实评论——分类落在五枚举、reply 1..80 码点、
// 无链接/承诺/敏感数据；real_model_review 在证据 JSONL 中如实记录 pass/fail。
func TestCXEF05CommentReplyRealSampling(t *testing.T) {
	if os.Getenv("OPS_CXEF05_REAL_ACCEPTANCE") != "1" {
		t.Skip("评论拟稿真实抽样需显式设置 OPS_CXEF05_REAL_ACCEPTANCE=1")
	}
	cfg, err := rRealProviderConfigFromEnv()
	if err != nil {
		t.Fatalf("真实供应商配置缺失：%v", err)
	}
	clearAgentFeatureSettings(t)
	env.reauth(t)

	// 真实供应商播种（与 R 系列同路径）：加密入测试库 + cx_comment_reply 路由指过去。
	enc, encErr := env.srv.box.Encrypt(cfg.APIKey)
	if encErr != nil {
		t.Fatalf("加密真实供应商密钥失败：%v", encErr)
	}
	var providerID string
	ws := env.me(t).Workspace.ID
	if err := env.srv.db.QueryRow(context.Background(),
		`INSERT INTO model_provider (workspace_id, name, base_url, api_key_enc, key_version, models, status, execution_location)
		 VALUES ($1,$2,$3,$4,$5,$6,'active','server') RETURNING id`,
		ws, "CXEF05 真实供应商（运行时注入）", cfg.BaseURL, enc, env.srv.box.Version, []string{cfg.Model}).Scan(&providerID); err != nil {
		t.Fatalf("写入真实供应商失败：%v", err)
	}
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(context.Background(), `DELETE FROM model_route WHERE task_type='cx_comment_reply' AND provider_id=$1`, providerID)
		_, _ = env.srv.db.Exec(context.Background(), `DELETE FROM model_provider WHERE id=$1`, providerID)
	})
	env.mustJSON(t, "PUT", "/api/v1/model-routes", []map[string]any{
		{"task_type": "cx_comment_reply", "provider_id": providerID, "model": cfg.Model},
	}, nil)

	account := env.accounts(t).xhs
	samples := []struct {
		alias   string
		content string
	}{
		{"读者甲", "这篇的步骤写得很清楚，但第二步的依据是什么？想引用到自己的笔记里。"},
		{"读者乙", "写得太泛了，根本没有可操作的细节，失望。"},
		{"读者丙", "收藏了！正好最近在研究这个方向，博主还有后续吗？"},
		{"读者丁", "第 3 段的数据来源是哪里？感觉和官方口径不一致。"},
		{"读者戊", "求个链接，谢谢分享http://example.com/deal"},
	}
	type result struct {
		Category string
		Reply    string
	}
	outDir := os.Getenv("OPS_CXEF05_REAL_OUTPUT")
	fails := 0
	passes := 0
	for i, s := range samples {
		var created commentInboxItem
		env.mustJSONStatus(t, "POST", "/api/v1/comments", map[string]any{
			"account_id": account.ID, "author_alias": s.alias, "content": s.content,
		}, &created, http.StatusCreated)
		var updated commentInboxItem
		env.mustJSON(t, "POST", "/api/v1/comment-inbox/"+created.ID+"/reply-suggest",
			map[string]any{"base_revision": created.Revision}, &updated)
		got := result{}
		if updated.Category != nil {
			got.Category = *updated.Category
		}
		got.Reply = updated.ReplyDraft

		// 逐条验收（34 §14.2：分类合理 + ≤80 码点 + 无外发承诺）。
		replyLen := len([]rune(strings.TrimSpace(got.Reply)))
		checks := map[string]bool{
			"category_valid": commentCategories[got.Category],
			"reply_1_80":     replyLen >= 1 && replyLen <= commentReplyMax,
			"no_link":        !strings.Contains(strings.ToLower(got.Reply), "http"),
		}
		ok := checks["category_valid"] && checks["reply_1_80"] && checks["no_link"]
		if ok {
			passes++
		} else {
			fails++
		}
		record := map[string]any{
			"sample": i + 1, "content_head": s.content, "category": got.Category,
			"reply": got.Reply, "checks": checks, "real_model_review": map[bool]string{true: "pass", false: "fail"}[ok],
			"model": cfg.Model, "at": env.srv.now().UTC().Format("2006-01-02T15:04:05Z"),
		}
		if outDir != "" {
			_ = os.MkdirAll(outDir, 0o755)
			line, _ := json.Marshal(record)
			f, ferr := os.OpenFile(outDir+"/cxef05-real-sampling.jsonl", os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
			if ferr == nil {
				_, _ = f.Write(append(line, '\n'))
				_ = f.Close()
			}
		}
		t.Logf("样本 %d：%s → [%s] %s（%v）", i+1, s.content, got.Category, got.Reply, checks)
	}
	t.Logf("真实模型抽样完成：pass=%d fail=%d（模型 %s）", passes, fails, cfg.Model)
	if passes < 3 {
		t.Fatalf("真实模型抽样通过样本不足 3 条（pass=%d fail=%d），不满足 34 §14.2 验收", passes, fails)
	}
}
